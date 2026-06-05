"""
run_platform.py — Master orchestrator for the Sparks Finance Intelligence Platform.

Replaces run_full_scan.py as the unified daily runner. Runs all modules
in the correct order and supports scheduled execution (3× daily).

Scheduled runs (suggested cron / Task Scheduler):
  08:00 ET  →  python run_platform.py --uid <uid> --mode morning
  12:00 ET  →  python run_platform.py --uid <uid> --mode midday
  16:30 ET  →  python run_platform.py --uid <uid> --mode close

Usage:
    python run_platform.py --uid USER_UID                    # full run
    python run_platform.py --uid USER_UID --mode morning     # pre-market
    python run_platform.py --uid USER_UID --mode midday      # news only
    python run_platform.py --uid USER_UID --mode close       # end-of-day
    python run_platform.py --uid USER_UID --skip-scan        # platform only
    python run_platform.py --uid USER_UID --tickers NVDA AAPL --agents  # agent deep-dive
"""
import sys
import argparse
import subprocess
from datetime import datetime

# ── Step runner ───────────────────────────────────────────────────────────────

def step(label: str):
    print(f"\n{'─'*60}")
    print(f"  {datetime.now().strftime('%H:%M:%S')} │ {label}")
    print(f"{'─'*60}")


def run_scan(full: bool = True):
    step("Running stock scan…")
    cmd = [sys.executable, "run_full_scan.py"]
    if full:
        cmd.append("--full")
    subprocess.run(cmd, check=False)


def run_portfolio(uid: str):
    step(f"Computing portfolio performance for {uid}…")
    import portfolio
    try:
        portfolio.run(uid)
    except Exception as e:
        print(f"  [warn] Portfolio: {e}")


def run_ai_summary(uid: str):
    step(f"Generating AI summary for {uid}…")
    import ai_summary
    try:
        ai_summary.run(uid)
    except Exception as e:
        print(f"  [warn] AI Summary: {e}")


def run_recommendations():
    step("Generating market recommendations…")
    try:
        import recommendations
        stocks = recommendations.load_scan_data()
        if not stocks:
            print("  [skip] No scan data yet")
            return
        opportunities = recommendations.filter_opportunities(stocks)
        print(f"  {len(opportunities)} opportunities identified")
        recs = recommendations.build_recommendations(opportunities)
        db = recommendations.get_db()
        recommendations.push_recommendations(db, recs)
    except Exception as e:
        print(f"  [warn] Recommendations: {e}")


def run_watchlist(uid: str):
    step(f"Scanning watchlists for {uid}…")
    import watchlist
    try:
        db = watchlist.get_db()
        watchlist.scan_watchlist(db, uid)
    except Exception as e:
        print(f"  [warn] Watchlist: {e}")


def run_alerts(uid: str):
    step(f"Evaluating alerts for {uid}…")
    import alerts_engine
    try:
        db = alerts_engine.get_db()
        alerts_engine.evaluate_alerts(db, uid)
    except Exception as e:
        print(f"  [warn] Alerts: {e}")


def run_health(uid: str):
    step(f"Running health monitor for {uid}…")
    import health_monitor
    try:
        db = health_monitor.get_db()
        holdings = health_monitor.evaluate_portfolio(db, uid)
        if holdings:
            health_monitor.push_health_report(db, uid, holdings)
    except Exception as e:
        print(f"  [warn] Health Monitor: {e}")


def run_agents_for_tickers(tickers: list[str]):
    step(f"Running 8-agent analysis for: {', '.join(tickers)}…")
    try:
        from agents.run_agents import run_all_agents, get_db, push_to_firestore
        db = get_db()
        for ticker in tickers:
            print(f"\n  Analyzing {ticker}…")
            result = run_all_agents(ticker, verbose=True)
            push_to_firestore(db, ticker, result)
    except Exception as e:
        print(f"  [warn] Agents: {e}")


def run_queued_agents():
    """Process tickers queued via the Research tab web UI."""
    step("Checking agent analysis queue…")
    try:
        import portfolio as pf_mod
        db = pf_mod.get_db()
        pending = list(db.collection("agent_queue")
                       .where("status", "==", "pending").stream())
        if not pending:
            print("  [skip] No tickers queued")
            return
        tickers = [doc.id for doc in pending]
        print(f"  Queued tickers: {', '.join(tickers)}")
        # Mark as processing so browser shows spinner
        for doc in pending:
            doc.reference.update({"status": "processing"})
        # Run agents — results auto-push to agent_results/{ticker}/dates/{date}
        run_agents_for_tickers(tickers)
        # Mark done
        for doc in pending:
            doc.reference.update({"status": "done"})
    except Exception as e:
        print(f"  [warn] Queued agents: {e}")


def get_all_holding_tickers(uid: str) -> list[str]:
    """Return deduplicated list of all tickers held by this user across all portfolios."""
    try:
        import portfolio as pf_mod
        db = pf_mod.get_db()
        portfolios = pf_mod.list_portfolios(db, uid)
        tickers = set()
        for pf in portfolios:
            for h in pf_mod.list_holdings(db, uid, pf["id"]):
                t = (h.get("ticker") or "").upper()
                if t:
                    tickers.add(t)
        return sorted(tickers)
    except Exception as e:
        print(f"  [warn] Could not fetch holding tickers: {e}")
        return []


def run_agents_for_holdings(uid: str):
    """Auto-discover all holding tickers + top scan picks and run 8-agent analysis."""
    step(f"Running 8-agent analysis for all holdings + top scan picks…")

    # 1. All portfolio holding tickers
    holding_tickers = get_all_holding_tickers(uid)

    # 2. Top 5 STRONG BUY from today's scan (enriches Research tab for top picks)
    scan_tickers = []
    try:
        import json
        from pathlib import Path
        scan_file = Path(__file__).parent / "combined_results.json"
        if scan_file.exists():
            data = json.loads(scan_file.read_text())
            stocks = data.get("stocks", data) if isinstance(data, dict) else data
            scan_tickers = [s["ticker"] for s in stocks if s.get("signal") == "STRONG BUY"][:5]
    except Exception:
        pass

    # 3. Combine, deduplicate, run
    all_tickers = sorted(set(holding_tickers + scan_tickers))
    if not all_tickers:
        print("  [skip] No tickers found — add holdings via the web app first")
        return

    holding_str = ', '.join(holding_tickers) if holding_tickers else 'none'
    scan_str    = ', '.join(scan_tickers)    if scan_tickers    else 'none'
    print(f"  Holdings : {holding_str}")
    print(f"  Scan picks: {scan_str}")
    run_agents_for_tickers(all_tickers)


def run_firebase_push():
    step("Pushing to Firestore…")
    try:
        import firebase_push
        import json
        from pathlib import Path
        scan_file = Path(__file__).parent / "combined_results.json"
        if scan_file.exists():
            with open(scan_file) as f:
                data = json.load(f)
            firebase_push.push_to_firestore(data)
        else:
            print("  [skip] No combined_results.json yet — run a scan first")
    except Exception as e:
        print(f"  [warn] Firebase Push: {e}")


def run_build_dashboard():
    # DISABLED: build_hosted_dashboard.py regenerates firebase_hosting/index.html and
    # OVERWRITES the live Google-Finance-styled app (auth + live Firestore reads).
    # The hosted page is now maintained by hand and reads Firestore directly, so it
    # must NOT be regenerated. Left as a no-op on purpose — do not re-enable.
    print("  [skip] Dashboard rebuild disabled (would overwrite the live app)")


# ── Mode orchestration ────────────────────────────────────────────────────────

def morning_run(uid: str):
    """Pre-market: Full scan + portfolio + agent analysis + AI summary + health check."""
    print("\n⏰  MORNING RUN — Pre-Market Intelligence Report")
    run_scan(full=True)
    run_firebase_push()
    run_portfolio(uid)
    run_queued_agents()            # process any tickers queued via the web Research tab
    run_agents_for_holdings(uid)   # auto-runs for all holdings + top scan picks
    run_ai_summary(uid)
    run_health(uid)
    run_recommendations()
    run_build_dashboard()


def midday_run(uid: str):
    """Midday: News refresh + watchlist + alert evaluation."""
    print("\n⏰  MIDDAY RUN — Intraday Monitor")
    run_scan(full=False)
    run_firebase_push()
    run_watchlist(uid)
    run_alerts(uid)


def close_run(uid: str):
    """After close: Full scan + full platform refresh."""
    print("\n⏰  CLOSE RUN — End-of-Day Full Refresh")
    run_scan(full=True)
    run_firebase_push()
    run_portfolio(uid)
    run_queued_agents()            # process any tickers queued via the web Research tab
    run_agents_for_holdings(uid)   # auto-runs for all holdings + top scan picks
    run_ai_summary(uid)
    run_health(uid)
    run_watchlist(uid)
    run_alerts(uid)
    run_recommendations()
    run_build_dashboard()


def full_run(uid: str):
    """Complete run of all modules."""
    morning_run(uid)
    run_watchlist(uid)
    run_alerts(uid)


def _all_portfolio_uids() -> list:
    """Every user UID that owns at least one portfolio (so reports can be built for all)."""
    try:
        import portfolio as pf_mod
        db = pf_mod.get_db()
        return [d.id for d in db.collection("portfolios").list_documents()]
    except Exception as e:
        print(f"  [warn] Could not list users: {e}")
        return []


def publish_run(uid: str):
    """Lightweight refresh: push the latest scan to Firestore + regenerate the
    AI summary and health report. No re-scan, no agents, no dashboard rebuild.

    This is the single command that replaces:
        python KV/firebase_push.py
        python KV/ai_summary.py <uid>
        python KV/health_monitor.py <uid>
    """
    print("\n⏰  PUBLISH RUN — Push latest scan + AI reports")
    run_firebase_push()   # pushes existing combined_results.json (all stocks)
    run_portfolio(uid)    # refresh stored holding prices/P&L
    run_ai_summary(uid)
    run_health(uid)


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Sparks Finance — Platform Runner")
    parser.add_argument("--uid", required=True,
                        help="Firebase user UID, or 'all' (with --mode publish) to build reports for every user")
    parser.add_argument("--mode", choices=["morning", "midday", "close", "full", "publish"],
                        default="full",
                        help="Run mode. 'publish' = push latest scan + AI summary + health only "
                             "(no re-scan/agents/dashboard).")
    parser.add_argument("--skip-scan", action="store_true",
                        help="Skip stock scan (use existing data)")
    parser.add_argument("--tickers", nargs="*", help="Run agent deep-dive on these tickers")
    parser.add_argument("--agents", action="store_true",
                        help="Run multi-agent analysis (requires --tickers)")
    args = parser.parse_args()

    start = datetime.now()
    print(f"\n{'═'*60}")
    print(f"  Sparks Finance Intelligence Platform")
    print(f"  {start.strftime('%Y-%m-%d %H:%M:%S')} | Mode: {args.mode} | UID: {args.uid}")
    print(f"{'═'*60}")

    # Agent deep-dive if requested
    if args.tickers and args.agents:
        run_agents_for_tickers(args.tickers)

    # Main mode execution
    if args.mode == "publish":
        if args.uid.lower() == "all":
            run_firebase_push()
            uids = _all_portfolio_uids()
            print(f"  Generating reports for {len(uids)} user(s): {', '.join(uids) or 'none'}")
            for u in uids:
                run_portfolio(u); run_ai_summary(u); run_health(u)
        else:
            publish_run(args.uid)
    elif args.mode == "morning":
        morning_run(args.uid)
    elif args.mode == "midday":
        midday_run(args.uid)
    elif args.mode == "close":
        close_run(args.uid)
    else:
        full_run(args.uid)

    elapsed = (datetime.now() - start).total_seconds()
    print(f"\n{'═'*60}")
    print(f"  Platform run complete in {elapsed:.0f}s")
    print(f"{'═'*60}\n")


if __name__ == "__main__":
    main()
