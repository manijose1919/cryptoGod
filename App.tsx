
import React from 'react';
import { RealTradingModal } from './components/RealTradingModal';
import SessionReconnect from './components/SessionReconnect';
import SessionHistory from './components/SessionHistory';
import { ToastProvider } from './components/ToastNotification';
import { TradingProvider, useTradingContext } from './contexts/TradingContext';
import { SettingsProvider } from './contexts/SettingsContext';
import { MarketDataProvider } from './contexts/MarketDataContext';
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

function AppContent() {
    const {
        isLoading, error, isAuthModalOpen, setIsAuthModalOpen,
        isSessionHistoryOpen, setIsSessionHistoryOpen,
        showReconnect, setShowReconnect, isBotActive,
        setIsVPSReconnect, setIsTradingActive, setIsBotActive,
        setIsScannerActive, setIsLoading, addLog,
    } = useTradingContext();

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

            <main className="grid grid-cols-1 lg:grid-cols-12 gap-4 p-4">
                <LeftPanel
                    onStart={handleStartSimulation}
                    toggleBot={toggleBot}
                    onCloseAll={handleCloseAllPositions}
                    onStopSession={handleStopSession}
                />
                <CenterPanel handleRunMonteCarlo={handleRunMonteCarlo} />
                <RightPanel />
            </main>
        </div>
    );
}

const App: React.FC = () => (
    <SettingsProvider>
        <TradingProvider>
            <MarketDataProvider>
                <ToastProvider>
                    <AppContent />
                </ToastProvider>
            </MarketDataProvider>
        </TradingProvider>
    </SettingsProvider>
);

export default App;
