"""
run_agents.py — Run all 8 agents for a ticker, merge results, push to Firestore.

Usage:
    python agents/run_agents.py NVDA
    python agents/run_agents.py AAPL MSFT GOOGL    # multiple tickers
    python agents/run_agents.py NVDA --dry-run     # print only, no Firestore
"""
import sys
import json
import argparse
from datetime import datetime, date
from concurrent.futures import ThreadPoolExecutor, as_completed

# Import each agent
from . import (
    fundamentals_agent, technical_agent, earnings_agent,
    insider_agent, analyst_agent, valuation_agent, risk_agent, catalyst_agent,
)

try:
    import firebase_admin
    from firebase_admin import credentials, firestore
    FIREBASE_AVAILABLE = True
except ImportError:
    FIREBASE_AVAILABLE = False

AGENT_MAP = {
    "fundamental": fundamentals_agent,
    "technical":   technical_agent,
    "earnings":    earnings_agent,
    "insider":     insider_agent,
    "analyst":     analyst_agent,
    "valuation":   valuation_agent,
    "risk":        risk_agent,
    "catalyst":    catalyst_agent,
}

SIGNAL_WEIGHTS = {
    "fundamental": 0.20,
    "technical":   0.20,
    "earnings":    0.15,
    "insider":     0.10,
    "analyst":     0.15,
    "valuation":   0.10,
    "risk":        0.05,
    "catalyst":    0.05,
}

def get_db():
    if not FIREBASE_AVAILABLE:
        return None
    if not firebase_admin._apps:
        import os
        sa_path = os.path.join(os.path.dirname(__file__), "..", "firebase_service_account.json")
        cred = credentials.Certificate(sa_path)
        firebase_admin.initialize_app(cred)
    return firestore.client()


def run_all_agents(ticker: str, verbose: bool = True) -> dict:
    """Run all 8 agents concurrently and merge results."""
    ticker = ticker.upper()
    results = {}

    def run_one(name, agent_module):
        try:
            r = agent_module.analyze(ticker)
            if verbose:
                print(f"  [{name:12s}] score={r['score']:3d}  {r['signals'][0][:60] if r['signals'] else ''}")
            return name, r
        except Exception as e:
            print(f"  [{name:12s}] ERROR: {e}")
            return name, {"ticker": ticker, "score": 50, "signals": [str(e)], "summary": "Error", "raw": {}}

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(run_one, name, mod): name for name, mod in AGENT_MAP.items()}
        for future in as_completed(futures):
            name, result = future.result()
            results[name] = result

    # Weighted composite score
    composite = sum(results[n]["score"] * w for n, w in SIGNAL_WEIGHTS.items() if n in results)

    # Signal determination
    if composite >= 72:
        signal = "STRONG BUY"
    elif composite >= 55:
        signal = "WATCH"
    else:
        signal = "WEAK"

    # Collect top signals across all agents
    all_signals = []
    for name, r in results.items():
        for sig in (r.get("signals") or [])[:2]:
            all_signals.append(f"[{name.title()}] {sig}")

    # Build consolidated output
    merged = {
        "ticker": ticker,
        "signal": signal,
        "composite_score": round(composite, 1),
        "summary": f"{ticker} scores {composite:.0f}/100 — {signal}",
        "full_analysis": "\n".join(all_signals),
        "analyzed_at": datetime.utcnow().isoformat(),
        "date": date.today().isoformat(),
    }

    # Add per-agent scores and top signals
    for name in AGENT_MAP:
        r = results.get(name, {})
        merged[f"{name}_score"] = r.get("score", 50)
        merged[f"{name}_signals"] = (r.get("signals") or [])[:3]
        merged[f"{name}_summary"] = r.get("summary", "")

    return merged


def push_to_firestore(db, ticker: str, merged: dict):
    today = merged["date"]
    db.collection("agent_results").document(ticker).collection("dates").document(today).set(merged)
    print(f"  Pushed agent_results/{ticker}/dates/{today}")


def main():
    parser = argparse.ArgumentParser(description="Sparks Finance — Multi-Agent Runner")
    parser.add_argument("tickers", nargs="+", help="Ticker symbols to analyze")
    parser.add_argument("--dry-run", action="store_true", help="Print results, skip Firestore push")
    args = parser.parse_args()

    db = None if args.dry_run else get_db()

    for ticker in args.tickers:
        print(f"\nAnalyzing {ticker.upper()}…")
        merged = run_all_agents(ticker, verbose=True)
        print(f"  → Composite: {merged['composite_score']} | Signal: {merged['signal']}")

        if db:
            push_to_firestore(db, ticker.upper(), merged)
        else:
            print(json.dumps({k: v for k, v in merged.items() if "signals" not in k and "summary" not in k}, indent=2))

    print("\nDone.")


if __name__ == "__main__":
    main()
