"""
Master runner v2 — stock scan + news + market health + thesis + journal stats.
Saves to combined_results.json consumed by build_dashboard.py.

Modes:
  python run_full_scan.py           → quick scan (20 stocks) + everything
  python run_full_scan.py --full    → full scan (90+ stocks)
  python run_full_scan.py --news    → news-only refresh (keep last scores)
"""
import json, sys, os, warnings
warnings.filterwarnings("ignore")
from datetime import datetime

import re as _re
# Detect active session path dynamically (works across Cowork session restarts)
def _find_base():
    # Always resolve relative to this file's directory
    return os.path.dirname(os.path.abspath(__file__))

BASE            = _find_base()
OUT             = os.path.join(BASE, "combined_results.json")
HISTORY_PATH    = os.path.join(BASE, "scan_history.json")
HISTORY_MAX_DAYS = 7

QUICK_LIST = [
    "NVDA","MSFT","AAPL","META","AVGO","AMD","PANW","NOW","CRWD","AXON",
    "LRCX","KLAC","AMAT","GE","CAT","ETN","FICO","DECK","CELH","SMCI",
    # High-momentum spin-offs & recent additions
    "SNDK","WDC",
]
FULL_LIST = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","LLY","AVGO","JPM","TSLA",
    "UNH","V","XOM","MA","PG","JNJ","COST","HD","MRK","ABBV","CVX","NFLX",
    "CRM","BAC","AMD","PEP","KO","ACN","TMO","WMT","ORCL","MCD","ABT","CSCO",
    "GE","DHR","NEE","TXN","PM","ISRG","CAT","AMGN","RTX","NOW","INTU","SPGI",
    "HON","IBM","BKNG","GS","QCOM","T","LOW","AMAT","UNP","SYK","VRTX","BLK",
    "PLD","ELV","MDT","GILD","DE","TJX","ADP","MMC","PANW","SCHW","ADI",
    "LRCX","MO","CI","CB","ZTS","MDLZ","SO","CME","REGN","EOG","BSX","PGR",
    "WM","NOC","KLAC","HUM","ITW","CSX","NSC","ETN","MCO","TGT","DUK",
    "FICO","DECK","CRWD","SMCI","AXON","CELH",
    # Spin-offs & high-momentum recent additions
    "SNDK","WDC",
]

# Custom watchlist — add any ticker here to always include it in every scan
CUSTOM_WATCHLIST = [
    # "SNDK",  # already in lists above — add others here e.g. "ARM", "PLTR"
]

# ── History helpers ─────────────────────────────────────────
def load_history() -> dict:
    """Returns {dates: [...], 'YYYY-MM-DD': {...scan_result...}}"""
    try:
        with open(HISTORY_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"dates": []}

def save_to_history(result: dict, encoder_cls):
    """Upsert today's scan into history. Last run of the day always wins.
    Prunes entries older than HISTORY_MAX_DAYS."""
    h = load_history()
    today = result["scan_date"]                # "YYYY-MM-DD"

    # Upsert: remove old entry for today if it exists, add fresh one
    h[today] = result
    if today not in h.get("dates", []):
        h.setdefault("dates", []).append(today)

    # Sort dates descending, keep latest HISTORY_MAX_DAYS only
    h["dates"] = sorted(set(h["dates"]), reverse=True)[:HISTORY_MAX_DAYS]

    # Purge any date keys no longer in the rolling window
    for k in list(h.keys()):
        if k != "dates" and k not in h["dates"]:
            del h[k]

    with open(HISTORY_PATH, "w") as f:
        json.dump(h, f, cls=encoder_cls)

    kept = h["dates"]
    print(f"  History: {len(kept)} day(s) stored → {', '.join(kept)}", flush=True)

class SafeEncoder(json.JSONEncoder):
    def default(self, o):
        import numpy as np
        if isinstance(o, (np.bool_,)):   return bool(o)
        if isinstance(o, (np.integer,)): return int(o)
        if isinstance(o, (np.floating,)):return float(o)
        try: return super().default(o)
        except: return str(o)

def load_prev():
    try:
        with open(OUT) as f: return json.load(f)
    except: return {}

def score_label(s):
    return "STRONG BUY" if s >= 75 else "WATCH" if s >= 55 else "WEAK"

def run(mode="quick"):
    sys.path.insert(0, BASE)
    from breakout_scanner  import score_stock
    from news_fetcher      import run_news_scan
    from market_health     import get_market_health
    from thesis_generator  import generate_thesis
    from trade_journal     import get_stats, init_journal

    init_journal()

    # ── 1. Market health (always fresh) ──
    print(f"[{datetime.now():%H:%M}] Fetching market health…", flush=True)
    mh = get_market_health()
    print(f"  Market: {mh['market_state']} | VIX: {mh['vix']} | Dist days: {mh['dist_days']}", flush=True)

    # ── 2. Stock scan ──
    tickers = QUICK_LIST if mode in ("quick","news") else FULL_LIST

    # Always include custom watchlist (deduplicated)
    all_tickers = list(dict.fromkeys(tickers + CUSTOM_WATCHLIST))

    if mode == "news":
        prev = load_prev()
        stock_rows = prev.get("stocks", [])
        tickers_for_news = [s["ticker"] for s in stock_rows[:15]]
    else:
        tickers = all_tickers
        print(f"[{datetime.now():%H:%M}] Scanning {len(tickers)} stocks…", flush=True)
        stock_rows = []
        for i, t in enumerate(tickers):
            r = score_stock(t)
            if r:
                stock_rows.append(r)
                print(f"  [{i+1}/{len(tickers)}] {t}: {r['score']:.0f} {r['signal']} | "
                      f"VCP:{r.get('is_vcp',False)} RS@High:{r.get('rs_at_high',False)} "
                      f"VDU:{r.get('is_vdu',False)}", flush=True)
        stock_rows.sort(key=lambda x: x["score"], reverse=True)
        tickers_for_news = [s["ticker"] for s in stock_rows[:15]]

    # ── 3. News ──
    print(f"[{datetime.now():%H:%M}] Fetching news…", flush=True)
    news_data = run_news_scan(tickers_for_news)

    # ── 4. Merge news + scores ──
    for s in stock_rows:
        t = s["ticker"]
        n = news_data["ticker_news"].get(t, {})
        addon = n.get("news_score_addon", 0)
        s["news_score_addon"]  = addon
        s["news_sentiment"]    = n.get("news_sentiment", "NEUTRAL")
        s["has_catalyst"]      = n.get("has_catalyst", False)
        s["has_breaking_news"] = n.get("has_breaking", False)
        s["top_news"]          = n.get("top_news", [])
        s["combined_score"]    = round(min(100, max(0, s["score"] + addon)), 1)
        s["signal"]            = score_label(s["combined_score"])

    stock_rows.sort(key=lambda x: x["combined_score"], reverse=True)

    # ── 5. Generate thesis for top 12 ──
    print(f"[{datetime.now():%H:%M}] Generating trade theses…", flush=True)
    for s in stock_rows[:12]:
        try:
            th = generate_thesis(s)
            s["thesis"]        = th["thesis"]
            s["setup_quality"] = th["setup_quality"]
            s["key_strengths"] = th["key_strengths"]
            s["key_risks"]     = th["key_risks"]
            s["what_to_watch"] = th["what_to_watch"]
        except Exception as e:
            s["thesis"] = "Thesis unavailable."
            s["setup_quality"] = "—"
            s["key_strengths"] = []
            s["key_risks"] = []
            s["what_to_watch"] = []

    # ── 6. Update market breadth now we have scores ──
    mh["breadth_pct"] = round(
        sum(1 for s in stock_rows if s.get("price",0) > s.get("ma50",999)) / len(stock_rows) * 100, 0
    ) if stock_rows else None
    mh["breadth_label"] = (
        f"{mh['breadth_pct']:.0f}% above MA50 — {'Healthy 🟢' if mh['breadth_pct'] >= 65 else 'Moderate 🟡' if mh['breadth_pct'] >= 50 else 'Narrow 🔴'}"
        if mh["breadth_pct"] is not None else "—"
    )

    # ── 7. Mid-day alerts ──
    alerts = []
    for s in stock_rows:
        for art in s.get("top_news", []):
            if art.get("breaking") or art.get("catalyst"):
                alerts.append({
                    "ticker": s["ticker"], "name": s["name"], "price": s["price"],
                    "score": s["combined_score"], "signal": s["signal"],
                    "news_title": art["title"], "outlet": art["outlet"],
                    "url": art["url"], "sentiment": art["sentiment"],
                    "age_hours": art["age_hours"], "catalyst": art.get("catalyst", False),
                })
    alerts.sort(key=lambda x: (x["catalyst"], -x["score"]), reverse=True)

    # ── 8. Journal stats ──
    journal_stats = get_stats()

    # ── 9. Save ──
    result = {
        "scan_date":      datetime.now().strftime("%Y-%m-%d"),
        "scan_time":      datetime.now().strftime("%H:%M"),
        "scan_time_et":   datetime.now().strftime("%I:%M %p") + " ET",
        "mode":           mode,
        "universe":       len(tickers),
        "passed":         len(stock_rows),
        "stocks":         stock_rows,
        "top_picks":      stock_rows[:10],
        "alerts":         alerts[:15],
        "market_news":    news_data["market_news"],
        "news_fetched_at":news_data["fetched_at"],
        "market_health":  mh,
        "journal_stats":  journal_stats,
    }
    with open(OUT, "w") as f:
        json.dump(result, f, indent=2, cls=SafeEncoder)
    print(f"[{datetime.now():%H:%M}] ✓ Saved latest → {OUT}", flush=True)

    # Save to rolling 7-day local history (last run of each day wins)
    save_to_history(result, SafeEncoder)

    # Push to Firebase Firestore (if configured)
    try:
        from firebase_push import push_to_firestore
        print(f"[{datetime.now():%H:%M}] Pushing to Firestore…", flush=True)
        push_to_firestore(result, verbose=True)
    except ImportError:
        pass  # firebase_push.py not present — skip silently
    except Exception as e:
        print(f"  ⚠ Firebase push skipped: {e}", flush=True)

    return result

if __name__ == "__main__":
    mode = "quick"
    if "--full" in sys.argv: mode = "full"
    if "--news" in sys.argv: mode = "news"
    run(mode)
