// Statistical primitives for live pairs trading.
// Mirrors v2/backtest/canonical/pairs/stats.ts — kept in sync for backtest
// fidelity. If you change one, change the other.
//
// Why duplicated? The live engine MUST NOT import from v2/backtest/, since
// the backtest harness has its own initialization and dependencies (candle
// cache, sqlite test tables, etc.). Duplication is the lesser evil vs a
// circular dependency.

export interface CointegrationStats {
  alpha: number;
  beta: number;
  rSquared: number;
  correlation: number;
  adfTStat: number;
  isStationary5pct: boolean;
  isStationary1pct: boolean;
  halflife: number;
  spreadMean: number;
  spreadStd: number;
}

export function pearsonCorr(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  return (vx > 0 && vy > 0) ? cov / Math.sqrt(vx * vy) : 0;
}

function olsAlphaBetaResiduals(y: number[], x: number[]): {
  alpha: number; beta: number; residuals: number[]; rSquared: number;
} {
  const n = Math.min(y.length, x.length);
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) ** 2;
  }
  const beta = vx > 0 ? cov / vx : 0;
  const alpha = my - beta * mx;
  const residuals: number[] = new Array(n);
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    residuals[i] = y[i] - (alpha + beta * x[i]);
    ssRes += residuals[i] ** 2;
    ssTot += (y[i] - my) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { alpha, beta, residuals, rSquared };
}

// ADF test, lag=0. Critical values for n ≥ 250 (no constant/trend):
//   1%: -3.43, 5%: -2.86, 10%: -2.57
export function adfTest(series: number[]): {
  tStat: number;
  isStationary5pct: boolean;
  isStationary1pct: boolean;
} {
  const n = series.length;
  if (n < 30) return { tStat: 0, isStationary5pct: false, isStationary1pct: false };
  const dy: number[] = new Array(n - 1);
  const ylag: number[] = new Array(n - 1);
  for (let i = 1; i < n; i++) {
    dy[i - 1] = series[i] - series[i - 1];
    ylag[i - 1] = series[i - 1];
  }
  let num = 0, den = 0;
  for (let i = 0; i < dy.length; i++) {
    num += ylag[i] * dy[i];
    den += ylag[i] * ylag[i];
  }
  if (den === 0) return { tStat: 0, isStationary5pct: false, isStationary1pct: false };
  const gamma = num / den;
  let ssRes = 0;
  for (let i = 0; i < dy.length; i++) {
    const resid = dy[i] - gamma * ylag[i];
    ssRes += resid ** 2;
  }
  const sigma2 = ssRes / (dy.length - 1);
  const seGamma = Math.sqrt(sigma2 / den);
  const tStat = seGamma > 0 ? gamma / seGamma : 0;
  return {
    tStat,
    isStationary5pct: tStat < -2.86,
    isStationary1pct: tStat < -3.43,
  };
}

// Ornstein-Uhlenbeck halflife. Δy = -λ(y - μ) + ε  →  halflife = ln(2)/λ
export function ouHalflife(series: number[]): number {
  const n = series.length;
  if (n < 30) return Infinity;
  const mean = series.reduce((s, v) => s + v, 0) / n;
  const dy: number[] = [];
  const ydev: number[] = [];
  for (let i = 1; i < n; i++) {
    dy.push(series[i] - series[i - 1]);
    ydev.push(series[i - 1] - mean);
  }
  let num = 0, den = 0;
  for (let i = 0; i < dy.length; i++) {
    num += ydev[i] * dy[i];
    den += ydev[i] * ydev[i];
  }
  if (den === 0) return Infinity;
  const lambda = -num / den;
  if (lambda <= 0) return Infinity;
  return Math.log(2) / lambda;
}

export function testCointegration(logY: number[], logX: number[]): CointegrationStats {
  const correlation = pearsonCorr(logY, logX);
  const reg = olsAlphaBetaResiduals(logY, logX);
  const adf = adfTest(reg.residuals);
  const halflife = ouHalflife(reg.residuals);
  const mean = reg.residuals.reduce((s, v) => s + v, 0) / reg.residuals.length;
  let varSum = 0;
  for (const r of reg.residuals) varSum += (r - mean) ** 2;
  const variance = varSum / reg.residuals.length;
  return {
    alpha: reg.alpha, beta: reg.beta, rSquared: reg.rSquared,
    correlation,
    adfTStat: adf.tStat,
    isStationary5pct: adf.isStationary5pct,
    isStationary1pct: adf.isStationary1pct,
    halflife,
    spreadMean: mean,
    spreadStd: Math.sqrt(variance),
  };
}

// Cheap rolling update — just α/β/spread stats, no ADF/halflife.
// Use this between full re-estimates if needed.
export function reestimateRecent(
  logA: number[], logB: number[], windowEnd: number, windowSize: number,
): { alpha: number; beta: number; spreadMean: number; spreadStd: number } {
  const start = Math.max(0, windowEnd - windowSize + 1);
  const y = logA.slice(start, windowEnd + 1);
  const x = logB.slice(start, windowEnd + 1);
  const reg = olsAlphaBetaResiduals(y, x);
  let smean = 0;
  for (const r of reg.residuals) smean += r;
  smean /= reg.residuals.length;
  let svar = 0;
  for (const r of reg.residuals) svar += (r - smean) ** 2;
  svar /= reg.residuals.length;
  return {
    alpha: reg.alpha,
    beta: reg.beta,
    spreadMean: smean,
    spreadStd: Math.sqrt(svar),
  };
}
