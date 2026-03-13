// ============================================
// Phoenix V2 — Slim Server
// Minimal entry point: Express + SQLite + Kraken WS + Telegram + V2 Engine
// ============================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = process.env.PORT || 3033;

// --- 1. Database ---
import { initializeDatabase } from './services/database.js';

// --- 2. Telegram (optional) ---
import { initTelegram, isEnabled as telegramEnabled, alertCircuitBreaker } from './services/telegramService.js';

// --- 3. Kraken WebSocket ---
import { initWebSocket as initKrakenWS } from './services/krakenWebsocketService.js';

// --- 4. Phoenix V2 Engine ---
import { bootV2, v2Router, getV2Status, stopV2Engine } from './v2/index.ts';

// ============================================
// Express App
// ============================================

const app = express();
app.use(cors());
app.use(express.json());

// Serve built frontend
app.use(express.static(join(__dirname, 'dist')));

// --- Health endpoint ---
app.get('/api/health', (_req, res) => {
  const status = getV2Status();
  res.json({
    ok: true,
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
    v2: status,
  });
});

// --- V2 API routes ---
app.use('/api/v2', v2Router);

// --- SPA catch-all ---
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

// ============================================
// Boot Sequence
// ============================================

const V2_TICKERS = [
  'BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'ADAUSD',
  'LINKUSD', 'DOTUSD', 'AVAXUSD', 'DOGEUSD', 'BNBUSD',
];

async function start() {
  console.log('[V2-Server] Starting Phoenix V2 slim server...');

  // 1. Database
  initializeDatabase();
  console.log('[V2-Server] SQLite initialized');

  // 2. Telegram
  initTelegram();

  // 3. Kraken WebSocket — warm up candle buffers for V2 tickers
  initKrakenWS(V2_TICKERS, {
    onConnect: () => console.log('[V2-Server] Kraken WS connected'),
  });
  console.log('[V2-Server] Kraken WebSocket initializing...');

  // 4. Boot V2 engine (paper mode by default via V2_MODE env)
  const budget = parseInt(process.env.V2_BUDGET || '1000', 10);
  await bootV2(budget);

  // 5. Start HTTP server
  const server = createServer(app);
  server.listen(PORT, () => {
    console.log(`[V2-Server] Listening on port ${PORT}`);
    console.log(`[V2-Server] Mode: ${process.env.V2_MODE || 'shadow'}`);
    console.log(`[V2-Server] Budget: $${budget}`);
    if (telegramEnabled()) {
      alertCircuitBreaker(`Phoenix V2 slim server started (${process.env.V2_MODE || 'shadow'} mode, $${budget})`);
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[V2-Server] Shutting down...');
    stopV2Engine();
    if (telegramEnabled()) {
      alertCircuitBreaker('Phoenix V2 slim server stopping');
    }
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  console.error('[V2-Server] Fatal boot error:', err);
  process.exit(1);
});
