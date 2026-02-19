import React, { useState, useEffect } from 'react';

interface Props {
  timestamp: number | null;
}

const LastUpdated: React.FC<Props> = ({ timestamp }) => {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => forceUpdate(n => n + 1), 10000);
    return () => clearInterval(timer);
  }, []);

  if (!timestamp) return null;

  const secondsAgo = Math.floor((Date.now() - timestamp) / 1000);
  let text: string;
  let colorClass: string;

  if (secondsAgo < 10) {
    text = 'just now';
    colorClass = 'text-green-500';
  } else if (secondsAgo < 60) {
    text = `${secondsAgo}s ago`;
    colorClass = 'text-green-400';
  } else if (secondsAgo < 300) {
    text = `${Math.floor(secondsAgo / 60)}m ago`;
    colorClass = 'text-yellow-400';
  } else {
    text = `${Math.floor(secondsAgo / 60)}m ago`;
    colorClass = 'text-red-400';
  }

  return <span className={`text-[10px] ${colorClass} opacity-80`}>{text}</span>;
};

export default LastUpdated;
