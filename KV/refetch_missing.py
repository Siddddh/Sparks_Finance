"""One-off: re-fetch held tickers that Yahoo rate-limited during the full scan,
then patch them into combined_results.json (keeps everything else intact)."""
import json, os, sys, time
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from breakout_scanner import score_stock, curve_score

def score_label(s):
    return "STRONG BUY" if s >= 75 else "WATCH" if s >= 55 else "WEAK"

comb = json.load(open(os.path.join(BASE, "combined_results.json"), encoding="utf-8"))
have = {s["ticker"].upper() for s in comb["stocks"]}

incl = json.load(open(os.path.join(BASE, "scan_include.json"), encoding="utf-8"))["tickers"]
missing = [t for t in incl if t.upper() not in have and t.upper() != "BTC-USD"]
print("Re-fetching", len(missing), "missing held tickers:", missing)

new_rows = []
for t in missing:
    ok = False
    for attempt in range(4):
        try:
            r = score_stock(t, min_history=2)
            if r:
                raw = r.get("score_raw", r["score"])
                r["news_score_addon"] = 0
                r["news_sentiment"] = "NEUTRAL"
                r["has_catalyst"] = False
                r["has_breaking_news"] = False
                r["top_news"] = []
                r["combined_score"] = curve_score(max(0, raw))
                r["signal"] = score_label(max(0, raw))
                new_rows.append(r)
                print(f"  ok  {t}: {r['combined_score']:.0f} {r['signal']} px={r.get('price')}")
                ok = True
                break
        except Exception as e:
            print(f"  .. {t} attempt {attempt+1}: {e}")
        time.sleep(4 + attempt * 3)
    if not ok:
        print(f"  XX  {t}: still no data")

if new_rows:
    comb["stocks"].extend(new_rows)
    comb["stocks"].sort(key=lambda x: x.get("combined_score", 0), reverse=True)
    comb["passed"] = len(comb["stocks"])
    with open(os.path.join(BASE, "combined_results.json"), "w", encoding="utf-8") as f:
        json.dump(comb, f, indent=2, default=str)
    print(f"\nPatched {len(new_rows)} rows -> combined_results.json (now {len(comb['stocks'])} stocks)")
    still = [t for t in missing if t.upper() not in {r['ticker'].upper() for r in new_rows}]
    print("Still missing:", still)
