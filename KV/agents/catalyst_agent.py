"""
Catalyst Agent — Early catalyst detection (Req #14).

Scans news, yfinance data, and company info for upcoming catalysts:
FDA decisions, government contracts, patent activity, M&A, partnerships.
Pushes results to Firestore catalysts/{ticker}.
"""
import re
import sys
import json
import os as _os
from datetime import datetime, date

sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
import finnhub_data as fd

# Catalyst keyword patterns
CATALYST_PATTERNS = {
    "FDA / Regulatory": [
        r"FDA\s+approv", r"PDUFA", r"NDA\s+approv", r"BLA\s+approv",
        r"regulatory\s+approv", r"clinical\s+trial", r"phase\s+[123]",
        r"advisory\s+committee",
    ],
    "Government Contract": [
        r"government\s+contract", r"DoD\s+contract", r"Pentagon", r"defense\s+contract",
        r"federal\s+contract", r"military\s+contract", r"government\s+award",
        r"\$[\d\.]+[MB]?\s+contract",
    ],
    "M&A / Partnership": [
        r"acqui[sr]", r"merger", r"takeover", r"strategic\s+partner", r"joint\s+venture",
        r"collaboration\s+agreement", r"licensing\s+deal",
    ],
    "Product Launch": [
        r"new\s+product", r"product\s+launch", r"product\s+release", r"new\s+platform",
        r"launch[ed]?\s+its", r"debut[s]?",
    ],
    "Patent": [
        r"patent\s+approv", r"patent\s+granted", r"patent\s+filed",
        r"intellectual\s+property", r"IP\s+agreement",
    ],
    "Earnings / Guidance": [
        r"earnings\s+beat", r"beat\s+expectation", r"raise[d]?\s+guidance",
        r"upside\s+guidance", r"record\s+revenue", r"strong\s+quarter",
    ],
}

def scan_text_for_catalysts(text: str) -> list[tuple[str, str]]:
    """Return list of (catalyst_type, matched_snippet) found in text."""
    found = []
    if not text:
        return found
    text_lower = text.lower()
    for cat_type, patterns in CATALYST_PATTERNS.items():
        for pat in patterns:
            m = re.search(pat, text_lower)
            if m:
                start = max(0, m.start() - 30)
                end = min(len(text), m.end() + 50)
                found.append((cat_type, text[start:end].strip()))
                break
    return found

def analyze(ticker: str) -> dict:
    score = 50
    signals = []
    catalysts = []
    raw = {}

    try:
        info = fd.get_info(ticker)
        long_biz = info.get("longBusinessSummary", "")
        sector = info.get("sector", "")
        days_to_earnings = fd.get_next_earnings_days(ticker)

        # Upcoming earnings
        if days_to_earnings is not None:
            if 7 <= days_to_earnings <= 21:
                score += 15; catalysts.append({"type": "Earnings Catalyst", "description": f"Earnings report in {days_to_earnings} days — catalyst window", "event_date": ""})
            elif 21 < days_to_earnings <= 45:
                score += 5; catalysts.append({"type": "Upcoming Earnings", "description": f"Earnings in {days_to_earnings} days", "event_date": ""})

        # Scan business description for catalyst keywords
        biz_catalysts = scan_text_for_catalysts(long_biz)
        for cat_type, snippet in biz_catalysts[:3]:
            catalysts.append({"type": cat_type, "description": snippet, "event_date": ""})
            score += 8

        # Recent company news (Finnhub)
        try:
            for article in fd.get_company_news(ticker, days=14, max_items=12):
                text = (article.get("title", "") or "") + " " + (article.get("summary", "") or "")
                news_cats = scan_text_for_catalysts(text)
                for cat_type, snippet in news_cats[:2]:
                    catalysts.append({
                        "type": cat_type,
                        "description": article.get("title", snippet),
                        "event_date": str(date.today()),
                        "url": article.get("url", ""),
                    })
                    score += 10
        except Exception:
            pass

        # Sector-specific catalyst boosters
        healthcare_sectors = ["Healthcare", "Biotechnology", "Pharmaceuticals"]
        defense_sectors = ["Aerospace & Defense", "Industrials"]
        if any(s.lower() in sector.lower() for s in healthcare_sectors):
            score += 5; signals.append("Healthcare/Biotech — high catalyst frequency sector")
        if any(s.lower() in sector.lower() for s in defense_sectors):
            score += 5; signals.append("Defense/Aerospace — government contract activity sector")

        raw = {
            "sector": sector,
            "days_to_earnings": days_to_earnings,
            "catalysts_detected": len(catalysts),
        }

        if catalysts:
            signals.extend([c["type"] for c in catalysts[:4]])
        else:
            signals.append("No near-term catalysts detected")

    except Exception as e:
        signals.append(f"Catalyst scan error: {e}")

    score = max(0, min(100, score))
    verdict = (
        "High catalyst potential — multiple upcoming events could drive significant price movement" if score >= 70
        else "Moderate catalyst activity — some upcoming events worth monitoring" if score >= 50
        else "Low catalyst environment — no major near-term events detected"
    )

    return {
        "ticker": ticker,
        "score": score,
        "signals": signals[:5],
        "summary": verdict,
        "catalysts": catalysts[:10],
        "raw": raw,
    }


def push_catalysts(db, ticker: str, result: dict):
    """Push catalyst data to Firestore."""
    doc = {
        "ticker": ticker,
        "score": result["score"],
        "summary": result["summary"],
        "catalysts": result["catalysts"],
        "detected_at": datetime.utcnow().isoformat(),
    }
    # Push each catalyst as a separate document for the dashboard
    batch = db.batch()
    for i, cat in enumerate(result["catalysts"][:10]):
        ref = db.collection("catalysts").document(f"{ticker}_{i}")
        batch.set(ref, {
            "ticker": ticker,
            "type": cat.get("type", "Event"),
            "description": cat.get("description", ""),
            "event_date": cat.get("event_date", ""),
            "url": cat.get("url", ""),
            "detected_at": datetime.utcnow().isoformat(),
        })
    batch.commit()


if __name__ == "__main__":
    result = analyze(sys.argv[1] if len(sys.argv) > 1 else "NVDA")
    print(json.dumps({k: v for k, v in result.items() if k != "raw"}, indent=2))
