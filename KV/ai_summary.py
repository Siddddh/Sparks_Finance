"""
ai_summary.py — AI Dashboard Summary (Req #5)

Fetches the user's portfolio performance + today's scan data + market health,
generates a structured intelligence report, and pushes the result to Firestore
under ai_reports/{uid}/reports/{date}.

V1 MODE: Pure rule-based logic — no API keys required.
V2 MODE: Set USE_CLAUDE = True to upgrade to Claude-generated narratives.

Usage:
    python ai_summary.py <uid>
    python ai_summary.py <uid> --dry-run   # print report, skip Firestore push
"""

import sys
import json
import argparse
from datetime import date, datetime
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

# ── V1/V2 toggle ──────────────────────────────────────────────────────────────
USE_CLAUDE = False   # Set True in V2 to activate Claude API

try:
    import firebase_admin
    from firebase_admin import credentials, firestore
    FIREBASE_AVAILABLE = True
except ImportError:
    FIREBASE_AVAILABLE = False

MODEL_DEFAULT = "claude-sonnet-4-6"

# ── Firebase ───────────────────────────────────────────────────────────────────

def get_db():
    if not FIREBASE_AVAILABLE:
        raise RuntimeError("firebase-admin not installed.")
    if not firebase_admin._apps:
        cred = credentials.Certificate("firebase_service_account.json")
        firebase_admin.initialize_app(cred)
    return firestore.client()

# ── Data gathering ─────────────────────────────────────────────────────────────

def gather_context(db, uid: str) -> dict:
    today = date.today().isoformat()
    ctx = {"uid": uid, "date": today, "portfolios": [], "market": {}, "top_picks": []}

    # ── Load scan data first so we can use live prices for holdings ──
    scan_doc = db.collection("scans").document("latest").get()
    scan_prices = {}  # ticker -> live price from latest scan
    if scan_doc.exists:
        scan = scan_doc.to_dict()
        mh = scan.get("market_health", {})
        ctx["market"] = {
            "state": mh.get("market_state", "Unknown"),
            "advice": mh.get("state_advice", ""),
            "vix": mh.get("vix"),
            "vix_label": mh.get("vix_label", ""),
            "spy_trend": "Above MA50" if mh.get("spy_above_50") else "Below MA50",
            "dist_days": mh.get("dist_days", 0),
            "breadth_pct": mh.get("breadth_pct"),
        }
        picks = scan.get("stocks", [])
        # Build price lookup from scan data
        for s in picks:
            if s.get("ticker") and s.get("price"):
                scan_prices[s["ticker"]] = float(s["price"])
        strong_buys = [s for s in picks if s.get("signal") == "STRONG BUY"][:5]
        ctx["top_picks"] = [
            {"ticker": s["ticker"], "score": s.get("combined_score", 0),
             "sector": s.get("sector", ""), "thesis": s.get("thesis_summary", s.get("thesis", "")[:120])}
            for s in strong_buys
        ]

    # ── Portfolio holdings — compute performance on the fly ──
    pf_snap = db.collection("portfolios").document(uid).collection("list").stream()
    for pf_doc in pf_snap:
        pf = pf_doc.to_dict()
        pfid = pf_doc.id
        holdings_snap = db.collection("holdings").document(uid).collection(pfid).stream()
        holdings = []
        for h in holdings_snap:
            hd = h.to_dict()
            ticker    = hd.get("ticker", "").upper()
            qty       = float(hd.get("qty", 0))
            buy_price = float(hd.get("buy_price", 0))
            buy_date_raw = hd.get("buy_date") or hd.get("added_at", "")
            buy_date  = buy_date_raw[:10] if buy_date_raw else ""
            # Use scan live price if available, otherwise fall back to stored or buy_price
            cur_price = (
                scan_prices.get(ticker)
                or float(hd.get("current_price", 0))
                or buy_price
            )
            gain_pct = ((cur_price / buy_price) - 1) * 100 if buy_price > 0 else 0
            # Days held
            days_held = None
            if buy_date:
                try:
                    from datetime import date as _date
                    days_held = (_date.today() - _date.fromisoformat(buy_date)).days
                except Exception:
                    pass
            # Annualised return
            ann_ret = None
            if days_held and days_held >= 7:
                ann_ret = round(((1 + gain_pct / 100) ** (365 / days_held) - 1) * 100, 1)
            holdings.append({
                "ticker":        ticker,
                "qty":           qty,
                "buy_price":     buy_price,
                "buy_date":      buy_date,
                "days_held":     days_held,
                "ann_ret":       ann_ret,
                "current_price": cur_price,
                "gain_pct":      round(gain_pct, 2),
                "value":         round(qty * cur_price, 2),
                "cost":          round(qty * buy_price, 2),
                "notes":         hd.get("notes", ""),
            })

        # Compute portfolio-level stats directly from holdings
        total_value    = sum(h["value"] for h in holdings)
        total_cost     = sum(h["cost"]  for h in holdings)
        total_gain_abs = total_value - total_cost
        total_gain_pct = ((total_gain_abs / total_cost) * 100) if total_cost > 0 else 0
        sorted_by_gain = sorted(holdings, key=lambda x: x["gain_pct"], reverse=True)
        top_gainers    = [{"ticker": h["ticker"], "gain_pct": h["gain_pct"]} for h in sorted_by_gain[:3] if h["gain_pct"] > 0]
        biggest_losers = [{"ticker": h["ticker"], "gain_pct": h["gain_pct"]} for h in sorted_by_gain[-3:] if h["gain_pct"] < 0]

        ctx["portfolios"].append({
            "name":           pf.get("name", pfid),
            "total_value":    round(total_value, 2)    if total_value    else None,
            "total_gain_pct": round(total_gain_pct, 2) if total_gain_pct else None,
            "total_gain_abs": round(total_gain_abs, 2) if total_gain_abs else None,
            "top_gainers":    top_gainers,
            "biggest_losers": biggest_losers,
            "holdings":       holdings,
        })

    # Active personal alerts
    try:
        alerts_snap = db.collection("alerts").document(uid).collection("list").where("status", "==", "active").stream()
        ctx["active_alerts"] = [a.to_dict() for a in alerts_snap]
    except Exception:
        ctx["active_alerts"] = []

    return ctx

# ── Prompt building ────────────────────────────────────────────────────────────

def build_prompt(ctx: dict) -> str:
    lines = [
        f"Today's date: {ctx['date']}",
        f"Market State: {ctx['market'].get('state', 'Unknown')} — {ctx['market'].get('advice', '')}",
        f"VIX: {ctx['market'].get('vix', '—')} ({ctx['market'].get('vix_label', '')})",
        f"SPY Trend: {ctx['market'].get('spy_trend', '—')}",
        f"Distribution Days: {ctx['market'].get('dist_days', 0)}",
        "",
    ]

    if ctx["portfolios"]:
        lines.append("=== PORTFOLIOS ===")
        for pf in ctx["portfolios"]:
            lines.append(f"\nPortfolio: {pf['name']}")
            if pf.get("total_value"):
                lines.append(f"  Value: ${pf['total_value']:,.2f} | Gain: ${pf.get('total_gain_abs',0):+,.2f} ({pf.get('total_gain_pct',0):+.2f}%)")
            if pf["holdings"]:
                for h in pf["holdings"]:
                    lines.append(f"  {h['ticker']}: {h['qty']} shares @ ${h['buy_price']} → gain {h.get('gain_pct',0):+.1f}%")
            if pf.get("top_gainers"):
                lines.append("  Top gainers: " + ", ".join(f"{g['ticker']} {g['gain_pct']:+.1f}%" for g in pf["top_gainers"]))
            if pf.get("biggest_losers"):
                lines.append("  Biggest losers: " + ", ".join(f"{g['ticker']} {g['gain_pct']:+.1f}%" for g in pf["biggest_losers"]))
    else:
        lines.append("No portfolio holdings found.")

    if ctx["top_picks"]:
        lines.append("\n=== TOP MARKET OPPORTUNITIES (STRONG BUY) ===")
        for p in ctx["top_picks"]:
            lines.append(f"  {p['ticker']} (score {p['score']}) — {p['sector']} — {p['thesis']}")

    if ctx["active_alerts"]:
        lines.append(f"\n=== ACTIVE ALERTS ({len(ctx['active_alerts'])}) ===")
        for a in ctx["active_alerts"][:5]:
            lines.append(f"  {a.get('ticker')}: {a.get('condition')} @ {a.get('threshold', '—')}")

    data_summary = "\n".join(lines)

    return f"""You are a professional portfolio intelligence analyst for Sparks Finance.

Based on the following real-time data, generate a concise daily intelligence report for the investor.

{data_summary}

Write a structured report with exactly these four sections. Be specific, direct, and actionable.
Use plain text — no markdown headers, no bullet symbols, just clean numbered lists inside each section.

SECTION 1 — PORTFOLIO PERFORMANCE
Summarize portfolio status, total value, gains/losses, best and worst positions.
If no portfolio data exists, note that and focus on market context.

SECTION 2 — TOP OPPORTUNITIES
Identify 2–3 specific actionable opportunities from the market scan data or portfolio.
Each should include the ticker, why it's interesting, and what to watch for.

SECTION 3 — KEY RISKS
Identify 2–3 specific risks facing the portfolio or current market environment.
Include stock-specific risks and macro risks.

SECTION 4 — RECOMMENDED ACTIONS
Give 3–5 clear, specific actions the investor should take today or this week.
Be direct — buy, sell, watch, trim, or hold specific positions."""


# ── V1: Rule-based report generator ───────────────────────────────────────────

def template_summary(ctx: dict) -> tuple[dict, str]:
    """
    Generates a structured intelligence report from real portfolio + market data.
    Uses the same thesis_generator sentence-assembly pattern — no API required.
    """
    try:
        from thesis_generator import generate_thesis
    except ImportError:
        generate_thesis = None

    perf_lines = []
    opp_lines = []
    risk_lines = []
    action_lines = []

    # ── SECTION 1: Portfolio Performance ──────────────────────────────────────
    all_holdings = [h for pf in ctx["portfolios"] for h in pf.get("holdings", [])]
    total_pf_count = len(ctx["portfolios"])
    total_val = sum(pf.get("total_value") or 0 for pf in ctx["portfolios"])
    total_gain_abs = sum(pf.get("total_gain_abs") or 0 for pf in ctx["portfolios"])
    total_cost = total_val - total_gain_abs
    total_gain_pct = (total_gain_abs / total_cost * 100) if total_cost > 0 else 0

    if total_val > 0:
        gain_word = "gain" if total_gain_abs >= 0 else "loss"
        perf_lines.append(
            f"Your {total_pf_count} portfolio(s) total ${total_val:,.2f} with an unrealised "
            f"{gain_word} of ${abs(total_gain_abs):,.2f} ({total_gain_pct:+.1f}%)."
        )
    else:
        perf_lines.append("No portfolio holdings found yet. Add holdings in the Portfolio tab to track performance.")

    if all_holdings:
        winners = [h for h in all_holdings if (h.get("gain_pct") or 0) > 0]
        losers  = [h for h in all_holdings if (h.get("gain_pct") or 0) < 0]
        if winners:
            best = max(winners, key=lambda x: x.get("gain_pct", 0))
            held_str = f" in {best['days_held']}d" if best.get("days_held") else ""
            ann_str  = f" ({best['ann_ret']:+.0f}%/yr)" if best.get("ann_ret") else ""
            perf_lines.append(f"Best performer: {best['ticker']} +{best['gain_pct']:.1f}%{ann_str} from entry{held_str}.")
        if losers:
            worst = min(losers, key=lambda x: x.get("gain_pct", 0))
            held_str = f" in {worst['days_held']}d" if worst.get("days_held") else ""
            perf_lines.append(f"Biggest drag: {worst['ticker']} {worst['gain_pct']:.1f}% from entry{held_str}.")
        big_winners = [h for h in all_holdings if (h.get("gain_pct") or 0) > 30]
        for h in big_winners[:2]:
            trail_stop = h.get("current_price", 0) * 0.88
            action_lines.append(
                f"Set trailing stop on {h['ticker']} at ${trail_stop:.2f} "
                f"(12% trail) to protect the +{h['gain_pct']:.1f}% gain."
            )
        struggling = [h for h in all_holdings if (h.get("gain_pct") or 0) < -12]
        for h in struggling[:2]:
            exit_hard = h.get("buy_price", 0) * 0.85
            perf_lines.append(f"{h['ticker']} is down {abs(h['gain_pct']):.1f}% — approaching thesis review territory.")
            action_lines.append(
                f"{h['ticker']} approaching stop territory — exit if it closes below ${exit_hard:.2f}."
            )

    mkt = ctx.get("market", {})
    state = mkt.get("state", "Unknown")
    advice = mkt.get("advice", "")
    perf_lines.append(f"Market is in {state}. {advice}")

    # ── SECTION 2: Top Opportunities ──────────────────────────────────────────
    picks = ctx.get("top_picks", [])
    if picks:
        for i, p in enumerate(picks[:3], 1):
            thesis_text = p.get("thesis", "")
            if not thesis_text and generate_thesis:
                # Build a minimal stock dict that thesis_generator understands
                mini = {
                    "ticker": p["ticker"], "score": p["score"], "combined_score": p["score"],
                    "signal": "STRONG BUY", "price": 0, "ma50": 0, "ma200": 0,
                    "is_vcp": False, "vcp_contractions": 0, "vcp_tightest_pct": 100,
                    "rs_ok": False, "rs_4w_change": 0, "rs_pct_from_high": 0,
                    "vdu_ratio": 1.0, "is_vdu": False, "vol_ratio": 1.0, "rsi": 60,
                    "pct_from_high": -10, "momentum_3m": 10, "eps_growth": 20,
                    "rev_growth": 10, "fwd_pe": None, "short_pct_float": 3,
                    "days_to_cover": 3, "squeeze_potential": "NONE",
                    "earnings_flag": "", "days_to_earnings": 45,
                    "insider_ok": False, "insider_label": "",
                    "is_pocket_pivot": False, "range_contraction": 1.0,
                    "news_sentiment": "NEUTRAL", "top_news": [],
                    "entry": 0, "stop_loss": 0, "target_1": 0, "rr_ratio": 2.5,
                    "criteria": {"trend_ok": True, "near_high": True, "rsi_ok": True,
                                 "volume_ok": True, "eps_ok": True, "rev_ok": True,
                                 "vcp_ok": False, "rs_ok": False, "vdu_ok": False, "insider_ok": False},
                }
                try:
                    thesis_text = generate_thesis(mini)["thesis"]
                except Exception:
                    thesis_text = f"Score {p['score']}/100 in the {p.get('sector', 'market')} sector."
            opp_lines.append(f"{i}. {p['ticker']} (Score {p['score']}) — {thesis_text}")
    else:
        opp_lines.append("No STRONG BUY setups in today's scan. Run a full scan to find opportunities.")

    # Top action from picks
    if picks:
        top = picks[0]
        action_lines.insert(0,
            f"{top['ticker']} is the #1 setup today (score {top['score']}) — "
            f"watch for a volume breakout above its 52-week high."
        )

    # ── SECTION 3: Key Risks ───────────────────────────────────────────────────
    dist_days = mkt.get("dist_days", 0)
    vix = mkt.get("vix") or 0
    breadth = mkt.get("breadth_pct") or 100

    if state in ("UNDER PRESSURE", "CORRECTION"):
        risk_lines.append(
            f"Market is in {state} — avoid new buys. Wait for a follow-through day (up 1.25%+ on rising volume) before re-entering."
        )
        action_lines.append("Hold cash — market not in confirmed uptrend. No new buys until follow-through day confirmed.")
    if dist_days >= 4:
        risk_lines.append(
            f"Distribution day count elevated at {dist_days} — institutional selling pressure building. Reduce new position sizes."
        )
        action_lines.append("Reduce new position sizes to half until distribution day count falls below 4.")
    if vix > 20:
        risk_lines.append(f"VIX elevated at {vix:.1f} — above-average market volatility. Size all positions conservatively.")
    if breadth < 50:
        risk_lines.append(f"Market breadth weak at {breadth:.0f}% — fewer than half of stocks above their moving averages.")

    # Per-holding fundamental risks
    for h in all_holdings[:5]:
        if (h.get("gain_pct") or 0) < -12:
            risk_lines.append(f"{h['ticker']} down {abs(h.get('gain_pct', 0)):.1f}% from your entry — original thesis needs review.")

    # Concentration risk
    if all_holdings:
        sectors = [h.get("sector", "") for h in all_holdings if h.get("sector")]
        if sectors and sectors.count(sectors[0]) == len(sectors) and len(sectors) > 1:
            risk_lines.append(f"Portfolio 100% concentrated in {sectors[0]} — consider diversification into other sectors.")

    if not risk_lines:
        risk_lines.append("No major risk flags detected. Market conditions are healthy. Maintain discipline on position sizing.")

    # ── SECTION 4: Recommended Actions ────────────────────────────────────────
    # Add earnings catalyst actions
    for a in ctx.get("active_alerts", [])[:3]:
        if a.get("condition") == "major_news":
            action_lines.append(f"Active alert on {a.get('ticker', '?')} — review before opening any new position.")

    if len(action_lines) == 0:
        n_picks = len(picks)
        action_lines.append(f"Scan shows {n_picks} STRONG BUY setup(s) — review each on the Top Picks tab.")
        action_lines.append("Ensure all open positions have defined stop-loss levels.")
        action_lines.append("Run a fresh full scan before the market open for updated signals.")

    # Number the action lines
    numbered_actions = "\n".join(f"{i+1}. {a}" for i, a in enumerate(action_lines[:6]))

    sections = {
        "performance":   "\n".join(perf_lines),
        "opportunities": "\n".join(opp_lines),
        "risks":         "\n".join(risk_lines),
        "actions":       numbered_actions,
    }
    raw = "\n\n".join(f"[{k.upper()}]\n{v}" for k, v in sections.items())
    return sections, raw


# ── V2: Claude API call (activated when USE_CLAUDE = True) ────────────────────

def call_claude(prompt: str, model: str = MODEL_DEFAULT) -> tuple[dict, str]:
    import anthropic
    client = anthropic.Anthropic()
    response = client.messages.create(
        model=model,
        max_tokens=2048,
        system="You are a professional stock market analyst and portfolio advisor. Be concise, specific, and data-driven.",
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response.content[0].text
    sections = {"performance": "", "opportunities": "", "risks": "", "actions": ""}
    current = None
    buffer = []
    section_markers = {"SECTION 1": "performance", "SECTION 2": "opportunities",
                       "SECTION 3": "risks", "SECTION 4": "actions"}
    for line in raw.splitlines():
        matched = False
        for marker, key in section_markers.items():
            if marker in line.upper():
                if current and buffer:
                    sections[current] = "\n".join(buffer).strip()
                current = key; buffer = []; matched = True; break
        if not matched and current:
            buffer.append(line)
    if current and buffer:
        sections[current] = "\n".join(buffer).strip()
    return sections, raw


# ── Push to Firestore ──────────────────────────────────────────────────────────

def push_report(db, uid: str, sections: dict, raw: str):
    today = date.today().isoformat()
    doc = {
        "uid": uid,
        "generated_at": datetime.utcnow().isoformat(),
        "performance": sections.get("performance", ""),
        "opportunities": sections.get("opportunities", ""),
        "risks": sections.get("risks", ""),
        "actions": sections.get("actions", ""),
        "raw": raw,
    }
    db.collection("ai_reports").document(uid).collection("reports").document(today).set(doc)
    print(f"  AI report pushed for uid={uid} date={today}")


# ── Main ───────────────────────────────────────────────────────────────────────

def run(uid: str, model: str = MODEL_DEFAULT, dry_run: bool = False):
    print(f"Generating report for {uid}… (mode: {'Claude API' if USE_CLAUDE else 'rule-based'})")
    db = get_db()
    ctx = gather_context(db, uid)
    print(f"  Portfolios: {len(ctx['portfolios'])}  |  Top picks: {len(ctx['top_picks'])}  |  Alerts: {len(ctx['active_alerts'])}")

    if USE_CLAUDE:
        prompt = build_prompt(ctx)
        print(f"  Calling Claude ({model})…")
        sections, raw = call_claude(prompt, model)
    else:
        sections, raw = template_summary(ctx)

    if dry_run:
        print("\n── Intelligence Report (dry run) ──")
        for k, v in sections.items():
            print(f"\n[{k.upper()}]\n{v}")
        return sections

    push_report(db, uid, sections, raw)
    print("Done.")
    return sections


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sparks Finance — AI Summary Generator")
    parser.add_argument("uid", help="Firebase user UID")
    parser.add_argument("--model", default=MODEL_DEFAULT, help="Claude model to use")
    parser.add_argument("--dry-run", action="store_true", help="Print report without pushing to Firestore")
    args = parser.parse_args()

    run(args.uid, model=args.model, dry_run=args.dry_run)
