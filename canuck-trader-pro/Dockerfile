# Canuck-Trader-Pro - KVM4 Docker Image
# Multi-stage build: Node frontend build + Python backend

# Stage 1: Build React frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY . .
RUN npm run build

# Stage 2: Python backend + built frontend
FROM python:3.11-slim

# System deps for numpy/sklearn compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libffi-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY backend/ ./backend/

# Copy built frontend from stage 1
COPY --from=frontend-build /app/dist ./dist/

# Create data directory for SQLite + models
RUN mkdir -p /app/data /app/backend/models /app/backend/logs

# Environment defaults
ENV HTTP_PORT=3033
ENV PAPER_TRADING=true
ENV LOG_LEVEL=INFO
ENV PYTHONUNBUFFERED=1

EXPOSE 3033

WORKDIR /app/backend

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:3033/api/health')" || exit 1

CMD ["python", "main.py"]
