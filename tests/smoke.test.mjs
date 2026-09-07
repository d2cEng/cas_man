// Node-runnable checks for the parts that must not silently break:
// the sync merge rule and the CSV round trip.
//
//   node --test tests/*.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const { mergeRecords, normalise, signedAmount, typeFromRow, directionFromRow } = await import(
  '../assets/store.js'
);
const { toCsv, parseImport, toJson, csvFilename, handoffSummary, formatDate } = await import(
  '../assets/transfer.js'
);

const base = {
  id: 'a',
  ts: Date.parse('2026-03-04T12:30:00'),
  account: '현금',
  amount: 12000,
  type: 'expense',
  category: '식비',
  payee: '세븐일레븐',
  memo: '점심, "특선"',
  source: '현금장부',
};

test('normalise coerces amounts to positive integers', () => {
  assert.equal(normalise({ ...base, amount: -12000.4 }).amount, 12000);
  assert.equal(normalise({ ...base, amount: 'x' }).amount, 0);
  assert.equal(normalise({ ...base, type: 'nonsense' }).type, 'expense');
  assert.equal(normalise({ ...base, account: '  ' }).account, '현금');
});

test('수입 and 이체 carry the workbook 범주 regardless of what is passed in', () => {
  assert.equal(normalise({ ...base, type: 'income', category: '식비' }).category, '수입');
  assert.equal(normalise({ ...base, type: 'transfer', category: '식비' }).category, '이체');
  assert.equal(normalise({ ...base, type: 'expense', category: '교통' }).category, '교통');
});

test('signed 금액 matches the 거래내역 convention', () => {
  assert.equal(signedAmount(normalise({ ...base, type: 'expense' })), -12000);
  assert.equal(signedAmount(normalise({ ...base, type: 'income' })), 12000);
  assert.equal(signedAmount(normalise({ ...base, type: 'transfer' })), -12000);
});

test('이체 의 두 행은 반대 부호를 가져 서로 상쇄된다', () => {
  const out = normalise({ ...base, id: 'o', type: 'transfer', direction: 'out', account: '라쿠텐은행', amount: 30000 });
  const income = normalise({ ...base, id: 'i', type: 'transfer', direction: 'in', account: '현금', amount: 30000 });

  assert.equal(signedAmount(out), -30000);
  assert.equal(signedAmount(income), 30000);
  // 계좌 오라클: 이체만으로는 순자산이 변하지 않는다.
  assert.equal(signedAmount(out) + signedAmount(income), 0);
});

test('ATM 수수료는 이체가 아니라 지출로 남아 순자산을 줄인다', () => {
  const rows = [
    normalise({ ...base, id: 'o', type: 'transfer', direction: 'out', account: '라쿠텐은행', amount: 30000 }),
    normalise({ ...base, id: 'i', type: 'transfer', direction: 'in', account: '현금', amount: 30000 }),
    normalise({ ...base, id: 'f', type: 'expense', account: '라쿠텐은행', amount: 220, category: '기타', memo: '수수료' }),
  ];
  const net = rows.reduce((sum, r) => sum + signedAmount(r), 0);
  assert.equal(net, -220);

  // 지출 집계에는 수수료만 잡힌다 (규칙 4: 이체 제외).
  const spend = rows.filter((r) => r.type === 'expense').reduce((sum, r) => sum + r.amount, 0);
  assert.equal(spend, 220);
});

test('부호로 이체의 어느 쪽인지 되읽는다', () => {
  assert.equal(directionFromRow(-30000), 'out');
  assert.equal(directionFromRow(30000), 'in');
});

test('이체 CSV 왕복 후에도 양쪽 부호가 보존된다', () => {
  const rows = [
    normalise({ ...base, id: 'o', type: 'transfer', direction: 'out', account: '라쿠텐은행', amount: 30000, payee: 'ATM', memo: '' }),
    normalise({ ...base, id: 'i', type: 'transfer', direction: 'in', account: '현금', amount: 30000, payee: 'ATM', memo: '' }),
  ];
  const parsed = parseImport(toCsv(rows), 'ledger.csv');
  const net = parsed.reduce((sum, r) => sum + signedAmount(r), 0);
  assert.equal(net, 0);
  assert.equal(parsed.filter((r) => r.direction === 'out').length, 1);
  assert.equal(parsed.filter((r) => r.direction === 'in').length, 1);
});

test('type is inferred from a signed 금액 and its 범주', () => {
  assert.equal(typeFromRow(-1735, '식비'), 'expense');
  assert.equal(typeFromRow(50000, '수입'), 'income');
  assert.equal(typeFromRow(-100000, '이체'), 'transfer');
  // 이체 rows exist with either sign in the workbook.
  assert.equal(typeFromRow(100000, '이체'), 'transfer');
});

test('merge keeps the newer copy of a record', () => {
  const mine = [normalise({ ...base, memo: 'old', updatedAt: 100 })];
  const theirs = [normalise({ ...base, memo: 'new', updatedAt: 200 })];

  const { records, changed } = mergeRecords(mine, theirs);
  assert.equal(records.length, 1);
  assert.equal(records[0].memo, 'new');
  assert.equal(changed, 1);
});

test('merge does not resurrect a record deleted elsewhere', () => {
  const mine = [normalise({ ...base, updatedAt: 100 })];
  const theirs = [normalise({ ...base, deleted: true, updatedAt: 200 })];

  const { records } = mergeRecords(mine, theirs);
  assert.equal(records[0].deleted, true);
});

test('merge keeps a local edit that is newer than the remote copy', () => {
  const mine = [normalise({ ...base, memo: 'local', updatedAt: 300 })];
  const theirs = [normalise({ ...base, memo: 'remote', updatedAt: 200 })];

  const { records, changed } = mergeRecords(mine, theirs);
  assert.equal(records[0].memo, 'local');
  assert.equal(changed, 0);
});

test('동기화 건수는 삭제 표식을 빼고 센다', () => {
  // 병합 결과에는 삭제 표식이 남아 전파되지만, 사용자가 가진 기록 수는 아니다.
  const merged = mergeRecords(
    [
      normalise({ ...base, id: 'a' }),
      normalise({ ...base, id: 'b' }),
      normalise({ ...base, id: 'c', deleted: true }),
    ],
    [
      normalise({ ...base, id: 'd', deleted: true }),
      normalise({ ...base, id: 'e', deleted: true }),
    ],
  );
  assert.equal(merged.records.length, 5);
  assert.equal(merged.records.filter((r) => !r.deleted).length, 2);
});

test('merge is idempotent, so repeated syncs converge', () => {
  const mine = [normalise({ ...base, updatedAt: 100 })];
  const theirs = [normalise({ ...base, id: 'b', updatedAt: 200 })];

  const first = mergeRecords(mine, theirs);
  const second = mergeRecords(first.records, theirs);
  assert.equal(second.changed, 0);
  assert.equal(second.records.length, 2);
});

test('merge unions records from both sides', () => {
  const { records } = mergeRecords(
    [normalise({ ...base, id: 'a' })],
    [normalise({ ...base, id: 'b' })],
  );
  assert.deepEqual(
    records.map((r) => r.id).sort(),
    ['a', 'b'],
  );
});

test('CSV header is the 거래내역 column order in A:G', () => {
  const header = toCsv([]).replace(/^\ufeff/, '').split('\r\n')[0].split(',');
  assert.deepEqual(header, [
    '날짜',
    '계좌',
    '금액',
    '거래처',
    '범주',
    '출처',
    '비고',
  ]);
});

test('CSV writes 금액 signed, the way the workbook stores it', () => {
  const cells = toCsv([normalise(base)]).replace(/^\ufeff/, '').split('\r\n')[1].split(',');
  assert.equal(cells[1], '현금');
  assert.equal(cells[2], '-12000');
  assert.equal(cells[5], '현금장부');
});

test('CSV survives a round trip with commas and quotes intact', () => {
  const record = normalise(base);
  const parsed = parseImport(toCsv([record]), 'ledger.csv');

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].memo, '점심, "특선"');
  assert.equal(parsed[0].account, '현금');
  assert.equal(parsed[0].amount, 12000);
  assert.equal(parsed[0].type, 'expense');
  assert.equal(parsed[0].category, '식비');
  assert.equal(parsed[0].source, '현금장부');
  // The ledger keeps dates, not clock times, so compare to the day.
  assert.equal(formatDate(parsed[0].ts), formatDate(record.ts));
});

test('re-importing the same CSV updates rows instead of duplicating them', () => {
  const csv = toCsv([normalise(base), normalise({ ...base, id: 'b', amount: 300, payee: 'JR' })]);
  const first = parseImport(csv, 'ledger.csv');
  const second = parseImport(csv, 'ledger.csv');

  // Content-derived ids, so the second pass lands on the same rows.
  assert.deepEqual(
    first.map((r) => r.id),
    second.map((r) => r.id),
  );
  const merged = mergeRecords(first, second);
  assert.equal(merged.records.length, 2);
});

test('a changed row gets a different id than the one it replaces', () => {
  const [a] = parseImport(toCsv([normalise(base)]), 'a.csv');
  const [b] = parseImport(toCsv([normalise({ ...base, amount: 99 })]), 'b.csv');
  assert.notEqual(a.id, b.id);
});

test('export filename carries the period and the row count', () => {
  const records = [
    normalise({ ...base, id: 'a', ts: Date.parse('2025-07-20T10:00:00') }),
    normalise({ ...base, id: 'b', ts: Date.parse('2026-09-07T10:00:00') }),
  ];
  assert.equal(csvFilename(records), '현금장부_20250720-20260907_2건.csv');
});

test('CSV rows come out oldest first, whatever order they went in', () => {
  const late = normalise({ ...base, id: 'a', ts: Date.parse('2026-09-07T10:00:00') });
  const early = normalise({ ...base, id: 'b', ts: Date.parse('2025-07-20T10:00:00') });
  const dates = toCsv([late, early])
    .replace(/^\ufeff/, '')
    .split('\r\n')
    .slice(1, 3)
    .map((line) => line.split(',')[0]);
  assert.deepEqual(dates, ['2025-07-20', '2026-09-07']);
});

test('handoff summary reports the numbers a ledger session verifies against', () => {
  const records = [
    normalise({ ...base, id: 'a', type: 'expense', amount: 1735 }),
    normalise({ ...base, id: 'b', type: 'income', amount: 50000 }),
    normalise({ ...base, id: 'c', type: 'transfer', amount: 100000 }),
  ];
  const summary = handoffSummary(records);
  assert.match(summary, /지출 1 \/ 수입 1 \/ 이체 1/);
  assert.match(summary, /지출 합계: 1,735/);
  assert.match(summary, /수입 합계: 50,000/);
  assert.match(summary, /이체 합계: 100,000/);
});

test('a bare 거래내역 export imports without the trailing columns', () => {
  const csv = ['날짜,계좌,금액,거래처,범주,출처,비고', '2023-10-31,현금,-1735,세븐일레븐,식비,DB원본,편의점'].join(
    '\r\n',
  );
  const [record] = parseImport(csv, 'db.csv');
  assert.equal(record.account, '현금');
  assert.equal(record.amount, 1735);
  assert.equal(record.type, 'expense');
  assert.equal(record.category, '식비');
  assert.equal(record.payee, '세븐일레븐');
  assert.equal(record.memo, '편의점');
  assert.equal(record.source, 'DB원본');
});

test('CSV export is BOM-prefixed for Excel', () => {
  assert.ok(toCsv([normalise(base)]).startsWith('﻿'));
});

test('JSON backup round trips losslessly', () => {
  const record = normalise({ ...base, deleted: true });
  const parsed = parseImport(toJson([record]), 'backup.json');
  assert.deepEqual(parsed, [record]);
});

test('import rejects malformed JSON files', () => {
  assert.throws(() => parseImport('{"nope": 1}', 'backup.json'));
});
