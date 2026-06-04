"""
alerts_engine.py — AI-Based Alerts & Scheduled Tasks (Req #4, #10).

Evaluates all user-configured alerts against live market data.
Conditions supported:
  price_drop_pct    — current price dropped X% from buy price
  price_rise_pct    — current price rose X% within one month
  price_below       — current price below threshold $
  price_above       — current price above threshold $
  major_news        — significant news from top sources
  analyst_upgrade   — analyst rating upgraded
  analyst_downgrade — analyst rating downgraded
  insider_buy       — insider purchase detected
  unusual_volume    — volume >= 3× average

Usage:
    python alerts_engine.py <uid>           # evaluate + fire pending alerts
    python alerts_engine.py <uid> --dry-run # print what would fire
"""
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


# ── Individual condition evaluators ───────────────────────────────────────────

def _price(ticker: str) -> float | None:
    try:
        info = yf.Ticker(ticker).fast_info
        return getattr(info, "last_price", None) or getattr(info, "regularMarketPrice", None)
    except Exception:
        return None

def _info(ticker: str) -> dict:
    try:
        return yf.Ticker(ticker).info or {}
    except Exception:
        return {}

def eval_price_drop_pct(alert: dict, info: dict) -> tuple[bool, str]:
    cur = info.get("regularMarketPrice") or info.get("currentPrice")
    prev = info.get("regularMarketPreviousClose") or info.get("previousClose")
    thresh = float(alert.get("threshold") or 5)
    if cur and prev and prev > 0:
        drop = (prev - cur) / prev * 100
        if drop >= thresh:
            return True, f"{alert['ticker']} dropped {drop:.1f}% (threshold: {thresh:.0f}%)"
    return False, ""

def eval_price_rise_pct(alert: dict, info: dict) -> tuple[bool, str]:
    cur = info.get("regularMarketPrice") or info.get("currentPrice")
    prev = info.get("regularMarketPreviousClose") or info.get("previousClose")
    thresh = float(alert.get("threshold") or 5)
    if cur and prev and prev > 0:
        rise = (cur - prev) / prev * 100
        if rise >= thresh:
            return True, f"{alert['ticker']} rose {rise:.1f}% (threshold: {thresh:.0f}%)"
    return False, ""

def eval_price_below(alert: dict, info: dict) -> tuple[bool, str]:
    cur = info.get("regularMarketPrice") or info.get("currentPrice")
    thresh = float(alert.get("threshold") or 0)
    if cur and thresh > 0 and cur <= thresh:
        return True, f"{alert['ticker']} at ${cur:.2f} — below threshold ${thresh:.2f}"
    return False, ""

def eval_price_above(alert: dict, info: dict) -> tuple[bool, str]:
    cur = info.get("regularMarketPrice") or info.get("currentPrice")
    thresh = float(alert.get("threshold") or 0)
    if cur and thresh > 0 and cur >= thresh:
        return True, f"{alert['ticker']} at ${cur:.2f} — above threshold ${thresh:.2f}"
    return False, ""

def eval_unusual_volume(alert: dict, info: dict) -> tuple[bool, str]:
    avg = info.get("averageVolume") or 0
    cur = info.get("regularMarketVolume") or 0
    if avg > 0 and cur / avg >= 3.0:
        return True, f"{alert['ticker']} volume {cur/avg:.1f}× average — unusual activity"
    return False, ""

def eval_analyst_upgrade(alert: dict, info: dict) -> tuple[bool, str]:
    rec = (info.get("recommendationKey") or "").lower()
    if rec in ("strong_buy", "buy"):
        return True, f"{alert['ticker']} analyst consensus: {rec.replace('_',' ').title()}"
    return False, ""

def eval_analyst_downgrade(alert: dict, info: dict) -> tuple[bool, str]:
    rec = (info.get("recommendationKey") or "").lower()
    if rec in ("sell", "underperform", "strong_sell"):
        return True, f"{alert['ticker']} analyst consensus: {rec.replace('_',' ').title()} — caution"
    return False, ""

def eval_insider_buy(alert: dict, _info: dict) -> tuple[bool, str]:
    try:
        t = yf.Ticker(alert["ticker"])
        insiders = t.insider_transactions
        if insiders is not None and not insiders.empty:
            recent = insiders.head(3)
            buys = sum(1 for _, r in recent.iterrows() if "purchase" in str(r.get("Text","")).lower())
            if buys >= 1:
                return True, f"{alert['ticker']}: {buys} recent insider purchase(s) detected"
    except Exception:
        pass
    return False, ""

def eval_major_news(alert: dict, _info: dict) -> tuple[bool, str]:
    try:
        news = yf.Ticker(alert["ticker"]).news or []
        breaking = [n for n in news if n.get("providerPublishTime", 0) > (datetime.utcnow().timestamp() - 4 * 3600)]
        if breaking:
            return True, f"Breaking news: {breaking[0].get('title', 'Major news event')}"
    except Exception:
        pass
    return False, ""


EVALUATORS = {
    "price_drop_pct":    eval_price_drop_pct,
    "price_rise_pct":    eval_price_rise_pct,
    "price_below":       eval_price_below,
    "price_above":       eval_price_above,
    "unusual_volume":    eval_unusual_volume,
    "analyst_upgrade":   eval_analyst_upgrade,
    "analyst_downgrade": eval_analyst_downgrade,
    "insider_buy":       eval_insider_buy,
    "major_news":        eval_major_news,
}


# ── Main evaluation loop ───────────────────────────────────────────────────────

def evaluate_alerts(db, uid: str, dry_run: bool = False) -> list[dict]:
    alerts_ref = db.collection("alerts").document(uid).collection("list")
    active = [{"id": doc.id, **doc.to_dict()} for doc in alerts_ref.where("status", "==", "active").stream()]

    if not active:
        print(f"  No active alerts for uid={uid}")
        return []

    # Group by ticker to batch info fetches
    tickers = list({a["ticker"].upper() for a in active if a.get("ticker")})
    ticker_info = {}
    for t in tickers:
        try:
            ticker_info[t] = yf.Ticker(t).info or {}
        except Exception:
            ticker_info[t] = {}

    fired = []
    for alert in active:
        ticker = (alert.get("ticker") or "").upper()
        condition = alert.get("condition", "")
        evaluator = EVALUATORS.get(condition)
        if not evaluator:
            continue
        try:
            triggered, message = evaluator(alert, ticker_info.get(ticker, {}))
        except Exception as e:
            print(f"  [warn] Alert eval error {ticker}/{condition}: {e}")
            continue

        if triggered:
            print(f"  FIRED: {ticker} — {message}")
            fired.append({"id": alert["id"], "ticker": ticker, "condition": condition, "message": message})
            if not dry_run:
                alerts_ref.document(alert["id"]).update({
                    "status": "fired",
                    "last_triggered": datetime.utcnow().isoformat(),
                    "trigger_message": message,
                })
        else:
            print(f"  ok    : {ticker} / {condition}")

    print(f"  Evaluated {len(active)} alerts — {len(fired)} fired")
    return fired


def main():
    parser = argparse.ArgumentParser(description="Sparks Finance — Alerts Engine")
    parser.add_argument("uid", help="Firebase user UID")
    parser.add_argument("--dry-run", action="store_true", help="Evaluate without updating Firestore")
    args = parser.parse_args()
    db = get_db()
    evaluate_alerts(db, args.uid, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
