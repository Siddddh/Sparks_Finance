"""Valuation Agent — P/E, P/S, PEG, EV/EBITDA, relative valuation."""
import yfinance as yf

# Sector-average benchmarks for relative valuation
SECTOR_PE = {
    "Technology": 28, "Healthcare": 22, "Consumer Cyclical": 20,
    "Communication Services": 22, "Financial Services": 14, "Industrials": 20,
    "Consumer Defensive": 18, "Energy": 12, "Real Estate": 30,
    "Basic Materials": 15, "Utilities": 17,
}

def analyze(ticker: str) -> dict:
    score = 50
    signals = []
    raw = {}

    try:
        t = yf.Ticker(ticker)
        info = t.info or {}

        fwd_pe = info.get("forwardPE")
        trail_pe = info.get("trailingPE")
        peg = info.get("pegRatio")
        ps = info.get("priceToSalesTrailing12Months")
        pb = info.get("priceToBook")
        ev_ebitda = info.get("enterpriseToEbitda")
        sector = info.get("sector", "Technology")
        eps_g = info.get("earningsGrowth") or 0

        raw = {
            "forward_pe": fwd_pe, "trailing_pe": trail_pe, "peg": peg,
            "price_to_sales": ps, "price_to_book": pb, "ev_ebitda": ev_ebitda,
            "sector": sector,
        }

        sector_avg_pe = SECTOR_PE.get(sector, 20)

        # Forward P/E
        if fwd_pe is not None:
            if fwd_pe < sector_avg_pe * 0.7:
                score += 25; signals.append(f"Fwd P/E {fwd_pe:.1f} — deep discount vs sector avg {sector_avg_pe}")
            elif fwd_pe < sector_avg_pe:
                score += 15; signals.append(f"Fwd P/E {fwd_pe:.1f} — below sector avg {sector_avg_pe}")
            elif fwd_pe < sector_avg_pe * 1.3:
                score += 5; signals.append(f"Fwd P/E {fwd_pe:.1f} — inline with sector")
            elif fwd_pe < sector_avg_pe * 2.0:
                signals.append(f"Fwd P/E {fwd_pe:.1f} — premium valuation, needs growth to justify")
            else:
                score -= 15; signals.append(f"Fwd P/E {fwd_pe:.1f} — very expensive vs sector avg {sector_avg_pe}")

        # PEG ratio (< 1 = undervalued relative to growth)
        if peg is not None and peg > 0:
            if peg < 0.75:
                score += 25; signals.append(f"PEG {peg:.2f} — very attractive growth-adjusted valuation")
            elif peg < 1.0:
                score += 18; signals.append(f"PEG {peg:.2f} — growing faster than its valuation implies")
            elif peg < 1.5:
                score += 8; signals.append(f"PEG {peg:.2f} — fair value")
            elif peg < 2.5:
                signals.append(f"PEG {peg:.2f} — slightly expensive on growth basis")
            else:
                score -= 10; signals.append(f"PEG {peg:.2f} — expensive for the growth rate")

        # Price/Sales
        if ps is not None:
            if ps < 2.0:
                score += 15; signals.append(f"P/S {ps:.1f} — low sales multiple")
            elif ps < 5.0:
                score += 8; signals.append(f"P/S {ps:.1f} — reasonable")
            elif ps > 15:
                score -= 10; signals.append(f"P/S {ps:.1f} — high revenue multiple")

        # EV/EBITDA
        if ev_ebitda is not None and ev_ebitda > 0:
            if ev_ebitda < 12:
                score += 15; signals.append(f"EV/EBITDA {ev_ebitda:.1f} — attractive enterprise value")
            elif ev_ebitda < 20:
                score += 8
            elif ev_ebitda > 40:
                score -= 8; signals.append(f"EV/EBITDA {ev_ebitda:.1f} — stretched")

    except Exception as e:
        signals.append(f"Valuation data error: {e}")

    score = max(0, min(100, score))
    verdict = (
        "Attractively valued — trading at discount to growth and sector peers" if score >= 75
        else "Reasonably valued — fair price for quality" if score >= 55
        else "Fairly valued — limited margin of safety" if score >= 40
        else "Expensive valuation — requires perfect execution to justify price"
    )
    return {"ticker": ticker, "score": score, "signals": signals[:5], "summary": verdict, "raw": raw}


if __name__ == "__main__":
    import sys, json
    result = analyze(sys.argv[1] if len(sys.argv) > 1 else "AAPL")
    print(json.dumps(result, indent=2))
