/**
 * TabLayout — Bloomberg Terminal-style tabbed navigation.
 * Function-key bar at top, ticker tape, status bar at bottom.
 */

import React, { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { ExchangeDashboard } from '../components/ExchangeDashboard';
import { PortfolioOverview } from '../components/PortfolioOverview';
import { useAllEnginesStatus } from '../hooks/useEngineAPI';
import { useThemeStore } from '../stores/themeStore';
import { useToast } from '../components/ToastNotification';

const TickerTape = lazy(() => import('../components/TickerTape'));
const MLIntelligenceTab = lazy(() => import('../components/MLIntelligenceTab'));
const SystemConfigPanel = lazy(() => import('../components/SystemConfigPanel'));
const V2AttributionTab = lazy(() => import('../components/V2AttributionTab'));

export type TabId = 'dashboard' | 'kraken' | 'crypto.com' | 'portfolio' | 'ml' | 'config' | 'v2';

interface TabDef {
  id: TabId;
  label: string;
  key: string; // Bloomberg function-key style
  color: string;
}

const TABS: TabDef[] = [
  { id: 'dashboard', label: 'Dashboard', key: 'F1', color: '#6366f1' },
  { id: 'kraken', label: 'Kraken', key: 'F2', color: '#3b82f6' },
  { id: 'crypto.com', label: 'CDC', key: 'F3', color: '#8b5cf6' },
  { id: 'portfolio', label: 'Portfolio', key: 'F4', color: '#10b981' },
  { id: 'ml', label: 'ML', key: 'F5', color: '#a78bfa' },
  { id: 'config', label: 'Config', key: 'F6', color: '#f59e0b' },
  { id: 'v2', label: 'V2', key: 'F7', color: '#ec4899' },
];

interface Props {
  renderDashboard: () => React.ReactNode;
}

const SHORTCUTS = [
  { key: 'F1', desc: 'Dashboard' },
  { key: 'F2', desc: 'Kraken Exchange' },
  { key: 'F3', desc: 'Crypto.com Exchange' },
  { key: 'F4', desc: 'Portfolio Overview' },
  { key: 'F5', desc: 'ML Intelligence' },
  { key: 'F6', desc: 'System Config' },
  { key: 'F7', desc: 'V2 Attribution' },
  { key: '?', desc: 'Show this help' },
];

export function TabLayout({ renderDashboard }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const stored = localStorage.getItem('cryptogod-active-tab');
    return (stored && TABS.some(t => t.id === stored)) ? stored as TabId : 'dashboard';
  });
  const { data: enginesData } = useAllEnginesStatus();
  const { isDark, toggle: toggleTheme } = useThemeStore();
  const [clock, setClock] = useState(new Date().toLocaleTimeString([], { hour12: false }));
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Live clock
  useEffect(() => {
    const iv = setInterval(() => setClock(new Date().toLocaleTimeString([], { hour12: false })), 1000);
    return () => clearInterval(iv);
  }, []);

  const handleTabClick = useCallback((tabId: TabId) => {
    setActiveTab(tabId);
    localStorage.setItem('cryptogod-active-tab', tabId);
  }, []);

  // F-key keyboard shortcuts for tab switching
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const fKeyMap: Record<string, TabId> = {
        F1: 'dashboard', F2: 'kraken', F3: 'crypto.com',
        F4: 'portfolio', F5: 'ml', F6: 'config', F7: 'v2',
      };
      if (fKeyMap[e.key]) {
        e.preventDefault();
        setActiveTab(fKeyMap[e.key]);
        localStorage.setItem('cryptogod-active-tab', fKeyMap[e.key]);
      }
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setShowShortcuts(prev => !prev);
      }
      if (e.key === 'Escape') setShowShortcuts(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const krakenState = enginesData?.engines?.kraken?.state;
  const cdcState = enginesData?.engines?.['crypto.com']?.state;
  const { addToast } = useToast();

  // Aggregated status bar values
  const krakenEngine = enginesData?.engines?.kraken as any;
  const cdcEngine = enginesData?.engines?.['crypto.com'] as any;
  const totalPositions = (krakenEngine?.portfolio?.positions || 0) + (cdcEngine?.portfolio?.positions || 0);
  const totalTrades = (krakenEngine?.trades?.total || 0) + (cdcEngine?.trades?.total || 0);
  const cbPaused = krakenEngine?.circuitBreaker?.isPaused || cdcEngine?.circuitBreaker?.isPaused;

  // Fear & Greed index (lightweight poll)
  const [fearGreed, setFearGreed] = useState<{ value: number; label: string } | null>(null);
  useEffect(() => {
    const fetchFG = () => {
      fetch('/api/fear-greed/status').then(r => r.ok ? r.json() : null)
        .then(d => { if (d && d.value !== undefined) setFearGreed(d); })
        .catch(() => {});
    };
    fetchFG();
    const iv = setInterval(fetchFG, 60000);
    return () => clearInterval(iv);
  }, []);

  // Detect trade count changes and engine state changes → show toasts
  const prevTradeCount = useRef<Record<string, number>>({});
  const prevEngineState = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!enginesData?.engines) return;
    for (const [ex, engine] of Object.entries(enginesData.engines) as [string, any][]) {
      if (!engine) continue;
      const label = ex === 'crypto.com' ? 'CDC' : 'Kraken';

      // Detect new trades (trade count increased)
      const tradeTotal = engine.trades?.total ?? 0;
      const prevCount = prevTradeCount.current[ex];
      if (prevCount !== undefined && tradeTotal > prevCount) {
        const diff = tradeTotal - prevCount;
        addToast('trade', `${label}: ${diff} new trade${diff > 1 ? 's' : ''}`,
          `Total: ${tradeTotal} | WR: ${(engine.trades?.winRate || 0).toFixed(0)}%`);
      }
      prevTradeCount.current[ex] = tradeTotal;

      // Detect engine state changes
      const state = engine.state;
      const prev = prevEngineState.current[ex];
      if (prev && prev !== state) {
        if (state === 'RUNNING') addToast('success', `${label} Engine Running`);
        else if (state === 'PAUSED' && engine.circuitBreaker?.isPaused)
          addToast('error', `${label} Circuit Breaker`, 'Trading paused due to excessive losses');
        else if (state === 'PAUSED') addToast('warning', `${label} Engine Paused`);
        else if (state === 'IDLE' && prev === 'RUNNING') addToast('info', `${label} Engine Stopped`);
      }
      prevEngineState.current[ex] = state;
    }
  }, [enginesData, addToast]);

  return (
    <div className="tab-layout">
      {/* ═══ TICKER TAPE ═══ */}
      <Suspense fallback={null}>
        <TickerTape />
      </Suspense>

      {/* ═══ FUNCTION BAR ═══ */}
      <nav className="tab-bar" style={{ alignItems: 'center', overflowX: 'auto' }}>
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const engineState = tab.id === 'kraken' ? krakenState
            : tab.id === 'crypto.com' ? cdcState : null;

          return (
            <button
              key={tab.id}
              className={`tab-btn ${isActive ? 'tab-btn-active' : ''}`}
              onClick={() => handleTabClick(tab.id)}
            >
              <span style={{ color: 'var(--text-muted)', fontSize: '9px', fontWeight: 700 }}>{tab.key}</span>
              <span className="tab-label">{tab.label}</span>
              {engineState && (
                <span className={`tab-indicator tab-indicator-${engineState.toLowerCase()}`} />
              )}
            </button>
          );
        })}

        {/* Right side controls */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px', paddingRight: '8px' }}>
          <button className="theme-toggle" onClick={() => setShowShortcuts(true)}
            title="Keyboard shortcuts (?)" style={{ fontSize: '12px', opacity: 0.6 }}>
            ?
          </button>
          <button className="theme-toggle" onClick={toggleTheme}
            title={isDark ? 'Light mode' : 'Dark mode'}>
            {isDark ? '\u2600\uFE0F' : '\u{1F319}'}
          </button>
        </div>
      </nav>

      {/* ═══ TAB CONTENT ═══ */}
      <div className="tab-content">
        {activeTab === 'dashboard' && renderDashboard()}
        {activeTab === 'kraken' && <ExchangeDashboard exchange="kraken" />}
        {activeTab === 'crypto.com' && <ExchangeDashboard exchange="crypto.com" />}
        {activeTab === 'portfolio' && <PortfolioOverview />}
        {activeTab === 'ml' && (
          <Suspense fallback={<div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading ML dashboard...</div>}>
            <MLIntelligenceTab />
          </Suspense>
        )}
        {activeTab === 'config' && (
          <Suspense fallback={<div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading config...</div>}>
            <SystemConfigPanel />
          </Suspense>
        )}
        {activeTab === 'v2' && (
          <Suspense fallback={<div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading V2 attribution...</div>}>
            <V2AttributionTab />
          </Suspense>
        )}
      </div>

      {/* ═══ KEYBOARD SHORTCUT MODAL ═══ */}
      {showShortcuts && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setShowShortcuts(false)}
        >
          <div
            style={{
              background: 'var(--bg-card, #1e293b)', border: '1px solid var(--border-primary)',
              borderRadius: '12px', padding: '24px 32px', minWidth: '300px',
              boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-header)', marginBottom: '16px', letterSpacing: '0.5px' }}>
              KEYBOARD SHORTCUTS
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr', gap: '8px 16px' }}>
              {SHORTCUTS.map(s => (
                <React.Fragment key={s.key}>
                  <kbd style={{
                    background: 'var(--bg-primary, #0f172a)', border: '1px solid var(--border-primary)',
                    borderRadius: '4px', padding: '2px 8px', fontSize: '11px', fontWeight: 700,
                    color: 'var(--text-header)', fontFamily: 'var(--font-mono)', textAlign: 'center',
                  }}>
                    {s.key}
                  </kbd>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '24px' }}>
                    {s.desc}
                  </span>
                </React.Fragment>
              ))}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '16px', textAlign: 'center' }}>
              Press <kbd style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: '3px', border: '1px solid var(--border-primary)' }}>ESC</kbd> to close
            </div>
          </div>
        </div>
      )}

      {/* ═══ STATUS BAR (Bloomberg bottom bar) ═══ */}
      <div className="status-bar">
        <div className="status-bar-section">
          <span className="status-live">● LIVE</span>
          <span className="status-label">KRAKEN:</span>
          <span className="status-value" style={{ color: krakenState === 'RUNNING' ? 'var(--green)' : 'var(--text-muted)' }}>
            {krakenState || 'IDLE'}
          </span>
          <span className="status-label">CDC:</span>
          <span className="status-value" style={{ color: cdcState === 'RUNNING' ? 'var(--green)' : 'var(--text-muted)' }}>
            {cdcState || 'IDLE'}
          </span>
          <span className="status-label">POS:</span>
          <span className="status-value">{totalPositions}</span>
          <span className="status-label">CB:</span>
          <span className="status-value" style={{ color: cbPaused ? 'var(--red)' : 'var(--green)' }}>
            {cbPaused ? 'PAUSED' : 'OK'}
          </span>
        </div>
        <div className="status-bar-section">
          <span className="status-label">EQUITY:</span>
          <span className="status-value">${(enginesData?.global?.totalEquity || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          <span className="status-label">P&L:</span>
          <span className="status-value" style={{ color: (enginesData?.global?.totalPnl || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {(enginesData?.global?.totalPnl || 0) >= 0 ? '+' : ''}${(enginesData?.global?.totalPnl || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span className="status-label">TRADES:</span>
          <span className="status-value">{totalTrades}</span>
          {fearGreed && (
            <>
              <span className="status-label">F&G:</span>
              <span className="status-value" style={{ color: fearGreed.value <= 25 ? 'var(--red)' : fearGreed.value >= 75 ? 'var(--green)' : 'var(--text-header)' }}>
                {fearGreed.value}
              </span>
            </>
          )}
          <span style={{ color: 'var(--text-header)', fontWeight: 700 }}>{clock}</span>
        </div>
      </div>
    </div>
  );
}
