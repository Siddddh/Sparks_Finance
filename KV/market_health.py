"""
Market Health Module
Computes overall market context: VIX, SPY/QQQ trend, breadth, distribution days.
Returns a market_health dict consumed by run_full_scan.py and the dashboard.
"""
import warnings; warnings.filterwarnings("ignore")
import yfinance as yf
import numpy as np
from datetime import datetime

def get_market_health(stock_rows=None):
    """
    stock_rows: list of scored stocks (optional) — used to compute breadth from our own universe.
    Returns a dict with all market health signals.
    """
    try:
        # ── Fetch SPY, QQQ, VIX ──
        spy = yf.Ticker("SPY").history(period="6mo", interval="1d", auto_adjust=True)
        qqq = yf.Ticker("QQQ").history(period="6mo", interval="1d", auto_adjust=True)
        vix = yf.Ticker("^VIX").history(period="3mo", interval="1d", auto_adjust=True)

        spy_close = spy["Close"]; spy_vol = spy["Volume"]
        qqq_close = qqq["Close"]
        vix_close = vix["Close"]

        # ── VIX analysis ──
        vix_now   = round(float(vix_close.iloc[-1]), 1)
        vix_5d    = round(float(vix_close.tail(5).mean()), 1)
        vix_trend = "RISING" if vix_close.iloc[-1] > vix_close.iloc[-5] else "FALLING"
        if vix_now < 15:      vix_label = "Very Calm 🟢";  vix_risk = "LOW"
        elif vix_now < 20:    vix_label = "Calm 🟢";        vix_risk = "LOW"
        elif vix_now < 25:    vix_label = "Elevated 🟡";    vix_risk = "MEDIUM"
        elif vix_now < 30:    vix_label = "High 🔴";         vix_risk = "HIGH"
        else:                 vix_label = "Extreme 🔴";      vix_risk = "EXTREME"

        # ── SPY trend ──
        spy_price = float(spy_close.iloc[-1])
        spy_ma50  = float(spy_close.rolling(50).mean().iloc[-1])
        spy_ma200 = float(spy_close.rolling(200).mean().iloc[-1])
        spy_52w_h = float(spy_close.tail(252).max())
        spy_pct_high = round((spy_price - spy_52w_h) / spy_52w_h * 100, 1)
        spy_above_50  = spy_price > spy_ma50
        spy_above_200 = spy_price > spy_ma200

        # ── Distribution days (heavy-volume down days in last 25 sessions) ──
        recent = spy.tail(25)
        dist_days = int(((recent["Close"] < recent["Close"].shift(1)) &
                         (recent["Volume"] > recent["Volume"].rolling(20).mean().shift(1))).sum())

        # ── QQQ trend ──
        qqq_price  = float(qqq_close.iloc[-1])
        qqq_ma50   = float(qqq_close.rolling(50).mean().iloc[-1])
        qqq_above_50 = qqq_price > qqq_ma50

        # ── Follow-through day check (up 1.25%+ on above-avg volume in last 5d) ──
        spy_5d = spy.tail(5)
        spy_5d_returns = spy_5d["Close"].pct_change() * 100
        spy_5d_vol_avg = float(spy_vol.rolling(50).mean().iloc[-1])
        ftd = any(
            (spy_5d_returns.iloc[i] >= 1.25 and
             float(spy_5d["Volume"].iloc[i]) > spy_5d_vol_avg)
            for i in range(len(spy_5d_returns))
        )

        # ── Determine market state ──
        if dist_days >= 6:
            market_state = "CORRECTION"
            state_color  = "red"
            state_emoji  = "🔴"
            state_advice = "Raise cash. No new breakout buys. Wait for follow-through day."
        elif dist_days >= 4 or (not spy_above_50) or vix_now > 25:
            market_state = "UNDER PRESSURE"
            state_color  = "amber"
            state_emoji  = "🟡"
            state_advice = "Trade selectively. Smaller positions. Only A+ setups."
        elif spy_above_50 and spy_above_200 and dist_days <= 2 and vix_now < 22:
            market_state = "CONFIRMED UPTREND"
            state_color  = "green"
            state_emoji  = "🟢"
            state_advice = "Full aggression. Take all qualifying breakouts."
        else:
            market_state = "UPTREND"
            state_color  = "green"
            state_emoji  = "🟢"
            state_advice = "Market healthy. Normal position sizing."

        # ── Breadth: % of our scanned stocks above their 50d MA ──
        breadth_pct = None
        breadth_label = "—"
        if stock_rows:
            above_50 = sum(1 for s in stock_rows
                          if s.get("price") and s.get("ma50") and s["price"] > s["ma50"])
            breadth_pct   = round(above_50 / len(stock_rows) * 100, 0)
            if breadth_pct >= 70:    breadth_label = f"{breadth_pct:.0f}% above MA50 — Healthy breadth 🟢"
            elif breadth_pct >= 50:  breadth_label = f"{breadth_pct:.0f}% above MA50 — Moderate breadth 🟡"
            else:                    breadth_label = f"{breadth_pct:.0f}% above MA50 — Narrow market 🔴"

        # ── SPY 1-week return ──
        spy_1w_ret = round((spy_price / float(spy_close.iloc[-6]) - 1) * 100, 1) if len(spy_close) >= 6 else 0.0
        spy_1m_ret = round((spy_price / float(spy_close.iloc[-22]) - 1) * 100, 1) if len(spy_close) >= 22 else 0.0

        return {
            "computed_at":    datetime.now().strftime("%Y-%m-%d %H:%M ET"),
            # State
            "market_state":   market_state,
            "state_color":    state_color,
            "state_emoji":    state_emoji,
            "state_advice":   state_advice,
            # VIX
            "vix":            vix_now,
            "vix_5d_avg":     vix_5d,
            "vix_trend":      vix_trend,
            "vix_label":      vix_label,
            "vix_risk":       vix_risk,
            # SPY
            "spy_price":      round(spy_price, 2),
            "spy_ma50":       round(spy_ma50, 2),
            "spy_ma200":      round(spy_ma200, 2),
            "spy_pct_high":   spy_pct_high,
            "spy_above_50":   bool(spy_above_50),
            "spy_above_200":  bool(spy_above_200),
            "spy_1w_ret":     spy_1w_ret,
            "spy_1m_ret":     spy_1m_ret,
            "dist_days":      int(dist_days),
            "follow_through": bool(ftd),
            # QQQ
            "qqq_price":      round(qqq_price, 2),
            "qqq_above_50":   bool(qqq_above_50),
            # Breadth
            "breadth_pct":    breadth_pct,
            "breadth_label":  breadth_label,
            # Trade filter
            "trade_ok":       market_state in ("CONFIRMED UPTREND", "UPTREND"),
        }
    except Exception as e:
        return {
            "computed_at": datetime.now().strftime("%Y-%m-%d %H:%M ET"),
            "market_state": "UNKNOWN", "state_color": "gray",
            "state_emoji": "⚪", "state_advice": "Market data unavailable.",
            "vix": 0, "vix_label": "—", "vix_risk": "UNKNOWN",
            "spy_price": 0, "spy_above_50": False, "spy_above_200": False,
            "spy_1w_ret": 0, "spy_1m_ret": 0, "dist_days": 0, "follow_through": False,
            "qqq_price": 0, "qqq_above_50": False, "breadth_pct": None,
            "breadth_label": "—", "trade_ok": False, "error": str(e),
        }


if __name__ == "__main__":
    import json
    h = get_market_health()
    print(json.dumps(h, indent=2))
