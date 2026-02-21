
import React, { useState, useMemo } from 'react';
import type { SystemEvent } from '../types';
import { exportLogsToCSV } from '../services/exportService';

interface SystemLogProps {
  events: SystemEvent[];
}

const getLogStyles = (type: SystemEvent['type']) => {
    switch(type) {
        case 'BUY': return 'text-green-400 border-l-green-400';
        case 'SELL': return 'text-red-400 border-l-red-400';
        case 'ERROR': return 'text-red-500 border-l-red-500';
        case 'WARN': return 'text-yellow-400 border-l-yellow-400';
        case 'SPECIAL': return 'text-cyan-400 border-l-cyan-400 font-bold';
        default: return 'text-gray-400 border-l-gray-600';
    }
}

export const SystemLog: React.FC<SystemLogProps> = ({ events: log }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<SystemEvent['type'] | 'ALL'>('ALL');

  const filteredLogs = useMemo(() => {
    let result = log;
    if (filterType !== 'ALL') {
      result = result.filter(e => e.type === filterType);
    }
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      result = result.filter(e => e.message.toLowerCase().includes(term));
    }
    return result;
  }, [log, filterType, searchTerm]);

  return (
    <div className="glass-card p-6 animate-fade-up">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xl font-semibold gradient-header">System Log & Trades</h2>
        <button
          onClick={() => exportLogsToCSV(log)}
          className="text-[10px] px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
          title="Export logs to CSV"
        >
          Export CSV
        </button>
      </div>
      <div className="flex gap-2 mb-3">
        <input
          type="text"
          placeholder="Search logs..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500"
        />
        <select
          value={filterType}
          onChange={e => setFilterType(e.target.value as SystemEvent['type'] | 'ALL')}
          className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-cyan-500"
        >
          <option value="ALL">All</option>
          <option value="BUY">Buy</option>
          <option value="SELL">Sell</option>
          <option value="INFO">Info</option>
          <option value="WARN">Warn</option>
          <option value="ERROR">Error</option>
          <option value="SPECIAL">Special</option>
        </select>
      </div>
      <div className="max-h-64 overflow-y-auto pr-2 text-xs space-y-2">
        {filteredLogs.length === 0 ? (
          <p className="text-gray-500 text-center py-4">
            {log.length === 0 ? 'System log is empty.' : 'No logs match your filter.'}
          </p>
        ) : (
          filteredLogs.map(event => (
            <div key={event.id} className={`pl-3 border-l-2 ${getLogStyles(event.type)}`}>
              <span className="font-mono text-gray-500 mr-2">{new Date(event.time).toLocaleTimeString()}</span>
              <span>{event.message}</span>
            </div>
          ))
        )}
      </div>
      {searchTerm && (
        <div className="text-[10px] text-gray-500 mt-2">
          Showing {filteredLogs.length} of {log.length} logs
        </div>
      )}
    </div>
  );
};
