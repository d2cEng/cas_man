// Local-first record storage on IndexedDB.
//
// Every record carries `updatedAt` and a `deleted` tombstone flag so that the
// same merge rule (last write wins, per record) works for local edits and for
// whatever comes back from Google Drive.

const DB_NAME = 'cas_man';
const DB_VERSION = 1;
const STORE = 'records';

const SETTINGS_KEY = 'cas_man.settings';

// The vocabulary below mirrors the 거래내역 sheet of the 일본 자산 관리 workbook so
// that what this app exports drops straight into that DB.

/**
 * 범주 of 구분 = 지출; 수입 and 이체 are their own 범주 and come from `type`.
 * Ordered by how often each appears in the workbook, so the chips people reach
 * for most sit in the first row.
 */
export const DEFAULT_CATEGORIES = [
  '식비',
  '생활',
  '교통',
  '빌',
  '위생건강',
  '전자기기',
  '여가',
  '주식',
  '여행',
  '의류',
  '아파트',
  '기타',
  '엄마',
  '가구',
  '부엌용품',
  '교육',
  '선물',
];

export const DEFAULT_ACCOUNTS = [
  '현금',
  '교통카드',
  '교통카드2',
  '은행',
  '은행2',
  '카드',
  '증권',
  '후불결제',
  '은행3',
  '전자머니',
  '전자머니2',
  '카드2',
  '전자머니3',
  '전자머니4',
  '카드3',
  '포인트',
  '포인트2',
  // Not a real account: the placeholder for money that left the wallet but is
  // coming back. Paying for a group puts everyone else's share here as a 이체,
  // so 지출 stays at your own share and this balance is what you are still
  // owed. It returns to 0 when they pay you.
  '뿜빠이',
];

/**
 * Accounts added to the defaults after the app was already in use.
 *
 * An install that has been used carries its own saved 계좌 목록, so a new entry
 * in DEFAULT_ACCOUNTS would never reach it. These are added to that list once
 * each, and the note that it has happened is what keeps a deliberate removal
 * from being undone on the next launch.
 */
export const SEEDED_ACCOUNTS = ['뿜빠이'];

/**
 * 구분 for each transaction type, matching the 범주별 sheet.
 *
 * 이체 is stored as a pair of rows — money leaving one 계좌 and arriving in
 * another — exactly as the 거래내역 sheet records it, so account balances stay
 * reconcilable. `direction` on the record picks the sign for each half.
 */
export const TYPES = {
  expense: { label: '지출', category: null, sign: -1 },
  income: { label: '수입', category: '수입', sign: 1 },
  transfer: { label: '이체', category: '이체', sign: -1 },
};

export const CURRENCIES = {
  JPY: { unit: '円', step: '00' },
  KRW: { unit: '원', step: '000' },
  USD: { unit: '$', step: '00' },
};

const DEFAULT_SETTINGS = {
  categories: DEFAULT_CATEGORIES,
  accounts: DEFAULT_ACCOUNTS,
  defaultAccount: '현금',
  // This is a cash ledger, so the 이체 people actually record is withdrawing
  // cash from the bank. Defaulting to that saves two taps on the common case.
  transferFrom: '은행',
  transferTo: '현금',
  // Id of the 잔고신고 row, so re-saving the opening balance edits the same
  // record instead of stacking up a new one each time.
  openingId: '',
  // Ids deleted here but not yet deleted in the cloud. Deleted rows are removed
  // outright rather than kept as tombstones, so this queue is the only thing
  // that stops the next sync from pulling them back; it is emptied as soon as
  // the cloud copy is gone.
  // { id: deletedAt } for rows that have been deleted. The row itself is gone;
  // only an id and a timestamp remain, which is what lets a device tell
  // "deleted elsewhere" from "edited here since". Entries expire after
  // DELETION_TTL_MS so the log never grows without bound.
  deletions: {},
  // Which of SEEDED_ACCOUNTS this install has already been offered.
  seededAccounts: [],
  // ATM fees are spending, not part of the 이체 they accompany. The workbook has
  // no 수수료 범주, so they land in 기타 with 수수료 in 비고.
  feeCategory: '기타',
  // Written into the 출처 column so rows from this app are traceable in the DB.
  source: '현금장부',
  currency: 'JPY',
  lastSyncAt: 0,
  autoSync: true,
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('ts', 'ts');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function tx(mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    let result;
    try {
      result = run(store);
    } catch (error) {
      transaction.abort();
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * How long a deletion is remembered.
 *
 * Long enough that any device syncing within the window learns about it, short
 * enough that the log stays small. A device offline longer than this falls back
 * to the sync watermark, which still catches deletions it never saw.
 */
export const DELETION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Stable id derived from a row's own content.
 *
 * The 거래내역 CSV carries no id column — it is a source file for the ledger,
 * not a database dump — so importing one twice would otherwise duplicate every
 * row. Hashing the content instead makes re-import idempotent, and gives the
 * ledger pipeline a key it can dedupe on too.
 *
 * The fields are joined on NUL so no combination of values can collide by
 * shifting a separator, and it is written as an escape rather than a literal
 * so git still sees this file as text and can diff and search it.
 */
export function contentId(record) {
  const seed = [
    new Date(record.ts).toISOString().slice(0, 10),
    record.account,
    record.type,
    record.amount,
    record.category,
    record.payee,
    record.memo,
  ].join('\u0000');

  // Two differently-seeded FNV-1a passes, concatenated for a 64-bit id.
  const hash = (offset) => {
    let h = offset;
    for (let i = 0; i < seed.length; i += 1) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return `c-${hash(0x811c9dc5)}${hash(0x7ee3a1b9)}`;
}

/** Normalise anything record-shaped (form input, imported row, remote copy). */
export function normalise(input) {
  const type = TYPES[input.type] ? input.type : 'expense';
  // Amounts are stored unsigned; the sign is a function of `type`, exactly as
  // the 금액 column of 거래내역 derives it from 범주.
  const amount = Math.round(Math.abs(Number(input.amount) || 0));
  const fixedCategory = TYPES[type].category;

  return {
    id: String(input.id || newId()),
    ts: Number(input.ts) || Date.now(),
    account: String(input.account || '현금').trim() || '현금',
    amount,
    type,
    category: fixedCategory || String(input.category || '기타').trim() || '기타',
    payee: String(input.payee || '').trim(),
    memo: String(input.memo || '').trim(),
    source: String(input.source || '현금장부').trim(),
    // Ties the two halves of a 이체 together so they are edited and removed as
    // one; empty for ordinary rows. Internal only — never reaches the CSV.
    group: String(input.group || '').trim(),
    direction: input.direction === 'in' ? 'in' : 'out',
    updatedAt: Number(input.updatedAt) || Date.now(),
    deleted: Boolean(input.deleted),
  };
}

/** Signed 금액, the way the 거래내역 sheet stores it. */
export function signedAmount(record) {
  // The receiving half of a 이체 is the one row whose sign is positive.
  if (record.type === 'transfer') return (record.direction === 'in' ? 1 : -1) * record.amount;
  return TYPES[record.type].sign * record.amount;
}

/** Infer the type from a signed amount plus its 범주, for imports. */
export function typeFromRow(signed, category) {
  if (category === '이체') return 'transfer';
  if (category === '수입') return 'income';
  return Number(signed) > 0 ? 'income' : 'expense';
}

/** Which half of a 이체 a signed row is; meaningless for other 범주. */
export function directionFromRow(signed) {
  return Number(signed) > 0 ? 'in' : 'out';
}

// ── Records ───────────────────────────────────────────────────────────────

export async function put(record) {
  const value = normalise({ ...record, updatedAt: Date.now() });
  await tx('readwrite', (store) => store.put(value));
  emit();
  return value;
}

/** Write records verbatim — used by sync, which owns their `updatedAt`. */
export async function putMany(records) {
  if (!records.length) return;
  await tx('readwrite', (store) => {
    for (const record of records) store.put(normalise(record));
  });
  emit();
}

export async function get(id) {
  return tx('readonly', (store) => request(store.get(id))).then((r) => r || null);
}

/** All records, newest transaction first. */
export async function list() {
  const all = await allRaw();
  return all.sort((a, b) => b.ts - a.ts || b.updatedAt - a.updatedAt);
}

/** Every stored row. Deleted rows are removed outright, so this is all live. */
export async function allRaw() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** Soft delete, so the removal survives a round trip through the cloud. */
export async function remove(id) {
  const existing = await get(id);
  if (!existing) return;

  // Both halves of a 이체 go together, along with any fee — leaving one behind
  // would unbalance the accounts it moved money between.
  const ids = existing.group
    ? (await allRaw()).filter((r) => r.group === existing.group).map((r) => r.id)
    : [id];

  await hardDelete(ids);
}

/** Drop rows for good and log the deletion so other devices learn about it. */
async function hardDelete(ids) {
  if (!ids.length) return;
  await tx('readwrite', (store) => {
    for (const id of ids) store.delete(id);
  });
  recordDeletions(ids);
  emit();
}

/** Remove rows because the cloud says they are gone — nothing to log. */
export async function dropLocal(ids) {
  if (!ids.length) return;
  await tx('readwrite', (store) => {
    for (const id of ids) store.delete(id);
  });
  emit();
}

/** Known deletions, expired entries dropped. */
export function knownDeletions() {
  const stored = loadSettings().deletions;
  const cutoff = Date.now() - DELETION_TTL_MS;
  const live = {};
  let expired = false;

  for (const [id, at] of Object.entries(stored)) {
    if (at > cutoff) live[id] = at;
    else expired = true;
  }
  if (expired) saveSettings({ deletions: live });
  return live;
}

/** Note that these rows are gone, keeping the newest deletion time per id. */
export function recordDeletions(ids, at = Date.now()) {
  if (!ids.length) return;
  const deletions = { ...knownDeletions() };
  for (const id of ids) deletions[id] = Math.max(deletions[id] || 0, at);
  saveSettings({ deletions });
}

/** Merge a whole { id: deletedAt } map in, newest per id winning. */
export function mergeDeletions(incoming) {
  const deletions = { ...knownDeletions() };
  for (const [id, at] of Object.entries(incoming)) {
    deletions[id] = Math.max(deletions[id] || 0, at);
  }
  saveSettings({ deletions });
}

/** Drop deletion entries — used when a later edit brings a row back. */
export function forgetDeletions(ids) {
  if (!ids.length) return;
  const deletions = { ...knownDeletions() };
  for (const id of ids) delete deletions[id];
  saveSettings({ deletions });
}

/**
 * Every live row written together with this one — the two halves of a 이체 plus
 * any fee charged for it. They describe one movement of money, so they are
 * edited and deleted as a unit.
 */
export async function groupOf(id) {
  const record = await get(id);
  if (!record?.group) return record ? [record] : [];
  return (await allRaw()).filter((r) => r.group === record.group);
}

export async function wipe() {
  await hardDelete((await allRaw()).map((r) => r.id));
}

/**
 * Merge remote records into local ones. Last write wins per record id; ties go
 * to the incoming copy so a repeated sync converges instead of ping-ponging.
 */
/**
 * Local rows the cloud no longer has, split by whether we had already pushed
 * them.
 *
 * `watermark` is this device's last successful sync. A row last touched before
 * then was in the cloud at that moment, so its absence now means another device
 * deleted it. A row touched after then simply has not been pushed yet. Both
 * timestamps come from this device's own clock, so no clock skew is involved.
 */
export function classifyMissing(local, remoteIds, watermark) {
  const present = new Set(remoteIds);
  const deletedElsewhere = [];

  for (const record of local) {
    if (present.has(record.id)) continue;
    if (record.updatedAt <= watermark) deletedElsewhere.push(record.id);
  }
  return deletedElsewhere;
}

export function mergeRecords(mine, theirs, skip = []) {
  const merged = new Map();
  for (const record of mine) merged.set(record.id, normalise(record));

  // Rows deleted here but still present in the cloud must not come back.
  const skipped = new Set(skip);
  let changed = 0;

  for (const raw of theirs) {
    if (skipped.has(raw.id)) continue;
    const record = normalise(raw);

    // A tombstone written by an older version means the row is gone, not that
    // it should be stored as a deleted row.
    if (record.deleted) {
      if (merged.delete(record.id)) changed += 1;
      continue;
    }

    const current = merged.get(record.id);
    if (!current || record.updatedAt >= current.updatedAt) {
      if (!current || !sameRecord(current, record)) changed += 1;
      merged.set(record.id, record);
    }
  }
  return { records: [...merged.values()], changed };
}

function sameRecord(a, b) {
  return (
    a.ts === b.ts &&
    a.account === b.account &&
    a.amount === b.amount &&
    a.type === b.type &&
    a.category === b.category &&
    a.payee === b.payee &&
    a.memo === b.memo &&
    a.source === b.source &&
    a.group === b.group &&
    a.direction === b.direction &&
    a.deleted === b.deleted
  );
}

// ── Settings ──────────────────────────────────────────────────────────────

export function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const settings = { ...DEFAULT_SETTINGS, ...raw };
    if (!Array.isArray(settings.categories) || !settings.categories.length) {
      settings.categories = [...DEFAULT_CATEGORIES];
    }
    if (!Array.isArray(settings.accounts) || !settings.accounts.length) {
      settings.accounts = [...DEFAULT_ACCOUNTS];
    }
    if (!settings.accounts.includes(settings.defaultAccount)) {
      settings.defaultAccount = settings.accounts[0];
    }
    for (const key of ['transferFrom', 'transferTo']) {
      if (!settings.accounts.includes(settings[key])) settings[key] = '';
    }
    if (!CURRENCIES[settings.currency]) settings.currency = DEFAULT_SETTINGS.currency;
    // An earlier version kept a plain array of ids with no timestamp; treat
    // those as deleted now so they still propagate once.
    if (Array.isArray(settings.pendingDeletes)) {
      const now = Date.now();
      settings.deletions = { ...settings.deletions };
      for (const id of settings.pendingDeletes) settings.deletions[id] = now;
      delete settings.pendingDeletes;
    }
    if (!settings.deletions || typeof settings.deletions !== 'object') settings.deletions = {};
    return settings;
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      categories: [...DEFAULT_CATEGORIES],
      accounts: [...DEFAULT_ACCOUNTS],
    };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* private mode — settings just won't stick */
  }
  return next;
}

/**
 * Add any account new to the defaults to this install's list, once.
 *
 * Call it before the first render; it returns the settings to carry on with.
 */
export function seedAccounts() {
  const settings = loadSettings();
  const done = Array.isArray(settings.seededAccounts) ? settings.seededAccounts : [];
  const pending = SEEDED_ACCOUNTS.filter((name) => !done.includes(name));
  if (!pending.length) return settings;

  return saveSettings({
    accounts: [...settings.accounts, ...pending.filter((name) => !settings.accounts.includes(name))],
    seededAccounts: [...done, ...pending],
  });
}

// ── Change notification ───────────────────────────────────────────────────

const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn();
}
