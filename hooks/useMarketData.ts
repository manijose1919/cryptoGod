
import { useEffect, useCallback } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettingsContext } from '../contexts/SettingsContext';
import { useMarketDataContext } from '../contexts/MarketDataContext';
import { fetchHistoricalCandles, fetchAvailableUsdPairs, setActiveExchange as setMarketServiceExchange } from '../services/marketService';
import { calculateTCSeries } from '../services/indicatorService';
import { WEBSOCKET_CONFIG, INTERVALS, INDICATOR_PARAMS, TIME_FRAMES_MAP } from '../constants';

export function useMarketData() {
    const {
        addLog, isTradingActive, isVPSReconnect, setIsLoading, setError,
    } = useTradingContext();
    const {
        ticker, setTicker, setCurrentExchange, setCurrentExchangeFees,
    } = useSettingsContext();
    const {
        ws, watchlistDataRef, availableTickersRef, reconnectAttempts, reconnectTimeout,
        activeWatchlistData, setActiveWatchlistData, updateWatchlistData,
        setMtfData, setIsMtfLoading,
    } = useMarketDataContext();

    // Fetch current exchange on mount
    useEffect(() => {
        fetch('/api/exchange/current')
            .then(r => r.json())
            .then(data => {
                if (data.exchange) {
                    setCurrentExchange(data.exchange);
                    setMarketServiceExchange(data.exchange);
                }
                if (data.feePercent) setCurrentExchangeFees({
                    takerFee: data.feePercent,
                    roundTripFee: data.roundTripFeePercent || data.feePercent * 2,
                });
            })
            .catch(() => { /* Backend not running yet */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // WebSocket connection
    const connectWebSocket = useCallback((_tickers: string[]) => {
        if (ws.current) {
            ws.current.onclose = null;
            ws.current.close();
            ws.current = null;
        }

        const connect = () => {
            if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
            addLog(`Connecting to market data stream (attempt ${reconnectAttempts.current + 1})...`);

            const socket = new WebSocket(WEBSOCKET_CONFIG.URL);
            ws.current = socket;

            socket.onopen = () => {
                if (ws.current !== socket) return;
                addLog('Market data stream connected (via backend relay).');
                reconnectAttempts.current = 0;
            };

            socket.onmessage = (event) => {
                if (ws.current !== socket) return;
                const message = JSON.parse(event.data);

                if (message.method === 'public/heartbeat') {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ id: message.id, method: 'public/respond-heartbeat' }));
                    }
                    return;
                }

                const channel = message.result?.channel ?? '';
                if (message.method === 'subscribe' && (channel.startsWith('candlestick') || channel === 'kline')) {
                    const instrument = message.result?.instrument_name;
                    const candleData = message.result?.data?.[0];
                    if (!candleData || !instrument) return;

                    const symbol = instrument.replace('_', '');
                    const newCandle = {
                        time: candleData.t,
                        open: parseFloat(candleData.o),
                        high: parseFloat(candleData.h),
                        low: parseFloat(candleData.l),
                        close: parseFloat(candleData.c),
                        volume: parseFloat(candleData.v),
                    };

                    const currentData = watchlistDataRef.current[symbol];
                    if (currentData) {
                        let updatedCandles = [...currentData.candles];
                        if (updatedCandles.length > 0 && updatedCandles.at(-1)!.time === newCandle.time) {
                            updatedCandles[updatedCandles.length - 1] = newCandle;
                        } else {
                            updatedCandles = [...updatedCandles.slice(1), newCandle];
                        }

                        const lastCandle = currentData.candles.at(-1);
                        if (!lastCandle || lastCandle.close !== newCandle.close || lastCandle.time !== newCandle.time) {
                            watchlistDataRef.current[symbol] = updateWatchlistData(updatedCandles, symbol);
                        }
                    }
                }
            };

            socket.onerror = () => {
                if (ws.current !== socket) return;
                addLog('Market data stream error.', 'ERROR');
            };

            socket.onclose = () => {
                if (ws.current !== socket) return;
                if (reconnectAttempts.current < 3) {
                    addLog('Market data stream disconnected.', 'INFO');
                }
                if (reconnectAttempts.current < WEBSOCKET_CONFIG.RECONNECT_MAX_ATTEMPTS) {
                    const delay = Math.min(
                        WEBSOCKET_CONFIG.RECONNECT_INITIAL_DELAY_MS * Math.pow(2, reconnectAttempts.current),
                        WEBSOCKET_CONFIG.RECONNECT_MAX_DELAY_MS
                    );
                    reconnectAttempts.current++;
                    if (reconnectAttempts.current <= 3) {
                        addLog(`Reconnecting in ${delay / 1000}s...`, 'INFO');
                    }
                    reconnectTimeout.current = setTimeout(() => connect(), delay);
                } else {
                    addLog('WebSocket unavailable. Using REST polling for market data.', 'INFO');
                }
            };
        };

        connect();
    }, [addLog, updateWatchlistData, ws, watchlistDataRef, reconnectAttempts, reconnectTimeout]);

    // Market data setup
    useEffect(() => {
        if (!isTradingActive) return;
        if (isVPSReconnect) {
            addLog('VPS reconnect mode — skipping candle initialization, connecting WebSocket only.', 'INFO');
            connectWebSocket([]);
            setIsLoading(false);
            return;
        }

        const setupMarketData = async () => {
            setIsLoading(true);
            setError(null);
            try {
                addLog('Fetching available markets from /api/instruments...');
                let tickers = await fetchAvailableUsdPairs();
                tickers = tickers.slice(0, 12);
                availableTickersRef.current = tickers;
                addLog(`Found ${tickers.length} active markets for initialization. Initializing...`);

                const initialWatchlistData = {} as Record<string, ReturnType<typeof updateWatchlistData>>;
                const failedTickers: string[] = [];
                let successfulFetches = 0;
                let firstSuccessfulTicker: string | null = null;

                for (const t of tickers) {
                    try {
                        addLog(`Fetching initial 1m candles for ${t}...`);
                        const candles = await fetchHistoricalCandles(t, '1m', INDICATOR_PARAMS.MAX_CANDLES_STORED);
                        if (candles.length > 0) {
                            initialWatchlistData[t] = updateWatchlistData(candles, t);
                            successfulFetches++;
                            if (!firstSuccessfulTicker) firstSuccessfulTicker = t;
                        } else {
                            addLog(`No candle data returned for ${t}, skipping.`, 'INFO');
                            failedTickers.push(t);
                        }
                    } catch (e: unknown) {
                        addLog(`Failed to fetch initial data for ${t}: ${e instanceof Error ? e.message : 'Unknown error'}`, 'ERROR');
                        failedTickers.push(t);
                    }
                    await new Promise(resolve => setTimeout(resolve, INTERVALS.API_THROTTLE_MS));
                }

                if (successfulFetches === 0) {
                    throw new Error("Failed to fetch market data for all tickers. Backend proxy might be down or API is unresponsive.");
                }

                watchlistDataRef.current = initialWatchlistData;
                const startTicker = ticker || firstSuccessfulTicker;
                if (startTicker && initialWatchlistData[startTicker]) {
                    setTicker(startTicker);
                    setActiveWatchlistData(initialWatchlistData[startTicker]);
                } else if (firstSuccessfulTicker) {
                    setTicker(firstSuccessfulTicker);
                    setActiveWatchlistData(initialWatchlistData[firstSuccessfulTicker]);
                }

                addLog(`Initialized historical data for ${successfulFetches}/${tickers.length} tickers.`);
                if (failedTickers.length > 0) {
                    addLog(`Could not initialize: ${failedTickers.join(', ')}.`, 'ERROR');
                }
                connectWebSocket(Object.keys(initialWatchlistData));
            } catch (e: unknown) {
                const errorMsg = `Critical setup failure: ${e instanceof Error ? e.message : 'Unknown error'}`;
                setError(errorMsg);
                addLog(errorMsg, 'ERROR');
            } finally {
                setIsLoading(false);
            }
        };

        setupMarketData();

        return () => {
            if (ws.current) { ws.current.onclose = null; ws.current.close(); }
            if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isTradingActive]);

    // UI refresh
    useEffect(() => {
        const interval = setInterval(() => {
            const newData = watchlistDataRef.current[ticker];
            if (newData && newData.lastUpdated !== activeWatchlistData?.lastUpdated) {
                setActiveWatchlistData(newData);
            }
        }, INTERVALS.UI_REFRESH_MS);
        return () => clearInterval(interval);
    }, [ticker, activeWatchlistData?.lastUpdated, watchlistDataRef, setActiveWatchlistData]);

    // REST polling fallback
    useEffect(() => {
        if (!isTradingActive) return;
        const pollMarketData = async () => {
            const tickers = Object.keys(watchlistDataRef.current || {});
            if (tickers.length === 0) return;
            const tickersPerCycle = 5;
            const cycleIndex = Math.floor(Date.now() / 10000) % Math.ceil(tickers.length / tickersPerCycle);
            const tickersToUpdate = tickers.slice(cycleIndex * tickersPerCycle, (cycleIndex + 1) * tickersPerCycle);

            for (const tickerSymbol of tickersToUpdate) {
                try {
                    const candles = await fetchHistoricalCandles(tickerSymbol, '1m', 50);
                    if (candles.length > 0) {
                        const currentData = watchlistDataRef.current[tickerSymbol];
                        if (currentData) {
                            const existingTimes = new Set(currentData.candles.map(c => c.time));
                            const newCandles = candles.filter(c => !existingTimes.has(c.time));
                            if (newCandles.length > 0 || candles.at(-1)?.close !== currentData.candles.at(-1)?.close) {
                                const mergedCandles = [...currentData.candles];
                                const latestCandle = candles.at(-1);
                                if (latestCandle && mergedCandles.at(-1)?.time === latestCandle.time) {
                                    mergedCandles[mergedCandles.length - 1] = latestCandle;
                                } else if (latestCandle) {
                                    mergedCandles.push(latestCandle);
                                }
                                const trimmedCandles = mergedCandles.slice(-INDICATOR_PARAMS.MAX_CANDLES_STORED);
                                watchlistDataRef.current[tickerSymbol] = updateWatchlistData(trimmedCandles, tickerSymbol);
                            }
                        }
                    }
                } catch {
                    // Silently ignore
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        };

        const pollInterval = setInterval(pollMarketData, 10000);
        const initialPoll = setTimeout(pollMarketData, 2000);
        return () => { clearInterval(pollInterval); clearTimeout(initialPoll); };
    }, [isTradingActive, updateWatchlistData, watchlistDataRef]);

    // MTF data
    useEffect(() => {
        if (!ticker || !isTradingActive) return;
        const fetchMtfData = async () => {
            setIsMtfLoading(true);
            try {
                const timeframes = Object.values(TIME_FRAMES_MAP);
                const promises = timeframes.map(tf => fetchHistoricalCandles(ticker, tf, INDICATOR_PARAMS.MAX_CANDLES_STORED));
                const results = await Promise.all(promises);
                const newMtfData: Record<string, number> = {};
                Object.keys(TIME_FRAMES_MAP).forEach((tfDisplay, index) => {
                    const series = calculateTCSeries(results[index]);
                    newMtfData[tfDisplay] = series.length > 0 ? series.at(-1) ?? 50 : 50;
                });
                setMtfData(newMtfData);
            } catch (e: unknown) {
                addLog(`Failed to load MTF data for ${ticker}: ${e instanceof Error ? e.message : 'Unknown error'}`, 'ERROR');
            } finally {
                setIsMtfLoading(false);
            }
        };
        fetchMtfData();
    }, [ticker, isTradingActive, addLog, setMtfData, setIsMtfLoading]);
}
