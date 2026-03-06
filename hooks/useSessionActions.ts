
import { useEffect, useCallback } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettingsContext } from '../contexts/SettingsContext';
import { tradingBotService } from '../services/tradingBotService';
import { resetEquityTracking } from '../services/riskMetricsService';
import type { ApiCredentials } from '../types';

export function useSessionActions() {
    const {
        addLog, setPortfolio, setTrades, setIsBotActive, setIsTradingActive,
        setIsApiAuthenticated, setIsAuthModalOpen,
        portfolio, isBotActive, isBotActiveRef, tradingMode, isApiAuthenticated,
        sessionStartTime, setSessionStartTime, setSystemLog, isTradingActive,
        setShowReconnect, setCheckingSession,
    } = useTradingContext();
    const { setTicker, setUnlimitedTrades } = useSettingsContext();

    // Check for active backend session on mount
    useEffect(() => {
        const checkForActiveSession = async () => {
            try {
                const res = await fetch('/api/session/full-status');
                const data = await res.json();
                if (data.sessionActive) setShowReconnect(true);
            } catch {
                // Backend not available
            } finally {
                setCheckingSession(false);
            }
        };
        checkForActiveSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Backend polling loop
    useEffect(() => {
        if (!isBotActive || !isTradingActive) return;
        const pollInterval = 2000;

        const pollBackend = async () => {
            try {
                const res = await fetch('/api/session/full-status');
                if (!res.ok) return;
                const data = await res.json();

                if (data.portfolio) {
                    setPortfolio(prev => ({
                        cash: data.portfolio.cash,
                        initialBudget: data.portfolio.initialBudget,
                        positions: (Array.isArray(data.portfolio.positions) ? data.portfolio.positions : []).reduce((acc: any, pos: any) => {
                            acc[pos.ticker] = {
                                quantity: pos.quantity, openPrice: pos.openPrice,
                                currentPrice: pos.currentPrice, entryStrategy: pos.entryStrategy,
                                entryTime: pos.entryTime, highestPrice: pos.highestPrice,
                                lowestPrice: pos.lowestPrice, unrealizedPnl: pos.unrealizedPnl,
                            };
                            return acc;
                        }, {}),
                        // Preserve wallet holdings from auth or update from backend
                        holdings: data.portfolio.holdings || prev.holdings,
                    }));
                }

                if (data.logs && data.logs.length > 0) {
                    setSystemLog(prev => {
                        const existingIds = new Set(prev.map((l: any) => l.id));
                        const newLogs = data.logs.filter((l: any) => !existingIds.has(l.id));
                        return newLogs.length > 0 ? [...newLogs, ...prev].slice(0, 200) : prev;
                    });
                }

                // Sync trades from backend
                try {
                    const tradesRes = await fetch('/api/session/trades?limit=200');
                    if (tradesRes.ok) {
                        const tradesData = await tradesRes.json();
                        if (tradesData.trades?.length > 0) {
                            setTrades(tradesData.trades.map((t: any) => ({
                                id: t.id, ticker: t.ticker, type: t.type, price: t.price,
                                quantity: t.quantity, pnl: t.pnl, strategy: t.strategy,
                                time: t.time, reason: t.reason,
                            })));
                        }
                    }
                } catch {
                    // Silently handle trade sync errors
                }

                // Restore unlimitedTrades setting from backend
                if (data.botState?.settings?.unlimitedTrades) {
                    setUnlimitedTrades(true);
                }

                if (!data.sessionActive && isBotActiveRef.current) {
                    setIsBotActive(false);
                    addLog('Session ended on backend', 'WARN');
                }
            } catch {
                // Silently handle polling errors
            }
        };

        pollBackend();
        const botInterval = setInterval(pollBackend, pollInterval);
        return () => clearInterval(botInterval);
    }, [isBotActive, isTradingActive, addLog, setPortfolio, setTrades, setSystemLog, setIsBotActive, setUnlimitedTrades, isBotActiveRef]);

    const handleStartSimulation = useCallback(async (budget: number, selectedTicker: string) => {
        addLog(`Starting SIMULATION session with $${budget} for ${selectedTicker}`);
        try {
            const res = await fetch('/api/session/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'SIMULATION', budget, tickers: [selectedTicker] }),
            });
            const data = await res.json();
            if (data.success) {
                setPortfolio({ cash: data.budget, initialBudget: data.budget, positions: {}, holdings: {} });
                setTicker(selectedTicker);
                setTrades([]);
                resetEquityTracking(0);
                setSessionStartTime(Date.now());
                setIsTradingActive(true);
                setIsBotActive(true);
                addLog(`Backend session started: ${data.sessionId}`, 'SPECIAL');
            } else {
                addLog(`Failed to start session: ${data.error}`, 'ERROR');
            }
        } catch (e: any) {
            addLog(`Session start error: ${e.message}`, 'ERROR');
            setPortfolio({ cash: budget, initialBudget: budget, positions: {}, holdings: {} });
            setTicker(selectedTicker);
            setTrades([]);
            resetEquityTracking(0);
            setSessionStartTime(Date.now());
            setIsTradingActive(true);
        }
    }, [addLog, setPortfolio, setTicker, setTrades, setSessionStartTime, setIsTradingActive, setIsBotActive]);

    const handleAuthenticate = useCallback(async (creds: ApiCredentials) => {
        try {
            addLog('Authenticating with backend...');
            const result = await tradingBotService.login(creds);
            if (!result) {
                throw new Error('Authentication failed. Please check your API keys.');
            }

            // Process balance from login response — fix fiat currencies stuck in holdings
            let cashUsd = result.balance ?? 0;
            const cleanHoldings: Record<string, any> = {};
            const FIAT = ['USD', 'CAD', 'EUR', 'GBP'];
            const CAD_TO_USD = 1 / 1.37;

            if (result.holdings) {
                for (const [asset, holding] of Object.entries(result.holdings) as [string, any][]) {
                    const upperAsset = asset.toUpperCase();
                    if (FIAT.includes(upperAsset)) {
                        // Fiat got stuck in holdings — move to cash
                        const qty = holding.quantity || 0;
                        if (upperAsset === 'CAD') {
                            cashUsd += qty * CAD_TO_USD;
                        } else {
                            cashUsd += qty;
                        }
                    } else if (holding.quantity > 1e-8) {
                        // Real crypto holding — try to price if usdValue missing
                        if (holding.usdValue > 0) {
                            cleanHoldings[asset] = holding;
                        } else {
                            // Fetch price from Kraken public API (no auth needed)
                            try {
                                const pair = asset === 'BTC' ? 'XBTUSD' : `${asset}USD`;
                                const res = await fetch(`/api/market-data?ticker=${pair}&timeframe=1m&limit=1`);
                                if (res.ok) {
                                    const data = await res.json();
                                    const candles = data.candles || data.data || [];
                                    const price = candles.length > 0 ? candles[candles.length - 1].c || candles[candles.length - 1].close || 0 : 0;
                                    if (price > 0) {
                                        cleanHoldings[asset] = { ...holding, usdValue: holding.quantity * price, price };
                                    } else {
                                        cleanHoldings[asset] = holding;
                                    }
                                } else {
                                    cleanHoldings[asset] = holding;
                                }
                            } catch {
                                cleanHoldings[asset] = holding;
                            }
                        }
                    }
                    // Skip dust amounts (< 1e-8)
                }
            }

            const holdingsValue = Object.values(cleanHoldings).reduce((sum: number, h: any) => sum + (h.usdValue || 0), 0);
            // If backend already included holdings in balance, use the larger value
            const totalBalance = Math.max(cashUsd, cashUsd + holdingsValue - (result.balance ?? 0) + holdingsValue);
            // Simpler: cashUsd already has fiat, add crypto holdings
            const finalBalance = cashUsd + holdingsValue;

            addLog(`Kraken authenticated! Balance: $${finalBalance.toFixed(2)} (Cash: $${cashUsd.toFixed(2)}, Holdings: $${holdingsValue.toFixed(2)})`, 'SPECIAL');
            setIsApiAuthenticated(true);
            setPortfolio({
                cash: finalBalance,
                initialBudget: finalBalance,
                positions: result.portfolio?.positions ?? {},
                holdings: cleanHoldings,
            });
            setIsTradingActive(true);
            setSessionStartTime(Date.now());
            resetEquityTracking(0);
            setIsAuthModalOpen(false);
            addLog('Real trading session active. Toggle the bot to start auto-trading.', 'SPECIAL');
        } catch (err: any) {
            addLog(err.message, 'ERROR');
            throw err;
        }
    }, [addLog, setIsApiAuthenticated, setIsAuthModalOpen, setPortfolio, setIsTradingActive, setSessionStartTime]);

    const handleCloseAllPositions = useCallback(async () => {
        addLog('Stopping session and closing all positions...', 'WARN');
        try {
            const res = await fetch('/api/session/stop', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setPortfolio({
                    cash: data.finalCash || 0,
                    initialBudget: data.initialBudget || portfolio.initialBudget,
                    positions: {},
                });
                setIsBotActive(false);
                addLog(`Session stopped. Final: $${data.finalCash?.toFixed(2)} (${data.pnlPercent}%)`, 'SPECIAL');
                if (data.closedPositions?.length > 0) {
                    data.closedPositions.forEach((p: any) => {
                        addLog(`Closed ${p.ticker}: PnL $${p.pnl?.toFixed(2)}`, 'SELL');
                    });
                }
            }
        } catch (e: any) {
            addLog(`Stop session error: ${e.message}`, 'ERROR');
        }
    }, [addLog, setPortfolio, setIsBotActive, portfolio.initialBudget]);

    const handleStopSession = useCallback(async () => {
        addLog('Stopping entire session...', 'WARN');
        try {
            const res = await fetch('/api/session/stop', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setPortfolio({ cash: 0, initialBudget: 0, positions: {} });
                setIsBotActive(false);
                setIsTradingActive(false);
                addLog(`Session ended. Final value: $${data.finalCash?.toFixed(2)} | PnL: ${data.pnlPercent}% | Trades: ${data.totalTrades || 0}`, 'SPECIAL');
            }
        } catch (e: any) {
            addLog(`Stop session error: ${e.message}`, 'ERROR');
        }
    }, [addLog, setPortfolio, setIsBotActive, setIsTradingActive]);

    const handleRestoreSession = useCallback(async (sessionId: string) => {
        try {
            const res = await fetch(`/api/sessions/${sessionId}/restore`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setPortfolio({ cash: data.budget, initialBudget: data.budget, positions: {}, holdings: {} });
                setIsTradingActive(true);
                setIsBotActive(true);
                addLog(`Restored session from ${data.restoredFrom} with $${data.budget.toFixed(2)}`, 'SPECIAL');
            }
        } catch (e: any) {
            addLog(`Restore failed: ${e.message}`, 'ERROR');
        }
    }, [addLog, setPortfolio, setIsTradingActive, setIsBotActive]);

    const toggleBot = useCallback(async (isActive: boolean) => {
        if (isActive && tradingMode === 'REAL' && !isApiAuthenticated) {
            addLog('Cannot start real trading bot without API authentication.', 'ERROR');
            setIsAuthModalOpen(true);
            return;
        }

        try {
            if (isActive) {
                const res = await fetch('/api/session/resume', { method: 'POST' });
                const data = await res.json();
                setIsBotActive(data.botActive);
                addLog(`Auto-trading bot has been ACTIVATED. Mode: ${tradingMode}.`, 'SPECIAL');
                if (!sessionStartTime) {
                    setSessionStartTime(Date.now());
                    resetEquityTracking(0);
                }
            } else {
                const res = await fetch('/api/session/pause', { method: 'POST' });
                const data = await res.json();
                setIsBotActive(data.botActive);
                addLog('Auto-trading bot has been PAUSED.', 'WARN');
            }
        } catch (e: any) {
            addLog(`Bot toggle error: ${e.message}`, 'ERROR');
            setIsBotActive(isActive);
        }
    }, [addLog, tradingMode, isApiAuthenticated, sessionStartTime, setIsBotActive, setIsAuthModalOpen, setSessionStartTime]);

    return {
        handleStartSimulation,
        handleAuthenticate,
        handleCloseAllPositions,
        handleStopSession,
        handleRestoreSession,
        toggleBot,
    };
}
