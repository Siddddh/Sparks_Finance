"""
health_monitor.py -- Portfolio Health Monitor (Req #13).

For each holding, evaluates whether the original investment thesis
remains valid by checking P&L, fundamentals, analyst consensus, and
technical structure. Rates each position: HOLD / WATCH / EXIT.

V1 MODE: USE_CLAUDE = False -- pure rule-based analysis, no API keys.
V2 MODE: Set USE_CLAUDE = True to upgrade to Claude-written narratives.

Usage:
    python health_monitor.py <uid>
    python health_monitor.py <uid> --dry-run
"""
import argparse
from datetime import datetime, date

import yfinance as yf

# ── V1/V2 toggle ───────────────────────────────────────────────────────────────
USE_CLAUDE = False   # Set True in V2

MODEL = "claude-sonnet-4-6"

try:
    import firebase_admin
    from firebase_admin import credentials, firestore
    FIREBASE_AVAILABLE = True
except ImportError:
    FIREBASE_AVAILABLE = False


def get_db():
    if not FIREBASE_AVAILABLE:
        raise RuntimeError("firebase-admin not installed.")
    if not firebase_admin._apps:
        cred = credentials.Certificate("firebase_service_account.json")
        firebase_admin.initialize_app(cred)
    return firestore.client()


def fetch_health_data(ticker: str, buy_price: float) -> dict:
    """Gather all health-relevant metrics for a holding."""
    try:
        t = yf.Ticker(ticker)
        info = t.info or {}
        cur_price = info.get("regularMarketPrice") or info.get("currentPrice") or buy_price
        pct_gain = (cur_price / buy_price - 1) * 100 if buy_price > 0 else 0
        ma50  = info.get("fiftyDayAverage") or 0
        ma200 = info.get("twoHundredDayAverage") or 0

        return {
            "ticker": ticker,
            "buy_price": buy_price,
            "current_price": cur_price,
            "pct_gain": round(pct_gain, 2),
            "ma50": round(ma50, 2),
            "ma200": round(ma200, 2),
            "eps_growth": info.get("earningsGrowth"),
            "rev_growth": info.get("revenueGrowth"),
            "profit_margin": info.get("profitMargins"),
            "debt_to_equity": info.get("debtToEquity"),
            "recommendation": info.get("recommendationKey", ""),
            "fwd_pe": info.get("forwardPE"),
            "short_pct": info.get("shortPercentOfFloat") or 0,
            "target_mean": info.get("targetMeanPrice"),
        }
    except Exception as e:
        return {"ticker": ticker, "buy_price": buy_price, "error": str(e)}


def rule_based_rating(data: dict) -> tuple:
    """Fast rule-based rating using weighted factors."""
    flags = []
    score = 0  # positive = healthy, negative = concerning

    pct = data.get("pct_gain", 0)
    eps_g = data.get("eps_growth") or 0
    rev_g = data.get("rev_growth") or 0
    rec   = (data.get("recommendation") or "").lower()
    cur   = data.get("current_price", 0)
    ma50  = data.get("ma50", 0)
    ma200 = data.get("ma200", 0)

    # Position P&L
    if pct >= 25:
        score += 2
        flags.append(f"Up {pct:.1f}% -- strong gain, thesis working well")
    elif pct >= 10:
        score += 1
        flags.append(f"Up {pct:.1f}% from entry -- healthy gain")
    elif pct <= -20:
        score -= 3
        flags.append(f"Down {abs(pct):.1f}% -- significant loss, thesis at risk")
    elif pct <= -10:
        score -= 1
        flags.append(f"Down {abs(pct):.1f}% from entry -- approaching stop territory")

    # Technical structure
    if ma50 > 0 and cur > 0:
        if cur > ma50 > ma200:
            score += 2
            flags.append(f"Stage 2 uptrend intact -- price ${cur:.2f} above MA50 ${ma50:.2f} and MA200 ${ma200:.2f}")
        elif cur > ma200:
            score += 1
            flags.append(f"Above MA200 ${ma200:.2f} -- long-term support holding")
        elif cur < ma200:
            score -= 2
            flags.append(f"Below MA200 ${ma200:.2f} -- long-term uptrend broken")

    # Fundamental health
    if eps_g >= 0.20:
        score += 1
        flags.append(f"EPS growth {eps_g*100:.0f}% YoY -- thesis fundamentals intact")
    elif eps_g < 0:
        score -= 2
        flags.append(f"EPS declining {eps_g*100:.0f}% -- original thesis weakening")

    if rev_g < 0:
        score -= 1
        flags.append(f"Revenue declining {rev_g*100:.0f}% -- demand concern")

    # Analyst consensus
    if rec in ("sell", "underperform", "strong_sell"):
        score -= 2
        flags.append(f"Analyst consensus turned {rec.replace('_', ' ').title()} -- institutional caution")
    elif rec in ("strong_buy", "buy"):
        score += 1

    # Verdict
    if score >= 2:
        rating = "HOLD"
    elif score >= 0:
        rating = "WATCH"
    else:
        rating = "EXIT"

    return rating, flags


def rule_based_analysis(data: dict, rating: str, flags: list) -> str:
    """
    Builds a specific, data-driven health analysis sentence.
    Uses real price levels computed from actual buy_price and current_price.
    No API required.
    """
    ticker     = data.get("ticker", "?")
    buy_price  = data.get("buy_price", 0)
    cur_price  = data.get("current_price", buy_price)
    pct_gain   = data.get("pct_gain", 0)
    eps_g      = data.get("eps_growth") or 0
    rec        = (data.get("recommendation") or "").lower()
    ma50       = data.get("ma50", 0)

    # Compute concrete price levels
    stop_8pct  = buy_price * 0.92           # standard 8% stop from entry
    stop_trail = cur_price * 0.88           # 12% trail from current (for winners)
    stop_level = max(stop_8pct, stop_trail) if pct_gain > 15 else stop_8pct
    exit_hard  = buy_price * 0.85           # 15% loss = full exit territory

    main_flag = flags[0] if flags else "No major signals"

    if rating == "HOLD":
        pos_flags = [f for f in flags if "intact" in f or "above" in f or "growth" in f or "Up " in f]
        positive = pos_flags[0] if pos_flags else "Technical structure remains healthy."
        analysis = (
            f"Original thesis intact -- {ticker} is {'+' if pct_gain >= 0 else ''}{pct_gain:.1f}% "
            f"from your entry at ${buy_price:.2f}. "
            f"{positive} "
            f"Hold with stop at ${stop_level:.2f}."
        )

    elif rating == "WATCH":
        # Choose the most specific metric to monitor
        if eps_g < 0:
            key_metric = "next earnings report for signs of stabilisation"
        elif rec in ("sell", "underperform"):
            key_metric = "analyst consensus for further downgrades"
        elif ma50 > 0 and cur_price < ma50:
            key_metric = f"price vs MA50 (${ma50:.2f}) -- a close above would be constructive"
        else:
            key_metric = "volume and price action for deterioration signals"

        analysis = (
            f"Thesis showing early stress -- {main_flag}. "
            f"{ticker} is {'+' if pct_gain >= 0 else ''}{pct_gain:.1f}% from entry. "
            f"Tighten stop to ${stop_8pct:.2f} and monitor {key_metric} closely."
        )

    else:  # EXIT
        analysis = (
            f"Original investment thesis has broken down -- {main_flag}. "
            f"{ticker} is down {abs(pct_gain):.1f}% from your entry at ${buy_price:.2f}. "
            f"Set hard exit trigger at ${exit_hard:.2f}. Consider selling into any bounce rather than waiting."
        )

    return analysis


def generate_health_analysis_claude(data: dict, rating: str, flags: list) -> str:
    """V2: Claude API analysis -- activated when USE_CLAUDE = True."""
    import anthropic
    client = anthropic.Anthropic()
    flags_str = "\n".join(f"- {f}" for f in flags) if flags else "- No major flags"
    target_str = f"${data.get('target_mean'):.2f}" if data.get("target_mean") else "N/A"
    prompt = (
        f"Portfolio health check for {data['ticker']}:\n"
        f"Entry: ${data.get('buy_price'):.2f}, Now: ${data.get('current_price', data.get('buy_price')):.2f} "
        f"({data.get('pct_gain', 0):+.1f}%)\n"
        f"EPS Growth: {(data.get('eps_growth') or 0)*100:.0f}% | Rev: {(data.get('rev_growth') or 0)*100:.0f}%\n"
        f"Analyst: {data.get('recommendation', 'N/A')} | Target: {target_str}\n"
        f"Key flags:\n{flags_str}\n"
        f"Rating: {rating}\n\n"
        "In 2 sentences: is the thesis still valid? What specific action should the investor take?"
    )
    try:
        response = client.messages.create(
            model=MODEL, max_tokens=150,
            messages=[{"role": "user", "content": prompt}]
        )
        return response.content[0].text.strip()
    except Exception:
        return rule_based_analysis(data, rating, flags)


def evaluate_portfolio(db, uid: str, dry_run: bool = False) -> list:
    """Evaluate all holdings across all portfolios for the user."""
    holdings_data = []

    pf_snap = db.collection("portfolios").document(uid).collection("list").stream()
    for pf_doc in pf_snap:
        pfid = pf_doc.id
        pfname = pf_doc.to_dict().get("name", pfid)
        hold_snap = db.collection("holdings").document(uid).collection(pfid).stream()

        for hold_doc in hold_snap:
            h = hold_doc.to_dict()
            ticker = (h.get("ticker") or "").upper()
            buy_price = float(h.get("buy_price") or 0)
            if not ticker or not buy_price:
                continue

            print(f"  Evaluating {ticker} ({pfname})...", end=" ", flush=True)
            data = fetch_health_data(ticker, buy_price)
            rating, flags = rule_based_rating(data)

            if USE_CLAUDE:
                analysis = generate_health_analysis_claude(data, rating, flags)
            else:
                analysis = rule_based_analysis(data, rating, flags)

            print(f"-> {rating}")

            holdings_data.append({
                "ticker": ticker,
                "portfolio": pfname,
                "buy_price": buy_price,
                "current_price": data.get("current_price", buy_price),
                "pct_gain": data.get("pct_gain", 0),
                "rating": rating,
                "flags": flags,
                "analysis": analysis,
            })

    return holdings_data


def push_health_report(db, uid: str, holdings: list):
    today = date.today().isoformat()
    doc = {
        "uid": uid,
        "generated_at": datetime.utcnow().isoformat(),
        "holdings": holdings,
        "summary": {
            "HOLD":  sum(1 for h in holdings if h["rating"] == "HOLD"),
            "WATCH": sum(1 for h in holdings if h["rating"] == "WATCH"),
            "EXIT":  sum(1 for h in holdings if h["rating"] == "EXIT"),
        },
    }
    db.collection("health_reports").document(uid).collection("reports").document(today).set(doc)
    print(f"  Health report pushed: {doc['summary']}")


def main():
    parser = argparse.ArgumentParser(description="Sparks Finance -- Portfolio Health Monitor")
    parser.add_argument("uid", help="Firebase user UID")
    parser.add_argument("--dry-run", action="store_true", help="Print without pushing to Firestore")
    args = parser.parse_args()

    db = get_db()
    mode_label = "Claude API" if USE_CLAUDE else "rule-based"
    print(f"Evaluating portfolio health for {args.uid} (mode: {mode_label})...")
    holdings = evaluate_portfolio(db, args.uid)

    if not holdings:
        print("No holdings found.")
        return

    if args.dry_run:
        for h in holdings:
            print(f"\n  {h['ticker']} [{h['rating']}] {h['pct_gain']:+.1f}%")
            print(f"    {h['analysis']}")
        return

    push_health_report(db, args.uid, holdings)
    print("Done.")


if __name__ == "__main__":
    main()
