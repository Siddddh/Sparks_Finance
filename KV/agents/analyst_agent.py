"""Analyst Agent — Analyst ratings, price targets, upgrades/downgrades."""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
import finnhub_data as fd

def analyze(ticker: str) -> dict:
    score = 50
    signals = []
    raw = {}

    try:
        info = fd.get_info(ticker)

        rec_key = (info.get("recommendationKey") or "").lower()
        mean_rating = info.get("recommendationMean")  # 1=Strong Buy, 5=Sell
        num_analysts = info.get("numberOfAnalystOpinions") or 0
        target_mean = info.get("targetMeanPrice")
        target_high = info.get("targetHighPrice")
        target_low = info.get("targetLowPrice")
        price = info.get("currentPrice") or info.get("regularMarketPrice") or 0

        raw = {
            "recommendation": rec_key,
            "mean_rating": mean_rating,
            "num_analysts": num_analysts,
            "target_mean": target_mean,
            "target_high": target_high,
            "target_low": target_low,
            "current_price": price,
        }

        # Consensus rating score
        if mean_rating:
            if mean_rating <= 1.5:
                score += 35; signals.append(f"Strong Buy consensus ({num_analysts} analysts)")
            elif mean_rating <= 2.5:
                score += 25; signals.append(f"Buy consensus — rating {mean_rating:.1f}/5")
            elif mean_rating <= 3.0:
                score += 10; signals.append(f"Hold consensus — rating {mean_rating:.1f}/5")
            else:
                score -= 10; signals.append(f"Underperform/Sell rating {mean_rating:.1f}/5")
        elif rec_key in ("strong_buy", "buy"):
            score += 30; signals.append(f"Analyst consensus: {rec_key.replace('_',' ').title()}")
        elif rec_key == "hold":
            score += 5; signals.append("Analyst consensus: Hold")
        elif rec_key in ("sell", "underperform"):
            score -= 15; signals.append(f"Analyst consensus: {rec_key.title()} — caution")

        # Analyst coverage depth
        if num_analysts >= 20:
            score += 10; signals.append(f"High analyst coverage — {num_analysts} analysts")
        elif num_analysts >= 10:
            score += 5; signals.append(f"Good coverage — {num_analysts} analysts")
        elif num_analysts < 3:
            signals.append(f"Limited analyst coverage ({num_analysts})")

        # Price target upside
        if target_mean and price > 0:
            upside = (target_mean / price - 1) * 100
            if upside >= 30:
                score += 20; signals.append(f"Mean price target ${target_mean:.0f} — {upside:.0f}% upside")
            elif upside >= 15:
                score += 12; signals.append(f"Mean price target ${target_mean:.0f} — {upside:.0f}% upside")
            elif upside >= 5:
                score += 5; signals.append(f"Mean price target ${target_mean:.0f} — {upside:.0f}% upside")
            elif upside < 0:
                signals.append(f"Price target ${target_mean:.0f} implies {upside:.0f}% downside")

        # Target range
        if target_high and target_low and price > 0:
            bull_upside = (target_high / price - 1) * 100
            if bull_upside >= 50:
                score += 5; signals.append(f"Bull case target ${target_high:.0f} ({bull_upside:.0f}% upside)")

        # Recent upgrades/downgrades (Finnhub free has no equivalent — skipped)
        try:
            upgrades = None
            if upgrades is not None and not upgrades.empty:
                recent = upgrades.head(5)
                u_count = sum(1 for _, r in recent.iterrows() if str(r.get("Action","")).lower() in ("up","initiated","reiterated") and str(r.get("ToGrade","")).lower() in ("buy","strong buy","outperform","overweight"))
                d_count = sum(1 for _, r in recent.iterrows() if str(r.get("Action","")).lower() in ("down",) or str(r.get("ToGrade","")).lower() in ("sell","underperform","underweight"))
                if u_count > d_count:
                    score += 8; signals.append(f"{u_count} recent upgrades/initiations")
                elif d_count > u_count:
                    score -= 8; signals.append(f"{d_count} recent downgrades — caution")
        except Exception:
            pass

    except Exception as e:
        signals.append(f"Analyst data error: {e}")

    score = max(0, min(100, score))
    verdict = (
        "Strong analyst backing — consensus Buy with meaningful upside targets" if score >= 75
        else "Positive analyst sentiment with moderate upside" if score >= 55
        else "Neutral analyst view — mixed signals" if score >= 40
        else "Analyst caution — downgrades or sell ratings present"
    )
    return {"ticker": ticker, "score": score, "signals": signals[:5], "summary": verdict, "raw": raw}


if __name__ == "__main__":
    import sys, json
    result = analyze(sys.argv[1] if len(sys.argv) > 1 else "MSFT")
    print(json.dumps(result, indent=2))
