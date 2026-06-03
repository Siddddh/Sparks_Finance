"""
News Intelligence Engine for Stock Mission Control
- Fetches news via yfinance (aggregates Reuters, CNBC, MarketWatch, Bloomberg, Benzinga)
- Runs keyword-based sentiment + catalyst detection
- Produces a news_results.json file consumed by the dashboard
"""

import json, sys, re, warnings
warnings.filterwarnings("ignore")
import yfinance as yf
from datetime import datetime, timezone, timedelta

# ── Trusted outlets we surface (badge shown in dashboard) ──
TRUSTED_OUTLETS = {
    "reuters":        "Reuters",
    "cnbc":           "CNBC",
    "marketwatch":    "MarketWatch",
    "bloomberg":      "Bloomberg",
    "benzinga":       "Benzinga",
    "yahoofinance":   "Yahoo Finance",
    "barrons":        "Barron's",
    "wsj":            "WSJ",
    "seekingalpha":   "Seeking Alpha",
    "mt_newswires":   "MT Newswires",
    "motleyfool":     "Motley Fool",
    "investopedia":   "Investopedia",
}

# ── Sentiment keyword banks ──
STRONG_POSITIVE = [
    "earnings beat", "beats estimates", "beat expectations", "record revenue",
    "record earnings", "raises guidance", "raised guidance", "guidance raised",
    "analyst upgrade", "upgraded to buy", "price target raised", "target raised",
    "strong demand", "blowout quarter", "massive growth", "surged", "rallied",
    "breakout", "all-time high", "new high", "buyback", "dividend hike",
    "major contract", "strategic partnership", "market share gain",
]
MILD_POSITIVE = [
    "beat", "exceeded", "outperform", "buy rating", "positive", "growth",
    "higher", "gain", "upside", "strong", "expanding", "demand", "optimistic",
    "robust", "momentum", "opportunity", "partnership", "deal", "wins",
]
MILD_NEGATIVE = [
    "miss", "missed", "concern", "slowdown", "uncertainty", "caution",
    "downside", "headwind", "competition", "pressure", "decline", "lower",
    "weaker", "soft", "disappointing",
]
STRONG_NEGATIVE = [
    "earnings miss", "missed estimates", "misses expectations", "cut guidance",
    "guidance cut", "guidance lowered", "analyst downgrade", "downgraded to sell",
    "price target cut", "target lowered", "layoffs", "investigation", "lawsuit",
    "recall", "fraud", "bankruptcy", "selloff", "crashed", "plunged",
    "regulatory action", "subpoena", "patent loss",
]
BREAKOUT_CATALYSTS = [
    "earnings beat", "guidance raised", "analyst upgrade", "buyback",
    "fda approval", "contract win", "strategic deal", "major partnership",
    "record revenue", "accelerating growth", "short squeeze", "price target raised",
]

# ── How recent counts as "breaking" ──
BREAKING_HOURS = 4       # within last 4 hours
FRESH_HOURS    = 24      # within last 24 hours

def classify_outlet(source_id: str, display_name: str) -> str:
    combined = (source_id + display_name).lower()
    for key, label in TRUSTED_OUTLETS.items():
        if key in combined:
            return label
    return display_name or "Other"

def sentiment_score(text: str) -> tuple[int, list[str], str]:
    """Returns (score, triggered_keywords, sentiment_label)."""
    t = text.lower()
    score = 0
    triggers = []
    for kw in STRONG_POSITIVE:
        if kw in t: score += 3; triggers.append(kw)
    for kw in MILD_POSITIVE:
        if kw in t and kw not in str(triggers): score += 1; triggers.append(kw)
    for kw in MILD_NEGATIVE:
        if kw in t and kw not in str(triggers): score -= 1; triggers.append(kw)
    for kw in STRONG_NEGATIVE:
        if kw in t: score -= 3; triggers.append(kw)
    score = max(-10, min(10, score))
    label = ("BULLISH" if score >= 3 else
             "SLIGHTLY BULLISH" if score >= 1 else
             "SLIGHTLY BEARISH" if score <= -1 else
             "BEARISH" if score <= -3 else "NEUTRAL")
    return score, triggers[:5], label

def is_catalyst(text: str) -> bool:
    t = text.lower()
    return any(kw in t for kw in BREAKOUT_CATALYSTS)

def hours_ago(pub_date_str: str) -> float:
    try:
        # handle both "2026-05-04T15:08:05Z" and epoch int
        if isinstance(pub_date_str, (int, float)):
            pub = datetime.fromtimestamp(pub_date_str, tz=timezone.utc)
        else:
            pub = datetime.fromisoformat(pub_date_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        return (now - pub).total_seconds() / 3600
    except:
        return 999

def fetch_ticker_news(ticker: str, max_items: int = 8) -> list[dict]:
    try:
        tk = yf.Ticker(ticker)
        raw = tk.news or []
    except:
        return []

    articles = []
    for item in raw[:max_items]:
        c = item.get("content", {})
        title   = c.get("title", "")
        summary = c.get("summary", "")
        text    = f"{title} {summary}"
        pub_str = c.get("pubDate", "")
        age_h   = hours_ago(pub_str)

        if age_h > FRESH_HOURS * 3:   # skip anything older than 3 days
            continue

        provider_id   = c.get("provider", {}).get("sourceId", "")
        provider_name = c.get("provider", {}).get("displayName", "")
        outlet        = classify_outlet(provider_id, provider_name)
        url           = (c.get("clickThroughUrl") or {}).get("url", "") or \
                        (c.get("canonicalUrl") or {}).get("url", "")

        sent_score, triggers, sent_label = sentiment_score(text)
        catalyst = is_catalyst(text)
        breaking = age_h <= BREAKING_HOURS

        articles.append({
            "title":     title,
            "summary":   summary[:200] + ("…" if len(summary) > 200 else ""),
            "outlet":    outlet,
            "url":       url,
            "pub_date":  pub_str,
            "age_hours": round(age_h, 1),
            "breaking":  breaking,
            "sentiment_score":  sent_score,
            "sentiment_label":  sent_label,
            "is_catalyst":      catalyst,
            "trigger_keywords": triggers,
        })

    articles.sort(key=lambda x: (x["is_catalyst"], -x["sentiment_score"], -x["age_hours"]))
    return articles

def fetch_market_news() -> list[dict]:
    """General S&P 500 / macro news using SPY and QQQ as proxies."""
    articles = []
    seen = set()
    for proxy in ["SPY", "QQQ", "VIX"]:
        for art in fetch_ticker_news(proxy, max_items=5):
            if art["title"] not in seen:
                seen.add(art["title"])
                articles.append(art)
    articles.sort(key=lambda x: x["age_hours"])
    return articles[:8]

def compute_news_addon(articles: list[dict]) -> dict:
    """Aggregate news signals for a single ticker → score addon + top headlines."""
    if not articles:
        return {"news_score_addon": 0, "news_sentiment": "NEUTRAL",
                "has_catalyst": False, "has_breaking": False, "top_news": []}

    # Weighted: breaking news counts double
    total = sum((2 if a["breaking"] else 1) * a["sentiment_score"] for a in articles)
    count = sum(2 if a["breaking"] else 1 for a in articles)
    avg   = total / count if count else 0

    # Score addon: –10 to +10 → map to –15 to +15 pts in final score
    addon = round(avg * 1.5, 1)
    addon = max(-15, min(15, addon))

    has_catalyst = any(a["is_catalyst"] for a in articles)
    has_breaking = any(a["breaking"] for a in articles)

    # Overall sentiment label
    label = ("BULLISH" if avg >= 2 else "SLIGHTLY BULLISH" if avg >= 0.5 else
             "BEARISH" if avg <= -2 else "SLIGHTLY BEARISH" if avg <= -0.5 else "NEUTRAL")

    top = [{"title": a["title"], "outlet": a["outlet"], "url": a["url"],
            "sentiment": a["sentiment_label"], "breaking": a["breaking"],
            "catalyst": a["is_catalyst"], "age_hours": a["age_hours"]}
           for a in articles[:4]]

    return {"news_score_addon": addon, "news_sentiment": label,
            "has_catalyst": has_catalyst, "has_breaking": has_breaking,
            "top_news": top}

def run_news_scan(tickers: list[str]) -> dict:
    print(f"Fetching news for {len(tickers)} tickers…", file=sys.stderr)
    results = {}
    for t in tickers:
        print(f"  {t}", file=sys.stderr)
        arts   = fetch_ticker_news(t)
        results[t] = compute_news_addon(arts)
    market = fetch_market_news()
    return {
        "fetched_at":  datetime.now().strftime("%Y-%m-%d %H:%M ET"),
        "ticker_news": results,
        "market_news": market,
    }

if __name__ == "__main__":
    import sys
    tickers = sys.argv[1:] or ["AMD","CAT","NVDA","AVGO","LRCX","AMAT","KLAC","AAPL","MSFT","PANW"]
    data = run_news_scan(tickers)
    import glob as _g; _bases=_g.glob("/sessions/*/mnt/KV"); out = (_bases[0] if _bases else "/tmp") + "/news_results.json"
    with open(out, "w") as f:
        json.dump(data, f, indent=2)
    print(json.dumps(data, indent=2))
