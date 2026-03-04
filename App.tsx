
import React, { useEffect, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RealTradingModal } from './components/RealTradingModal';
import SessionReconnect from './components/SessionReconnect';
import SessionHistory from './components/SessionHistory';
import { ToastProvider } from './components/ToastNotification';
import { TradingProvider, useTradingContext } from './contexts/TradingContext';
import { SettingsProvider, useSettingsContext } from './contexts/SettingsContext';
import { MarketDataProvider, useMarketDataContext } from './contexts/MarketDataContext';
import { useMarketData } from './hooks/useMarketData';
import { useIndicators } from './hooks/useIndicators';
import { useLearning } from './hooks/useLearning';
import { useScanner } from './hooks/useScanner';
import { useSessionActions } from './hooks/useSessionActions';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { NavBar } from './containers/NavBar';
import { LeftPanel } from './containers/LeftPanel';
import { CenterPanel } from './containers/CenterPanel';
import { RightPanel } from './containers/RightPanel';
import { TabLayout } from './containers/TabLayout';

// TanStack Query client — shared across the app
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

function AppContent() {
    const {
        isLoading, error, isAuthModalOpen, setIsAuthModalOpen,
        isSessionHistoryOpen, setIsSessionHistoryOpen,
        showReconnect, setShowReconnect, isBotActive,
        setIsVPSReconnect, setIsTradingActive, setIsBotActive,
        setIsScannerActive, setIsLoading, addLog, isTradingActive,
        tradingMode, isApiAuthenticated,
    } = useTradingContext();
    const { setUnlimitedTrades, currentExchange } = useSettingsContext();
    const { setLearningState } = useMarketDataContext();

    useMarketData();
    const { handleRunMonteCarlo } = useIndicators();
    useLearning();
    useScanner();
    const {
        handleStartSimulation, handleAuthenticate,
        handleCloseAllPositions, handleStopSession,
        handleRestoreSession, toggleBot,
    } = useSessionActions();

    useKeyboardShortcuts(toggleBot);

    // Unified start handler: REAL mode opens auth modal (or re-activates if already authenticated)
    const handleStart = useCallback((budget: number, ticker: string) => {
        if (tradingMode === 'REAL') {
            if (isApiAuthenticated) {
                // Already authenticated — re-activate the trading session
                setIsTradingActive(true);
                addLog('Real trading session re-activated.', 'SPECIAL');
            } else {
                setIsAuthModalOpen(true);
            }
        } else {
            handleStartSimulation(budget, ticker);
        }
    }, [tradingMode, handleStartSimulation, setIsAuthModalOpen, isApiAuthenticated, setIsTradingActive, addLog]);

    // Poll AI learning state from backend
    useEffect(() => {
        if (!isTradingActive) return;
        const fetchLearning = async () => {
            try {
                const res = await fetch('/api/system/status');
                if (res.ok) {
                    const data = await res.json();
                    if (data.aiLearning) setLearningState(data.aiLearning);
                }
            } catch {
                // Silently handle fetch errors
            }
        };
        fetchLearning();
        const interval = setInterval(fetchLearning, 10000);
        return () => clearInterval(interval);
    }, [isTradingActive, setLearningState]);

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
                <div className="text-center">
                    <div className="text-2xl">Initializing market data stream...</div>
                    <div className="text-xs text-gray-400 mt-4 max-w-md">
                        Disclaimer: This is a simulation. Real trading involves significant risk. Not financial advice.
                    </div>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex items-center justify-center h-screen bg-red-900/50 text-white p-8">
                <div className="text-center">
                    <h2 className="text-2xl font-bold mb-4 text-red-300">Application Error</h2>
                    <p className="text-lg text-red-200">{error}</p>
                    <button onClick={() => window.location.reload()} className="mt-6 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded">
                        Reload Application
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-900 text-white font-sans dot-grid-bg">
            {isAuthModalOpen && (
                <RealTradingModal
                    onClose={() => setIsAuthModalOpen(false)}
                    onAuthenticate={handleAuthenticate}
                    exchangeName={currentExchange === 'kraken' ? 'Kraken' : 'Crypto.com'}
                />
            )}
            <SessionHistory
                isOpen={isSessionHistoryOpen}
                onClose={() => setIsSessionHistoryOpen(false)}
                onRestore={handleRestoreSession}
                isSessionActive={isBotActive}
            />

            {showReconnect && !isBotActive && (
                <div className="fixed inset-0 z-50 bg-gray-900/95 flex items-center justify-center">
                    <SessionReconnect
                        onReconnect={() => {
                            setShowReconnect(false);
                            setIsVPSReconnect(true);
                            setIsTradingActive(true);
                            setIsBotActive(true);
                            setIsScannerActive(true);
                            setUnlimitedTrades(true);
                            setIsLoading(false);
                            addLog('Reconnected to active backend session (VPS mode)', 'SPECIAL');
                        }}
                        onStopSession={() => {
                            setShowReconnect(false);
                            setIsBotActive(false);
                            setIsTradingActive(false);
                        }}
                        onStartNew={() => {
                            setShowReconnect(false);
                        }}
                    />
                </div>
            )}

            <NavBar onOpenHistory={() => setIsSessionHistoryOpen(true)} />

            <TabLayout renderDashboard={() => (
                <main className="grid grid-cols-1 lg:grid-cols-12 gap-4 p-4">
                    <LeftPanel
                        onStart={handleStart}
                        toggleBot={toggleBot}
                        onCloseAll={handleCloseAllPositions}
                        onStopSession={handleStopSession}
                    />
                    <CenterPanel handleRunMonteCarlo={handleRunMonteCarlo} />
                    <RightPanel />
                </main>
            )} />
        </div>
    );
}

const App: React.FC = () => (
    <QueryClientProvider client={queryClient}>
        <SettingsProvider>
            <TradingProvider>
                <MarketDataProvider>
                    <ToastProvider>
                        <AppContent />
                    </ToastProvider>
                </MarketDataProvider>
            </TradingProvider>
        </SettingsProvider>
    </QueryClientProvider>
);

export default App;
