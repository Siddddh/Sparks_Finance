# 📡 Mission Control — Stock Breakout Scanner

A fully automated S&P 500 breakout scanner built on Claude + Cowork. Scans for high-probability breakout setups using Minervini's momentum strategy, news sentiment, VCP patterns, Relative Strength, and more.

---

## What it does

- **Scans 22–90+ S&P 500 stocks** daily using 14 technical + fundamental signals
- **Scores each stock 0–100** and grades them STRONG BUY / WATCH / WEAK
- **Detects breakout patterns**: VCP (Volatility Contraction Pattern), RS Line new highs, Volume Dry-Up, Pocket Pivot
- **Integrates live news** from Reuters, CNBC, Bloomberg, MarketWatch, Benzinga — with sentiment scoring and catalyst detection
- **Market health bar**: VIX, SPY trend, distribution days, breadth — so you always know if conditions favour trading
- **AI trade thesis**: plain-English explanation of every setup — teaches you what to look for
- **Trade journal**: log entries/exits, track win rate, R multiples, expectancy over time
- **3 automatic daily scans**: 8am (pre-market), 12pm (mid-day catalysts), 4:30pm (after-close digest)

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| macOS | 12+ | Windows/Linux should also work with minor path changes |
| Python | 3.9+ | Check with `python3 --version` |
| Claude desktop app | Latest | With Cowork enabled |
| Internet connection | — | For Yahoo Finance data |

---

## Quick Start (5 minutes)

### 1. Copy the files

Place all files from this folder into:
```
~/Claude/KV/
```
This is the default folder that Cowork looks for. Create it if it doesn't exist:
```bash
mkdir -p ~/Claude/KV
cp /path/to/downloaded/files/* ~/Claude/KV/
```

### 2. Run the installer

```bash
cd ~/Claude/KV
chmod +x setup.sh
./setup.sh
```

The installer will:
- Install all Python dependencies (`yfinance`, `pandas`, `numpy`, `scipy`)
- Test the Yahoo Finance connection
- Run your first scan (~90 seconds)
- Build the dashboard HTML
- Offer to open it in your browser

### 3. Open Cowork

1. Open the Claude desktop app
2. Click **Cowork** in the sidebar
3. Select `~/Claude/KV` as your workspace folder
4. Ask Claude: *"Set up my three scheduled daily scans for Mission Control"* and paste the task prompts from the **Scheduled Tasks** section below

---

## File Overview

```
~/Claude/KV/
│
├── run_full_scan.py        ← MASTER SCRIPT: runs everything, saves results + history
├── breakout_scanner.py     ← Technical + fundamental scoring per stock
├── news_fetcher.py         ← News sentiment engine (Reuters, CNBC, Bloomberg etc.)
├── market_health.py        ← VIX, SPY trend, breadth, distribution days
├── thesis_generator.py     ← Plain-English trade narrative generator
├── trade_journal.py        ← Trade logging and performance analytics
├── build_dashboard.py      ← Generates mission_control.html from scan data + history
│
├── combined_results.json   ← Latest scan output (always the most recent run)
├── scan_history.json       ← Rolling 7-day history (one entry per day, last run wins)
├── mission_control.html    ← The dashboard — open in any browser
├── journal.json            ← Your trade log (persists between runs)
│
├── setup.sh                ← One-time installer
└── README.md               ← This file
```

### Session path auto-detection

All scripts automatically detect the correct Cowork session path at runtime — you never need to edit `BASE` path variables manually. This means scripts survive Cowork restarts, session name changes, and new installations without modification.

---

## Running Scans Manually

```bash
cd ~/Claude/KV

# Quick scan (22 stocks, ~90 seconds) — good for daily use
python3 run_full_scan.py

# Full scan (90+ stocks, ~8 minutes)
python3 run_full_scan.py --full

# News-only refresh (keeps last scan scores, just updates news — ~30 seconds)
python3 run_full_scan.py --news

# Rebuild the dashboard after any scan
python3 build_dashboard.py
```

After running, open `mission_control.html` in your browser to see results.

## 7-Day Scan History

Every scan automatically saves to a rolling 7-day history (`scan_history.json`):

- **One entry per day** — the last scan of each day always overwrites earlier runs for that day. The 3 scheduled daily runs (8am, 12pm, 4:30pm) each update the same day's slot, so you always see the freshest data for any given date.
- **7-day rolling window** — entries older than 7 days are automatically pruned.
- **Date bar in dashboard** — the history bar below the breaking news ticker shows each available day as a pill showing Strong Buy count, Watch count, and market state. Click any day to see its summary in the market advice bar.
- **Staleness warning** — if the dashboard data is 2+ days old, a red warning badge appears next to the date bar prompting you to run a fresh scan.

---

## Setting Up Scheduled Daily Scans in Cowork

The system is designed to run automatically 3× per weekday (ET). Set these up in Cowork by asking Claude to create scheduled tasks with the prompts below.

### 🌅 Pre-Market Scan — 8:00 AM ET (weekdays)

> **Task name:** `stock-premarket-scan`
> **Schedule:** `0 8 * * 1-5`

**Prompt to give Claude:**
```
Run the pre-market Mission Control scan. Steps:
1. Run: python3 ~/Claude/KV/run_full_scan.py
2. Run: python3 ~/Claude/KV/build_dashboard.py
3. Update the Mission Control artifact (id: stock-mission-control) with the new HTML at ~/Claude/KV/mission_control.html
4. In your completion message, list any STRONG BUY stocks that have breaking news or catalyst flags.
```

### ⚡ Mid-Day Catalyst Check — 12:00 PM ET (weekdays)

> **Task name:** `stock-midday-catalyst-check`
> **Schedule:** `0 12 * * 1-5`

**Prompt to give Claude:**
```
Run the mid-day news refresh for Mission Control. Steps:
1. Run: python3 ~/Claude/KV/run_full_scan.py --news
2. Run: python3 ~/Claude/KV/build_dashboard.py
3. Update the Mission Control artifact (id: stock-mission-control) with ~/Claude/KV/mission_control.html
4. List any breaking news alerts (age_hours < 4) for STRONG BUY or WATCH stocks.
   If nothing notable: say "No new catalysts. Watchlist unchanged."
```

### 🌆 After-Close Digest — 4:30 PM ET (weekdays)

> **Task name:** `stock-afterclose-digest`
> **Schedule:** `30 16 * * 1-5`

**Prompt to give Claude:**
```
Run the after-close Mission Control digest. Steps:
1. Run: python3 ~/Claude/KV/run_full_scan.py
2. Run: python3 ~/Claude/KV/build_dashboard.py
3. Update the Mission Control artifact (id: stock-mission-control) with ~/Claude/KV/mission_control.html
4. Write an end-of-day summary:
   - STRONG BUYS with score, key reason, and top news headline
   - WATCH list stocks and what they're waiting for
   - Top 2-3 market news headlines
   - Best single trade setup for tomorrow (entry, stop, target)
```

---

## Customising Your Watchlist

Open `run_full_scan.py` and find the `CUSTOM_WATCHLIST` variable near the top:

```python
# Custom watchlist — add any ticker here to always include it in every scan
CUSTOM_WATCHLIST = [
    # "PLTR",   # add any ticker you want to always track
    # "ARM",
    # "MSTR",
]
```

Tickers in `CUSTOM_WATCHLIST` appear in **every scan** regardless of mode. The dashboard also has a live **Custom Watchlist** input bar where you can type in tickers — these persist in your browser.

---

## The Trading Strategy

### Entry Criteria (scored 0–100)

| Signal | Points | What it means |
|---|---|---|
| Stage 2 Trend | 25 | Price > MA50 > MA150 > MA200 |
| VCP Pattern | 0–30 | Volatility contracting — coiled spring |
| RS Line vs S&P | 0–20 | Outperforming the market |
| Volume Dry-Up | 0–15 | Sellers exhausted during consolidation |
| Near 52w High | 12 | Within 25% of annual high |
| RSI 50–75 | 12 | Momentum confirmed, not overextended |
| Volume Surge ≥1.5× | 12 | Institutional conviction on breakout |
| EPS Growth ≥20% | 8 | Earnings power |
| Revenue Growth ≥10% | 8 | Sustainable growth |
| Short Squeeze | 0–15 | High short float + uptrend |
| Insider Buying | 0–15 | Executives buying with own money |
| Earnings Proximity | -5 to +10 | 7–14 days away = catalyst window |
| Pocket Pivot | 8 | Early institutional entry signal |
| News Sentiment | -15 to +15 | Breaking news & catalysts |

**Score ≥ 75 → STRONG BUY | Score 55–74 → WATCH | Score < 55 → WEAK**

### Trade Management

| Parameter | Rule |
|---|---|
| Entry | At/near breakout pivot, within 2–3% |
| Stop Loss | 8% below entry — hard stop, no exceptions |
| Target | 20–25% gain (scale: ⅓ at +10%, ⅓ at +20%, trail rest) |
| Position Size | Risk no more than 1–2% of total portfolio per trade |
| Min R:R | 3:1 — only take setups with at least 3× reward vs risk |

### What NOT to do

- Don't buy within 3 days of earnings (high binary risk)
- Don't trade breakouts when VIX > 25 or market is in correction
- Don't chase stocks more than 5% extended past the breakout point
- Don't hold through earnings without halving your position first

---

## Dashboard Tabs Guide

| Tab | What you'll find |
|---|---|
| 🃏 Top Picks | Stock cards with full metrics, pattern tags, trade setup, AI thesis, and latest news |
| ⚡ Alerts | Breaking news (< 4 hours old) for your top picks — mid-day catalyst opportunities |
| 🌐 Market News | Top 8 macro headlines with sentiment — SPY/QQQ context |
| 📋 Full Table | Sortable table of all scanned stocks with every metric |
| 📈 Charts | Score comparison, signal breakdown (VCP/RS/VDU), and news contribution charts |
| 📓 Trade Journal | Log and track your trades — win rate, R multiples, expectancy |
| 🧠 Strategy | Full strategy reference and scoring criteria |

---

## Reading a Stock Card

```
┌─────────────────────────────────────────────┐
│ AMD                              STRONG BUY  │  ← Signal
│ Advanced Micro Devices           Grade: A+   │  ← Setup quality
│ Technology                    📰 BULLISH     │  ← News sentiment
│                                              │
│ SCORE ████████████████████████  98.2        │  ← Combined score
│                                              │
│ [VCP 6× (7.1%)] [RS ↑8% 4w] [Earn in 11d⚡]│  ← Pattern tags
│                                              │
│ Price    RSI    Vol Surge   3M Mom   EPS Gr  │
│ $341     73.9   1.04×       +41%    +217%    │
│                                              │
│ ✓ Stage 2  ✓ Near High  ✓ RSI  ✗ Volume    │  ← Criteria
│ ✓ EPS 20%+ ✓ Rev 10%+  ✓ VCP  ✗ RS High   │
│                                              │
│ Entry    Stop     Target    R:R             │
│ $341.54  $314.22  $409.85   2.5:1          │  ← Trade setup
│                                              │
│ 🧠 Trade Thesis ▼ Show                      │  ← Click to expand
│ 📰 Latest News                               │  ← 3 headlines
└─────────────────────────────────────────────┘
```

---

## Troubleshooting

**"No module named yfinance"**
```bash
pip3 install --user yfinance pandas numpy scipy
```

**Scan fails or returns no data**
- Check internet connection
- Yahoo Finance occasionally rate-limits; wait 30 seconds and retry
- Try: `python3 -c "import yfinance as yf; print(yf.Ticker('SPY').info['regularMarketPrice'])"`

**Dashboard shows old data**
- Run `python3 run_full_scan.py` then `python3 build_dashboard.py`
- Reload the HTML file in your browser (Cmd+R)

**Cowork can't find the scripts**
- Make sure scripts are in `~/Claude/KV/`
- In Cowork, click the folder icon and select `~/Claude/KV`

**Scheduled tasks aren't running**
- The Claude desktop app must be running for scheduled tasks to fire
- Check the Scheduled section in the Cowork sidebar for status

**Dashboard showing stale data (red warning badge)**
- The 7-day history bar will show a red "Data is N days old" badge if the latest scan is 2+ days old
- Run `python3 run_full_scan.py && python3 build_dashboard.py` to refresh immediately
- If scheduled tasks were running but the Cowork artifact wasn't updating, ask Claude to update the artifact: *"Update the Mission Control artifact with the latest dashboard"*

**scan_history.json shows duplicate days**
- This shouldn't happen — each scan overwrites the same-day entry automatically
- If it does occur, delete `scan_history.json` and run a fresh scan to reset the history

---

## Firebase Hosting — Live Shared Dashboard

Deploy Mission Control to Firebase so anyone on your team can open it at a public URL. The dashboard reads live data directly from Firestore and auto-refreshes in real time whenever a new scan runs.

### Architecture

```
Cowork (your desktop)
  └── run_full_scan.py
        └── firebase_push.py ──→ Firestore: scans/latest
                              ──→ Firestore: history/YYYY-MM-DD
                              
Firebase Hosting
  └── index.html ──→ Firestore (real-time listener via onSnapshot)
  
Team members open: https://YOUR_PROJECT_ID.web.app
```

### One-time Setup (10 minutes)

**Step 1 — Get your Firebase credentials**

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Select your existing project
3. **Web app config** (for the dashboard HTML):
   - Project Settings → Your apps → Web app → Config
   - Copy the config object
   - Save as `~/Claude/KV/firebase_config.json` using the template:
     ```bash
     cp ~/Claude/KV/firebase_config.template.json ~/Claude/KV/firebase_config.json
     # Edit firebase_config.json with your values
     ```
4. **Service account key** (for Python → Firestore writes):
   - Project Settings → Service Accounts → Generate new private key
   - Save the downloaded JSON as `~/Claude/KV/firebase_service_account.json`

**Step 2 — Enable Firestore**

Firebase Console → Build → Firestore Database → Create database → Start in **production mode** → choose a region → Done.

**Step 3 — Install Firebase CLI**

```bash
npm install -g firebase-tools
firebase login
```

**Step 4 — Install firebase-admin Python package**

```bash
pip3 install --user firebase-admin
```

**Step 5 — Deploy**

```bash
cd ~/Claude/KV
chmod +x deploy.sh
./deploy.sh
```

The deploy script will:
- Build `firebase_hosting/index.html` with your Firebase config injected
- Push the current scan data to Firestore
- Deploy the dashboard to Firebase Hosting
- Deploy the Firestore security rules (public read, no public write)
- Print your live URL: `https://YOUR_PROJECT_ID.web.app`

### After Deployment

Every time `run_full_scan.py` runs (via scheduled tasks or manually), it automatically pushes fresh data to Firestore. The hosted dashboard will update in real time for all viewers — no manual redeploy needed.

To redeploy the HTML (e.g. after dashboard UI changes):
```bash
./deploy.sh
```

### File Reference

| File | Purpose |
|---|---|
| `firebase_config.json` | Web app credentials (you create from template) |
| `firebase_config.template.json` | Template — copy and fill in |
| `firebase_service_account.json` | Service account key for Python writes (you download) |
| `firebase_push.py` | Pushes scan data to Firestore after each run |
| `build_hosted_dashboard.py` | Generates `firebase_hosting/index.html` |
| `firebase_hosting/index.html` | The hosted dashboard (reads from Firestore) |
| `firebase.json` | Firebase Hosting + Firestore rules config |
| `.firebaserc` | Firebase project alias |
| `firestore.rules` | Security rules: public read, no public write |
| `deploy.sh` | One-command full deployment |

### Security

- **Firestore data**: publicly readable (anyone can read scan results), not publicly writable. Writes only happen via the service account key on your machine.
- **Service account key**: keep `firebase_service_account.json` private — never commit it to git. It's already in `.gitignore` if you use git.
- **Dashboard URL**: public by default (anyone with the link). Firebase Auth can be added later if you need org-only access.

---

## Sharing & Collaboration

**Share the current dashboard (read-only):**
Send the `mission_control.html` file — it opens in any browser with all data embedded.

**Share the live system:**
1. Zip the `~/Claude/KV` folder
2. Recipient unzips to their `~/Claude/KV`
3. They run `./setup.sh`
4. They set up their own scheduled tasks in their Cowork

**Shared data feed (same scan, multiple viewers):**
Point `combined_results.json` to a shared folder (Dropbox, Google Drive, network drive):
- In `run_full_scan.py` change `OUT = "/path/to/shared/combined_results.json"`
- In `build_dashboard.py` change `BASE` to read from the same shared path
- Each person opens their own copy of `mission_control.html`

---

## Data Sources

All data is free via Yahoo Finance (yfinance library):
- Price/volume history (OHLCV, daily)
- Fundamentals (EPS growth, revenue, forward P/E)
- Short interest (% float, days to cover)
- Insider transactions
- Analyst recommendations
- Earnings calendar
- News aggregation (Reuters, CNBC, Bloomberg, MarketWatch, Benzinga, Barron's, WSJ)

No API keys required. Rate limit: ~2,000 requests/day (well within daily scan needs).

---

*Strategy based on Mark Minervini's SEPA method. For educational purposes — not financial advice. Always do your own research and manage risk carefully.*
