import React from 'react';
import { AreaChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts';
import type { Candle, IndicatorData, SRLevels, VolumeProfileData, DivergenceData } from '../types';

interface IndicatorChartProps {
  candles: Candle[];
  tcSeries: IndicatorData[];
  breakoutSeries: IndicatorData[];
  whaleSeries: IndicatorData[];
  momentumSeries: IndicatorData[];
  divergenceData: DivergenceData | null;
  srLevels: SRLevels;
  volumeProfile: VolumeProfileData | null;
  trades: Array<{ type: string; ticker: string; price: number; time?: number; pnl?: number }>;
  bollingerBands: { upper: IndicatorData[], middle: IndicatorData[], lower: IndicatorData[] };
  vwap: IndicatorData[];
  ma50: IndicatorData[];
  ma200: IndicatorData[];
}

const CustomTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    const time = new Date(label).toLocaleTimeString();
    return (
      <div className="bg-white/90 backdrop-blur-md p-3 border border-black/6 rounded-xl shadow-lg">
        <p className="text-sm text-slate-500">{`Time: ${time}`}</p>
        {payload.map((p: any) => (
          <p key={p.dataKey} style={{ color: p.color }} className="font-semibold">
            {`${p.name}: ${typeof p.value === 'number' ? p.value.toFixed(2) : 'N/A'}`}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

const IndicatorChartComponent: React.FC<IndicatorChartProps> = ({ 
    candles, tcSeries, breakoutSeries, whaleSeries, momentumSeries, srLevels, trades: _trades, bollingerBands, vwap, ma50, ma200
}) => {
  if (!candles || candles.length === 0) {
    return <div className="flex items-center justify-center h-full text-slate-400">Loading chart data...</div>;
  }
  
  const combinedData = candles.map((d, i) => ({
      time: d.time,
      close: d.close,
      open: d.open,
      high: d.high,
      low: d.low,
      trendValue: tcSeries[i]?.value,
      breakoutValue: breakoutSeries[i]?.value,
      whaleValue: whaleSeries[i]?.value,
      momentumValue: momentumSeries[i]?.value,
      bbUpper: bollingerBands?.upper[i]?.value,
      bbMiddle: bollingerBands?.middle[i]?.value,
      bbLower: bollingerBands?.lower[i]?.value,
      vwap: vwap[i]?.value,
      ma50: ma50[i]?.value,
      ma200: ma200[i]?.value,
  }));
  
  const lows = combinedData.map(d => d.low).filter((v): v is number => v != null);
  const highs = combinedData.map(d => d.high).filter((v): v is number => v != null);
  const priceDomain: [number, number] = [
    lows.length > 0 ? Math.min(...lows) * 0.99 : 0,
    highs.length > 0 ? Math.max(...highs) * 1.01 : 1,
  ];

  return (
    <ResponsiveContainer width="100%" height={400}>
      <AreaChart data={combinedData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <defs>
            <linearGradient id="colorTrend" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#38bdf8" stopOpacity={0.5}/><stop offset="95%" stopColor="#38bdf8" stopOpacity={0}/></linearGradient>
            <linearGradient id="bb" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#a78bfa" stopOpacity={0.2}/><stop offset="95%" stopColor="#a78bfa" stopOpacity={0}/></linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="time" tickFormatter={(time) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} />
        <YAxis yAxisId="right" orientation="right" domain={priceDomain} stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `$${Number(value).toFixed(2)}`}/>
        
        <Tooltip content={<CustomTooltip />} />
        <Legend verticalAlign="top" height={36} iconType="plainline" />
        
        {/* S/R Levels */}
        {srLevels.resistance && <ReferenceLine y={srLevels.resistance} yAxisId="right" label={{ value: 'Resistance', position: 'right', fill: '#f87171', fontSize: 12 }} stroke="#f87171" strokeDasharray="8 8" />}
        {srLevels.support && <ReferenceLine y={srLevels.support} yAxisId="right" label={{ value: 'Support', position: 'right', fill: '#4ade80', fontSize: 12 }} stroke="#4ade80" strokeDasharray="8 8" />}

        {/* Bollinger Bands */}
        <Area yAxisId="right" dataKey="bbUpper" name="BB Upper" stroke="#a78bfa" fill="url(#bb)" strokeWidth={1} dot={false} />
        <Area yAxisId="right" dataKey="bbLower" name="BB Lower" stroke="#a78bfa" fill="url(#bb)" strokeWidth={1} dot={false} />

        {/* Price Line */}
        <Line yAxisId="right" type="monotone" dataKey="close" name="Price" stroke="#fBBF24" strokeWidth={2} dot={false} />
        
        {/* VWAP and MAs */}
        <Line yAxisId="right" type="monotone" dataKey="vwap" name="VWAP" stroke="#f472b6" strokeWidth={1.5} dot={false} />
        <Line yAxisId="right" type="monotone" dataKey="ma50" name="50 MA" stroke="#e11d48" strokeWidth={1.5} dot={false} />
        <Line yAxisId="right" type="monotone" dataKey="ma200" name="200 MA" stroke="#9333ea" strokeWidth={1.5} dot={false} />

      </AreaChart>
    </ResponsiveContainer>
  );
};

export const IndicatorChart = React.memo(IndicatorChartComponent);
