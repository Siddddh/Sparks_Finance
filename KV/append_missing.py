"""Append any universe/held ticker still absent from combined_results.json, at very low
concurrency with heavy backoff (Yahoo throttles the tail of a big pass)."""
import json, os, random, sys, threading, time
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = r"C:\Users\91635\Desktop\TXsparks\Sparks_Finance\Sparks_Finance\KV"
sys.path.insert(0, BASE)
import run_full_scan as R
from breakout_scanner import score_stock, curve_score

WORKERS = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 3
ROUNDS = int(sys.argv[sys.argv.index("--rounds") + 1]) if "--rounds" in sys.argv else 3
P = os.path.join(BASE, "combined_results.json")


def is_nan(v):
    return v is None or (isinstance(v, float) and v != v)


def label(s):
    return "STRONG BUY" if s >= 75 else "WATCH" if s >= 55 else "WEAK"


held = R._held_tickers()
want = [t for t in dict.fromkeys(R.FULL_LIST + R.CUSTOM_WATCHLIST + held)
        if t.upper() != "BTC-USD"]
forced = {t.upper() for t in (R.CUSTOM_WATCHLIST + held)}

for rnd in range(1, ROUNDS + 1):
    comb = json.load(open(P, encoding="utf-8"))
    have = {s["ticker"].upper() for s in comb["stocks"] if not is_nan(s.get("price"))}
    missing = [t for t in want if t.upper() not in have]
    if not missing:
        print("nothing missing — done."); break
    print(f"\n=== round {rnd}: {len(missing)} missing, {WORKERS} workers ===", flush=True)

    lock, rows, bad = threading.Lock(), [], []
    done = [0]

    def one(t):
        tu = t.upper()
        mh = 2 if tu in forced else 50
        for attempt in range(4):
            try:
                time.sleep(random.uniform(0.3, 1.5))
                r = score_stock(t, min_history=mh)
                if r and not is_nan(r.get("price")):
                    raw = r.get("score_raw", r["score"])
                    r.update(news_score_addon=0, news_sentiment="NEUTRAL",
                             has_catalyst=False, has_breaking_news=False, top_news=[])
                    r["combined_score"] = curve_score(max(0, raw))
                    r["signal"] = label(max(0, raw))
                    return r
            except Exception:
                pass
            time.sleep(5 + attempt * 8)
        return None

    def wrap(t):
        r = one(t)
        with lock:
            done[0] += 1
            if r:
                rows.append(r)
                print(f"  [{done[0]}/{len(missing)}] {t}: {r['combined_score']:.0f} "
                      f"{r['signal']} px={r['price']}", flush=True)
            else:
                bad.append(t)
                print(f"  [{done[0]}/{len(missing)}] {t}: FAIL", flush=True)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(wrap, missing))

    if rows:
        comb = json.load(open(P, encoding="utf-8"))   # re-read (write race)
        have = {s["ticker"].upper() for s in comb["stocks"] if not is_nan(s.get("price"))}
        comb["stocks"] = [s for s in comb["stocks"]
                          if s["ticker"].upper() not in {r["ticker"].upper() for r in rows}]
        comb["stocks"].extend(rows)
        comb["stocks"].sort(key=lambda x: x.get("combined_score", 0), reverse=True)
        comb["passed"] = len(comb["stocks"])
        with open(P, "w", encoding="utf-8") as f:
            json.dump(comb, f, indent=2, default=str)
        print(f"  ok  appended {len(rows)} -> {len(comb['stocks'])} rows total", flush=True)
    print(f"  round {rnd}: recovered {len(rows)}, still failing {len(bad)}", flush=True)
    if not bad:
        break
    time.sleep(20)

comb = json.load(open(P, encoding="utf-8"))
good = [s for s in comb["stocks"] if not is_nan(s.get("price"))]
print(f"\nFINAL: {len(good)} rows with real prices")
print("signals:", {k: sum(1 for s in good if s["signal"] == k)
                  for k in ("STRONG BUY", "WATCH", "WEAK")})
have = {s["ticker"].upper() for s in good}
print("held still missing:", [t for t in held if t.upper() not in have])
print("index/ETF check:", {t: (t in have) for t in ("SPY", "QQQ", "IWM", "SMH", "XLF", "XLE")})
