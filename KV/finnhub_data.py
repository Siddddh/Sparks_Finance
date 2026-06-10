"""
finnhub_data.py — shared, throttled Finnhub client for the agents + news engine.

Why this exists: hammering Yahoo (yfinance .info) with 8 concurrent requests per
ticker triggers "Too Many Requests" / "Invalid Crumb" errors. Finnhub is an official,
keyed API with a clear 60-calls/min free limit, so it's reliable. This module:
  • loads the key (env FINNHUB_API_KEY, or a local finnhub_key.txt),
  • throttles to stay under the rate limit,
  • caches every response for the life of the process (so all 8 agents share ONE
    fetch per ticker instead of each re-downloading),
  • maps Finnhub fields onto the SAME keys yfinance's .info uses, so the agents'
    scoring logic barely changes.

If no key is configured, get_info() falls back to a single shared yfinance .info
fetch (still better than the old 8×-per-ticker pattern).

Free-tier note: Finnhub free does NOT provide short interest, insider/institutional
ownership %, analyst price targets, PEG, or forward P/E. Those map to None and the
agents simply skip those signals (no errors). Forward P/E is proxied by trailing P/E.
"""
import os
import time
import threading
import json
from datetime import datetime, date, timedelta, timezone

try:
    from urllib.request import urlopen, Request
    from urllib.parse import urlencode
except Exception:  # pragma: no cover
    urlopen = None

_BASE = "https://finnhub.io/api/v1"
_MIN_INTERVAL = 1.05          # seconds between calls (~57/min, under the 60 free limit)
_lock = threading.Lock()
_last_call = [0.0]
_CACHE = {}                   # path+params -> json (per-process)
_KEY = None
_KEY_LOADED = False


def _load_key():
    global _KEY, _KEY_LOADED
    if _KEY_LOADED:
        return _KEY
    _KEY_LOADED = True
    k = os.environ.get("FINNHUB_API_KEY")
    if not k:
        # local file fallback (gitignored): KV/finnhub_key.txt
        try:
            p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "finnhub_key.txt")
            if os.path.exists(p):
                with open(p) as f:
                    k = f.read().strip()
        except Exception:
            k = None
    _KEY = k or None
    return _KEY


def has_key():
    return _load_key() is not None


def _get(path, params=None):
    """Throttled, cached GET against Finnhub. Returns parsed JSON or None."""
    key = _load_key()
    if not key:
        return None
    params = dict(params or {})
    params["token"] = key
    cache_key = path + "?" + urlencode(sorted((k, v) for k, v in params.items() if k != "token"))
    if cache_key in _CACHE:
        return _CACHE[cache_key]

    url = _BASE + path + "?" + urlencode(params)
    data = None
    for attempt in range(2):
        with _lock:                       # serialize + throttle across threads
            wait = _MIN_INTERVAL - (time.time() - _last_call[0])
            if wait > 0:
                time.sleep(wait)
            _last_call[0] = time.time()
        try:
            req = Request(url, headers={"User-Agent": "sparks-finance/1.0"})
            with urlopen(req, timeout=12) as r:
                data = json.loads(r.read().decode("utf-8"))
            break
        except Exception as e:
            msg = str(e)
            if "429" in msg and attempt == 0:
                time.sleep(2.0)           # rate limited — back off once
                continue
            data = None
            break
    _CACHE[cache_key] = data
    return data


# ── numeric helpers ──────────────────────────────────────────────────────────

def _num(v):
    try:
        if v is None:
            return None
        f = float(v)
        if f != f:        # NaN
            return None
        return f
    except (TypeError, ValueError):
        return None


def _pct_to_frac(v):
    """Finnhub reports growth/margins as percents (25.3); yfinance uses fractions (0.253)."""
    n = _num(v)
    return n / 100.0 if n is not None else None


# Map Finnhub finnhubIndustry -> the GICS-ish sector names valuation_agent expects.
_INDUSTRY_TO_SECTOR = {
    "Semiconductors": "Technology", "Technology": "Technology", "Software": "Technology",
    "Hardware": "Technology", "Electronic Equipment": "Technology",
    "Communications": "Communication Services", "Media": "Communication Services",
    "Telecommunication": "Communication Services",
    "Pharmaceuticals": "Healthcare", "Biotechnology": "Healthcare", "Health Care": "Healthcare",
    "Banking": "Financial Services", "Financial Services": "Financial Services",
    "Insurance": "Financial Services",
    "Retail": "Consumer Cyclical", "Automobiles": "Consumer Cyclical",
    "Consumer products": "Consumer Defensive", "Food Products": "Consumer Defensive",
    "Beverages": "Consumer Defensive",
    "Energy": "Energy", "Oil & Gas": "Energy",
    "Industrial Conglomerates": "Industrials", "Machinery": "Industrials",
    "Aerospace & Defense": "Industrials",
    "Real Estate": "Real Estate", "Utilities": "Utilities",
}


# ── public API (yfinance-shaped) ───────────────────────────────────────────────

def get_info(ticker):
    """Return a dict using yfinance .info key names, sourced from Finnhub.

    Falls back to a single shared yfinance .info fetch if no Finnhub key is set.
    """
    ck = "info:" + ticker
    if ck in _CACHE:
        return _CACHE[ck]

    if not has_key():
        info = _yahoo_info(ticker)
        _CACHE[ck] = info
        return info

    metric = (_get("/stock/metric", {"symbol": ticker, "metric": "all"}) or {}).get("metric", {}) or {}
    profile = _get("/stock/profile2", {"symbol": ticker}) or {}
    quote = _get("/quote", {"symbol": ticker}) or {}
    recos = _get("/stock/recommendation", {"symbol": ticker}) or []

    # Analyst consensus from the latest recommendation period.
    mean_rating = num_analysts = rec_key = None
    if isinstance(recos, list) and recos:
        r0 = recos[0]
        sb = _num(r0.get("strongBuy")) or 0
        b = _num(r0.get("buy")) or 0
        h = _num(r0.get("hold")) or 0
        s = _num(r0.get("sell")) or 0
        ss = _num(r0.get("strongSell")) or 0
        total = sb + b + h + s + ss
        if total > 0:
            mean_rating = (1 * sb + 2 * b + 3 * h + 4 * s + 5 * ss) / total
            num_analysts = int(total)
            rec_key = ("strong_buy" if mean_rating <= 1.5 else "buy" if mean_rating <= 2.5
                       else "hold" if mean_rating <= 3.5 else "sell")

    pe = _num(metric.get("peTTM")) or _num(metric.get("peExclExtraTTM")) or _num(metric.get("peNormalizedAnnual"))
    industry = profile.get("finnhubIndustry", "")
    sector = _INDUSTRY_TO_SECTOR.get(industry, industry or "Technology")

    info = {
        # growth / margins (fractions, like yfinance)
        "earningsGrowth": _pct_to_frac(metric.get("epsGrowthTTMYoy")) or _pct_to_frac(metric.get("epsGrowthQuarterlyYoy")),
        "earningsQuarterlyGrowth": _pct_to_frac(metric.get("epsGrowthQuarterlyYoy")),
        "revenueGrowth": _pct_to_frac(metric.get("revenueGrowthTTMYoy")) or _pct_to_frac(metric.get("revenueGrowthQuarterlyYoy")),
        "profitMargins": _pct_to_frac(metric.get("netProfitMarginTTM")),
        "grossMargins": _pct_to_frac(metric.get("grossMarginTTM")),
        # balance sheet
        "debtToEquity": (lambda r: r * 100 if r is not None else None)(
            _num(metric.get("totalDebt/totalEquityQuarterly")) or _num(metric.get("totalDebt/totalEquityAnnual"))
            or _num(metric.get("longTermDebt/equityQuarterly"))),
        "currentRatio": _num(metric.get("currentRatioQuarterly")) or _num(metric.get("currentRatioAnnual")),
        "freeCashflow": None,
        "totalRevenue": None,
        # valuation (forward P/E proxied by trailing — Finnhub free has no forward P/E)
        "forwardPE": pe,
        "trailingPE": pe,
        "pegRatio": _num(metric.get("pegTTM")) or _num(metric.get("peg")),
        "priceToSalesTrailing12Months": _num(metric.get("psTTM")),
        "priceToBook": _num(metric.get("pbQuarterly")) or _num(metric.get("pb")) or _num(metric.get("pbAnnual")),
        "enterpriseToEbitda": _num(metric.get("currentEv/ebitdaTTM")) or _num(metric.get("currentEv/ebitda")),
        "trailingEps": _num(metric.get("epsTTM")),
        "forwardEps": None,
        "beta": _num(metric.get("beta")) or 1.0,
        # analyst
        "recommendationMean": mean_rating,
        "recommendationKey": rec_key,
        "numberOfAnalystOpinions": num_analysts,
        "targetMeanPrice": None, "targetHighPrice": None, "targetLowPrice": None,
        # price / identity
        "currentPrice": _num(quote.get("c")),
        "regularMarketPrice": _num(quote.get("c")),
        "longName": profile.get("name", ticker),
        "sector": sector,
        "longBusinessSummary": "",
        # not on Finnhub free → leave neutral so agents skip those signals
        "shortPercentOfFloat": None, "shortRatio": None,
        "floatShares": None, "sharesOutstanding": _num(profile.get("shareOutstanding")),
        "heldPercentInsiders": None, "heldPercentInstitutions": None,
    }
    _CACHE[ck] = info
    return info


def get_earnings_history(ticker):
    """Last ~4 quarters as [{date, eps_estimate, eps_actual, surprise_pct}]."""
    rows = _get("/stock/earnings", {"symbol": ticker, "limit": 4})
    out = []
    if isinstance(rows, list):
        for e in rows[:4]:
            out.append({
                "date": e.get("period", ""),
                "eps_estimate": _num(e.get("estimate")),
                "eps_actual": _num(e.get("actual")),
                "surprise_pct": _num(e.get("surprisePercent")),
            })
        out.reverse()   # oldest → newest (agents read history[-4:])
    return out


def get_next_earnings_days(ticker):
    """Days until the next scheduled earnings, or None."""
    today = date.today()
    to = today + timedelta(days=90)
    data = _get("/calendar/earnings", {"symbol": ticker, "from": today.isoformat(), "to": to.isoformat()})
    cal = (data or {}).get("earningsCalendar", []) if isinstance(data, dict) else []
    best = None
    for e in cal:
        ds = e.get("date")
        if not ds:
            continue
        try:
            d = datetime.strptime(ds, "%Y-%m-%d").date()
        except Exception:
            continue
        delta = (d - today).days
        if delta >= 0 and (best is None or delta < best):
            best = delta
    return best


def get_insider(ticker):
    """Recent insider transactions as [{date, insider, shares, value, type}]."""
    today = date.today()
    frm = today - timedelta(days=120)
    data = _get("/stock/insider-transactions", {"symbol": ticker, "from": frm.isoformat(), "to": today.isoformat()})
    rows = (data or {}).get("data", []) if isinstance(data, dict) else []
    out = []
    for r in rows[:15]:
        code = (r.get("transactionCode") or "").upper()
        shares = _num(r.get("share")) or 0
        price = _num(r.get("transactionPrice")) or 0
        typ = "buy" if code in ("P", "A") else "sell" if code in ("S", "D", "F") else "other"
        out.append({
            "date": r.get("transactionDate", "") or r.get("filingDate", ""),
            "insider": r.get("name", ""),
            "shares": int(shares),
            "value": float(shares * price),
            "type": typ,
        })
    return out


def _news_to_articles(rows, max_items):
    out = []
    for a in (rows or [])[:max_items]:
        ts = a.get("datetime")
        try:
            iso = datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat() if ts else ""
        except Exception:
            iso = ""
        out.append({
            "title": a.get("headline", ""),
            "summary": a.get("summary", "") or "",
            "source": a.get("source", ""),
            "url": a.get("url", ""),
            "pub_epoch": int(ts) if ts else 0,
            "pub_date": iso,
        })
    return out


def get_company_news(ticker, days=14, max_items=12):
    today = date.today()
    frm = today - timedelta(days=days)
    rows = _get("/company-news", {"symbol": ticker, "from": frm.isoformat(), "to": today.isoformat()})
    return _news_to_articles(rows, max_items)


def get_general_news(max_items=30):
    rows = _get("/news", {"category": "general"})
    return _news_to_articles(rows, max_items)


# ── yfinance fallback (only used when no Finnhub key) ──────────────────────────

def _yahoo_info(ticker):
    try:
        import yfinance as yf
        return yf.Ticker(ticker).info or {}
    except Exception:
        return {}
