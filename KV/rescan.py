"""Re-scan the full universe at LOW concurrency and patch combined_results.json.

Why: run_full_scan.py uses 20 parallel workers; on this run Yahoo throttled it so hard
that all 423 surviving rows came back with NaN Close (price/ma50/rsi/momentum all NaN,
zero STRONG BUYs) while volume/fundamentals still populated. Sequential re-fetch of the
same tickers via the same score_stock() returns real prices, so it's a concurrency problem.
This re-scores every ticker with a small worker pool + jitter and replaces stocks[].

Usage: rescan.py [--workers N] [--test N] [--only T1,T2]
"""
import json, os, random, sys, threading, time
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = r"C:\Users\91635\Desktop\TXsparks\Sparks_Finance\Sparks_Finance\KV"
sys.path.insert(0, BASE)

import run_full_scan as R
from breakout_scanner import score_stock, curve_score


def arg(name, default=None):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default


WORKERS = int(arg("--workers", 5))
TEST = arg("--test")
ONLY = arg("--only")


def score_label(s):
    return "STRONG BUY" if s >= 75 else "WATCH" if s >= 55 else "WEAK"


held = R._held_tickers()
tickers = list(dict.fromkeys(R.FULL_LIST + R.CUSTOM_WATCHLIST + held))
forced = {t.upper() for t in (R.CUSTOM_WATCHLIST + held)}
if ONLY:
    tickers = [t.strip().upper() for t in ONLY.split(",")]
if TEST:
    tickers = tickers[:int(TEST)]

print(f"Re-scanning {len(tickers)} tickers with {WORKERS} workers "
      f"({len(forced)} forced/low-history)", flush=True)

lock = threading.Lock()
rows, failed, nanpx = [], [], []
done = [0]


def is_nan(v):
    return v is None or (isinstance(v, float) and v != v)


def one(t):
    tu = t.upper()
    mh = 2 if tu in forced else 50
    for attempt in range(3):
        try:
            time.sleep(random.uniform(0.05, 0.5))
            r = score_stock(t, min_history=mh)
            if r and not is_nan(r.get("price")):
                raw = r.get("score_raw", r["score"])
                r["news_score_addon"] = 0
                r["news_sentiment"] = "NEUTRAL"
                r["has_catalyst"] = False
                r["has_breaking_news"] = False
                r["top_news"] = []
                r["combined_score"] = curve_score(max(0, raw))
                r["signal"] = score_label(max(0, raw))
                return ("ok", r)
            if r:
                # got a row but Close was NaN -> throttled; back off and retry
                time.sleep(4 + attempt * 6)
                continue
            return ("nodata", None)
        except Exception:
            time.sleep(3 + attempt * 5)
    return ("nan", None)


def wrap(t):
    st, r = one(t)
    with lock:
        done[0] += 1
        if st == "ok":
            rows.append(r)
            print(f"  [{done[0]}/{len(tickers)}] {t}: {r['combined_score']:.0f} "
                  f"{r['signal']} px={r['price']}", flush=True)
        else:
            (nanpx if st == "nan" else failed).append(t)
            print(f"  [{done[0]}/{len(tickers)}] {t}: {st}", flush=True)


t0 = time.time()
with ThreadPoolExecutor(max_workers=WORKERS) as ex:
    list(ex.map(wrap, tickers))

rows.sort(key=lambda x: x.get("combined_score", 0), reverse=True)
mins = (time.time() - t0) / 60
print(f"\n{len(rows)} scored with real prices in {mins:.1f} min | "
      f"no-data {len(failed)} | still-NaN {len(nanpx)}")
print("signals:", {k: sum(1 for r in rows if r["signal"] == k)
                   for k in ("STRONG BUY", "WATCH", "WEAK")})
if nanpx:
    print("still NaN:", nanpx)
if failed:
    print("no data:", failed)

if ONLY or TEST:
    print("(test mode — combined_results.json NOT modified)")
    sys.exit(0)

if len(rows) < 200:
    print("  XX  too few good rows; refusing to overwrite combined_results.json")
    sys.exit(1)

p = os.path.join(BASE, "combined_results.json")
comb = json.load(open(p, encoding="utf-8"))
comb["stocks"] = rows
comb["passed"] = len(rows)
comb["rescanned_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
with open(p, "w", encoding="utf-8") as f:
    json.dump(comb, f, indent=2, default=str)
print(f"  ok  patched stocks[] -> combined_results.json ({len(rows)} rows)")
