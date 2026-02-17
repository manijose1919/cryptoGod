
import type { Candle } from '../types';
import { FALLBACK_TICKERS } from '../constants';

// Current exchange — updated by App.tsx when user switches
let _activeExchange: string = 'crypto.com';

export function setActiveExchange(exchange: string) {
    _activeExchange = exchange;
}

export function getActiveExchange(): string {
    return _activeExchange;
}

/**
 * Fetches a list of the top 20 most active USD trading pairs from the backend.
 * If the fetch fails, it returns a hardcoded fallback list to ensure app functionality.
 * @returns A promise that resolves to an array of ticker strings (e.g., ['BTCUSD', 'ETHUSD']).
 */
export async function fetchAvailableUsdPairs(): Promise<string[]> {
  try {
    const exchangeParam = _activeExchange !== 'crypto.com' ? `?exchange=${_activeExchange}` : '';
    const url = `/api/instruments${exchangeParam}`;
    const response = await fetch(url);
    if (!response.ok) {
       const errorText = await response.text();
      throw new Error(`Failed to fetch instruments from backend (status ${response.status}): ${errorText}`);
    }
    const data = await response.json();

    // Handle different API response structures
    const instruments = data?.instruments || data?.data || [];
    if (!Array.isArray(instruments) || instruments.length === 0) {
        console.warn('No instruments in API response. Using fallback list.');
        return FALLBACK_TICKERS;
    }

    // Filter for USD pairs — Kraken adapter already filters, Crypto.com needs filtering
    if (_activeExchange === 'kraken') {
        // Kraken adapter returns pre-filtered USD pairs with instrument_name like "BTCUSD"
        const tickers = instruments
            .map((inst: any) => inst.instrument_name || '')
            .filter((name: string) => name.endsWith('USD'));
        return tickers.length > 0 ? tickers : FALLBACK_TICKERS;
    }

    // Crypto.com: filter for active, tradable, non-beta, spot USD pairs.
    const dynamicTickers = instruments
        .filter((inst: any) => {
            const name = inst.instrument_name || inst.symbol || '';
            const isUsdPair = name.endsWith('_USD') && !name.includes('USDT');
            const isSpot = (inst.inst_type === 'CCY_PAIR' || inst.inst_type === 'SPOT');
            const isTradable = inst.tradable === true && inst.beta_product === false;
            return isUsdPair && isSpot && isTradable;
        })
        .sort((a: any, b: any) => parseFloat(b.volume_24h || 0) - parseFloat(a.volume_24h || 0))
        .slice(0, 50) // Get top 50 by volume
        .map((inst: any) => (inst.instrument_name || inst.symbol || '').replace('_', ''));

    if (dynamicTickers.length === 0) {
        console.warn('Dynamic fetch resulted in 0 tickers. Using fallback list.');
        return FALLBACK_TICKERS;
    }

    return dynamicTickers;
  } catch (error: any) {
    console.error('Error fetching available USD pairs, using fallback list:', error.message);
    return FALLBACK_TICKERS;
  }
}


/**
 * Fetches historical k-line (candlestick) data from the backend server,
 * which acts as a proxy to the Crypto.com API.
 * @param symbol The trading symbol (e.g., 'BTCUSDC').
 * @param interval The candle interval (e.g., '1m', '1h', '1d').
 * @returns A promise that resolves to an array of Candle objects.
 */
export async function fetchHistoricalCandles(
  symbol: string,
  interval: string = '1m',
  limit: number = 200
): Promise<Candle[]> {
  // For Kraken, pass the raw ticker — the backend adapter handles formatting
  // For Crypto.com, convert to instrument_name format (BTCUSD -> BTC_USD)
  let instrument_name = symbol;
  if (_activeExchange === 'crypto.com' && !symbol.includes('_')) {
    if (symbol.endsWith('USDC')) {
      instrument_name = symbol.replace('USDC', '_USDC');
    } else if (symbol.endsWith('USDT')) {
      instrument_name = symbol.replace('USDT', '_USDT');
    } else if (symbol.endsWith('CAD')) {
      instrument_name = symbol.replace('CAD', '_CAD');
    } else if (symbol.endsWith('USD')) {
      instrument_name = symbol.replace('USD', '_USD');
    }
  }

  const exchangeParam = _activeExchange !== 'crypto.com' ? `&exchange=${_activeExchange}` : '';
  const url = `/api/market-data?instrument_name=${instrument_name}&timeframe=${interval}${exchangeParam}`;

  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Request to backend for ${symbol} failed with status ${response.status}: ${errorText}`);
  }

  const data = await response.json();

  if (!data || !data.data) {
      console.warn(`Backend returned no candle data for ${symbol}. It might be a new or delisted pair.`);
      return [];
  }

  const candles: Candle[] = data.data.map((d: any) => ({
    time: d.t,
    open: Number(d.o),
    high: Number(d.h),
    low: Number(d.l),
    close: Number(d.c),
    volume: Number(d.v),
  }));

  return candles;
}

// Backward compatibility alias
export const fetchAvailableUsdcPairs = fetchAvailableUsdPairs;

// ============================================
// Multi-Exchange & ML Data Fetchers
// ============================================

export async function fetchExchangeData(ticker: string) {
  try {
    const res = await fetch(`/api/exchange-data/${ticker}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function fetchDerivatives(ticker: string) {
  try {
    const res = await fetch(`/api/derivatives/${ticker}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function fetchDeFiOverview() {
  try {
    const res = await fetch('/api/defi/overview');
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function fetchSentimentNews(ticker: string) {
  try {
    const res = await fetch(`/api/sentiment/news/${ticker}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function fetchSentimentSocial(ticker: string) {
  try {
    const res = await fetch(`/api/sentiment/social/${ticker}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function fetchFearGreed() {
  try {
    const res = await fetch('/api/sentiment/fear-greed');
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function fetchMLStatus() {
  try {
    const res = await fetch('/api/ml/status');
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function fetchMLPredictions(ticker: string) {
  try {
    const res = await fetch(`/api/ml/predictions/${ticker}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function fetchMLFeatureImportance() {
  try {
    const res = await fetch('/api/ml/feature-importance');
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function fetchMultiExchangeStatus() {
  try {
    const res = await fetch('/api/multi-exchange/status');
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}