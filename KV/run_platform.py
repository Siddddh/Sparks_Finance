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
    step("Building hosted dashboard…")
    subprocess.run([sys.executable, "build_hosted_dashboard.py"], check=False)


# ── Mode orchestration ────────────────────────────────────────────────────────

def morning_run(uid: str):
    """Pre-market: Full scan + portfolio + AI summary + health check."""
    print("\n⏰  MORNING RUN — Pre-Market Intelligence Report")
    run_scan(full=True)
    run_firebase_push()
    run_portfolio(uid)
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


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Sparks Finance — Platform Runner")
    parser.add_argument("--uid", required=True, help="Firebase user UID")
    parser.add_argument("--mode", choices=["morning", "midday", "close", "full"],
                        default="full", help="Run mode")
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
    if not args.skip_scan or args.mode in ("morning", "close", "full"):
        if args.mode == "morning":
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
