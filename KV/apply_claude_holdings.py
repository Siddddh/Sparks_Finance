"""
apply_claude_holdings.py — publishes Claude's per-holding analysis to each user's Home.

Reads claude_holdings.json (authored by Claude from holdings_dump.json + the scan data) and
writes claude_holdings/{uid} for each user. The Home dashboard's 52-week section reads
claude_holdings/{currentUid} and shows Claude's per-position call (action + why) instead of
the rule-based one, falling back to the rule-based call when Claude hasn't covered a ticker.

claude_holdings.json:
{
  "date": "YYYY-MM-DD",
  "users": {
    "<uid>": { "holdings": [ { "ticker": "AAPL", "action": "HOLD", "why": "..." } ] }
  }
}

Firestore: claude_holdings/{uid}  (owner-read; admin-write — see firestore.rules)
Run:  python apply_claude_holdings.py [--dry-run] [--file claude_holdings.json]
"""

import json, os, sys
from datetime import datetime, date as _date

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = os.path.dirname(os.path.abspath(__file__))
CREDS_PATH = os.path.join(BASE, "firebase_service_account.json")
HOLDINGS_FILE = os.path.join(BASE, "claude_holdings.json")


def _doc_for(entry: dict, day: str) -> dict:
    by_ticker, ordered = {}, []
    for h in entry.get("holdings") or []:
        t = (h.get("ticker") or "").strip().upper()
        if not t:
            continue
        rec = {"action": (h.get("action") or "HOLD"), "why": h.get("why") or ""}
        by_ticker[t] = rec
        ordered.append(dict(rec, ticker=t))
    return {
        "date": day,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "recommended_by": "claude-cowork",
        "by_ticker": by_ticker,   # site looks up by ticker
        "holdings": ordered,
    }


def main():
    dry = "--dry-run" in sys.argv
    path = HOLDINGS_FILE
    if "--file" in sys.argv:
        try:
            path = sys.argv[sys.argv.index("--file") + 1]
        except IndexError:
            print("  x  --file needs a path"); sys.exit(1)
    if not os.path.exists(path):
        print(f"  x  {path} not found — Claude should author it from holdings_dump.json (see COWORK_CLAUDE_TASKS.md).")
        sys.exit(1)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"  x  {path} is not valid JSON: {e}"); sys.exit(1)

    day = (data.get("date") or _date.today().isoformat()).strip()
    users = data.get("users") or {}
    users = {u: e for u, e in users.items() if (e.get("holdings"))}
    if not users:
        print("  x  no 'users' with holdings found."); sys.exit(1)

    docs = {uid: _doc_for(entry, day) for uid, entry in users.items()}
    print(f"  Users: {len(docs)}  ·  positions: {sum(len(d['holdings']) for d in docs.values())}  ·  date={day}")
    for uid, d in docs.items():
        print(f"    {uid[:8]}…: {', '.join(h['ticker'] + ' (' + h['action'] + ')' for h in d['holdings'][:6])}{' …' if len(d['holdings'])>6 else ''}")

    if dry:
        print("  (dry run) not writing. First user doc:")
        first = next(iter(docs.values()))
        print(json.dumps(first, indent=2)[:1200])
        return

    if not os.path.exists(CREDS_PATH):
        print(f"  x  Missing {CREDS_PATH}"); sys.exit(1)
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore as fs
    except ImportError:
        print("  x  firebase-admin not installed. Run: pip install firebase-admin"); sys.exit(1)
    try:
        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(CREDS_PATH))
        db = fs.client()
        for uid, d in docs.items():
            db.collection("claude_holdings").document(uid).set(d)
            print(f"  ok  claude_holdings/{uid}")
        try:  # local dated archive so past per-holding calls are browsable
            import shutil
            dd = os.path.join(BASE, "claude_history", day); os.makedirs(dd, exist_ok=True)
            shutil.copy(path, os.path.join(dd, "claude_holdings.json"))
            print(f"  ok  local copy -> claude_history/{day}/claude_holdings.json")
        except Exception as e:
            print(f"  !  local archive failed: {e}")
        print("  done. Each user's Home 52-week section now shows Claude's per-position call.")
    except Exception as e:
        print(f"  x  publish failed: {e}")
        import traceback; traceback.print_exc(); sys.exit(1)


if __name__ == "__main__":
    main()
