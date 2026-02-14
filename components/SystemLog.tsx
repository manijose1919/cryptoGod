
import React from 'react';
import type { SystemEvent, Trade } from '../types';

interface SystemLogProps {
  events: SystemEvent[];
}

const getLogStyles = (type: SystemEvent['type']) => {
    switch(type) {
        case 'BUY': return 'text-green-400 border-l-green-400';
        case 'SELL': return 'text-red-400 border-l-red-400';
        case 'ERROR': return 'text-red-500 border-l-red-500';
        case 'SPECIAL': return 'text-cyan-400 border-l-cyan-400 font-bold';
        default: return 'text-gray-400 border-l-gray-600';
    }
}

export const SystemLog: React.FC<SystemLogProps> = ({ events: log }) => {
  return (
    <div className="glass-card p-6 animate-fade-up">
      <h2 className="text-xl font-semibold mb-4 gradient-header">System Log & Trades</h2>
      <div className="max-h-64 overflow-y-auto pr-2 text-xs space-y-2">
        {log.length === 0 ? (
          <p className="text-gray-500 text-center py-4">System log is empty.</p>
        ) : (
          log.map(event => (
            <div key={event.id} className={`pl-3 border-l-2 ${getLogStyles(event.type)}`}>
              <span className="font-mono text-gray-500 mr-2">{new Date(event.time).toLocaleTimeString()}</span>
              <span>{event.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
