"""Wait out Yahoo's rate limit, then re-fetch the tickers missing from combined_results.json
and patch them in. Held tickers first (they drive claude_holdings), then the rest of the
universe so the pick list isn't skewed to whatever got scanned before the throttle hit.

Usage: wait_refetch.py [--max-wait-min 45] [--pace 2.5] [--universe]
"""
import json, os, sys, time
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from breakout_scanner import score_stock, curve_score
import run_full_scan as R

COMB = os.path.join(BASE, "combined_results.json")


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


MAX_WAIT = float(arg("--max-wait-min", 45))
PACE = float(arg("--pace", 2.5))
DO_UNIVERSE = "--universe" in sys.argv


def score_label(s):
    return "STRONG BUY" if s >= 75 else "WATCH" if s >= 55 else "WEAK"


def norm(r):
    raw = r.get("score_raw", r["score"])
    r["news_score_addon"] = 0
    r["news_sentiment"] = "NEUTRAL"
    r["has_catalyst"] = False
    r["has_breaking_news"] = False
    r["top_news"] = []
    r["combined_score"] = curve_score(max(0, raw))
    r["signal"] = score_label(max(0, raw))
    return r


def bad_px(v):
    return v is None or (isinstance(v, float) and v != v)


# ---- 1. wait for the throttle to lift -------------------------------------
print("Probing Yahoo until the rate limit lifts…", flush=True)
t0 = time.time()
probe_ok = False
delay = 60
while (time.time() - t0) / 60 < MAX_WAIT:
    try:
        r = score_stock("PLTR", min_history=2)
        if r and not bad_px(r.get("price")):
            print(f"  throttle cleared after {(time.time()-t0)/60:.1f} min (PLTR px={r['price']})", flush=True)
            probe_ok = True
            break
    except Exception as e:
        print(f"  probe error: {e}", flush=True)
    print(f"  still throttled at {(time.time()-t0)/60:.1f} min; sleeping {delay}s", flush=True)
    time.sleep(delay)
    delay = min(180, delay + 30)

if not probe_ok:
    print("XX  rate limit did not lift within the window — combined_results.json untouched.")
    sys.exit(2)

# ---- 2. work out what's missing -------------------------------------------
comb = json.load(open(COMB, encoding="utf-8"))
have = {(s.get("ticker") or "").upper() for s in comb["stocks"]}
held = [t.upper() for t in json.load(open(os.path.join(BASE, "scan_include.json"), encoding="utf-8"))["tickers"]]

targets = [t for t in held if t not in have and t != "BTC-USD"]
if DO_UNIVERSE:
    rest = [t.upper() for t in (R.FULL_LIST + R.CUSTOM_WATCHLIST)]
    targets += [t for t in dict.fromkeys(rest) if t not in have and t not in targets and t != "BTC-USD"]

print(f"Re-fetching {len(targets)} tickers (held first) at ~{PACE}s pace…", flush=True)

new_rows, still = [], []
for i, t in enumerate(targets, 1):
    got = None
    for attempt in range(3):
        try:
            r = score_stock(t, min_history=2)
            if r and not bad_px(r.get("price")):
                got = norm(r)
                break
        except Exception:
            pass
        time.sleep(5 + attempt * 8)
    if got:
        new_rows.append(got)
        print(f"  [{i}/{len(targets)}] ok  {t}: {got['combined_score']:.0f} {got['signal']} px={got['price']}", flush=True)
    else:
        still.append(t)
        print(f"  [{i}/{len(targets)}] XX  {t}", flush=True)
    time.sleep(PACE)

    # checkpoint every 25 so a mid-run failure still leaves progress on disk
    if new_rows and i % 25 == 0:
        c = json.load(open(COMB, encoding="utf-8"))
        cur = {(s.get("ticker") or "").upper() for s in c["stocks"]}
        c["stocks"].extend([r for r in new_rows if r["ticker"].upper() not in cur])
        c["stocks"].sort(key=lambda x: x.get("combined_score", 0), reverse=True)
        c["passed"] = len(c["stocks"])
        json.dump(c, open(COMB, "w", encoding="utf-8"), indent=2, default=str)
        print(f"  -- checkpoint: {len(c['stocks'])} rows on disk", flush=True)

if new_rows:
    c = json.load(open(COMB, encoding="utf-8"))
    cur = {(s.get("ticker") or "").upper() for s in c["stocks"]}
    c["stocks"].extend([r for r in new_rows if r["ticker"].upper() not in cur])
    c["stocks"].sort(key=lambda x: x.get("combined_score", 0), reverse=True)
    c["passed"] = len(c["stocks"])
    c["refetched_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    json.dump(c, open(COMB, "w", encoding="utf-8"), indent=2, default=str)
    print(f"\nok  patched {len(new_rows)} rows -> combined_results.json (now {len(c['stocks'])} stocks)")
print("still missing:", still)
