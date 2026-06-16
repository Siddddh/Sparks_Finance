"""
apply_claude_recommendations.py — make the dashboard show CLAUDE's picks, not the script's.

This is the "Claude inculcation" bridge for the EXISTING UI. The scan
(run_full_scan.py) still gathers the raw data (prices, RSI, fundamentals, news) for
the whole universe — but the *recommendations* come from Claude. Claude (running in
Cowork) reviews combined_results.json and writes its calls into claude_recommendations.json;
this script merges them onto the real data and publishes to Firestore `scans/latest`.

The website is UNCHANGED — the same Top Picks cards and Market News now render Claude's
content because the *input* changed:
  - Top Picks cards   <- scans/latest.claude_picks  (Claude's picks; real metrics + Claude's signal/thesis/grade/levels)
  - Market News       <- scans/latest.market_news   (Claude-curated)
  - Market-state bar  <- scans/latest.market_health.state_advice / market_state (Claude's read)
  - Full Table        <- scans/latest.stocks        (the full scanned universe, unchanged data)

No Anthropic API key — Claude authors claude_recommendations.json itself in Cowork.

Run:  python apply_claude_recommendations.py [--dry-run] [--file claude_recommendations.json]
Pipeline:  run_full_scan.py  ->  (Claude writes claude_recommendations.json)  ->  apply_claude_recommendations.py
"""

import json, os, sys
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
SCAN_FILE = os.path.join(BASE, "combined_results.json")
RECS_FILE = os.path.join(BASE, "claude_recommendations.json")

# Qualitative fields Claude owns (override onto the real data row for each pick).
SIGNAL_VALUES = {"STRONG BUY", "WATCH", "WEAK"}


def _num(v):
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None


def _card_from(row, pick):
    """Merge Claude's call (pick) onto the scanned data row → a Top Picks card object.
    Keeps the real quantitative fields (price, rsi, criteria, patterns…); overrides
    the judgment fields (signal, score, grade, thesis, levels)."""
    card = dict(row) if row else {"ticker": pick["ticker"].upper(), "name": pick.get("name") or pick["ticker"].upper(), "sector": pick.get("sector") or "—"}
    sig = (pick.get("signal") or "STRONG BUY").upper()
    if sig not in SIGNAL_VALUES:
        sig = "STRONG BUY"
    score = pick.get("score")
    score = float(score) if isinstance(score, (int, float)) else (row.get("combined_score") if row else 0) or 0
    card["signal"] = sig
    card["score"] = score
    card["combined_score"] = score
    if pick.get("grade"):
        card["setup_quality"] = pick["grade"]
    if pick.get("thesis"):
        card["thesis"] = pick["thesis"]
    if pick.get("strengths") is not None:
        card["key_strengths"] = pick["strengths"]
    if pick.get("risks") is not None:
        card["key_risks"] = pick["risks"]
    if pick.get("watch") is not None:
        card["what_to_watch"] = pick["watch"]
    e, s, t = _num(pick.get("entry")), _num(pick.get("stop")), _num(pick.get("target"))
    if e is not None:
        card["entry"] = e
    if s is not None:
        card["stop_loss"] = s
    if t is not None:
        card["target_1"] = t
    if e and s and t and (e - s) > 0:
        card["rr_ratio"] = round((t - e) / (e - s), 1)
    card["claude_pick"] = True
    return card


def _news_item(n):
    sent = (n.get("sentiment") or n.get("sentiment_label") or "NEUTRAL").upper()
    return {
        "title": n.get("title") or "",
        "url": n.get("url") or "#",
        "outlet": n.get("outlet") or n.get("source") or "—",
        "summary": n.get("summary") or "",
        "sentiment_label": sent,
        "age_hours": n.get("age_hours", 0),
        "breaking": bool(n.get("breaking")),
    }


def build_merged(scan: dict, recs: dict) -> dict:
    out = dict(scan)
    universe = scan.get("stocks") or []
    by_ticker = {(s.get("ticker") or "").upper(): s for s in universe}

    picks_in = recs.get("picks") or []
    cards, missing = [], []
    for p in picks_in:
        t = (p.get("ticker") or "").strip().upper()
        if not t:
            continue
        row = by_ticker.get(t)
        if row is None:
            missing.append(t)  # Claude picked a ticker not in the scanned universe
        cards.append(_card_from(row, p))

    out["claude_picks"] = cards
    out["top_picks"] = [c["ticker"] for c in cards][:10]

    # Full Table + daily history: patch each rated row in the universe with Claude's
    # judgment fields (keep the real metrics), then front-load Claude's picks so the
    # table and firebase_push's history/{date} (top5 + counts) reflect Claude's calls.
    card_by_t = {c["ticker"]: c for c in cards}
    JUDGMENT = ("signal", "combined_score", "score", "setup_quality", "thesis",
                "key_strengths", "key_risks", "what_to_watch", "entry", "stop_loss", "target_1", "rr_ratio")
    for s in universe:
        c = card_by_t.get((s.get("ticker") or "").upper())
        if c:
            for k in JUDGMENT:
                if k in c:
                    s[k] = c[k]
            s["claude_pick"] = True
    order = {t: i for i, t in enumerate([c["ticker"] for c in cards])}
    front = sorted((s for s in universe if (s.get("ticker") or "").upper() in order),
                   key=lambda s: order[(s.get("ticker") or "").upper()])
    back = [s for s in universe if (s.get("ticker") or "").upper() not in order]
    out["stocks"] = front + back

    if recs.get("market_news") is not None:
        out["market_news"] = [_news_item(n) for n in recs["market_news"]]

    mh = dict(scan.get("market_health") or {})
    mkt = recs.get("market") or {}
    if mkt.get("state"):
        mh["market_state"] = mkt["state"]
    if mkt.get("advice"):
        mh["state_advice"] = mkt["advice"]
    out["market_health"] = mh

    # Provenance + freshness (carry Claude's date/time if given, else scan's).
    out["scan_date"] = recs.get("scan_date") or scan.get("scan_date")
    out["scan_time_et"] = recs.get("scan_time_et") or scan.get("scan_time_et")
    out["claude_published_at"] = datetime.utcnow().isoformat() + "Z"
    out["recommended_by"] = "claude-cowork"
    return out, missing


def main():
    dry = "--dry-run" in sys.argv
    recs_path = RECS_FILE
    if "--file" in sys.argv:
        try:
            recs_path = sys.argv[sys.argv.index("--file") + 1]
        except IndexError:
            print("  x  --file needs a path"); sys.exit(1)

    if not os.path.exists(SCAN_FILE):
        print(f"  x  {SCAN_FILE} not found — run run_full_scan.py first (it produces the data Claude reviews).")
        sys.exit(1)
    if not os.path.exists(recs_path):
        print(f"  x  {recs_path} not found — Claude should author it (see COWORK_CLAUDE_TASKS.md).")
        sys.exit(1)

    with open(SCAN_FILE, encoding="utf-8") as f:
        scan = json.load(f)
    try:
        with open(recs_path, encoding="utf-8") as f:
            recs = json.load(f)
    except json.JSONDecodeError as e:
        print(f"  x  {recs_path} is not valid JSON: {e}"); sys.exit(1)

    if not (recs.get("picks") or []):
        print("  x  claude_recommendations.json has no 'picks'. Claude must supply at least one.")
        sys.exit(1)

    merged, missing = build_merged(scan, recs)
    n = len(merged.get("claude_picks") or [])
    print(f"  Claude picks: {n}  ({', '.join(merged.get('top_picks') or [])})")
    if missing:
        print(f"  !  Not in scanned universe (no live metrics — pick from the scan when possible): {', '.join(missing)}")
    print(f"  Market read: {(merged.get('market_health') or {}).get('market_state')} — {(merged.get('market_health') or {}).get('state_advice','')[:80]}")
    print(f"  Market news items: {len(merged.get('market_news') or [])}")

    if dry:
        print("  (dry run) not writing to Firestore. Sample of first card:")
        if merged.get("claude_picks"):
            c = merged["claude_picks"][0]
            print(json.dumps({k: c.get(k) for k in ("ticker", "signal", "combined_score", "setup_quality", "entry", "stop_loss", "target_1", "rr_ratio", "thesis")}, indent=2)[:1200])
        return

    try:
        import firebase_push
    except Exception as e:
        print(f"  x  could not import firebase_push: {e}"); sys.exit(1)
    ok = firebase_push.push_to_firestore(merged, verbose=True)
    if ok:
        print("  done. The live Top Picks cards + Market News now show Claude's recommendations.")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
