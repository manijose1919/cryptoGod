# ==============================================================================
# Canuck-Trader-Pro Dockerfile — Multi-stage build for KVM8 VPS
# Stage 1: Node 20 Alpine — build React/Vite frontend
# Stage 2: Python 3.12 Slim — run FastAPI backend + serve built frontend
# ==============================================================================

# ── Stage 1: Build Frontend ──────────────────────────────────────────────────
FROM node:20-alpine AS node-build

WORKDIR /frontend

# Copy package manifests first (Docker cache layer for npm install)
COPY package.json package-lock.json ./

# Install ALL dependencies (dev + prod) — needed for Vite build
RUN npm ci --production=false

# Copy frontend source files (flat structure at project root)
COPY App.tsx index.tsx index.html types.ts constants.ts ./
COPY vite.config.ts tsconfig.json tailwind.config.js postcss.config.js ./
COPY index.css ui-theme.css ./
COPY components/ ./components/
COPY services/ ./services/

# Build production frontend bundle
RUN npm run build


# ── Stage 2: Python Runtime ──────────────────────────────────────────────────
FROM python:3.12-slim AS python-runtime

WORKDIR /app

# Install system dependencies for native Python packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libffi-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies
COPY canuck-trader-pro/backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source code
COPY canuck-trader-pro/backend/ ./

# Copy built frontend from Stage 1
COPY --from=node-build /frontend/dist ./dist

# Create directories for persistent data
RUN mkdir -p /app/data /app/models /app/logs

# Expose FastAPI port
EXPOSE 3033

# Health check — hit the /api/health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3033/api/health || exit 1

# Run the application
CMD ["python", "main.py"]
