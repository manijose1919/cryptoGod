"""
Sequence Model for Price Direction Prediction

Uses a GRU-like recurrent architecture (numpy only, no PyTorch needed).
Processes sequences of candle features to predict next-candle direction.
Trained online as new data arrives.
"""

import logging
import time
from pathlib import Path
from typing import Optional
from collections import deque

import numpy as np
from sklearn.preprocessing import StandardScaler

logger = logging.getLogger("sequence_model")

MODEL_DIR = Path(__file__).parent.parent / "models"
MODEL_DIR.mkdir(exist_ok=True)

# Configuration
SEQ_LENGTH = 20          # Look back 20 candles
FEATURE_DIM = 8          # Features per candle: ret, vol_ratio, rsi_proxy, range, body, ema_diff, volume_ma_ratio, momentum
HIDDEN_DIM = 32          # GRU hidden state size
OUTPUT_DIM = 3           # UP, FLAT, DOWN


def _sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -10, 10)))


def _tanh(x):
    return np.tanh(np.clip(x, -10, 10))


def _softmax(x):
    e = np.exp(x - np.max(x))
    return e / e.sum()


class NumpyGRU:
    """Minimal GRU cell + output layer implemented in numpy."""

    def __init__(self, input_dim: int, hidden_dim: int, output_dim: int):
        scale_ih = np.sqrt(2.0 / (input_dim + hidden_dim))
        scale_hh = np.sqrt(2.0 / hidden_dim)

        # GRU gates: z (update), r (reset), n (new)
        self.W_z = np.random.randn(input_dim, hidden_dim) * scale_ih
        self.U_z = np.random.randn(hidden_dim, hidden_dim) * scale_hh
        self.b_z = np.zeros(hidden_dim)

        self.W_r = np.random.randn(input_dim, hidden_dim) * scale_ih
        self.U_r = np.random.randn(hidden_dim, hidden_dim) * scale_hh
        self.b_r = np.zeros(hidden_dim)

        self.W_n = np.random.randn(input_dim, hidden_dim) * scale_ih
        self.U_n = np.random.randn(hidden_dim, hidden_dim) * scale_hh
        self.b_n = np.zeros(hidden_dim)

        # Output layer
        self.W_out = np.random.randn(hidden_dim, output_dim) * np.sqrt(2.0 / hidden_dim)
        self.b_out = np.zeros(output_dim)

    def forward_sequence(self, x_seq: np.ndarray) -> np.ndarray:
        """Process a sequence and return output probabilities.

        Args:
            x_seq: shape (seq_len, feature_dim)
        Returns:
            probabilities: shape (output_dim,)
        """
        h = np.zeros(self.W_z.shape[1])  # hidden state

        for t in range(x_seq.shape[0]):
            x = x_seq[t]
            z = _sigmoid(x @ self.W_z + h @ self.U_z + self.b_z)
            r = _sigmoid(x @ self.W_r + h @ self.U_r + self.b_r)
            n = _tanh(x @ self.W_n + (r * h) @ self.U_n + self.b_n)
            h = (1 - z) * n + z * h

        logits = h @ self.W_out + self.b_out
        return _softmax(logits)


class SequencePredictor:
    """Predicts next-candle direction from a sequence of candle features."""

    MIN_SAMPLES = 50
    RETRAIN_INTERVAL = 30
    MAX_SAMPLES = 5000

    def __init__(self):
        self.gru = NumpyGRU(FEATURE_DIM, HIDDEN_DIM, OUTPUT_DIM)
        self.scaler = StandardScaler()
        self._sequences: list = []  # (seq, label)
        self._samples_since_train = 0
        self._trained = False
        self._accuracy_history: list = []
        self._load()

    def extract_features(self, df) -> np.ndarray:
        """Extract per-candle features from DataFrame.

        Returns: shape (n_candles, FEATURE_DIM) array
        """
        close = df["close"].values.astype(float)
        high = df["high"].values.astype(float)
        low = df["low"].values.astype(float)
        opn = df["open"].values.astype(float)
        vol = df["volume"].values.astype(float)

        n = len(close)
        features = np.zeros((n, FEATURE_DIM))

        # 1. Returns
        features[1:, 0] = np.diff(close) / close[:-1]

        # 2. Volume ratio (vs 20-period MA)
        vol_ma = np.convolve(vol, np.ones(20) / 20, mode="same")
        vol_ma[vol_ma == 0] = 1
        features[:, 1] = vol / vol_ma

        # 3. RSI proxy (up-moves vs total moves in 14-period window)
        for i in range(14, n):
            gains = sum(max(0, close[j] - close[j - 1]) for j in range(i - 13, i + 1))
            losses = sum(max(0, close[j - 1] - close[j]) for j in range(i - 13, i + 1))
            total = gains + losses
            features[i, 2] = (gains / total - 0.5) * 2 if total > 0 else 0

        # 4. Candle range (high-low) / close
        features[:, 3] = (high - low) / np.maximum(close, 1e-8)

        # 5. Body ratio (close-open) / (high-low)
        hl = high - low
        hl[hl == 0] = 1e-8
        features[:, 4] = (close - opn) / hl

        # 6. EMA diff (fast - slow) / close
        ema5 = self._ema(close, 5)
        ema20 = self._ema(close, 20)
        features[:, 5] = (ema5 - ema20) / np.maximum(close, 1e-8)

        # 7. Volume MA ratio (5-period vs 20-period)
        vol_ma5 = self._ema(vol, 5)
        vol_ma20 = self._ema(vol, 20)
        vol_ma20[vol_ma20 == 0] = 1
        features[:, 6] = vol_ma5 / vol_ma20

        # 8. Momentum (5-period rate of change)
        features[5:, 7] = (close[5:] - close[:-5]) / np.maximum(close[:-5], 1e-8)

        return features

    @staticmethod
    def _ema(data: np.ndarray, period: int) -> np.ndarray:
        result = np.zeros_like(data)
        alpha = 2.0 / (period + 1)
        result[0] = data[0]
        for i in range(1, len(data)):
            result[i] = alpha * data[i] + (1 - alpha) * result[i - 1]
        return result

    def record_sequence(self, df):
        """Record a training sample from candle DataFrame."""
        if len(df) < SEQ_LENGTH + 2:
            return

        features = self.extract_features(df)

        # Use second-to-last as sequence, last candle's direction as label
        seq = features[-(SEQ_LENGTH + 1):-1]  # 20 candles
        last_ret = features[-1, 0]  # Return of final candle

        if last_ret > 0.001:
            label = 0  # UP
        elif last_ret < -0.001:
            label = 2  # DOWN
        else:
            label = 1  # FLAT

        self._sequences.append((seq, label))

        # Cap stored sequences
        if len(self._sequences) > self.MAX_SAMPLES:
            self._sequences = self._sequences[-self.MAX_SAMPLES:]

        self._samples_since_train += 1

        # Auto-retrain
        if len(self._sequences) >= self.MIN_SAMPLES and self._samples_since_train >= self.RETRAIN_INTERVAL:
            self._train()

    def predict(self, df) -> dict:
        """Predict next candle direction.

        Returns: {direction: "UP"|"FLAT"|"DOWN", confidence: 0-100, probabilities: {...}}
        """
        if not self._trained or len(df) < SEQ_LENGTH + 1:
            return {"direction": "FLAT", "confidence": 33, "probabilities": {"UP": 33, "FLAT": 34, "DOWN": 33}, "method": "default"}

        features = self.extract_features(df)
        seq = features[-SEQ_LENGTH:]

        # Normalize
        if hasattr(self.scaler, "mean_") and self.scaler.mean_ is not None:
            seq_flat = seq.reshape(-1, FEATURE_DIM)
            seq_flat = self.scaler.transform(seq_flat)
            seq = seq_flat.reshape(SEQ_LENGTH, FEATURE_DIM)

        probs = self.gru.forward_sequence(seq)
        directions = ["UP", "FLAT", "DOWN"]
        best_idx = int(np.argmax(probs))

        return {
            "direction": directions[best_idx],
            "confidence": round(float(probs[best_idx]) * 100, 1),
            "probabilities": {d: round(float(probs[i]) * 100, 1) for i, d in enumerate(directions)},
            "method": "gru",
            "training_samples": len(self._sequences),
        }

    def get_confidence_adjustment(self, df, proposed_action: str) -> int:
        """Return confidence adjustment based on sequence prediction.

        If sequence model agrees with proposed action direction, boost confidence.
        """
        pred = self.predict(df)
        if pred["method"] == "default":
            return 0

        direction = pred["direction"]
        conf = pred["confidence"]

        # Map direction to action agreement
        if proposed_action == "BUY" and direction == "UP" and conf > 50:
            return min(8, int((conf - 50) / 6))
        elif proposed_action == "SELL" and direction == "DOWN" and conf > 50:
            return min(8, int((conf - 50) / 6))
        elif proposed_action == "BUY" and direction == "DOWN" and conf > 60:
            return -5
        elif proposed_action == "SELL" and direction == "UP" and conf > 60:
            return -5
        return 0

    def _train(self):
        """Train the GRU via simple evolution strategy (no backprop through time).

        Uses a population-based approach: perturb weights, evaluate, keep best.
        """
        if len(self._sequences) < self.MIN_SAMPLES:
            return

        # Prepare data
        all_seqs = np.array([s[0] for s in self._sequences])
        all_labels = np.array([s[1] for s in self._sequences])

        # Fit scaler on all feature data
        flat = all_seqs.reshape(-1, FEATURE_DIM)
        self.scaler.fit(flat)
        all_seqs_norm = self.scaler.transform(flat).reshape(-1, SEQ_LENGTH, FEATURE_DIM)

        # Simple evolution: try random perturbations, keep improvements
        best_loss = self._evaluate(all_seqs_norm, all_labels)

        n_iterations = 20
        noise_scale = 0.02

        for _ in range(n_iterations):
            # Save current weights
            saved = self._save_weights()

            # Perturb
            self._perturb_weights(noise_scale)

            # Evaluate
            loss = self._evaluate(all_seqs_norm, all_labels)

            if loss < best_loss:
                best_loss = loss
            else:
                # Revert
                self._restore_weights(saved)

        self._trained = True
        self._samples_since_train = 0

        # Calculate accuracy
        correct = 0
        for seq, label in zip(all_seqs_norm, all_labels):
            probs = self.gru.forward_sequence(seq)
            if np.argmax(probs) == label:
                correct += 1
        accuracy = correct / len(all_labels) * 100
        self._accuracy_history.append(accuracy)

        logger.info(f"Sequence model trained: {len(self._sequences)} samples, accuracy={accuracy:.1f}%, loss={best_loss:.4f}")
        self._save_model()

    def _evaluate(self, seqs: np.ndarray, labels: np.ndarray) -> float:
        """Cross-entropy loss on dataset."""
        total_loss = 0.0
        for i in range(len(seqs)):
            probs = self.gru.forward_sequence(seqs[i])
            # Cross-entropy: -log(prob of correct class)
            total_loss -= np.log(max(probs[labels[i]], 1e-8))
        return total_loss / len(seqs)

    def _perturb_weights(self, scale: float):
        for attr in ["W_z", "U_z", "b_z", "W_r", "U_r", "b_r",
                      "W_n", "U_n", "b_n", "W_out", "b_out"]:
            w = getattr(self.gru, attr)
            w += np.random.randn(*w.shape) * scale

    def _save_weights(self) -> dict:
        return {attr: getattr(self.gru, attr).copy()
                for attr in ["W_z", "U_z", "b_z", "W_r", "U_r", "b_r",
                              "W_n", "U_n", "b_n", "W_out", "b_out"]}

    def _restore_weights(self, saved: dict):
        for attr, val in saved.items():
            setattr(self.gru, attr, val)

    def _save_model(self):
        try:
            data = {}
            for attr in ["W_z", "U_z", "b_z", "W_r", "U_r", "b_r",
                          "W_n", "U_n", "b_n", "W_out", "b_out"]:
                data[attr] = getattr(self.gru, attr)
            if hasattr(self.scaler, "mean_") and self.scaler.mean_ is not None:
                data["scaler_mean"] = self.scaler.mean_
                data["scaler_scale"] = self.scaler.scale_
            np.savez(MODEL_DIR / "sequence_model.npz", **data)
        except Exception as e:
            logger.warning(f"Failed to save sequence model: {e}")

    def _load(self):
        path = MODEL_DIR / "sequence_model.npz"
        if not path.exists():
            return
        try:
            data = np.load(path)
            for attr in ["W_z", "U_z", "b_z", "W_r", "U_r", "b_r",
                          "W_n", "U_n", "b_n", "W_out", "b_out"]:
                if attr in data:
                    setattr(self.gru, attr, data[attr])
            if "scaler_mean" in data:
                self.scaler.mean_ = data["scaler_mean"]
                self.scaler.scale_ = data["scaler_scale"]
                self.scaler.var_ = data["scaler_scale"] ** 2
                self.scaler.n_features_in_ = FEATURE_DIM
            self._trained = True
            logger.info("Loaded sequence model")
        except Exception as e:
            logger.warning(f"Could not load sequence model: {e}")

    def get_status(self) -> dict:
        return {
            "trained": self._trained,
            "training_samples": len(self._sequences),
            "accuracy": round(self._accuracy_history[-1], 1) if self._accuracy_history else None,
            "seq_length": SEQ_LENGTH,
            "feature_dim": FEATURE_DIM,
        }


# Singleton
_instance: Optional[SequencePredictor] = None


def get_sequence_predictor() -> SequencePredictor:
    global _instance
    if _instance is None:
        _instance = SequencePredictor()
    return _instance
