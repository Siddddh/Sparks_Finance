"""Recompute market_health after the refetch — the scan's copy has NaN SPY/QQQ and
0% breadth because SPY/QQQ/most of the universe were Yahoo-rate-limited mid-scan."""
import json, os, sys, time
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = r"C:\Users\91635\Desktop\TXsparks\Sparks_Finance\Sparks_Finance\KV"
sys.path.insert(0, BASE)
from market_health import get_market_health

comb = json.load(open(os.path.join(BASE, "combined_results.json"), encoding="utf-8"))
old = comb.get("market_health") or {}
print("OLD:", json.dumps({k: old.get(k) for k in
      ("market_state", "spy_price", "spy_above_50", "breadth_pct", "vix", "dist_days")}))

h = None
for attempt in range(5):
    h = get_market_health(stock_rows=comb["stocks"])
    if h.get("spy_price") and h["spy_price"] == h["spy_price"] and h["spy_price"] > 0:
        break
    print(f"  .. attempt {attempt+1}: spy_price={h.get('spy_price')} err={h.get('error')}")
    time.sleep(15)

print("NEW:", json.dumps(h, indent=1, default=str))
if h and h.get("spy_price") and h["spy_price"] > 0:
    comb["market_health"] = h
    with open(os.path.join(BASE, "combined_results.json"), "w", encoding="utf-8") as f:
        json.dump(comb, f, indent=2, default=str)
    print("\n  ok  patched market_health -> combined_results.json")
else:
    print("\n  XX  still no SPY data; leaving market_health as-is")
