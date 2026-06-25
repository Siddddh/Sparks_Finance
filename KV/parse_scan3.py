import json, sys
sys.stdout.reconfigure(encoding='utf-8')
with open("combined_results.json", encoding="utf-8") as f:
    data = json.load(f)
want = set(["ALAB","SWBI","LUV","RBRK","RKLB","PLTR","SNDK","APP","HOOD","SNOW","AMKR","COCO","DELL","DIOD","DOCN","FLEX","ICHR","LQDA","MXL","PRTH","VRT","COIN","APLD","QBTS","RGTI","DRAM","SSO","QLD","BTC-USD"])
for s in data["stocks"]:
    if s["ticker"] in want:
        print(s["ticker"], s["score"], s["signal"], s["price"], "pct_high="+str(s["pct_from_high"]), "eps="+str(s.get("eps_growth")), "rev="+str(s.get("rev_growth")), "vcp="+str(s.get("is_vcp")), "rs_high="+str(s.get("rs_at_high")))
