import React from 'react';

interface Props {
  rows?: number;
  className?: string;
}

const SkeletonPanel: React.FC<Props> = ({ rows = 3, className = '' }) => {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="shimmer h-4 rounded"
          style={{ width: `${70 + Math.random() * 30}%` }}
        />
      ))}
    </div>
  );
};

export default SkeletonPanel;
