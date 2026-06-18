"""
apply_claude_research.py — publishes Claude's per-ticker research brief to the Research tab.

The Research tab reads agent_results/{ticker}/dates/{YYYY-MM-DD} and now renders a
Claude-authored BRIEF (no 8-agent panel) alongside live TradingView widgets (chart,
financials, company profile, technical gauge). Claude supplies the qualitative read that
the widgets can't; TradingView supplies the live public numbers.

Per-ticker doc shape (all fields optional except ticker — the UI degrades gracefully):
  {
    "ticker": "AAPL", "name": "Apple Inc.",
    "signal": "STRONG BUY|WATCH|WEAK",        # optional one-word call for the snapshot chip
    "verdict": "one-line takeaway",            # optional
    "financials": {                            # last full fiscal year, public info
        "period": "FY2025 (ended Sep 2025)",
        "summary": "what the income statement / balance sheet / cash flow say",
        "highlights": ["Revenue $X, +Y% YoY", "Net income $Z", "Gross margin %", "EPS $..", ...]
    },
    "accomplishments": ["product launch / record / milestone", ...],
    "journey_52w": {                           # the past year's arc
        "summary": "narrative of the 52-week journey",
        "milestones": [ {"label": "Oct 2025", "note": "what happened"}, ... ]
    },
    "critical": {                              # the things that actually move the stock
        "risks": ["..."], "catalysts": ["..."], "watch": ["..."], "valuation": "context"
    }
  }

CLAUDE (in Cowork) authors claude_research.json from the scan data + public knowledge; this
script writes it to the SAME dated doc the Research tab reads. No Anthropic API key.

Claude authors claude_research.json:
  { "date": "YYYY-MM-DD", "analyses": [ { ticker, name, signal, verdict, financials:{...},
    accomplishments:[...], journey_52w:{...}, critical:{...} }, ... ] }

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


def _strlist(v):
    """Coerce to a clean list of non-empty strings."""
    if not isinstance(v, list):
        return []
    return [str(x).strip() for x in v if str(x).strip()]


def _norm(a: dict, day: str) -> dict:
    t = (a.get("ticker") or "").strip().upper()
    fin = a.get("financials") or {}
    jr = a.get("journey_52w") or a.get("journey") or {}
    cr = a.get("critical") or a.get("critical_info") or {}

    milestones = []
    for m in (jr.get("milestones") or []):
        if isinstance(m, dict):
            label = str(m.get("label") or m.get("date") or "").strip()
            note = str(m.get("note") or m.get("text") or "").strip()
            if note:
                milestones.append({"label": label, "note": note})
        elif str(m).strip():
            milestones.append({"label": "", "note": str(m).strip()})

    doc = {
        "ticker": t,
        "name": (a.get("name") or "").strip(),
        "signal": (a.get("signal") or "WATCH").upper(),
        "verdict": (a.get("verdict") or a.get("one_liner") or a.get("summary") or "").strip(),
        "financials": {
            "period": str(fin.get("period") or "").strip(),
            "summary": str(fin.get("summary") or "").strip(),
            "highlights": _strlist(fin.get("highlights")),
        },
        "accomplishments": _strlist(a.get("accomplishments")),
        "journey_52w": {
            "summary": str(jr.get("summary") or "").strip(),
            "milestones": milestones,
        },
        "critical": {
            "risks": _strlist(cr.get("risks")),
            "catalysts": _strlist(cr.get("catalysts")),
            "watch": _strlist(cr.get("watch")),
            "valuation": str(cr.get("valuation") or "").strip(),
        },
        "schema": "brief-v2",
        "analyzed_at": datetime.utcnow().isoformat(),
        "date": day,
        "recommended_by": "claude-cowork",
    }
    return doc


def _counts(d: dict) -> str:
    f = d["financials"]
    c = d["critical"]
    return (f"fin:{'Y' if (f['summary'] or f['highlights']) else '-'} "
            f"hl:{len(f['highlights'])} acc:{len(d['accomplishments'])} "
            f"journey:{'Y' if d['journey_52w']['summary'] else '-'} "
            f"risk:{len(c['risks'])} cat:{len(c['catalysts'])} watch:{len(c['watch'])}")


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
    print(f"  Research briefs: {len(docs)}  ({', '.join(d['ticker'] for d in docs)})  date={day}")
    for d in docs:
        print(f"    {d['ticker']}: {d['signal']} · {_counts(d)}")

    if dry:
        print("  (dry run) not writing. First brief:")
        print(json.dumps(docs[0], indent=2)[:1800])
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
            try:  # resolve the research-tab queue for requested tickers
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
        print("  done. Open the Research tab and search any of these tickers — Claude's brief shows above the live TradingView widgets.")
    except Exception as e:
        print(f"  x  publish failed: {e}")
        import traceback; traceback.print_exc(); sys.exit(1)


if __name__ == "__main__":
    main()
