/**
 * PageLayout — Wraps standalone route pages with navigation bar.
 * Provides consistent nav + back-to-dashboard link for /performance, /risk, etc.
 */
import React from 'react';

const NAV_LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/performance', label: 'Performance' },
  { href: '/backtest', label: 'Backtest' },
  { href: '/replay', label: 'Replay' },
  { href: '/risk', label: 'Risk' },
  { href: '/training', label: 'Training' },
  { href: '/system', label: 'System' },
];

export function PageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <nav style={{
        display: 'flex', alignItems: 'center', gap: '4px',
        padding: '8px 16px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-primary)',
        fontSize: '11px',
      }}>
        {NAV_LINKS.map(link => {
          const isActive = window.location.pathname === link.href;
          return (
            <a key={link.href} href={link.href} style={{
              padding: '4px 10px',
              borderRadius: '6px',
              textDecoration: 'none',
              fontWeight: isActive ? 700 : 400,
              color: isActive ? 'var(--text-header)' : 'var(--text-secondary)',
              background: isActive ? 'rgba(99,102,241,0.1)' : 'transparent',
              transition: 'background 0.15s',
            }}>
              {link.label}
            </a>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
