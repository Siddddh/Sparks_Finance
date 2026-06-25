import json, sys
sys.stdout.reconfigure(encoding='utf-8')
with open("combined_results.json", encoding="utf-8") as f:
    data = json.load(f)
mh = data.get("market_health", {})
import json as j
print(j.dumps(mh))
want = set(["ALAB","FTNT","SWBI","LUV","RBRK","CSCO","KLAC","AMAT","TXN","SPCX","LRCX","RKLB","PLTR","TSLA","NVDA","SNDK","APP","HOOD","INTC","SMCI","SNOW","AAPL","AMZN","AMKR","COCO","DELL","DIOD","DOCN","FLEX","GLW","GOOGL","ICHR","LLY","LQDA","MXL","NTAP","PRTH","VRT","GS","COIN","EOG","FICO","NXPI","SIRI","WDC","MU"])
for s in data["stocks"]:
    if s["ticker"] in want:
        print(s["ticker"], s["score"], s["signal"], s["price"], "pct_high="+str(s["pct_from_high"]), "eps="+str(s.get("eps_growth")), "rev="+str(s.get("rev_growth")), "vcp="+str(s.get("is_vcp")), "rs_high="+str(s.get("rs_at_high")))
