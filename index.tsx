

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App';
// QuestradeDashboard removed
import { PerformanceDashboard } from './components/PerformanceDashboard';
import { BacktestDashboard } from './components/BacktestDashboard';
import { ReplayDashboard } from './components/ReplayDashboard';
import { RiskDashboard } from './components/RiskDashboard';
import { SystemHealthPanel } from './components/SystemHealthPanel';
import { HistoricalTrainingDashboard } from './components/HistoricalTrainingDashboard';
import { ComponentErrorBoundary } from './components/ErrorBoundary';
import './index.css';
import './ui-theme.css';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, color: '#ff6b6b', background: '#1a1a2e', minHeight: '100vh', fontFamily: 'monospace' }}>
          <h1 style={{ color: '#ff4444', fontSize: 24 }}>Application Crashed</h1>
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: 20, padding: 20, background: '#0d0d1a', borderRadius: 8, fontSize: 14, color: '#ffaa88' }}>
            {this.state.error?.message}
          </pre>
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: 10, padding: 20, background: '#0d0d1a', borderRadius: 8, fontSize: 12, color: '#888' }}>
            {this.state.error?.stack}
          </pre>
          <button onClick={() => window.location.reload()} style={{ marginTop: 20, padding: '10px 20px', background: '#ff4444', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<ComponentErrorBoundary componentName="App"><App /></ComponentErrorBoundary>} />
{/* Questrade /stocks route removed */}
          <Route path="/performance" element={<ComponentErrorBoundary componentName="PerformanceDashboard"><PerformanceDashboard /></ComponentErrorBoundary>} />
          <Route path="/backtest" element={<ComponentErrorBoundary componentName="BacktestDashboard"><BacktestDashboard /></ComponentErrorBoundary>} />
          <Route path="/replay" element={<ComponentErrorBoundary componentName="ReplayDashboard"><ReplayDashboard /></ComponentErrorBoundary>} />
          <Route path="/risk" element={<ComponentErrorBoundary componentName="RiskDashboard"><RiskDashboard /></ComponentErrorBoundary>} />
          <Route path="/system" element={<ComponentErrorBoundary componentName="SystemHealthPanel"><SystemHealthPanel /></ComponentErrorBoundary>} />
          <Route path="/training" element={<ComponentErrorBoundary componentName="HistoricalTrainingDashboard"><HistoricalTrainingDashboard /></ComponentErrorBoundary>} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
