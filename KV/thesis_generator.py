"""
AI Trade Thesis Generator
Produces a plain-English trade narrative for each stock based on its scored metrics.
Educational: explains WHY a stock scores the way it does and what to watch for.
"""

def generate_thesis(s: dict) -> dict:
    """
    s: a fully-scored stock dict from breakout_scanner.score_stock()
    Returns: { thesis, setup_quality, key_strengths, key_risks, what_to_watch }
    """
    ticker  = s.get("ticker", "")
    name    = s.get("name", ticker).split(",")[0].split("Inc")[0].strip()
    score   = s.get("combined_score") or s.get("score", 0)
    signal  = s.get("signal", "WEAK")
    price   = s.get("price", 0)

    # ── Pull all signals ──
    trend_ok   = s.get("criteria", {}).get("trend_ok", False)
    near_high  = s.get("criteria", {}).get("near_high", False)
    rsi_ok     = s.get("criteria", {}).get("rsi_ok", False)
    volume_ok  = s.get("criteria", {}).get("volume_ok", False)
    eps_ok     = s.get("criteria", {}).get("eps_ok", False)
    rev_ok     = s.get("criteria", {}).get("rev_ok", False)
    vcp_ok     = s.get("criteria", {}).get("vcp_ok", False)
    rs_ok      = s.get("criteria", {}).get("rs_ok", False)
    vdu_ok     = s.get("criteria", {}).get("vdu_ok", False)
    insider_ok = s.get("criteria", {}).get("insider_ok", False)

    is_vcp     = s.get("is_vcp", False)
    vcp_label  = s.get("vcp_label", "")
    rs_label   = s.get("rs_label", "")
    vdu_ratio  = s.get("vdu_ratio", 1.0)
    vol_ratio  = s.get("vol_ratio", 1.0)
    rsi        = s.get("rsi", 50)
    pct_high   = s.get("pct_from_high", -50)
    mom_3m     = s.get("momentum_3m", 0)
    eps        = s.get("eps_growth")
    rev        = s.get("rev_growth")
    fwd_pe     = s.get("fwd_pe")
    short_pct  = s.get("short_pct_float", 0)
    dtc        = s.get("days_to_cover", 0)
    squeeze    = s.get("squeeze_potential", "NONE")
    earn_label = s.get("earnings_label", "")
    earn_days  = s.get("days_to_earnings")
    earn_flag  = s.get("earnings_flag", "")
    insider_l  = s.get("insider_label", "")
    pp         = s.get("is_pocket_pivot", False)
    rs_4w      = s.get("rs_4w_change", 0)
    vcp_cont   = s.get("vcp_contractions", 0)
    tight      = s.get("vcp_tightest_pct", 100)
    news_sent  = s.get("news_sentiment", "NEUTRAL")
    top_news   = s.get("top_news", [])
    ma50       = s.get("ma50", 0)
    ma200      = s.get("ma200", 0)

    strengths = []
    risks     = []
    watches   = []

    # ── TREND ──
    if trend_ok:
        strengths.append(f"confirmed Stage 2 uptrend (price ${price} above MA50 ${ma50:.0f} and MA200 ${ma200:.0f})")
    else:
        risks.append("not in a clean Stage 2 uptrend — MAs not stacked bullishly yet")

    # ── VCP ──
    if is_vcp:
        strengths.append(f"VCP pattern with {vcp_cont} contractions, tightest pullback {tight:.1f}% — classic coiled-spring setup")
        if tight < 5:
            strengths.append("extremely tight base (sub-5% contraction) — high-velocity breakout potential")
    elif s.get("range_contraction", 1.0) < 0.7:
        strengths.append("price action tightening significantly — early VCP forming")

    # ── RS LINE ──
    if rs_ok:
        strengths.append(f"Relative Strength line at new highs vs S&P 500 — institutional accumulation leading price")
    elif rs_4w > 3:
        strengths.append(f"RS line rising {rs_4w:.1f}% in last 4 weeks — outperforming the market")
    else:
        risks.append(f"RS line {s.get('rs_pct_from_high', 0):.0f}% off its high — underperforming the market somewhat")

    # ── VOLUME DRY-UP ──
    if vdu_ok:
        strengths.append(f"volume dried up to {vdu_ratio:.0%} of average — sellers exhausted, stock is resting not distributing")
    elif vol_ratio >= 1.5 and trend_ok:
        strengths.append(f"volume surge {vol_ratio:.1f}× average today — institutional demand showing up")

    # ── POCKET PIVOT ──
    if pp:
        strengths.append("pocket pivot detected today — early institutional entry signal, ahead of formal breakout")

    # ── EARNINGS ──
    if earn_flag == "CATALYST":
        strengths.append(f"earnings in {earn_days} days — in the optimal pre-earnings catalyst window (7-14 days)")
        watches.append(f"sell at least half position before earnings to avoid binary event risk")
    elif earn_flag == "HIGH_RISK":
        risks.append(f"earnings in {earn_days} day(s) — AVOID new entries this close to a binary event")
    elif earn_flag == "UPCOMING":
        watches.append(f"earnings in {earn_days} days — monitor for pre-earnings drift opportunity")

    # ── FUNDAMENTALS ──
    if eps_ok and eps is not None:
        strengths.append(f"EPS growing {eps:.0f}% year-over-year — institutional-grade earnings momentum")
    elif eps is not None and eps > 0:
        strengths.append(f"earnings growing {eps:.0f}% YoY — positive but below the 20% threshold")
    else:
        risks.append("earnings growth below 20% threshold — weak fundamental backdrop")

    if rev_ok and rev is not None:
        strengths.append(f"revenue up {rev:.0f}% YoY confirming earnings growth is real and sustained")

    if fwd_pe and fwd_pe < 25:
        strengths.append(f"reasonable valuation at {fwd_pe:.1f}× forward earnings for a growth stock")
    elif fwd_pe and fwd_pe > 50:
        risks.append(f"elevated valuation at {fwd_pe:.1f}× forward P/E — requires flawless execution")

    # ── SHORT INTEREST ──
    if squeeze == "HIGH":
        strengths.append(f"high short interest ({short_pct:.1f}% of float, {dtc:.1f} days to cover) — squeeze fuel ready")
    elif squeeze == "MEDIUM":
        strengths.append(f"moderate short interest ({short_pct:.1f}% float) — some squeeze potential on breakout")

    # ── INSIDER ──
    if insider_ok:
        strengths.append(f"insider activity: {insider_l}")

    # ── NEWS ──
    if news_sent in ("BULLISH", "SLIGHTLY BULLISH") and top_news:
        headline = top_news[0].get("title", "")[:80]
        outlet   = top_news[0].get("outlet", "")
        strengths.append(f"news flow bullish — \"{headline}…\" ({outlet})")
    elif news_sent in ("BEARISH", "SLIGHTLY BEARISH"):
        risks.append("recent news flow negative — monitor sentiment shift")

    # ── RSI ──
    if rsi_ok:
        watches.append(f"RSI at {rsi:.0f} — momentum healthy, watch for RSI to stay above 50 on any pullback")
    elif rsi > 75:
        risks.append(f"RSI at {rsi:.0f} — overbought short-term, wait for a pullback or tighter entry")
    else:
        risks.append(f"RSI at {rsi:.0f} — below 50, momentum hasn't confirmed yet")

    # ── 52w HIGH PROXIMITY ──
    if near_high and pct_high >= -5:
        watches.append(f"price is just {abs(pct_high):.1f}% from 52-week high at ${s.get('high_52w', 0):.2f} — that level is key resistance/breakout point")
    elif near_high:
        watches.append(f"price is {abs(pct_high):.1f}% from 52-week high — needs to reclaim that level to confirm breakout")

    # ── 3-MONTH MOMENTUM ──
    if mom_3m > 20:
        strengths.append(f"{mom_3m:.0f}% gain in 3 months — strong momentum, institutions are building positions")
    elif mom_3m < -10:
        risks.append(f"{abs(mom_3m):.0f}% decline in 3 months — needs to stabilize before a tradeable breakout")

    # ── WHAT TO WATCH ──
    if not watches:
        if signal == "STRONG BUY":
            watches.append(f"watch for breakout above ${s.get('high_52w', 0):.2f} on volume ≥1.5× average — that's your entry trigger")
        elif signal == "WATCH":
            watches.append("watch for volume to confirm next move up, or VCP to tighten further")

    # ── BUILD NARRATIVE ──
    parts = []

    # Opening
    if signal == "STRONG BUY":
        opening = f"{ticker} is one of the highest-quality setups in our universe right now with a score of {score}."
    elif signal == "WATCH":
        opening = f"{ticker} is building toward a tradeable setup — on the watchlist with a score of {score}."
    else:
        opening = f"{ticker} scores {score} — not a high-conviction setup at this time."

    parts.append(opening)

    # Trend + pattern
    if trend_ok and is_vcp:
        parts.append(
            f"It's in a confirmed Stage 2 uptrend and has formed a VCP with {vcp_cont} contractions "
            f"(tightest: {tight:.1f}%) — the textbook pre-breakout coiling that Minervini built his career on."
        )
    elif trend_ok:
        parts.append(f"The stock is in a clean Stage 2 uptrend with price above its MA50, MA150, and MA200.")

    # RS + VDU
    if rs_ok and vdu_ok:
        parts.append(
            f"The RS line is at new highs vs the S&P 500 — a sign institutions are accumulating ahead of price. "
            f"Volume has dried up to {vdu_ratio:.0%} of its average, meaning sellers have left the building."
        )
    elif rs_ok:
        parts.append(f"The RS line is at new highs — this stock is leading the market, not just riding it.")
    elif vdu_ok:
        parts.append(f"Volume has dried up significantly ({vdu_ratio:.0%} of average) — classic consolidation before a move.")

    # Earnings catalyst
    if earn_flag == "CATALYST":
        parts.append(
            f"With earnings {earn_days} days away, this is in the optimal pre-earnings catalyst window. "
            f"Strong growth stocks often run 10-20% into their report."
        )

    # Fundamentals
    if eps_ok and rev_ok:
        parts.append(
            f"Fundamentals back it up: EPS +{eps:.0f}% and revenue +{rev:.0f}% YoY — "
            f"the kind of numbers that attract institutional money."
        )

    # Key risk
    if risks:
        main_risk = risks[0]
        parts.append(f"Key risk to monitor: {main_risk}.")

    # Trade setup
    parts.append(
        f"Trade setup: entry at ${s.get('entry', price):.2f}, stop at ${s.get('stop_loss', 0):.2f} (–8%), "
        f"target ${s.get('target_1', 0):.2f} (+20%). Risk/reward: {s.get('rr_ratio', 2.5)}:1."
    )

    thesis = " ".join(parts)

    # ── Setup quality label ──
    if score >= 85:   quality = "A+"
    elif score >= 75: quality = "A"
    elif score >= 65: quality = "B+"
    elif score >= 55: quality = "B"
    elif score >= 45: quality = "C"
    else:             quality = "D"

    return {
        "thesis":        thesis,
        "setup_quality": quality,
        "key_strengths": strengths[:4],
        "key_risks":     risks[:3],
        "what_to_watch": watches[:3],
    }


if __name__ == "__main__":
    # Quick test
    sample = {
        "ticker": "AMD", "name": "Advanced Micro Devices", "price": 341.54,
        "combined_score": 98.2, "score": 98.2, "signal": "STRONG BUY",
        "ma50": 238.2, "ma200": 212.29, "is_vcp": True, "vcp_contractions": 6,
        "vcp_tightest_pct": 7.1, "vcp_label": "VCP ✓", "rs_at_high": False,
        "rs_pct_from_high": -5.0, "rs_4w_change": 8.2, "rs_label": "RS -5% from high",
        "vdu_ratio": 0.45, "is_vdu": True, "vdu_label": "Vol dry-up ✓",
        "vol_ratio": 1.04, "rsi": 73.9, "pct_from_high": -5.3, "momentum_3m": 41.1,
        "eps_growth": 217.1, "rev_growth": 34.1, "fwd_pe": 30.6,
        "short_pct_float": 2.2, "days_to_cover": 1.1, "squeeze_potential": "NONE",
        "earnings_flag": "HIGH_RISK", "days_to_earnings": 1, "earnings_label": "⚠️ Earnings in 1d",
        "insider_buying": False, "insider_label": "No recent activity",
        "is_pocket_pivot": False, "range_contraction": 0.52,
        "news_sentiment": "NEUTRAL", "top_news": [],
        "entry": 341.54, "stop_loss": 314.22, "target_1": 409.85, "rr_ratio": 2.5,
        "criteria": {"trend_ok": True, "near_high": True, "rsi_ok": True,
                     "volume_ok": False, "eps_ok": True, "rev_ok": True,
                     "vcp_ok": True, "rs_ok": False, "vdu_ok": True, "insider_ok": False},
    }
    t = generate_thesis(sample)
    print("THESIS:", t["thesis"])
    print("\nQuality:", t["setup_quality"])
    print("Strengths:", t["key_strengths"])
    print("Risks:", t["key_risks"])
    print("Watch:", t["what_to_watch"])
