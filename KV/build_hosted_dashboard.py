"""
Builds firebase_hosting/index.html — the public Firebase-hosted dashboard.
Reads firebase_config.json for the web app credentials.
The dashboard reads live data from Firestore (no embedded JSON).
"""
import json, os, glob as _glob

def _find_base():
    for p in _glob.glob("/sessions/*/mnt/KV"):
        if os.path.exists(p):
            return p
    return os.path.expanduser("~/Claude/KV")

BASE = _find_base()
CONFIG_PATH  = f"{BASE}/firebase_config.json"
OUT_DIR      = f"{BASE}/firebase_hosting"
OUT_FILE     = f"{OUT_DIR}/index.html"

# Load Firebase web config
try:
    with open(CONFIG_PATH) as f:
        fb_config = json.load(f)
    # Remove instructions key if present
    fb_config.pop("_instructions", None)
    fb_config_js = json.dumps(fb_config, indent=4)
except FileNotFoundError:
    print(f"⚠  {CONFIG_PATH} not found — using placeholder config.")
    fb_config_js = json.dumps({
        "apiKey": "YOUR_API_KEY",
        "authDomain": "YOUR_PROJECT.firebaseapp.com",
        "projectId": "YOUR_PROJECT_ID",
        "storageBucket": "YOUR_PROJECT.appspot.com",
        "messagingSenderId": "YOUR_SENDER_ID",
        "appId": "YOUR_APP_ID"
    }, indent=4)

os.makedirs(OUT_DIR, exist_ok=True)

HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Mission Control — Stock Breakout Scanner</title>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.js" integrity="sha384-iU8HYtnGQ8Cy4zl7gbNMOhsDTTKX02BTXptVP/vqAWIaTfM7isw76iyZCsjL2eVi" crossorigin="anonymous"></script>
<style>
:root{color-scheme:light;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#1a1d23;}
/* Loading */
#loading{position:fixed;inset:0;background:#0f1923;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;transition:opacity .4s;}
#loading.hidden{opacity:0;pointer-events:none;}
.load-logo{font-size:28px;font-weight:800;color:#fff;letter-spacing:-1px;margin-bottom:16px;}
.load-logo span{color:#22d3ee;}
.load-spinner{width:36px;height:36px;border:3px solid rgba(34,211,238,.2);border-top-color:#22d3ee;border-radius:50%;animation:spin .8s linear infinite;margin-bottom:12px;}
.load-msg{font-size:12px;color:#94a3b8;}
@keyframes spin{to{transform:rotate(360deg)}}
.error-screen{background:#fee2e2;border:1px solid #fecaca;border-radius:10px;padding:20px;max-width:500px;text-align:center;margin:40px auto;}
.error-screen h2{color:#b91c1c;margin-bottom:8px;font-size:16px;}
.error-screen p{color:#7f1d1d;font-size:12px;line-height:1.5;}
/* Live badge */
.live-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;display:inline-block;animation:pulse-live 2s infinite;margin-right:4px;}
@keyframes pulse-live{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(74,222,128,.4)}50%{opacity:.8;box-shadow:0 0 0 5px rgba(74,222,128,0)}}
.live-badge{display:flex;align-items:center;font-size:10px;color:#4ade80;font-weight:700;gap:3px;}
/* Header */
.hdr{background:linear-gradient(135deg,#0f1923,#1a2f45);color:#fff;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;}
.logo{font-size:19px;font-weight:800;}.logo span{color:#22d3ee;}
.sub{font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-top:1px;}
.hdr-r{text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:4px;}
.scan-t{font-size:11px;color:#94a3b8;}.scan-t strong{color:#e2e8f0;}
.strat-badge{display:inline-block;background:rgba(34,211,238,.15);border:1px solid rgba(34,211,238,.3);color:#22d3ee;font-size:9px;font-weight:600;padding:2px 7px;border-radius:20px;text-transform:uppercase;letter-spacing:.5px;}
/* Market bar */
.mkt-bar{display:grid;grid-template-columns:auto 1fr 1fr 1fr 1fr 1fr;align-items:center;gap:10px;padding:10px 20px;background:#fff;border-bottom:2px solid #e2e8f0;}
.mkt-state{display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:800;white-space:nowrap;}
.mkt-green{background:#dcfce7;color:#15803d;border:1px solid #bbf7d0;}
.mkt-amber{background:#fef9c3;color:#92400e;border:1px solid #fde68a;}
.mkt-red{background:#fee2e2;color:#b91c1c;border:1px solid #fecaca;}
.mkt-gray{background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;}
.mkt-stat{display:flex;flex-direction:column;align-items:center;padding:4px 6px;}
.mkt-val{font-size:16px;font-weight:800;}
.mkt-lbl{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.4px;font-weight:600;margin-top:1px;}
.mkt-adv{font-size:10px;color:#64748b;flex:1;padding:4px 10px;border-left:1px solid #e2e8f0;}
/* Breaking bar */
.brk-bar{background:#7f1d1d;color:#fecaca;padding:6px 20px;display:flex;align-items:center;gap:8px;overflow:hidden;}
.brk-lbl{background:#dc2626;color:#fff;font-size:9px;font-weight:800;padding:2px 6px;border-radius:3px;white-space:nowrap;flex-shrink:0;}
.brk-scrl{overflow:hidden;white-space:nowrap;flex:1;}
.brk-scrl span{animation:ticker 238s linear infinite;display:inline-block;padding-right:80px;}
@keyframes ticker{from{transform:translateX(100%)}to{transform:translateX(-200%)}}
.brk-bar.hidden{display:none;}
/* History bar */
.hist-bar{background:#fff;border-bottom:1px solid #e2e8f0;padding:8px 20px;display:flex;align-items:center;gap:8px;overflow-x:auto;}
.hist-label{font-size:10px;font-weight:700;color:#64748b;white-space:nowrap;}
.hist-days{display:flex;gap:5px;}
.hist-day{display:flex;flex-direction:column;align-items:center;padding:5px 10px;border-radius:8px;border:1px solid #e2e8f0;cursor:pointer;background:#f8fafc;transition:all .15s;min-width:70px;}
.hist-day:hover{border-color:#1d4ed8;background:#eff6ff;}
.hist-day.active{border-color:#1d4ed8;background:#dbeafe;}
.hist-day-date{font-size:10px;font-weight:800;color:#1a1d23;}
.hist-day-sb{font-size:9px;font-weight:700;color:#16a34a;}
.hist-day-w{font-size:9px;color:#d97706;}
.hist-day-mkt{font-size:8px;color:#64748b;margin-top:1px;}
.hist-day.today .hist-day-date::after{content:" ✦";color:#1d4ed8;}
/* Summary bar */
.sum-bar{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:10px 20px;background:#fff;border-bottom:1px solid #e2e8f0;}
.scard{display:flex;flex-direction:column;align-items:center;padding:7px;border-radius:8px;background:#f8fafc;border:1px solid #e2e8f0;}
.snum{font-size:22px;font-weight:800;line-height:1;}
.slbl{font-size:9px;color:#64748b;margin-top:2px;text-transform:uppercase;letter-spacing:.4px;font-weight:600;text-align:center;}
.scard.sg .snum{color:#16a34a;}.scard.sw .snum{color:#d97706;}.scard.sk .snum{color:#dc2626;}
.scard.st .snum{color:#1d4ed8;}.scard.sa .snum{color:#9333ea;}
/* Tabs */
.tabs{display:flex;padding:0 20px;background:#fff;border-bottom:1px solid #e2e8f0;overflow-x:auto;}
.tab{padding:10px 15px;font-size:12px;font-weight:600;cursor:pointer;border-bottom:3px solid transparent;color:#64748b;white-space:nowrap;transition:all .15s;}
.tab.active{color:#1d4ed8;border-bottom-color:#1d4ed8;}
.tab:hover:not(.active){color:#1a1d23;border-bottom-color:#e2e8f0;}
.content{padding:16px 20px;}
.tab-panel{display:none;}
.tab-panel.active{display:block;}
/* Cards */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;}
.card{background:#fff;border-radius:12px;border:1px solid #e2e8f0;padding:14px 16px;position:relative;overflow:hidden;transition:box-shadow .15s,transform .1s;}
.card:hover{box-shadow:0 4px 20px rgba(0,0,0,.10);transform:translateY(-1px);}
.accent{position:absolute;top:0;left:0;width:4px;height:100%;border-radius:12px 0 0 12px;}
.STRONG-BUY .accent{background:#16a34a;}.WATCH .accent{background:#d97706;}.WEAK .accent{background:#dc2626;}
.ctop{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;}
.tkr{font-size:18px;font-weight:800;}
.coname{font-size:10px;color:#64748b;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:185px;}
.sectag{display:inline-block;font-size:9px;font-weight:600;padding:2px 6px;border-radius:20px;background:#f1f5f9;color:#475569;margin-top:3px;}
.badges{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0;}
.sig{font-size:10px;font-weight:700;padding:3px 8px;border-radius:5px;text-transform:uppercase;letter-spacing:.4px;}
.sig-STRONG-BUY,.sig-STRONGBUY{background:#dcfce7;color:#15803d;}
.sig-WATCH{background:#fef9c3;color:#92400e;}
.sig-WEAK{background:#fee2e2;color:#b91c1c;}
.qual{font-size:11px;font-weight:800;padding:2px 7px;border-radius:4px;background:#0f1923;color:#22d3ee;}
.news-b{font-size:9px;font-weight:600;padding:1px 6px;border-radius:20px;}
.nb-BULLISH,.nb-SLIGHTLYBULLISH{background:#dcfce7;color:#15803d;}
.nb-NEUTRAL{background:#f1f5f9;color:#64748b;}
.nb-BEARISH,.nb-SLIGHTLYBEARISH{background:#fee2e2;color:#b91c1c;}
.brkflag{font-size:9px;background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;padding:1px 6px;border-radius:20px;font-weight:700;animation:pulse 2s infinite;}
.catflag{font-size:9px;background:#fef3c7;color:#92400e;border:1px solid #fde68a;padding:1px 6px;border-radius:20px;font-weight:700;}
.earnflag{font-size:9px;font-weight:700;padding:1px 6px;border-radius:20px;}
.earn-CATALYST{background:#dbeafe;color:#1e40af;}
.earn-HIGH_RISK{background:#fee2e2;color:#b91c1c;animation:pulse 2s infinite;}
.earn-APPROACHING{background:#fef3c7;color:#92400e;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}
.srow{display:flex;align-items:center;gap:6px;margin-bottom:9px;}
.sbar-w{flex:1;height:6px;background:#f1f5f9;border-radius:3px;overflow:hidden;}
.sbar{height:100%;border-radius:3px;}
.sbar-s{background:linear-gradient(90deg,#16a34a,#4ade80);}.sbar-w2{background:linear-gradient(90deg,#d97706,#fbbf24);}.sbar-k{background:linear-gradient(90deg,#dc2626,#f87171);}
.snum2{font-size:13px;font-weight:800;min-width:32px;text-align:right;}
.sig-strip{display:flex;gap:4px;margin-bottom:9px;flex-wrap:wrap;}
.ss-pill{font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;}
.ss-pass{background:#dcfce7;color:#15803d;}.ss-fail{background:#f1f5f9;color:#94a3b8;text-decoration:line-through;}
.mgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:9px;}
.met{background:#f8fafc;border-radius:5px;padding:5px 6px;}
.mlbl{font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:#94a3b8;font-weight:600;}
.mval{font-size:12px;font-weight:700;color:#1a1d23;margin-top:1px;}
.mval.up{color:#16a34a;}.mval.dn{color:#dc2626;}
.pattern-strip{display:flex;gap:5px;margin-bottom:9px;flex-wrap:wrap;}
.ptag{font-size:9px;font-weight:700;padding:2px 8px;border-radius:5px;border:1px solid transparent;}
.ptag-vcp{background:#dbeafe;color:#1e40af;border-color:#bfdbfe;}
.ptag-rs{background:#fef3c7;color:#92400e;border-color:#fde68a;}
.ptag-vdu{background:#f0fdf4;color:#166534;border-color:#bbf7d0;}
.ptag-pp{background:#fdf4ff;color:#7e22ce;border-color:#e9d5ff;}
.ptag-sq{background:#fff7ed;color:#c2410c;border-color:#fed7aa;}
.ptag-earn{background:#f0f9ff;color:#0369a1;border-color:#bae6fd;}
.tbox{background:#0f1923;border-radius:7px;padding:8px 10px;display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:9px;}
.ti{text-align:center;}
.tilbl{font-size:8px;text-transform:uppercase;letter-spacing:.4px;color:#64748b;font-weight:600;}
.tival{font-size:11px;font-weight:700;margin-top:1px;}
.tival.e{color:#e2e8f0;}.tival.s{color:#f87171;}.tival.t{color:#4ade80;}.tival.r{color:#22d3ee;}
.thesis-sec{border-top:1px solid #f1f5f9;padding-top:8px;}
.thesis-hdr{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;margin-bottom:4px;display:flex;justify-content:space-between;}
.thesis-toggle{cursor:pointer;color:#1d4ed8;font-size:9px;}
.thesis-body{font-size:11px;color:#374151;line-height:1.5;display:none;}
.thesis-body.open{display:block;}
.th-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;margin-top:5px;}
.th-lbl.g{color:#15803d;}.th-lbl.r{color:#b91c1c;}.th-lbl.b{color:#1d4ed8;}
.th-item{font-size:10px;color:#475569;padding:1px 0;line-height:1.4;}
.news-sec{border-top:1px solid #f1f5f9;padding-top:8px;}
.news-stitle{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;margin-bottom:4px;}
.nitem{padding:4px 0;border-bottom:1px solid #f8fafc;}
.nitem:last-child{border-bottom:none;}
.ntitle{font-size:10px;font-weight:600;line-height:1.3;}
.ntitle a{color:#1d4ed8;text-decoration:none;}
.ntitle a:hover{text-decoration:underline;}
.nmeta{display:flex;gap:5px;align-items:center;margin-top:2px;flex-wrap:wrap;}
.otag{font-size:9px;font-weight:700;background:#f1f5f9;color:#475569;padding:1px 5px;border-radius:3px;}
.otag.Reuters{background:#ff6b00;color:#fff;}.otag.CNBC{background:#0077b5;color:#fff;}
.otag.Bloomberg{background:#1a1a1a;color:#fff;}.otag.MarketWatch{background:#005a5b;color:#fff;}
.otag.Benzinga{background:#00b4d8;color:#fff;}.otag.WSJ{background:#0274b6;color:#fff;}
.bage{font-size:9px;color:#94a3b8;}.bsent{font-size:9px;font-weight:600;padding:1px 5px;border-radius:3px;}
.bsent.BULLISH,.bsent.SLIGHTLYBULLISH{background:#dcfce7;color:#15803d;}
.bsent.BEARISH,.bsent.SLIGHTLYBEARISH{background:#fee2e2;color:#b91c1c;}
.bsent.NEUTRAL{background:#f1f5f9;color:#64748b;}
.twrap{overflow-x:auto;border-radius:10px;border:1px solid #e2e8f0;background:#fff;}
table{width:100%;border-collapse:collapse;font-size:11px;}
th{background:#f8fafc;padding:8px 10px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#64748b;border-bottom:1px solid #e2e8f0;cursor:pointer;white-space:nowrap;user-select:none;}
th:hover{background:#f1f5f9;}
th.sa::after{content:' ↑';}th.sd::after{content:' ↓';}
td{padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;vertical-align:middle;}
tr:last-child td{border-bottom:none;}tr:hover td{background:#f8fafc;}
.sc-circle{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;font-size:10px;font-weight:800;}
.sc-SB{background:#dcfce7;color:#15803d;}.sc-W{background:#fef9c3;color:#92400e;}.sc-K{background:#fee2e2;color:#b91c1c;}
.dot-row{display:flex;gap:2px;}.dot{width:7px;height:7px;border-radius:50%;}.dot.p{background:#16a34a;}.dot.f{background:#e2e8f0;}
.alerts-grid{display:flex;flex-direction:column;gap:10px;}
.acrd{background:#fff;border-radius:10px;border:1px solid #e2e8f0;padding:12px 14px;border-left:4px solid #9333ea;}
.atop{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;}
.atkr{font-size:17px;font-weight:800;}
.atitle{font-size:12px;font-weight:600;line-height:1.4;margin-bottom:4px;}
.atitle a{color:#1d4ed8;text-decoration:none;}
.ameta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.noalerts{text-align:center;padding:60px 20px;}
.mnews-grid{display:flex;flex-direction:column;gap:8px;}
.mncrd{background:#fff;border-radius:8px;border:1px solid #e2e8f0;padding:11px 13px;}
.mncrd.brk{border-left:3px solid #dc2626;}.mncrd.bull{border-left:3px solid #16a34a;}
.mntitle{font-size:12px;font-weight:600;line-height:1.4;}
.mntitle a{color:#1d4ed8;text-decoration:none;}
.mnmeta{display:flex;gap:6px;align-items:center;margin-top:3px;flex-wrap:wrap;}
.mnsumm{font-size:10px;color:#64748b;margin-top:3px;line-height:1.4;}
.cwrap{background:#fff;border-radius:10px;border:1px solid #e2e8f0;padding:16px;margin-bottom:12px;}
.ctitle{font-size:13px;font-weight:700;margin-bottom:12px;}
.cbox{height:270px;position:relative;}
@media(max-width:600px){.sum-bar{grid-template-columns:1fr 1fr;}.grid{grid-template-columns:1fr;}.tbox{grid-template-columns:1fr 1fr;}.mkt-bar{grid-template-columns:1fr 1fr;}}
</style>
</head>
<body>

<!-- Loading screen -->
<div id="loading">
  <div class="load-logo">&#x1F4E1; Mission <span>Control</span></div>
  <div class="load-spinner"></div>
  <div class="load-msg" id="loadMsg">Connecting to live data…</div>
</div>

<!-- Dashboard (hidden until data loads) -->
<div id="app" style="display:none">
<div class="hdr">
  <div><div class="logo">&#x1F4E1; Mission <span>Control</span></div><div class="sub">S&amp;P 500 &middot; Live Breakout Scanner</div></div>
  <div class="hdr-r">
    <div class="live-badge"><span class="live-dot"></span> LIVE</div>
    <div class="scan-t">Updated: <strong id="scanT">—</strong></div>
    <div class="strat-badge">Minervini + VCP + RS + News</div>
  </div>
</div>
<div class="mkt-bar" id="mktBar">
  <div class="mkt-state mkt-gray" id="mktState">— Market</div>
  <div class="mkt-stat"><div class="mkt-val" id="mVix">—</div><div class="mkt-lbl">VIX</div></div>
  <div class="mkt-stat"><div class="mkt-val" id="mSpy">—</div><div class="mkt-lbl">SPY</div></div>
  <div class="mkt-stat"><div class="mkt-val" id="mDist">—</div><div class="mkt-lbl">Dist Days</div></div>
  <div class="mkt-stat"><div class="mkt-val" id="mBreadth">—</div><div class="mkt-lbl">Breadth</div></div>
  <div class="mkt-adv" id="mktAdv">—</div>
</div>
<div class="brk-bar" id="brkBar"><div class="brk-lbl">&#x1F534; BREAKING</div><div class="brk-scrl"><span id="brkTxt">—</span></div></div>
<div class="hist-bar"><span class="hist-label">&#x1F4C5; Last 7 days:</span><div class="hist-days" id="histDays"><span style="font-size:10px;color:#94a3b8">Loading history…</span></div></div>
<div class="sum-bar">
  <div class="scard sg"><div class="snum" id="cSB">—</div><div class="slbl">&#x1F7E2; Strong Buy</div></div>
  <div class="scard sw"><div class="snum" id="cW">—</div><div class="slbl">&#x1F7E1; Watch</div></div>
  <div class="scard sk"><div class="snum" id="cK">—</div><div class="slbl">&#x1F534; Weak</div></div>
  <div class="scard st"><div class="snum" id="cT">—</div><div class="slbl">&#x1F4CA; Scanned</div></div>
  <div class="scard sa"><div class="snum" id="cA">—</div><div class="slbl">&#x26A1; Alerts</div></div>
</div>
<div class="tabs">
  <div class="tab active" onclick="sw('cards')">&#x1F0CF; Top Picks</div>
  <div class="tab" onclick="sw('alerts')">&#x26A1; Alerts</div>
  <div class="tab" onclick="sw('market')">&#x1F310; Market News</div>
  <div class="tab" onclick="sw('table')">&#x1F4CB; Full Table</div>
  <div class="tab" onclick="sw('chart')">&#x1F4C8; Charts</div>
</div>
<div class="content">
  <div id="tab-cards" class="tab-panel active"><div class="grid" id="picksGrid"></div></div>
  <div id="tab-alerts" class="tab-panel"><div class="alerts-grid" id="alertsGrid"></div></div>
  <div id="tab-market" class="tab-panel"><div class="mnews-grid" id="marketGrid"></div></div>
  <div id="tab-table" class="tab-panel">
    <div class="twrap"><table><thead><tr>
      <th onclick="st('ticker')">Ticker</th><th onclick="st('signal')">Signal</th>
      <th onclick="st('combined_score')">Score</th><th onclick="st('setup_quality')">Grade</th>
      <th onclick="st('news_score_addon')">News&#916;</th><th onclick="st('price')">Price</th>
      <th onclick="st('rsi')">RSI</th><th onclick="st('vol_ratio')">Vol&#215;</th>
      <th onclick="st('momentum_3m')">3M%</th><th onclick="st('eps_growth')">EPS%</th>
      <th onclick="st('short_pct_float')">Short%</th><th onclick="st('days_to_earnings')">Earn</th>
      <th onclick="st('pct_from_high')">vsHi%</th><th onclick="st('rr_ratio')">R:R</th>
      <th>Signals</th>
    </tr></thead><tbody id="tblBody"></tbody></table></div>
  </div>
  <div id="tab-chart" class="tab-panel">
    <div class="cwrap"><div class="ctitle">Combined Score by Stock</div><div class="cbox"><canvas id="sc1"></canvas></div></div>
    <div class="cwrap"><div class="ctitle">Signal Breakdown — VCP / RS / VDU</div><div class="cbox"><canvas id="sc2"></canvas></div></div>
    <div class="cwrap"><div class="ctitle">News Score Contribution</div><div class="cbox"><canvas id="sc3"></canvas></div></div>
  </div>
</div>
</div>

<script>
// ── Firebase config (injected by build_hosted_dashboard.py) ──
const firebaseConfig = __FIREBASE_CONFIG__;
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// ── State ──
let D = null;
let historyDates = [];
let histSummary  = {};
let chartsInited = false;
let sortKey = 'combined_score', sortAsc = false;
const critLabels = {trend_ok:'Stage 2',near_high:'Near High',rsi_ok:'RSI',volume_ok:'Volume',eps_ok:'EPS 20%+',rev_ok:'Rev 10%+',vcp_ok:'VCP',rs_ok:'RS High',vdu_ok:'Vol DU',insider_ok:'Insider'};

// ── Helpers ──
function sc(s){return (s||'').replace(/[\s/]/g,'');}
function fmt(v){return v!=null?v:'—';}
function age2str(h){return h<1?'<1h ago':Math.round(h)+'h ago';}
function signalCls(sig){const s=(sig||'').replace(' ','');return s==='STRONGBUY'?'sc-SB':s==='WATCH'?'sc-W':'sc-K';}

// ── Show loading screen ──
function setLoading(msg){document.getElementById('loadMsg').textContent=msg;}
function hideLoading(){
  const el=document.getElementById('loading');
  el.classList.add('hidden');
  document.getElementById('app').style.display='block';
  setTimeout(()=>el.style.display='none',500);
}

// ── Listen to Firestore: scans/latest ──
setLoading('Connecting to live data…');
db.collection('scans').doc('latest').onSnapshot(doc=>{
  if(!doc.exists){
    setLoading('No scan data yet. Run a scan first.');
    return;
  }
  D = doc.data();
  renderAll();
  hideLoading();
}, err=>{
  console.error('Firestore error:', err);
  document.getElementById('loadMsg').innerHTML =
    '<div class="error-screen"><h2>Connection Error</h2><p>'+err.message+'</p></div>';
});

// ── Listen to history index ──
db.collection('scans').doc('history_index').onSnapshot(doc=>{
  if(!doc.exists) return;
  historyDates = doc.data().dates || [];
  // Load summaries for each date
  historyDates.forEach(date=>{
    db.collection('history').doc(date).get().then(d=>{
      if(d.exists) histSummary[date] = d.data();
      renderHistBar();
    });
  });
});

// ── Render all panels ──
function renderAll(){
  if(!D) return;
  const picks   = D.stocks  || [];
  const alerts  = D.alerts  || [];
  const mktNews = D.market_news || [];
  const mh      = D.market_health || {};

  // Header
  document.getElementById('scanT').textContent = (D.scan_date||'') + ' ' + (D.scan_time_et||'');
  document.getElementById('cSB').textContent = picks.filter(s=>s.signal==='STRONG BUY').length;
  document.getElementById('cW').textContent  = picks.filter(s=>s.signal==='WATCH').length;
  document.getElementById('cK').textContent  = picks.filter(s=>s.signal==='WEAK').length;
  document.getElementById('cT').textContent  = D.universe || picks.length;
  document.getElementById('cA').textContent  = alerts.length;

  // Market bar
  const stateColors={green:'mkt-green',amber:'mkt-amber',red:'mkt-red',gray:'mkt-gray'};
  const stEl=document.getElementById('mktState');
  stEl.textContent=(mh.state_emoji||'') + ' ' + (mh.market_state||'—');
  stEl.className='mkt-state '+(stateColors[mh.state_color]||'mkt-gray');
  document.getElementById('mVix').textContent=mh.vix?(mh.vix+' '+(mh.vix_trend==='RISING'?'↑':'↓')):'—';
  document.getElementById('mVix').style.color=mh.vix>25?'#dc2626':mh.vix>20?'#d97706':'#16a34a';
  document.getElementById('mSpy').textContent=mh.spy_price?('$'+mh.spy_price+' ('+(mh.spy_1w_ret>=0?'+':'')+mh.spy_1w_ret+'%)'):'—';
  document.getElementById('mDist').textContent=mh.dist_days!=null?(mh.dist_days+' days'):'—';
  document.getElementById('mDist').style.color=mh.dist_days>=4?'#dc2626':mh.dist_days>=2?'#d97706':'#16a34a';
  document.getElementById('mBreadth').textContent=mh.breadth_pct!=null?(mh.breadth_pct+'%'):'—';
  document.getElementById('mBreadth').style.color=mh.breadth_pct>=65?'#16a34a':mh.breadth_pct>=50?'#d97706':'#dc2626';
  document.getElementById('mktAdv').textContent=mh.state_advice||'—';

  // Breaking ticker
  const brk=alerts.filter(a=>a.age_hours<=4);
  const brkBar=document.getElementById('brkBar');
  if(brk.length){
    document.getElementById('brkTxt').textContent=brk.map(a=>'['+a.ticker+'] '+a.news_title+' ('+a.outlet+')').join('  •••  ');
    brkBar.classList.remove('hidden');
  } else { brkBar.classList.add('hidden'); }

  renderCards(picks);
  renderAlerts(alerts);
  renderMarket(mktNews);
  renderTable(picks);
  chartsInited=false;
}

// ── History bar ──
function renderHistBar(){
  if(!D) return;
  const bar=document.getElementById('histDays');
  if(!historyDates.length){
    bar.innerHTML='<span style="font-size:10px;color:#94a3b8">History building…</span>';
    return;
  }
  const today=D.scan_date;
  bar.innerHTML=historyDates.map(d=>{
    const s=histSummary[d]||{};
    const isToday=d===today;
    const dt=new Date(d+'T12:00:00');
    const dStr=dt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    return '<div class="hist-day'+(isToday?' active today':'')+'" onclick="switchDate(\''+d+'\')" title="'+d+'">'
      +'<div class="hist-day-date">'+dStr+'</div>'
      +'<div class="hist-day-sb">\u{1F7E2} '+(s.strong_buy||0)+' SB</div>'
      +'<div class="hist-day-w">\u{1F7E1} '+(s.watch||0)+' W</div>'
      +'<div class="hist-day-mkt">'+(s.market_state||'—')+'</div>'
      +'</div>';
  }).join('');
}

function switchDate(date){
  document.querySelectorAll('.hist-day').forEach(el=>el.classList.toggle('active',el.getAttribute('onclick').includes("'"+date+"'")));
  const s=histSummary[date];
  if(!s||!D) return;
  const isToday=date===D.scan_date;
  if(!isToday){
    const spy=s.spy_1w_ret!=null?((s.spy_1w_ret>=0?'+':'')+s.spy_1w_ret+'%'):'—';
    document.getElementById('mktAdv').textContent='📅 '+date+': '+s.strong_buy+' SB, '+s.watch+' W | '+s.market_state+' | VIX: '+s.vix+' | SPY 1w: '+spy+' | Top: '+(s.top5||[]).join(', ');
  } else {
    document.getElementById('mktAdv').textContent=(D.market_health||{}).state_advice||'—';
  }
}

// ── Cards ──
function renderCards(picks){
  document.getElementById('picksGrid').innerHTML=(picks||[]).slice(0,12).map(s=>{
    const sig=(s.signal||'').replace(' ','-');
    const score=s.combined_score||s.score||0;
    const fc=sig==='STRONG-BUY'?'sbar-s':sig==='WATCH'?'sbar-w2':'sbar-k';
    const crit=Object.entries(s.criteria||{}).map(([k,v])=>'<span class="ss-pill '+(v?'ss-pass':'ss-fail')+'">'+(v?'✓':'✗')+' '+(critLabels[k]||k)+'</span>').join('');
    let ptags='';
    if(s.is_vcp) ptags+='<span class="ptag ptag-vcp">VCP '+(s.vcp_contractions||'')+'× ('+(s.vcp_tightest_pct||0)+'%)</span>';
    if(s.rs_at_high) ptags+='<span class="ptag ptag-rs">RS New High &#x1F525;</span>';
    else if(s.rs_4w_change>3) ptags+='<span class="ptag ptag-rs">RS ↑'+s.rs_4w_change+'% 4w</span>';
    if(s.is_vdu) ptags+='<span class="ptag ptag-vdu">Vol Dry-Up '+Math.round(s.vdu_ratio*100)+'%</span>';
    if(s.is_pocket_pivot) ptags+='<span class="ptag ptag-pp">Pocket Pivot ⚡</span>';
    if(s.squeeze_potential==='HIGH'||s.squeeze_potential==='MEDIUM') ptags+='<span class="ptag ptag-sq">Squeeze '+s.short_pct_float+'% short</span>';
    if(s.earnings_flag==='CATALYST') ptags+='<span class="ptag ptag-earn">Earnings in '+s.days_to_earnings+'d ⚡</span>';
    const newsBadge=s.news_sentiment?'<span class="news-b nb-'+sc(s.news_sentiment)+'">📰 '+s.news_sentiment+'</span>':'';
    const brkF=s.has_breaking_news?'<span class="brkflag">🔴 LIVE</span>':'';
    const earnB=s.earnings_flag&&s.earnings_flag!=='DISTANT'&&s.earnings_flag!=='UNKNOWN'?'<span class="earnflag earn-'+s.earnings_flag+'">'+s.earnings_label+'</span>':'';
    const th=s.thesis||'';
    const str=(s.key_strengths||[]).slice(0,3).map(x=>'<div class="th-item">✅ '+x+'</div>').join('');
    const rsk=(s.key_risks||[]).slice(0,2).map(x=>'<div class="th-item">⚠️ '+x+'</div>').join('');
    const wtw=(s.what_to_watch||[]).slice(0,2).map(x=>'<div class="th-item">👁 '+x+'</div>').join('');
    const thHtml=th?'<div class="thesis-sec"><div class="thesis-hdr"><span>🧠 Grade: <strong>'+(s.setup_quality||'—')+'</strong></span><span class="thesis-toggle" onclick="toggleThesis(this)">▼ Show</span></div><div class="thesis-body"><p style="font-size:11px;color:#374151;line-height:1.5;margin-bottom:4px;">'+th+'</p>'+(str?'<div class="th-lbl g">STRENGTHS</div>'+str:'')+(rsk?'<div class="th-lbl r">RISKS</div>'+rsk:'')+(wtw?'<div class="th-lbl b">WATCH</div>'+wtw:'')+'</div></div>':'';
    const newsHtml=(s.top_news||[]).slice(0,3).map(n=>'<div class="nitem"><div class="ntitle"><a href="'+(n.url||'#')+'" target="_blank">'+n.title+'</a></div><div class="nmeta"><span class="otag '+(n.outlet||'').replace(/[^a-zA-Z]/g,'')+'">'+n.outlet+'</span><span class="bage">'+age2str(n.age_hours)+'</span><span class="bsent '+sc(n.sentiment||'NEUTRAL')+'">'+n.sentiment+'</span>'+(n.catalyst?'<span class="catflag">⚡</span>':'')+'</div></div>').join('');
    return '<div class="card '+sig+'"><div class="accent"></div>'
      +'<div class="ctop"><div><div class="tkr">'+s.ticker+'</div><div class="coname" title="'+s.name+'">'+s.name+'</div><span class="sectag">'+(s.sector||'—')+'</span></div>'
      +'<div class="badges"><span class="sig sig-'+sig+'">'+s.signal+'</span>'+(s.setup_quality?'<span class="qual">'+s.setup_quality+'</span>':'')+newsBadge+brkF+earnB+'</div></div>'
      +'<div class="srow"><span style="font-size:9px;color:#94a3b8;font-weight:600;min-width:40px">SCORE</span><div class="sbar-w"><div class="sbar '+fc+'" style="width:'+score+'%"></div></div><span class="snum2">'+score+'</span></div>'
      +(ptags?'<div class="pattern-strip">'+ptags+'</div>':'')
      +'<div class="mgrid"><div class="met"><div class="mlbl">Price</div><div class="mval">$'+s.price+'</div></div><div class="met"><div class="mlbl">RSI</div><div class="mval '+(s.rsi>=50&&s.rsi<=75?'up':'dn')+'">'+s.rsi+'</div></div><div class="met"><div class="mlbl">Vol Surge</div><div class="mval '+(s.vol_ratio>=1.5?'up':'')+'">'+s.vol_ratio+'×</div></div><div class="met"><div class="mlbl">3M Mom%</div><div class="mval '+(s.momentum_3m>=0?'up':'dn')+'">'+(s.momentum_3m>=0?'+':'')+s.momentum_3m+'%</div></div><div class="met"><div class="mlbl">EPS Gr%</div><div class="mval '+(s.eps_growth>=20?'up':s.eps_growth>0?'':'dn')+'">'+(s.eps_growth!=null?(s.eps_growth>=0?'+':'')+s.eps_growth+'%':'—')+'</div></div><div class="met"><div class="mlbl">Fwd P/E</div><div class="mval">'+fmt(s.fwd_pe)+'</div></div></div>'
      +'<div class="sig-strip">'+crit+'</div>'
      +'<div class="tbox"><div class="ti"><div class="tilbl">Entry</div><div class="tival e">$'+s.entry+'</div></div><div class="ti"><div class="tilbl">Stop</div><div class="tival s">$'+s.stop_loss+'</div></div><div class="ti"><div class="tilbl">Target</div><div class="tival t">$'+s.target_1+'</div></div><div class="ti"><div class="tilbl">R:R</div><div class="tival r">'+s.rr_ratio+':1</div></div></div>'
      +thHtml
      +(newsHtml?'<div class="news-sec"><div class="news-stitle">📰 Latest News</div>'+newsHtml+'</div>':'')
      +'</div>';
  }).join('');
}
function toggleThesis(el){const b=el.closest('.thesis-sec').querySelector('.thesis-body');b.classList.toggle('open');el.textContent=b.classList.contains('open')?'▲ Hide':'▼ Show';}

// ── Alerts ──
function renderAlerts(alerts){
  const g=document.getElementById('alertsGrid');
  if(!(alerts||[]).length){g.innerHTML='<div class="noalerts"><div style="font-size:48px">🔕</div><div style="font-size:14px;font-weight:600;color:#64748b;margin-top:8px">No breaking catalysts right now</div></div>';return;}
  g.innerHTML=(alerts||[]).map(a=>{
    const sig=(a.signal||'').replace(' ','-');
    const oc='otag '+(a.outlet||'').replace(/[^a-zA-Z]/g,'');
    return '<div class="acrd"><div class="atop"><div><div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;"><span class="atkr">'+a.ticker+'</span><span class="sig sig-'+sig+'">'+a.signal+'</span><span style="font-weight:700;color:#64748b">$'+a.price+'</span></div></div><div style="text-align:right"><div style="font-size:20px;font-weight:800;color:#9333ea">'+a.score+'</div><div style="font-size:9px;color:#94a3b8">SCORE</div></div></div><div class="atitle"><a href="'+(a.url||'#')+'" target="_blank">'+a.news_title+'</a></div><div class="ameta"><span class="'+oc+'">'+(a.outlet||'—')+'</span>'+(a.age_hours<4?'<span class="brkflag">🔴 BREAKING</span>':'')+(a.catalyst?'<span class="catflag">⚡ CATALYST</span>':'')+'<span class="bage">'+age2str(a.age_hours)+'</span></div></div>';
  }).join('');
}

// ── Market news ──
function renderMarket(mktNews){
  document.getElementById('marketGrid').innerHTML=(mktNews||[]).map(n=>{
    const sl=n.sentiment_label||'';
    const cls=sl.includes('BULLISH')?'bull':sl.includes('BEARISH')?'bear':'';
    const oc='otag '+(n.outlet||'').replace(/[^a-zA-Z]/g,'');
    return '<div class="mncrd '+(n.breaking?'brk':cls)+'"><div class="mntitle"><a href="'+(n.url||'#')+'" target="_blank">'+n.title+'</a></div>'+(n.summary?'<div class="mnsumm">'+n.summary+'</div>':'')+'<div class="mnmeta"><span class="'+oc+'">'+(n.outlet||'—')+'</span>'+(n.breaking?'<span class="brkflag">🔴 BREAKING</span>':'')+'<span class="bsent '+sc(sl)+'">'+sl+'</span><span class="bage">'+age2str(n.age_hours)+'</span></div></div>';
  }).join('');
}

// ── Table ──
function st(k){sortKey===k?(sortAsc=!sortAsc):(sortKey=k,sortAsc=false);renderTable(D&&D.stocks||[]);}
function renderTable(picks){
  const sorted=[...(picks||[])].sort((a,b)=>{const av=a[sortKey]??-Infinity,bv=b[sortKey]??-Infinity;return sortAsc?(av>bv?1:-1):(av<bv?1:-1);});
  document.getElementById('tblBody').innerHTML=sorted.map(s=>{
    const sig=(s.signal||'').replace(' ','-');
    const score=s.combined_score||s.score||0;
    const scc=signalCls(s.signal);
    const dots=Object.values(s.criteria||{}).map(v=>'<div class="dot '+(v?'p':'f')+'"></div>').join('');
    const addon=s.news_score_addon||0;
    return '<tr><td><b style="color:#1d4ed8;cursor:pointer" onclick="window.open(\'https://finance.yahoo.com/quote/'+s.ticker+'\',\'_blank\')">'+s.ticker+'</b><br><span style="font-size:9px;color:#94a3b8">'+((s.name||'').split(',')[0].substring(0,16))+'</span></td><td><span class="sig sig-'+sig+'">'+s.signal+'</span></td><td><span class="sc-circle '+scc+'">'+score+'</span></td><td style="font-weight:800;color:#1d4ed8">'+(s.setup_quality||'—')+'</td><td style="color:'+(addon>0?'#16a34a':addon<0?'#dc2626':'#64748b')+';font-weight:700">'+(addon>0?'+':'')+addon+'</td><td>$'+s.price+'</td><td style="color:'+(s.rsi>=50&&s.rsi<=75?'#16a34a':'#94a3b8')+';font-weight:600">'+s.rsi+'</td><td style="color:'+(s.vol_ratio>=1.5?'#16a34a':'#64748b')+';font-weight:600">'+s.vol_ratio+'×</td><td style="color:'+(s.momentum_3m>=0?'#16a34a':'#dc2626')+';font-weight:600">'+(s.momentum_3m>=0?'+':'')+s.momentum_3m+'%</td><td style="color:'+(s.eps_growth>=20?'#16a34a':s.eps_growth>0?'#64748b':'#dc2626')+';font-weight:600">'+(s.eps_growth!=null?(s.eps_growth>=0?'+':'')+s.eps_growth+'%':'—')+'</td><td style="color:'+(s.short_pct_float>=15?'#dc2626':s.short_pct_float>=5?'#d97706':'#64748b')+';font-weight:600">'+(s.short_pct_float||0)+'%</td><td style="color:'+(s.earnings_flag==='CATALYST'?'#1d4ed8':s.earnings_flag==='HIGH_RISK'?'#dc2626':'#64748b')+';font-weight:600">'+(s.days_to_earnings!=null?s.days_to_earnings+'d':'—')+'</td><td style="color:'+(s.pct_from_high>=-10?'#16a34a':s.pct_from_high>=-25?'#d97706':'#dc2626')+';font-weight:600">'+s.pct_from_high+'%</td><td style="color:#22d3ee;font-weight:700">'+s.rr_ratio+':1</td><td><div class="dot-row">'+dots+'</div></td></tr>';
  }).join('');
}

// ── Charts ──
function renderCharts(){
  if(chartsInited||!D) return; chartsInited=true;
  const picks=D.stocks||[];
  const top=picks.slice(0,12);
  const colors=top.map(s=>s.signal==='STRONG BUY'?'rgba(22,163,74,.8)':s.signal==='WATCH'?'rgba(217,119,6,.8)':'rgba(220,38,38,.8)');
  new Chart(document.getElementById('sc1'),{type:'bar',data:{labels:top.map(s=>s.ticker),datasets:[{data:top.map(s=>s.combined_score||s.score),backgroundColor:colors,borderRadius:5,label:'Score'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{min:0,max:100,grid:{color:'#f1f5f9'}},x:{grid:{display:false},ticks:{font:{weight:'700'}}}}}});
  const vcpd=top.map(s=>s.is_vcp?s.vcp_score||20:0);
  const rsd=top.map(s=>s.rs_score||0);
  const vdud=top.map(s=>s.vdu_score||0);
  new Chart(document.getElementById('sc2'),{type:'bar',data:{labels:top.map(s=>s.ticker),datasets:[{label:'VCP',data:vcpd,backgroundColor:'rgba(29,78,216,.7)',borderRadius:3},{label:'RS Line',data:rsd,backgroundColor:'rgba(217,119,6,.7)',borderRadius:3},{label:'Vol Dry-Up',data:vdud,backgroundColor:'rgba(22,163,74,.7)',borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top'}},scales:{x:{stacked:true,grid:{display:false},ticks:{font:{weight:'700'}}},y:{stacked:true,grid:{color:'#f1f5f9'}}}}});
  const addons=top.map(s=>s.news_score_addon||0);
  new Chart(document.getElementById('sc3'),{type:'bar',data:{labels:top.map(s=>s.ticker),datasets:[{label:'News Addon',data:addons,backgroundColor:addons.map(v=>v>0?'rgba(22,163,74,.7)':v<0?'rgba(220,38,38,.7)':'rgba(148,163,184,.5)'),borderRadius:5}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{grid:{color:'#f1f5f9'}},x:{grid:{display:false},ticks:{font:{weight:'700'}}}}}});
}

function sw(name){
  const names=['cards','alerts','market','table','chart'];
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',names[i]===name));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  if(name==='chart') renderCharts();
}
</script>
</body>
</html>
"""

# Inject Firebase config
html = HTML.replace('__FIREBASE_CONFIG__', fb_config_js)

with open(OUT_FILE, 'w') as f:
    f.write(html)
print(f"Built {OUT_FILE} ({len(html):,} chars)")
