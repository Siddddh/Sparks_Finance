# 🧠 Cowork "Claude's Take" — Scheduled Tasks

This is how Claude is **inculcated the same way as the original Mission Control**: the
heavy lifting (scan, scoring, news) is rule-based Python, and **Claude — running here in
Cowork — writes the actual market read** and publishes it to the live site. No Anthropic
API key, no per-token billing. It rides on your existing Claude subscription, exactly like
the original `~/Claude/KV` dashboard did.

**Flow each run:**
1. `python run_full_scan.py` → produces `combined_results.json` (the numbers)
2. `python firebase_push.py` → publishes the scan numbers to Firestore (`scans/latest`)
3. **Claude reads `combined_results.json` and writes its analysis into `claude_insights.json`** (schema below)
4. `python publish_claude_insights.py` → publishes Claude's analysis to Firestore (`insights/latest`)

The website's **"🧠 Claude's Take"** panel reads `insights/latest` live and updates the moment step 4 runs — no redeploy.

> Prereqs (one-time): `pip install firebase-admin` and `firebase_service_account.json` already in this folder (it is). The Claude desktop app must be running for scheduled tasks to fire.

---

## `claude_insights.json` — the schema Claude authors

Only `market_digest` is required; everything else renders when present. Write in your own
voice — concrete, specific, not hype. Always end the takeaway with risk discipline.

```json
{
  "scan_date": "YYYY-MM-DD",            // copy from combined_results.json
  "scan_time_et": "HH:MM AM/PM ET",     // copy from combined_results.json
  "market_state": "UPTREND",            // copy from market_health.market_state
  "headline": "one-line read of the tape",
  "market_digest": "2-4 sentences: what the market is doing and what it means for trading today",
  "top_setups": [
    { "ticker": "NVDA", "action": "BUY | BUY ON PULLBACK | WATCH | TRIM | AVOID", "score": 100, "thesis": "1-3 sentences in your voice — why, and the catch" }
  ],
  "risks": ["short bullet", "short bullet"],
  "watch": ["TICKER — what it's waiting for"],
  "bottom_line": "the single most actionable takeaway, with stop discipline"
}
```

A filled-in example is in `claude_insights.json` already (from the 2026-06-11 scan) — match that shape.

---

## Setting up the 3 daily scheduled tasks in Cowork

Open Cowork → Scheduled → create each task with the cron + prompt below.

### 🌅 Pre-Market — 8:00 AM ET (weekdays) · cron `0 8 * * 1-5`
```
Run the Sparks Finance pre-market update. Steps:
1. Run: python run_full_scan.py
2. Run: python firebase_push.py
3. Read combined_results.json. Write your pre-market read into claude_insights.json
   following the schema in COWORK_CLAUDE_TASKS.md. Lead with the market_state and the
   top STRONG BUY setups; flag anything with breaking news or an earnings catalyst.
4. Run: python publish_claude_insights.py
5. In your completion message, give me the 2-3 best setups for the day with entry/stop.
```

### ⚡ Mid-Day Catalyst Check — 12:00 PM ET (weekdays) · cron `0 12 * * 1-5`
```
Run the Sparks Finance mid-day refresh. Steps:
1. Run: python run_full_scan.py --news
2. Run: python firebase_push.py
3. Read combined_results.json. Update claude_insights.json — focus the market_digest and
   risks on what changed intraday (breaking news < 4h old, catalysts). Keep top_setups current.
4. Run: python publish_claude_insights.py
5. If nothing material changed, say "No new catalysts — watchlist unchanged."
```

### 🌆 After-Close Digest — 4:30 PM ET (weekdays) · cron `30 16 * * 1-5`
```
Run the Sparks Finance after-close digest. Steps:
1. Run: python run_full_scan.py
2. Run: python firebase_push.py
3. Read combined_results.json. Write a full end-of-day read into claude_insights.json:
   market_digest (how the day closed), top_setups (best setups for tomorrow with action +
   thesis), risks, watch, and a bottom_line with stop discipline.
4. Run: python publish_claude_insights.py
5. In your completion message: STRONG BUYs with score + key reason, the watch list, and the
   single best setup for tomorrow (entry, stop, target).
```

---

## Run it manually right now (no schedule)

Paste this into Cowork any time:
```
Run a Sparks Finance update now:
1. python run_full_scan.py
2. python firebase_push.py
3. Read combined_results.json and write your analysis into claude_insights.json (schema in
   COWORK_CLAUDE_TASKS.md).
4. python publish_claude_insights.py --dry-run   (review the output)
5. If it looks right: python publish_claude_insights.py
```

## Notes
- **Scope:** this publishes a single, global "Claude's Take" market digest (like the original's one dashboard). Per-user portfolio analysis isn't done here — it would need Claude to read each user's holdings, which we can add later.
- **The live website chat assistant is separate** — it serves anonymous visitors in real time, which Cowork can't do, so it stays on the free OpenRouter models. Only the batch digest above is Claude-via-Cowork.
- `publish_claude_insights.py --dry-run` prints exactly what would be written without touching Firestore — use it to proofread.
