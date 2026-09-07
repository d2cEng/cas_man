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
  '스이카(애플)',
  '스이카(가민)',
  '라쿠텐은행',
  '신카',
  'RKTP',
  '라쿠텐증권',
  '페이디',
  '로킨',
  '하나머니',
  '와온',
  '뷰카드',
  '페이페이',
  '나나코',
  'PPP',
  '아마존포인트',
  '라쿠텐JRE',
];

/** 구분 for each transaction type, matching the 범주별 sheet. */
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
  clientId: '',
  categories: DEFAULT_CATEGORIES,
  accounts: DEFAULT_ACCOUNTS,
  defaultAccount: '현금',
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

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
    updatedAt: Number(input.updatedAt) || Date.now(),
    deleted: Boolean(input.deleted),
  };
}

/** Signed 금액, the way the 거래내역 sheet stores it. */
export function signedAmount(record) {
  return TYPES[record.type].sign * record.amount;
}

/** Infer the type from a signed amount plus its 범주, for imports. */
export function typeFromRow(signed, category) {
  if (category === '이체') return 'transfer';
  if (category === '수입') return 'income';
  return Number(signed) > 0 ? 'income' : 'expense';
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

/** All live records, newest transaction first. */
export async function list() {
  const all = await allRaw();
  return all.filter((r) => !r.deleted).sort((a, b) => b.ts - a.ts || b.updatedAt - a.updatedAt);
}

/** Everything, tombstones included — the shape sync merges on. */
export async function allRaw() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** Soft delete, so the removal survives a round trip through Drive. */
export async function remove(id) {
  const existing = await get(id);
  if (!existing) return;
  await put({ ...existing, deleted: true });
}

export async function wipe() {
  // Tombstone rather than clear(), otherwise the next sync pulls it all back.
  const all = await allRaw();
  const now = Date.now();
  await putMany(all.map((r) => ({ ...r, deleted: true, updatedAt: now })));
}

/**
 * Merge remote records into local ones. Last write wins per record id; ties go
 * to the incoming copy so a repeated sync converges instead of ping-ponging.
 */
export function mergeRecords(mine, theirs) {
  const merged = new Map();
  for (const record of mine) merged.set(record.id, normalise(record));
  let changed = 0;
  for (const raw of theirs) {
    const record = normalise(raw);
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
    if (!CURRENCIES[settings.currency]) settings.currency = DEFAULT_SETTINGS.currency;
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

// ── Change notification ───────────────────────────────────────────────────

const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn();
}
