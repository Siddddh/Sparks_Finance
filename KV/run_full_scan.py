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
    "SNDK","WDC",
]

# ── Full universe: S&P 500 + NASDAQ 100 + high-interest growth stocks ─────────
# ~600 unique tickers. Morning/close run takes ~20-25 min with parallel workers.

_NASDAQ_100 = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","AVGO","TSLA","COST",
    "NFLX","AMD","PEP","INTU","QCOM","AMAT","ADBE","CSCO","TXN","AMGN",
    "HON","BKNG","CMCSA","ISRG","VRTX","REGN","PANW","MU","ADI","LRCX",
    "KLAC","INTC","ABNB","MELI","MDLZ","SBUX","GILD","SNPS","CDNS","ADP",
    "PYPL","CRWD","CEG","ORLY","CSX","KDP","MRVL","PCAR","MRNA","DXCM",
    "PAYX","CTAS","NXPI","WDAY","FTNT","FAST","GEHC","TTD","ROST","ODFL",
    "CTSH","MCHP","EA","BIIB","ZS","TEAM","IDXX","ANSS","DLTR","WBD",
    "VRSK","ILMN","ON","EXC","KHC","DDOG","BKR","CCEP","FANG","CDW",
    "CSGP","XEL","MNST","SIRI","CHTR","ALGN","PDD","JD","LULU",
]

_SP500_FINANCIALS = [
    "JPM","BAC","WFC","GS","MS","SCHW","AXP","BLK","SPGI","CB","MMC","PGR",
    "TRV","AFL","ALL","HIG","AON","MET","AIG","PRU","PFG","CINF","RJF",
    "ICE","CME","MCO","COF","DFS","SYF","AMP","TROW","STT","BK","NTRS",
    "FITB","KEY","RF","CFG","HBAN","MTB","USB","PNC","C","TFC","ALLY",
    "BRO","NDAQ","FNF","LNC","RGA","GL","AIZ","UNM","WRB","ACGL","RE",
]
_SP500_HEALTHCARE = [
    "UNH","LLY","JNJ","ABBV","MRK","TMO","DHR","ABT","ELV","HUM","CI",
    "MDT","SYK","BSX","BDX","IQV","HCA","REGN","ZBH","ZTS","MCK","CVS",
    "CAH","CNC","MOH","BAX","EW","PODD","HOLX","MTD","WAT","A","ALGN",
    "RMD","GEHC","TECH","HSIC","COO","DVA","PGNY","VTRS","CTLT","SOLV",
]
_SP500_ENERGY = [
    "XOM","CVX","COP","SLB","EOG","OXY","MPC","PSX","VLO","HES","DVN",
    "FANG","HAL","BKR","APA","MRO","CTRA","OKE","WMB","KMI","LNG","EQT",
    "TRGP","NRG","VST","AES",
]
_SP500_CONS_DISC = [
    "HD","MCD","NKE","LOW","TJX","MAR","HLT","GM","F","AZO","TSCO","ROST",
    "BBY","EBAY","ETSY","RCL","CCL","LVS","MGM","WYNN","DRI","YUM","CMG",
    "DPZ","APTV","BWA","PHM","LEN","DHI","TOL","NVR","POOL","HAS","MAT",
    "NCLH","VFC","PVH","RL","DECK","CROX","BOOT","COLM","SKX","LULU",
]
_SP500_CONS_STAPLES = [
    "WMT","PG","KO","PEP","COST","PM","MO","MDLZ","CL","STZ","K","GIS",
    "HRL","SJM","MKC","HSY","CAG","CPB","CLX","CHD","EL","KMB","TAP",
    "TSN","KHC","SFM","ADM","CTVA","SYY","BG","MOS","CF","FMC","COTY",
]
_SP500_INDUSTRIALS = [
    "GE","CAT","BA","HON","RTX","UNP","UPS","FDX","ETN","EMR","ITW","DE",
    "CSX","NSC","LMT","NOC","GD","ROP","OTIS","CARR","CMI","PH","IR",
    "AME","FAST","IEX","SNA","GWW","TDG","HWM","RSG","WM","ROK","JCI",
    "MMM","DOV","XYL","GNRC","LDOS","LHX","TXT","AXON","CACI","SAIC",
    "JBHT","CHRW","EXPD","XPO","ODFL","SAIA","WERN","HUBG",
]
_SP500_TECH = [
    "ORCL","CRM","IBM","ACN","HPE","HPQ","KEYS","MPWR","AKAM","VRSN",
    "TYL","FSLR","ENPH","SEDG","GLW","GRMN","FFIV","STX","WDC","NTAP",
    "ANET","ZBRA","CDW","CTSH","MU","SNPS","CDNS","ADBE","FTNT","NXPI",
    "ON","MRVL","NOW","CRWD","SMCI","PANW","FICO",
]
_SP500_UTILITIES = [
    "NEE","DUK","SO","D","AEP","EXC","XEL","PEG","SRE","PCG","AWK","WEC",
    "ES","DTE","CMS","ATO","NI","CNP","ETR","PPL","EIX","EVRG","AEE",
    "IDA","AVA","POR","BKH","LNT","OGE","OTTR",
]
_SP500_REALESTATE = [
    "PLD","EQIX","AMT","CCI","SPG","O","VICI","PSA","EXR","MAA","UDR",
    "AVB","EQR","ESS","SUI","ELS","NNN","WPC","FR","REXR","DLR","IRM",
    "SBAC","ARE","BXP","VNO","KIM","REG","FRT","EPRT","STAG","TRNO","IIPR",
    "COR","MPW","SBA",
]
_SP500_MATERIALS = [
    "LIN","APD","SHW","ECL","FCX","NEM","NUE","CF","MOS","EMN","PPG",
    "CE","AVY","IP","PKG","BALL","SON","SEE","ALB","FMC","RPM","OLN",
    "ASH","VMC","MLM","STLD","RS","CLF","CMC","NUE",
]
_SP500_COMMS = [
    "META","GOOGL","GOOG","NFLX","CHTR","CMCSA","DIS","PARA","WBD","VZ",
    "T","TMUS","EA","TTWO","OMC","IPG","NWSA","FOXA","FOX","IAC","MTCH",
    "LYFT","UBER","SNAP","PINS","RBLX",
]
# High-interest growth stocks beyond S&P 500/NASDAQ 100
_GROWTH_EXTRAS = [
    "COIN","HOOD","SPOT","SHOP","SE","MELI","BIDU","JD",
    "SNOW","OKTA","DOCU","RIVN","PLTR","ARM","TSM","ASML","NVO",
    "SOUN","IONQ","RKLB","JOBY","ACHR","QBTS","RGTI","LUNR",
    "CELH","DECK","FICO","SMCI","AXON","SNDK","WDC",
]
# Major ETFs (scanned for market breadth + user holdings)
_MAJOR_ETFS = [
    "SPY","QQQ","IWM","DIA","VTI","VOO","VEA","VWO",
    "GLD","SLV","TLT","IEF","HYG","LQD",
    "XLK","XLF","XLV","XLE","XLI","XLC","XLP","XLU","XLRE","XLY","XLB",
    "SMH","IBB","XBI","XOP","ARKK","ARKG","ARKW",
]

# Deduplicated master list — ~620 unique symbols
FULL_LIST = list(dict.fromkeys(
    _NASDAQ_100
    + _SP500_FINANCIALS + _SP500_HEALTHCARE + _SP500_ENERGY
    + _SP500_CONS_DISC  + _SP500_CONS_STAPLES + _SP500_INDUSTRIALS
    + _SP500_TECH       + _SP500_UTILITIES   + _SP500_REALESTATE
    + _SP500_MATERIALS  + _SP500_COMMS
    + _GROWTH_EXTRAS    + _MAJOR_ETFS
))

# Custom watchlist — add any ticker here to always include it in every scan
CUSTOM_WATCHLIST = [
    # ── Recent IPOs (force-scanned even with thin history; flagged is_new_listing) ──
    "SPCX",     # SpaceX — IPO 2026-06-12, Nasdaq (largest IPO ever)
    # add new IPOs here as they list, e.g. "ARM", "RDDT", "CART"
]

# Held tickers across ALL user portfolios — written by gather_holdings.py as scan_include.json.
# Always merged into the scan so every holding gets real metrics (for Claude's per-position
# calls), even in quick mode and even if the ticker isn't in the S&P/NASDAQ universe.
def _held_tickers():
    try:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scan_include.json")
        if os.path.exists(p):
            with open(p) as f:
                data = json.load(f)
            arr = data.get("tickers") if isinstance(data, dict) else data
            return [str(t).strip().upper() for t in (arr or []) if str(t).strip()]
    except Exception:
        pass
    return []

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

    # Always include custom watchlist + every user-held ticker (deduplicated)
    all_tickers = list(dict.fromkeys(tickers + CUSTOM_WATCHLIST + _held_tickers()))

    if mode == "news":
        prev = load_prev()
        stock_rows = prev.get("stocks", [])
        tickers_for_news = [s["ticker"] for s in stock_rows[:15]]
    else:
        tickers = all_tickers
        # Curated watchlist + held tickers are "forced" — score them even with little history
        # (so fresh IPOs like SPCX appear); the broad universe keeps the default 50-day minimum.
        forced = {t.upper() for t in (CUSTOM_WATCHLIST + _held_tickers())}
        n_workers = min(20, len(tickers))
        print(f"[{datetime.now():%H:%M}] Scanning {len(tickers)} stocks with {n_workers} parallel workers…", flush=True)
        from concurrent.futures import ThreadPoolExecutor, as_completed
        import threading
        _lock = threading.Lock()
        stock_rows = []
        completed = [0]

        def _scan_one(t):
            try:
                return score_stock(t, min_history=(2 if t.upper() in forced else 50))
            except Exception:
                return None

        with ThreadPoolExecutor(max_workers=n_workers) as ex:
            futures = {ex.submit(_scan_one, t): t for t in tickers}
            for future in as_completed(futures):
                t = futures[future]
                r = future.result()
                with _lock:
                    completed[0] += 1
                    if r:
                        stock_rows.append(r)
                        print(f"  [{completed[0]}/{len(tickers)}] {t}: {r['score']:.0f} {r['signal']} | "
                              f"VCP:{r.get('is_vcp',False)} RS@High:{r.get('rs_at_high',False)}", flush=True)
                    else:
                        print(f"  [{completed[0]}/{len(tickers)}] {t}: skip (no data)", flush=True)

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
