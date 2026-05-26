# Full Strategy Sweep — Results
Generated: 2026-05-26T15:55:23.120Z

- Universe: 25 tickers
- Strategies: 10 (DCA, Grid, VWAP, Vol Profile, Candlestick added; Pairs and Chart Patterns deferred)
- Per-strategy top-N tickers: 4
- Windows: 30d, 60d, 90d
- Interval: 1h
- Fees: 0.52% round-trip; slippage 0.05%/side

## 1. Ticker characteristics (90d)

| Ticker | Bars | Hurst | RealVol % | ATR % | Drift % | VolStdRatio | RangeBound | TrendScore |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| FETUSD | 2159 | 0.546 | 94.4 | 1.46 | 49.1 | 1.10 | 0.00 | 0.091 |
| ICPUSD | 2159 | 0.554 | 88.4 | 1.19 | 15.4 | 1.30 | 0.00 | 0.055 |
| INJUSD | 2159 | 0.578 | 86.3 | 1.19 | 82.7 | 1.48 | 0.00 | 0.156 |
| NEARUSD | 2159 | 0.549 | 86.3 | 1.25 | 149.6 | 1.53 | 0.00 | 0.098 |
| FILUSD | 2159 | 0.550 | 80.9 | 1.08 | -4.4 | 1.72 | 0.00 | 0.015 |
| COMPUSD | 2159 | 0.566 | 76.4 | 1.00 | 1.5 | 1.83 | 0.00 | 0.007 |
| ALGOUSD | 2159 | 0.570 | 75.4 | 1.12 | 22.7 | 1.44 | 0.00 | 0.106 |
| RUNEUSD | 2159 | 0.573 | 75.2 | 0.84 | 7.0 | 3.08 | 0.00 | 0.034 |
| AAVEUSD | 2159 | 0.557 | 73.4 | 1.07 | -27.7 | 1.48 | 0.00 | 0.106 |
| DOTUSD | 2159 | 0.565 | 68.6 | 1.02 | -16.4 | 1.33 | 0.00 | 0.071 |
| UNIUSD | 2159 | 0.567 | 66.4 | 0.96 | -16.5 | 1.43 | 0.00 | 0.074 |
| DOGEUSD | 2159 | 0.563 | 60.6 | 0.91 | 0.0 | 0.95 | 1.00 | 0.000 |
| AVAXUSD | 2159 | 0.553 | 59.4 | 0.85 | -3.5 | 1.04 | 0.00 | 0.012 |
| ADAUSD | 2159 | 0.558 | 58.5 | 0.90 | -16.7 | 0.94 | 0.00 | 0.065 |
| SOLUSD | 2159 | 0.566 | 56.7 | 0.86 | -2.4 | 1.00 | 0.00 | 0.011 |
| LINKUSD | 2159 | 0.567 | 56.7 | 0.86 | 2.0 | 0.90 | 0.00 | 0.009 |
| ATOMUSD | 2159 | 0.562 | 56.5 | 0.84 | 8.3 | 1.10 | 0.00 | 0.034 |
| SHIBUSD | 2159 | 0.542 | 56.4 | 0.82 | -11.8 | 0.98 | 0.00 | 0.033 |
| ETHUSD | 2159 | 0.579 | 54.4 | 0.81 | 3.8 | 1.10 | 0.00 | 0.020 |
| HBARUSD | 2159 | 0.549 | 51.3 | 0.78 | -13.3 | 0.83 | 0.00 | 0.043 |
| XRPUSD | 2159 | 0.559 | 49.5 | 0.75 | -6.5 | 0.99 | 0.00 | 0.025 |
| BCHUSD | 2159 | 0.580 | 49.0 | 0.64 | -31.5 | 1.78 | 0.00 | 0.160 |
| MKRUSD | 2159 | 0.511 | 47.6 | 0.03 | 28.6 | 17.71 | 0.00 | 0.021 |
| LTCUSD | 2159 | 0.542 | 42.6 | 0.64 | -9.1 | 0.64 | 0.00 | 0.025 |
| BTCUSD | 2159 | 0.574 | 41.3 | 0.62 | 12.9 | 1.11 | 0.00 | 0.064 |

## 2. Optimal tickers per strategy (by fitness — closed-form, NOT backtest)

Tickers selected by matching their structural properties (Hurst, vol, drift) to each strategy's theoretical requirements.
This avoids overfitting that would result from picking by backtest results.

### MA_CROSS
| Rank | Ticker | Fitness | Hurst | ATR % | Drift % | RangeBound | Liquidity ($/bar) |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | BCHUSD | 0.160 | 0.580 | 0.64 | -31.5 | 0.00 | 236.0K |
| 2 | INJUSD | 0.156 | 0.578 | 1.19 | 82.7 | 0.00 | 106.1K |
| 3 | ALGOUSD | 0.106 | 0.570 | 1.12 | 22.7 | 0.00 | 128.5K |
| 4 | AAVEUSD | 0.106 | 0.557 | 1.07 | -27.7 | 0.00 | 233.9K |

### RSI_REVERSAL
| Rank | Ticker | Fitness | Hurst | ATR % | Drift % | RangeBound | Liquidity ($/bar) |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | FILUSD | 0.762 | 0.550 | 1.08 | -4.4 | 0.00 | 72.4K |
| 2 | ICPUSD | 0.735 | 0.554 | 1.19 | 15.4 | 0.00 | 156.6K |
| 3 | COMPUSD | 0.730 | 0.566 | 1.00 | 1.5 | 0.00 | 27.9K |
| 4 | DOGEUSD | 0.723 | 0.563 | 0.91 | 0.0 | 1.00 | 1.7M |

### BOLLINGER_MR
| Rank | Ticker | Fitness | Hurst | ATR % | Drift % | RangeBound | Liquidity ($/bar) |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | FILUSD | 0.762 | 0.550 | 1.08 | -4.4 | 0.00 | 72.4K |
| 2 | ICPUSD | 0.735 | 0.554 | 1.19 | 15.4 | 0.00 | 156.6K |
| 3 | COMPUSD | 0.730 | 0.566 | 1.00 | 1.5 | 0.00 | 27.9K |
| 4 | DOGEUSD | 0.723 | 0.563 | 0.91 | 0.0 | 1.00 | 1.7M |

### MACD
| Rank | Ticker | Fitness | Hurst | ATR % | Drift % | RangeBound | Liquidity ($/bar) |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | INJUSD | 0.231 | 0.578 | 1.19 | 82.7 | 0.00 | 106.1K |
| 2 | ALGOUSD | 0.148 | 0.570 | 1.12 | 22.7 | 0.00 | 128.5K |
| 3 | NEARUSD | 0.147 | 0.549 | 1.25 | 149.6 | 0.00 | 381.7K |
| 4 | AAVEUSD | 0.141 | 0.557 | 1.07 | -27.7 | 0.00 | 233.9K |

### DONCHIAN_BREAKOUT
| Rank | Ticker | Fitness | Hurst | ATR % | Drift % | RangeBound | Liquidity ($/bar) |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | RUNEUSD | 2.582 | 0.573 | 0.84 | 7.0 | 0.00 | 3.8K |
| 2 | COMPUSD | 1.831 | 0.566 | 1.00 | 1.5 | 0.00 | 27.9K |
| 3 | FILUSD | 1.723 | 0.550 | 1.08 | -4.4 | 0.00 | 72.4K |
| 4 | NEARUSD | 1.526 | 0.549 | 1.25 | 149.6 | 0.00 | 381.7K |

### DCA
| Rank | Ticker | Fitness | Hurst | ATR % | Drift % | RangeBound | Liquidity ($/bar) |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | NEARUSD | 3.226 | 0.549 | 1.25 | 149.6 | 0.00 | 381.7K |
| 2 | INJUSD | 1.783 | 0.578 | 1.19 | 82.7 | 0.00 | 106.1K |
| 3 | FETUSD | 1.159 | 0.546 | 1.46 | 49.1 | 0.00 | 196.3K |
| 4 | ALGOUSD | 0.427 | 0.570 | 1.12 | 22.7 | 0.00 | 128.5K |

### GRID
| Rank | Ticker | Fitness | Hurst | ATR % | Drift % | RangeBound | Liquidity ($/bar) |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | ICPUSD | 1.320 | 0.554 | 1.19 | 15.4 | 0.00 | 156.6K |
| 2 | FILUSD | 1.299 | 0.550 | 1.08 | -4.4 | 0.00 | 72.4K |
| 3 | COMPUSD | 1.255 | 0.566 | 1.00 | 1.5 | 0.00 | 27.9K |
| 4 | FETUSD | 1.196 | 0.546 | 1.46 | 49.1 | 0.00 | 196.3K |

### VWAP
| Rank | Ticker | Fitness | Hurst | ATR % | Drift % | RangeBound | Liquidity ($/bar) |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | BTCUSD | 0.703 | 0.574 | 0.62 | 12.9 | 0.00 | 49.3M |
| 2 | ETHUSD | 0.542 | 0.579 | 0.81 | 3.8 | 0.00 | 22.1M |
| 3 | XRPUSD | 0.421 | 0.559 | 0.75 | -6.5 | 0.00 | 7.1M |
| 4 | SOLUSD | 0.352 | 0.566 | 0.86 | -2.4 | 0.00 | 5.3M |

### VOLUME_PROFILE
| Rank | Ticker | Fitness | Hurst | ATR % | Drift % | RangeBound | Liquidity ($/bar) |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | RUNEUSD | 0.558 | 0.573 | 0.84 | 7.0 | 0.00 | 3.8K |
| 2 | FILUSD | 0.369 | 0.550 | 1.08 | -4.4 | 0.00 | 72.4K |
| 3 | COMPUSD | 0.350 | 0.566 | 1.00 | 1.5 | 0.00 | 27.9K |
| 4 | NEARUSD | 0.329 | 0.549 | 1.25 | 149.6 | 0.00 | 381.7K |

### CANDLESTICK
| Rank | Ticker | Fitness | Hurst | ATR % | Drift % | RangeBound | Liquidity ($/bar) |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | BTCUSD | 3.111 | 0.574 | 0.62 | 12.9 | 0.00 | 49.3M |
| 2 | ETHUSD | 2.296 | 0.579 | 0.81 | 3.8 | 0.00 | 22.1M |
| 3 | XRPUSD | 1.569 | 0.559 | 0.75 | -6.5 | 0.00 | 7.1M |
| 4 | SOLUSD | 1.311 | 0.566 | 0.86 | -2.4 | 0.00 | 5.3M |

## 3. Regime distribution (sanity check on the test windows)

Each window's regime mix on BTCUSD — gives context for why gated/raw results differ.

| Window | % UP | % DOWN | % RANGE |
|---|---:|---:|---:|
| 30d | 29 | 21 | 50 |
| 60d | 38 | 18 | 44 |
| 90d | 37 | 19 | 44 |

## 4. Top profitable backtest cells (any window)

Filtered to runs with ≥ 5 trades. Sorted by Net %.

| Strategy | Ticker | Params | Window | Gating | Trades | WR % | PF | Net % | DD % |
|---|---|---|---:|---|---:|---:|---:|---:|---:|
| DCA | NEARUSD | daily | 90d | enhanced-maker | 11 | 100.0 | inf | 64.83 | 0.0 |
| DCA | NEARUSD | daily | 90d | raw | 11 | 100.0 | inf | 59.54 | 0.0 |
| DCA | NEARUSD | daily | 90d | gated | 11 | 100.0 | inf | 59.54 | 0.0 |
| DCA | NEARUSD | daily | 90d | enhanced | 11 | 100.0 | inf | 59.54 | 0.0 |
| DCA | NEARUSD | daily | 60d | enhanced-maker | 9 | 100.0 | inf | 49.52 | 0.0 |
| DCA | NEARUSD | tightTP(5%) | 90d | enhanced-maker | 16 | 100.0 | inf | 48.39 | 0.0 |
| DCA | NEARUSD | daily | 60d | raw | 9 | 100.0 | inf | 45.58 | 0.0 |
| DCA | NEARUSD | daily | 60d | gated | 9 | 100.0 | inf | 45.58 | 0.0 |
| DCA | NEARUSD | daily | 60d | enhanced | 9 | 100.0 | inf | 45.58 | 0.0 |
| DCA | INJUSD | tightTP(5%) | 60d | enhanced-maker | 15 | 100.0 | inf | 44.78 | 0.0 |
| DCA | NEARUSD | daily | 30d | enhanced-maker | 8 | 100.0 | inf | 42.41 | 0.0 |
| DCA | NEARUSD | tightTP(5%) | 90d | raw | 16 | 100.0 | inf | 41.37 | 0.0 |
| DCA | NEARUSD | tightTP(5%) | 90d | gated | 16 | 100.0 | inf | 41.37 | 0.0 |
| DCA | NEARUSD | tightTP(5%) | 90d | enhanced | 16 | 100.0 | inf | 41.37 | 0.0 |
| DCA | NEARUSD | tightTP(5%) | 60d | enhanced-maker | 14 | 100.0 | inf | 41.25 | 0.0 |
| DCA | NEARUSD | daily | 30d | raw | 8 | 100.0 | inf | 39.06 | 0.0 |
| DCA | NEARUSD | daily | 30d | gated | 8 | 100.0 | inf | 39.06 | 0.0 |
| DCA | NEARUSD | daily | 30d | enhanced | 8 | 100.0 | inf | 39.06 | 0.0 |
| DCA | INJUSD | tightTP(5%) | 60d | raw | 15 | 100.0 | inf | 38.35 | 0.0 |
| DCA | INJUSD | tightTP(5%) | 60d | gated | 15 | 100.0 | inf | 38.35 | 0.0 |
| DCA | INJUSD | tightTP(5%) | 60d | enhanced | 15 | 100.0 | inf | 38.35 | 0.0 |
| DCA | INJUSD | tightTP(5%) | 90d | enhanced-maker | 13 | 100.0 | inf | 37.81 | 0.0 |
| DCA | NEARUSD | tightTP(5%) | 60d | raw | 14 | 100.0 | inf | 35.38 | 0.0 |
| DCA | NEARUSD | tightTP(5%) | 60d | gated | 14 | 100.0 | inf | 35.38 | 0.0 |
| DCA | NEARUSD | tightTP(5%) | 60d | enhanced | 14 | 100.0 | inf | 35.38 | 0.0 |
| DCA | INJUSD | daily | 60d | enhanced-maker | 6 | 100.0 | inf | 33.97 | 0.0 |
| DCA | INJUSD | tightTP(5%) | 90d | raw | 13 | 100.0 | inf | 32.49 | 0.0 |
| DCA | INJUSD | tightTP(5%) | 90d | gated | 13 | 100.0 | inf | 32.49 | 0.0 |
| DCA | INJUSD | tightTP(5%) | 90d | enhanced | 13 | 100.0 | inf | 32.49 | 0.0 |
| MACD | NEARUSD | macdAboveZero | 30d | raw | 9 | 66.7 | 9.74 | 32.26 | 3.3 |

## 5. Per-strategy avg Net % by mode (does each layer help?)

Mean Net % across all (ticker × params × window) cells, broken out by mode.
- **raw**: base strategy, default exits, taker fees
- **gated**: + regime filter (UP/RANGE only as applicable)
- **enhanced**: + confirmation candle + 4h HTF filter + volume gate + BE@1.5R + chandelier@2.5R, taker fees
- **enhanced-maker**: enhanced, but with maker rebates (−0.10% round-trip) instead of taker (+0.52%)

| Strategy | raw | gated | enhanced | enh-maker | Δ enh−raw | Δ maker−enh |
|---|---:|---:|---:|---:|---:|---:|
| MA_CROSS | -1.05 | -0.24 | -0.12 | -0.08 | 0.92 | 0.04 |
| RSI_REVERSAL | -8.45 | -5.51 | -0.37 | -0.13 | 8.08 | 0.24 |
| BOLLINGER_MR | -9.13 | -4.33 | -0.38 | -0.16 | 8.76 | 0.22 |
| MACD | 0.54 | 1.94 | 1.49 | 4.30 | 0.96 | 2.81 |
| DONCHIAN_BREAKOUT | -4.85 | -4.48 | -2.09 | -0.52 | 2.76 | 1.57 |
| DCA | 21.29 | 21.29 | 21.29 | 23.49 | 0.00 | 2.21 |
| GRID | -8.63 | -5.44 | -5.48 | -3.29 | 3.15 | 2.19 |
| VWAP | -29.39 | -24.33 | -8.04 | -0.56 | 21.34 | 7.48 |
| VOLUME_PROFILE | -21.85 | -14.22 | -2.28 | -1.30 | 19.56 | 0.98 |
| CANDLESTICK | -14.91 | -11.64 | -1.51 | 0.49 | 13.40 | 1.99 |

Avg trades per (ticker × params × window) by mode:

| Strategy | raw trades | gated trades | enhanced trades | enh-maker trades |
|---|---:|---:|---:|---:|
| MA_CROSS | 1.4 | 0.3 | 0.1 | 0.1 |
| RSI_REVERSAL | 21.4 | 11.7 | 0.8 | 0.8 |
| BOLLINGER_MR | 23.2 | 11.3 | 0.7 | 0.7 |
| MACD | 33.1 | 10.2 | 8.7 | 8.7 |
| DONCHIAN_BREAKOUT | 20.8 | 18.2 | 5.1 | 5.1 |
| DCA | 5.7 | 5.7 | 5.7 | 5.7 |
| GRID | 87.2 | 53.2 | 36.1 | 36.1 |
| VWAP | 127.0 | 96.7 | 25.6 | 25.6 |
| VOLUME_PROFILE | 64.3 | 32.0 | 3.2 | 3.2 |
| CANDLESTICK | 53.1 | 40.1 | 6.5 | 6.5 |

## 6. Per-strategy best & roll-up

Best cell = best Net % across (ticker × params × window × gating) with ≥ 5 trades.

| Strategy | Best Cell | Net % | PF | Trades | WR % | Total runs | Profitable runs (%) |
|---|---|---:|---:|---:|---:|---:|---:|
| MA_CROSS | AAVEUSD/looseGap/90d/raw | -2.02 | 0.59 | 7 | 14.3 | 192 | 0% |
| RSI_REVERSAL | DOGEUSD/tight(25)/90d/raw | 1.74 | 1.34 | 9 | 44.4 | 192 | 1% |
| BOLLINGER_MR | ICPUSD/default(20,2)/90d/gated | 1.27 | 1.13 | 22 | 59.1 | 192 | 3% |
| MACD | NEARUSD/macdAboveZero/30d/raw | 32.26 | 9.74 | 9 | 66.7 | 240 | 45% |
| DONCHIAN_BREAKOUT | COMPUSD/highVol(z2)/60d/gated | 5.11 | 1.49 | 17 | 29.4 | 240 | 18% |
| DCA | NEARUSD/daily/90d/enhanced-maker | 64.83 | inf | 11 | 100.0 | 144 | 42% |
| GRID | FETUSD/wide(3%)/90d/enhanced-maker | 7.02 | 1.62 | 55 | 67.3 | 144 | 12% |
| VWAP | ETHUSD/default(-1.5σ)/60d/enhanced-maker | 1.79 | 1.68 | 29 | 51.7 | 144 | 8% |
| VOLUME_PROFILE | RUNEUSD/tight(48,30,80%)/30d/gated | 1.77 | 1.35 | 7 | 28.6 | 144 | 3% |
| CANDLESTICK | XRPUSD/default/60d/enhanced-maker | 2.25 | 3.37 | 7 | 71.4 | 144 | 15% |

## 7. Walk-forward validation (60% IS / 40% OOS split)

For each (strategy × top-ticker × window), the best param+mode combo is selected on the first 60% of the window (in-sample), then re-tested on the last 40% (out-of-sample). Large gap from IS to OOS = overfitting risk. Sign flip (IS+ → OOS−) = catastrophic. Skipped runs had <3 IS trades.

Top OOS results (≥ 3 OOS trades), sorted by OOS Net %:

| Strategy | Ticker | Window | Best params/mode | IS Net % | OOS Net % | Fragility | IS trades | OOS trades |
|---|---|---:|---|---:|---:|---:|---:|---:|
| DCA | NEARUSD | 90d | daily/enhanced-maker | 20.16 | 35.63 | 1.77 | 5 | 7 |
| DCA | NEARUSD | 60d | tightTP(5%)/enhanced-maker | 8.78 | 24.86 | 2.83 | 6 | 9 |
| DCA | NEARUSD | 30d | daily/enhanced-maker | 16.40 | 23.03 | 1.40 | 4 | 5 |
| MACD | NEARUSD | 90d | macdAboveZero/enhanced-maker | -1.90 | 20.41 | -10.76 | 10 | 7 |
| MACD | NEARUSD | 30d | macdAboveZero/raw | 11.26 | 18.87 | 1.68 | 3 | 6 |
| DCA | FETUSD | 60d | tightTP(5%)/enhanced-maker | -4.68 | 13.13 | -2.80 | 3 | 5 |
| DCA | INJUSD | 30d | tightTP(5%)/enhanced-maker | 16.86 | 7.68 | 0.46 | 8 | 3 |
| DCA | ALGOUSD | 90d | tightTP(5%)/enhanced-maker | 3.44 | 5.85 | 1.70 | 6 | 6 |
| DONCHIAN_BREAKOUT | NEARUSD | 30d | pullback(30)/raw | -0.33 | 4.91 | — | 5 | 3 |
| DCA | ALGOUSD | 60d | daily/enhanced-maker | 10.09 | 4.02 | 0.40 | 4 | 3 |
| RSI_REVERSAL | FILUSD | 30d | default(30)/raw | 0.12 | 1.67 | — | 3 | 5 |
| RSI_REVERSAL | DOGEUSD | 90d | tight(25)/raw | 0.12 | 1.61 | — | 5 | 4 |
| MACD | INJUSD | 60d | default(12/26/9)/enhanced-maker | 5.06 | 1.21 | 0.24 | 5 | 17 |
| CANDLESTICK | BTCUSD | 90d | default/enhanced-maker | 0.12 | 1.10 | — | 7 | 13 |
| GRID | COMPUSD | 60d | wide(3%)/enhanced-maker | -1.43 | 0.86 | -0.60 | 3 | 3 |
| VWAP | ETHUSD | 90d | default(-1.5σ)/enhanced-maker | 0.87 | 0.48 | 0.56 | 25 | 17 |
| VWAP | BTCUSD | 90d | tight(-2σ)/enhanced-maker | -0.26 | 0.43 | — | 7 | 13 |
| VWAP | BTCUSD | 60d | loose(-1σ)/enhanced-maker | 1.00 | 0.41 | 0.41 | 27 | 16 |
| MACD | AAVEUSD | 30d | divergence/raw | -1.06 | 0.20 | -0.19 | 3 | 4 |
| VWAP | ETHUSD | 60d | default(-1.5σ)/enhanced-maker | 1.84 | -0.05 | sign-flip | 19 | 10 |
| CANDLESTICK | BTCUSD | 60d | biggerBody(2x)/enhanced-maker | 1.41 | -0.28 | sign-flip | 8 | 8 |
| CANDLESTICK | SOLUSD | 90d | default/enhanced-maker | 1.68 | -0.30 | sign-flip | 3 | 4 |
| VWAP | SOLUSD | 60d | tight(-2σ)/enhanced-maker | 0.15 | -0.34 | — | 3 | 3 |
| CANDLESTICK | ETHUSD | 60d | default/enhanced-maker | 1.56 | -0.40 | sign-flip | 8 | 5 |
| DONCHIAN_BREAKOUT | RUNEUSD | 60d | long(30)/raw | 5.61 | -0.51 | sign-flip | 10 | 7 |

Worst IS→OOS collapses (sorted by fragility, most negative first):

| Strategy | Ticker | Window | Best params/mode | IS Net % | OOS Net % | Fragility |
|---|---|---:|---|---:|---:|---:|
| RSI_REVERSAL | FILUSD | 90d | tight(25)/raw | 1.38 | -2.88 | sign-flip |
| RSI_REVERSAL | ICPUSD | 60d | loose(35)/raw | 1.07 | -10.33 | sign-flip |
| RSI_REVERSAL | COMPUSD | 60d | fastRsi(7)/gated | 1.30 | -6.87 | sign-flip |
| RSI_REVERSAL | DOGEUSD | 60d | loose(35)/raw | 1.75 | -3.97 | sign-flip |
| BOLLINGER_MR | FILUSD | 60d | noSqueeze/gated | 2.22 | -5.48 | sign-flip |
| BOLLINGER_MR | ICPUSD | 30d | default(20,2)/gated | 1.65 | -0.53 | sign-flip |
| BOLLINGER_MR | ICPUSD | 90d | noSqueeze/gated | 2.21 | -1.44 | sign-flip |
| MACD | INJUSD | 30d | wideStop(2.5atr)/gated | 7.38 | -5.86 | sign-flip |
| MACD | ALGOUSD | 60d | macdAboveZero/raw | 13.54 | -1.88 | sign-flip |
| MACD | ALGOUSD | 90d | macdAboveZero/raw | 12.86 | -3.69 | sign-flip |

## 9. Pairs Trading

Cross-asset mean reversion: long one ticker, short another, in β-hedged ratios.
Implementation requires margin/futures (short leg); spot-only Kraken cannot execute as-is.

### Cointegrated pair candidates (top 12 by composite score)

| Rank | A | B | β | r² | ADF t | Halflife | Score |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | AVAXUSD | SOLUSD | 0.779 | 0.80 | -4.86 | 30 | 7.65 |
| 2 | LINKUSD | FILUSD | 0.548 | 0.78 | -4.77 | 35 | 7.53 |
| 3 | HBARUSD | DOTUSD | 0.419 | 0.76 | -4.44 | 36 | 7.09 |
| 4 | HBARUSD | UNIUSD | 0.423 | 0.74 | -4.43 | 37 | 7.02 |
| 5 | FILUSD | ICPUSD | 0.750 | 0.76 | -4.10 | 43 | 6.80 |
| 6 | HBARUSD | ADAUSD | 0.764 | 0.76 | -4.17 | 48 | 6.78 |
| 7 | LTCUSD | XRPUSD | 0.689 | 0.73 | -4.00 | 42 | 6.50 |
| 8 | LINKUSD | ICPUSD | 0.452 | 0.71 | -4.06 | 44 | 6.46 |
| 9 | ATOMUSD | INJUSD | 0.294 | 0.77 | -3.61 | 53 | 6.23 |
| 10 | ADAUSD | SOLUSD | 0.891 | 0.77 | -3.62 | 53 | 6.21 |
| 11 | DOGEUSD | MKRUSD | 0.637 | 0.69 | -3.87 | 46 | 6.10 |
| 12 | AVAXUSD | ICPUSD | 0.290 | 0.56 | -4.65 | 32 | 6.02 |

### Top profitable backtest cells (≥5 trades)

| Pair | Window | Params | Mode | Trades | WR % | PF | Net % | LongSpread/ShortSpread |
|---|---:|---|---|---:|---:|---:|---:|---:|
| FILUSD/ICPUSD | 90d | tight(1.5σ/0.3σ) | maker | 28 | 50.0 | 2.57 | 14.26 | 20/8 |
| FILUSD/ICPUSD | 30d | tight(1.5σ/0.3σ) | maker | 7 | 85.7 | 19.95 | 13.04 | 1/6 |
| FILUSD/ICPUSD | 90d | default(2σ/0.5σ) | maker | 25 | 48.0 | 2.75 | 12.92 | 19/6 |
| FILUSD/ICPUSD | 90d | wide(2.5σ/0.5σ) | maker | 23 | 52.2 | 3.04 | 12.71 | 18/5 |
| FILUSD/ICPUSD | 30d | tight(1.5σ/0.3σ) | taker | 7 | 85.7 | 15.04 | 11.84 | 1/6 |
| FILUSD/ICPUSD | 60d | tight(1.5σ/0.3σ) | maker | 9 | 66.7 | 7.32 | 11.56 | 2/7 |
| FILUSD/ICPUSD | 60d | default(2σ/0.5σ) | maker | 7 | 71.4 | 11.47 | 11.43 | 2/5 |
| FILUSD/ICPUSD | 60d | wide(2.5σ/0.5σ) | maker | 5 | 100.0 | inf | 11.19 | 1/4 |
| FILUSD/ICPUSD | 60d | wide(2.5σ/0.5σ) | taker | 5 | 100.0 | inf | 10.35 | 1/4 |
| FILUSD/ICPUSD | 60d | default(2σ/0.5σ) | taker | 7 | 71.4 | 8.32 | 10.24 | 2/5 |
| FILUSD/ICPUSD | 60d | tight(1.5σ/0.3σ) | taker | 9 | 66.7 | 5.39 | 10.03 | 2/7 |
| FILUSD/ICPUSD | 90d | tight(1.5σ/0.3σ) | taker | 28 | 50.0 | 1.85 | 9.42 | 20/8 |
| FILUSD/ICPUSD | 90d | wide(2.5σ/0.5σ) | taker | 23 | 52.2 | 2.11 | 8.78 | 18/5 |
| FILUSD/ICPUSD | 90d | default(2σ/0.5σ) | taker | 25 | 48.0 | 1.93 | 8.65 | 19/6 |
| LINKUSD/ICPUSD | 90d | wide(2.5σ/0.5σ) | maker | 12 | 66.7 | 4.38 | 7.72 | 2/10 |
| LINKUSD/ICPUSD | 30d | wide(2.5σ/0.5σ) | maker | 11 | 63.6 | 4.27 | 7.45 | 2/9 |
| LINKUSD/ICPUSD | 60d | wide(2.5σ/0.5σ) | maker | 11 | 63.6 | 4.27 | 7.45 | 2/9 |
| HBARUSD/ADAUSD | 90d | default(2σ/0.5σ) | maker | 9 | 100.0 | inf | 6.79 | 5/4 |
| AVAXUSD/SOLUSD | 90d | tight(1.5σ/0.3σ) | maker | 18 | 94.4 | 24.93 | 5.97 | 8/10 |
| LINKUSD/ICPUSD | 90d | wide(2.5σ/0.5σ) | taker | 12 | 41.7 | 2.87 | 5.75 | 2/10 |

### Walk-forward results (60% IS / 40% OOS)

Top OOS results sorted by OOS Net % (requires ≥ 2 OOS trades):

| Pair | Window | Params/Mode | IS Net % | OOS Net % | Fragility | IS / OOS trades |
|---|---:|---|---:|---:|---:|---:|
| FILUSD/ICPUSD | 90d | wide(2.5σ/0.5σ)/maker | 2.79 | 11.28 | 4.05 | 20 / 5 |
| FILUSD/ICPUSD | 60d | wide(2.5σ/0.5σ)/maker | 1.30 | 9.59 | 7.38 | 3 / 3 |
| LINKUSD/ICPUSD | 90d | tight(1.5σ/0.3σ)/maker | 3.74 | 7.19 | 1.92 | 7 / 14 |
| LINKUSD/ICPUSD | 60d | default(2σ/0.5σ)/maker | 0.61 | 6.04 | 9.90 | 3 / 13 |
| AVAXUSD/SOLUSD | 90d | tight(1.5σ/0.3σ)/maker | 3.16 | 2.58 | 0.82 | 8 / 9 |
| AVAXUSD/SOLUSD | 60d | tight(1.5σ/0.3σ)/maker | 2.99 | 2.16 | 0.72 | 5 / 10 |
| HBARUSD/UNIUSD | 90d | default(2σ/0.5σ)/maker | 3.88 | 1.43 | 0.37 | 6 / 4 |
| FILUSD/ICPUSD | 30d | tight(1.5σ/0.3σ)/maker | 11.95 | 1.16 | 0.10 | 5 / 2 |
| HBARUSD/UNIUSD | 30d | default(2σ/0.5σ)/maker | 0.66 | 1.02 | 1.56 | 2 / 2 |
| AVAXUSD/SOLUSD | 30d | tight(1.5σ/0.3σ)/maker | 1.30 | 0.71 | 0.54 | 5 / 5 |
| LTCUSD/XRPUSD | 90d | tight(1.5σ/0.3σ)/maker | 2.26 | 0.48 | 0.21 | 8 / 32 |
| LINKUSD/ICPUSD | 30d | wide(2.5σ/0.5σ)/maker | 8.87 | 0.33 | 0.04 | 3 / 10 |
| LINKUSD/FILUSD | 30d | tight(1.5σ/0.3σ)/maker | 1.83 | 0.28 | 0.15 | 19 / 4 |
| LINKUSD/FILUSD | 60d | tight(1.5σ/0.3σ)/maker | 0.34 | 0.21 | — | 3 / 15 |
| HBARUSD/DOTUSD | 60d | tight(1.5σ/0.3σ)/maker | 2.41 | 0.19 | 0.08 | 5 / 3 |

Notes:
- Cointegration is fragile in crypto due to regime changes (halvings, listings, hacks). Pairs that pass ADF 5% on the full sweep window can still fail OOS.
- The short leg simulation assumes shorts are feasible at the entry price. On Kraken spot this requires margin trading (some pairs only) or perpetual futures (separate venue).
- Fees applied per leg per side. With taker fees (0.26%/side), each round-trip pair trade costs ~1% in fees. Maker rebates make a substantial difference here.

## 10. Methodology notes

- **Ticker selection is closed-form, not backtest-driven.** Picking optimal tickers from backtest results would be circular (overfitting to history). Instead, each ticker is scored by structural properties (Hurst exponent, ATR%, drift, vol-of-volume, range-bound score) against each strategy's theoretical requirements.
- **Single-position long-only.** The runner holds at most one position at a time per (strategy × ticker × params). Live deployment would parallelize.
- **Next-bar fill, no lookahead.** Signal closes on bar `i`, fill on bar `i+1` open. Mirrors live execution.
- **Fees and slippage applied per side.** Kraken taker round-trip (0.52%) plus 5 bps slippage per side. Maker-rebate scenarios would shift many strategies positive.
- **Stop-first intrabar resolution.** When both stop and target are touched within the same bar, the stop is assumed first (conservative).
- **Skipped:** Pairs Trading (#11 — needs cointegration logic), Chart Patterns (#20 — needs swing detection). These have meaningfully different structure and deserve their own sessions.
