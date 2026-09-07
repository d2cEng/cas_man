// CSV / JSON export and import.

import { normalise, signedAmount, typeFromRow } from './store.js';

// A:G are exactly the 거래내역 columns of the 일본 자산 관리 workbook, in order, so a
// copy of those columns pastes straight in. 시각/id/updatedAt trail behind them
// to keep a re-import lossless without disturbing that layout.
const COLUMNS = ['날짜', '계좌', '금액', '거래처', '범주', '출처', '비고', '시각', 'id', 'updatedAt'];

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

export function toCsv(records) {
  const rows = [COLUMNS.join(',')];
  for (const r of records) {
    rows.push(
      [
        formatDate(r.ts),
        r.account,
        signedAmount(r),
        r.payee,
        r.category,
        r.source,
        r.memo,
        formatTime(r.ts),
        r.id,
        r.updatedAt,
      ]
        .map(escapeCell)
        .join(','),
    );
  }
  // BOM so Excel picks UTF-8 instead of mangling the Korean columns.
  return `﻿${rows.join('\r\n')}\r\n`;
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
    return normalise({
      id: at(cells, 'id') || undefined,
      ts: parseTimestamp(at(cells, '날짜'), at(cells, '시각')),
      account: at(cells, '계좌'),
      amount: signed,
      type: typeFromRow(signed, category),
      category,
      payee: at(cells, '거래처'),
      memo: at(cells, '비고'),
      source: at(cells, '출처') || '가져오기',
      updatedAt: Number(at(cells, 'updatedAt')) || Date.now(),
    });
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
