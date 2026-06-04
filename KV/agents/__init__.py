"""
Sparks Finance — Multi-Agent Research Engine (Req #7)

Each agent independently scores one dimension (0-100) and returns:
{
    "ticker": str,
    "score": int,            # 0–100
    "signals": [str, ...],   # up to 5 key observations
    "summary": str,          # 1–2 sentence plain-English verdict
    "raw": dict,             # raw data used
}

Run all agents:
    python agents/run_agents.py TICKER
"""
