# 🧠 Cowork — Claude drives the platform (same UI, Claude as the input)

Same as the original Mission Control: the scripts gather the **data**; **Claude (in Cowork)
decides the analysis**. Claude's output is merged onto the real data and published to the
**existing** Firestore docs the site already reads — so the UI is unchanged, the *inputs* changed.
No Anthropic API key, no per-token billing.

What Claude now drives (all through the existing UI):

| Surface | Reads from | Claude authors → script |
|---|---|---|
| **Top Picks cards** | `scans/latest.claude_picks` | `claude_recommendations.json` → `apply_claude_recommendations.py` |
| **Full Table** | `scans/latest.stocks` (rated rows patched) | (same) |
| **Market News + market bar** | `scans/latest.market_news` / `.market_health` | (same) |
| **Research tab (per ticker)** | `agent_results/{ticker}/dates/{date}` | `claude_research.json` → `apply_claude_research.py` |
| **Home — per-holding call** | `claude_holdings/{uid}` | `gather_holdings.py` → `claude_holdings.json` → `apply_claude_holdings.py` |

**Data source:** the scan uses **Yahoo Finance** (free); the site's live quotes/news use **Finnhub** (your Node functions). Claude fetches no prices — it reasons over what the scripts gathered. **History:** `scans/latest` overwrites daily but `history/{date}` keeps a dated summary (the dashboard date-bar), and Research is dated at `agent_results/{ticker}/dates/{date}`.

> Prereqs (one-time): `pip install firebase-admin`; `firebase_service_account.json` already here. The Claude desktop app must be running for scheduled tasks to fire. Every `apply_*.py` supports `--dry-run`.

---

## The data Claude reads + the files Claude writes

- **`combined_results.json`** (from `run_full_scan.py`) — the scanned universe + metrics + raw news. Pick from this so every pick has real numbers.
- **`holdings_dump.json`** (from `gather_holdings.py`) — every user's holdings, so Claude can write per-position calls.
- Claude authors three files (filled examples are in the folder): **`claude_recommendations.json`**, **`claude_research.json`**, **`claude_holdings.json`**. Schemas are documented at the top of each `apply_*.py`.

---

## Daily scheduled tasks (Cowork → Scheduled)

### 🌅 Pre-Market — 8:00 AM ET (weekdays) · cron `0 8 * * 1-5`
```
Run the Sparks Finance pre-market update. Steps:
1. python gather_holdings.py        # writes scan_include.json so every held ticker is scanned
2. python run_full_scan.py --full   # FULL ~620 universe + all holdings (NOT the 22-ticker quick scan)
3. Read combined_results.json. Choose YOUR top setups and write claude_recommendations.json
   (signal/score/grade/thesis/levels per pick + a market read + curated market_news).
   Then write claude_research.json with an 8-dimension deep dive for your top picks (and any
   tickers in agent_queue). Then read holdings_dump.json and write claude_holdings.json with a
   per-position call (action + why) for each user's holdings.
   (All three schemas are at the top of the matching apply_*.py.)
4. python apply_claude_recommendations.py
5. python apply_claude_research.py
6. python apply_claude_holdings.py
7. In your completion message: top 2-3 picks with entry/stop + why.
```

### ⚡ Mid-Day Catalyst Check — 12:00 PM ET (weekdays) · cron `0 12 * * 1-5`
```
Run the Sparks Finance mid-day refresh. Steps:
1. python run_full_scan.py --news
2. Update claude_recommendations.json for anything that changed intraday (breaking news, catalysts);
   refresh market_news. Update claude_research.json only for tickers with material news.
3. python apply_claude_recommendations.py
4. python apply_claude_research.py
5. If nothing material changed: "No new catalysts — picks unchanged."
```

### 🌆 After-Close Digest — 4:30 PM ET (weekdays) · cron `30 16 * * 1-5`
```
Run the Sparks Finance after-close digest. Steps:
1. python gather_holdings.py        # writes scan_include.json so every held ticker is scanned
2. python run_full_scan.py --full   # FULL ~620 universe + all holdings (NOT the 22-ticker quick scan)
3. Write end-of-day claude_recommendations.json (best setups for tomorrow), claude_research.json
   (deep dives), and claude_holdings.json (refreshed per-position calls).
4. python apply_claude_recommendations.py && python apply_claude_research.py && python apply_claude_holdings.py
5. Completion message: STRONG BUYs with reasons, the watch list, the single best setup for tomorrow.
```

---

## Run it manually right now
```
Run a full Sparks Finance update now:
1. python gather_holdings.py        # writes scan_include.json so every held ticker is scanned
2. python run_full_scan.py --full   # FULL ~620 universe + all holdings (NOT the 22-ticker quick scan)
3. Read combined_results.json + holdings_dump.json. Write claude_recommendations.json,
   claude_research.json, and claude_holdings.json (schemas at the top of each apply_*.py).
4. Dry-run to proofread:
   python apply_claude_recommendations.py --dry-run
   python apply_claude_research.py --dry-run
   python apply_claude_holdings.py --dry-run
5. Publish:
   python apply_claude_recommendations.py
   python apply_claude_research.py
   python apply_claude_holdings.py
```

## Notes
- **Scan modes — use `--full`.** Plain `python run_full_scan.py` is the **22-ticker QUICK** scan (fast, for a glance only) — don't publish from it. `--full` scans the full **~620-stock** universe. `--news` is a light news-only refresh of the last scan. Either way, `gather_holdings.py` writes `scan_include.json`, and the scan **force-includes every held ticker** on top of its universe — so all holdings always get real metrics, even small/foreign names outside the S&P/NASDAQ lists. Run `gather_holdings.py` **before** the scan.
- **Recent IPOs (e.g. SpaceX `SPCX`):** force-scanned via `CUSTOM_WATCHLIST` even with only days of history; they appear flagged `is_new_listing` (UI shows a **NEW** badge). Their breakout signals (52-week, VCP, RS) are blank until ~2–3 months of trading — so for a fresh IPO, **lead with a thesis** (business, valuation, IPO momentum) rather than the quant signals, and label it a new listing in your `claude_recommendations.json` / `claude_research.json`. Add new IPO tickers to `CUSTOM_WATCHLIST` (or just hold them) as they list.
- **Pick from the scanned universe** in `combined_results.json` so each pick/research has real metrics. A pick not in the universe still shows as a card but without live numbers.
- **Per-holding privacy:** each user can only read their own `claude_holdings/{uid}` (Firestore rule). `gather_holdings.py` reads all holdings via the admin key on your machine to let Claude write the analysis.
- **The live website chat assistant stays on free OpenRouter** — Cowork can't serve anonymous visitors in real time. Everything else above is Claude-via-Cowork.
- The disabled `USE_CLAUDE=True` Python modules (ai_summary/health_monitor/recommendations) are the *paid-API* path — not used here. Claude authors the analysis directly instead.
