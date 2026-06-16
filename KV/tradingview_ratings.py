"""
tradingview_ratings.py — fetch TradingView's technical rating for the scan's leaders.

Adds a SECOND, independent technical opinion (TradingView's Strong Buy/Buy/Neutral/Sell
gauge) to the pipeline so Claude can weigh it in its thesis and the app can show it next to
Claude's call. Free, unofficial (uses the `tradingview-ta` library, which reads TradingView's
public technical-analysis endpoint).

Flow: run AFTER run_full_scan.py and BEFORE Claude authors claude_recommendations.json, so
Claude can cross-check its picks against TradingView. apply_claude_recommendations.py then
merges each pick's rating onto its card for display.

Writes tv_ratings.json:  { "<TICKER>": {recommendation, buy, sell, neutral, tv_symbol}, ... }
Run:  python tradingview_ratings.py [--limit 60]
"""

import json, os, sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = os.path.dirname(os.path.abspath(__file__))
SCAN_FILE = os.path.join(BASE, "combined_results.json")
INCLUDE = os.path.join(BASE, "scan_include.json")
OUT = os.path.join(BASE, "tv_ratings.json")
EXCHANGES = ["NASDAQ", "NYSE", "AMEX"]   # try each; whichever resolves wins


def _candidates(limit):
    """Tickers to rate: the scan's STRONG BUY leaders + every held ticker."""
    with open(SCAN_FILE, encoding="utf-8") as f:
        d = json.load(f)
    sb = sorted([s for s in d.get("stocks", []) if s.get("signal") == "STRONG BUY"],
                key=lambda s: -(s.get("combined_score") or s.get("score") or 0))
    tickers = [s["ticker"] for s in sb[:limit]]
    try:
        if os.path.exists(INCLUDE):
            held = json.load(open(INCLUDE, encoding="utf-8")).get("tickers", [])
            for t in held:
                if t not in tickers:
                    tickers.append(t)
    except Exception:
        pass
    return [t.upper() for t in tickers]


def main():
    limit = 60
    if "--limit" in sys.argv:
        try:
            limit = int(sys.argv[sys.argv.index("--limit") + 1])
        except Exception:
            pass
    if not os.path.exists(SCAN_FILE):
        print(f"  x  {SCAN_FILE} not found — run run_full_scan.py first."); sys.exit(1)
    try:
        from tradingview_ta import get_multiple_analysis
    except ImportError:
        print("  x  tradingview-ta not installed. Run: pip install tradingview-ta"); sys.exit(1)

    tickers = _candidates(limit)
    equities = [t for t in tickers if not t.endswith("-USD")]
    cryptos = [t for t in tickers if t.endswith("-USD")]
    print(f"  Rating {len(equities)} equities (+{len(cryptos)} crypto) via TradingView…")

    ratings = {}

    # Equities: try NASDAQ/NYSE/AMEX, keep whichever resolves. Batch the lookups.
    def _fmt(a):
        s = a.summary or {}
        return {"recommendation": s.get("RECOMMENDATION"), "buy": s.get("BUY"),
                "sell": s.get("SELL"), "neutral": s.get("NEUTRAL")}

    syms = [f"{ex}:{t}" for t in equities for ex in EXCHANGES]
    for i in range(0, len(syms), 60):
        batch = syms[i:i + 60]
        try:
            res = get_multiple_analysis(screener="america", interval="1d", symbols=batch) or {}
        except Exception as e:
            print(f"  !  batch failed: {repr(e)[:120]}"); res = {}
        for sym, a in res.items():
            if not a:
                continue
            t = sym.split(":", 1)[1]
            if t in ratings:
                continue   # first resolving exchange wins
            r = _fmt(a); r["tv_symbol"] = sym
            ratings[t] = r

    # Crypto (BTC-USD -> COINBASE:BTCUSD on the crypto screener)
    if cryptos:
        csyms = [f"COINBASE:{t.replace('-USD','')}USD" for t in cryptos]
        try:
            res = get_multiple_analysis(screener="crypto", interval="1d", symbols=csyms) or {}
            for t, sym in zip(cryptos, csyms):
                a = res.get(sym)
                if a:
                    r = _fmt(a); r["tv_symbol"] = sym
                    ratings[t] = r
        except Exception as e:
            print(f"  !  crypto batch failed: {repr(e)[:120]}")

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(ratings, f, indent=2)
    got = len(ratings)
    rec_counts = {}
    for r in ratings.values():
        rec_counts[r["recommendation"]] = rec_counts.get(r["recommendation"], 0) + 1
    print(f"  ok  wrote {OUT}: {got}/{len(tickers)} resolved. Distribution: {rec_counts}")
    print("  Next: Claude reads tv_ratings.json (cross-check picks), then apply_claude_recommendations.py merges it onto the cards.")


if __name__ == "__main__":
    main()
