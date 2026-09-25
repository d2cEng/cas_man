// CSV / JSON export and import.

import { contentId, directionFromRow, normalise, signedAmount, typeFromRow } from './store.js';

// A:G are exactly the 거래내역 columns of the 일본 자산 관리 workbook, in order, so
// the file drops into archive/ as a source original and build_ledger.py reads it
// unchanged. 잔액 trails behind them as H: a derived column, there so the ledger
// balance can be held against the cash actually in hand.
const COLUMNS = ['날짜', '계좌', '금액', '거래처', '범주', '출처', '비고', '잔액'];

function pad(n) {
  return String(n).padStart(2, '0');
}

export function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// The ledger's cash account. Only its rows are exported.
const CASH = '현금';

/**
 * `(짝: 로킨 -17,000)` — where a 이체's cash came from or went, in the form the
 * workbook's own cash-side 이체 rows already use in 비고.
 */
function counterpartNote(record, halves) {
  if (record.type !== 'transfer' || !record.group) return '';
  const other = (halves.get(record.group) || []).find((r) => r.direction !== record.direction);
  if (!other) return '';
  return `(짝: ${other.account} ${signedAmount(other).toLocaleString('en-US')})`;
}

/**
 * What goes into the ledger: cash rows only, oldest first, deterministic so md5
 * dedupe works.
 *
 * This app records cash flow. The other side of a 이체 — the bank an ATM
 * withdrawal came out of, the 와리깡 a friend repaid — is named on the cash row
 * rather than written as a row of its own: the bank's own data already carries
 * the bank side, and matching the two is the ledger's job, not this app's. An
 * ATM fee is charged to the bank, so it stays out for the same reason.
 */
function forExport(records) {
  const halves = new Map();
  for (const r of records) {
    if (r.type !== 'transfer' || !r.group) continue;
    if (!halves.has(r.group)) halves.set(r.group, []);
    halves.get(r.group).push(r);
  }

  return records
    .filter((r) => r.account === CASH)
    .map((r) => {
      const note = counterpartNote(r, halves);
      return note ? { ...r, memo: [r.memo, note].filter(Boolean).join(' ') } : r;
    })
    .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

export function toCsv(records) {
  const rows = [COLUMNS.join(',')];

  // Running cash balance, in the order the rows are written — the number to hold
  // against the wallet. It only means anything while that order holds, which is
  // why the export is always sorted.
  const running = new Map();

  for (const r of forExport(records)) {
    const balance = (running.get(r.account) || 0) + signedAmount(r);
    running.set(r.account, balance);

    rows.push(
      [
        formatDate(r.ts),
        r.account,
        signedAmount(r),
        r.payee,
        r.category,
        r.source,
        r.memo,
        balance,
      ]
        .map(escapeCell)
        .join(','),
    );
  }
  // BOM so Excel picks UTF-8 instead of mangling the Korean columns.
  return `﻿${rows.join('\r\n')}\r\n`;
}

/** Closing balance per 계좌 over the whole export, cash first. */
export function closingBalances(records) {
  const totals = new Map();
  for (const r of forExport(records)) {
    totals.set(r.account, (totals.get(r.account) || 0) + signedAmount(r));
  }
  return [...totals.entries()].sort(([a], [b]) => (a === '현금' ? -1 : b === '현금' ? 1 : a.localeCompare(b)));
}

/**
 * Self-describing name so exports accumulate in archive/ without collisions and
 * the covered period is readable straight off the filename.
 */
export function csvFilename(records) {
  const sorted = forExport(records);
  if (!sorted.length) return '현금장부_빈장부.csv';
  const from = formatDate(sorted[0].ts).replace(/-/g, '');
  const to = formatDate(sorted[sorted.length - 1].ts).replace(/-/g, '');
  return `현금장부_${from}-${to}_${sorted.length}건.csv`;
}

/**
 * The numbers a Cowork session needs for rule 5 (독립 검산) and rule 6 (출처 계보),
 * as a markdown block to paste into the handoff prompt.
 */
export function handoffSummary(records) {
  const sorted = forExport(records);
  const sum = (type) =>
    sorted.filter((r) => r.type === type).reduce((total, r) => total + r.amount, 0);
  const count = (type) => sorted.filter((r) => r.type === type).length;
  const moved = (sign) =>
    sorted
      .filter((r) => r.type === 'transfer' && Math.sign(signedAmount(r)) === sign)
      .reduce((total, r) => total + r.amount, 0);
  const yen = (n) => n.toLocaleString('ko-KR');

  const period = sorted.length
    ? `${formatDate(sorted[0].ts)} ~ ${formatDate(sorted[sorted.length - 1].ts)}`
    : '(없음)';

  const accounts = [...new Set(sorted.map((r) => r.account))].join(', ') || '(없음)';
  const sources = [...new Set(sorted.map((r) => r.source))].join(', ') || '(없음)';

  return [
    '## 현금장부 내보내기',
    '',
    `- 파일: \`${csvFilename(records)}\``,
    `- 기간: ${period}`,
    `- 건수: ${sorted.length}건 (지출 ${count('expense')} / 수입 ${count('income')} / 이체 ${count('transfer')})`,
    `- 지출 합계: ${yen(sum('expense'))}`,
    `- 수입 합계: ${yen(sum('income'))}`,
    `- 이체: 유입 ${yen(moved(1))} / 유출 ${yen(moved(-1))} (수입·지출 집계 제외)`,
    `- 계좌: ${accounts}`,
    `- 출처: ${sources}`,
    '',
    '### 기록상 최종 잔액',
    '',
    ...closingBalances(sorted).map(([account, value]) => `- ${account}: ${yen(value)}`),
    '',
    'A~G열은 거래내역 시트와 동일(`날짜,계좌,금액,거래처,범주,출처,비고`), 날짜 오름차순.',
    '**현금 계좌 행만** 담습니다. 이체의 상대 계좌는 비고의 `(짝: 계좌 금액)` 에 있고, 그 행은',
    '포함하지 않습니다 — 은행 쪽은 은행 데이터에서 오며, 대조와 날짜 보정은 원장에서 합니다.',
    'H열 `잔액` 은 현금 누계(파생값)이므로 정렬을 바꾸면 의미가 깨집니다 — 지갑 대조용입니다.',
    '금액은 현금 기준: 들어오면 양수, 나가면 음수. archive/ 에 넣고 _MANIFEST.csv 에 md5 등록하세요.',
  ].join('\n');
}

export function toJson(records) {
  return JSON.stringify({ app: 'cas_man', version: 1, exportedAt: Date.now(), records }, null, 2);
}

export function download(filename, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Split one CSV line, honouring quoted cells. */
function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function parseTimestamp(dateText, timeText) {
  const date = String(dateText || '').trim();
  if (!date) return Date.now();
  const time = String(timeText || '').trim() || '00:00';
  const parsed = Date.parse(`${date.replace(/[./]/g, '-')}T${time.length === 5 ? time : '00:00'}`);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function fromCsv(text) {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const index = (name) => header.indexOf(name);
  const at = (cells, name) => {
    const i = index(name);
    return i === -1 ? '' : cells[i];
  };

  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const signed = Number(String(at(cells, '금액')).replace(/[^0-9.-]/g, ''));
    const category = at(cells, '범주');
    const record = normalise({
      ts: parseTimestamp(at(cells, '날짜'), at(cells, '시각')),
      account: at(cells, '계좌'),
      amount: signed,
      type: typeFromRow(signed, category),
      // The sign is what tells the two halves of a 이체 apart on the way back in.
      direction: directionFromRow(signed),
      category,
      payee: at(cells, '거래처'),
      memo: at(cells, '비고'),
      source: at(cells, '출처') || '가져오기',
      updatedAt: Number(at(cells, 'updatedAt')) || Date.now(),
    });
    // An explicit id wins; otherwise hash the content so re-importing the same
    // file updates the same rows instead of duplicating them.
    return { ...record, id: at(cells, 'id') || contentId(record) };
  });
}

/** Accept either our JSON backup or a CSV in the shape we export. */
export function parseImport(text, filename = '') {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const payload = JSON.parse(trimmed);
    const records = Array.isArray(payload) ? payload : payload.records;
    if (!Array.isArray(records)) throw new Error('records 배열을 찾을 수 없습니다.');
    return records.map(normalise);
  }
  if (filename.toLowerCase().endsWith('.json')) {
    throw new Error('JSON 형식이 올바르지 않습니다.');
  }
  return fromCsv(text);
}
