"""Insider Agent — Insider buying/selling transactions (Form 4)."""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
import finnhub_data as fd

def analyze(ticker: str) -> dict:
    score = 50  # neutral baseline
    signals = []
    raw = {}

    try:
        info = fd.get_info(ticker)

        insider_pct = info.get("heldPercentInsiders") or 0
        inst_pct = info.get("heldPercentInstitutions") or 0
        insider_transactions = fd.get_insider(ticker)

        raw = {
            "insider_pct": round(insider_pct * 100, 1),
            "institutional_pct": round(inst_pct * 100, 1),
            "recent_transactions": insider_transactions[:5],
        }

        # Score based on insider ownership
        if insider_pct >= 0.20:
            score += 20; signals.append(f"High insider ownership {insider_pct*100:.0f}% — skin in the game")
        elif insider_pct >= 0.05:
            score += 10; signals.append(f"Moderate insider ownership {insider_pct*100:.0f}%")

        # Institutional ownership
        if inst_pct >= 0.70:
            score += 15; signals.append(f"Heavy institutional ownership {inst_pct*100:.0f}% — smart money interest")
        elif inst_pct >= 0.40:
            score += 8; signals.append(f"Solid institutional ownership {inst_pct*100:.0f}%")

        # Recent transactions
        buys = [t for t in insider_transactions if t["type"] == "buy"]
        sells = [t for t in insider_transactions if t["type"] == "sell"]

        if buys:
            total_buy_val = sum(t["value"] for t in buys)
            score += min(20, len(buys) * 5); signals.append(f"{len(buys)} recent insider purchase(s) totalling ${total_buy_val:,.0f}")
        if sells and not buys:
            score -= min(15, len(sells) * 4); signals.append(f"{len(sells)} recent insider sale(s) — monitor")
        elif sells:
            signals.append(f"Mixed: {len(buys)} buys, {len(sells)} sells recently")

        if not insider_transactions:
            signals.append("No recent insider transactions data available")

    except Exception as e:
        signals.append(f"Insider data error: {e}")

    score = max(0, min(100, score))
    verdict = (
        "Strong insider conviction — purchases and high ownership" if score >= 75
        else "Neutral insider picture — no strong signals" if score >= 45
        else "Insider selling pressure — monitor closely"
    )
    return {"ticker": ticker, "score": score, "signals": signals[:5], "summary": verdict, "raw": raw}


if __name__ == "__main__":
    import sys, json
    result = analyze(sys.argv[1] if len(sys.argv) > 1 else "AAPL")
    print(json.dumps(result, indent=2))
