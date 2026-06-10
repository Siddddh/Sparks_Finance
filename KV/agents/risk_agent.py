"""Risk Agent — Debt, dilution, short interest, regulatory, earnings risk."""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
import finnhub_data as fd

def analyze(ticker: str) -> dict:
    score = 70  # start positive, subtract risk
    signals = []
    raw = {}
    risk_flags = []

    try:
        info = fd.get_info(ticker)

        short_pct = info.get("shortPercentOfFloat") or 0
        short_ratio = info.get("shortRatio") or 0  # days to cover
        dte = info.get("debtToEquity") or 0
        current_ratio = info.get("currentRatio") or 0
        beta = info.get("beta") or 1.0
        float_shares = info.get("floatShares") or 0
        shares_outstanding = info.get("sharesOutstanding") or 0
        eps_g = info.get("earningsGrowth") or 0
        rev_g = info.get("revenueGrowth") or 0
        margin = info.get("profitMargins") or 0
        sector = info.get("sector", "")

        raw = {
            "short_pct_float": round(short_pct * 100, 1),
            "days_to_cover": round(short_ratio, 1),
            "debt_to_equity": round(dte, 1),
            "current_ratio": round(current_ratio, 2),
            "beta": round(beta, 2),
            "sector": sector,
        }

        # Earnings risk
        if eps_g < 0 and rev_g < 0:
            score -= 25; risk_flags.append("Both revenue and earnings declining")
        elif eps_g < 0:
            score -= 15; risk_flags.append("EPS declining — watch for guidance cuts")
        elif rev_g < 0:
            score -= 10; risk_flags.append("Revenue contraction — demand weakness")

        # Margin risk
        if margin < 0:
            score -= 20; risk_flags.append("Operating at a loss — profitability concern")
        elif margin < 0.05:
            score -= 8; risk_flags.append(f"Very thin margins {margin*100:.1f}% — no cushion")

        # Debt risk
        if dte > 200:
            score -= 20; risk_flags.append(f"Very high debt/equity {dte:.0f}% — balance sheet risk")
        elif dte > 100:
            score -= 10; risk_flags.append(f"High leverage {dte:.0f}% — monitor refinancing")

        # Liquidity
        if current_ratio < 1.0 and current_ratio > 0:
            score -= 12; risk_flags.append(f"Current ratio {current_ratio:.2f} — near-term liquidity risk")

        # Short interest risk
        if short_pct >= 0.20:
            score -= 15; risk_flags.append(f"High short interest {short_pct*100:.0f}% — expect volatility")
        elif short_pct >= 0.10:
            score -= 5; risk_flags.append(f"Elevated short interest {short_pct*100:.0f}%")

        # Days to cover (squeeze risk, but also bearish signal)
        if short_ratio >= 10:
            score -= 8; risk_flags.append(f"High days-to-cover {short_ratio:.0f} — significant short pressure")

        # Beta (volatility risk)
        if beta >= 2.0:
            score -= 10; risk_flags.append(f"Beta {beta:.1f} — high volatility risk")
        elif beta >= 1.5:
            score -= 5; signals.append(f"Beta {beta:.1f} — above-market volatility")
        elif beta <= 0.5:
            signals.append(f"Low beta {beta:.1f} — defensive, lower market correlation")

        if not risk_flags:
            signals.append("No major risk flags — clean risk profile")
        else:
            signals.extend(risk_flags[:4])

        # Positive risk mitigants
        if current_ratio >= 2.0:
            score = min(score + 5, 100); signals.append("Strong liquidity buffer")
        if short_pct < 0.02:
            score = min(score + 5, 100); signals.append("Very low short interest — no meaningful bear thesis")

    except Exception as e:
        signals.append(f"Risk analysis error: {e}")

    score = max(0, min(100, score))
    verdict = (
        "Low-risk profile — strong fundamentals with manageable leverage and volatility" if score >= 75
        else "Moderate risk — some watchable factors but nothing alarming" if score >= 55
        else "Elevated risk — multiple warning signs require monitoring" if score >= 35
        else "High-risk situation — significant fundamental or financial concerns"
    )
    return {"ticker": ticker, "score": score, "signals": signals[:5], "summary": verdict, "raw": raw}


if __name__ == "__main__":
    import sys, json
    result = analyze(sys.argv[1] if len(sys.argv) > 1 else "AAPL")
    print(json.dumps(result, indent=2))
