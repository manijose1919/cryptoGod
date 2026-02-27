#!/bin/bash
# ============================================
# Trading Bot VPS Setup Script
# Installs all dependencies and configures the server
#
# Run this ON the VPS (called automatically by deploy.ps1 -FirstTime)
# Usage: bash setup-vps.sh
# ============================================

set -e  # Exit on any error

APP_DIR="/opt/trading-bot"
APP_USER="tradingbot"
NODE_VERSION="20"
PYTHON_VERSION="3.12"
VENV_DIR="$APP_DIR/venv"
BARE_REPO="/opt/trading-bot.git"
SWAP_SIZE="4G"

echo ""
echo "================================================"
echo "  Canuck Trader Pro - VPS Setup"
echo "  $(date)"
echo "================================================"
echo ""
echo "  App Dir   : $APP_DIR"
echo "  User      : $APP_USER"
echo "  Node      : v$NODE_VERSION LTS"
echo "  Python    : $PYTHON_VERSION"
echo "  Swap      : $SWAP_SIZE"
echo ""

# ============================================
# 1. System Updates & Base Packages
# ============================================
echo ""
echo "[1/12] Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y \
    curl wget git build-essential ufw \
    software-properties-common apt-transport-https \
    ca-certificates gnupg lsb-release \
    htop iotop ncdu tmux unzip jq \
    libffi-dev libssl-dev zlib1g-dev \
    libbz2-dev libreadline-dev libsqlite3-dev \
    libncursesw5-dev libxml2-dev libxmlsec1-dev \
    libgdbm-dev libnss3-dev liblzma-dev
echo "  System packages installed"

# ============================================
# 2. Install Python 3.12
# ============================================
echo ""
echo "[2/12] Installing Python ${PYTHON_VERSION}..."

# Add deadsnakes PPA for Python 3.12
if ! python3.12 --version &>/dev/null; then
    add-apt-repository -y ppa:deadsnakes/ppa 2>/dev/null || true
    apt-get update -y
    apt-get install -y python3.12 python3.12-venv python3.12-dev python3.12-distutils 2>/dev/null || \
    apt-get install -y python3 python3-pip python3-venv python3-dev
fi

# Ensure pip is available
if command -v python3.12 &>/dev/null; then
    PYTHON_BIN="python3.12"
    curl -sS https://bootstrap.pypa.io/get-pip.py | python3.12 2>/dev/null || true
else
    PYTHON_BIN="python3"
    apt-get install -y python3-pip
fi

PYTHON_INSTALLED=$($PYTHON_BIN --version 2>&1)
echo "  Python: $PYTHON_INSTALLED"
echo "  Pip: $(pip3 --version 2>&1 | head -c 40)"

# ============================================
# 3. Install Node.js 20 LTS
# ============================================
echo ""
echo "[3/12] Installing Node.js v${NODE_VERSION} LTS..."
if ! command -v node &>/dev/null || [[ "$(node -v)" != v${NODE_VERSION}* ]]; then
    # Remove old Node.js if present
    apt-get remove -y nodejs 2>/dev/null || true
    rm -f /etc/apt/sources.list.d/nodesource.list 2>/dev/null || true

    # Install via NodeSource
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
else
    echo "  Node.js v${NODE_VERSION} already installed"
fi

echo "  Node: $(node -v)"
echo "  NPM: $(npm -v)"

# ============================================
# 4. Install Docker & Docker Compose
# ============================================
echo ""
echo "[4/12] Installing Docker & Docker Compose..."
if ! command -v docker &>/dev/null; then
    # Add Docker's official GPG key
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc

    # Add Docker repo
    echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
        $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
        tee /etc/apt/sources.list.d/docker.list > /dev/null

    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    # Enable and start Docker
    systemctl enable docker
    systemctl start docker
    echo "  Docker installed"
else
    echo "  Docker already installed: $(docker --version | head -c 30)"
fi

# Install docker-compose standalone (backward compat with docker-compose.yml)
if ! command -v docker-compose &>/dev/null; then
    COMPOSE_VERSION=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | jq -r .tag_name)
    curl -L "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" \
        -o /usr/local/bin/docker-compose 2>/dev/null || true
    chmod +x /usr/local/bin/docker-compose 2>/dev/null || true
    echo "  docker-compose standalone: $(docker-compose --version 2>&1 | head -c 40)"
fi

echo "  Docker: $(docker --version 2>&1 | head -c 40)"
echo "  Compose: $(docker compose version 2>&1 | head -c 40)"

# ============================================
# 5. Install Redis
# ============================================
echo ""
echo "[5/12] Installing Redis..."
if ! command -v redis-server &>/dev/null; then
    apt-get install -y redis-server
    # Configure Redis
    sed -i 's/^supervised no/supervised systemd/' /etc/redis/redis.conf 2>/dev/null || true
    sed -i 's/^# maxmemory .*/maxmemory 2gb/' /etc/redis/redis.conf 2>/dev/null || true
    sed -i 's/^# maxmemory-policy .*/maxmemory-policy allkeys-lru/' /etc/redis/redis.conf 2>/dev/null || true
    systemctl enable redis-server
    systemctl restart redis-server
    echo "  Redis installed and configured"
else
    echo "  Redis already installed: $(redis-server --version | head -c 30)"
fi

# ============================================
# 6. Install Nginx
# ============================================
echo ""
echo "[6/12] Installing Nginx..."
if ! command -v nginx &>/dev/null; then
    apt-get install -y nginx
    systemctl enable nginx

    # Create basic reverse proxy config
    cat > /etc/nginx/sites-available/trading-bot << 'NGINXEOF'
server {
    listen 80;
    server_name _;

    # Frontend + API reverse proxy
    location / {
        proxy_pass http://127.0.0.1:3033;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    # Grafana
    location /grafana/ {
        proxy_pass http://127.0.0.1:3001/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
NGINXEOF

    ln -sf /etc/nginx/sites-available/trading-bot /etc/nginx/sites-enabled/trading-bot
    rm -f /etc/nginx/sites-enabled/default
    nginx -t && systemctl restart nginx
    echo "  Nginx installed and configured"
else
    echo "  Nginx already installed: $(nginx -v 2>&1 | head -c 30)"
fi

# ============================================
# 7. Install PM2
# ============================================
echo ""
echo "[7/12] Installing PM2 process manager..."
npm install -g pm2
echo "  PM2: $(pm2 --version 2>&1)"

# ============================================
# 8. Create Application User & Directories
# ============================================
echo ""
echo "[8/12] Setting up application user and directories..."

# Create app user
if ! id "$APP_USER" &>/dev/null; then
    useradd -r -m -s /bin/bash "$APP_USER"
    # Add to docker group so it can manage containers
    usermod -aG docker "$APP_USER" 2>/dev/null || true
    echo "  Created user: $APP_USER"
else
    usermod -aG docker "$APP_USER" 2>/dev/null || true
    echo "  User $APP_USER already exists"
fi

# Create directories
mkdir -p "$APP_DIR"
mkdir -p "$APP_DIR/data"
mkdir -p "$APP_DIR/logs"
mkdir -p "$APP_DIR/models"
mkdir -p "$APP_DIR/nginx"

# If code was uploaded to /tmp/trading-bot-upload, move it
if [ -d "/tmp/trading-bot-upload" ]; then
    echo "  Moving uploaded code to $APP_DIR..."
    cp -r /tmp/trading-bot-upload/* "$APP_DIR/"
    rm -rf /tmp/trading-bot-upload
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
echo "  Directories created and owned by $APP_USER"

# ============================================
# 9. Python Virtual Environment & Dependencies
# ============================================
echo ""
echo "[9/12] Setting up Python virtual environment..."

if [ ! -d "$VENV_DIR" ]; then
    $PYTHON_BIN -m venv "$VENV_DIR"
    echo "  Created venv at $VENV_DIR using $PYTHON_BIN"
else
    echo "  Venv already exists at $VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
pip install --upgrade pip setuptools wheel

# Install Python requirements
if [ -f "$APP_DIR/canuck-trader-pro/backend/requirements.txt" ]; then
    pip install -r "$APP_DIR/canuck-trader-pro/backend/requirements.txt"
    echo "  Python dependencies installed from requirements.txt"
else
    echo "  No requirements.txt found yet (will install on first deploy)"
fi
deactivate

chown -R "$APP_USER:$APP_USER" "$VENV_DIR"

# ============================================
# 10. Firewall (UFW)
# ============================================
echo ""
echo "[10/12] Configuring firewall..."
ufw --force enable
ufw allow 22/tcp     comment 'SSH'
ufw allow 80/tcp     comment 'HTTP / Nginx'
ufw allow 443/tcp    comment 'HTTPS / Nginx'
ufw allow 3033/tcp   comment 'Trading Bot API'
# Block direct access to internal services from outside
ufw deny 6379/tcp    comment 'Redis - internal only'
ufw deny 9090/tcp    comment 'Prometheus - internal only'
echo "  Firewall rules:"
ufw status numbered 2>&1 | head -20

# ============================================
# 11. Swap Space (4GB)
# ============================================
echo ""
echo "[11/12] Configuring swap space (${SWAP_SIZE})..."
if [ ! -f /swapfile ]; then
    fallocate -l $SWAP_SIZE /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile

    # Make persistent
    if ! grep -q '/swapfile' /etc/fstab; then
        echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi

    # Optimize swappiness for trading (prefer RAM)
    sysctl vm.swappiness=10
    if ! grep -q 'vm.swappiness' /etc/sysctl.conf; then
        echo 'vm.swappiness=10' >> /etc/sysctl.conf
    fi

    echo "  Swap created: $SWAP_SIZE"
else
    echo "  Swap already exists"
fi
echo "  Current swap:"
swapon --show 2>&1 | head -5

# ============================================
# 12. Systemd Service + PM2 + Git Bare Repo
# ============================================
echo ""
echo "[12/12] Configuring services and git repo..."

# --- Systemd service ---
cat > /etc/systemd/system/trading-bot.service << SVCEOF
[Unit]
Description=Canuck Trader Pro - Python Trading Engine + FastAPI
After=network.target redis-server.service
Wants=redis-server.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/canuck-trader-pro/backend
ExecStart=$VENV_DIR/bin/python main.py
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
EnvironmentFile=$APP_DIR/.env
StandardOutput=journal
StandardError=journal
SyslogIdentifier=trading-bot

# Resource limits
LimitNOFILE=65535
MemoryMax=16G

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable trading-bot
echo "  systemd service created and enabled"

# --- PM2 ecosystem config ---
cat > "$APP_DIR/ecosystem.config.cjs" << 'PM2EOF'
module.exports = {
  apps: [
    {
      name: 'trading-bot',
      script: 'canuck-trader-pro/backend/main.py',
      interpreter: '/opt/trading-bot/venv/bin/python3',
      cwd: '/opt/trading-bot',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '8G',
      env: {
        PYTHONUNBUFFERED: '1',
        HTTP_PORT: 3033,
      },
      error_file: '/opt/trading-bot/logs/error.log',
      out_file: '/opt/trading-bot/logs/output.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      exp_backoff_restart_delay: 1000,
      max_restarts: 50,
      restart_delay: 3000,
    }
  ]
};
PM2EOF
chown "$APP_USER:$APP_USER" "$APP_DIR/ecosystem.config.cjs"
echo "  PM2 ecosystem config created"

# --- Bare Git Repo with Post-Receive Hook ---
if [ ! -d "$BARE_REPO" ]; then
    git init --bare "$BARE_REPO"
    echo "  Created bare repo at $BARE_REPO"
else
    echo "  Bare repo already exists at $BARE_REPO"
fi

cat > "${BARE_REPO}/hooks/post-receive" << 'HOOKEOF'
#!/bin/bash
# ============================================
# Post-receive hook: auto-deploy on git push
# ============================================
set -e

APP_DIR="/opt/trading-bot"
VENV_DIR="$APP_DIR/venv"
LOG_FILE="$APP_DIR/logs/deploy.log"

mkdir -p "$APP_DIR/logs"

{
    echo ""
    echo "========================================"
    echo "  Post-receive deploy: $(date)"
    echo "========================================"

    # Checkout working tree
    echo "Checking out to $APP_DIR..."
    GIT_WORK_TREE=$APP_DIR git checkout -f main

    # Install Node.js dependencies (if package.json exists)
    if [ -f "$APP_DIR/package.json" ]; then
        echo "Installing Node.js dependencies..."
        cd $APP_DIR
        npm install --production 2>&1 | tail -5
    fi

    # Install Python dependencies
    if [ -d "$VENV_DIR" ] && [ -f "$APP_DIR/canuck-trader-pro/backend/requirements.txt" ]; then
        echo "Installing Python dependencies..."
        source $VENV_DIR/bin/activate
        pip install -r canuck-trader-pro/backend/requirements.txt 2>&1 | tail -5
        deactivate
    fi

    # Restart the bot
    if systemctl is-active --quiet trading-bot 2>/dev/null; then
        systemctl restart trading-bot
        echo "Bot restarted via systemd"
    elif pm2 describe trading-bot > /dev/null 2>&1; then
        pm2 restart trading-bot
        echo "Bot restarted via PM2"
    else
        echo "WARNING: No running bot process found to restart"
        echo "Start manually: systemctl start trading-bot"
    fi

    echo "Deploy complete!"
    echo "========================================"
} 2>&1 | tee -a "$LOG_FILE"
HOOKEOF

chmod +x "${BARE_REPO}/hooks/post-receive"
chown -R "$APP_USER:$APP_USER" "$BARE_REPO"
echo "  Post-receive hook installed at $BARE_REPO"

# --- .env template ---
if [ ! -f "$APP_DIR/.env" ]; then
    cat > "$APP_DIR/.env" << 'ENVEOF'
# ============================================
# Canuck Trader Pro - Environment Configuration
# ============================================

# Crypto.com Exchange API
SESSION_API_KEY="your_api_key_here"
SESSION_SECRET_KEY="your_secret_key_here"

# Anthropic Claude AI (for trade analysis)
ANTHROPIC_API_KEY="your_anthropic_key_here"

# Questrade
QUESTRADE_REFRESH_TOKEN="your_questrade_token_here"

# Server Config
HTTP_PORT=3033
CORS_ORIGIN=http://localhost:3000

# Redis
REDIS_URL=redis://localhost:6379/0

# Paper Trading (set to false for live trading)
PAPER_TRADING=true

# Logging
LOG_LEVEL=INFO
ENVEOF
    chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
    chmod 600 "$APP_DIR/.env"
    echo "  Created .env template"
else
    echo "  .env already exists, skipping"
fi

# ============================================
# Install Node.js dependencies (if code present)
# ============================================
if [ -f "$APP_DIR/package.json" ]; then
    echo ""
    echo "  Installing Node.js dependencies..."
    cd "$APP_DIR"
    sudo -u "$APP_USER" npm install --production 2>&1 | tail -5

    # Build frontend
    echo "  Building React frontend..."
    sudo -u "$APP_USER" npm run build 2>&1 || echo "  Frontend build skipped (may need dev deps)"
fi

# ============================================
# Summary
# ============================================
echo ""
echo "================================================"
echo "  VPS Setup Complete!"
echo "================================================"
echo ""
echo "  Installed:"
echo "    Python     : $($PYTHON_BIN --version 2>&1)"
echo "    Node.js    : $(node -v 2>&1)"
echo "    Docker     : $(docker --version 2>&1 | head -c 40)"
echo "    Redis      : $(redis-server --version 2>&1 | head -c 30)"
echo "    Nginx      : $(nginx -v 2>&1 | head -c 30)"
echo "    PM2        : $(pm2 --version 2>&1)"
echo "    Swap       : $(swapon --show --noheadings --bytes 2>/dev/null | awk '{printf "%.1fG", $3/1073741824}' || echo "$SWAP_SIZE")"
echo ""
echo "  Paths:"
echo "    App Dir    : $APP_DIR"
echo "    Venv       : $VENV_DIR"
echo "    Git Repo   : $BARE_REPO"
echo "    Logs       : $APP_DIR/logs/"
echo "    Database   : $APP_DIR/data/"
echo ""
echo "  Next steps:"
echo ""
echo "    1. Edit your API keys:"
echo "       nano $APP_DIR/.env"
echo ""
echo "    2. Deploy code (from Windows):"
echo "       .\\deploy\\deploy.ps1                    # archive mode"
echo "       .\\deploy\\deploy.ps1 -Mode git          # git push mode"
echo "       .\\deploy\\deploy.ps1 -Mode docker       # docker mode"
echo ""
echo "    3. Start the bot:"
echo "       systemctl start trading-bot             # systemd (recommended)"
echo "       journalctl -u trading-bot -f            # view logs"
echo ""
echo "    4. Or with Docker:"
echo "       cd $APP_DIR && docker-compose up -d     # start all services"
echo "       docker-compose logs -f bot              # view logs"
echo ""
echo "    5. Health check:"
echo "       curl http://localhost:3033/api/health"
echo ""
echo "================================================"
