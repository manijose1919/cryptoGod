
import { EventEmitter } from 'events';

/**
 * Local AI Brain
 * Rule-based trade analysis engine - no external API needed.
 * - Analyzes trades using indicator signals, sentiment, and market data
 * - Learns from trade history with statistical pattern analysis
 * - Suggests strategy adjustments via retrospectives
 */
export class GeminiBrain extends EventEmitter {
    tradeHistory: any[];
    learningLogs: any[];
    strategyStats: Record<string, { trades: number; wins: number; losses: number; winRate: number }>;

    constructor() {
        super();
        this.tradeHistory = [];
        this.learningLogs = [];
        this.strategyStats = {};
    }

    /**
     * Analyze a potential trade using local rules
     */
    async analyzeTradeOpportunity(ticker: string, signals: any, sentiment: any, marketData: any) {
        try {
            const analysis = this._ruleBasedAnalysis(ticker, signals, sentiment, marketData);

            this.emit('thought', {
                type: 'TRADE_ANALYSIS',
                asset: ticker,
                ...analysis
            });

            return analysis;
        } catch (e: any) {
            console.error('Local Analysis Error:', e.message);
            return { decision: 'WAIT', confidence: 0, reasoning: 'Analysis error' };
        }
    }

    /**
     * Core rule-based analysis engine
     */
    _ruleBasedAnalysis(ticker: string, signals: any, sentiment: any, marketData: any) {
        let score = 50;
        const reasons: string[] = [];
        const risks: string[] = [];

        // --- Signal Analysis ---
        if (Array.isArray(signals) && signals.length > 0) {
            const bullishSignals = signals.filter((s: any) =>
                s.action === 'BUY' || s.signal === 'Bullish' || s.type === 'BUY'
            );
            const bearishSignals = signals.filter((s: any) =>
                s.action === 'SELL' || s.signal === 'Bearish' || s.type === 'SELL'
            );

            if (bullishSignals.length > bearishSignals.length) {
                score += 10 * (bullishSignals.length - bearishSignals.length);
                reasons.push(`${bullishSignals.length} bullish vs ${bearishSignals.length} bearish signals`);
            } else if (bearishSignals.length > bullishSignals.length) {
                score -= 10 * (bearishSignals.length - bullishSignals.length);
                risks.push(`${bearishSignals.length} bearish signals dominate`);
            }

            const avgConfidence = signals.reduce((sum: number, s: any) => sum + (s.confidence || 0.5), 0) / signals.length;
            score += (avgConfidence - 0.5) * 40;
            if (avgConfidence > 0.7) reasons.push(`High avg signal confidence (${(avgConfidence * 100).toFixed(0)}%)`);

            const strategies = new Set(signals.map((s: any) => s.strategy).filter(Boolean));
            if (strategies.size >= 3) {
                score += 10;
                reasons.push(`${strategies.size}-strategy confluence`);
            }
        }

        // --- Market Data Analysis ---
        if (marketData) {
            const { rsi, emaSlope, change5m, volumeRatio } = marketData;

            if (typeof rsi === 'number') {
                if (rsi > 80) { score -= 25; risks.push(`Overbought RSI (${rsi.toFixed(0)})`); }
                else if (rsi > 70) { score -= 10; risks.push(`High RSI (${rsi.toFixed(0)})`); }
                else if (rsi < 15) { score -= 20; risks.push(`Falling knife RSI (${rsi.toFixed(0)})`); }
                else if (rsi < 30) { score += 10; reasons.push(`Oversold bounce (RSI ${rsi.toFixed(0)})`); }
                else if (rsi >= 40 && rsi <= 60) { score += 5; }
            }

            if (typeof volumeRatio === 'number') {
                if (volumeRatio < 0.3) { score -= 20; risks.push(`Low liquidity (${volumeRatio.toFixed(1)}x)`); }
                else if (volumeRatio > 2.0) { score += 10; reasons.push(`Strong volume (${volumeRatio.toFixed(1)}x)`); }
                else if (volumeRatio > 1.2) { score += 5; }
            }

            if (emaSlope === 'up' || emaSlope === 'bullish') { score += 10; reasons.push('EMA trend up'); }
            else if (emaSlope === 'down' || emaSlope === 'bearish') { score -= 10; risks.push('EMA trend down'); }

            if (typeof change5m === 'number') {
                if (change5m > 2) { score -= 10; risks.push(`Pumped ${change5m.toFixed(1)}% in 5m`); }
                else if (change5m < -3) { score -= 5; risks.push(`Dropped ${change5m.toFixed(1)}% in 5m`); }
                else if (change5m > 0.3 && change5m < 2) { score += 5; }
            }
        }

        // --- Sentiment ---
        if (sentiment && typeof sentiment === 'object') {
            const sentStr = (sentiment.overall || sentiment.sentiment || '').toUpperCase();
            if (sentStr.includes('FEAR') || sentStr.includes('BEARISH')) { score -= 10; risks.push('Negative sentiment'); }
            else if (sentStr.includes('GREED') || sentStr.includes('BULLISH')) { score += 5; reasons.push('Positive sentiment'); }
        }

        // --- Historical ---
        const tickerStats = this.strategyStats[ticker];
        if (tickerStats && tickerStats.trades > 5) {
            if (tickerStats.winRate > 60) { score += 5; reasons.push(`Good history (${tickerStats.winRate.toFixed(0)}% WR)`); }
            else if (tickerStats.winRate < 35) { score -= 10; risks.push(`Poor history (${tickerStats.winRate.toFixed(0)}% WR)`); }
        }

        const confidence = Math.max(0, Math.min(100, Math.round(score)));
        const decision = confidence >= 60 ? 'YES' : confidence >= 40 ? 'WAIT' : 'NO';
        const risk = risks.length >= 3 ? 'High' : risks.length >= 1 ? 'Medium' : 'Low';
        const reasoning = [
            ...reasons.slice(0, 3).map(r => `+ ${r}`),
            ...risks.slice(0, 2).map(r => `- ${r}`)
        ].join('; ') || 'Neutral conditions';

        return { decision, confidence, risk, reasoning };
    }

    async reviewTrade(trade: any) {
        this.tradeHistory.push(trade);
        const ticker = trade.ticker || 'UNKNOWN';
        if (!this.strategyStats[ticker]) {
            this.strategyStats[ticker] = { trades: 0, wins: 0, losses: 0, winRate: 50 };
        }
        const stats = this.strategyStats[ticker];
        stats.trades++;
        if (trade.pnl > 0 || trade.outcome === 'WIN') stats.wins++;
        if (trade.pnl < 0 || trade.outcome === 'LOSS') stats.losses++;
        stats.winRate = stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 50;

        if (this.tradeHistory.length % 5 === 0) {
            await this.conductRetrospective();
        }
    }

    async conductRetrospective() {
        const recentTrades = this.tradeHistory.slice(-5);
        const wins = recentTrades.filter((t: any) => t.pnl > 0 || t.outcome === 'WIN');
        const losses = recentTrades.filter((t: any) => t.pnl < 0 || t.outcome === 'LOSS');

        const insights: string[] = [];
        insights.push(`Last 5 trades: ${wins.length} wins, ${losses.length} losses`);

        if (losses.length >= 3) {
            insights.push('WARNING: 3+ losses - tighten stop losses or pause');
        }

        const text = insights.join('\n');
        this.learningLogs.push({ date: Date.now(), insights: text });
        this.emit('learning', { insights: text });
    }
}
