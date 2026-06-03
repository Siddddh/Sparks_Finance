#!/bin/bash
# ============================================================
#  Mission Control — Firebase Deploy Script
#  Deploys the hosted dashboard + Firestore rules
#
#  Prerequisites (one-time):
#    npm install -g firebase-tools
#    firebase login
#
#  Usage:
#    chmod +x deploy.sh && ./deploy.sh
# ============================================================

set -e
BOLD="\033[1m"; GREEN="\033[0;32m"; CYAN="\033[0;36m"
YELLOW="\033[1;33m"; RED="\033[0;31m"; RESET="\033[0m"
KV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${BOLD}${CYAN}🚀  Mission Control — Firebase Deploy${RESET}"
echo ""

# ── 1. Verify firebase CLI ──
if ! command -v firebase &>/dev/null; then
  echo -e "${RED}✗  firebase CLI not found.${RESET}"
  echo "   Install it: npm install -g firebase-tools"
  echo "   Then login: firebase login"
  exit 1
fi
echo -e "${GREEN}✓  firebase CLI found: $(firebase --version)${RESET}"

# ── 2. Verify config files ──
if [ ! -f "$KV_DIR/firebase_config.json" ]; then
  echo -e "${RED}✗  Missing firebase_config.json${RESET}"
  echo "   Copy firebase_config.template.json → firebase_config.json"
  echo "   Fill in your Firebase web app credentials."
  exit 1
fi

if [ ! -f "$KV_DIR/firebase_service_account.json" ]; then
  echo -e "${YELLOW}⚠  firebase_service_account.json not found.${RESET}"
  echo "   Hosting deploy will still work, but Python → Firestore push won't."
  echo "   Get it from: Firebase Console → Project Settings → Service Accounts"
fi

# ── 3. Verify project ID is set ──
PROJECT_ID=$(python3 -c "import json; print(json.load(open('$KV_DIR/firebase_config.json'))['projectId'])" 2>/dev/null || echo "")
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "YOUR_PROJECT_ID" ]; then
  echo -e "${RED}✗  projectId not set in firebase_config.json${RESET}"
  exit 1
fi
echo -e "${GREEN}✓  Project: $PROJECT_ID${RESET}"

# Update .firebaserc with actual project ID
sed -i '' "s/YOUR_FIREBASE_PROJECT_ID/$PROJECT_ID/g" "$KV_DIR/.firebaserc" 2>/dev/null || \
  sed -i "s/YOUR_FIREBASE_PROJECT_ID/$PROJECT_ID/g" "$KV_DIR/.firebaserc"

# ── 4. Build the hosted HTML with the Firebase config ──
echo ""
echo -e "${BOLD}Step 1 — Building hosted dashboard${RESET}"
python3 "$KV_DIR/build_hosted_dashboard.py"
echo -e "${GREEN}✓  firebase_hosting/index.html built${RESET}"

# ── 5. Install python firebase-admin if needed ──
echo ""
echo -e "${BOLD}Step 2 — Checking firebase-admin Python package${RESET}"
if python3 -c "import firebase_admin" 2>/dev/null; then
  echo -e "${GREEN}✓  firebase-admin already installed${RESET}"
else
  echo "  Installing firebase-admin…"
  pip3 install --user --quiet firebase-admin 2>/dev/null || \
    pip3 install --break-system-packages --quiet firebase-admin
  echo -e "${GREEN}✓  firebase-admin installed${RESET}"
fi

# ── 6. Push current scan data to Firestore ──
echo ""
echo -e "${BOLD}Step 3 — Pushing current scan data to Firestore${RESET}"
if [ -f "$KV_DIR/firebase_service_account.json" ]; then
  python3 "$KV_DIR/firebase_push.py" && echo -e "${GREEN}✓  Data pushed to Firestore${RESET}" || echo -e "${YELLOW}⚠  Firestore push failed — check credentials${RESET}"
else
  echo -e "${YELLOW}⚠  Skipped (no service account key)${RESET}"
fi

# ── 7. Deploy to Firebase Hosting + Firestore rules ──
echo ""
echo -e "${BOLD}Step 4 — Deploying to Firebase${RESET}"
cd "$KV_DIR"
firebase deploy --project "$PROJECT_ID" 2>&1 | grep -v "^$"

echo ""
echo "────────────────────────────────────────────────────────"
echo -e "${BOLD}${GREEN}✅  Deployed!${RESET}"
echo ""
echo -e "  ${BOLD}Your live dashboard:${RESET}"
echo "  https://$PROJECT_ID.web.app"
echo ""
echo -e "  ${BOLD}Share this URL with your team.${RESET}"
echo "  Data auto-refreshes in real-time when new scans run."
echo "────────────────────────────────────────────────────────"
