"""
recommendations.py — AI Stock Recommendation Engine (Req #9).

Scans the market using existing scan data + live scoring, ranks top
opportunities by composite score, and writes results to Firestore
under opportunities/latest.

Each recommendation includes a detailed explanation of why the stock
is being recommended (using Claude API for the narrative).

Usage:
    python recommendations.py                  # use combined_results.json
    python recommendations.py --full           # run fresh scan first
    python recommendations.py --top 10         # top N picks
"""
import json
import argparse
from datetime import datetime, date
from pathlib import Path

import sys, os
sys.path.insert(0, os.path.dirname(__file__))

# ── V1/V2 toggle ───────────────────────────────────────────────────────────────
USE_CLAUDE = False   # Set True in V2 to activate Claude API rationale generation

try:
    import firebase_admin
    from firebase_admin import credentials, firestore
    FIREBASE_AVAILABLE = True
except ImportError:
    FIREBASE_AVAILABLE = False

MODEL = "claude-sonnet-4-6"
DATA_FILE = Path(__file__).parent / "combined_results.json"


def get_db():
    if not FIREBASE_AVAILABLE:
        raise RuntimeError("firebase-admin not installed.")
    if not firebase_admin._apps:
        cred = credentials.Certificate("firebase_service_account.json")
        firebase_admin.initialize_app(cred)
    return firestore.client()


def load_scan_data() -> list[dict]:
    """Load latest scan results from combined_results.json."""
    if not DATA_FILE.exists():
        print(f"  [warn] {DATA_FILE} not found — run a scan first")
        return []
    with open(DATA_FILE) as f:
        data = json.load(f)
    stocks = data.get("stocks", data) if isinstance(data, dict) else data
    return stocks if isinstance(stocks, list) else []


def filter_opportunities(stocks: list[dict], top_n: int = 15) -> list[dict]:
    """Filter and rank stocks by opportunity criteria."""
    filtered = []
    for s in stocks:
        score = s.get("combined_score") or s.get("score") or 0
        signal = s.get("signal", "")
        eps_g = s.get("eps_growth") or 0
        rev_g = s.get("rev_growth") or 0
        rsi = s.get("rsi") or 50
        # Opportunity criteria: strong signal + reasonable technicals
        if (score >= 60 and signal in ("STRONG BUY", "WATCH")
                and 30 <= rsi <= 80):
            filtered.append(s)

    # Sort by composite score descending
    filtered.sort(key=lambda x: x.get("combined_score") or 0, reverse=True)
    return filtered[:top_n]


def template_rationale(stock: dict) -> str:
    """
    V1: Rule-based recommendation using the existing thesis_generator.
    thesis_generator.generate_thesis() already produces professional 3-5 sentence
    narratives covering VCP, RS line, volume dry-up, EPS/revenue, insider activity,
    news sentiment, earnings proximity -- the same engine that powered the original
    mission_control.html. Zero API calls, full quality.
    """
    try:
        from thesis_generator import generate_thesis
        result = generate_thesis(stock)
        return result["thesis"]
    except Exception:
        # Fallback if thesis_generator unavailable
        score = stock.get("combined_score", 0)
        signal = stock.get("signal", "WATCH")
        eps = stock.get("eps_growth")
        mom = stock.get("momentum_3m", 0)
        criteria = stock.get("criteria") or {}
        met = [k.replace("_ok", "").replace("_", " ").title() for k, v in criteria.items() if v]
        rationale = (
            f"{stock.get('ticker')} scores {score}/100 with a {signal} signal. "
            f"{'EPS growing ' + str(eps) + '% YoY. ' if eps and eps > 0 else ''}"
            f"{'3-month momentum +' + str(mom) + '%. ' if mom > 0 else ''}"
            f"{'Criteria met: ' + ', '.join(met[:4]) + '.' if met else ''}"
        )
        return rationale.strip()


def generate_recommendation_claude(stock: dict) -> str:
    """V2: Claude API rationale -- activated when USE_CLAUDE = True."""
    import anthropic
    client = anthropic.Anthropic()
    criteria = stock.get("criteria") or {}
    criteria_met = [k for k, v in criteria.items() if v]
    prompt = (
        f"Write a 2-3 sentence investment recommendation for {stock.get('ticker')} ({stock.get('name', '')}).\n"
        f"Score: {stock.get('combined_score', 0)}/100 | Signal: {stock.get('signal')} | "
        f"Grade: {stock.get('setup_quality', 'N/A')}\n"
        f"Price: ${stock.get('price')} | RSI: {stock.get('rsi')} | 3M Momentum: {stock.get('momentum_3m', 0):+.1f}%\n"
        f"EPS Growth: {stock.get('eps_growth', 'N/A')}% | Revenue: {stock.get('rev_growth', 'N/A')}%\n"
        f"Criteria met: {', '.join(criteria_met) if criteria_met else 'Standard signals'}\n"
        f"Pattern: {'VCP ' if stock.get('is_vcp') else ''}{'Pocket Pivot ' if stock.get('is_pocket_pivot') else ''}\n"
        "Explain why this is an opportunity and what to watch for. Be specific. No hype."
    )
    response = client.messages.create(model=MODEL, max_tokens=200,
                                       messages=[{"role": "user", "content": prompt}])
    return response.content[0].text.strip()


def build_recommendations(stocks: list[dict], use_claude: bool = True) -> list[dict]:
    """Build full recommendation objects for each stock."""
    recs = []
    for i, s in enumerate(stocks):
        print(f"  [{i+1}/{len(stocks)}] {s.get('ticker')} score={s.get('combined_score', 0)}", end=" ")
        if USE_CLAUDE and use_claude:
            try:
                rationale = generate_recommendation_claude(s)
                print("✓ Claude rationale")
            except Exception as e:
                rationale = template_rationale(s)
                print(f"⚠ fallback to rule-based ({e})")
        else:
            rationale = template_rationale(s)
            print("✓ rule-based")

        recs.append({
            "ticker": s.get("ticker"),
            "name": s.get("name", ""),
            "sector": s.get("sector", ""),
            "score": s.get("combined_score", 0),
            "signal": s.get("signal", ""),
            "grade": s.get("setup_quality", "—"),
            "price": s.get("price"),
            "rsi": s.get("rsi"),
            "momentum_3m": s.get("momentum_3m"),
            "eps_growth": s.get("eps_growth"),
            "news_sentiment": s.get("news_sentiment", ""),
            "is_vcp": s.get("is_vcp", False),
            "rationale": rationale,
            "rank": i + 1,
        })
    return recs


def push_recommendations(db, recs: list[dict]):
    today = date.today().isoformat()
    doc = {
        "date": today,
        "generated_at": datetime.utcnow().isoformat(),
        "count": len(recs),
        "recommendations": recs,
    }
    db.collection("opportunities").document("latest").set(doc)
    db.collection("opportunities").document(today).set(doc)
    print(f"  Pushed {len(recs)} recommendations to Firestore")


def main():
    parser = argparse.ArgumentParser(description="Sparks Finance — Recommendation Engine")
    parser.add_argument("--top", type=int, default=10, help="Number of top picks to recommend")
    parser.add_argument("--no-ai", action="store_true", help="Skip Claude AI rationale generation")
    parser.add_argument("--dry-run", action="store_true", help="Print without pushing to Firestore")
    args = parser.parse_args()

    print("Loading scan data…")
    stocks = load_scan_data()
    if not stocks:
        print("No stocks found. Run a scan first.")
        return

    print(f"  Loaded {len(stocks)} stocks")
    opportunities = filter_opportunities(stocks, top_n=args.top)
    print(f"  {len(opportunities)} opportunities identified")

    recs = build_recommendations(opportunities, use_claude=not args.no_ai)

    if args.dry_run:
        for r in recs:
            print(f"\n  [{r['rank']}] {r['ticker']} ({r['score']}/100) — {r['signal']}")
            print(f"      {r['rationale']}")
        return

    db = get_db()
    push_recommendations(db, recs)
    print("Done.")


if __name__ == "__main__":
    main()
