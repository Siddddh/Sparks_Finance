"""Fundamentals Agent — Revenue growth, EPS growth, margins, balance sheet."""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
import finnhub_data as fd

def analyze(ticker: str) -> dict:
    score = 0
    signals = []
    raw = {}

    try:
        info = fd.get_info(ticker)
        raw = {
            "eps_growth": info.get("earningsGrowth"),
            "rev_growth": info.get("revenueGrowth"),
            "profit_margin": info.get("profitMargins"),
            "gross_margin": info.get("grossMargins"),
            "debt_to_equity": info.get("debtToEquity"),
            "current_ratio": info.get("currentRatio"),
            "free_cashflow": info.get("freeCashflow"),
            "total_revenue": info.get("totalRevenue"),
            "earnings_quarterly_growth": info.get("earningsQuarterlyGrowth"),
        }

        eps_g = info.get("earningsGrowth") or info.get("earningsQuarterlyGrowth")
        rev_g = info.get("revenueGrowth")
        margin = info.get("profitMargins") or 0
        dte = info.get("debtToEquity") or 999
        cr = info.get("currentRatio") or 0
        fcf = info.get("freeCashflow") or 0

        # EPS growth
        if eps_g is not None:
            if eps_g >= 0.50:
                score += 30; signals.append(f"EPS growth {eps_g*100:.0f}% YoY — exceptional")
            elif eps_g >= 0.20:
                score += 22; signals.append(f"EPS growth {eps_g*100:.0f}% YoY — strong")
            elif eps_g >= 0.10:
                score += 14; signals.append(f"EPS growth {eps_g*100:.0f}% YoY — moderate")
            elif eps_g > 0:
                score += 6; signals.append(f"EPS growth {eps_g*100:.0f}% — positive but weak")
            else:
                signals.append(f"EPS declining {eps_g*100:.0f}% — red flag")

        # Revenue growth
        if rev_g is not None:
            if rev_g >= 0.30:
                score += 25; signals.append(f"Revenue growth {rev_g*100:.0f}% — high growth")
            elif rev_g >= 0.15:
                score += 18; signals.append(f"Revenue growth {rev_g*100:.0f}% — solid")
            elif rev_g >= 0.05:
                score += 10; signals.append(f"Revenue growth {rev_g*100:.0f}% — modest")
            elif rev_g > 0:
                score += 4; signals.append(f"Revenue growth {rev_g*100:.0f}% — very modest")
            else:
                signals.append(f"Revenue declining {rev_g*100:.0f}%")

        # Profit margin
        if margin >= 0.20:
            score += 20; signals.append(f"Strong profit margin {margin*100:.0f}%")
        elif margin >= 0.10:
            score += 12; signals.append(f"Healthy margin {margin*100:.0f}%")
        elif margin > 0:
            score += 5; signals.append(f"Thin margin {margin*100:.1f}%")

        # Balance sheet
        if dte < 30:
            score += 15; signals.append("Low debt-to-equity — fortress balance sheet")
        elif dte < 100:
            score += 8; signals.append(f"Moderate debt/equity {dte:.0f}%")
        else:
            signals.append(f"High debt/equity {dte:.0f}% — watch leverage")

        if cr >= 2.0:
            score += 10; signals.append(f"Current ratio {cr:.1f} — excellent liquidity")
        elif cr >= 1.2:
            score += 5; signals.append(f"Current ratio {cr:.1f} — adequate")

        if fcf and fcf > 0:
            score = min(score + 5, 100)
            signals.append(f"Positive free cash flow ${fcf/1e9:.1f}B")

    except Exception as e:
        signals.append(f"Data error: {e}")

    score = max(0, min(100, score))
    verdict = (
        "Exceptional fundamentals — high-growth, profitable, strong balance sheet" if score >= 80
        else "Strong fundamentals with solid growth trajectory" if score >= 60
        else "Mixed fundamentals — some positives, monitor closely" if score >= 40
        else "Weak fundamentals — revenue/earnings concerns"
    )

    return {"ticker": ticker, "score": score, "signals": signals[:5], "summary": verdict, "raw": raw}


if __name__ == "__main__":
    import sys, json
    result = analyze(sys.argv[1] if len(sys.argv) > 1 else "AAPL")
    print(json.dumps(result, indent=2))
