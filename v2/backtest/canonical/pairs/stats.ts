// Pair-trading statistical helpers.
//
// All from first principles — no scipy/statsmodels dependency. The key tests:
//
//   1. Pearson correlation (cheap pre-filter; fails fast on uncorrelated pairs)
//   2. OLS regression A = α + β·B + ε (gives hedge ratio β)
//   3. ADF on residuals (cointegration test)
//   4. Ornstein-Uhlenbeck halflife of residuals (mean-reversion speed)
//
// ADF critical values for ~2000 observations are roughly:
//   1% → -3.43, 5% → -2.86, 10% → -2.57

export interface RegressionResult {
  alpha: number;
  beta: number;
  residuals: number[];
  rSquared: number;
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

// OLS: y = α + β·x
export function ols(y: number[], x: number[]): RegressionResult {
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

// Augmented Dickey-Fuller test (lag=0; sufficient for daily/hourly residuals).
// Regress Δy = γ·y_{t-1} + ε, then t-stat = γ̂ / SE(γ̂).
// A more negative t-stat = stronger rejection of unit root = more stationary.
//
// Critical values (n ≥ 250, no constant or trend in test regression):
//   1%: -3.43, 5%: -2.86, 10%: -2.57
export interface AdfResult {
  tStat: number;
  isStationary5pct: boolean;
  isStationary1pct: boolean;
}

export function adfTest(series: number[]): AdfResult {
  const n = series.length;
  if (n < 30) return { tStat: 0, isStationary5pct: false, isStationary1pct: false };
  // Δy_t = γ·y_{t-1} + ε  (n-1 observations)
  const dy: number[] = new Array(n - 1);
  const ylag: number[] = new Array(n - 1);
  for (let i = 1; i < n; i++) {
    dy[i - 1] = series[i] - series[i - 1];
    ylag[i - 1] = series[i - 1];
  }
  // OLS without intercept: γ = Σ(y·Δy) / Σ(y²)
  let num = 0, den = 0;
  for (let i = 0; i < dy.length; i++) {
    num += ylag[i] * dy[i];
    den += ylag[i] * ylag[i];
  }
  if (den === 0) return { tStat: 0, isStationary5pct: false, isStationary1pct: false };
  const gamma = num / den;
  // Residuals from this regression
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

// Ornstein-Uhlenbeck halflife of mean reversion.
// Fit Δy_t = -λ·(y_{t-1} - μ) + ε  →  halflife = ln(2) / λ
// Returns +Infinity if not mean-reverting (λ ≤ 0); use as upper bound (slow).
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
  // Δy = -λ·(y - μ); λ = -slope
  let num = 0, den = 0;
  for (let i = 0; i < dy.length; i++) {
    num += ydev[i] * dy[i];
    den += ydev[i] * ydev[i];
  }
  if (den === 0) return Infinity;
  const lambda = -num / den;
  if (lambda <= 0) return Infinity;  // diverging or random walk
  return Math.log(2) / lambda;
}

export interface CointegrationTest {
  alpha: number;        // intercept from y = α + β·x
  beta: number;         // hedge ratio
  rSquared: number;
  correlation: number;  // Pearson on log prices
  adfTStat: number;
  isStationary5pct: boolean;
  isStationary1pct: boolean;
  halflife: number;     // bars
  spreadMean: number;
  spreadStd: number;
}

// Test cointegration of two log-price series using Engle-Granger 2-step.
// We use log prices (not raw) so the β is a unitless ratio insensitive to
// asset price scale.
export function testCointegration(logPx_y: number[], logPx_x: number[]): CointegrationTest {
  const correlation = pearsonCorr(logPx_y, logPx_x);
  const reg = ols(logPx_y, logPx_x);
  const adf = adfTest(reg.residuals);
  const halflife = ouHalflife(reg.residuals);
  const mean = reg.residuals.reduce((s, v) => s + v, 0) / reg.residuals.length;
  const variance = reg.residuals.reduce((s, v) => s + (v - mean) ** 2, 0) / reg.residuals.length;
  return {
    alpha: reg.alpha,
    beta: reg.beta,
    rSquared: reg.rSquared,
    correlation,
    adfTStat: adf.tStat,
    isStationary5pct: adf.isStationary5pct,
    isStationary1pct: adf.isStationary1pct,
    halflife,
    spreadMean: mean,
    spreadStd: Math.sqrt(variance),
  };
}
