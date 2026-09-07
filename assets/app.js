// UI controller.

import {
  CURRENCIES,
  DEFAULT_ACCOUNTS,
  DEFAULT_CATEGORIES,
  TYPES,
  groupOf,
  list,
  loadSettings,
  newId,
  put,
  remove,
  saveSettings,
  allRaw,
  newId as newGroupId,
  putMany,
  signedAmount,
  onChange,
  wipe,
} from './store.js';
import {
  accountLabel,
  connect,
  disconnect,
  isConnected,
  REQUIRED_RULE,
  restore,
  RULES_CONSOLE_URL,
  sync,
  SyncError,
} from './sync.js';
import {
  csvFilename,
  download,
  formatDate,
  formatTime,
  handoffSummary,
  parseImport,
  toCsv,
  toJson,
} from './transfer.js';

const $ = (id) => document.getElementById(id);
const num = new Intl.NumberFormat('ko-KR');

/** Currency is display-only: amounts are stored as plain integers. */
function unit() {
  return CURRENCIES[state.settings.currency]?.unit || '';
}

function money(amount) {
  return `${num.format(amount)}${unit()}`;
}

const state = {
  settings: loadSettings(),
  type: 'expense',
  amount: 0,
  category: '',
  account: '',
  counterAccount: '',
  editingId: null,
  editingGroup: null,
  month: startOfMonth(new Date()),
  query: '',
  records: [],
};

// ── helpers ───────────────────────────────────────────────────────────────

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function endOfMonth(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function toLocalInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function fromLocalInput(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

let toastTimer = 0;
function toast(message, tone = 'info') {
  const host = $('toast-host');
  host.textContent = message;
  host.dataset.tone = tone;
  host.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('is-visible'), 2600);
}

// ── entry view ────────────────────────────────────────────────────────────

/** The bulk-zero key: 00 for yen and dollars, 000 for won. */
function renderKeypadStep() {
  const step = CURRENCIES[state.settings.currency]?.step || '00';
  const key = $('key-step');
  key.dataset.key = step;
  key.textContent = step;
}

function renderAmount() {
  $('amount-display').textContent = num.format(state.amount);
  $('amount-hint').textContent = `${unit()} ${TYPES[state.type].label}`;
  $('save-button').disabled = state.amount <= 0;
}

function renderTypeToggle() {
  for (const button of document.querySelectorAll('.typetoggle__btn')) {
    button.classList.toggle('is-active', button.dataset.type === state.type);
  }
  document.body.dataset.type = state.type;
  // 수입 and 이체 are single 범주 in the workbook, so there is nothing to pick.
  $('category-chips').hidden = Boolean(TYPES[state.type].category);

  // 이체 needs the account on the other side, and may carry an ATM fee.
  const isTransfer = state.type === 'transfer';
  $('field-counter-account').hidden = !isTransfer;
  $('swap-accounts').hidden = !isTransfer;
  $('field-fee').hidden = !isTransfer;
  $('field-account').setAttribute('aria-label', isTransfer ? '보내는 계좌' : '계좌');

  renderAmount();
}

function fillAccountSelect(select, chosen, placeholder) {
  select.textContent = '';
  if (placeholder) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = placeholder;
    select.appendChild(option);
  }
  for (const name of state.settings.accounts) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
  select.value = state.settings.accounts.includes(chosen) ? chosen : placeholder ? '' : state.settings.accounts[0];
  return select.value;
}

function renderAccounts() {
  state.account = fillAccountSelect(
    $('field-account'),
    state.account || state.settings.defaultAccount,
  );
  state.counterAccount = fillAccountSelect(
    $('field-counter-account'),
    state.counterAccount,
    '받는 계좌 선택',
  );
}

function renderCategories() {
  const host = $('category-chips');
  host.textContent = '';
  if (!state.settings.categories.includes(state.category)) {
    state.category = state.settings.categories[0] || '기타';
  }
  for (const name of state.settings.categories) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = name;
    chip.classList.toggle('is-active', name === state.category);
    chip.addEventListener('click', () => {
      state.category = name;
      renderCategories();
    });
    host.appendChild(chip);
  }
}

/** Which accounts a fresh entry of this 구분 starts on. */
function applyAccountDefaults() {
  if (state.type === 'transfer') {
    state.account = state.settings.transferFrom || state.settings.defaultAccount;
    state.counterAccount = state.settings.transferTo || '';
  } else {
    state.account = state.settings.defaultAccount;
    state.counterAccount = '';
  }
  renderAccounts();
}

function resetEntry() {
  state.amount = 0;
  state.editingId = null;
  state.editingGroup = null;
  $('field-fee').value = '';
  applyAccountDefaults();
  $('field-payee').value = '';
  $('field-memo').value = '';
  $('field-date').value = toLocalInput(Date.now());
  $('save-button').textContent = '저장';
  $('cancel-edit').hidden = true;
  renderAmount();
}

function pressKey(key) {
  if (key === 'back') {
    state.amount = Math.floor(state.amount / 10);
  } else {
    const next = Number(`${state.amount}${key}`);
    // 13 digits is well past any cash payment and keeps us inside safe integers.
    if (String(next).length <= 13) state.amount = next;
  }
  renderAmount();
}

async function saveEntry() {
  if (state.amount <= 0) return;

  const common = {
    ts: fromLocalInput($('field-date').value),
    amount: state.amount,
    type: state.type,
    payee: $('field-payee').value,
    memo: $('field-memo').value,
    source: state.settings.source,
  };

  if (state.type === 'transfer') {
    await saveTransfer(common);
    return;
  }

  await put({
    ...common,
    id: state.editingId || newId(),
    account: $('field-account').value,
    category: TYPES[state.type].category || state.category,
  });
  toast(state.editingId ? '수정했습니다' : `${money(common.amount)} 기록`, 'ok');
  resetEntry();
  backgroundSync();
}

/**
 * A 이체 becomes the same pair of rows the 거래내역 sheet uses — money out of one
 * 계좌 and into another — so account balances stay reconcilable. An ATM fee is
 * real spending, so it goes in as its own 지출 row rather than inflating the
 * transfer, which is excluded from 지출 totals.
 */
async function saveTransfer(common) {
  const from = $('field-account').value;
  const to = $('field-counter-account').value;

  if (!to) {
    toast('받는 계좌를 선택하세요', 'warn');
    return;
  }
  if (to === from) {
    toast('보내는 계좌와 받는 계좌가 같습니다', 'warn');
    return;
  }

  const existing = state.editingGroup || [];
  const group = existing[0]?.group || newGroupId();
  const idFor = (direction) =>
    existing.find((r) => r.direction === direction)?.id || newId();

  await putMany([
    { ...common, id: idFor('out'), account: from, category: '이체', group, direction: 'out' },
    { ...common, id: idFor('in'), account: to, category: '이체', group, direction: 'in' },
  ]);

  const fee = Math.round(Math.abs(Number($('field-fee').value) || 0));
  if (fee > 0) {
    await put({
      ts: common.ts,
      // The fee is charged on the account the money left.
      account: from,
      amount: fee,
      type: 'expense',
      category: state.settings.feeCategory,
      payee: common.payee || 'ATM',
      memo: [common.memo, '수수료'].filter(Boolean).join(' '),
      source: state.settings.source,
    });
  }

  const note = fee > 0 ? ` (수수료 ${money(fee)} 별도 기록)` : '';
  toast(
    state.editingGroup ? `이체를 수정했습니다${note}` : `${from} → ${to} ${money(common.amount)}${note}`,
    'ok',
  );
  resetEntry();
  backgroundSync();
}

async function editRecord(record) {
  state.editingId = record.id;
  state.editingGroup = null;
  state.type = record.type;
  state.amount = record.amount;
  state.category = record.category;
  state.account = record.account;
  state.counterAccount = '';
  $('field-fee').value = '';

  if (record.type === 'transfer' && record.group) {
    // Edit the pair as one movement, whichever half was tapped.
    const pair = await groupOf(record.id);
    state.editingGroup = pair;
    state.account = pair.find((r) => r.direction === 'out')?.account || record.account;
    state.counterAccount = pair.find((r) => r.direction === 'in')?.account || '';
  }

  renderAccounts();
  $('field-payee').value = record.payee;
  $('field-memo').value = record.memo;
  $('field-date').value = toLocalInput(record.ts);
  $('save-button').textContent = '수정 저장';
  $('cancel-edit').hidden = false;
  renderTypeToggle();
  renderCategories();
  showView('entry');
}

// ── history view ──────────────────────────────────────────────────────────

function monthRecords() {
  const from = state.month;
  const to = endOfMonth(state.month);
  const query = state.query.trim().toLowerCase();
  return state.records.filter((r) => {
    if (r.ts < from || r.ts >= to) return false;
    if (!query) return true;
    return `${r.category} ${r.account} ${r.payee} ${r.memo}`.toLowerCase().includes(query);
  });
}

/** The 계좌 on the other side of a 이체, for display. */
function counterpartOf(record) {
  if (!record.group) return '';
  return state.records.find((r) => r.group === record.group && r.id !== record.id)?.account || '';
}

/**
 * One line per movement: a 이체 is two rows in the ledger but a single thing
 * that happened, so only its outgoing half is listed.
 */
function visibleRows(records) {
  return records.filter((r) => !(r.type === 'transfer' && r.group && r.direction === 'in'));
}

/**
 * Running balance per 계좌, over every record rather than the shown month —
 * this is "what is in the account right now", which is the number that tells
 * you whether the cash in your pocket matches the ledger.
 */
function renderBalances() {
  const totals = new Map();
  for (const record of state.records) {
    totals.set(record.account, (totals.get(record.account) || 0) + signedAmount(record));
  }

  const host = $('balances');
  host.textContent = '';

  const entries = [...totals.entries()]
    .filter(([, value]) => value !== 0)
    // Cash first — it is what this ledger exists to track.
    .sort(([a, av], [b, bv]) =>
      a === '현금' ? -1 : b === '현금' ? 1 : Math.abs(bv) - Math.abs(av),
    );

  // Only worth the caption once something other than cash is on screen.
  $('balances-note').hidden = !entries.some(([account]) => account !== '현금');

  for (const [account, value] of entries) {
    const chip = document.createElement('div');
    chip.className = `balance${account === '현금' ? ' balance--cash' : ''}`;

    const name = document.createElement('span');
    name.className = 'balance__name';
    name.textContent = account;

    const amount = document.createElement('span');
    amount.className = `balance__value${value < 0 ? ' balance__value--negative' : ''}`;
    amount.textContent = money(value);

    chip.append(name, amount);
    host.appendChild(chip);
  }
}

function renderHistory() {
  const d = new Date(state.month);
  $('month-label').textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월`;

  const records = visibleRows(monthRecords());
  // 이체 moves money between accounts, so it is not spending.
  const expense = records.filter((r) => r.type === 'expense').reduce((sum, r) => sum + r.amount, 0);
  const income = records.filter((r) => r.type === 'income').reduce((sum, r) => sum + r.amount, 0);
  $('sum-expense').textContent = num.format(expense);
  $('sum-income').textContent = num.format(income);
  $('sum-net').textContent = num.format(income - expense);

  renderBalances();

  const host = $('history-list');
  host.textContent = '';

  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.query ? '검색 결과가 없습니다.' : '이 달의 기록이 없습니다.';
    host.appendChild(empty);
    return;
  }

  let currentDay = '';
  for (const record of records) {
    const day = formatDate(record.ts);
    if (day !== currentDay) {
      currentDay = day;
      const dayTotal = records
        .filter((r) => formatDate(r.ts) === day && r.type === 'expense')
        .reduce((sum, r) => sum + r.amount, 0);
      const heading = document.createElement('div');
      heading.className = 'daygroup';
      heading.innerHTML = `<span>${day}</span><span>${escapeHtml(money(dayTotal))}</span>`;
      host.appendChild(heading);
    }
    host.appendChild(renderRow(record));
  }
}

function renderRow(record) {
  const row = document.createElement('div');
  row.className = 'row-item';

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'row-item__main';
  main.addEventListener('click', () => editRecord(record));

  const title = record.payee || record.category;
  const counterpart = counterpartOf(record);
  const where = counterpart ? `${record.account} → ${counterpart}` : record.account;
  const sub = [where, record.payee ? record.category : '', record.memo]
    .filter(Boolean)
    .join(' · ');
  main.innerHTML = `
    <span class="row-item__title">${escapeHtml(title)}</span>
    <span class="row-item__sub">${escapeHtml(sub || formatTime(record.ts))}</span>
  `;

  const amount = document.createElement('span');
  amount.className = `row-item__amount row-item__amount--${record.type}`;
  amount.textContent = `${record.type === 'income' ? '+' : '-'}${num.format(record.amount)}`;

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'row-item__del';
  del.setAttribute('aria-label', '삭제');
  del.textContent = '×';
  del.addEventListener('click', async () => {
    await remove(record.id);
    toast('삭제했습니다');
    backgroundSync();
  });

  row.append(main, amount, del);
  return row;
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// ── settings view ─────────────────────────────────────────────────────────

function renderCategoryEditor() {
  const host = $('category-editor');
  host.textContent = '';
  for (const name of state.settings.categories) {
    const chip = document.createElement('span');
    chip.className = 'chip chip--static';
    chip.textContent = name;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chip__del';
    del.setAttribute('aria-label', `${name} 삭제`);
    del.textContent = '×';
    del.addEventListener('click', () => {
      const categories = state.settings.categories.filter((c) => c !== name);
      state.settings = saveSettings({
        categories: categories.length ? categories : [...DEFAULT_CATEGORIES],
      });
      renderCategoryEditor();
      renderCategories();
      renderWidgetUrl();
    });

    chip.appendChild(del);
    host.appendChild(chip);
  }
}

function renderAccountEditor() {
  const host = $('account-editor');
  host.textContent = '';
  for (const name of state.settings.accounts) {
    const chip = document.createElement('span');
    chip.className = 'chip chip--static';
    chip.textContent = name;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chip__del';
    del.setAttribute('aria-label', `${name} 삭제`);
    del.textContent = '×';
    del.addEventListener('click', () => {
      const accounts = state.settings.accounts.filter((a) => a !== name);
      state.settings = saveSettings({
        accounts: accounts.length ? accounts : [...DEFAULT_ACCOUNTS],
      });
      renderAccountEditor();
      renderDefaultAccount();
      renderAccounts();
      renderWidgetUrl();
    });

    chip.appendChild(del);
    host.appendChild(chip);
  }
}

function renderDefaultAccount() {
  fillAccountSelect($('setting-default-account'), state.settings.defaultAccount);
  fillAccountSelect($('setting-transfer-from'), state.settings.transferFrom, '선택 안 함');
  fillAccountSelect($('setting-transfer-to'), state.settings.transferTo, '선택 안 함');
}

function renderSyncState() {
  const dot = $('sync-dot');
  const label = $('sync-label');
  const status = $('sync-status');

  if (isConnected()) {
    dot.dataset.state = 'on';
    label.textContent = '동기화';
    const last = state.settings.lastSyncAt;
    status.textContent = last
      ? `${accountLabel()} · 마지막 동기화 ${formatDate(last)} ${formatTime(last)}`
      : `${accountLabel()} 로그인됨`;
    return;
  }
  dot.dataset.state = 'idle';
  label.textContent = '로그인';
  status.textContent = '구글 로그인을 하면 기기 간에 기록이 동기화됩니다.';
}

function renderWidgetUrl() {
  const select = $('widget-category');
  const chosen = select.value;
  select.textContent = '';
  for (const name of state.settings.categories) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
  if (state.settings.categories.includes(chosen)) select.value = chosen;

  const accountSelect = $('widget-account');
  const chosenAccount = accountSelect.value;
  accountSelect.textContent = '';
  for (const name of state.settings.accounts) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    accountSelect.appendChild(option);
  }
  accountSelect.value = state.settings.accounts.includes(chosenAccount)
    ? chosenAccount
    : state.settings.defaultAccount;

  const params = new URLSearchParams({ add: '1', type: state.type });
  const amount = $('widget-amount').value.trim();
  if (amount) params.set('amount', amount);
  if (select.value) params.set('category', select.value);
  if (accountSelect.value) params.set('account', accountSelect.value);
  if ($('widget-instant').checked && amount) params.set('save', '1');

  const base = new URL('.', location.href).href.replace(/\/$/, '');
  $('widget-url').textContent = `${base}/?${params}`;
}

async function renderStats() {
  const all = await allRaw();
  const live = all.filter((r) => !r.deleted).length;
  $('stats-line').textContent = `기록 ${num.format(live)}건 (삭제 표시 ${all.length - live}건 포함 저장)`;
}

// ── install (Add to Home screen) ──────────────────────────────────────────

// Chrome fires this instead of showing its own prompt once we preventDefault,
// which lets us offer the install from inside the app where it is findable.
let installPrompt = null;

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function renderInstallState() {
  const button = $('install-button');
  const note = $('install-note');

  if (isStandalone()) {
    button.hidden = true;
    note.textContent = '이미 설치되어 있습니다.';
    return;
  }
  if (installPrompt) {
    button.hidden = false;
    note.textContent =
      '설치하면 주소창 없이 앱처럼 열리고, 오프라인에서도 입력할 수 있습니다. 아이콘을 길게 누르면 빠른입력 바로가기도 나옵니다.';
    return;
  }

  button.hidden = true;
  // iOS has no install event; Safari only offers it from the share sheet.
  const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  note.textContent = iOS
    ? 'Safari에서 공유 버튼 → "홈 화면에 추가" 를 누르세요.'
    : '브라우저 메뉴(⋮)에서 "앱 설치" 또는 "홈 화면에 추가" 를 누르세요. 크롬에서는 잠시 뒤 이 버튼이 나타납니다.';
}

function wireInstall() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    renderInstallState();
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    renderInstallState();
    toast('홈 화면에 설치했습니다', 'ok');
  });

  $('install-button').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    // The event is single-use, whichever way the user answered.
    installPrompt = null;
    renderInstallState();
    if (outcome === 'dismissed') toast('설치를 취소했습니다');
  });
}

// ── navigation ────────────────────────────────────────────────────────────

function showView(name) {
  for (const view of document.querySelectorAll('.view')) {
    view.hidden = view.dataset.view !== name;
  }
  for (const button of document.querySelectorAll('.tabbar__btn')) {
    button.classList.toggle('is-active', button.dataset.target === name);
  }
  if (name === 'history') renderHistory();
  if (name === 'settings') {
    renderInstallState();
    renderCategoryEditor();
    renderAccountEditor();
    renderDefaultAccount();
    renderSyncState();
    renderWidgetUrl();
    renderStats();
  }
}

// ── sync glue ─────────────────────────────────────────────────────────────

let syncing = false;

async function runSync({ interactive }) {
  if (syncing) return;
  syncing = true;
  $('sync-button').classList.add('is-busy');
  try {
    const result = interactive && !isConnected() ? await connect() : await sync({ interactive });
    state.settings = loadSettings();
    $('rules-help').hidden = true;
    if (interactive) toast(`동기화 완료 · ${num.format(result.total)}건`, 'ok');
  } catch (error) {
    if (error?.needsRules) {
      $('rules-help').hidden = false;
      showView('settings');
    }
    if (interactive || !(error instanceof SyncError && error.needsConsent)) {
      toast(error instanceof SyncError ? error.message : '동기화에 실패했습니다', 'warn');
    }
  } finally {
    syncing = false;
    $('sync-button').classList.remove('is-busy');
    renderSyncState();
  }
}

/** Fire-and-forget sync after a local change; never nags when not connected. */
function backgroundSync() {
  if (!state.settings.autoSync || !isConnected()) return;
  runSync({ interactive: false });
}

// ── launch parameters (widgets, shortcuts, share target) ──────────────────

async function handleLaunchParams() {
  const params = new URLSearchParams(location.search);
  const shortcut = ['add', 'amount', 'title', 'text', 'view'].some((key) => params.has(key));
  if (!shortcut) return;

  if (params.get('view') === 'history') {
    showView('history');
    history.replaceState(null, '', new URL('.', location.href).href);
    return;
  }

  if (params.has('type')) state.type = params.get('type') === 'income' ? 'income' : 'expense';

  const shared = `${params.get('title') || ''} ${params.get('text') || ''}`.trim();
  const rawAmount = params.get('amount') || shared.replace(/[^0-9]/g, '');
  const amount = Math.round(Math.abs(Number(rawAmount) || 0));
  if (amount > 0) state.amount = amount;

  const category = params.get('category');
  if (category && state.settings.categories.includes(category)) state.category = category;
  const account = params.get('account');
  if (account && state.settings.accounts.includes(account)) state.account = account;
  renderAccounts();
  if (params.get('payee')) $('field-payee').value = params.get('payee');
  if (params.get('memo')) $('field-memo').value = params.get('memo');
  else if (shared && !params.get('amount')) $('field-memo').value = shared;

  renderTypeToggle();
  renderCategories();
  showView('entry');

  if (params.get('save') === '1' && state.amount > 0) {
    await saveEntry();
  }

  // Drop the parameters so a reload doesn't record the same payment twice.
  history.replaceState(null, '', new URL('.', location.href).href);
}

// ── wiring ────────────────────────────────────────────────────────────────

function wire() {
  for (const button of document.querySelectorAll('.tabbar__btn')) {
    button.addEventListener('click', () => showView(button.dataset.target));
  }
  for (const button of document.querySelectorAll('.typetoggle__btn')) {
    button.addEventListener('click', () => {
      state.type = button.dataset.type;
      // Editing keeps the row's own accounts; only a fresh entry gets defaults.
      if (!state.editingId) applyAccountDefaults();
      renderTypeToggle();
    });
  }

  $('keypad').addEventListener('click', (event) => {
    const key = event.target.closest('button')?.dataset.key;
    if (key) pressKey(key);
  });
  document.addEventListener('keydown', (event) => {
    if ($('view-entry').hidden) return;
    const active = document.activeElement;
    if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return;
    if (/^[0-9]$/.test(event.key)) pressKey(event.key);
    else if (event.key === 'Backspace') pressKey('back');
    else if (event.key === 'Enter') saveEntry();
  });

  $('save-button').addEventListener('click', saveEntry);
  $('cancel-edit').addEventListener('click', () => {
    resetEntry();
    toast('편집을 취소했습니다');
  });

  $('month-prev').addEventListener('click', () => {
    const d = new Date(state.month);
    state.month = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
    renderHistory();
  });
  $('month-next').addEventListener('click', () => {
    const d = new Date(state.month);
    state.month = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    renderHistory();
  });
  $('month-label').addEventListener('click', () => {
    state.month = startOfMonth(new Date());
    renderHistory();
  });
  $('search').addEventListener('input', (event) => {
    state.query = event.target.value;
    renderHistory();
  });

  $('sync-button').addEventListener('click', () => runSync({ interactive: true }));

  const currencyField = $('setting-currency');
  currencyField.value = state.settings.currency;
  currencyField.addEventListener('change', () => {
    state.settings = saveSettings({ currency: currencyField.value });
    renderKeypadStep();
    renderAmount();
    renderHistory();
  });

  $('rules-snippet').textContent = REQUIRED_RULE;
  $('rules-console-link').href = RULES_CONSOLE_URL;
  $('rules-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(REQUIRED_RULE);
      toast('규칙을 복사했습니다', 'ok');
    } catch {
      toast('복사할 수 없습니다. 길게 눌러 선택하세요', 'warn');
    }
  });

  $('sync-connect').addEventListener('click', () => runSync({ interactive: true }));
  $('sync-now').addEventListener('click', () => runSync({ interactive: true }));
  $('sync-disconnect').addEventListener('click', async () => {
    await disconnect();
    renderSyncState();
    toast('로그아웃했습니다');
  });

  $('export-csv').addEventListener('click', async () => {
    const records = await list();
    if (!records.length) {
      toast('내보낼 기록이 없습니다', 'warn');
      return;
    }
    download(csvFilename(records), toCsv(records), 'text/csv');
  });

  $('copy-handoff').addEventListener('click', async () => {
    const records = await list();
    if (!records.length) {
      toast('내보낼 기록이 없습니다', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(handoffSummary(records));
      toast('인수인계 요약을 복사했습니다', 'ok');
    } catch {
      toast('복사할 수 없습니다', 'warn');
    }
  });
  $('export-json').addEventListener('click', async () => {
    const records = await allRaw();
    download(`현금장부-백업-${formatDate(Date.now())}.json`, toJson(records), 'application/json');
  });
  $('import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const records = parseImport(await file.text(), file.name);
      await putMany(records);
      toast(`${num.format(records.length)}건을 가져왔습니다`, 'ok');
      backgroundSync();
    } catch (error) {
      toast(`가져오기 실패: ${error.message}`, 'warn');
    } finally {
      event.target.value = '';
    }
  });

  $('add-category').addEventListener('click', () => {
    const name = $('new-category').value.trim();
    if (!name || state.settings.categories.includes(name)) return;
    state.settings = saveSettings({ categories: [...state.settings.categories, name] });
    $('new-category').value = '';
    renderCategoryEditor();
    renderCategories();
    renderWidgetUrl();
  });

  $('add-account').addEventListener('click', () => {
    const name = $('new-account').value.trim();
    if (!name || state.settings.accounts.includes(name)) return;
    state.settings = saveSettings({ accounts: [...state.settings.accounts, name] });
    $('new-account').value = '';
    renderAccountEditor();
    renderDefaultAccount();
    renderAccounts();
    renderWidgetUrl();
  });

  $('setting-default-account').addEventListener('change', (event) => {
    state.settings = saveSettings({ defaultAccount: event.target.value });
    if (!state.editingId) applyAccountDefaults();
  });

  for (const [id, key] of [
    ['setting-transfer-from', 'transferFrom'],
    ['setting-transfer-to', 'transferTo'],
  ]) {
    $(id).addEventListener('change', (event) => {
      state.settings = saveSettings({ [key]: event.target.value });
      if (!state.editingId) applyAccountDefaults();
    });
  }

  $('field-account').addEventListener('change', (event) => {
    state.account = event.target.value;
  });

  $('swap-accounts').addEventListener('click', () => {
    const from = $('field-account').value;
    const to = $('field-counter-account').value;
    if (!to) {
      toast('받는 계좌를 먼저 선택하세요', 'warn');
      return;
    }
    state.account = to;
    state.counterAccount = from;
    renderAccounts();
    toast(`${to} → ${from}`);
  });

  for (const id of ['widget-amount', 'widget-category', 'widget-account', 'widget-instant']) {
    $(id).addEventListener('input', renderWidgetUrl);
  }
  $('widget-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('widget-url').textContent);
      toast('주소를 복사했습니다', 'ok');
    } catch {
      toast('복사할 수 없습니다. 주소를 길게 눌러 선택하세요', 'warn');
    }
  });

  $('wipe').addEventListener('click', async () => {
    if (!confirm('모든 기록을 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return;
    await wipe();
    toast('모두 삭제했습니다');
    backgroundSync();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') backgroundSync();
  });
  window.addEventListener('online', backgroundSync);
}

async function refresh() {
  state.records = await list();
  if (!$('view-history').hidden) renderHistory();
  if (!$('view-settings').hidden) renderStats();
}

async function main() {
  wire();
  wireInstall();
  onChange(refresh);

  renderKeypadStep();
  renderTypeToggle();
  renderCategories();
  resetEntry();
  renderSyncState();
  await refresh();
  await handleLaunchParams();

  // Firebase restores the previous sign-in itself; sync once it reports back.
  restore()
    .then((signedIn) => {
      renderSyncState();
      if (signedIn && state.settings.autoSync) runSync({ interactive: false });
    })
    .catch(() => {
      /* offline or SDK blocked — the app still works locally */
    });

  // Module scripts are deferred and main() is async, so `load` has usually
  // fired by now — waiting on it would leave the worker unregistered, and with
  // it no offline shell and no install prompt on Android.
  if ('serviceWorker' in navigator) {
    const register = () => navigator.serviceWorker.register('sw.js').catch(() => {});
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
}

main();
