#!/usr/bin/env bash
# Poll paper engine every 60s and append a one-line status snapshot.
OUT=${1:-/opt/cursor/artifacts/paper_monitor_timeseries.log}
mkdir -p "$(dirname "$OUT")"
echo "# paper monitor started $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT"
while true; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  curl -s --max-time 5 localhost:3033/api/v2/status 2>/dev/null | python3 -c "
import sys, json
from datetime import datetime
try:
  d=json.load(sys.stdin)
  passes=[r['ticker'] for r in d.get('lastScanReasons',[]) if str(r.get('reason','')).startswith('PASS')]
  print(f\"$ts mode={d.get('mode')} loop={d.get('loopCount')} open={d.get('openPositions')} trades={d.get('totalTrades')} pnl={d.get('totalPnlNet')} cash={d.get('portfolioCash')} passes={','.join(passes) or '-'}\")
except Exception as e:
  print(f\"$ts ERROR {e}\")
" >> "$OUT"
  sleep 60
done
