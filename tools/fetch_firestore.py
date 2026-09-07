#!/usr/bin/env python3
"""Read the ledger straight out of Firestore and write the 거래내역 CSV.

This is the same file the app's "거래내역 CSV" button produces — same columns,
same ordering, same 잔액 column — so it drops into archive/ and dedupes by md5
whichever way it was made. Use it when a Cowork session should pull the records
itself instead of waiting for an export from the phone.

    pip install google-cloud-firestore
    python3 tools/fetch_firestore.py --key ~/keys/cas-man-reader.json

The key is a read-only service account (roles/datastore.viewer). Keep it out of
git and out of the archive.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ID = "cas-man-ca57a"
COLLECTION = "cashman"

# The app writes dates in the phone's local time, so read them back in the same
# zone or rows land on the wrong day either side of midnight.
DEFAULT_TZ = timezone(timedelta(hours=9))  # Asia/Tokyo

COLUMNS = ["날짜", "계좌", "금액", "거래처", "범주", "출처", "비고", "잔액"]

SIGN = {"expense": -1, "income": 1}


def signed_amount(record: dict) -> int:
    """Signed 금액, matching signedAmount() in assets/store.js."""
    amount = int(record.get("amount") or 0)
    if record.get("type") == "transfer":
        # The receiving half of a 이체 is the one row whose sign is positive.
        return amount if record.get("direction") == "in" else -amount
    return SIGN.get(record.get("type"), -1) * amount


def escape_cell(value) -> str:
    text = "" if value is None else str(value)
    if any(c in text for c in ',"\n\r'):
        return '"' + text.replace('"', '""') + '"'
    return text


def to_csv(records: list[dict], tz: timezone) -> str:
    """Byte-for-byte the same shape as toCsv() in assets/transfer.js."""
    rows = [",".join(COLUMNS)]
    running: dict[str, int] = {}

    for record in sorted(records, key=lambda r: (r["ts"], r["id"])):
        account = record.get("account", "")
        balance = running.get(account, 0) + signed_amount(record)
        running[account] = balance

        day = datetime.fromtimestamp(record["ts"] / 1000, tz).strftime("%Y-%m-%d")
        rows.append(
            ",".join(
                escape_cell(v)
                for v in (
                    day,
                    account,
                    signed_amount(record),
                    record.get("payee", ""),
                    record.get("category", ""),
                    record.get("source", ""),
                    record.get("memo", ""),
                    balance,
                )
            )
        )

    # BOM so Excel picks UTF-8 instead of mangling the Korean columns.
    return "﻿" + "\r\n".join(rows) + "\r\n"


def csv_filename(records: list[dict], tz: timezone) -> str:
    if not records:
        return "현금장부_빈장부.csv"
    ordered = sorted(records, key=lambda r: (r["ts"], r["id"]))
    day = lambda r: datetime.fromtimestamp(r["ts"] / 1000, tz).strftime("%Y%m%d")
    return f"현금장부_{day(ordered[0])}-{day(ordered[-1])}_{len(records)}건.csv"


def fetch(key_path: Path, uid: str | None) -> list[dict]:
    try:
        from google.cloud import firestore
    except ImportError:
        sys.exit("google-cloud-firestore 가 필요합니다:  pip install google-cloud-firestore")

    db = firestore.Client.from_service_account_json(str(key_path), project=PROJECT_ID)

    if not uid:
        # A subcollection can exist without its parent document, and
        # list_documents() still reports those parents.
        uids = [doc.id for doc in db.collection("users").list_documents()]
        if len(uids) != 1:
            sys.exit(f"uid 를 특정할 수 없습니다 (후보 {uids}). --uid 로 지정하세요.")
        uid = uids[0]

    records = []
    for doc in db.collection(f"users/{uid}/{COLLECTION}").stream():
        record = doc.to_dict() or {}
        if record.get("deleted"):
            continue  # tombstones exist to propagate deletions, not to export
        record["id"] = doc.id
        record["ts"] = int(record.get("ts") or 0)
        records.append(record)

    return records


def main() -> None:
    parser = argparse.ArgumentParser(description="Firestore 에서 거래내역 CSV 를 내려받습니다.")
    parser.add_argument("--key", required=True, type=Path, help="서비스 계정 JSON 키 경로")
    parser.add_argument("--uid", help="대상 사용자 uid (생략하면 자동 탐지)")
    parser.add_argument("--out", type=Path, default=Path("."), help="저장 폴더 (기본: 현재 폴더)")
    parser.add_argument("--tz", type=int, default=9, help="날짜 기준 시간대 오프셋 (기본: +9 JST)")
    args = parser.parse_args()

    tz = timezone(timedelta(hours=args.tz))
    records = fetch(args.key, args.uid)

    if not records:
        print("기록이 없습니다.")
        return

    args.out.mkdir(parents=True, exist_ok=True)
    path = args.out / csv_filename(records, tz)
    text = to_csv(records, tz)
    path.write_text(text, encoding="utf-8", newline="")

    digest = hashlib.md5(path.read_bytes()).hexdigest()
    balances: dict[str, int] = {}
    for record in records:
        account = record.get("account", "")
        balances[account] = balances.get(account, 0) + signed_amount(record)

    print(f"{path}  ({len(records)}건)")
    print(f"md5: {digest}")
    print("기록상 최종 잔액:")
    for account, value in sorted(balances.items(), key=lambda kv: (kv[0] != "현금", kv[0])):
        print(f"  {account}: {value:,}")


if __name__ == "__main__":
    main()
