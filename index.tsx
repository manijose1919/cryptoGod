

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App';
import { QuestradeDashboard } from './components/QuestradeDashboard';
import { PerformanceDashboard } from './components/PerformanceDashboard';
import { BacktestDashboard } from './components/BacktestDashboard';
import { ReplayDashboard } from './components/ReplayDashboard';
import { RiskDashboard } from './components/RiskDashboard';
import { SystemHealthPanel } from './components/SystemHealthPanel';
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
          <Route path="/" element={<App />} />
          <Route path="/stocks" element={<QuestradeDashboard />} />
          <Route path="/performance" element={<PerformanceDashboard />} />
          <Route path="/backtest" element={<BacktestDashboard />} />
          <Route path="/replay" element={<ReplayDashboard />} />
          <Route path="/risk" element={<RiskDashboard />} />
          <Route path="/system" element={<SystemHealthPanel />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
