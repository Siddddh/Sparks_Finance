"""Targeted TradingView merge-fetch: add ratings for specific tickers WITHOUT replacing
tv_ratings.json (re-running tradingview_ratings.py would rebuild it for a different leader
set and silently drop TV badges — see gotcha-concurrent-task-instances).

Usage: tv_merge.py TICK1,TICK2,...
"""
import json, os, sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = r"C:\Users\91635\Desktop\TXsparks\Sparks_Finance\Sparks_Finance\KV"
OUT = os.path.join(BASE, "tv_ratings.json")
EXCHANGES = ["NASDAQ", "NYSE", "AMEX"]

from tradingview_ta import get_multiple_analysis

want = [t.strip().upper() for t in sys.argv[1].split(",") if t.strip()]
cur = json.load(open(OUT, encoding="utf-8")) if os.path.exists(OUT) else {}
need = [t for t in want if not (cur.get(t) or {}).get("recommendation")]
print(f"{len(want)} requested, {len(need)} missing a rating: {need}")
if not need:
    sys.exit(0)

syms = [f"{ex}:{t}" for t in need for ex in EXCHANGES]
got = {}
for i in range(0, len(syms), 60):
    try:
        res = get_multiple_analysis(screener="america", interval="1d",
                                    symbols=syms[i:i + 60]) or {}
    except Exception as e:
        print("  ! batch failed:", repr(e)[:120]); res = {}
    for sym, a in res.items():
        if not a:
            continue
        t = sym.split(":", 1)[1]
        if t in got:
            continue
        s = a.summary or {}
        if s.get("RECOMMENDATION"):
            got[t] = {"recommendation": s.get("RECOMMENDATION"), "buy": s.get("BUY"),
                      "sell": s.get("SELL"), "neutral": s.get("NEUTRAL"), "tv_symbol": sym}

cur.update(got)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(cur, f, indent=2)
for t in need:
    r = got.get(t)
    print(f"  {'ok ' if r else 'XX '} {t}: "
          f"{r['recommendation'] + ' %s/%s/%s' % (r['buy'], r['neutral'], r['sell']) if r else 'unresolved'}")
print(f"merged {len(got)} -> tv_ratings.json (now {len(cur)} total)")
