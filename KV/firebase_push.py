"""
Firebase Push — uploads scan data to Firestore after every run.

Firestore structure:
  scans/latest           ← full scan result (overwritten each run)
  scans/history_index    ← {dates: ["2026-05-13", ...]} rolling 7-day index
  history/YYYY-MM-DD     ← daily summary (lightweight, one per day)

Called automatically by run_full_scan.py after every successful scan.
Can also be run manually:  python3 firebase_push.py
"""

import json, os, sys, glob as _glob
from datetime import datetime

def _find_base():
    # Always use the directory where this file lives
    return os.path.dirname(os.path.abspath(__file__))

BASE        = _find_base()
CREDS_PATH  = os.path.join(BASE, "firebase_service_account.json")
CONFIG_PATH = os.path.join(BASE, "firebase_config.json")
SCAN_FILE   = os.path.join(BASE, "combined_results.json")
MAX_HISTORY = 7


def _check_setup():
    """Verify required files exist before attempting push."""
    if not os.path.exists(CREDS_PATH):
        print(f"  ✗  Missing: {CREDS_PATH}")
        print("     Download your service account key from:")
        print("     Firebase Console → Project Settings → Service Accounts → Generate new private key")
        print("     Save it as firebase_service_account.json in your KV folder.")
        return False
    if not os.path.exists(CONFIG_PATH):
        print(f"  ✗  Missing: {CONFIG_PATH}")
        print("     Copy firebase_config.template.json → firebase_config.json and fill in your values.")
        return False
    return True


def _safe_dict(obj):
    """Recursively convert any non-Firestore-compatible types."""
    import numpy as np
    if isinstance(obj, dict):
        return {k: _safe_dict(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_safe_dict(i) for i in obj]
    elif isinstance(obj, (np.bool_,)):   return bool(obj)
    elif isinstance(obj, (np.integer,)): return int(obj)
    elif isinstance(obj, (np.floating,)):return float(obj)
    elif isinstance(obj, float) and (obj != obj):  return None  # NaN → null
    else: return obj


def push_to_firestore(scan_data: dict, verbose: bool = True) -> bool:
    """Push scan_data to Firestore. Returns True on success."""
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore as fs
    except ImportError:
        print("  ✗  firebase-admin not installed. Run: pip install firebase-admin")
        return False

    if not _check_setup():
        return False

    try:
        # Init app once per process
        if not firebase_admin._apps:
            cred = credentials.Certificate(CREDS_PATH)
            firebase_admin.initialize_app(cred)

        db = fs.client()

        # ── 1. Push full scan to scans/latest ──────────────────────
        clean_data = _safe_dict(scan_data)

        # Keep ALL scanned stocks (WATCH/WEAK included) so the dashboard shows the
        # full universe. To stay under Firestore's 1 MB doc limit, the top picks keep
        # their full detail (thesis, news, strengths) while the rest are stored as
        # compact records carrying everything the UI needs to render cards/table/search.
        _COMPACT_KEYS = (
            "ticker", "name", "sector", "market_cap_b", "price",
            "signal", "score", "combined_score", "setup_quality",
            "rsi", "vol_ratio", "momentum_3m", "eps_growth", "rev_growth",
            "fwd_pe", "analyst_rating", "rr_ratio", "entry", "stop_loss", "target_1",
            "pct_from_high", "days_to_earnings", "earnings_flag", "earnings_label",
            "criteria", "is_vcp", "vcp_contractions", "rs_at_high", "is_vdu",
            "is_pocket_pivot", "squeeze_potential", "short_pct_float",
            "news_sentiment", "has_catalyst", "has_breaking_news",
        )
        FULL_DETAIL = 25  # how many top stocks keep thesis/news/strengths

        all_stocks = sorted(
            clean_data.get("stocks", []),
            key=lambda s: s.get("combined_score", s.get("score", 0)) or 0,
            reverse=True,
        )
        packed = []
        for i, s in enumerate(all_stocks):
            if i < FULL_DETAIL:
                packed.append(s)
            else:
                packed.append({k: s[k] for k in _COMPACT_KEYS if k in s})
        clean_data["stocks"]      = packed
        clean_data["top_picks"]   = clean_data.get("top_picks", [])[:10]
        clean_data["market_news"] = clean_data.get("market_news", [])[:8]
        clean_data["alerts"]      = clean_data.get("alerts", [])[:12]

        # Safety: if the document is still too large, drop compact tail until it fits.
        while len(json.dumps(clean_data, default=str).encode("utf-8")) > 1_000_000 and len(clean_data["stocks"]) > FULL_DETAIL:
            clean_data["stocks"] = clean_data["stocks"][:-50]

        db.collection("scans").document("latest").set(clean_data)
        if verbose: print("  ✓  Pushed → Firestore: scans/latest")

        # ── 2. Push daily summary to history/{date} ────────────────
        date    = scan_data.get("scan_date", datetime.now().strftime("%Y-%m-%d"))
        stocks  = scan_data.get("stocks", [])
        mh      = scan_data.get("market_health", {})

        summary = {
            "scan_date":    date,
            "scan_time_et": scan_data.get("scan_time_et", "—"),
            "strong_buy":   sum(1 for s in stocks if s.get("signal") == "STRONG BUY"),
            "watch":        sum(1 for s in stocks if s.get("signal") == "WATCH"),
            "weak":         sum(1 for s in stocks if s.get("signal") == "WEAK"),
            "top5":         [s["ticker"] for s in stocks[:5]],
            "market_state": mh.get("market_state", "—"),
            "state_emoji":  mh.get("state_emoji", ""),
            "vix":          mh.get("vix"),
            "spy_price":    mh.get("spy_price"),
            "spy_1w_ret":   mh.get("spy_1w_ret"),
            "dist_days":    mh.get("dist_days"),
            "breadth_pct":  mh.get("breadth_pct"),
        }
        db.collection("history").document(date).set(summary)
        if verbose: print(f"  ✓  Pushed → Firestore: history/{date}")

        # ── 3. Update history index ────────────────────────────────
        idx_ref = db.collection("scans").document("history_index")
        idx_doc = idx_ref.get()
        dates   = idx_doc.to_dict().get("dates", []) if idx_doc.exists else []

        if date not in dates:
            dates.append(date)
        dates = sorted(set(dates), reverse=True)[:MAX_HISTORY]
        idx_ref.set({"dates": dates, "updated_at": datetime.now().isoformat()})

        if verbose:
            print(f"  ✓  History index: {', '.join(dates)}")

        return True

    except Exception as e:
        print(f"  ✗  Firebase push failed: {e}")
        if verbose:
            import traceback; traceback.print_exc()
        return False


if __name__ == "__main__":
    print(f"Loading scan data from {SCAN_FILE}…")
    try:
        with open(SCAN_FILE) as f:
            data = json.load(f)
        print(f"  Scan date: {data.get('scan_date')} | Stocks: {len(data.get('stocks', []))}")
        ok = push_to_firestore(data, verbose=True)
        sys.exit(0 if ok else 1)
    except FileNotFoundError:
        print(f"  ✗  {SCAN_FILE} not found. Run run_full_scan.py first.")
        sys.exit(1)
