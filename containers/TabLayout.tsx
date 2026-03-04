/**
 * TabLayout — Top-level tabbed navigation for the overhaul UI.
 *
 * Tabs: Dashboard (legacy) | Kraken | Crypto.com | Portfolio | Revenue | ML
 * Each tab renders its own view with isolated state from the Zustand store.
 */

import React, { useState, useCallback } from 'react';
import { ExchangeDashboard } from '../components/ExchangeDashboard';
import { PortfolioOverview } from '../components/PortfolioOverview';
import { useAllEnginesStatus } from '../hooks/useEngineAPI';

export type TabId = 'dashboard' | 'kraken' | 'crypto.com' | 'portfolio' | 'revenue' | 'ml';

interface TabDef {
  id: TabId;
  label: string;
  shortLabel: string;
  color: string;
  icon: string;
}

const TABS: TabDef[] = [
  { id: 'dashboard', label: 'Dashboard', shortLabel: 'Dash', color: '#10b981', icon: '📊' },
  { id: 'kraken', label: 'Kraken', shortLabel: 'KRK', color: '#3b82f6', icon: '🐙' },
  { id: 'crypto.com', label: 'Crypto.com', shortLabel: 'CDC', color: '#6366f1', icon: '💎' },
  { id: 'portfolio', label: 'Portfolio', shortLabel: 'Port', color: '#f59e0b', icon: '📈' },
  { id: 'ml', label: 'ML Pipeline', shortLabel: 'ML', color: '#8b5cf6', icon: '🧠' },
];

interface Props {
  /** Render the legacy dashboard content (App.tsx internals) */
  renderDashboard: () => React.ReactNode;
}

export function TabLayout({ renderDashboard }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  const { data: enginesData } = useAllEnginesStatus();

  const handleTabClick = useCallback((tabId: TabId) => {
    setActiveTab(tabId);
  }, []);

  return (
    <div className="tab-layout">
      {/* Tab Bar */}
      <nav className="tab-bar">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const engineState = tab.id === 'kraken'
            ? enginesData?.engines?.kraken?.state
            : tab.id === 'crypto.com'
              ? enginesData?.engines?.['crypto.com']?.state
              : null;

          return (
            <button
              key={tab.id}
              className={`tab-btn ${isActive ? 'tab-btn-active' : ''}`}
              style={isActive ? { borderBottomColor: tab.color } : undefined}
              onClick={() => handleTabClick(tab.id)}
            >
              <span className="tab-icon">{tab.icon}</span>
              <span className="tab-label">{tab.label}</span>
              {engineState && (
                <span className={`tab-indicator tab-indicator-${engineState.toLowerCase()}`} />
              )}
            </button>
          );
        })}
      </nav>

      {/* Tab Content */}
      <div className="tab-content">
        {activeTab === 'dashboard' && renderDashboard()}
        {activeTab === 'kraken' && <ExchangeDashboard exchange="kraken" />}
        {activeTab === 'crypto.com' && <ExchangeDashboard exchange="crypto.com" />}
        {activeTab === 'portfolio' && <PortfolioOverview />}
        {activeTab === 'ml' && (
          <div className="tab-placeholder">
            <h2>ML Pipeline V2</h2>
            <p>ML training dashboard — coming soon. Current ML pipeline is accessible from the Dashboard tab.</p>
          </div>
        )}
      </div>
    </div>
  );
}
