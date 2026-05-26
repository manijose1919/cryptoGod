// Compatibility shim: forwards to the full sweep runner.
// The original tiny backtest was superseded by sweep.ts (universe expansion,
// param sweep, regime gating, fitness-based ticker selection).
//
// Run: npx tsx v2/backtest/canonical/index.ts
import './sweep.ts';
