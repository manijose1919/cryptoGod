# ============================================
# Trading Bot Deployment Script (Windows -> VPS)
#
# Three deployment modes:
#   archive (default) - tar + scp + extract
#   git               - push to VPS bare repo, post-receive hook
#   docker            - build image, transfer, docker-compose up
#
# Usage:
#   .\deploy\deploy.ps1                                          # archive mode (default), VPS=$env:VPS_HOST
#   .\deploy\deploy.ps1 -Mode git                                # git-based deploy
#   .\deploy\deploy.ps1 -Mode docker                             # docker image deploy
#   .\deploy\deploy.ps1 -Mode git -Rollback                      # rollback to previous commit
#   .\deploy\deploy.ps1 -Mode docker -Rollback                   # rollback to previous docker image
#   .\deploy\deploy.ps1 -FirstTime                               # initial VPS setup + archive deploy
#   .\deploy\deploy.ps1 -VpsIp "10.0.0.1" -User "deploy"        # custom VPS
# ============================================

param(
    # Host is not committed. Set $env:VPS_HOST or pass -VpsIp explicitly.
    [string]$VpsIp = $(if ($env:VPS_HOST) { $env:VPS_HOST } else { throw "VPS_HOST is not set - export it or pass -VpsIp" }),

    [string]$User = "root",

    [string]$SshKey = "",

    [ValidateSet("archive", "git", "docker")]
    [string]$Mode = "archive",

    [switch]$FirstTime,

    [switch]$CodeOnly,

    [switch]$Rollback
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RemoteDir = "/opt/trading-bot"
$GitRemoteName = "vps"
$BareRepoPath = "/opt/trading-bot.git"
$DockerImage = "canuck-trader:latest"
$DockerImageFile = "canuck-trader.tar.gz"
$Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

# ============================================
# Helper Functions
# ============================================

function Write-Step([string]$StepNum, [string]$Message) {
    Write-Host ""
    Write-Host "[$StepNum] $Message" -ForegroundColor Yellow
}

function Write-Ok([string]$Message) {
    Write-Host "  $Message" -ForegroundColor Green
}

function Write-Info([string]$Message) {
    Write-Host "  $Message" -ForegroundColor Gray
}

function Write-Warn([string]$Message) {
    Write-Host "  $Message" -ForegroundColor Magenta
}

function Write-Err([string]$Message) {
    Write-Host "  $Message" -ForegroundColor Red
}

function Write-Banner([string]$Message, [string]$Color = "Cyan") {
    Write-Host ""
    Write-Host "================================================" -ForegroundColor $Color
    Write-Host "  $Message" -ForegroundColor $Color
    Write-Host "================================================" -ForegroundColor $Color
}

# SSH target
$SshTarget = "${User}@${VpsIp}"

function Run-Ssh([string]$Cmd) {
    if ($SshKey) {
        & ssh -o ConnectTimeout=10 -i $SshKey $SshTarget $Cmd
    } else {
        & ssh -o ConnectTimeout=10 $SshTarget $Cmd
    }
    if ($LASTEXITCODE -ne 0) { throw "SSH command failed (exit $LASTEXITCODE): $Cmd" }
}

function Run-Scp([string]$Src, [string]$Dst) {
    if ($SshKey) {
        & scp -o ConnectTimeout=10 -i $SshKey $Src $Dst
    } else {
        & scp -o ConnectTimeout=10 $Src $Dst
    }
    if ($LASTEXITCODE -ne 0) { throw "SCP failed (exit $LASTEXITCODE)" }
}

function Get-ElapsedTime {
    return "$([math]::Round($Stopwatch.Elapsed.TotalSeconds, 1))s"
}

# ============================================
# Banner
# ============================================
$ModeLabel = switch ($Mode) {
    "archive" { "Archive (tar+scp)" }
    "git"     { "Git Push" }
    "docker"  { "Docker Image" }
}
if ($Rollback) { $ModeLabel += " [ROLLBACK]" }

Write-Banner "Trading Bot Deployment"
Write-Host "  Project : $ProjectDir"
Write-Host "  Target  : $SshTarget"
Write-Host "  Mode    : $ModeLabel" -ForegroundColor White
Write-Host "  Remote  : $RemoteDir"
if ($FirstTime) { Write-Host "  Setup   : First-time VPS provisioning" -ForegroundColor Magenta }
Write-Host ""

# ============================================
# First-Time VPS Setup (all modes)
# ============================================
if ($FirstTime) {
    Write-Step "0/6" "Running first-time VPS setup..."

    $SetupScript = Join-Path $ProjectDir "deploy" "setup-vps.sh"
    if (-not (Test-Path $SetupScript)) {
        throw "Setup script not found: $SetupScript"
    }

    Write-Info "Uploading setup-vps.sh..."
    Run-Scp -Src $SetupScript -Dst "${SshTarget}:/tmp/setup-vps.sh"

    Write-Info "Running setup script on VPS (this may take several minutes)..."
    Run-Ssh -Cmd "chmod +x /tmp/setup-vps.sh && bash /tmp/setup-vps.sh"

    Write-Ok "First-time setup complete!"
    Write-Host ""
    Write-Warn "IMPORTANT: Edit your .env file on the VPS:"
    Write-Info "  ssh $User@$VpsIp"
    Write-Info "  nano /opt/trading-bot/.env"
    Write-Host ""
}

# ============================================
# ROLLBACK
# ============================================
if ($Rollback) {
    Write-Banner "Rolling Back" "Red"

    switch ($Mode) {
        "git" {
            Write-Step "1/2" "Rolling back via git (force-push HEAD~1)..."
            Push-Location $ProjectDir
            try {
                & git push $GitRemoteName HEAD~1:main --force
                if ($LASTEXITCODE -ne 0) { throw "Git rollback push failed" }
                Write-Ok "Rollback push complete"
            } finally {
                Pop-Location
            }

            Write-Step "2/2" "Verifying rollback on VPS..."
            Run-Ssh -Cmd "cd $RemoteDir && git log --oneline -3"
        }
        "docker" {
            Write-Step "1/2" "Rolling back Docker to previous image..."
            Run-Ssh -Cmd @"
cd $RemoteDir
# Tag current as rollback-target, restore previous
if docker image inspect canuck-trader:previous >/dev/null 2>&1; then
    docker tag canuck-trader:latest canuck-trader:failed || true
    docker tag canuck-trader:previous canuck-trader:latest
    docker-compose up -d --force-recreate bot
    echo 'Rolled back to canuck-trader:previous'
else
    echo 'ERROR: No previous image found. Cannot rollback.'
    exit 1
fi
"@
            Write-Step "2/2" "Checking container status..."
            Run-Ssh -Cmd "docker ps --filter name=canuck-trader-bot --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
        }
        "archive" {
            Write-Warn "Archive mode rollback: restoring from backup..."
            Run-Ssh -Cmd @"
if [ -d ${RemoteDir}.bak ]; then
    rm -rf ${RemoteDir}
    mv ${RemoteDir}.bak ${RemoteDir}
    echo 'Restored from backup'
    # Restart
    if systemctl is-active --quiet trading-bot 2>/dev/null; then
        systemctl restart trading-bot
    elif pm2 describe trading-bot > /dev/null 2>&1; then
        pm2 restart trading-bot
    fi
else
    echo 'ERROR: No backup found at ${RemoteDir}.bak'
    exit 1
fi
"@
        }
    }

    # Health check after rollback
    Write-Host ""
    Write-Host "Running post-rollback health check..." -ForegroundColor Yellow
    Start-Sleep -Seconds 8
    try {
        if ($SshKey) {
            $HealthResult = & ssh -i $SshKey $SshTarget "curl -sf http://localhost:3033/api/health 2>&1 | head -c 300"
        } else {
            $HealthResult = & ssh $SshTarget "curl -sf http://localhost:3033/api/health 2>&1 | head -c 300"
        }
        if ($HealthResult) {
            Write-Ok "Health check PASSED after rollback"
            Write-Info $HealthResult
        } else {
            Write-Warn "Health check returned empty response"
        }
    } catch {
        Write-Err "Health check failed after rollback. Check logs manually."
    }

    $Stopwatch.Stop()
    Write-Banner "Rollback Complete ($(Get-ElapsedTime))" "Magenta"
    exit 0
}

# ============================================
# MODE: ARCHIVE (default, improved)
# ============================================
if ($Mode -eq "archive") {

    # --- Step 1: Prepare deployment package ---
    Write-Step "1/5" "Preparing deployment package..."

    $ExcludeList = @(
        "node_modules",
        ".git",
        "data/trading.db",
        "data/trading.db-wal",
        "data/trading.db-shm",
        "*.log",
        "nul",
        "deploy",
        ".env",
        ".env.local",
        "__pycache__",
        "*.pyc",
        ".mypy_cache",
        ".pytest_cache",
        "models/*.pkl",
        "models/*.joblib"
    )

    $TempDir = Join-Path $env:TEMP "trading-bot-deploy-$(Get-Date -Format 'yyyyMMddHHmmss')"
    New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

    $AllItems = Get-ChildItem -Path $ProjectDir -Force
    foreach ($item in $AllItems) {
        $skip = $false
        foreach ($exc in $ExcludeList) {
            if ($item.Name -like $exc -or $item.Name -eq $exc) {
                $skip = $true
                break
            }
        }
        if (-not $skip) {
            if ($item.PSIsContainer) {
                Copy-Item -Path $item.FullName -Destination (Join-Path $TempDir $item.Name) -Recurse -Force -ErrorAction SilentlyContinue
                # Recursive nul file cleanup (Windows reserved filename)
                Get-ChildItem -Path (Join-Path $TempDir $item.Name) -Recurse -Filter "nul" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
                # Also clean __pycache__ and .pyc
                Get-ChildItem -Path (Join-Path $TempDir $item.Name) -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
                Get-ChildItem -Path (Join-Path $TempDir $item.Name) -Recurse -Filter "*.pyc" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
            } else {
                Copy-Item -Path $item.FullName -Destination (Join-Path $TempDir $item.Name) -Force -ErrorAction SilentlyContinue
            }
        }
    }

    $FileCount = (Get-ChildItem -Path $TempDir -Recurse -File -ErrorAction SilentlyContinue).Count
    Write-Ok "Packaged $FileCount files"

    # --- Step 2: Upload code to VPS ---
    Write-Step "2/5" "Uploading code to VPS..."

    # Create backup on VPS first
    Run-Ssh -Cmd "if [ -d $RemoteDir ]; then rm -rf ${RemoteDir}.bak; cp -a $RemoteDir ${RemoteDir}.bak 2>/dev/null || true; echo 'Backup created'; fi"

    $TarFile = Join-Path $env:TEMP "trading-bot-deploy.tar.gz"
    if (Test-Path $TarFile) { Remove-Item $TarFile -Force }

    Push-Location $TempDir
    & "$env:SystemRoot\System32\tar.exe" -czf $TarFile .
    Pop-Location

    $TarSizeMB = [math]::Round((Get-Item $TarFile).Length / 1MB, 2)
    Write-Info "Archive size: ${TarSizeMB}MB"

    Write-Info "Uploading to $VpsIp..."
    Run-Scp -Src $TarFile -Dst "${SshTarget}:/tmp/trading-bot-deploy.tar.gz"

    Write-Info "Extracting on VPS..."
    Run-Ssh -Cmd "mkdir -p $RemoteDir && cd $RemoteDir && tar -xzf /tmp/trading-bot-deploy.tar.gz && rm /tmp/trading-bot-deploy.tar.gz && echo 'Code extracted successfully'"

    Write-Ok "Upload complete!"

    # --- Step 3: Install dependencies ---
    if (-not $FirstTime) {
        Write-Step "3/5" "Installing dependencies..."

        Run-Ssh -Cmd @"
cd $RemoteDir
npm install --production 2>&1 | tail -5

echo 'All dependencies installed'
"@
    }

    # --- Step 4: Restart ---
    if (-not $CodeOnly) {
        Write-Step "4/5" "Restarting trading bot..."

        Run-Ssh -Cmd @"
cd $RemoteDir

# Try systemd first, then PM2
if systemctl is-active --quiet trading-bot 2>/dev/null; then
    systemctl restart trading-bot
    echo 'Bot restarted via systemd'
elif pm2 describe trading-bot > /dev/null 2>&1; then
    pm2 restart trading-bot
    echo 'Bot restarted via PM2'
else
    pm2 start ecosystem.config.cjs
    pm2 save
    echo 'Bot started for first time via PM2'
fi
"@

        Write-Ok "Bot restarted!"
    }

    # --- Cleanup ---
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
    Remove-Item -Force $TarFile -ErrorAction SilentlyContinue
}

# ============================================
# MODE: GIT
# ============================================
if ($Mode -eq "git") {

    Push-Location $ProjectDir

    try {
        # --- Step 1: Ensure git remote exists ---
        Write-Step "1/5" "Checking git remote '$GitRemoteName'..."

        $remotes = & git remote 2>&1
        if ($remotes -notcontains $GitRemoteName) {
            Write-Info "Remote '$GitRemoteName' not found. Creating..."
            & git remote add $GitRemoteName "${User}@${VpsIp}:${BareRepoPath}"
            if ($LASTEXITCODE -ne 0) { throw "Failed to add git remote" }
            Write-Ok "Remote '$GitRemoteName' added -> ${User}@${VpsIp}:${BareRepoPath}"
        } else {
            # Update URL in case VPS IP changed
            & git remote set-url $GitRemoteName "${User}@${VpsIp}:${BareRepoPath}"
            Write-Ok "Remote '$GitRemoteName' exists -> ${User}@${VpsIp}:${BareRepoPath}"
        }

        # --- Step 2: Ensure bare repo on VPS ---
        Write-Step "2/5" "Ensuring bare repo on VPS..."

        Run-Ssh -Cmd @"
if [ ! -d $BareRepoPath ]; then
    git init --bare $BareRepoPath
    echo 'Created bare repo at $BareRepoPath'
else
    echo 'Bare repo already exists at $BareRepoPath'
fi
"@

        # --- Step 3: Create/update post-receive hook ---
        Write-Step "3/5" "Configuring post-receive hook on VPS..."

        Run-Ssh -Cmd @"
cat > ${BareRepoPath}/hooks/post-receive << 'HOOKEOF'
#!/bin/bash
# ============================================
# Post-receive hook: deploy on git push
# ============================================
set -e

APP_DIR="/opt/trading-bot"
LOG_FILE="/opt/trading-bot/logs/deploy.log"

echo "========================================"
echo "  Post-receive: deploying to `$APP_DIR"
echo "========================================"

# Checkout working tree
GIT_WORK_TREE=`$APP_DIR git checkout -f main 2>&1 | tee -a `$LOG_FILE

# Install Node.js dependencies
echo "Installing Node.js dependencies..."
cd `$APP_DIR
npm install --production 2>&1 | tail -5 | tee -a `$LOG_FILE

# Restart the bot
if systemctl is-active --quiet trading-bot 2>/dev/null; then
    systemctl restart trading-bot
    echo "Bot restarted via systemd"
elif pm2 describe trading-bot > /dev/null 2>&1; then
    pm2 restart trading-bot
    echo "Bot restarted via PM2"
else
    echo "WARNING: Could not find running bot process to restart"
fi

echo "Deploy complete at `$(date)"
echo "========================================" | tee -a `$LOG_FILE
HOOKEOF
chmod +x ${BareRepoPath}/hooks/post-receive
echo 'Post-receive hook installed'
"@

        Write-Ok "Post-receive hook configured"

        # --- Step 4: Push to VPS ---
        Write-Step "4/5" "Pushing to VPS via git..."

        # Check current branch
        $CurrentBranch = & git rev-parse --abbrev-ref HEAD 2>&1
        if ($CurrentBranch -ne "main") {
            Write-Warn "Current branch is '$CurrentBranch', pushing as main..."
            & git push $GitRemoteName "${CurrentBranch}:main" --force
        } else {
            & git push $GitRemoteName main
        }

        if ($LASTEXITCODE -ne 0) { throw "Git push failed" }
        Write-Ok "Git push complete! Post-receive hook will handle deployment."

        # --- Step 5: Verify deployment ---
        Write-Step "5/5" "Verifying deployment on VPS..."
        Start-Sleep -Seconds 3

        Run-Ssh -Cmd "cd $RemoteDir && git log --oneline -3 2>/dev/null || echo 'Working tree updated'"

    } finally {
        Pop-Location
    }
}

# ============================================
# MODE: DOCKER
# ============================================
if ($Mode -eq "docker") {

    # --- Step 1: Build Docker image ---
    Write-Step "1/5" "Building Docker image..."

    Push-Location $ProjectDir
    try {
        # Tag previous image for rollback
        Write-Info "Tagging previous image as canuck-trader:previous..."
        & docker tag canuck-trader:latest canuck-trader:previous 2>$null
        # Ignore errors if no previous image exists

        Write-Info "Building canuck-trader:latest..."
        & docker build -t "${DockerImage}" -f canuck-trader-pro/backend/Dockerfile .
        if ($LASTEXITCODE -ne 0) { throw "Docker build failed" }
        Write-Ok "Docker image built successfully"
    } finally {
        Pop-Location
    }

    # --- Step 2: Save and compress image ---
    Write-Step "2/5" "Saving Docker image to archive..."

    $DockerImagePath = Join-Path $ProjectDir "deploy" $DockerImageFile
    if (Test-Path $DockerImagePath) { Remove-Item $DockerImagePath -Force }

    & docker save $DockerImage | & "$env:SystemRoot\System32\cmd.exe" /c "gzip > `"$DockerImagePath`""
    if (-not (Test-Path $DockerImagePath)) {
        # Fallback: save without pipe
        $RawPath = Join-Path $ProjectDir "deploy" "canuck-trader.tar"
        & docker save -o $RawPath $DockerImage
        & "$env:SystemRoot\System32\tar.exe" -czf $DockerImagePath -C (Split-Path $RawPath) (Split-Path -Leaf $RawPath)
        Remove-Item $RawPath -Force -ErrorAction SilentlyContinue
    }

    $ImageSizeMB = [math]::Round((Get-Item $DockerImagePath).Length / 1MB, 2)
    Write-Ok "Image saved: ${ImageSizeMB}MB"

    # --- Step 3: Transfer image to VPS ---
    Write-Step "3/5" "Uploading Docker image to VPS..."

    Run-Scp -Src $DockerImagePath -Dst "${SshTarget}:/tmp/${DockerImageFile}"
    Write-Ok "Image uploaded"

    # --- Step 4: Load image and deploy on VPS ---
    Write-Step "4/5" "Loading image and deploying on VPS..."

    # Also ensure docker-compose.yml is on the VPS
    $ComposeFile = Join-Path $ProjectDir "docker-compose.yml"
    if (Test-Path $ComposeFile) {
        Run-Scp -Src $ComposeFile -Dst "${SshTarget}:${RemoteDir}/docker-compose.yml"
        Write-Info "docker-compose.yml uploaded"
    }

    Run-Ssh -Cmd @"
# Tag current image as previous for rollback
docker tag canuck-trader:latest canuck-trader:previous 2>/dev/null || true

# Load new image
echo 'Loading Docker image...'
gunzip -c /tmp/${DockerImageFile} | docker load
rm -f /tmp/${DockerImageFile}
echo 'Image loaded'

# Deploy with docker-compose
cd $RemoteDir
if [ -f docker-compose.yml ]; then
    docker-compose up -d --force-recreate bot
    echo 'Services started via docker-compose'
else
    # Fallback: run container directly
    docker stop canuck-trader-bot 2>/dev/null || true
    docker rm canuck-trader-bot 2>/dev/null || true
    docker run -d \
        --name canuck-trader-bot \
        --restart always \
        -p 3033:3033 \
        --env-file ${RemoteDir}/.env \
        -v trading-data:/app/data \
        -v trading-models:/app/models \
        -v trading-logs:/app/logs \
        ${DockerImage}
    echo 'Container started directly'
fi
"@

    Write-Ok "Docker deployment complete"

    # --- Step 5: Verify containers ---
    Write-Step "5/5" "Verifying containers..."
    Start-Sleep -Seconds 5

    Run-Ssh -Cmd "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | head -10"

    # Cleanup local image archive
    Remove-Item -Force $DockerImagePath -ErrorAction SilentlyContinue
}

# ============================================
# Health Check (all modes)
# ============================================
Write-Step "HC" "Running health check..."
Start-Sleep -Seconds 8

try {
    if ($SshKey) {
        $HealthResult = & ssh -o ConnectTimeout=10 -i $SshKey $SshTarget "curl -sf --max-time 10 http://localhost:3033/api/health 2>&1 | head -c 500"
    } else {
        $HealthResult = & ssh -o ConnectTimeout=10 $SshTarget "curl -sf --max-time 10 http://localhost:3033/api/health 2>&1 | head -c 500"
    }

    if ($HealthResult -match "ok|healthy|running|trading_engine|database") {
        Write-Ok "Health check PASSED!"
        Write-Info $HealthResult
    } elseif ($HealthResult) {
        Write-Warn "Health check returned unexpected response:"
        Write-Info $HealthResult
    } else {
        Write-Warn "Health check returned empty response. Bot may still be starting..."
    }
} catch {
    Write-Err "Health check failed. Check logs:"
    Write-Info "  ssh $User@$VpsIp 'journalctl -u trading-bot --lines 30'"
    Write-Info "  ssh $User@$VpsIp 'pm2 logs trading-bot --lines 20'"
    Write-Info "  ssh $User@$VpsIp 'docker logs canuck-trader-bot --tail 30'"
}

# ============================================
# Deployment Report
# ============================================
$Stopwatch.Stop()
$ElapsedTotal = Get-ElapsedTime

Write-Banner "Deployment Complete ($ElapsedTotal)"
Write-Host ""
Write-Host "  Mode      : $ModeLabel" -ForegroundColor White
Write-Host "  Duration  : $ElapsedTotal" -ForegroundColor White
Write-Host "  Dashboard : http://${VpsIp}:3033" -ForegroundColor White
Write-Host ""
Write-Host "  Useful commands:" -ForegroundColor Gray

switch ($Mode) {
    "archive" {
        Write-Info "    ssh $User@$VpsIp 'journalctl -u trading-bot -f'        # View logs (systemd)"
        Write-Info "    ssh $User@$VpsIp 'systemctl restart trading-bot'       # Restart (systemd)"
        Write-Info "    ssh $User@$VpsIp 'pm2 logs trading-bot'               # View logs (PM2)"
        Write-Info "    .\deploy\deploy.ps1 -Mode archive -Rollback           # Rollback"
    }
    "git" {
        Write-Info "    ssh $User@$VpsIp 'cd $RemoteDir && git log --oneline -5'  # Recent deploys"
        Write-Info "    ssh $User@$VpsIp 'journalctl -u trading-bot -f'           # View logs"
        Write-Info "    .\deploy\deploy.ps1 -Mode git -Rollback                   # Rollback 1 commit"
    }
    "docker" {
        Write-Info "    ssh $User@$VpsIp 'docker logs -f canuck-trader-bot'       # View logs"
        Write-Info "    ssh $User@$VpsIp 'docker-compose -f $RemoteDir/docker-compose.yml restart bot'  # Restart"
        Write-Info "    ssh $User@$VpsIp 'docker ps'                              # Container status"
        Write-Info "    .\deploy\deploy.ps1 -Mode docker -Rollback                # Rollback"
    }
}
Write-Host ""
