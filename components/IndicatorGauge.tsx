
import React from 'react';

interface IndicatorGaugeProps {
  label: string;
  value: number | null;
  lower_threshold?: number;
  upper_threshold?: number;
  higher_is_better?: boolean;
}

const getGradientColor = (value: number) => {
  if (value < 20) return 'from-emerald-500 via-emerald-500 to-emerald-400';
  if (value < 40) return 'from-emerald-500 via-yellow-500 to-yellow-400';
  if (value < 60) return 'from-emerald-500 via-yellow-500 to-red-400';
  if (value < 80) return 'from-yellow-500 via-red-500 to-red-400';
  return 'from-red-500 via-red-500 to-red-400';
};

export const IndicatorGauge: React.FC<IndicatorGaugeProps> = ({ label, value, lower_threshold, upper_threshold, higher_is_better }) => {
  const displayValue = value ?? 50;
  const rotation = (displayValue / 100) * 180 - 90;
  const gradientClass = getGradientColor(displayValue);

  let statusColor = 'text-gray-400';
  if (value !== null && lower_threshold !== undefined && upper_threshold !== undefined) {
    if (higher_is_better) {
      if (value >= upper_threshold) statusColor = 'text-green-400';
      else if (value <= lower_threshold) statusColor = 'text-red-400';
      else statusColor = 'text-yellow-400';
    } else {
      if (value <= lower_threshold) statusColor = 'text-green-400';
      else if (value >= upper_threshold) statusColor = 'text-red-400';
      else statusColor = 'text-yellow-400';
    }
  }

  return (
    <div className="bg-gray-800/50 backdrop-blur-sm p-3 rounded-xl border border-gray-700 text-center">
      <p className="text-xs text-gray-400 mb-2 uppercase tracking-wider">{label}</p>
      <div className="w-full h-20 relative mx-auto" style={{ maxWidth: '160px' }}>
        <div className="absolute inset-0 overflow-hidden rounded-t-full">
          <div className={`w-full h-full bg-gradient-to-r ${gradientClass} transition-all duration-500 ease-in-out`}></div>
          <div className="absolute inset-2 bg-gray-800 rounded-t-full"></div>
        </div>

        <div
          className="absolute bottom-0 left-1/2 w-0.5 h-16 bg-gray-100 transition-transform duration-500 ease-in-out"
          style={{ transform: `translateX(-50%) rotate(${rotation}deg)`, transformOrigin: 'bottom center' }}
        >
          <div className="absolute -top-1 -left-1 w-2 h-2 bg-gray-100 rounded-full"></div>
        </div>

        <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 -translate-y-1">
          <span className={`text-2xl font-bold tracking-tighter ${statusColor}`}>
            {value !== null ? displayValue.toFixed(1) : '--'}
          </span>
        </div>
      </div>
    </div>
  );
};
