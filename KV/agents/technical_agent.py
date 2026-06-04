"""Technical Agent — Extended technical analysis (trend, momentum, patterns)."""
import yfinance as yf
import pandas as pd
import numpy as np

def analyze(ticker: str) -> dict:
    score = 0
    signals = []
    raw = {}

    try:
        hist = yf.download(ticker, period="1y", progress=False, auto_adjust=True)
        if hist.empty:
            return {"ticker": ticker, "score": 0, "signals": ["No price data"], "summary": "No data", "raw": {}}

        close = hist["Close"].squeeze()
        vol = hist["Volume"].squeeze()

        ma50 = float(close.rolling(50).mean().iloc[-1])
        ma150 = float(close.rolling(150).mean().iloc[-1])
        ma200 = float(close.rolling(200).mean().iloc[-1])
        price = float(close.iloc[-1])
        high_52w = float(close.rolling(252).max().iloc[-1])
        low_52w = float(close.rolling(252).min().iloc[-1])
        avg_vol = float(vol.rolling(50).mean().iloc[-1])
        cur_vol = float(vol.iloc[-1])

        # RSI
        delta = close.diff()
        gain = delta.clip(lower=0).rolling(14).mean()
        loss = (-delta.clip(upper=0)).rolling(14).mean()
        rs = gain / loss.replace(0, np.nan)
        rsi = float((100 - 100 / (1 + rs)).iloc[-1])

        # Momentum
        mom_3m = float((close.iloc[-1] / close.iloc[-63] - 1) * 100) if len(close) >= 63 else 0
        mom_1m = float((close.iloc[-1] / close.iloc[-21] - 1) * 100) if len(close) >= 21 else 0

        raw = {"price": round(price, 2), "ma50": round(ma50, 2), "ma150": round(ma150, 2),
               "ma200": round(ma200, 2), "rsi": round(rsi, 1), "mom_3m": round(mom_3m, 1),
               "vol_ratio": round(cur_vol / avg_vol, 2) if avg_vol else None,
               "pct_from_high": round((price / high_52w - 1) * 100, 1)}

        # Stage 2 uptrend
        if price > ma50 > ma150 > ma200:
            score += 30; signals.append("Stage 2 uptrend — price > MA50 > MA150 > MA200")
        elif price > ma50 > ma200:
            score += 18; signals.append("Above MA50 and MA200 — partial uptrend")
        elif price > ma200:
            score += 8; signals.append("Above MA200 — long-term support")
        else:
            signals.append("Below MA200 — downtrend warning")

        # Near 52-week high
        pct_from_high = (price / high_52w - 1) * 100
        if pct_from_high >= -5:
            score += 20; signals.append(f"Within 5% of 52w high — leading stock")
        elif pct_from_high >= -15:
            score += 12; signals.append(f"{pct_from_high:.1f}% from 52w high")
        elif pct_from_high >= -25:
            score += 5; signals.append(f"{pct_from_high:.1f}% off highs")
        else:
            signals.append(f"{pct_from_high:.1f}% off 52w high — extended base")

        # RSI
        if 50 <= rsi <= 75:
            score += 20; signals.append(f"RSI {rsi:.0f} — ideal momentum zone")
        elif 40 <= rsi < 50:
            score += 8; signals.append(f"RSI {rsi:.0f} — approaching momentum")
        elif rsi > 80:
            signals.append(f"RSI {rsi:.0f} — overbought, wait for pullback")
        elif rsi < 35:
            signals.append(f"RSI {rsi:.0f} — oversold")

        # Volume
        vol_ratio = cur_vol / avg_vol if avg_vol > 0 else 1
        if vol_ratio >= 2.0:
            score += 15; signals.append(f"Volume surge {vol_ratio:.1f}× avg — institutional activity")
        elif vol_ratio >= 1.5:
            score += 10; signals.append(f"Volume elevated {vol_ratio:.1f}× avg")

        # 3-month momentum
        if mom_3m >= 20:
            score += 15; signals.append(f"Strong 3M momentum +{mom_3m:.1f}%")
        elif mom_3m >= 10:
            score += 8; signals.append(f"3M momentum +{mom_3m:.1f}%")
        elif mom_3m < -15:
            signals.append(f"Negative 3M momentum {mom_3m:.1f}%")

    except Exception as e:
        signals.append(f"Technical analysis error: {e}")

    score = max(0, min(100, score))
    verdict = (
        "Excellent technical setup — Stage 2 uptrend with strong momentum" if score >= 80
        else "Good technical structure — watch for breakout trigger" if score >= 60
        else "Mixed technicals — some positive signals, not a clean setup" if score >= 40
        else "Weak technicals — avoid until price structure improves"
    )
    return {"ticker": ticker, "score": score, "signals": signals[:5], "summary": verdict, "raw": raw}


if __name__ == "__main__":
    import sys, json
    result = analyze(sys.argv[1] if len(sys.argv) > 1 else "NVDA")
    print(json.dumps(result, indent=2))
