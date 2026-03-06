import React, { useState } from 'react';
import type { StakingYieldResult } from '../types';
import * as api from '../services/historicalTrainingService';

const TICKERS = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD', 'LINKUSD', 'DOTUSD', 'AVAXUSD'];
const DEFAULT_APYS: Record<string, number> = {
  ETHUSD: 3.5, DOTUSD: 12.0, SOLUSD: 7.0, ADAUSD: 3.0, AVAXUSD: 8.0,
  XRPUSD: 0, BTCUSD: 0, DOGEUSD: 0, LINKUSD: 4.5,
};

export const StakingCalculator: React.FC = () => {
  const [ticker, setTicker] = useState('ETHUSD');
  const [apy, setApy] = useState(DEFAULT_APYS['ETHUSD']);
  const [amount, setAmount] = useState(10000);
  const [days, setDays] = useState(365);
  const [result, setResult] = useState<StakingYieldResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTickerChange = (t: string) => {
    setTicker(t);
    setApy(DEFAULT_APYS[t] ?? 0);
    setResult(null);
  };

  const handleCalculate = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.calculateStakingYield({ ticker, apy, initialAmount: amount, days });
      setResult(r);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  const maxYield = result
    ? Math.max(result.stakeAndHold.returnPct, result.activeTrading.returnPct, result.hybrid.returnPct, 1)
    : 100;

  function barWidth(pct: number): number {
    return Math.max(Math.min((pct / maxYield) * 100, 100), 2);
  }

  return (
    <div className="bg-gray-800/50 rounded-lg p-4 space-y-3">
      <h3 className="text-sm font-semibold text-indigo-300">Staking Yield Calculator</h3>

      <div className="grid grid-cols-4 gap-2">
        <div>
          <label className="text-[10px] text-gray-400 block mb-1">Ticker</label>
          <select
            value={ticker}
            onChange={e => handleTickerChange(e.target.value)}
            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs"
          >
            {TICKERS.map(t => (
              <option key={t} value={t}>{t.replace('USD', '')}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-gray-400 block mb-1">APY %</label>
          <input
            type="number"
            value={apy}
            onChange={e => setApy(parseFloat(e.target.value) || 0)}
            step="0.5"
            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs"
          />
        </div>
        <div>
          <label className="text-[10px] text-gray-400 block mb-1">Amount ($)</label>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(parseInt(e.target.value) || 10000)}
            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs"
          />
        </div>
        <div>
          <label className="text-[10px] text-gray-400 block mb-1">Days</label>
          <input
            type="number"
            value={days}
            onChange={e => setDays(parseInt(e.target.value) || 365)}
            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs"
          />
        </div>
      </div>

      <button
        onClick={handleCalculate}
        disabled={loading}
        className="text-xs px-3 py-1 bg-indigo-600 hover:bg-indigo-700 rounded transition-colors disabled:opacity-50"
      >
        {loading ? 'Calculating...' : 'Calculate'}
      </button>

      {error && <div className="text-xs text-red-400">{error}</div>}

      {result && (
        <div className="space-y-3">
          {/* Bar comparison */}
          <div className="space-y-2">
            <StrategyBar
              label="Stake & Hold"
              returnPct={result.stakeAndHold.returnPct}
              total={result.stakeAndHold.total}
              yieldAmt={result.stakeAndHold.yield}
              color="bg-indigo-500"
              width={barWidth(result.stakeAndHold.returnPct)}
            />
            <StrategyBar
              label="Active Trading"
              returnPct={result.activeTrading.returnPct}
              total={result.activeTrading.total}
              yieldAmt={result.activeTrading.yield}
              color="bg-green-500"
              width={barWidth(result.activeTrading.returnPct)}
              note={result.activeTrading.sourceRunId ? `From run ${result.activeTrading.sourceRunId.slice(0, 15)}...` : 'No training data'}
            />
            <StrategyBar
              label="Hybrid (80/20)"
              returnPct={result.hybrid.returnPct}
              total={result.hybrid.total}
              yieldAmt={result.hybrid.yield}
              color="bg-amber-500"
              width={barWidth(result.hybrid.returnPct)}
              note={`$${result.hybrid.stakedPortion} staked + $${result.hybrid.tradedPortion} traded`}
            />
          </div>

          {/* Winner */}
          <div className="text-xs text-gray-400">
            Best strategy:{' '}
            <span className="text-white font-semibold">
              {result.stakeAndHold.returnPct >= result.activeTrading.returnPct && result.stakeAndHold.returnPct >= result.hybrid.returnPct
                ? 'Stake & Hold'
                : result.activeTrading.returnPct >= result.hybrid.returnPct
                ? 'Active Trading'
                : 'Hybrid (80/20)'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

function StrategyBar({
  label,
  returnPct,
  total,
  yieldAmt,
  color,
  width,
  note,
}: {
  label: string;
  returnPct: number;
  total: number;
  yieldAmt: number;
  color: string;
  width: number;
  note?: string;
}) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-0.5">
        <span className="text-gray-300">{label}</span>
        <span className={returnPct >= 0 ? 'text-green-400' : 'text-red-400'}>
          {returnPct >= 0 ? '+' : ''}{returnPct}% (${yieldAmt.toFixed(2)}) → ${total.toFixed(2)}
        </span>
      </div>
      <div className="w-full bg-gray-700 rounded-full h-3">
        <div
          className={`${color} h-3 rounded-full transition-all`}
          style={{ width: `${width}%` }}
        />
      </div>
      {note && <div className="text-[10px] text-gray-500 mt-0.5">{note}</div>}
    </div>
  );
}
