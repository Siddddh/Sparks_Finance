"""
portfolio.py — Portfolio management module for Sparks Finance.

Reads holdings from Firestore, fetches live prices via yfinance,
computes P&L metrics, and writes enriched performance data back
to Firestore under health_reports/{uid}/reports/{date}.

Usage:
    python portfolio.py <uid>                  # compute + push performance
    python portfolio.py <uid> --list           # list all portfolios
    python portfolio.py <uid> --add <pfid> AAPL 10 180.00  # add holding
"""

import sys
import json
import argparse
from datetime import datetime, date
import yfinance as yf
import pandas as pd

try:
    import firebase_admin
    from firebase_admin import credentials, firestore
    FIREBASE_AVAILABLE = True
except ImportError:
    FIREBASE_AVAILABLE = False

# ── Firebase init ──────────────────────────────────────────────────────────────

def get_db():
    if not FIREBASE_AVAILABLE:
        raise RuntimeError("firebase-admin not installed. Run: pip install firebase-admin")
    if not firebase_admin._apps:
        try:
            cred = credentials.Certificate("firebase_service_account.json")
            firebase_admin.initialize_app(cred)
        except Exception as e:
            raise RuntimeError(f"Firebase init failed: {e}")
    return firestore.client()

# ── Price fetching ─────────────────────────────────────────────────────────────

def fetch_prices(tickers: list[str]) -> dict:
    """Return {TICKER: current_price} for a list of tickers."""
    if not tickers:
        return {}
    prices = {}
    try:
        data = yf.download(tickers, period="2d", progress=False, auto_adjust=True)
        if isinstance(data.columns, pd.MultiIndex):
            close = data["Close"]
        else:
            close = data[["Close"]]
            close.columns = tickers
        for t in tickers:
            try:
                prices[t] = float(close[t].dropna().iloc[-1])
            except Exception:
                prices[t] = None
    except Exception as e:
        print(f"  [warn] Price fetch error: {e}")
    return prices

def fetch_52w(tickers: list[str]) -> dict:
    """Return {TICKER: (high_52w, low_52w)} for a list of tickers."""
    result = {}
    for t in tickers:
        try:
            info = yf.Ticker(t).fast_info
            result[t] = (getattr(info, "year_high", None), getattr(info, "year_low", None))
        except Exception:
            result[t] = (None, None)
    return result

# ── Portfolio CRUD ─────────────────────────────────────────────────────────────

def list_portfolios(db, uid: str) -> list[dict]:
    snap = db.collection("portfolios").document(uid).collection("list").stream()
    return [{"id": doc.id, **doc.to_dict()} for doc in snap]

def list_holdings(db, uid: str, portfolio_id: str) -> list[dict]:
    snap = db.collection("holdings").document(uid).collection(portfolio_id).stream()
    return [{"id": doc.id, **doc.to_dict()} for doc in snap]

def add_holding(db, uid: str, portfolio_id: str, ticker: str, qty: float,
                buy_price: float, buy_date: str = "", notes: str = "") -> str:
    ref = db.collection("holdings").document(uid).collection(portfolio_id).document()
    ref.set({
        "ticker": ticker.upper(),
        "qty": qty,
        "buy_price": buy_price,
        "buy_date": buy_date or date.today().isoformat(),
        "notes": notes,
        "added": datetime.utcnow().isoformat(),
    })
    print(f"  Added {ticker} x{qty} @ ${buy_price} to {portfolio_id}")
    return ref.id

def remove_holding(db, uid: str, portfolio_id: str, holding_id: str):
    db.collection("holdings").document(uid).collection(portfolio_id).document(holding_id).delete()
    print(f"  Removed holding {holding_id} from {portfolio_id}")

# ── Performance calculation ────────────────────────────────────────────────────

def compute_performance(holdings: list[dict], prices: dict, w52: dict) -> dict:
    """
    Given holdings and live prices, return a performance dict:
    {
        total_cost, total_value, total_gain_abs, total_gain_pct,
        today_gain_abs, today_gain_pct,
        high_52w_value, low_52w_value,
        top_gainers: [{ticker, gain_pct, gain_abs}],
        biggest_losers: [{ticker, gain_pct, gain_abs}],
        holdings: [{ticker, qty, buy_price, current_price, value, gain_abs, gain_pct, ...}]
    }
    """
    total_cost = 0.0
    total_value = 0.0
    high_52w_value = 0.0
    low_52w_value = 0.0
    enriched = []

    for h in holdings:
        ticker = (h.get("ticker") or "").upper()
        qty = float(h.get("qty") or 0)
        buy_price = float(h.get("buy_price") or 0)
        cur_price = prices.get(ticker) or buy_price
        cost = qty * buy_price
        val = qty * cur_price
        gain_abs = val - cost
        gain_pct = (gain_abs / cost * 100) if cost > 0 else 0.0

        high, low = w52.get(ticker, (None, None))
        high_52w_value += qty * (high or cur_price)
        low_52w_value += qty * (low or cur_price)

        total_cost += cost
        total_value += val
        enriched.append({
            "id": h.get("id", ""),
            "ticker": ticker,
            "qty": qty,
            "buy_price": buy_price,
            "current_price": cur_price,
            "value": round(val, 2),
            "gain_abs": round(gain_abs, 2),
            "gain_pct": round(gain_pct, 2),
            "buy_date": h.get("buy_date", ""),
            "notes": h.get("notes", ""),
        })

    total_gain_abs = total_value - total_cost
    total_gain_pct = (total_gain_abs / total_cost * 100) if total_cost > 0 else 0.0

    by_gain = sorted(enriched, key=lambda x: x["gain_pct"], reverse=True)
    top_gainers = [{"ticker": h["ticker"], "gain_pct": h["gain_pct"], "gain_abs": h["gain_abs"]} for h in by_gain[:3]]
    biggest_losers = [{"ticker": h["ticker"], "gain_pct": h["gain_pct"], "gain_abs": h["gain_abs"]} for h in by_gain[-3:] if h["gain_pct"] < 0]

    return {
        "total_cost": round(total_cost, 2),
        "total_value": round(total_value, 2),
        "total_gain_abs": round(total_gain_abs, 2),
        "total_gain_pct": round(total_gain_pct, 2),
        "today_gain_abs": None,
        "today_gain_pct": None,
        "high_52w_value": round(high_52w_value, 2),
        "low_52w_value": round(low_52w_value, 2),
        "top_gainers": top_gainers,
        "biggest_losers": biggest_losers,
        "holdings": enriched,
    }

# ── Push to Firestore ──────────────────────────────────────────────────────────

def push_portfolio_report(db, uid: str, portfolio_id: str, portfolio_name: str, perf: dict):
    today = date.today().isoformat()
    doc = {
        "uid": uid,
        "portfolio_id": portfolio_id,
        "portfolio_name": portfolio_name,
        "generated_at": datetime.utcnow().isoformat(),
        **perf,
    }
    db.collection("holdings").document(uid).collection(f"{portfolio_id}_performance").document(today).set(doc)
    print(f"  Pushed performance report for {portfolio_name} ({portfolio_id})")


def push_holding_prices(db, uid: str, portfolio_id: str, enriched_holdings: list):
    """
    Write current_price + gain back to each individual holding document so the
    browser can display live P&L without depending on scan data coverage.
    """
    updated_at = datetime.utcnow().isoformat()
    batch = db.batch()
    for h in enriched_holdings:
        hold_id = h.get("id")
        if not hold_id:
            continue
        ref = db.collection("holdings").document(uid).collection(portfolio_id).document(hold_id)
        batch.update(ref, {
            "current_price":  h["current_price"],
            "gain_pct":       h["gain_pct"],
            "gain_abs":       h["gain_abs"],
            "price_updated":  updated_at,
        })
    batch.commit()
    print(f"  Updated {len(enriched_holdings)} holding prices in Firestore")

# ── Main ───────────────────────────────────────────────────────────────────────

def run(uid: str, verbose: bool = True):
    db = get_db()
    portfolios = list_portfolios(db, uid)
    if not portfolios:
        print(f"No portfolios found for uid={uid}")
        return

    for pf in portfolios:
        pfid = pf["id"]
        pfname = pf.get("name", pfid)
        holdings = list_holdings(db, uid, pfid)
        if not holdings:
            print(f"  {pfname}: no holdings")
            continue

        tickers = list({h["ticker"].upper() for h in holdings if h.get("ticker")})
        print(f"  {pfname}: fetching prices for {tickers}…")
        prices = fetch_prices(tickers)
        w52 = fetch_52w(tickers)

        perf = compute_performance(holdings, prices, w52)
        push_portfolio_report(db, uid, pfid, pfname, perf)
        push_holding_prices(db, uid, pfid, perf["holdings"])

        if verbose:
            print(f"    Value: ${perf['total_value']:,.2f}  |  Gain: ${perf['total_gain_abs']:+,.2f} ({perf['total_gain_pct']:+.2f}%)")
            if perf["top_gainers"]:
                print(f"    Top gainers: " + ", ".join(f"{g['ticker']} {g['gain_pct']:+.1f}%" for g in perf["top_gainers"]))

    print("Done.")
    return portfolios


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sparks Finance — Portfolio Manager")
    parser.add_argument("uid", help="Firebase user UID")
    parser.add_argument("--list", action="store_true", help="List all portfolios")
    parser.add_argument("--add", metavar="PORTFOLIO_ID", help="Add a holding to this portfolio")
    parser.add_argument("--ticker", help="Ticker symbol (with --add)")
    parser.add_argument("--qty", type=float, help="Number of shares (with --add)")
    parser.add_argument("--price", type=float, help="Buy price (with --add)")
    parser.add_argument("--date", default="", help="Buy date YYYY-MM-DD (with --add)")
    parser.add_argument("--notes", default="", help="Notes (with --add)")
    args = parser.parse_args()

    db = get_db()

    if args.list:
        pfs = list_portfolios(db, args.uid)
        if not pfs:
            print("No portfolios found.")
        for pf in pfs:
            print(f"  [{pf['id']}] {pf['name']}")
    elif args.add:
        if not args.ticker or not args.qty or not args.price:
            print("--ticker, --qty, and --price are required with --add")
            sys.exit(1)
        add_holding(db, args.uid, args.add, args.ticker, args.qty, args.price, args.date, args.notes)
    else:
        run(args.uid)
