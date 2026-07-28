#!/bin/bash
# ============================================
# Trading Bot Health Monitor
# Runs every 2 minutes via cron
# Sends high-priority email alerts on issues
# ============================================

VPS_HOST="${VPS_HOST:?VPS_HOST is not set — export it or add it to .env.local}"

HEALTH_URL="http://localhost:3033/api/health"
EMAIL="manijose1919@gmail.com"
STATE_FILE="/tmp/bot-monitor-state"
COOLDOWN_FILE="/tmp/bot-monitor-cooldown"
COOLDOWN_SECONDS=900  # 15 min between repeat alerts for same issue
LOG_FILE="/opt/trading-bot/logs/monitor.log"

mkdir -p /opt/trading-bot/logs

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

send_alert() {
    local subject="$1"
    local body="$2"
    local alert_key="$3"

    # Cooldown: don't spam same alert within 15 min
    if [ -f "$COOLDOWN_FILE.$alert_key" ]; then
        local last_sent=$(cat "$COOLDOWN_FILE.$alert_key")
        local now=$(date +%s)
        if [ $((now - last_sent)) -lt $COOLDOWN_SECONDS ]; then
            log "[COOLDOWN] Skipping alert '$alert_key' (sent $((now - last_sent))s ago)"
            return
        fi
    fi

    printf "From: manijose1919@gmail.com\nTo: %s\nSubject: %s\nX-Priority: 1\nImportance: High\nX-MSMail-Priority: High\nContent-Type: text/plain; charset=UTF-8\n\n%s\n\n---\nTrading Bot Monitor | VPS $VPS_HOST\nTime: %s\n"         "$EMAIL" "$subject" "$body" "$(date)" | msmtp -a default "$EMAIL" 2>&1

    date +%s > "$COOLDOWN_FILE.$alert_key"
    log "[ALERT SENT] $subject"
}

# --- Fetch health data ---
HEALTH=$(curl -sf --max-time 10 "$HEALTH_URL" 2>&1)
CURL_EXIT=$?

# --- Check 1: Bot unreachable ---
if [ $CURL_EXIT -ne 0 ] || [ -z "$HEALTH" ]; then
    send_alert         "[CRITICAL] Trading Bot DOWN"         "The trading bot health endpoint is not responding.\n\nCurl exit code: $CURL_EXIT\nResponse: $HEALTH\n\nPossible causes:\n- Node.js process crashed\n- Port 3033 not listening\n- Server overloaded\n\nCheck with: ssh root@$VPS_HOST 'pm2 status && pm2 logs canuck-node --lines 30'"         "bot_down"
    log "[CRITICAL] Bot unreachable (curl exit $CURL_EXIT)"
    exit 1
fi

# --- Parse health JSON ---
OK=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok',''))" 2>/dev/null)
UPTIME=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(int(d.get('uptime',0)))" 2>/dev/null)
MEMORY=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('memory',0))" 2>/dev/null)
IS_RUNNING=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('v2',{}).get('isRunning',''))" 2>/dev/null)
LOOP_COUNT=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('v2',{}).get('loopCount',0))" 2>/dev/null)
LAST_LOOP_TIME=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('v2',{}).get('lastLoopTime',0))" 2>/dev/null)
OPEN_POS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('v2',{}).get('openPositions',0))" 2>/dev/null)
TOTAL_TRADES=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('v2',{}).get('totalTrades',0))" 2>/dev/null)
PNL=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('v2',{}).get('totalPnlNet',0))" 2>/dev/null)
ML_READY=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ml',{}).get('ready',''))" 2>/dev/null)
FG_INDEX=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('fearGreed',{}).get('index',0))" 2>/dev/null)

# --- Check 2: Engine not running ---
if [ "$IS_RUNNING" != "True" ]; then
    send_alert         "[CRITICAL] Trading Engine STOPPED"         "The V2 trading engine reports isRunning=false.\n\nUptime: ${UPTIME}s\nMemory: ${MEMORY}MB\nLoop count: $LOOP_COUNT\n\nThe engine may have crashed internally while the HTTP server is still up."         "engine_stopped"
    log "[CRITICAL] Engine not running"
fi

# --- Check 3: Memory too high (>500MB) ---
if [ "$MEMORY" -gt 500 ] 2>/dev/null; then
    send_alert         "[WARNING] High Memory Usage: ${MEMORY}MB"         "Bot memory usage is ${MEMORY}MB (threshold: 500MB).\n\nUptime: ${UPTIME}s ($((UPTIME/3600))h)\nLoop count: $LOOP_COUNT\n\nThis may indicate a memory leak. Consider restarting:\nssh root@$VPS_HOST 'pm2 restart canuck-node'"         "high_memory"
    log "[WARNING] High memory: ${MEMORY}MB"
fi

# --- Check 4: Loop stall (last loop > 60s) ---
if [ "$LAST_LOOP_TIME" -gt 60000 ] 2>/dev/null; then
    send_alert         "[WARNING] Bot Loop Stall: ${LAST_LOOP_TIME}ms"         "Last bot loop took ${LAST_LOOP_TIME}ms (threshold: 60000ms).\n\nThis indicates the bot may be hanging on an API call or ML prediction.\n\nUptime: ${UPTIME}s\nLoop count: $LOOP_COUNT"         "loop_stall"
    log "[WARNING] Loop stall: ${LAST_LOOP_TIME}ms"
fi

# --- Check 5: Loop count not advancing (stale check) ---
PREV_LOOP=0
if [ -f "$STATE_FILE" ]; then
    PREV_LOOP=$(cat "$STATE_FILE")
fi
echo "$LOOP_COUNT" > "$STATE_FILE"

if [ "$PREV_LOOP" -gt 0 ] && [ "$LOOP_COUNT" -le "$PREV_LOOP" ] 2>/dev/null; then
    send_alert         "[CRITICAL] Bot Loop FROZEN"         "Loop count has not advanced since last check.\n\nCurrent: $LOOP_COUNT\nPrevious: $PREV_LOOP\n\nThe bot loop may be deadlocked.\n\nUptime: ${UPTIME}s\nMemory: ${MEMORY}MB"         "loop_frozen"
    log "[CRITICAL] Loop frozen at $LOOP_COUNT"
fi

# --- Check 6: ML engine not ready ---
if [ "$ML_READY" != "True" ]; then
    send_alert         "[WARNING] ML Engine Not Ready"         "The ML engine reports ready=false.\n\nThis may affect signal quality and trade decisions.\n\nUptime: ${UPTIME}s"         "ml_not_ready"
    log "[WARNING] ML not ready"
fi

# --- Check 7: Recent restart (uptime < 120s, not first run) ---
if [ -f "$STATE_FILE.uptime" ]; then
    PREV_UPTIME=$(cat "$STATE_FILE.uptime")
    if [ "$UPTIME" -lt 120 ] && [ "$PREV_UPTIME" -gt 120 ] 2>/dev/null; then
        send_alert             "[WARNING] Bot Restarted"             "Bot uptime dropped from ${PREV_UPTIME}s to ${UPTIME}s — it was restarted or crashed.\n\nMemory: ${MEMORY}MB\nLoop count: $LOOP_COUNT\n\nCheck crash logs: ssh root@$VPS_HOST 'pm2 logs canuck-node --lines 50 --nostream'"             "bot_restart"
        log "[WARNING] Bot restarted (uptime $PREV_UPTIME -> $UPTIME)"
    fi
fi
echo "$UPTIME" > "$STATE_FILE.uptime"

# --- All clear ---
log "[OK] uptime=${UPTIME}s mem=${MEMORY}MB loops=$LOOP_COUNT lastLoop=${LAST_LOOP_TIME}ms positions=$OPEN_POS trades=$TOTAL_TRADES pnl=$PNL fg=$FG_INDEX"
