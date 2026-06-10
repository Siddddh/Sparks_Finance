"""
Earnings Agent -- Earnings analysis + sentiment (Req #11).

Fetches earnings data via yfinance and scores using a multi-factor
rule-based system: beat streak, EPS/revenue growth, analyst consensus,
forward PE valuation. No API keys required in V1.

V1 MODE: USE_CLAUDE = False -- pure rule-based scoring.
V2 MODE: Set USE_CLAUDE = True to upgrade to Claude API analysis.

Usage:
    python agents/earnings_agent.py NVDA
"""
import sys
import json
import os as _os
_sys = sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
import finnhub_data as fd

# ── V1/V2 toggle ───────────────────────────────────────────────────────────────
USE_CLAUDE = False   # Set True in V2 to activate Claude API

MODEL = "claude-sonnet-4-6"


def fetch_earnings_context(ticker: str) -> dict:
    """Gather earnings data from Finnhub (via finnhub_data)."""
    try:
        info = fd.get_info(ticker)
        earnings_hist = fd.get_earnings_history(ticker)
        days = fd.get_next_earnings_days(ticker)
        return {
            "ticker": ticker,
            "company": info.get("longName", ticker),
            "sector": info.get("sector", ""),
            "eps_growth": info.get("earningsGrowth"),
            "rev_growth": info.get("revenueGrowth"),
            "forward_eps": info.get("forwardEps"),
            "trailing_eps": info.get("trailingEps"),
            "forward_pe": info.get("forwardPE"),
            "guidance": info.get("targetMeanPrice"),
            "analyst_count": info.get("numberOfAnalystOpinions"),
            "recommendation": info.get("recommendationKey"),
            "earnings_history": earnings_hist,
            "next_earnings": (f"in {days} days" if days is not None else ""),
        }
    except Exception as e:
        return {"ticker": ticker, "error": str(e)}


# ── V1: Rule-based earnings analysis ──────────────────────────────────────────

def rule_based_analysis(ctx: dict) -> dict:
    """
    Multi-factor earnings scoring system (0-100). No API required.

    Scoring table:
      Beat streak (4 qtrs)       +30  |  Miss streak             -10
      Beat streak (2-3 qtrs)     +20  |  Avg surprise > 15%      +20
      Avg surprise 5-15%         +12  |  Avg surprise < -5%      -15
      EPS growth >= 50%          +25  |  EPS growth 20-49%       +18
      EPS growth 1-19%           +8   |  EPS declining            -20
      Revenue growth >= 25%      +15  |  Revenue growth 10-24%    +8
      Revenue declining          -15  |  Analyst buy/strong_buy   +15
      Analyst sell/underperform  -15  |  Fwd PE < 25              +10
      Fwd PE > 50                -10

    Verdict: BULLISH >= 65 | NEUTRAL 35-64 | BEARISH < 35
    """
    score = 50
    signals = []
    ticker = ctx["ticker"]

    eps_g    = ctx.get("eps_growth") or 0
    rev_g    = ctx.get("rev_growth") or 0
    rec      = (ctx.get("recommendation") or "").lower()
    n_anal   = ctx.get("analyst_count") or 0
    fwd_pe   = ctx.get("forward_pe")
    history  = ctx.get("earnings_history", [])

    # Beat streak + average surprise
    beat_count = 0
    surprises  = []
    for e in history[-4:]:
        sp = e.get("surprise_pct")
        if sp is not None:
            surprises.append(float(sp))
            if sp > 0:
                beat_count += 1

    avg_surprise = sum(surprises) / len(surprises) if surprises else 0

    if beat_count == 4:
        score += 30
        signals.append("4-of-4 quarter beat streak -- consistent execution, high reliability")
    elif beat_count >= 2:
        score += 20
        signals.append(f"{beat_count}-of-4 quarters beat estimates -- generally outperforming")
    elif beat_count == 1 and len(surprises) >= 3:
        signals.append("Only 1-of-4 quarters beat -- inconsistent vs analyst estimates")
    elif len(surprises) >= 2 and beat_count == 0:
        score -= 10
        signals.append("Missing earnings estimates consistently -- execution concern")

    if avg_surprise > 15:
        score += 20
        signals.append(f"Avg EPS surprise +{avg_surprise:.1f}% -- significantly beating expectations")
    elif avg_surprise > 5:
        score += 12
        signals.append(f"Avg EPS surprise +{avg_surprise:.1f}% -- beating estimates")
    elif avg_surprise < -5:
        score -= 15
        signals.append(f"Avg EPS surprise {avg_surprise:.1f}% -- missing estimates by meaningful margin")

    # EPS growth
    if eps_g >= 0.50:
        score += 25
        signals.append(f"EPS growth {eps_g*100:.0f}% YoY -- exceptional, institutional-grade momentum")
    elif eps_g >= 0.20:
        score += 18
        signals.append(f"EPS growth {eps_g*100:.0f}% YoY -- strong, above 20% threshold")
    elif eps_g > 0:
        score += 8
        signals.append(f"EPS growth {eps_g*100:.0f}% YoY -- positive but below ideal 20% threshold")
    elif eps_g < 0:
        score -= 20
        signals.append(f"EPS declining {eps_g*100:.0f}% YoY -- fundamental red flag")

    # Revenue growth
    if rev_g >= 0.25:
        score += 15
        signals.append(f"Revenue growth {rev_g*100:.0f}% -- high-growth trajectory confirmed")
    elif rev_g >= 0.10:
        score += 8
        signals.append(f"Revenue growth {rev_g*100:.0f}% -- healthy expansion")
    elif rev_g < 0:
        score -= 15
        signals.append(f"Revenue declining {rev_g*100:.0f}% -- demand weakness, watch closely")

    # Analyst consensus
    if rec in ("strong_buy", "buy"):
        score += 15
        signals.append(f"Analyst consensus: {rec.replace('_', ' ').title()} ({n_anal} analysts)")
    elif rec in ("sell", "underperform", "strong_sell"):
        score -= 15
        signals.append(f"Analyst consensus: {rec.replace('_', ' ').title()} -- professional caution")
    elif rec == "hold" and n_anal > 5:
        signals.append(f"Analyst consensus: Hold ({n_anal} analysts) -- neutral institutional view")

    # Valuation
    if fwd_pe:
        if fwd_pe < 25:
            score += 10
            signals.append(f"Forward P/E {fwd_pe:.1f} -- reasonable valuation for a growth stock")
        elif fwd_pe > 50:
            score -= 10
            signals.append(f"Forward P/E {fwd_pe:.1f} -- rich valuation, requires flawless execution")

    score = max(0, min(100, score))

    # Verdict
    if score >= 65:
        verdict = "BULLISH"
    elif score >= 35:
        verdict = "NEUTRAL"
    else:
        verdict = "BEARISH"

    # Summary sentence built from real data
    beat_str = (f"{beat_count}-of-4 quarter beat streak, avg surprise {avg_surprise:+.1f}%"
                if surprises else "limited recent earnings history")
    summary = (
        f"{ticker} shows {beat_str}. "
        f"EPS {eps_g*100:+.0f}% YoY, revenue {rev_g*100:+.0f}% YoY. "
        f"Analyst consensus: {rec.replace('_', ' ') if rec else 'N/A'} ({n_anal} analysts). "
        f"Earnings verdict: {verdict}."
    )

    return {
        "ticker": ticker,
        "score": score,
        "signals": signals[:5],
        "summary": summary,
        "sentiment": verdict,
        "full_analysis": summary + "\n\nKey signals:\n" + "\n".join(f"  * {s}" for s in signals),
        "raw": ctx,
    }


# ── V2: Claude API analysis (activated when USE_CLAUDE = True) ────────────────

def analyze_with_claude(ctx: dict) -> dict:
    import anthropic
    client = anthropic.Anthropic()
    history_str = ""
    for e in ctx.get("earnings_history", []):
        sp = e.get("surprise_pct")
        sp_str = f" (beat {sp:.1f}%)" if sp and sp > 0 else f" (missed {abs(sp):.1f}%)" if sp else ""
        history_str += f"  {e.get('date','')}: EPS {e.get('eps_actual','N/A')}{sp_str}\n"
    prompt = (
        f"Analyze earnings for {ctx.get('company', ctx['ticker'])} ({ctx['ticker']}):\n"
        f"EPS growth: {ctx.get('eps_growth', 'N/A')}, Revenue: {ctx.get('rev_growth', 'N/A')}, "
        f"Fwd PE: {ctx.get('forward_pe', 'N/A')}, "
        f"Analyst: {ctx.get('recommendation', 'N/A')} ({ctx.get('analyst_count', '?')} analysts)\n"
        f"Earnings history:\n{history_str or 'N/A'}\n\n"
        "Reply with exactly:\n"
        "SUMMARY: [2-3 sentences]\n"
        "KEY POINT: [single most important finding]\n"
        "VERDICT: [BULLISH / NEUTRAL / BEARISH]"
    )
    response = client.messages.create(
        model=MODEL, max_tokens=400,
        messages=[{"role": "user", "content": prompt}]
    )
    raw = response.content[0].text
    summary, key_point, verdict = "", "", "NEUTRAL"
    for line in raw.splitlines():
        if line.startswith("SUMMARY:"):
            summary = line[8:].strip()
        elif line.startswith("KEY POINT:"):
            key_point = line[10:].strip()
        elif line.startswith("VERDICT:"):
            v = line[8:].strip().upper()
            verdict = "BULLISH" if "BULLISH" in v else "BEARISH" if "BEARISH" in v else "NEUTRAL"
    return {
        "ticker": ctx["ticker"],
        "score": 75 if verdict == "BULLISH" else 50 if verdict == "NEUTRAL" else 25,
        "signals": [key_point] if key_point else [],
        "summary": summary or raw[:200],
        "sentiment": verdict,
        "full_analysis": raw,
        "raw": ctx,
    }


# ── Entry point ────────────────────────────────────────────────────────────────

def analyze(ticker: str) -> dict:
    ctx = fetch_earnings_context(ticker)
    if "error" in ctx:
        return {
            "ticker": ticker, "score": 50,
            "signals": [ctx["error"]], "summary": "Data unavailable",
            "sentiment": "NEUTRAL", "raw": ctx,
        }
    if USE_CLAUDE:
        return analyze_with_claude(ctx)
    return rule_based_analysis(ctx)


if __name__ == "__main__":
    result = analyze(sys.argv[1] if len(sys.argv) > 1 else "NVDA")
    print(json.dumps({k: v for k, v in result.items() if k != "raw"}, indent=2))
