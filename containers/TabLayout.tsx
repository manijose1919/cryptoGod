/**
 * TabLayout — Bloomberg Terminal-style tabbed navigation.
 * Function-key bar at top, ticker tape, status bar at bottom.
 */

import React, { useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { ExchangeDashboard } from '../components/ExchangeDashboard';
import { PortfolioOverview } from '../components/PortfolioOverview';
import { useAllEnginesStatus } from '../hooks/useEngineAPI';
import { useThemeStore } from '../stores/themeStore';

const TickerTape = lazy(() => import('../components/TickerTape'));

export type TabId = 'dashboard' | 'kraken' | 'crypto.com' | 'portfolio' | 'ml';

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
];

interface Props {
  renderDashboard: () => React.ReactNode;
}

export function TabLayout({ renderDashboard }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  const { data: enginesData } = useAllEnginesStatus();
  const { isDark, toggle: toggleTheme } = useThemeStore();
  const [clock, setClock] = useState(new Date().toLocaleTimeString([], { hour12: false }));

  // Live clock
  useEffect(() => {
    const iv = setInterval(() => setClock(new Date().toLocaleTimeString([], { hour12: false })), 1000);
    return () => clearInterval(iv);
  }, []);

  const handleTabClick = useCallback((tabId: TabId) => {
    setActiveTab(tabId);
  }, []);

  const krakenState = enginesData?.engines?.kraken?.state;
  const cdcState = enginesData?.engines?.['crypto.com']?.state;

  return (
    <div className="tab-layout">
      {/* ═══ TICKER TAPE ═══ */}
      <Suspense fallback={null}>
        <TickerTape />
      </Suspense>

      {/* ═══ FUNCTION BAR ═══ */}
      <nav className="tab-bar" style={{ alignItems: 'center' }}>
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
          <div className="tab-placeholder">
            <h2>ML PIPELINE V2</h2>
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
              ML training dashboard — accessible from Dashboard tab.
            </p>
          </div>
        )}
      </div>

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
        </div>
        <div className="status-bar-section">
          <span className="status-label">EQUITY:</span>
          <span className="status-value">${(enginesData?.global?.totalEquity || 0).toFixed(2)}</span>
          <span className="status-label">P&L:</span>
          <span className="status-value" style={{ color: (enginesData?.global?.totalPnl || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {(enginesData?.global?.totalPnl || 0) >= 0 ? '+' : ''}${(enginesData?.global?.totalPnl || 0).toFixed(2)}
          </span>
          <span style={{ color: 'var(--text-header)', fontWeight: 700 }}>{clock}</span>
        </div>
      </div>
    </div>
  );
}
