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

// --- 3. Fear & Greed Gate + Data Sources ---
import { initFearGreedGate, getFearGreedStatus } from './services/fearGreedGate.js';

let derivativesIntel: any = null;
let whaleFlowTracker: any = null;
try { derivativesIntel = await import('./services/derivativesIntelligence.js'); } catch {}
try { whaleFlowTracker = await import('./services/whaleFlowTracker.js'); } catch {}

// --- 4. Kraken WebSocket ---
import { initWebSocket as initKrakenWS } from './services/krakenWebsocketService.js';

// --- 5. ML Pipeline (optional — fails gracefully) ---
let mlReady = false;
async function initML(): Promise<void> {
  try {
    const mlService = await import('./services/mlPredictionService.js');
    await mlService.initializeML();
    const engine = mlService.getMLEngine();
    if (engine?.isTrained) {
      const gatekeeper = await import('./services/mlGatekeeper.js');
      gatekeeper.init(engine, null); // no adversarial brains
      mlReady = true;
      const status = engine.getModelStatus?.();
      console.log(`[V2-Server] ML gatekeeper initialized (accuracy=${(status?.accuracy * 100 || 0).toFixed(1)}%, samples=${status?.sampleCount || 0})`);
    } else {
      console.log('[V2-Server] ML engine not trained yet — gatekeeper disabled');
    }
  } catch (err: any) {
    console.warn('[V2-Server] ML pipeline not available:', err.message);
  }
}

// --- 6. Phoenix V2 Engine ---
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
    fearGreed: getFearGreedStatus(),
    ml: { ready: mlReady },
  });
});

// --- V2 API routes ---
app.use('/api/v2', v2Router);

// --- Config endpoint (runtime flag changes) ---
app.post('/api/config/flag', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    const { setFlag, getFlag } = await import('./services/systemConfig.js');
    setFlag(key, value);
    res.json({ ok: true, key, value: getFlag(key) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config/flags', async (_req, res) => {
  try {
    const { getAllFlags } = await import('./services/systemConfig.js');
    res.json(getAllFlags());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Read-only monitoring dashboard (source-controlled; not part of the vite build)
app.get('/monitor', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'monitor.html'));
});

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

  // 3. On-chain data pollers (must start before F&G gate so it has real data)
  if (derivativesIntel?.startDerivativesPolling) {
    derivativesIntel.startDerivativesPolling();
    console.log('[V2-Server] Derivatives Intelligence polling started');
  }
  if (whaleFlowTracker?.startWhaleFlowPolling) {
    whaleFlowTracker.startWhaleFlowPolling();
    console.log('[V2-Server] Whale Flow Tracker polling started');
  }

  // 4. Fear & Greed Gate (async — awaits on-chain module loading)
  await initFearGreedGate();

  // 5. Kraken WebSocket — warm up candle buffers for V2 tickers
  initKrakenWS(V2_TICKERS, {
    onConnect: () => console.log('[V2-Server] Kraken WS connected'),
  });
  console.log('[V2-Server] Kraken WebSocket initializing...');

  // 6. ML Pipeline (non-blocking)
  await initML();

  // 7. Boot V2 engine (paper mode by default via V2_MODE env)
  const budget = parseInt(process.env.V2_BUDGET || '1000', 10);
  await bootV2(budget);

  // 8. Start HTTP server
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
