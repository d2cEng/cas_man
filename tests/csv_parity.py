#!/usr/bin/env python3
"""The app and tools/fetch_firestore.py must emit the same CSV, byte for byte.

Both write files that land in archive/ and are deduped by md5, so a difference
as small as a date rounding or a quoting rule would quietly create two "copies"
of the same export. This runs the same records through both implementations and
compares the bytes.

    python3 tests/csv_parity.py
"""

import json
import subprocess
import sys
import tempfile
from datetime import timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from fetch_firestore import csv_filename, to_csv  # noqa: E402

JST = timezone(timedelta(hours=9))

# Deliberately awkward: a 이체 pair, a fee, a tombstone, a comma and quotes in
# 비고, two rows sharing a timestamp, and an opening balance.
RECORDS = [
    {"id": "o", "ts": 1757116800000, "account": "현금", "amount": 50000, "type": "income",
     "direction": "out", "category": "수입", "payee": "잔고신고", "memo": "잔고",
     "source": "현금장부", "deleted": False},
    {"id": "t1", "ts": 1757203200000, "account": "라쿠텐은행", "amount": 30000, "type": "transfer",
     "direction": "out", "category": "이체", "payee": "ATM", "memo": "",
     "source": "현금장부", "deleted": False},
    {"id": "t2", "ts": 1757203200000, "account": "현금", "amount": 30000, "type": "transfer",
     "direction": "in", "category": "이체", "payee": "ATM", "memo": "",
     "source": "현금장부", "deleted": False},
    {"id": "f", "ts": 1757203260000, "account": "라쿠텐은행", "amount": 220, "type": "expense",
     "direction": "out", "category": "기타", "payee": "ATM", "memo": "수수료",
     "source": "현금장부", "deleted": False},
    {"id": "e", "ts": 1757289600000, "account": "현금", "amount": 1735, "type": "expense",
     "direction": "out", "category": "식비", "payee": "세븐일레븐", "memo": '점심, "특선"',
     "source": "현금장부", "deleted": False},
    {"id": "x", "ts": 1757289600000, "account": "현금", "amount": 999, "type": "expense",
     "direction": "out", "category": "기타", "payee": "삭제됨", "memo": "",
     "source": "현금장부", "deleted": True},
]

SCRIPT = """
const fs = require('fs');
Promise.all([
  import('%(root)s/assets/transfer.js'),
  import('%(root)s/assets/store.js'),
]).then(([t, s]) => {
  const recs = JSON.parse(fs.readFileSync('%(fixture)s', 'utf8'))
    .filter((r) => !r.deleted)
    .map(s.normalise);
  fs.writeFileSync('%(out)s', t.toCsv(recs));
  process.stdout.write(t.csvFilename(recs));
});
"""


def main() -> int:
    live = [r for r in RECORDS if not r["deleted"]]

    with tempfile.TemporaryDirectory() as tmp:
        fixture = Path(tmp) / "fixture.json"
        js_out = Path(tmp) / "js.csv"
        fixture.write_text(json.dumps(RECORDS, ensure_ascii=False), encoding="utf-8")

        # The app formats dates in the phone's local zone; pin node to the same
        # one the script defaults to, or the comparison tests the clock instead.
        result = subprocess.run(
            ["node", "-e", SCRIPT % {"root": ROOT, "fixture": fixture, "out": js_out}],
            capture_output=True,
            text=True,
            env={"TZ": "Asia/Tokyo", "PATH": "/usr/bin:/bin:/usr/local/bin"},
        )
        if result.returncode != 0:
            print(result.stderr, file=sys.stderr)
            return 1

        js_bytes = js_out.read_bytes()
        js_name = result.stdout.strip()

    py_bytes = to_csv(live, JST).encode("utf-8")
    py_name = csv_filename(live, JST)

    ok = True
    if js_bytes != py_bytes:
        ok = False
        print("CSV 내용이 다릅니다.\n--- 앱 ---")
        print(js_bytes.decode("utf-8"))
        print("--- 스크립트 ---")
        print(py_bytes.decode("utf-8"))
    if js_name != py_name:
        ok = False
        print(f"파일명이 다릅니다: 앱 {js_name!r} / 스크립트 {py_name!r}")

    print("CSV parity OK" if ok else "CSV parity FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
