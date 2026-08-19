"""Targeted: fetch ONLY the held tickers still absent (or NaN-priced) from
combined_results.json, then patch them in. Skips the broad universe so the
pre-open window isn't spent on delisted names."""
import json, os, sys, time, random, threading
from concurrent.futures import ThreadPoolExecutor
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from breakout_scanner import score_stock, curve_score

P = os.path.join(BASE, "combined_results.json")
def is_nan(v): return v is None or (isinstance(v, float) and v != v)
def label(s): return "STRONG BUY" if s >= 75 else "WATCH" if s >= 55 else "WEAK"

comb = json.load(open(P, encoding="utf-8"))
have = {s["ticker"].upper() for s in comb["stocks"] if not is_nan(s.get("price"))}
held = json.load(open(os.path.join(BASE, "scan_include.json"), encoding="utf-8"))["tickers"]
missing = [t for t in held if t.upper() not in have and t.upper() != "BTC-USD"]
print(f"fetching {len(missing)} missing held: {missing}", flush=True)

lock, rows, bad, done = threading.Lock(), [], [], [0]
def one(t):
    for attempt in range(3):
        try:
            time.sleep(random.uniform(0.2, 1.0))
            r = score_stock(t, min_history=2)
            if r and not is_nan(r.get("price")):
                raw = r.get("score_raw", r["score"])
                r.update(news_score_addon=0, news_sentiment="NEUTRAL",
                         has_catalyst=False, has_breaking_news=False, top_news=[])
                r["combined_score"] = curve_score(max(0, raw))
                r["signal"] = label(max(0, raw))
                return r
        except Exception:
            pass
        time.sleep(3 + attempt * 4)
    return None

def wrap(t):
    r = one(t)
    with lock:
        done[0] += 1
        if r:
            rows.append(r)
            print(f"  [{done[0]}/{len(missing)}] {t}: {r['combined_score']:.0f} {r['signal']} px={r['price']}", flush=True)
        else:
            bad.append(t); print(f"  [{done[0]}/{len(missing)}] {t}: FAIL", flush=True)

with ThreadPoolExecutor(max_workers=4) as ex:
    list(ex.map(wrap, missing))

if rows:
    comb = json.load(open(P, encoding="utf-8"))  # re-read (write race)
    keep = {r["ticker"].upper() for r in rows}
    comb["stocks"] = [s for s in comb["stocks"] if s["ticker"].upper() not in keep] + rows
    comb["stocks"].sort(key=lambda x: x.get("combined_score") or 0, reverse=True)
    json.dump(comb, open(P, "w", encoding="utf-8"), indent=1, default=str)
    print(f"\nPatched {len(rows)} rows -> combined_results.json (now {len(comb['stocks'])} stocks)")
print("Still missing:", bad)
