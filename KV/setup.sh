#!/bin/bash
# ============================================================
#  Mission Control — Setup Script
#  Stock breakout scanner powered by Claude + Cowork
#
#  Run this once in Terminal after copying the KV folder:
#    chmod +x setup.sh && ./setup.sh
# ============================================================

set -e   # exit on first error

BOLD="\033[1m"
GREEN="\033[0;32m"
CYAN="\033[0;36m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}${CYAN}📡  Mission Control — Setup${RESET}"
echo -e "${CYAN}    S&P 500 Breakout Scanner${RESET}"
echo "    ─────────────────────────────────────────"
echo ""

# ── 1. Detect install location ──────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USERNAME=$(whoami)
DEFAULT_KV="$HOME/Claude/KV"

echo -e "${BOLD}Step 1 — Locating install directory${RESET}"
echo "  Scripts found at: $SCRIPT_DIR"

if [ "$SCRIPT_DIR" != "$DEFAULT_KV" ]; then
  echo -e "${YELLOW}  ⚠  Scripts are not in ~/Claude/KV.${RESET}"
  echo "     For Cowork to find them automatically, they should live at:"
  echo "     $DEFAULT_KV"
  echo ""
  read -p "  Copy scripts to ~/Claude/KV now? [Y/n] " COPY_CONFIRM
  COPY_CONFIRM=${COPY_CONFIRM:-Y}
  if [[ "$COPY_CONFIRM" =~ ^[Yy]$ ]]; then
    mkdir -p "$DEFAULT_KV"
    cp "$SCRIPT_DIR"/*.py "$DEFAULT_KV/" 2>/dev/null || true
    cp "$SCRIPT_DIR/mission_control.html" "$DEFAULT_KV/" 2>/dev/null || true
    echo -e "  ${GREEN}✓  Copied to $DEFAULT_KV${RESET}"
    INSTALL_DIR="$DEFAULT_KV"
  else
    INSTALL_DIR="$SCRIPT_DIR"
  fi
else
  INSTALL_DIR="$SCRIPT_DIR"
  echo -e "  ${GREEN}✓  Already in the right place${RESET}"
fi

echo ""

# ── 2. Check Python ─────────────────────────────────────────
echo -e "${BOLD}Step 2 — Checking Python${RESET}"
if command -v python3 &>/dev/null; then
  PY_VER=$(python3 --version 2>&1)
  echo -e "  ${GREEN}✓  $PY_VER found${RESET}"
  PYTHON=python3
else
  echo -e "  ${RED}✗  Python 3 not found.${RESET}"
  echo "     Install it from https://www.python.org/downloads/"
  echo "     or via Homebrew: brew install python"
  exit 1
fi

# Minimum Python 3.9
PY_MINOR=$(python3 -c "import sys; print(sys.version_info.minor)")
if [ "$PY_MINOR" -lt 9 ]; then
  echo -e "  ${RED}✗  Python 3.9+ required (you have 3.$PY_MINOR)${RESET}"
  exit 1
fi
echo ""

# ── 3. Install Python dependencies ──────────────────────────
echo -e "${BOLD}Step 3 — Installing Python packages${RESET}"
echo "  Installing: yfinance, pandas, numpy, scipy"
echo ""

# Use --user flag for non-venv installs (safe for macOS)
$PYTHON -m pip install --user --quiet --upgrade \
  yfinance pandas numpy scipy 2>&1 | grep -v "^$" | sed 's/^/  /' || {
    echo -e "  ${YELLOW}  Trying with --break-system-packages flag...${RESET}"
    $PYTHON -m pip install --break-system-packages --quiet --upgrade \
      yfinance pandas numpy scipy 2>&1 | grep -v "^$" | sed 's/^/  /'
  }

echo -e "  ${GREEN}✓  All packages installed${RESET}"
echo ""

# ── 4. Verify imports ────────────────────────────────────────
echo -e "${BOLD}Step 4 — Verifying package imports${RESET}"
$PYTHON -c "
import yfinance, pandas, numpy
try:
    from scipy.signal import find_peaks
    print('  ✓  yfinance, pandas, numpy, scipy — all OK')
except ImportError:
    print('  ⚠  scipy not available — VCP detection will use fallback mode')
" 2>&1

echo ""

# ── 5. Quick connectivity test ───────────────────────────────
echo -e "${BOLD}Step 5 — Testing Yahoo Finance connection${RESET}"
$PYTHON -c "
import yfinance as yf, sys
try:
    tk = yf.Ticker('SPY')
    price = tk.info.get('regularMarketPrice') or tk.info.get('currentPrice', 0)
    print(f'  ✓  Connected — SPY current price: \${price:.2f}')
except Exception as e:
    print(f'  ✗  Connection failed: {e}')
    print('     Check your internet connection and try again.')
    sys.exit(1)
" 2>&1
echo ""

# ── 6. Create journal.json if not exists ─────────────────────
echo -e "${BOLD}Step 6 — Initialising trade journal${RESET}"
JOURNAL="$INSTALL_DIR/journal.json"
if [ ! -f "$JOURNAL" ]; then
  echo '{"trades": [], "version": 1}' > "$JOURNAL"
  echo -e "  ${GREEN}✓  journal.json created${RESET}"
else
  TRADE_COUNT=$(python3 -c "import json; d=json.load(open('$JOURNAL')); print(len(d.get('trades',[])))" 2>/dev/null || echo "?")
  echo -e "  ${GREEN}✓  journal.json exists ($TRADE_COUNT trades)${RESET}"
fi
echo ""

# ── 7. Run initial scan ──────────────────────────────────────
echo -e "${BOLD}Step 7 — Running initial scan${RESET}"
echo -e "  ${CYAN}This takes about 60-90 seconds (fetching 22 stocks + news)...${RESET}"
echo ""

cd "$INSTALL_DIR"
$PYTHON run_full_scan.py 2>&1 | sed 's/^/  /'

echo ""

# ── 8. Build dashboard ───────────────────────────────────────
echo -e "${BOLD}Step 8 — Building dashboard${RESET}"
$PYTHON build_dashboard.py 2>&1 | sed 's/^/  /'
echo ""

# ── 9. Open dashboard ────────────────────────────────────────
DASHBOARD="$INSTALL_DIR/mission_control.html"
echo -e "${BOLD}Step 9 — Opening dashboard${RESET}"
if [ -f "$DASHBOARD" ]; then
  echo -e "  ${GREEN}✓  Dashboard ready at:${RESET}"
  echo "     $DASHBOARD"
  echo ""
  read -p "  Open in browser now? [Y/n] " OPEN_CONFIRM
  OPEN_CONFIRM=${OPEN_CONFIRM:-Y}
  if [[ "$OPEN_CONFIRM" =~ ^[Yy]$ ]]; then
    open "$DASHBOARD"
    echo -e "  ${GREEN}✓  Opened in default browser${RESET}"
  fi
else
  echo -e "  ${YELLOW}⚠  Dashboard file not found. Run build_dashboard.py manually.${RESET}"
fi

echo ""
echo "─────────────────────────────────────────────────────────"
echo -e "${BOLD}${GREEN}✅  Setup complete!${RESET}"
echo ""
echo -e "  ${BOLD}Your Mission Control files are at:${RESET}"
echo "  $INSTALL_DIR"
echo ""
echo -e "  ${BOLD}Key files:${RESET}"
echo "  run_full_scan.py      — run a fresh scan anytime"
echo "  build_dashboard.py    — rebuild the dashboard HTML"
echo "  mission_control.html  — open directly in any browser"
echo "  journal.json          — your trade log (persists between runs)"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo "  1. Open Cowork (Claude desktop app)"
echo "  2. Select the KV folder: $INSTALL_DIR"
echo "  3. Ask Claude to set up your scheduled daily scans"
echo "     (Copy the scheduled task prompts from the README)"
echo ""
echo "  See README.md for full usage instructions."
echo "─────────────────────────────────────────────────────────"
echo ""
