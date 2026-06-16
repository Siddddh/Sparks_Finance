"""
S&P 500 Momentum Breakout Scanner — Enhanced v2
Signals: Stage 2 Trend, VCP, RS Line, Volume Dry-Up, Pocket Pivot,
         RSI, EPS/Rev Growth, Short Interest, Insider Buying, Earnings Proximity
"""
import json, sys, warnings
warnings.filterwarnings("ignore")
import yfinance as yf
import pandas as pd
import numpy as np
from datetime import datetime, timezone, timedelta

try:
    from scipy.signal import find_peaks
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False

# ── Cache SPY once per run ──
_SPY_CACHE = None
def get_spy():
    global _SPY_CACHE
    if _SPY_CACHE is None:
        _SPY_CACHE = yf.Ticker("SPY").history(period="1y", interval="1d", auto_adjust=True)["Close"]
    return _SPY_CACHE

# ─────────────────────────────────────────
#  HELPER: RSI
# ─────────────────────────────────────────
def compute_rsi(series, period=14):
    delta = series.diff()
    gain  = delta.clip(lower=0).rolling(period).mean()
    loss  = (-delta.clip(upper=0)).rolling(period).mean()
    rs    = gain / loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))

# ─────────────────────────────────────────
#  VCP — Volatility Contraction Pattern
# ─────────────────────────────────────────
def compute_vcp(hist):
    """
    Returns dict: vcp_score (0-30), vcp_contractions, vcp_tightest_pct,
                  is_vcp, vcp_label
    """
    close = hist["Close"]
    vol   = hist["Volume"]
    prices = close.tail(60).values
    vols   = vol.tail(60).values

    contractions = 0
    tightest_pct = 100.0
    is_vcp = False
    vcp_score = 0

    if HAS_SCIPY and len(prices) >= 30:
        from scipy.signal import find_peaks
        peaks,   _ = find_peaks(prices,  distance=5, prominence=prices.mean()*0.02)
        troughs, _ = find_peaks(-prices, distance=5, prominence=prices.mean()*0.02)

        pullbacks = []
        for p in peaks:
            subs = troughs[troughs > p]
            if len(subs):
                t   = subs[0]
                pct = (prices[p] - prices[t]) / prices[p] * 100
                avg_v = vols[p:t+1].mean() if t > p else vols[p]
                pullbacks.append({"pct": round(float(pct), 1),
                                  "vol_ratio": round(float(avg_v / vols.mean()), 2)})

        if len(pullbacks) >= 2:
            # Check contracting (each pullback < previous)
            strictly_contracting = all(
                pullbacks[i]["pct"] > pullbacks[i+1]["pct"]
                for i in range(len(pullbacks)-1)
            )
            # Loose contracting: at least 2 of last 3 contract
            if len(pullbacks) >= 3:
                last3 = pullbacks[-3:]
                loose = sum(1 for i in range(len(last3)-1) if last3[i]["pct"] > last3[i+1]["pct"])
                loosely_contracting = loose >= 1
            else:
                loosely_contracting = strictly_contracting

            tightest_pct = pullbacks[-1]["pct"]
            contractions = len(pullbacks)
            is_vcp = loosely_contracting and tightest_pct < 10

    # Score VCP (0–30)
    if is_vcp:
        if tightest_pct < 4:   vcp_score = 30   # super tight
        elif tightest_pct < 6: vcp_score = 25
        elif tightest_pct < 8: vcp_score = 18
        else:                  vcp_score = 12
    elif contractions >= 1:
        vcp_score = 5   # partial pattern

    # Tight range bonus (even without formal VCP)
    daily_range_20 = ((hist["High"] - hist["Low"]) / hist["Close"]).tail(20).mean() * 100
    daily_range_5  = ((hist["High"] - hist["Low"]) / hist["Close"]).tail(5).mean() * 100
    range_contraction = daily_range_5 / daily_range_20 if daily_range_20 > 0 else 1.0

    if range_contraction < 0.5 and vcp_score == 0:
        vcp_score = 10   # tight consolidation even without formal VCP
    elif range_contraction < 0.7 and vcp_score < 10:
        vcp_score = max(vcp_score, 6)

    if is_vcp:
        label = f"VCP ✓ ({contractions} contractions, tightest {tightest_pct:.1f}%)"
    elif range_contraction < 0.6:
        label = f"Tight consolidation (range {daily_range_5:.1f}% vs {daily_range_20:.1f}% avg)"
    else:
        label = "No clear VCP"

    return {
        "vcp_score":       int(min(30, vcp_score)),
        "vcp_contractions": int(contractions),
        "vcp_tightest_pct": round(float(tightest_pct), 1),
        "is_vcp":           bool(is_vcp),
        "range_contraction": round(float(range_contraction), 2),
        "vcp_label":        label,
    }

# ─────────────────────────────────────────
#  RS Line vs SPY
# ─────────────────────────────────────────
def compute_rs_line(close_series):
    spy = get_spy()
    spy = spy.reindex(close_series.index, method="ffill").ffill().bfill()
    rs  = close_series / spy
    rs_52w_high  = rs.tail(252).max()
    rs_current   = rs.iloc[-1]
    rs_4w_change = (rs.iloc[-1] / rs.iloc[-20] - 1) * 100 if len(rs) >= 20 else 0.0
    rs_pct_from_high = (rs_current - rs_52w_high) / rs_52w_high * 100 if rs_52w_high > 0 else -100
    rs_at_high = rs_pct_from_high >= -3   # within 3% of RS 52w high

    # RS score (0-20)
    if rs_at_high and rs_4w_change > 0:   rs_score = 20
    elif rs_at_high:                       rs_score = 15
    elif rs_pct_from_high >= -10:          rs_score = 10
    elif rs_4w_change > 5:                 rs_score = 8
    elif rs_4w_change > 0:                 rs_score = 5
    else:                                  rs_score = 0

    return {
        "rs_pct_from_high": round(float(rs_pct_from_high), 1),
        "rs_4w_change":     round(float(rs_4w_change), 1),
        "rs_at_high":       bool(rs_at_high),
        "rs_score":         int(rs_score),
        "rs_label": ("RS New High 🔥" if rs_at_high
                     else f"RS {rs_pct_from_high:.0f}% from high"),
    }

# ─────────────────────────────────────────
#  Volume Dry-Up & Pocket Pivot
# ─────────────────────────────────────────
def compute_volume_signals(hist):
    vol   = hist["Volume"]
    close = hist["Close"]

    vol_5d  = float(vol.tail(5).mean())
    vol_20d = float(vol.tail(20).mean())
    vol_50d = float(vol.tail(50).mean()) if len(vol) >= 50 else vol_20d
    vdu_ratio = vol_5d / vol_20d if vol_20d > 0 else 1.0

    is_vdu = vdu_ratio < 0.6   # volume 40%+ below 20d avg
    vdu_score = 0
    if vdu_ratio < 0.4:   vdu_score = 15
    elif vdu_ratio < 0.6: vdu_score = 10
    elif vdu_ratio < 0.8: vdu_score = 5

    # Pocket pivot: today up AND today's volume > max down-volume of prior 10 days
    if len(hist) >= 11:
        last    = hist.iloc[-1]
        prior10 = hist.iloc[-11:-1]
        down_days = prior10[prior10["Close"] < prior10["Open"]]
        max_down_vol = float(down_days["Volume"].max()) if not down_days.empty else 0.0
        is_pocket_pivot = bool(
            (float(last["Close"]) > float(last["Open"])) and
            (float(last["Volume"]) > max_down_vol) and
            (float(last["Volume"]) > vol_20d * 0.8)
        )
    else:
        is_pocket_pivot = False

    # Today's vol vs 20d avg
    vol_today = float(vol.iloc[-1])
    vol_ratio = round(vol_today / vol_20d, 2) if vol_20d > 0 else 1.0

    return {
        "vdu_ratio":       round(vdu_ratio, 2),
        "is_vdu":          bool(is_vdu),
        "vdu_score":       int(vdu_score),
        "is_pocket_pivot": bool(is_pocket_pivot),
        "vol_ratio":       vol_ratio,
        "vdu_label": (f"Vol dry-up ✓ ({vdu_ratio:.0%} of avg)" if is_vdu
                      else f"Vol at {vdu_ratio:.0%} of avg"),
    }

# ─────────────────────────────────────────
#  Short Interest & Squeeze Setup
# ─────────────────────────────────────────
def compute_short_interest(info):
    short_float = info.get("shortPercentOfFloat") or 0.0
    short_ratio = info.get("shortRatio") or 0.0   # days to cover
    short_pct   = round(float(short_float) * 100, 1)
    dtc         = round(float(short_ratio), 1)

    squeeze_score = 0
    if short_pct >= 15 and dtc >= 5:   squeeze_score = 15
    elif short_pct >= 10 and dtc >= 3: squeeze_score = 10
    elif short_pct >= 5:               squeeze_score = 5

    return {
        "short_pct_float":  short_pct,
        "days_to_cover":    dtc,
        "squeeze_score":    int(squeeze_score),
        "squeeze_potential": ("HIGH" if squeeze_score >= 15 else
                              "MEDIUM" if squeeze_score >= 10 else
                              "LOW" if squeeze_score >= 5 else "NONE"),
    }

# ─────────────────────────────────────────
#  Insider Buying
# ─────────────────────────────────────────
def compute_insider_signal(ticker_obj):
    try:
        ins = ticker_obj.insider_transactions
        if ins is None or ins.empty:
            return {"insider_buying": False, "insider_score": 0,
                    "insider_label": "No data", "insider_buys_30d": 0, "insider_buy_value": 0}

        # Filter last 60 days
        ins = ins.copy()
        if "Start Date" in ins.columns:
            ins["Start Date"] = pd.to_datetime(ins["Start Date"], errors="coerce")
            cutoff = pd.Timestamp.now() - pd.Timedelta(days=60)
            recent = ins[ins["Start Date"] >= cutoff]
        else:
            recent = ins.head(10)

        buys  = recent[recent["Transaction"].str.contains("Purchase|Buy", case=False, na=False)]
        sales = recent[recent["Transaction"].str.contains("Sale|Sell", case=False, na=False)]

        buy_value  = float(buys["Value"].sum()) if not buys.empty else 0.0
        sell_value = float(sales["Value"].sum()) if not sales.empty else 0.0
        buy_count  = len(buys)

        insider_buying = buy_count >= 1 and buy_value > 50_000
        cluster        = buy_count >= 3

        if cluster and buy_value > 500_000:      score = 15
        elif buy_count >= 2 and buy_value > 200_000: score = 10
        elif insider_buying:                         score = 5
        else:                                        score = 0

        if cluster:
            label = f"Cluster buying! {buy_count} insiders, ${buy_value/1e6:.1f}M in 60d"
        elif insider_buying:
            label = f"{buy_count} insider purchase(s), ${buy_value/1e3:.0f}K in 60d"
        elif sell_value > 0:
            label = f"Insider selling: ${sell_value/1e6:.1f}M"
        else:
            label = "No recent insider activity"

        return {
            "insider_buying":    bool(insider_buying),
            "insider_cluster":   bool(cluster),
            "insider_score":     int(score),
            "insider_buys_30d":  int(buy_count),
            "insider_buy_value": round(buy_value),
            "insider_label":     label,
        }
    except Exception:
        return {"insider_buying": False, "insider_score": 0,
                "insider_label": "No data", "insider_buys_30d": 0, "insider_buy_value": 0}

# ─────────────────────────────────────────
#  Earnings Date Proximity
# ─────────────────────────────────────────
def compute_earnings_proximity(ticker_obj):
    try:
        cal = ticker_obj.calendar
        if not cal or "Earnings Date" not in cal:
            return {"days_to_earnings": None, "earnings_flag": "UNKNOWN",
                    "earnings_label": "No earnings date", "earnings_score": 0,
                    "earnings_date_str": "—"}

        earn_dates = cal["Earnings Date"]
        if not isinstance(earn_dates, list):
            earn_dates = [earn_dates]

        today = datetime.now(timezone.utc).date()
        future = [d for d in earn_dates
                  if (d if isinstance(d, type(today)) else d.date() if hasattr(d,'date') else today) >= today]

        if not future:
            return {"days_to_earnings": None, "earnings_flag": "PAST",
                    "earnings_label": "Earnings passed", "earnings_score": 0,
                    "earnings_date_str": "—"}

        next_earn = future[0]
        next_earn_date = next_earn if isinstance(next_earn, type(today)) else next_earn.date() if hasattr(next_earn,'date') else today
        days_to = (next_earn_date - today).days

        if 7 <= days_to <= 14:
            flag = "CATALYST"
            score = 10
            label = f"⚡ Earnings in {days_to}d — CATALYST WINDOW"
        elif 3 <= days_to < 7:
            flag = "APPROACHING"
            score = 5
            label = f"📅 Earnings in {days_to}d"
        elif days_to < 3:
            flag = "HIGH_RISK"
            score = -5
            label = f"⚠️ Earnings in {days_to}d — HIGH RISK"
        elif days_to <= 30:
            flag = "UPCOMING"
            score = 3
            label = f"📅 Earnings in {days_to}d"
        else:
            flag = "DISTANT"
            score = 0
            label = f"📅 Earnings in {days_to}d"

        return {
            "days_to_earnings": int(days_to),
            "earnings_flag":    flag,
            "earnings_label":   label,
            "earnings_score":   int(score),
            "earnings_date_str": str(next_earn_date),
        }
    except Exception:
        return {"days_to_earnings": None, "earnings_flag": "UNKNOWN",
                "earnings_label": "No earnings date", "earnings_score": 0,
                "earnings_date_str": "—"}

# ─────────────────────────────────────────
#  MAIN SCORER
# ─────────────────────────────────────────
def _new_listing_row(ticker, name, sector, market_cap, price, ma50, high_52w, low_52w,
                     pct_from_high, hist_days, rsi, momentum_3m, eps_growth, rev_growth, fwd_pe, analyst_up):
    """Minimal, crash-safe record for a stock with too little history for breakout signals
    (e.g. a days-old IPO like SPCX). Shows price + basics + is_new_listing; technical signals
    are neutral/None so the UI flags it as a new listing rather than misreading zeros."""
    finite = lambda v: round(v, 1) if isinstance(v, float) and v == v else None
    return {
        "ticker": ticker, "name": name, "sector": sector,
        "market_cap_b": round(market_cap / 1e9, 1) if market_cap else None,
        "is_new_listing": True, "history_days": int(hist_days),
        "price": round(price, 2), "ma50": round(ma50, 2), "ma150": None, "ma200": None,
        "high_52w": round(high_52w, 2), "low_52w": round(low_52w, 2), "pct_from_high": pct_from_high,
        "momentum_3m": finite(momentum_3m), "rsi": finite(rsi), "vol_ratio": 1.0,
        "vcp_score": 0, "is_vcp": False, "vcp_contractions": 0, "vcp_label": "",
        "rs_score": 0, "rs_at_high": False, "rs_label": "", "rs_4w_change": None, "rs_pct_from_high": None,
        "vdu_score": 0, "is_vdu": False, "is_pocket_pivot": False, "vdu_label": "", "vdu_ratio": None,
        "squeeze_score": 0, "squeeze_potential": "NONE", "short_pct_float": None, "days_to_cover": None,
        "insider_score": 0, "insider_buying": False, "insider_label": "", "insider_cluster": False,
        "insider_buys_30d": 0, "insider_buy_value": 0,
        "earnings_score": 0, "earnings_flag": "UNKNOWN", "earnings_label": "", "days_to_earnings": None, "earnings_date_str": "",
        "eps_growth": round(eps_growth * 100, 1) if eps_growth is not None else None,
        "rev_growth": round(rev_growth * 100, 1) if rev_growth is not None else None,
        "fwd_pe": round(fwd_pe, 1) if fwd_pe else None,
        "analyst_rating": round(analyst_up, 2) if analyst_up else None,
        "score": 50, "signal": "WATCH",
        "entry": round(price, 2), "stop_loss": round(price * 0.92, 2), "target_1": round(price * 1.20, 2), "rr_ratio": 2.5,
        "criteria": {"trend_ok": False, "near_high": False, "rsi_ok": False, "volume_ok": False,
                     "eps_ok": bool(eps_growth is not None and eps_growth >= 0.20),
                     "rev_ok": bool(rev_growth is not None and rev_growth >= 0.10),
                     "vcp_ok": False, "rs_ok": False, "vdu_ok": False, "insider_ok": False},
    }


def score_stock(ticker_symbol, min_history=50):
    try:
        tk   = yf.Ticker(ticker_symbol)
        hist = tk.history(period="1y", interval="1d", auto_adjust=True)

        # Minimum history. Callers pass a lower bound for curated/held names so brand-new
        # IPOs still surface (the broad universe keeps the default 50). Below ~30 days we
        # return a minimal new-listing row instead of computing unreliable breakout signals.
        if hist.empty or len(hist) < min_history:
            return None

        # Flag as new listing if < 150 days (spin-off / recent IPO)
        is_new_listing = len(hist) < 150

        close  = hist["Close"]
        volume = hist["Volume"]
        price  = float(close.iloc[-1])

        # ── Moving averages — use available history ──
        ma50  = float(close.rolling(min(50, len(close))).mean().iloc[-1])
        # For new listings, use best available approximation
        ma150 = float(close.rolling(min(150, len(close))).mean().iloc[-1])
        ma200 = float(close.rolling(min(200, len(close))).mean().iloc[-1])

        # ── 52-week range ──
        high_52w    = float(close.max())
        low_52w     = float(close.min())
        pct_from_high = round((price - high_52w) / high_52w * 100, 1)

        # ── RSI ──
        rsi = float(compute_rsi(close).iloc[-1])

        # ── 3-month momentum ──
        price_3m = float(close.iloc[-63]) if len(close) >= 63 else float(close.iloc[0])
        momentum_3m = round((price - price_3m) / price_3m * 100, 1)

        # ── Fundamentals ──
        info       = tk.info
        eps_growth = info.get("earningsGrowth")
        rev_growth = info.get("revenueGrowth")
        fwd_pe     = info.get("forwardPE")
        analyst_up = info.get("recommendationMean")
        sector     = info.get("sector", "Unknown")
        short_name = info.get("shortName", ticker_symbol)
        market_cap = info.get("marketCap", 0)

        # Days-old listing (e.g. a fresh IPO like SPCX): too little history for VCP/RS/etc.
        # Return a minimal row now (price + new-listing flag); breakout signals build over time.
        if len(hist) < 30:
            return _new_listing_row(ticker_symbol, short_name, sector, market_cap, price,
                                    ma50, high_52w, low_52w, pct_from_high, len(hist),
                                    rsi, momentum_3m, eps_growth, rev_growth, fwd_pe, analyst_up)

        # ── Enhanced signals ──
        vcp_data     = compute_vcp(hist)
        rs_data      = compute_rs_line(close)
        vol_data     = compute_volume_signals(hist)
        short_data   = compute_short_interest(info)
        insider_data = compute_insider_signal(tk)
        earn_data    = compute_earnings_proximity(tk)

        # ── Base criteria ──
        # For new listings (<150d) the MA150/200 are unreliable — use relaxed trend check
        if is_new_listing:
            trend_ok = bool(price > ma50)   # just needs to be above 50d MA
        else:
            trend_ok  = bool(price > ma50 > ma150 > ma200)
        near_high = bool(pct_from_high >= -25)
        rsi_ok    = bool(50 <= rsi <= 75)
        volume_ok = bool(vol_data["vol_ratio"] >= 1.5)
        eps_ok    = bool(eps_growth is not None and eps_growth >= 0.20)
        rev_ok    = bool(rev_growth is not None and rev_growth >= 0.10)

        # ── SCORING (0-100 base, bonuses can push higher → capped later) ──
        score = 0

        # Core Minervini criteria (max 95 pts base)
        score += 25 if trend_ok else 0
        score += 12 if near_high else max(0, 12 + pct_from_high * 0.3)
        score += 12 if rsi_ok    else 0
        score += 12 if volume_ok else min(11, vol_data["vol_ratio"] * 7)
        score += 8  if eps_ok    else 0
        score += 8  if rev_ok    else 0
        score += 3  if (analyst_up is not None and analyst_up <= 2.5) else 0

        # New enhanced signals (bonus points)
        score += vcp_data["vcp_score"]           # 0-30
        score += rs_data["rs_score"]             # 0-20
        score += vol_data["vdu_score"]           # 0-15
        score += short_data["squeeze_score"]     # 0-15
        score += insider_data["insider_score"]   # 0-15
        score += earn_data["earnings_score"]     # -5 to +10
        score += 8 if vol_data["is_pocket_pivot"] else 0

        # Cap at 100
        score = round(min(100, max(0, score)), 1)

        if score >= 75:   signal = "STRONG BUY"
        elif score >= 55: signal = "WATCH"
        else:             signal = "WEAK"

        # ── Trade levels ──
        stop_loss = round(price * 0.92, 2)
        target_1  = round(price * 1.20, 2)
        risk      = round(price - stop_loss, 2)
        reward    = round(target_1 - price, 2)
        rr_ratio  = round(reward / risk, 1) if risk > 0 else 0

        return {
            # Identity
            "ticker":       ticker_symbol,
            "name":         short_name,
            "sector":       sector,
            "market_cap_b": round(market_cap / 1e9, 1) if market_cap else None,
            "is_new_listing": bool(is_new_listing),
            "history_days":   int(len(hist)),
            # Price & trend
            "price":         round(price, 2),
            "ma50":          round(ma50, 2),
            "ma150":         round(ma150, 2),
            "ma200":         round(ma200, 2),
            "high_52w":      round(high_52w, 2),
            "low_52w":       round(low_52w, 2),
            "pct_from_high": pct_from_high,
            "momentum_3m":   momentum_3m,
            # Technical signals
            "rsi":           round(rsi, 1),
            "vol_ratio":     vol_data["vol_ratio"],
            # Enhanced signals (all exported)
            **vcp_data,
            **rs_data,
            **vol_data,
            **short_data,
            **insider_data,
            **earn_data,
            # Fundamentals
            "eps_growth":    round(eps_growth * 100, 1) if eps_growth is not None else None,
            "rev_growth":    round(rev_growth * 100, 1) if rev_growth is not None else None,
            "fwd_pe":        round(fwd_pe, 1) if fwd_pe else None,
            "analyst_rating": round(analyst_up, 2) if analyst_up else None,
            # Score & signal
            "score":   score,
            "signal":  signal,
            # Trade levels
            "entry":     round(price, 2),
            "stop_loss": stop_loss,
            "target_1":  target_1,
            "rr_ratio":  rr_ratio,
            # Criteria dict (for criteria dots)
            "criteria": {
                "trend_ok":   bool(trend_ok),
                "near_high":  bool(near_high),
                "rsi_ok":     bool(rsi_ok),
                "volume_ok":  bool(volume_ok),
                "eps_ok":     bool(eps_ok),
                "rev_ok":     bool(rev_ok),
                "vcp_ok":     bool(vcp_data["is_vcp"]),
                "rs_ok":      bool(rs_data["rs_at_high"]),
                "vdu_ok":     bool(vol_data["is_vdu"]),
                "insider_ok": bool(insider_data["insider_buying"]),
            },
        }
    except Exception as e:
        print(f"  ERR {ticker_symbol}: {e}", file=sys.stderr)
        return None


if __name__ == "__main__":
    tickers = sys.argv[1:] or ["AMD", "CAT", "NVDA"]
    for t in tickers:
        r = score_stock(t)
        if r:
            print(f"\n{r['ticker']} — {r['name']}")
            print(f"  Score: {r['score']} | Signal: {r['signal']}")
            print(f"  VCP: {r['vcp_label']}")
            print(f"  RS:  {r['rs_label']}")
            print(f"  VDU: {r['vdu_label']}")
            print(f"  Short squeeze: {r['squeeze_potential']} ({r['short_pct_float']}% float, {r['days_to_cover']}d DTC)")
            print(f"  Insider: {r['insider_label']}")
            print(f"  Earnings: {r['earnings_label']}")
