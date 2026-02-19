import React, { useEffect, useRef, useState } from 'react';

interface Props {
  value: number;
  format?: 'currency' | 'percent' | 'number';
  decimals?: number;
  duration?: number;
  colorize?: boolean;
  className?: string;
  prefix?: string;
  showSign?: boolean;
}

const AnimatedNumber: React.FC<Props> = ({
  value,
  format = 'currency',
  decimals = 2,
  duration = 500,
  colorize = true,
  className = '',
  prefix = '',
  showSign = false,
}) => {
  const [display, setDisplay] = useState(value);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevValue = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = prevValue.current;
    const to = value;
    prevValue.current = value;

    if (from === to) return;

    // Flash effect
    setFlash(to > from ? 'up' : 'down');
    const flashTimer = setTimeout(() => setFlash(null), 800);

    // Animate
    const start = performance.now();
    const animate = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (to - from) * eased);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      clearTimeout(flashTimer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration]);

  let formatted: string;
  if (format === 'currency') {
    formatted = `${prefix || '$'}${Math.abs(display).toFixed(decimals)}`;
  } else if (format === 'percent') {
    formatted = `${Math.abs(display).toFixed(decimals)}%`;
  } else {
    formatted = `${prefix}${Math.abs(display).toFixed(decimals)}`;
  }

  const sign = showSign ? (display >= 0 ? '+' : '-') : (display < 0 ? '-' : '');

  let colorClass = '';
  if (colorize) {
    colorClass = display > 0 ? 'text-green-400' : display < 0 ? 'text-red-400' : 'text-gray-300';
  }

  let flashClass = '';
  if (flash === 'up') flashClass = 'trade-flash-buy';
  else if (flash === 'down') flashClass = 'trade-flash-sell';

  return (
    <span className={`${colorClass} ${flashClass} ${className} transition-colors duration-300`}>
      {sign}{formatted}
    </span>
  );
};

export default AnimatedNumber;
