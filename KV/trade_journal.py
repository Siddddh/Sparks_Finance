"""
Trade Journal — log, track, and analyse your trades.
Persists to journal.json in the KV folder.
"""
import json, os, glob as _glob
from datetime import datetime

def _find_base():
    for p in _glob.glob("/sessions/*/mnt/KV"):
        if os.path.exists(p):
            return p
    return os.path.expanduser("~/Claude/KV")

BASE         = _find_base()
JOURNAL_PATH = f"{BASE}/journal.json"

# ─────────────────────────────────────────
#  PERSISTENCE
# ─────────────────────────────────────────
def _load() -> dict:
    try:
        with open(JOURNAL_PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"trades": [], "version": 1}

def _save(data: dict):
    with open(JOURNAL_PATH, "w") as f:
        json.dump(data, f, indent=2)

# ─────────────────────────────────────────
#  TRADE OPERATIONS
# ─────────────────────────────────────────
def add_trade(ticker: str, entry_price: float, stop_loss: float, target: float,
              signal_score: float, setup_notes: str = "", signals_triggered: list = None) -> dict:
    data = _load()
    trade = {
        "id":               len(data["trades"]) + 1,
        "ticker":           ticker.upper(),
        "status":           "OPEN",
        "entry_date":       datetime.now().strftime("%Y-%m-%d"),
        "entry_price":      round(entry_price, 2),
        "stop_loss":        round(stop_loss, 2),
        "target":           round(target, 2),
        "exit_date":        None,
        "exit_price":       None,
        "exit_reason":      None,   # "TARGET", "STOP", "TIME_STOP", "MANUAL"
        "pnl_pct":          None,
        "pnl_r":            None,   # profit in R (multiples of risk)
        "signal_score":     signal_score,
        "setup_notes":      setup_notes,
        "signals_triggered": signals_triggered or [],
        "risk_pct":         round((entry_price - stop_loss) / entry_price * 100, 1),
        "reward_pct":       round((target - entry_price) / entry_price * 100, 1),
        "rr_ratio":         round((target - entry_price) / (entry_price - stop_loss), 1)
                            if (entry_price - stop_loss) > 0 else 0,
    }
    data["trades"].append(trade)
    _save(data)
    return trade

def close_trade(trade_id: int, exit_price: float, exit_reason: str = "MANUAL") -> dict:
    data = _load()
    for t in data["trades"]:
        if t["id"] == trade_id and t["status"] == "OPEN":
            t["status"]      = "CLOSED"
            t["exit_date"]   = datetime.now().strftime("%Y-%m-%d")
            t["exit_price"]  = round(exit_price, 2)
            t["exit_reason"] = exit_reason.upper()
            t["pnl_pct"]     = round((exit_price - t["entry_price"]) / t["entry_price"] * 100, 2)
            risk_amt = t["entry_price"] - t["stop_loss"]
            t["pnl_r"]       = round((exit_price - t["entry_price"]) / risk_amt, 2) if risk_amt > 0 else 0
            _save(data)
            return t
    raise ValueError(f"Open trade #{trade_id} not found")

def get_stats() -> dict:
    data  = _load()
    all_t = data["trades"]
    closed = [t for t in all_t if t["status"] == "CLOSED"]
    open_t = [t for t in all_t if t["status"] == "OPEN"]

    if not closed:
        return {
            "total_trades": len(all_t), "closed": 0, "open": len(open_t),
            "wins": 0, "losses": 0, "win_rate": None,
            "avg_win_pct": None, "avg_loss_pct": None,
            "avg_r": None, "expectancy": None,
            "total_pnl_pct": 0, "best_trade": None, "worst_trade": None,
            "open_trades": open_t,
        }

    wins   = [t for t in closed if t["pnl_pct"] and t["pnl_pct"] > 0]
    losses = [t for t in closed if t["pnl_pct"] and t["pnl_pct"] <= 0]

    win_rate    = round(len(wins) / len(closed) * 100, 1) if closed else 0
    avg_win     = round(sum(t["pnl_pct"] for t in wins)   / len(wins), 2)   if wins   else 0
    avg_loss    = round(sum(t["pnl_pct"] for t in losses) / len(losses), 2) if losses else 0
    avg_r       = round(sum(t["pnl_r"]   for t in closed if t["pnl_r"] is not None) / len(closed), 2)
    # Expectancy: (win_rate * avg_win) + (loss_rate * avg_loss)
    expectancy  = round((win_rate/100 * avg_win) + ((1-win_rate/100) * avg_loss), 2)
    total_pnl   = round(sum(t["pnl_pct"] for t in closed if t["pnl_pct"]), 2)

    best  = max(closed, key=lambda t: t["pnl_pct"] or -999)
    worst = min(closed, key=lambda t: t["pnl_pct"] or 999)

    # By exit reason
    by_reason = {}
    for t in closed:
        r = t.get("exit_reason", "OTHER")
        by_reason[r] = by_reason.get(r, 0) + 1

    # By signal — which triggers correlate with wins?
    signal_wins = {}
    for t in closed:
        for sig in (t.get("signals_triggered") or []):
            if sig not in signal_wins:
                signal_wins[sig] = {"wins": 0, "total": 0}
            signal_wins[sig]["total"] += 1
            if t["pnl_pct"] and t["pnl_pct"] > 0:
                signal_wins[sig]["wins"] += 1
    for sig in signal_wins:
        d = signal_wins[sig]
        d["win_rate"] = round(d["wins"] / d["total"] * 100, 0) if d["total"] else 0

    return {
        "total_trades": len(all_t),
        "closed":       len(closed),
        "open":         len(open_t),
        "wins":         len(wins),
        "losses":       len(losses),
        "win_rate":     win_rate,
        "avg_win_pct":  avg_win,
        "avg_loss_pct": avg_loss,
        "avg_r":        avg_r,
        "expectancy":   expectancy,
        "total_pnl_pct": total_pnl,
        "best_trade":   best,
        "worst_trade":  worst,
        "by_exit_reason": by_reason,
        "signal_performance": signal_wins,
        "open_trades":  open_t,
        "closed_trades": sorted(closed, key=lambda t: t["exit_date"] or "", reverse=True)[:20],
    }

def get_all_trades() -> list:
    return _load()["trades"]

# ─────────────────────────────────────────
#  INITIALISE journal if not exists
# ─────────────────────────────────────────
def init_journal():
    if not os.path.exists(JOURNAL_PATH):
        _save({"trades": [], "version": 1})
        print(f"Journal created at {JOURNAL_PATH}")
    else:
        data = _load()
        print(f"Journal loaded: {len(data['trades'])} trades")

if __name__ == "__main__":
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "stats"

    if cmd == "init":
        init_journal()
    elif cmd == "stats":
        init_journal()
        import json
        print(json.dumps(get_stats(), indent=2, default=str))
    elif cmd == "add":
        # python trade_journal.py add NVDA 198.48 182.60 238.18 92.4
        _, _, ticker, entry, stop, target, score = sys.argv
        t = add_trade(ticker, float(entry), float(stop), float(target), float(score))
        print(f"Added trade #{t['id']}: {ticker} @ ${entry}")
    elif cmd == "close":
        # python trade_journal.py close 1 210.00 TARGET
        _, _, trade_id, exit_price, *reason = sys.argv
        t = close_trade(int(trade_id), float(exit_price), reason[0] if reason else "MANUAL")
        print(f"Closed trade #{trade_id}: P&L {t['pnl_pct']:+.1f}% ({t['pnl_r']:+.1f}R)")
