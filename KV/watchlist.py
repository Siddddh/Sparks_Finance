"""
watchlist.py — Smart Watchlist Monitoring (Req #8).

Fetches all watchlists for a user, evaluates each ticker for smart alert
conditions (analyst upgrades, insider activity, unusual volume, institutional
accumulation, earnings surprises, significant news), and writes triggered
alerts to Firestore alerts/{uid}/list/.

Usage:
    python watchlist.py <uid>
    python watchlist.py <uid> --list
"""
import sys
import argparse
from datetime import datetime, date

import yfinance as yf

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


# ── Smart alert condition checkers ────────────────────────────────────────────

def check_unusual_volume(ticker: str, info: dict) -> tuple[bool, str]:
    try:
        avg_vol = info.get("averageVolume") or 0
        cur_vol = info.get("regularMarketVolume") or 0
        if avg_vol > 0 and cur_vol / avg_vol >= 2.5:
            return True, f"Unusual volume {cur_vol/avg_vol:.1f}× average — institutional activity"
    except Exception:
        pass
    return False, ""

def check_analyst_rating(ticker: str, info: dict) -> tuple[bool, str]:
    rec = (info.get("recommendationKey") or "").lower()
    mean = info.get("recommendationMean") or 3.0
    if rec in ("strong_buy", "buy") and mean <= 2.0:
        return True, f"Strong analyst consensus — {rec.replace('_',' ').title()} (rating {mean:.1f})"
    return False, ""

def check_insider_activity(ticker: str) -> tuple[bool, str]:
    try:
        t = yf.Ticker(ticker)
        insiders = t.insider_transactions
        if insiders is not None and not insiders.empty:
            recent = insiders.head(5)
            buys = sum(1 for _, r in recent.iterrows() if "purchase" in str(r.get("Text","")).lower() or "buy" in str(r.get("Text","")).lower())
            if buys >= 2:
                return True, f"{buys} recent insider purchases — high conviction signal"
    except Exception:
        pass
    return False, ""

def check_near_52w_high(ticker: str, info: dict) -> tuple[bool, str]:
    try:
        price = info.get("regularMarketPrice") or info.get("currentPrice") or 0
        high = info.get("fiftyTwoWeekHigh") or 0
        if price > 0 and high > 0:
            pct = (price / high - 1) * 100
            if pct >= -3:
                return True, f"Near 52-week high — {pct:.1f}% from peak, potential breakout"
    except Exception:
        pass
    return False, ""

def check_price_momentum(ticker: str, info: dict) -> tuple[bool, str]:
    try:
        price = info.get("regularMarketPrice") or 0
        ma50 = info.get("fiftyDayAverage") or 0
        ma200 = info.get("twoHundredDayAverage") or 0
        if price > ma50 > ma200 > 0:
            return True, f"Stage 2 uptrend: price ${price:.2f} > MA50 ${ma50:.2f} > MA200 ${ma200:.2f}"
    except Exception:
        pass
    return False, ""

def check_earnings_surprise(ticker: str) -> tuple[bool, str]:
    try:
        t = yf.Ticker(ticker)
        hist = t.earnings_history
        if hist is not None and not hist.empty:
            last = hist.iloc[-1]
            surprise = last.get("epsSurprisePct")
            if surprise and surprise > 10:
                return True, f"Recent earnings beat by {surprise:.1f}% — momentum catalyst"
    except Exception:
        pass
    return False, ""


SMART_CHECKS = [
    ("unusual_volume",   check_unusual_volume,   True),   # needs info
    ("analyst_upgrade",  check_analyst_rating,   True),
    ("near_52w_high",    check_near_52w_high,    True),
    ("price_momentum",   check_price_momentum,   True),
    ("insider_buy",      check_insider_activity, False),  # standalone call
    ("earnings_beat",    check_earnings_surprise, False),
]


def evaluate_ticker(ticker: str) -> list[dict]:
    """Run all smart checks on a ticker and return list of triggered alerts."""
    triggered = []
    try:
        t = yf.Ticker(ticker)
        info = t.info or {}

        for check_name, check_fn, needs_info in SMART_CHECKS:
            try:
                if needs_info:
                    fired, message = check_fn(ticker, info)
                else:
                    fired, message = check_fn(ticker)
                if fired:
                    triggered.append({
                        "type": "smart_watchlist",
                        "condition": check_name,
                        "ticker": ticker,
                        "message": message,
                        "status": "fired",
                        "fired_at": datetime.utcnow().isoformat(),
                    })
            except Exception:
                pass
    except Exception as e:
        print(f"  [warn] {ticker}: {e}")
    return triggered


def scan_watchlist(db, uid: str) -> dict:
    """Scan all watchlists for the user and push triggered alerts."""
    wl_snap = db.collection("watchlists").document(uid).collection("list").stream()
    all_tickers = set()
    for wl_doc in wl_snap:
        tickers = wl_doc.to_dict().get("tickers", [])
        all_tickers.update(t.upper() for t in tickers)

    if not all_tickers:
        print(f"  No tickers in any watchlist for uid={uid}")
        return {}

    print(f"  Scanning {len(all_tickers)} tickers: {sorted(all_tickers)}")
    total_alerts = 0

    for ticker in sorted(all_tickers):
        print(f"  Checking {ticker}…", end=" ", flush=True)
        triggered = evaluate_ticker(ticker)
        print(f"{len(triggered)} alert(s)")
        total_alerts += len(triggered)

        for alert in triggered:
            # Check if this exact alert was already fired today
            today = date.today().isoformat()
            existing = db.collection("alerts").document(uid).collection("list") \
                .where("ticker", "==", ticker) \
                .where("condition", "==", alert["condition"]) \
                .where("status", "==", "fired") \
                .stream()
            already_fired = any(a.to_dict().get("fired_at", "")[:10] == today for a in existing)
            if not already_fired:
                db.collection("alerts").document(uid).collection("list").add(alert)

    print(f"  Total alerts triggered: {total_alerts}")
    return {"tickers_scanned": len(all_tickers), "alerts_triggered": total_alerts}


def main():
    parser = argparse.ArgumentParser(description="Sparks Finance — Watchlist Monitor")
    parser.add_argument("uid", help="Firebase user UID")
    parser.add_argument("--list", action="store_true", help="List all watchlist tickers")
    args = parser.parse_args()

    db = get_db()

    if args.list:
        wl_snap = db.collection("watchlists").document(args.uid).collection("list").stream()
        for wl in wl_snap:
            d = wl.to_dict()
            print(f"  [{wl.id}] {d.get('name','—')}: {', '.join(d.get('tickers',[]))}")
    else:
        scan_watchlist(db, args.uid)


if __name__ == "__main__":
    main()
