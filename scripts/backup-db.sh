#!/bin/bash
# Database Backup Script for CryptoGod VPS
# Run daily via cron: 0 0 * * * /opt/trading-bot/scripts/backup-db.sh
#
# Setup on VPS:
#   chmod +x /opt/trading-bot/scripts/backup-db.sh
#   crontab -e → add: 0 0 * * * /opt/trading-bot/scripts/backup-db.sh

set -e

APP_DIR="/opt/trading-bot"
DB_PATH="$APP_DIR/data/trading.db"
BACKUP_DIR="$APP_DIR/data/backups"
RETENTION_DAYS=30
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/trading_$DATE.db"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Check if database exists
if [ ! -f "$DB_PATH" ]; then
    echo "[Backup] ERROR: Database not found at $DB_PATH"
    exit 1
fi

# Get DB size before backup
DB_SIZE=$(du -h "$DB_PATH" | cut -f1)
echo "[Backup] Starting backup of $DB_PATH ($DB_SIZE)"

# Use SQLite's .backup command for safe hot backup (WAL-compatible)
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Compress the backup
gzip "$BACKUP_FILE"
COMPRESSED_SIZE=$(du -h "${BACKUP_FILE}.gz" | cut -f1)

echo "[Backup] Created: ${BACKUP_FILE}.gz ($COMPRESSED_SIZE)"

# Remove backups older than RETENTION_DAYS
REMOVED=$(find "$BACKUP_DIR" -name "trading_*.db.gz" -mtime +$RETENTION_DAYS -delete -print | wc -l)
if [ "$REMOVED" -gt 0 ]; then
    echo "[Backup] Cleaned $REMOVED backups older than $RETENTION_DAYS days"
fi

# List current backups
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "trading_*.db.gz" | wc -l)
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "[Backup] Total backups: $BACKUP_COUNT ($TOTAL_SIZE)"

# Optional: send Telegram notification
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    MSG="📦 <b>DB Backup Complete</b>%0A━━━━━━━━━━━━━━━━━━%0ASize: $COMPRESSED_SIZE%0ABackups: $BACKUP_COUNT%0ARetention: ${RETENTION_DAYS}d"
    curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
        -d "chat_id=$TELEGRAM_CHAT_ID" \
        -d "text=$MSG" \
        -d "parse_mode=HTML" > /dev/null 2>&1
fi

echo "[Backup] Done."
