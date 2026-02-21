import { Router } from 'express';
import { createLogger } from '../services/logger.js';

const log = createLogger('Config');

export default function createConfigRouter(ctx) {
    const router = Router();

    // GET /status
    router.get('/status', (req, res) => {
        res.status(200).json({ portfolio: ctx.portfolio, logs: ctx.logs, isBotActive: ctx.botState.isActive });
    });

    // GET /system/status
    router.get('/system/status', (req, res) => {
        try {
            res.status(200).json({
                websocket: ctx.getWebSocketStatusProxy(),
                circuitBreaker: ctx.getCircuitBreakerStatus(),
                adaptiveWeights: ctx.getAdaptiveWeightsStatus(),
                profitMethods: ctx.getProfitMethodsStatus(),
                preTradeAI: ctx.getPreTradeAIStatus(),
                beastMode: ctx.getBeastModeStatus(),
                optimizer: ctx.getOptimizerStatus(ctx.portfolio.tradeLog),
                aiLearning: ctx.getAILearningStatus(),
            });
        } catch (error) {
            log.error('system/status failed', { error: error.message });
            res.status(500).json({ message: error.message });
        }
    });

    // GET /config
    router.get('/config', (req, res) => {
        try {
            const raw = ctx.getSetting('trading_config');
            res.json(raw ? JSON.parse(raw) : {});
        } catch (e) {
            res.json({});
        }
    });

    // POST /config
    router.post('/config', (req, res) => {
        try {
            ctx.setSetting('trading_config', JSON.stringify(req.body));
            log.info('Config updated');
            res.json({ success: true });
        } catch (e) {
            log.error('Config save failed', { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // GET /health — Enhanced health check
    router.get('/health', (req, res) => {
        const uptime = process.uptime();
        const mem = process.memoryUsage();

        let dbOk = false;
        try {
            if (ctx.pingDatabase) {
                dbOk = ctx.pingDatabase();
            } else {
                dbOk = true; // assume ok if no ping available
            }
        } catch { dbOk = false; }

        let wsStatus = 'unknown';
        try {
            if (ctx.getWebSocketStatusProxy) {
                const wsInfo = ctx.getWebSocketStatusProxy();
                wsStatus = wsInfo?.connected ? 'connected' : 'disconnected';
            }
        } catch { wsStatus = 'error'; }

        const healthy = dbOk && wsStatus !== 'error';

        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'ok' : 'degraded',
            uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
            uptimeSeconds: Math.round(uptime),
            memory: {
                heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
                heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
                rssMB: Math.round(mem.rss / 1024 / 1024),
            },
            database: dbOk ? 'ok' : 'error',
            websocket: wsStatus,
            botActive: ctx.botState.isActive,
            positions: Object.keys(ctx.portfolio.positions).length,
            lastBotLoopTime: ctx.botState.lastLoopTime || null,
        });
    });

    // GET /metrics — Prometheus-compatible metrics
    router.get('/metrics', (req, res) => {
        const uptime = process.uptime();
        const mem = process.memoryUsage();
        const positions = Object.keys(ctx.portfolio.positions).length;
        const cash = ctx.portfolio.cash || 0;

        // Calculate total portfolio value
        let totalValue = cash;
        for (const pos of Object.values(ctx.portfolio.positions)) {
            totalValue += (pos.quantity || 0) * (pos.currentPrice || pos.entryPrice || 0);
        }

        // Calculate total realized PnL from trade log
        let totalPnl = 0;
        if (ctx.portfolio.tradeLog) {
            for (const trade of ctx.portfolio.tradeLog) {
                if (trade.pnl) totalPnl += trade.pnl;
            }
        }

        const lines = [
            '# HELP trading_uptime_seconds Server uptime in seconds',
            '# TYPE trading_uptime_seconds gauge',
            `trading_uptime_seconds ${Math.round(uptime)}`,
            '',
            '# HELP trading_heap_used_bytes Heap memory used in bytes',
            '# TYPE trading_heap_used_bytes gauge',
            `trading_heap_used_bytes ${mem.heapUsed}`,
            '',
            '# HELP trading_heap_total_bytes Total heap size in bytes',
            '# TYPE trading_heap_total_bytes gauge',
            `trading_heap_total_bytes ${mem.heapTotal}`,
            '',
            '# HELP trading_rss_bytes Resident set size in bytes',
            '# TYPE trading_rss_bytes gauge',
            `trading_rss_bytes ${mem.rss}`,
            '',
            '# HELP trading_bot_active Whether the trading bot is active (1=yes, 0=no)',
            '# TYPE trading_bot_active gauge',
            `trading_bot_active ${ctx.botState.isActive ? 1 : 0}`,
            '',
            '# HELP trading_open_positions Number of open positions',
            '# TYPE trading_open_positions gauge',
            `trading_open_positions ${positions}`,
            '',
            '# HELP trading_portfolio_value_usd Total portfolio value in USD',
            '# TYPE trading_portfolio_value_usd gauge',
            `trading_portfolio_value_usd ${totalValue.toFixed(2)}`,
            '',
            '# HELP trading_portfolio_cash_usd Available cash in USD',
            '# TYPE trading_portfolio_cash_usd gauge',
            `trading_portfolio_cash_usd ${cash.toFixed(2)}`,
            '',
            '# HELP trading_total_pnl_usd Total realized PnL in USD',
            '# TYPE trading_total_pnl_usd gauge',
            `trading_total_pnl_usd ${totalPnl.toFixed(2)}`,
            '',
            '# HELP trading_total_trades Total number of trades executed',
            '# TYPE trading_total_trades counter',
            `trading_total_trades ${ctx.portfolio.tradeLog?.length || 0}`,
        ];

        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.send(lines.join('\n') + '\n');
    });

    return router;
}
