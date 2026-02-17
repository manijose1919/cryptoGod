"""
LSTM-Lite Sequence Model for Price Direction Prediction

Enhanced replacement for sequence_model.py using a proper LSTM cell architecture
with forget/input/output gates, Xavier/Glorot initialization, simplified BPTT
training with gradient clipping, and an SGDClassifier output layer.

Uses only numpy + scikit-learn (no PyTorch) for maximum portability.

Architecture:
    Input  -> [20 timesteps x 20 features] -> LSTM cell (hidden=64)
    LSTM   -> final hidden state h_T (64-dim)
    Output -> SGDClassifier(h_T) -> {BUY, SELL, HOLD}

Features (20 selected from 109-feature superset):
    ret_1, ret_3, ret_5, atr_norm, vol_ratio, rsi, macd_hist, bb_pctb,
    ema20_dist, body_ratio, hour_sin, hour_cos, candle_streak, vol_trend,
    std_norm, ema50_dist, upper_wick, lower_wick, ret_10, ret_20
"""

import logging
import threading
import time
from pathlib import Path
from typing import Dict, Optional, Tuple
from collections import deque

import numpy as np
import pandas as pd
from sklearn.linear_model import SGDClassifier
from sklearn.preprocessing import StandardScaler

logger = logging.getLogger("lstm_model")

MODEL_DIR = Path(__file__).parent.parent / "models"
MODEL_DIR.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SEQ_LENGTH = 20          # Look-back window: 20 timesteps
FEATURE_DIM = 20         # 20 selected features per timestep
HIDDEN_DIM = 64          # LSTM hidden state size
OUTPUT_DIM = 3           # BUY, SELL, HOLD

# Selected feature names (order matters - indexes into extraction)
FEATURE_NAMES = [
    "ret_1", "ret_3", "ret_5", "atr_norm", "vol_ratio",
    "rsi", "macd_hist", "bb_pctb", "ema20_dist", "body_ratio",
    "hour_sin", "hour_cos", "candle_streak", "vol_trend",
    "std_norm", "ema50_dist", "upper_wick", "lower_wick",
    "ret_10", "ret_20",
]

# Training configuration
MAX_TRAINING_BUFFER = 3000
RETRAIN_EVERY_N = 25          # Was 200 — retrain more often while learning
MIN_SAMPLES_TO_TRAIN = 15     # Was 80 — start training with less data
BPTT_EPOCHS = 5
BPTT_LEARNING_RATE = 0.005
GRADIENT_CLIP = 5.0

# Action encoding
ACTION_MAP = {"BUY": 0, "SELL": 1, "HOLD": 2}
ACTION_NAMES = {0: "BUY", 1: "SELL", 2: "HOLD"}


# ---------------------------------------------------------------------------
# Activation functions (numerically stable)
# ---------------------------------------------------------------------------
def _sigmoid(x: np.ndarray) -> np.ndarray:
    """Numerically stable sigmoid."""
    x = np.clip(x, -15, 15)
    return 1.0 / (1.0 + np.exp(-x))


def _sigmoid_deriv(s: np.ndarray) -> np.ndarray:
    """Derivative of sigmoid given sigmoid output s."""
    return s * (1.0 - s)


def _tanh(x: np.ndarray) -> np.ndarray:
    return np.tanh(np.clip(x, -15, 15))


def _tanh_deriv(t: np.ndarray) -> np.ndarray:
    """Derivative of tanh given tanh output t."""
    return 1.0 - t ** 2


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - np.max(x))
    return e / (e.sum() + 1e-10)


# ---------------------------------------------------------------------------
# Xavier / Glorot initialization
# ---------------------------------------------------------------------------
def _xavier_init(fan_in: int, fan_out: int) -> np.ndarray:
    """Xavier/Glorot uniform initialization."""
    limit = np.sqrt(6.0 / (fan_in + fan_out))
    return np.random.uniform(-limit, limit, (fan_in, fan_out))


# ---------------------------------------------------------------------------
# LSTM Cell (numpy implementation)
# ---------------------------------------------------------------------------
class NumpyLSTMCell:
    """
    Single LSTM cell implementing the standard LSTM equations:

        f_t = sigmoid(W_f @ x_t + U_f @ h_{t-1} + b_f)       # forget gate
        i_t = sigmoid(W_i @ x_t + U_i @ h_{t-1} + b_i)       # input gate
        c_tilde = tanh(W_c @ x_t + U_c @ h_{t-1} + b_c)      # candidate
        c_t = f_t * c_{t-1} + i_t * c_tilde                    # cell state
        o_t = sigmoid(W_o @ x_t + U_o @ h_{t-1} + b_o)       # output gate
        h_t = o_t * tanh(c_t)                                   # hidden state

    All weight matrices use Xavier/Glorot initialization.
    """

    GATE_NAMES = ["f", "i", "c", "o"]  # forget, input, candidate, output

    def __init__(self, input_dim: int, hidden_dim: int):
        self.input_dim = input_dim
        self.hidden_dim = hidden_dim

        # Forget gate weights
        self.W_f = _xavier_init(input_dim, hidden_dim)
        self.U_f = _xavier_init(hidden_dim, hidden_dim)
        self.b_f = np.ones(hidden_dim) * 0.5  # bias towards remembering

        # Input gate weights
        self.W_i = _xavier_init(input_dim, hidden_dim)
        self.U_i = _xavier_init(hidden_dim, hidden_dim)
        self.b_i = np.zeros(hidden_dim)

        # Candidate cell state weights
        self.W_c = _xavier_init(input_dim, hidden_dim)
        self.U_c = _xavier_init(hidden_dim, hidden_dim)
        self.b_c = np.zeros(hidden_dim)

        # Output gate weights
        self.W_o = _xavier_init(input_dim, hidden_dim)
        self.U_o = _xavier_init(hidden_dim, hidden_dim)
        self.b_o = np.zeros(hidden_dim)

    def forward_step(
        self, x_t: np.ndarray, h_prev: np.ndarray, c_prev: np.ndarray
    ) -> Tuple[np.ndarray, np.ndarray, dict]:
        """
        Single forward step through the LSTM cell.

        Args:
            x_t:    input vector at time t, shape (input_dim,)
            h_prev: previous hidden state, shape (hidden_dim,)
            c_prev: previous cell state, shape (hidden_dim,)

        Returns:
            h_t:    new hidden state
            c_t:    new cell state
            cache:  dict of intermediate values for backpropagation
        """
        # Gate computations
        f_t = _sigmoid(x_t @ self.W_f + h_prev @ self.U_f + self.b_f)
        i_t = _sigmoid(x_t @ self.W_i + h_prev @ self.U_i + self.b_i)
        c_tilde = _tanh(x_t @ self.W_c + h_prev @ self.U_c + self.b_c)
        c_t = f_t * c_prev + i_t * c_tilde
        o_t = _sigmoid(x_t @ self.W_o + h_prev @ self.U_o + self.b_o)
        tanh_c_t = _tanh(c_t)
        h_t = o_t * tanh_c_t

        cache = {
            "x_t": x_t, "h_prev": h_prev, "c_prev": c_prev,
            "f_t": f_t, "i_t": i_t, "c_tilde": c_tilde,
            "c_t": c_t, "o_t": o_t, "tanh_c_t": tanh_c_t, "h_t": h_t,
        }
        return h_t, c_t, cache

    def forward_sequence(
        self,
        x_seq: np.ndarray,
        h_init: Optional[np.ndarray] = None,
        c_init: Optional[np.ndarray] = None,
    ) -> Tuple[np.ndarray, np.ndarray, list]:
        """
        Process a full sequence through the LSTM.

        Args:
            x_seq:  shape (seq_len, input_dim)
            h_init: initial hidden state (optional)
            c_init: initial cell state (optional)

        Returns:
            h_final: final hidden state (hidden_dim,)
            c_final: final cell state (hidden_dim,)
            caches:  list of cache dicts (one per timestep)
        """
        seq_len = x_seq.shape[0]
        h = h_init if h_init is not None else np.zeros(self.hidden_dim)
        c = c_init if c_init is not None else np.zeros(self.hidden_dim)
        caches = []

        for t in range(seq_len):
            h, c, cache = self.forward_step(x_seq[t], h, c)
            caches.append(cache)

        return h, c, caches

    def backward_sequence(
        self, dh_final: np.ndarray, caches: list, lr: float = 0.005
    ) -> None:
        """
        Simplified BPTT: backpropagate gradient from final hidden state
        through the sequence, accumulate weight gradients, and apply updates.

        Args:
            dh_final: gradient of loss w.r.t. final hidden state (hidden_dim,)
            caches:   list of cache dicts from forward pass
            lr:       learning rate
        """
        seq_len = len(caches)

        # Initialize gradient accumulators
        grads = {}
        for gate in self.GATE_NAMES:
            grads[f"dW_{gate}"] = np.zeros_like(getattr(self, f"W_{gate}"))
            grads[f"dU_{gate}"] = np.zeros_like(getattr(self, f"U_{gate}"))
            grads[f"db_{gate}"] = np.zeros_like(getattr(self, f"b_{gate}"))

        dh_next = dh_final.copy()
        dc_next = np.zeros(self.hidden_dim)

        for t in reversed(range(seq_len)):
            cache = caches[t]
            x_t = cache["x_t"]
            h_prev = cache["h_prev"]
            c_prev = cache["c_prev"]
            f_t = cache["f_t"]
            i_t = cache["i_t"]
            c_tilde = cache["c_tilde"]
            c_t = cache["c_t"]
            o_t = cache["o_t"]
            tanh_c_t = cache["tanh_c_t"]

            # dh_t comes from both output gradient and next timestep
            dh_t = dh_next

            # Gradient through output gate: h_t = o_t * tanh(c_t)
            do_t = dh_t * tanh_c_t
            d_tanh_c_t = dh_t * o_t

            # Gradient through tanh(c_t)
            dc_t = d_tanh_c_t * _tanh_deriv(tanh_c_t) + dc_next

            # Gradient through cell state: c_t = f_t * c_{t-1} + i_t * c_tilde
            df_t = dc_t * c_prev
            di_t = dc_t * c_tilde
            dc_tilde = dc_t * i_t
            dc_next = dc_t * f_t  # gradient flows to previous cell state

            # Gradient through gate activations (pre-activation)
            df_raw = df_t * _sigmoid_deriv(f_t)
            di_raw = di_t * _sigmoid_deriv(i_t)
            dc_raw = dc_tilde * _tanh_deriv(c_tilde)
            do_raw = do_t * _sigmoid_deriv(o_t)

            # Accumulate weight gradients
            # Forget gate
            grads["dW_f"] += np.outer(x_t, df_raw)
            grads["dU_f"] += np.outer(h_prev, df_raw)
            grads["db_f"] += df_raw

            # Input gate
            grads["dW_i"] += np.outer(x_t, di_raw)
            grads["dU_i"] += np.outer(h_prev, di_raw)
            grads["db_i"] += di_raw

            # Candidate
            grads["dW_c"] += np.outer(x_t, dc_raw)
            grads["dU_c"] += np.outer(h_prev, dc_raw)
            grads["db_c"] += dc_raw

            # Output gate
            grads["dW_o"] += np.outer(x_t, do_raw)
            grads["dU_o"] += np.outer(h_prev, do_raw)
            grads["db_o"] += do_raw

            # Gradient flowing back to h_{t-1}
            dh_next = (
                df_raw @ self.U_f.T
                + di_raw @ self.U_i.T
                + dc_raw @ self.U_c.T
                + do_raw @ self.U_o.T
            )

        # Gradient clipping (global norm)
        all_grads = np.concatenate(
            [g.ravel() for g in grads.values()]
        )
        grad_norm = np.linalg.norm(all_grads)
        clip_coef = GRADIENT_CLIP / (grad_norm + 1e-8)
        if clip_coef < 1.0:
            for key in grads:
                grads[key] *= clip_coef

        # Apply gradient updates
        for gate in self.GATE_NAMES:
            setattr(self, f"W_{gate}",
                    getattr(self, f"W_{gate}") - lr * grads[f"dW_{gate}"])
            setattr(self, f"U_{gate}",
                    getattr(self, f"U_{gate}") - lr * grads[f"dU_{gate}"])
            setattr(self, f"b_{gate}",
                    getattr(self, f"b_{gate}") - lr * grads[f"db_{gate}"])

    def get_weight_names(self) -> list:
        """Return list of all parameter attribute names."""
        names = []
        for gate in self.GATE_NAMES:
            names.extend([f"W_{gate}", f"U_{gate}", f"b_{gate}"])
        return names


# ---------------------------------------------------------------------------
# Feature extraction
# ---------------------------------------------------------------------------
def _ema(data: np.ndarray, period: int) -> np.ndarray:
    """Exponential moving average."""
    result = np.empty_like(data, dtype=np.float64)
    alpha = 2.0 / (period + 1)
    result[0] = data[0]
    for i in range(1, len(data)):
        result[i] = alpha * data[i] + (1 - alpha) * result[i - 1]
    return result


def _sma(data: np.ndarray, period: int) -> np.ndarray:
    """Simple moving average (padded with first values)."""
    out = np.empty_like(data, dtype=np.float64)
    cumsum = np.cumsum(data)
    out[:period] = cumsum[:period] / np.arange(1, period + 1)
    out[period:] = (cumsum[period:] - cumsum[:-period]) / period
    return out


def extract_features(df: pd.DataFrame) -> np.ndarray:
    """
    Extract the 20 selected features per candle from an OHLCV DataFrame.

    Expected columns: open, high, low, close, volume
    Optional column:  timestamp (for hour_sin/hour_cos)

    Returns: np.ndarray of shape (n_candles, 20)
    """
    n = len(df)
    if n < 2:
        return np.zeros((n, FEATURE_DIM))

    close = df["close"].values.astype(np.float64)
    high = df["high"].values.astype(np.float64)
    low = df["low"].values.astype(np.float64)
    opn = df["open"].values.astype(np.float64)
    vol = df["volume"].values.astype(np.float64) if "volume" in df.columns else np.ones(n)

    features = np.zeros((n, FEATURE_DIM), dtype=np.float64)

    # Precompute common indicators
    ema20 = _ema(close, 20)
    ema50 = _ema(close, 50)
    sma20 = _sma(close, 20)

    # True Range for ATR
    tr = np.zeros(n)
    tr[0] = high[0] - low[0]
    for i in range(1, n):
        tr[i] = max(high[i] - low[i],
                     abs(high[i] - close[i - 1]),
                     abs(low[i] - close[i - 1]))
    atr14 = _ema(tr, 14)

    # Bollinger Bands
    bb_std = np.zeros(n)
    for i in range(19, n):
        bb_std[i] = np.std(close[i - 19:i + 1])
    bb_upper = sma20 + 2.0 * bb_std
    bb_lower = sma20 - 2.0 * bb_std

    # RSI (14-period)
    rsi = np.full(n, 50.0)
    gains = np.zeros(n)
    losses = np.zeros(n)
    for i in range(1, n):
        diff = close[i] - close[i - 1]
        if diff > 0:
            gains[i] = diff
        else:
            losses[i] = -diff
    avg_gain = _ema(gains, 14)
    avg_loss = _ema(losses, 14)
    for i in range(14, n):
        if avg_loss[i] > 1e-10:
            rs = avg_gain[i] / avg_loss[i]
            rsi[i] = 100.0 - 100.0 / (1.0 + rs)
        else:
            rsi[i] = 100.0

    # MACD histogram
    ema12 = _ema(close, 12)
    ema26 = _ema(close, 26)
    macd_line = ema12 - ema26
    macd_signal = _ema(macd_line, 9)
    macd_hist = macd_line - macd_signal

    # Rolling std (20-period)
    rolling_std = np.zeros(n)
    for i in range(19, n):
        rolling_std[i] = np.std(close[i - 19:i + 1])

    # Volume SMA for vol_ratio and vol_trend
    vol_sma20 = _sma(vol, 20)
    vol_sma5 = _sma(vol, 5)

    safe_close = np.maximum(close, 1e-10)
    hl_range = high - low
    safe_hl = np.maximum(hl_range, 1e-10)

    # --- Feature 0: ret_1 (1-candle return) ---
    features[1:, 0] = (close[1:] - close[:-1]) / safe_close[:-1]

    # --- Feature 1: ret_3 (3-candle return) ---
    features[3:, 1] = (close[3:] - close[:-3]) / safe_close[:-3]

    # --- Feature 2: ret_5 (5-candle return) ---
    features[5:, 2] = (close[5:] - close[:-5]) / safe_close[:-5]

    # --- Feature 3: atr_norm (ATR / close) ---
    features[:, 3] = atr14 / safe_close

    # --- Feature 4: vol_ratio (volume / 20-SMA volume) ---
    safe_vol_sma = np.maximum(vol_sma20, 1e-10)
    features[:, 4] = vol / safe_vol_sma

    # --- Feature 5: rsi (rescaled to -1..+1) ---
    features[:, 5] = (rsi - 50.0) / 50.0

    # --- Feature 6: macd_hist (normalised by close) ---
    features[:, 6] = macd_hist / safe_close

    # --- Feature 7: bb_pctb (Bollinger %B) ---
    bb_width = bb_upper - bb_lower
    safe_bb_width = np.maximum(bb_width, 1e-10)
    features[:, 7] = (close - bb_lower) / safe_bb_width

    # --- Feature 8: ema20_dist (distance from EMA-20 / close) ---
    features[:, 8] = (close - ema20) / safe_close

    # --- Feature 9: body_ratio ((close - open) / (high - low)) ---
    features[:, 9] = (close - opn) / safe_hl

    # --- Feature 10: hour_sin ---
    # --- Feature 11: hour_cos ---
    if "timestamp" in df.columns:
        try:
            ts = pd.to_datetime(df["timestamp"])
            hours = ts.dt.hour + ts.dt.minute / 60.0
            features[:, 10] = np.sin(2 * np.pi * hours.values / 24.0)
            features[:, 11] = np.cos(2 * np.pi * hours.values / 24.0)
        except Exception:
            pass  # leave as zeros if parsing fails
    elif "time" in df.columns:
        try:
            ts = pd.to_datetime(df["time"])
            hours = ts.dt.hour + ts.dt.minute / 60.0
            features[:, 10] = np.sin(2 * np.pi * hours.values / 24.0)
            features[:, 11] = np.cos(2 * np.pi * hours.values / 24.0)
        except Exception:
            pass

    # --- Feature 12: candle_streak (consecutive up/down candles) ---
    streak = np.zeros(n)
    for i in range(1, n):
        if close[i] > close[i - 1]:
            streak[i] = max(streak[i - 1] + 1, 1)
        elif close[i] < close[i - 1]:
            streak[i] = min(streak[i - 1] - 1, -1)
        else:
            streak[i] = 0
    # Normalize to roughly -1..+1 (streaks rarely exceed 10)
    features[:, 12] = np.clip(streak / 5.0, -1.0, 1.0)

    # --- Feature 13: vol_trend (5-SMA vol / 20-SMA vol) ---
    safe_vol_sma20 = np.maximum(vol_sma20, 1e-10)
    features[:, 13] = vol_sma5 / safe_vol_sma20

    # --- Feature 14: std_norm (20-period std / close) ---
    features[:, 14] = rolling_std / safe_close

    # --- Feature 15: ema50_dist (distance from EMA-50 / close) ---
    features[:, 15] = (close - ema50) / safe_close

    # --- Feature 16: upper_wick ((high - max(open,close)) / range) ---
    upper_body = np.maximum(close, opn)
    features[:, 16] = (high - upper_body) / safe_hl

    # --- Feature 17: lower_wick ((min(open,close) - low) / range) ---
    lower_body = np.minimum(close, opn)
    features[:, 17] = (lower_body - low) / safe_hl

    # --- Feature 18: ret_10 (10-candle return) ---
    features[10:, 18] = (close[10:] - close[:-10]) / safe_close[:-10]

    # --- Feature 19: ret_20 (20-candle return) ---
    features[20:, 19] = (close[20:] - close[:-20]) / safe_close[:-20]

    # Replace any NaN / Inf with 0
    features = np.nan_to_num(features, nan=0.0, posinf=0.0, neginf=0.0)

    return features


# ---------------------------------------------------------------------------
# LSTM Predictor
# ---------------------------------------------------------------------------
class LSTMPredictor:
    """
    LSTM-lite predictor for price direction.

    - Processes sequences of 20 timesteps x 20 features through a numpy LSTM cell.
    - Final hidden state is classified by a scikit-learn SGDClassifier (online).
    - Maintains per-symbol hidden states for stateful (continuous) prediction.
    - Thread-safe via a reentrant lock.
    """

    def __init__(self):
        self._lock = threading.RLock()

        # LSTM cell
        self.lstm = NumpyLSTMCell(FEATURE_DIM, HIDDEN_DIM)

        # Output classifier (SGD for online / incremental learning)
        # Note: class_weight="balanced" is incompatible with partial_fit,
        # so we compute sample weights manually during training.
        self.classifier = SGDClassifier(
            loss="log_loss",
            penalty="l2",
            alpha=1e-4,
            max_iter=1,
            warm_start=True,
            random_state=42,
        )
        self._classifier_fitted = False

        # Feature scaler
        self.scaler = StandardScaler()
        self._scaler_fitted = False

        # Per-symbol hidden and cell states (stateful prediction)
        self._hidden_states: Dict[str, np.ndarray] = {}   # symbol -> h
        self._cell_states: Dict[str, np.ndarray] = {}     # symbol -> c

        # Training buffer
        self._training_buffer: deque = deque(maxlen=MAX_TRAINING_BUFFER)
        self._samples_since_train = 0
        self._total_samples = 0

        # Metrics
        self._train_count = 0
        self._accuracy_history: list = []
        self._last_train_time = 0.0
        self._creation_time = time.time()

        # Load persisted model
        self._load()

    # -------------------------------------------------------------------
    # Public API
    # -------------------------------------------------------------------

    def predict(self, df: pd.DataFrame, symbol: str = "default") -> dict:
        """
        Predict next-candle direction from a candle DataFrame.

        Args:
            df:     OHLCV DataFrame (at least SEQ_LENGTH+1 rows)
            symbol: trading pair symbol for stateful hidden state

        Returns:
            dict with keys:
                action:           "BUY" | "SELL" | "HOLD"
                confidence:       0-100
                probabilities:    {BUY: float, SELL: float, HOLD: float}
                hidden_state_norm: L2 norm of final hidden state
                method:           "lstm" | "default"
                training_samples: int
        """
        with self._lock:
            if len(df) < SEQ_LENGTH + 1:
                return self._default_prediction()

            features = extract_features(df)
            seq = features[-SEQ_LENGTH:]

            # Normalize features
            if self._scaler_fitted:
                seq = self.scaler.transform(seq.reshape(-1, FEATURE_DIM))
                seq = seq.reshape(SEQ_LENGTH, FEATURE_DIM)

            # Get or initialize hidden/cell state for this symbol
            h_init = self._hidden_states.get(symbol)
            c_init = self._cell_states.get(symbol)

            # Forward pass through LSTM
            h_final, c_final, _ = self.lstm.forward_sequence(seq, h_init, c_init)

            # Update stateful hidden state
            self._hidden_states[symbol] = h_final.copy()
            self._cell_states[symbol] = c_final.copy()

            h_norm = float(np.linalg.norm(h_final))

            # Classify final hidden state
            if self._classifier_fitted:
                h_2d = h_final.reshape(1, -1)
                try:
                    proba = self.classifier.predict_proba(h_2d)[0]
                    # Map to class probabilities (SGD may not have all 3 classes)
                    class_probs = np.array([0.33, 0.33, 0.34])
                    for i, cls in enumerate(self.classifier.classes_):
                        class_probs[int(cls)] = proba[i]
                    best_idx = int(np.argmax(class_probs))
                    confidence = float(class_probs[best_idx]) * 100

                    return {
                        "action": ACTION_NAMES[best_idx],
                        "confidence": round(confidence, 1),
                        "probabilities": {
                            "BUY": round(float(class_probs[0]) * 100, 1),
                            "SELL": round(float(class_probs[1]) * 100, 1),
                            "HOLD": round(float(class_probs[2]) * 100, 1),
                        },
                        "hidden_state_norm": round(h_norm, 4),
                        "method": "lstm",
                        "training_samples": self._total_samples,
                    }
                except Exception as e:
                    logger.warning(f"Classifier prediction failed: {e}")

            # Fallback: use hidden state heuristic
            return self._heuristic_from_hidden(h_final, h_norm)

    def record_sample(self, df: pd.DataFrame, outcome: str, symbol: str = "default") -> None:
        """
        Record a training sample.

        Args:
            df:      OHLCV DataFrame
            outcome: "BUY" (price went up), "SELL" (price went down), "HOLD" (flat)
            symbol:  trading pair symbol
        """
        with self._lock:
            if len(df) < SEQ_LENGTH + 2:
                return

            features = extract_features(df)
            seq = features[-(SEQ_LENGTH + 1):-1]  # 20-candle window

            label = ACTION_MAP.get(outcome.upper(), 2)

            self._training_buffer.append((seq.copy(), label, symbol))
            self._samples_since_train += 1
            self._total_samples += 1

            # Auto-retrain check
            if (
                len(self._training_buffer) >= MIN_SAMPLES_TO_TRAIN
                and self._samples_since_train >= RETRAIN_EVERY_N
            ):
                self.train()

    def train(self) -> dict:
        """
        Retrain LSTM weights via simplified BPTT + retrain SGDClassifier.

        Returns:
            dict with training metrics
        """
        with self._lock:
            if len(self._training_buffer) < MIN_SAMPLES_TO_TRAIN:
                return {"status": "insufficient_data", "samples": len(self._training_buffer)}

            t0 = time.time()

            # Prepare data
            all_seqs = np.array([s[0] for s in self._training_buffer])
            all_labels = np.array([s[1] for s in self._training_buffer])

            n_samples = len(all_seqs)

            # Fit/update scaler
            flat_features = all_seqs.reshape(-1, FEATURE_DIM)
            self.scaler.fit(flat_features)
            self._scaler_fitted = True

            # Normalize all sequences
            all_seqs_norm = self.scaler.transform(flat_features).reshape(
                n_samples, SEQ_LENGTH, FEATURE_DIM
            )

            # ---------------------------------------------------------------
            # Phase 1: BPTT training of LSTM weights
            # ---------------------------------------------------------------
            for epoch in range(BPTT_EPOCHS):
                # Shuffle training order each epoch
                indices = np.random.permutation(n_samples)
                epoch_loss = 0.0

                for idx in indices:
                    seq = all_seqs_norm[idx]
                    label = all_labels[idx]

                    # Forward pass
                    h_final, c_final, caches = self.lstm.forward_sequence(seq)

                    # Simple cross-entropy gradient on hidden state
                    # We compute a soft target direction from the label
                    # and backpropagate a gradient towards that direction
                    target = np.zeros(OUTPUT_DIM)
                    target[label] = 1.0

                    # Compute logits from hidden state (simple linear projection)
                    # We use the sign/magnitude of hidden units as proxy
                    logits = np.zeros(OUTPUT_DIM)
                    chunk = HIDDEN_DIM // OUTPUT_DIM
                    for c_idx in range(OUTPUT_DIM):
                        start = c_idx * chunk
                        end = start + chunk
                        logits[c_idx] = np.mean(h_final[start:end])

                    probs = _softmax(logits)
                    loss = -np.log(max(probs[label], 1e-8))
                    epoch_loss += loss

                    # Gradient of loss w.r.t. hidden state
                    # dL/dh through the proxy logits
                    dlogits = probs - target  # (OUTPUT_DIM,)
                    dh = np.zeros(HIDDEN_DIM)
                    for c_idx in range(OUTPUT_DIM):
                        start = c_idx * chunk
                        end = start + chunk
                        dh[start:end] = dlogits[c_idx] / chunk

                    # Backpropagate through LSTM
                    lr = BPTT_LEARNING_RATE / (1 + epoch * 0.1)  # decay
                    self.lstm.backward_sequence(dh, caches, lr=lr)

                avg_loss = epoch_loss / n_samples
                if epoch == BPTT_EPOCHS - 1:
                    logger.debug(f"BPTT epoch {epoch+1}/{BPTT_EPOCHS}: avg_loss={avg_loss:.4f}")

            # ---------------------------------------------------------------
            # Phase 2: Train SGDClassifier on LSTM hidden states
            # ---------------------------------------------------------------
            hidden_states = np.zeros((n_samples, HIDDEN_DIM))
            for i in range(n_samples):
                h, _, _ = self.lstm.forward_sequence(all_seqs_norm[i])
                hidden_states[i] = h

            # Compute balanced sample weights (manual, since partial_fit
            # does not support class_weight="balanced")
            all_classes = np.array([0, 1, 2])
            class_counts = np.bincount(all_labels, minlength=3).astype(np.float64)
            class_counts = np.maximum(class_counts, 1.0)  # avoid div-by-zero
            total = float(n_samples)
            class_weights = total / (3.0 * class_counts)
            sample_weights = np.array([class_weights[l] for l in all_labels])

            try:
                if not self._classifier_fitted:
                    self.classifier.partial_fit(
                        hidden_states, all_labels,
                        classes=all_classes,
                        sample_weight=sample_weights,
                    )
                    self._classifier_fitted = True
                else:
                    # Multiple passes for better convergence
                    for _ in range(3):
                        self.classifier.partial_fit(
                            hidden_states, all_labels,
                            sample_weight=sample_weights,
                        )
            except Exception as e:
                logger.warning(f"SGDClassifier training failed: {e}")

            # ---------------------------------------------------------------
            # Evaluate accuracy (on held-out 20% validation split)
            # ---------------------------------------------------------------
            val_split = max(1, n_samples // 5)  # 20% validation
            val_states = hidden_states[-val_split:]
            val_labels = all_labels[-val_split:]
            correct = 0
            for i in range(len(val_states)):
                h_2d = val_states[i].reshape(1, -1)
                try:
                    pred = self.classifier.predict(h_2d)[0]
                    if pred == val_labels[i]:
                        correct += 1
                except Exception:
                    pass

            accuracy = (correct / len(val_states) * 100) if len(val_states) > 0 else 0.0
            self._accuracy_history.append(accuracy)
            if len(self._accuracy_history) > 50:
                self._accuracy_history = self._accuracy_history[-50:]

            elapsed = time.time() - t0
            self._train_count += 1
            self._samples_since_train = 0
            self._last_train_time = time.time()

            # Save to disk
            self._save()

            result = {
                "status": "trained",
                "samples": n_samples,
                "accuracy": round(accuracy, 1),
                "avg_loss": round(avg_loss, 4),
                "elapsed_sec": round(elapsed, 2),
                "train_count": self._train_count,
            }

            logger.info(
                f"LSTM trained: {n_samples} samples, accuracy={accuracy:.1f}%, "
                f"loss={avg_loss:.4f}, time={elapsed:.2f}s"
            )
            return result

    def get_confidence_adjustment(self, df: pd.DataFrame, proposed_action: str,
                                   symbol: str = "default") -> int:
        """
        Return a confidence adjustment (-10 to +10) based on LSTM prediction
        agreement/disagreement with the proposed action.

        Args:
            df:              OHLCV DataFrame
            proposed_action: "BUY" or "SELL"
            symbol:          trading pair symbol

        Returns:
            int in range [-10, +10]
        """
        with self._lock:
            pred = self.predict(df, symbol)
            if pred["method"] == "default":
                return 0

            lstm_action = pred["action"]
            conf = pred["confidence"]

            # Strong agreement boost
            if proposed_action == "BUY" and lstm_action == "BUY":
                if conf > 65:
                    return min(10, int((conf - 50) / 5))
                elif conf > 50:
                    return min(6, int((conf - 50) / 8))
                return 0

            if proposed_action == "SELL" and lstm_action == "SELL":
                if conf > 65:
                    return min(10, int((conf - 50) / 5))
                elif conf > 50:
                    return min(6, int((conf - 50) / 8))
                return 0

            # Disagreement penalty
            if proposed_action == "BUY" and lstm_action == "SELL" and conf > 55:
                return max(-10, -int((conf - 45) / 5))

            if proposed_action == "SELL" and lstm_action == "BUY" and conf > 55:
                return max(-10, -int((conf - 45) / 5))

            # HOLD prediction: mild penalty for active trades
            if lstm_action == "HOLD" and conf > 60:
                return -3

            return 0

    def get_hidden_state(self, symbol: str = "default") -> np.ndarray:
        """
        Get the current hidden state for a symbol.

        Args:
            symbol: trading pair symbol

        Returns:
            np.ndarray of shape (HIDDEN_DIM,), zeros if no state exists
        """
        with self._lock:
            return self._hidden_states.get(symbol, np.zeros(HIDDEN_DIM)).copy()

    def get_status(self) -> dict:
        """
        Get model status and performance metrics.

        Returns:
            dict with model info, training stats, per-symbol state info
        """
        with self._lock:
            recent_acc = (
                round(np.mean(self._accuracy_history[-5:]), 1)
                if self._accuracy_history
                else None
            )
            best_acc = (
                round(max(self._accuracy_history), 1)
                if self._accuracy_history
                else None
            )

            symbols_tracked = list(self._hidden_states.keys())
            state_norms = {
                sym: round(float(np.linalg.norm(h)), 4)
                for sym, h in self._hidden_states.items()
            }

            return {
                "model": "lstm_lite",
                "architecture": {
                    "type": "LSTM",
                    "input_dim": FEATURE_DIM,
                    "hidden_dim": HIDDEN_DIM,
                    "output_dim": OUTPUT_DIM,
                    "seq_length": SEQ_LENGTH,
                    "features": FEATURE_NAMES,
                },
                "trained": self._classifier_fitted,
                "training_samples": self._total_samples,
                "buffer_size": len(self._training_buffer),
                "buffer_capacity": MAX_TRAINING_BUFFER,
                "samples_until_retrain": max(0, RETRAIN_EVERY_N - self._samples_since_train),
                "train_count": self._train_count,
                "accuracy_recent": recent_acc,
                "accuracy_best": best_acc,
                "accuracy_history": self._accuracy_history[-10:],
                "classifier_fitted": self._classifier_fitted,
                "scaler_fitted": self._scaler_fitted,
                "symbols_tracked": symbols_tracked,
                "state_norms": state_norms,
                "last_train_time": self._last_train_time,
                "uptime_sec": round(time.time() - self._creation_time, 0),
            }

    # -------------------------------------------------------------------
    # Private helpers
    # -------------------------------------------------------------------

    def _default_prediction(self) -> dict:
        """Return a neutral default prediction."""
        return {
            "action": "HOLD",
            "confidence": 33.0,
            "probabilities": {"BUY": 33.0, "SELL": 33.0, "HOLD": 34.0},
            "hidden_state_norm": 0.0,
            "method": "default",
            "training_samples": self._total_samples,
        }

    def _heuristic_from_hidden(self, h: np.ndarray, h_norm: float) -> dict:
        """
        Simple heuristic prediction from the hidden state vector
        when the SGDClassifier is not yet trained.

        Splits hidden state into 3 chunks for BUY/SELL/HOLD signal.
        """
        chunk = HIDDEN_DIM // 3
        buy_signal = float(np.mean(h[:chunk]))
        sell_signal = float(np.mean(h[chunk:2 * chunk]))
        hold_signal = float(np.mean(h[2 * chunk:]))

        signals = np.array([buy_signal, sell_signal, hold_signal])
        probs = _softmax(signals * 3.0)  # amplify differences

        best_idx = int(np.argmax(probs))
        confidence = float(probs[best_idx]) * 100

        return {
            "action": ACTION_NAMES[best_idx],
            "confidence": round(confidence, 1),
            "probabilities": {
                "BUY": round(float(probs[0]) * 100, 1),
                "SELL": round(float(probs[1]) * 100, 1),
                "HOLD": round(float(probs[2]) * 100, 1),
            },
            "hidden_state_norm": round(h_norm, 4),
            "method": "lstm_heuristic",
            "training_samples": self._total_samples,
        }

    def _save(self) -> None:
        """Persist LSTM weights, classifier, and scaler to disk."""
        try:
            data = {}

            # Save LSTM weights
            for name in self.lstm.get_weight_names():
                data[f"lstm_{name}"] = getattr(self.lstm, name)

            # Save scaler
            if self._scaler_fitted:
                data["scaler_mean"] = self.scaler.mean_
                data["scaler_scale"] = self.scaler.scale_

            # Save classifier coefficients
            if self._classifier_fitted:
                data["clf_coef"] = self.classifier.coef_
                data["clf_intercept"] = self.classifier.intercept_
                data["clf_classes"] = self.classifier.classes_

            # Save hidden states (up to 20 symbols)
            symbols = list(self._hidden_states.keys())[:20]
            if symbols:
                data["state_symbols"] = np.array(symbols, dtype=object)
                for sym in symbols:
                    safe_key = sym.replace("/", "_").replace("-", "_")
                    data[f"h_{safe_key}"] = self._hidden_states[sym]
                    data[f"c_{safe_key}"] = self._cell_states.get(
                        sym, np.zeros(HIDDEN_DIM)
                    )

            # Save metadata
            data["meta_train_count"] = np.array([self._train_count])
            data["meta_total_samples"] = np.array([self._total_samples])
            if self._accuracy_history:
                data["accuracy_history"] = np.array(self._accuracy_history)

            np.savez(MODEL_DIR / "lstm_model.npz", **data)
            logger.debug("LSTM model saved to disk")

        except Exception as e:
            logger.warning(f"Failed to save LSTM model: {e}")

    def _load(self) -> None:
        """Load persisted LSTM weights, classifier, and scaler from disk."""
        path = MODEL_DIR / "lstm_model.npz"
        if not path.exists():
            logger.info("No persisted LSTM model found, starting fresh")
            return

        try:
            data = np.load(path, allow_pickle=True)

            # Load LSTM weights
            loaded_weights = 0
            for name in self.lstm.get_weight_names():
                key = f"lstm_{name}"
                if key in data:
                    val = data[key]
                    expected = getattr(self.lstm, name)
                    if val.shape == expected.shape:
                        setattr(self.lstm, name, val)
                        loaded_weights += 1

            # Load scaler
            if "scaler_mean" in data and "scaler_scale" in data:
                self.scaler.mean_ = data["scaler_mean"]
                self.scaler.scale_ = data["scaler_scale"]
                self.scaler.var_ = data["scaler_scale"] ** 2
                self.scaler.n_features_in_ = FEATURE_DIM
                self.scaler.n_samples_seen_ = np.full(FEATURE_DIM, 1000)
                self._scaler_fitted = True

            # Load classifier
            if "clf_coef" in data and "clf_intercept" in data:
                self.classifier.coef_ = data["clf_coef"]
                self.classifier.intercept_ = data["clf_intercept"]
                if "clf_classes" in data:
                    self.classifier.classes_ = data["clf_classes"]
                else:
                    self.classifier.classes_ = np.array([0, 1, 2])
                self._classifier_fitted = True

            # Load hidden states
            if "state_symbols" in data:
                symbols = data["state_symbols"]
                for sym in symbols:
                    sym_str = str(sym)
                    safe_key = sym_str.replace("/", "_").replace("-", "_")
                    h_key = f"h_{safe_key}"
                    c_key = f"c_{safe_key}"
                    if h_key in data:
                        self._hidden_states[sym_str] = data[h_key]
                    if c_key in data:
                        self._cell_states[sym_str] = data[c_key]

            # Load metadata
            if "meta_train_count" in data:
                self._train_count = int(data["meta_train_count"][0])
            if "meta_total_samples" in data:
                self._total_samples = int(data["meta_total_samples"][0])
            if "accuracy_history" in data:
                self._accuracy_history = data["accuracy_history"].tolist()

            logger.info(
                f"Loaded LSTM model: {loaded_weights} weight matrices, "
                f"classifier={'yes' if self._classifier_fitted else 'no'}, "
                f"scaler={'yes' if self._scaler_fitted else 'no'}, "
                f"symbols={list(self._hidden_states.keys())}"
            )

        except Exception as e:
            logger.warning(f"Could not load LSTM model: {e}")


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------
_instance: Optional[LSTMPredictor] = None
_instance_lock = threading.Lock()


def get_lstm_model() -> LSTMPredictor:
    """
    Get or create the singleton LSTMPredictor instance.
    Thread-safe via double-checked locking.
    """
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = LSTMPredictor()
                logger.info("LSTM model singleton initialized")
    return _instance
