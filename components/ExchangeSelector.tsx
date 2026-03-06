import React, { useState, useEffect } from 'react';

interface ExchangeInfo {
    id: string;
    name: string;
    feePercent: number;
    isActive: boolean;
    hasCredentials: boolean;
}

interface ExchangeSelectorProps {
    currentExchange: string;
    onExchangeChange: (exchange: string, fees: { takerFee: number; roundTripFee: number }) => void;
}

export const ExchangeSelector: React.FC<ExchangeSelectorProps> = ({ currentExchange, onExchangeChange }) => {
    const [exchanges, setExchanges] = useState<ExchangeInfo[]>([]);
    const [switching, setSwitching] = useState(false);

    useEffect(() => {
        fetch('/api/exchange/list')
            .then(r => r.json())
            .then(data => {
                if (Array.isArray(data)) setExchanges(data);
            })
            .catch(() => {
                // Fallback when backend is not running
                setExchanges([
                    { id: 'crypto.com', name: 'crypto.com', feePercent: 0.075, isActive: true, hasCredentials: false },
                    { id: 'kraken', name: 'kraken', feePercent: 0.26, isActive: false, hasCredentials: false },
                ]);
            });
    }, [currentExchange]);

    const handleSwitch = async (exchangeId: string) => {
        if (exchangeId === currentExchange || switching) return;
        setSwitching(true);
        try {
            const resp = await fetch('/api/exchange/switch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ exchange: exchangeId }),
            });
            const data = await resp.json();
            if (data.exchange) {
                onExchangeChange(data.exchange, {
                    takerFee: data.feePercent,
                    roundTripFee: data.feePercent * 2,
                });
            }
        } catch (err) {
            console.error('Failed to switch exchange:', err);
        } finally {
            setSwitching(false);
        }
    };

    const active = exchanges.find(e => e.id === currentExchange);

    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            background: 'rgba(30, 41, 59, 0.7)', borderRadius: '8px',
            padding: '4px 8px', backdropFilter: 'blur(8px)',
        }}>
            <span style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 600 }}>Exchange:</span>
            <select
                value={currentExchange}
                onChange={(e) => handleSwitch(e.target.value)}
                disabled={switching}
                style={{
                    background: 'rgba(15, 23, 42, 0.9)',
                    color: '#e2e8f0',
                    border: '1px solid rgba(100, 116, 139, 0.3)',
                    borderRadius: '4px',
                    padding: '2px 6px',
                    fontSize: '12px',
                    cursor: switching ? 'wait' : 'pointer',
                }}
            >
                {exchanges.map(ex => (
                    <option key={ex.id} value={ex.id}>
                        {ex.name} ({(ex.feePercent || 0).toFixed(3)}%)
                    </option>
                ))}
            </select>
            {active && (
                <span style={{
                    fontSize: '10px',
                    color: active.hasCredentials ? '#22c55e' : '#f59e0b',
                }}>
                    {active.hasCredentials ? 'Connected' : 'Paper'}
                </span>
            )}
        </div>
    );
};
