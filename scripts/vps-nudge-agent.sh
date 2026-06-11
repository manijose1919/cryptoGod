#!/bin/bash
# ============================================
# vps-nudge-agent.sh — wake VPS Claude for a monitoring cycle
# ============================================
# VPS Claude runs as an INTERACTIVE Claude Code session inside tmux
# (session "claude-code", user "claude"). It only acts when prompted —
# discovered 2026-06-11 when the audit progress report went 34h stale
# because nothing was driving its monitoring cycles.
#
# This script injects a monitoring-cycle prompt into that tmux session.
# Intended to run from root's crontab every 6 hours:
#   0 */6 * * * /opt/trading-bot/scripts/vps-nudge-agent.sh >> /opt/trading-bot/logs/nudge.log 2>&1
#
# Mechanical stats do NOT depend on this — generate-audit-report.mjs runs
# hourly from its own cron entry. This nudge is for narrative/judgment work.

set -u

TMUX_USER="claude"
TMUX_SESSION="claude-code"

PROMPT="Scheduled monitoring cycle ($(date -u '+%Y-%m-%d %H:%M UTC')). Follow docs/VPS-AGENT.md sections 1, 2, 5a and 5c. The data tables in data/reports/audit-batch-progress.md are auto-generated hourly by scripts/generate-audit-report.mjs — do NOT edit that file directly. Instead: (1) read it, (2) write/refresh your narrative + verdict in data/reports/audit-batch-notes.md (it gets included into the report automatically), (3) append a timestamped entry to data/reports/agent-log.md saying what you checked and found, (4) only ship code changes per the autonomy rules, with a CHANGELOG.md entry and a pull-before-commit. If the report shows the trailing red flag tripped, say so prominently in your notes but do not change config without 20+ trades of evidence. Keep it brief if nothing is anomalous."

if ! sudo -u "$TMUX_USER" tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "[nudge $(date -u '+%F %T')] ERROR: tmux session '$TMUX_SESSION' not found for user $TMUX_USER" >&2
  exit 1
fi

# Send literal text, brief pause so the TUI ingests it, then Enter.
sudo -u "$TMUX_USER" tmux send-keys -t "$TMUX_SESSION" -l "$PROMPT"
sleep 1
sudo -u "$TMUX_USER" tmux send-keys -t "$TMUX_SESSION" Enter

echo "[nudge $(date -u '+%F %T')] OK: monitoring-cycle prompt sent to $TMUX_SESSION"
