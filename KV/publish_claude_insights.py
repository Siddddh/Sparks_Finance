"""
publish_claude_insights.py — pushes Claude's own analysis to Firestore.

This is the "Cowork inculcation" bridge. Unlike the rest of the pipeline (which
is rule-based Python + Finnhub), the *analysis* here is written by Claude itself
running inside Cowork — exactly like the original Mission Control's daily digest.
No Anthropic API key, no per-token billing: Claude (in this Cowork session) reads
the latest scan, writes its read of the market into claude_insights.json, then this
script publishes that text to Firestore for the live site to display.

Firestore structure:
  insights/latest        ← most recent Claude analysis (overwritten each run)
  insights/{scan_date}   ← dated copy (one per day, last run of the day wins)

Workflow (see COWORK_CLAUDE_TASKS.md):
  1. python run_full_scan.py            # or run_platform.py — produces combined_results.json
  2. python firebase_push.py            # publishes the scan numbers
  3. (Claude authors claude_insights.json from combined_results.json — by hand, in Cowork)
  4. python publish_claude_insights.py  # publishes Claude's analysis

Manual:  python publish_claude_insights.py [--dry-run] [--file path]
"""

import json, os, sys
from datetime import datetime


def _find_base():
    return os.path.dirname(os.path.abspath(__file__))


BASE = _find_base()
CREDS_PATH = os.path.join(BASE, "firebase_service_account.json")
INSIGHTS_FILE = os.path.join(BASE, "claude_insights.json")

# Fields Claude is expected to author. Only `market_digest` is strictly required;
# the rest render when present so the site degrades gracefully on a light run.
REQUIRED = ["market_digest"]
KNOWN = [
    "scan_date", "scan_time_et", "market_state", "headline", "market_digest",
    "top_setups", "risks", "watch", "bottom_line",
]


def _check_setup():
    if not os.path.exists(CREDS_PATH):
        print(f"  x  Missing service account: {CREDS_PATH}")
        print("     Firebase Console -> Project Settings -> Service Accounts -> Generate new private key")
        print("     Save it as firebase_service_account.json in this KV folder.")
        return False
    return True


def _validate(data: dict) -> list:
    """Return a list of human-readable problems (empty = OK)."""
    problems = []
    if not isinstance(data, dict):
        return ["claude_insights.json must be a JSON object."]
    for f in REQUIRED:
        if not (data.get(f) or "").strip() if isinstance(data.get(f), str) else not data.get(f):
            problems.append(f"missing required field: {f}")
    setups = data.get("top_setups")
    if setups is not None:
        if not isinstance(setups, list):
            problems.append("top_setups must be a list")
        else:
            for i, s in enumerate(setups):
                if not isinstance(s, dict) or not s.get("ticker"):
                    problems.append(f"top_setups[{i}] needs at least a 'ticker'")
    for f in ("risks", "watch"):
        if data.get(f) is not None and not isinstance(data.get(f), list):
            problems.append(f"{f} must be a list of strings")
    return problems


def publish(data: dict, dry_run: bool = False) -> bool:
    problems = _validate(data)
    if problems:
        print("  x  claude_insights.json has problems:")
        for p in problems:
            print(f"       - {p}")
        return False

    # Stamp provenance so the UI can show "by Claude · Updated <when>".
    doc = {k: data[k] for k in KNOWN if k in data}
    # carry through any extra keys Claude chose to add
    for k, v in data.items():
        if k not in doc:
            doc[k] = v
    doc["source"] = "cowork-claude"
    doc["published_at"] = datetime.utcnow().isoformat() + "Z"
    date = (data.get("scan_date") or datetime.now().strftime("%Y-%m-%d")).strip()

    if dry_run:
        print("  (dry run) would write insights/latest and insights/" + date + ":")
        print(json.dumps(doc, indent=2)[:2000])
        return True

    try:
        import firebase_admin
        from firebase_admin import credentials, firestore as fs
    except ImportError:
        print("  x  firebase-admin not installed. Run: pip install firebase-admin")
        return False
    if not _check_setup():
        return False

    try:
        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(CREDS_PATH))
        db = fs.client()
        db.collection("insights").document("latest").set(doc)
        print("  ok  Pushed -> Firestore: insights/latest")
        db.collection("insights").document(date).set(doc)
        print(f"  ok  Pushed -> Firestore: insights/{date}")
        n = len(doc.get("top_setups") or [])
        print(f"  done. {n} setup(s) published. The site's 'Claude's Take' panel will refresh live.")
        return True
    except Exception as e:
        print(f"  x  Publish failed: {e}")
        import traceback; traceback.print_exc()
        return False


def main():
    dry = "--dry-run" in sys.argv
    path = INSIGHTS_FILE
    if "--file" in sys.argv:
        try:
            path = sys.argv[sys.argv.index("--file") + 1]
        except IndexError:
            print("  x  --file needs a path"); sys.exit(1)
    if not os.path.exists(path):
        print(f"  x  {path} not found.")
        print("     Claude should author it first (see COWORK_CLAUDE_TASKS.md).")
        sys.exit(1)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"  x  {path} is not valid JSON: {e}"); sys.exit(1)
    ok = publish(data, dry_run=dry)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
