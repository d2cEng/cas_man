// Node-runnable checks for the parts that must not silently break:
// the sync merge rule and the CSV round trip.
//
//   node --test tests/*.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const { mergeRecords, normalise, signedAmount, typeFromRow } = await import('../assets/store.js');
const { toCsv, parseImport, toJson } = await import('../assets/transfer.js');

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
  assert.deepEqual(header.slice(0, 7), [
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
  assert.equal(parsed[0].id, record.id);
  assert.equal(parsed[0].memo, '점심, "특선"');
  assert.equal(parsed[0].account, '현금');
  assert.equal(parsed[0].amount, 12000);
  assert.equal(parsed[0].type, 'expense');
  // The CSV drops seconds, so compare to the minute.
  assert.equal(Math.floor(parsed[0].ts / 60000), Math.floor(record.ts / 60000));
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
