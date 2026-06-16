"""
gather_holdings.py — dump every portfolio owner's holdings so Claude can analyze them.

Per-user step of the Home flow. Reads (admin SDK) all users' holdings, dedups by ticker
(weighted-average cost), and writes holdings_dump.json. Claude (in Cowork) then reads that
dump + the scan data and authors per-holding buy/sell calls into claude_holdings.json, which
apply_claude_holdings.py publishes to claude_holdings/{uid} for each user's Home dashboard.

Run:  python gather_holdings.py
Output: holdings_dump.json  { "<uid>": { "holdings": [ { ticker, qty, avg_cost } ] } }
"""

import json, os, sys

# Windows consoles default to cp1252 and crash on non-ASCII prints (→, ✓, —). Force UTF-8
# so prints never raise (which, in the publish scripts, could otherwise abort before a write).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = os.path.dirname(os.path.abspath(__file__))
CREDS_PATH = os.path.join(BASE, "firebase_service_account.json")
OUT = os.path.join(BASE, "holdings_dump.json")
INCLUDE = os.path.join(BASE, "scan_include.json")  # held tickers → run_full_scan.py merges these in


def main():
    if not os.path.exists(CREDS_PATH):
        print(f"  x  Missing {CREDS_PATH}"); sys.exit(1)
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore as fs
    except ImportError:
        print("  x  firebase-admin not installed. Run: pip install firebase-admin"); sys.exit(1)
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(CREDS_PATH))
    db = fs.client()

    out = {}
    try:
        uids = [d.id for d in db.collection("portfolios").list_documents()]
    except Exception as e:
        print(f"  x  could not list portfolio owners: {e}"); sys.exit(1)

    for uid in uids:
        merged = {}  # ticker -> {qty, cost}
        try:
            for col in db.collection("holdings").document(uid).collections():  # each portfolioId
                for doc in col.stream():
                    h = doc.to_dict() or {}
                    t = (h.get("ticker") or "").upper()
                    if not t:
                        continue
                    qty = float(h.get("qty") or 0)
                    buy = float(h.get("buy_price") or 0)
                    m = merged.setdefault(t, {"qty": 0.0, "cost": 0.0})
                    m["qty"] += qty
                    m["cost"] += qty * buy
        except Exception as e:
            print(f"  !  {uid}: {e}")
            continue
        holdings = [
            {"ticker": t, "qty": round(m["qty"], 4), "avg_cost": round(m["cost"] / m["qty"], 2) if m["qty"] else 0}
            for t, m in sorted(merged.items())
        ]
        if holdings:
            out[uid] = {"holdings": holdings}

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    # Deduped list of every held ticker → run_full_scan.py merges these in so each
    # holding gets real metrics regardless of scan mode / universe membership.
    held = sorted({h["ticker"] for v in out.values() for h in v["holdings"]})
    with open(INCLUDE, "w", encoding="utf-8") as f:
        json.dump({"tickers": held, "updated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z"}, f, indent=2)

    n_users = len(out)
    n_pos = sum(len(v["holdings"]) for v in out.values())
    print(f"  ok  wrote {OUT}: {n_users} user(s), {n_pos} position(s).")
    print(f"  ok  wrote {INCLUDE}: {len(held)} held ticker(s) → will be force-included in the next scan.")
    print("  Next: run `python run_full_scan.py --full` (held tickers are now auto-included),")
    print("        then Claude writes claude_holdings.json, then `python apply_claude_holdings.py`.")


if __name__ == "__main__":
    main()
