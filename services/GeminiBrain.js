
import { EventEmitter } from 'events';

/**
 * Local AI Brain
 * Rule-based trade analysis engine - no external API needed.
 * - Analyzes trades using indicator signals, sentiment, and market data
 * - Learns from trade history with statistical pattern analysis
 * - Suggests strategy adjustments via retrospectives
 */
export class GeminiBrain extends EventEmitter {
    constructor() {
        super();
        this.tradeHistory = [];
        this.learningLogs = [];
        this.strategyStats = {};
    }

    /**
     * Analyze a potential trade using local rules
     */
    async analyzeTradeOpportunity(ticker, signals, sentiment, marketData) {
        try {
            const analysis = this._ruleBasedAnalysis(ticker, signals, sentiment, marketData);

            this.emit('thought', {
                type: 'TRADE_ANALYSIS',
                asset: ticker,
                ...analysis
            });

            return analysis;
        } catch (e) {
            console.error('Local Analysis Error:', e.message);
            return { decision: 'WAIT', confidence: 0, reasoning: 'Analysis error' };
        }
    }

    /**
     * Core rule-based analysis engine
     */
    _ruleBasedAnalysis(ticker, signals, sentiment, marketData) {
        let score = 50; // Start neutral
        const reasons = [];
        const risks = [];

        // --- Signal Analysis ---
        if (Array.isArray(signals) && signals.length > 0) {
            const bullishSignals = signals.filter(s =>
                s.action === 'BUY' || s.signal === 'Bullish' || s.type === 'BUY'
            );
            const bearishSignals = signals.filter(s =>
                s.action === 'SELL' || s.signal === 'Bearish' || s.type === 'SELL'
            );

            if (bullishSignals.length > bearishSignals.length) {
                score += 10 * (bullishSignals.length - bearishSignals.length);
                reasons.push(`${bullishSignals.length} bullish vs ${bearishSignals.length} bearish signals`);
            } else if (bearishSignals.length > bullishSignals.length) {
                score -= 10 * (bearishSignals.length - bullishSignals.length);
                risks.push(`${bearishSignals.length} bearish signals dominate`);
            }

            // Check signal confidence
            const avgConfidence = signals.reduce((sum, s) => sum + (s.confidence || 0.5), 0) / signals.length;
            score += (avgConfidence - 0.5) * 40; // -20 to +20
            if (avgConfidence > 0.7) reasons.push(`High avg signal confidence (${(avgConfidence * 100).toFixed(0)}%)`);

            // Check for confluence (multiple strategies agree)
            const strategies = new Set(signals.map(s => s.strategy).filter(Boolean));
            if (strategies.size >= 3) {
                score += 10;
                reasons.push(`${strategies.size}-strategy confluence`);
            }
        }

        // --- Market Data Analysis ---
        if (marketData) {
            const { price, volume, rsi, emaSlope, change5m, volumeRatio } = marketData;

            // RSI checks
            if (typeof rsi === 'number') {
                if (rsi > 80) {
                    score -= 25;
                    risks.push(`Overbought RSI (${rsi.toFixed(0)})`);
                } else if (rsi > 70) {
                    score -= 10;
                    risks.push(`High RSI (${rsi.toFixed(0)})`);
                } else if (rsi < 15) {
                    score -= 20;
                    risks.push(`Falling knife RSI (${rsi.toFixed(0)})`);
                } else if (rsi < 30) {
                    score += 10;
                    reasons.push(`Oversold bounce opportunity (RSI ${rsi.toFixed(0)})`);
                } else if (rsi >= 40 && rsi <= 60) {
                    score += 5;
                    reasons.push('RSI in neutral zone');
                }
            }

            // Volume analysis
            if (typeof volumeRatio === 'number') {
                if (volumeRatio < 0.3) {
                    score -= 20;
                    risks.push(`Low liquidity (${volumeRatio.toFixed(1)}x avg volume)`);
                } else if (volumeRatio > 2.0) {
                    score += 10;
                    reasons.push(`Strong volume (${volumeRatio.toFixed(1)}x avg)`);
                } else if (volumeRatio > 1.2) {
                    score += 5;
                    reasons.push('Above-average volume');
                }
            }

            // EMA slope (trend direction)
            if (emaSlope === 'up' || emaSlope === 'bullish') {
                score += 10;
                reasons.push('EMA trend up');
            } else if (emaSlope === 'down' || emaSlope === 'bearish') {
                score -= 10;
                risks.push('EMA trend down');
            }

            // Recent momentum
            if (typeof change5m === 'number') {
                if (change5m > 2) {
                    score -= 10; // FOMO risk
                    risks.push(`Already pumped ${change5m.toFixed(1)}% in 5m`);
                } else if (change5m < -3) {
                    score -= 5;
                    risks.push(`Sharp drop ${change5m.toFixed(1)}% in 5m`);
                } else if (change5m > 0.3 && change5m < 2) {
                    score += 5;
                    reasons.push('Healthy upward momentum');
                }
            }
        }

        // --- Sentiment Analysis ---
        if (sentiment && typeof sentiment === 'object') {
            const sentStr = (sentiment.overall || sentiment.sentiment || '').toUpperCase();
            if (sentStr.includes('FEAR') || sentStr.includes('BEARISH')) {
                score -= 10;
                risks.push('Negative market sentiment');
            } else if (sentStr.includes('GREED') || sentStr.includes('BULLISH')) {
                score += 5;
                reasons.push('Positive market sentiment');
            }
        }

        // --- Historical Learning ---
        const tickerStats = this.strategyStats[ticker];
        if (tickerStats && tickerStats.trades > 5) {
            if (tickerStats.winRate > 60) {
                score += 5;
                reasons.push(`Good history: ${tickerStats.winRate.toFixed(0)}% win rate`);
            } else if (tickerStats.winRate < 35) {
                score -= 10;
                risks.push(`Poor history: ${tickerStats.winRate.toFixed(0)}% win rate`);
            }
        }

        // Clamp score
        const confidence = Math.max(0, Math.min(100, Math.round(score)));

        // Decision logic
        let decision;
        if (confidence >= 60) {
            decision = 'YES';
        } else if (confidence >= 40) {
            decision = 'WAIT';
        } else {
            decision = 'NO';
        }

        // Risk assessment
        let risk;
        if (risks.length >= 3) risk = 'High';
        else if (risks.length >= 1) risk = 'Medium';
        else risk = 'Low';

        const reasoning = [
            ...reasons.slice(0, 3).map(r => `+ ${r}`),
            ...risks.slice(0, 2).map(r => `- ${r}`)
        ].join('; ') || 'Neutral conditions';

        return { decision, confidence, risk, reasoning };
    }

    /**
     * Post-Trade Analysis & Learning
     */
    async reviewTrade(trade) {
        this.tradeHistory.push(trade);

        // Update per-ticker stats
        const ticker = trade.ticker || 'UNKNOWN';
        if (!this.strategyStats[ticker]) {
            this.strategyStats[ticker] = { trades: 0, wins: 0, losses: 0, winRate: 50 };
        }
        const stats = this.strategyStats[ticker];
        stats.trades++;
        if (trade.pnl > 0 || trade.outcome === 'WIN') stats.wins++;
        if (trade.pnl < 0 || trade.outcome === 'LOSS') stats.losses++;
        stats.winRate = stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 50;

        // Every 5 trades, do a retrospective
        if (this.tradeHistory.length % 5 === 0) {
            await this.conductRetrospective();
        }
    }

    async conductRetrospective() {
        const recentTrades = this.tradeHistory.slice(-5);

        const wins = recentTrades.filter(t => t.pnl > 0 || t.outcome === 'WIN');
        const losses = recentTrades.filter(t => t.pnl < 0 || t.outcome === 'LOSS');

        const insights = [];
        insights.push(`Last 5 trades: ${wins.length} wins, ${losses.length} losses`);

        // Pattern detection
        const winStrategies = wins.map(t => t.signal?.strategy || t.strategy).filter(Boolean);
        const lossStrategies = losses.map(t => t.signal?.strategy || t.strategy).filter(Boolean);

        if (winStrategies.length > 0) {
            const common = this._mostCommon(winStrategies);
            insights.push(`Winning strategy: ${common}`);
        }
        if (lossStrategies.length > 0) {
            const common = this._mostCommon(lossStrategies);
            insights.push(`Losing strategy: ${common} - consider reducing weight`);
        }

        // Check if losses are consecutive
        if (losses.length >= 3) {
            insights.push('WARNING: 3+ consecutive losses - tighten stop losses or pause');
        }

        const text = insights.join('\n');
        this.learningLogs.push({ date: Date.now(), insights: text });
        this.emit('learning', { insights: text });
    }

    _mostCommon(arr) {
        const counts = {};
        arr.forEach(v => counts[v] = (counts[v] || 0) + 1);
        return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
    }
}
