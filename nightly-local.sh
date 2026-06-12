#!/bin/zsh
# Local nightly career-ops scan — runs via launchd at 2am Asia/Karachi.
# Fully local + deterministic. Logs to reports/nightly-local.log.
set -e
REPO="/Users/muhammadmahlabmaniar/ai-projects/job-search/career-ops"
cd "$REPO"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$HOME/.local/bin:$PATH"
LOG="$REPO/reports/nightly-local.log"
echo "===== $(date) =====" >> "$LOG"

# Pull latest config (in case profile/portals edited elsewhere)
git pull --quiet origin main >> "$LOG" 2>&1 || echo "git pull skipped" >> "$LOG"

# Load Notion token if present
[ -f "$REPO/config/.notion-token" ] && export NOTION_TOKEN="$(cat "$REPO/config/.notion-token")"

# Run the pipeline (runs scan.mjs itself)
node nightly-local.mjs >> "$LOG" 2>&1 || echo "pipeline error" >> "$LOG"

# Commit the report + updated scan history
git add data/scan-history.tsv data/pipeline.md reports/nightly-*.md 2>/dev/null || true
git diff --cached --quiet || git commit -m "chore: local nightly $(date +%Y-%m-%d)" >> "$LOG" 2>&1
git push --quiet origin main >> "$LOG" 2>&1 || echo "git push failed" >> "$LOG"

# Desktop notification
PUSHED=$(grep -m1 'pushed' "$LOG" | tail -1)
osascript -e "display notification \"$(tail -3 $LOG | head -1)\" with title \"Career-Ops nightly done\"" 2>/dev/null || true
echo "done $(date)" >> "$LOG"
