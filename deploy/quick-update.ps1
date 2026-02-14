# ============================================
# Quick Update - Push code changes and restart
#
# Usage: .\deploy\quick-update.ps1 -VpsIp "YOUR_VPS_IP"
# ============================================

param(
    [Parameter(Mandatory=$true)]
    [string]$VpsIp,
    [string]$User = "root"
)

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "Quick deploying to $User@$VpsIp..." -ForegroundColor Cyan

# Pack only source files (no node_modules, no data)
$TarFile = Join-Path $env:TEMP "trading-bot-quick.tar.gz"

Push-Location $ProjectDir
tar -czf $TarFile `
    --exclude='node_modules' `
    --exclude='dist' `
    --exclude='.git' `
    --exclude='data' `
    --exclude='deploy' `
    --exclude='.env' `
    --exclude='*.log' `
    --exclude='nul' `
    .
Pop-Location

$SizeMB = [math]::Round((Get-Item $TarFile).Length / 1MB, 2)
Write-Host "  Package: ${SizeMB}MB" -ForegroundColor Gray

scp $TarFile "${User}@${VpsIp}:/tmp/trading-bot-quick.tar.gz"

ssh "${User}@${VpsIp}" @"
cd /opt/trading-bot
tar -xzf /tmp/trading-bot-quick.tar.gz
rm /tmp/trading-bot-quick.tar.gz
npm install --production 2>&1 | tail -1
pm2 restart trading-bot
sleep 3
curl -s http://localhost:3033/api/circuit-breaker | head -c 50 && echo ' OK'
"@

Remove-Item -Force $TarFile -ErrorAction SilentlyContinue
Write-Host "Done! Bot restarted at http://${VpsIp}:3033" -ForegroundColor Green
