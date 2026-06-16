"""
apply_claude_research.py — publishes Claude's per-ticker deep analysis to the Research tab.

The Research tab reads agent_results/{ticker}/dates/{YYYY-MM-DD} and renders an
"8-Agent Analysis" panel from these per-dimension objects:
  fundamentals / technical / earnings / analyst / valuation / insider / risk / catalyst
  each: { "score": 0-100, "sentiment": "BULLISH|NEUTRAL|BEARISH", "summary": "...", "signals": ["..."] }
plus top-level: composite_score, signal, summary.

Instead of the rule-based 8 agents, CLAUDE (in Cowork) authors that analysis from the
scan data (combined_results.json) + its own reasoning, and this script writes it to the
SAME doc the Research tab already reads. Dated path => browsable history of what was
researched. No Anthropic API key.

Claude authors claude_research.json:
  { "date": "YYYY-MM-DD", "analyses": [ { ticker, signal, composite_score, summary, fundamentals:{...}, ... } ] }

Run:  python apply_claude_research.py [--dry-run] [--file claude_research.json]
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
RESEARCH_FILE = os.path.join(BASE, "claude_research.json")

DIMENSIONS = ["fundamentals", "technical", "earnings", "analyst", "valuation", "insider", "risk", "catalyst"]


def _norm(a: dict, day: str) -> dict:
    t = (a.get("ticker") or "").strip().upper()
    doc = {
        "ticker": t,
        "signal": (a.get("signal") or "WATCH").upper(),
        "composite_score": a.get("composite_score") if a.get("composite_score") is not None else a.get("score", 50),
        "summary": a.get("summary") or "",
        "full_analysis": a.get("full_analysis") or "",
        "analyzed_at": datetime.utcnow().isoformat(),
        "date": day,
        "recommended_by": "claude-cowork",
    }
    for k in DIMENSIONS:
        v = a.get(k)
        if isinstance(v, dict):
            doc[k] = {
                "score": v.get("score", 50),
                "sentiment": (v.get("sentiment") or v.get("verdict") or "NEUTRAL"),
                "summary": v.get("summary") or "",
                "signals": v.get("signals") or [],
            }
    # allow a free-form 'agents' array as an alternative the UI also understands
    if isinstance(a.get("agents"), list):
        doc["agents"] = a["agents"]
    return doc


def main():
    dry = "--dry-run" in sys.argv
    path = RESEARCH_FILE
    if "--file" in sys.argv:
        try:
            path = sys.argv[sys.argv.index("--file") + 1]
        except IndexError:
            print("  x  --file needs a path"); sys.exit(1)
    if not os.path.exists(path):
        print(f"  x  {path} not found — Claude should author it (see COWORK_CLAUDE_TASKS.md).")
        sys.exit(1)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"  x  {path} is not valid JSON: {e}"); sys.exit(1)

    day = (data.get("date") or _date.today().isoformat()).strip()
    analyses = data.get("analyses") or []
    analyses = [a for a in analyses if (a.get("ticker") or "").strip()]
    if not analyses:
        print("  x  no 'analyses' with a ticker found."); sys.exit(1)

    docs = [_norm(a, day) for a in analyses]
    print(f"  Research analyses: {len(docs)}  ({', '.join(d['ticker'] for d in docs)})  date={day}")
    for d in docs:
        dims = [k for k in DIMENSIONS if k in d]
        print(f"    {d['ticker']}: {d['signal']} {d['composite_score']} · {len(dims)} dimensions")

    if dry:
        print("  (dry run) not writing. First analysis:")
        print(json.dumps(docs[0], indent=2)[:1500])
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
        for d in docs:
            db.collection("agent_results").document(d["ticker"]).collection("dates").document(day).set(d)
            print(f"  ok  agent_results/{d['ticker']}/dates/{day}")
            # clear the research queue so the Research-tab spinner resolves for requested tickers
            try:
                db.collection("agent_queue").document(d["ticker"]).set({"status": "done", "done_at": datetime.utcnow().isoformat()}, merge=True)
            except Exception:
                pass
        try:  # local dated archive so past research is browsable
            import shutil
            dd = os.path.join(BASE, "claude_history", day); os.makedirs(dd, exist_ok=True)
            shutil.copy(path, os.path.join(dd, "claude_research.json"))
            print(f"  ok  local copy -> claude_history/{day}/claude_research.json")
        except Exception as e:
            print(f"  !  local archive failed: {e}")
        print("  done. Open the Research tab and search any of these tickers — Claude's analysis shows under '8-Agent Analysis'.")
    except Exception as e:
        print(f"  x  publish failed: {e}")
        import traceback; traceback.print_exc(); sys.exit(1)


if __name__ == "__main__":
    main()
