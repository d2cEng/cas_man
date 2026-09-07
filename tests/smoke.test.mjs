// Node-runnable checks for the parts that must not silently break:
// the sync merge rule and the CSV round trip.
//
//   node --test tests/*.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const { mergeRecords, normalise, signedAmount, typeFromRow, directionFromRow, classifyMissing } =
  await import('../assets/store.js');
const { toCsv, parseImport, toJson, csvFilename, handoffSummary, formatDate, closingBalances } =
  await import('../assets/transfer.js');

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

test('다른 기기에서 지운 기록은 병합 결과에서 사라진다', () => {
  const mine = [normalise({ ...base, updatedAt: 100 })];
  // 예전 버전이 남긴 삭제 표식은 "지워졌다"는 뜻이지 보관할 행이 아니다.
  const theirs = [normalise({ ...base, deleted: true, updatedAt: 200 })];

  const { records, changed } = mergeRecords(mine, theirs);
  assert.equal(records.length, 0);
  assert.equal(changed, 1);
});

test('동기화 시점으로 다른 기기의 삭제와 아직 못 올린 기록을 구분한다', () => {
  const watermark = 1000;
  const local = [
    // 마지막 동기화 전에 올렸던 것 → 클라우드에 없으면 저쪽에서 지운 것
    normalise({ ...base, id: 'synced', updatedAt: 500 }),
    // 동기화 후에 만든 것 → 아직 못 올렸을 뿐
    normalise({ ...base, id: 'fresh', updatedAt: 1500 }),
    // 클라우드에도 있는 것 → 아무 일 없음
    normalise({ ...base, id: 'both', updatedAt: 200 }),
  ];

  assert.deepEqual(classifyMissing(local, ['both'], watermark), ['synced']);
});

test('첫 동기화에서는 아무것도 지우지 않는다', () => {
  // lastSyncAt 이 0 이면 올린 적이 없으므로 전부 새 기록이다.
  const local = [normalise({ ...base, id: 'a', updatedAt: 1 })];
  assert.deepEqual(classifyMissing(local, [], 0), []);
});

test('여기서 지운 기록은 클라우드에 남아 있어도 되살아나지 않는다', () => {
  const mine = [];
  // 지웠지만 아직 클라우드에서 못 지운 상태
  const theirs = [normalise({ ...base, id: 'gone', updatedAt: 200 })];

  const { records } = mergeRecords(mine, theirs, ['gone']);
  assert.equal(records.length, 0);

  // 대기열에 없으면 평범한 새 기록으로 받아온다.
  assert.equal(mergeRecords(mine, theirs).records.length, 1);
});

test('merge keeps a local edit that is newer than the remote copy', () => {
  const mine = [normalise({ ...base, memo: 'local', updatedAt: 300 })];
  const theirs = [normalise({ ...base, memo: 'remote', updatedAt: 200 })];

  const { records, changed } = mergeRecords(mine, theirs);
  assert.equal(records[0].memo, 'local');
  assert.equal(changed, 0);
});

test('병합 결과에는 살아 있는 기록만 남는다', () => {
  const merged = mergeRecords(
    [normalise({ ...base, id: 'a' }), normalise({ ...base, id: 'b' })],
    [
      normalise({ ...base, id: 'c' }),
      normalise({ ...base, id: 'a', deleted: true, updatedAt: Date.now() + 1000 }),
    ],
  );
  assert.deepEqual(merged.records.map((r) => r.id).sort(), ['b', 'c']);
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

test('CSV header is the 거래내역 column order in A:G, 잔액 trailing in H', () => {
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
  assert.equal(header[7], '잔액');
  assert.equal(header.length, 8);
});

test('잔액 열은 계좌별 누계라 서로 섞이지 않는다', () => {
  const rows = [
    normalise({ ...base, id: 'a', ts: Date.parse('2026-09-01T10:00'), account: '라쿠텐은행', amount: 30000, type: 'transfer', direction: 'out' }),
    normalise({ ...base, id: 'b', ts: Date.parse('2026-09-01T10:00'), account: '현금', amount: 30000, type: 'transfer', direction: 'in' }),
    normalise({ ...base, id: 'c', ts: Date.parse('2026-09-03T12:00'), account: '현금', amount: 1735, type: 'expense', category: '식비' }),
  ];
  const balances = toCsv(rows)
    .replace(/^\ufeff/, '')
    .split('\r\n')
    .slice(1, 4)
    .map((line) => line.split(',').slice(-1)[0]);

  // 라쿠텐은행 -30000 / 현금 +30000 / 현금 30000-1735
  assert.deepEqual(balances, ['-30000', '30000', '28265']);
});

test('기초 잔액(잔고신고) 행이 누계의 시작점이 된다', () => {
  const rows = [
    normalise({ ...base, id: 'o', ts: Date.parse('2026-09-06T00:00'), account: '현금', amount: 50000, type: 'income', payee: '잔고신고', memo: '잔고' }),
    normalise({ ...base, id: 'a', ts: Date.parse('2026-09-07T12:00'), account: '현금', amount: 1735, type: 'expense', category: '식비', payee: '', memo: '' }),
  ];
  const lines = toCsv(rows).replace(/^\ufeff/, '').split('\r\n');

  // 워크북이 잔고를 선언하는 방식 그대로: 거래처 잔고신고 · 범주 수입 · 비고 잔고
  assert.equal(lines[1], '2026-09-06,현금,50000,잔고신고,수입,현금장부,잔고,50000');
  assert.equal(lines[2], '2026-09-07,현금,-1735,,식비,현금장부,,48265');
});

test('기록상 최종 잔액은 현금을 먼저 보여준다', () => {
  const rows = [
    normalise({ ...base, id: 'a', account: '라쿠텐은행', amount: 30000, type: 'transfer', direction: 'out' }),
    normalise({ ...base, id: 'b', account: '현금', amount: 30000, type: 'transfer', direction: 'in' }),
    normalise({ ...base, id: 'c', account: '현금', amount: 1735, type: 'expense', category: '식비' }),
  ];
  assert.deepEqual(closingBalances(rows), [
    ['현금', 28265],
    ['라쿠텐은행', -30000],
  ]);
});

test('잔액 열이 있어도 가져오기는 그대로 동작한다', () => {
  const rows = [normalise({ ...base, account: '현금', amount: 1735, type: 'expense', category: '식비' })];
  const parsed = parseImport(toCsv(rows), 'ledger.csv');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].amount, 1735);
  assert.equal(parsed[0].account, '현금');
  // 잔액은 파생값이라 되읽지 않는다.
  assert.equal(parsed[0].잔액, undefined);
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
