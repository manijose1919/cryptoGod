"""
Transformer-Lite Trading Signal Model

Lightweight Transformer architecture for sequence prediction on trading data.
Uses numpy for self-attention computation and scikit-learn MLPClassifier as the
feed-forward classification head on top of attention-pooled representations.

Architecture:
  - Sinusoidal positional encoding
  - Multi-head self-attention (4 heads) implemented from scratch in numpy
  - Layer normalization
  - Residual connections
  - 2-layer Transformer encoder (attention + feed-forward sublayers)
  - Scikit-learn MLPClassifier on pooled attention output
  - Input: sequence of 20 feature vectors (109 features each)
  - Output: action (BUY/SELL/HOLD) + confidence (0-100)

Designed for KVM8 (8 vCPU, 32GB RAM) — runs comfortably without GPU.
"""

import logging
import threading
import time
from collections import deque
from pathlib import Path
from typing import Optional

import numpy as np
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

logger = logging.getLogger("transformer_model")

MODEL_DIR = Path(__file__).parent.parent / "models"
MODEL_DIR.mkdir(exist_ok=True)

# ──────────────────────────── Configuration ────────────────────────────

SEQ_LENGTH = 20            # Look-back window: 20 candles
FEATURE_DIM = 109          # Features per candle (from upstream feature pipeline)
NUM_HEADS = 4              # Multi-head attention heads
D_MODEL = 112              # Internal model dimension (must be divisible by NUM_HEADS; >= FEATURE_DIM)
D_HEAD = D_MODEL // NUM_HEADS  # 28 per head
D_FF = 128                 # Feed-forward hidden dimension inside transformer block
NUM_LAYERS = 2             # Number of stacked transformer encoder layers
OUTPUT_CLASSES = 3          # BUY, SELL, HOLD

MAX_BUFFER_SIZE = 2000     # Maximum training sequences held in memory
MIN_SAMPLES_TO_TRAIN = 100 # Minimum new samples before retraining
RETRAIN_THRESHOLD = 100    # New samples needed to trigger auto-retrain

ACTION_MAP = {"BUY": 0, "SELL": 1, "HOLD": 2}
ACTION_NAMES = {0: "BUY", 1: "SELL", 2: "HOLD"}


# ──────────────────────────── Numpy Helpers ─────────────────────────────

def _softmax(x: np.ndarray, axis: int = -1) -> np.ndarray:
    """Numerically stable softmax along given axis."""
    e = np.exp(x - np.max(x, axis=axis, keepdims=True))
    return e / np.sum(e, axis=axis, keepdims=True)


def _layer_norm(x: np.ndarray, gamma: np.ndarray, beta: np.ndarray,
                eps: float = 1e-6) -> np.ndarray:
    """Layer normalization over the last axis.

    Args:
        x: Input array of shape (..., d_model).
        gamma: Scale parameter, shape (d_model,).
        beta: Shift parameter, shape (d_model,).
    Returns:
        Normalized array of same shape.
    """
    mean = np.mean(x, axis=-1, keepdims=True)
    var = np.var(x, axis=-1, keepdims=True)
    x_norm = (x - mean) / np.sqrt(var + eps)
    return gamma * x_norm + beta


def _relu(x: np.ndarray) -> np.ndarray:
    return np.maximum(0, x)


def _gelu(x: np.ndarray) -> np.ndarray:
    """Gaussian Error Linear Unit approximation."""
    return 0.5 * x * (1.0 + np.tanh(np.sqrt(2.0 / np.pi) * (x + 0.044715 * x ** 3)))


# ──────────────────── Sinusoidal Positional Encoding ────────────────────

def _sinusoidal_encoding(seq_len: int, d_model: int) -> np.ndarray:
    """Create sinusoidal positional encoding matrix.

    Args:
        seq_len: Maximum sequence length.
        d_model: Model dimension.
    Returns:
        Array of shape (seq_len, d_model).
    """
    pe = np.zeros((seq_len, d_model), dtype=np.float64)
    position = np.arange(seq_len, dtype=np.float64)[:, np.newaxis]  # (seq_len, 1)
    div_term = np.exp(
        np.arange(0, d_model, 2, dtype=np.float64) * -(np.log(10000.0) / d_model)
    )  # (d_model/2,)

    pe[:, 0::2] = np.sin(position * div_term)
    pe[:, 1::2] = np.cos(position * div_term[:d_model // 2])  # handle odd d_model
    return pe


# ──────────────────── Multi-Head Self-Attention ─────────────────────────

class MultiHeadAttention:
    """Multi-head self-attention implemented entirely in numpy.

    Computes: Attention(Q, K, V) = softmax(QK^T / sqrt(d_k)) V
    with h parallel heads, then concatenated and projected.
    """

    def __init__(self, d_model: int, num_heads: int):
        self.d_model = d_model
        self.num_heads = num_heads
        self.d_head = d_model // num_heads
        assert d_model % num_heads == 0, "d_model must be divisible by num_heads"

        scale = np.sqrt(2.0 / d_model)

        # Projection matrices for Q, K, V — shape (d_model, d_model)
        self.W_q = np.random.randn(d_model, d_model).astype(np.float64) * scale
        self.W_k = np.random.randn(d_model, d_model).astype(np.float64) * scale
        self.W_v = np.random.randn(d_model, d_model).astype(np.float64) * scale

        # Output projection
        self.W_o = np.random.randn(d_model, d_model).astype(np.float64) * scale

        # Biases
        self.b_q = np.zeros(d_model, dtype=np.float64)
        self.b_k = np.zeros(d_model, dtype=np.float64)
        self.b_v = np.zeros(d_model, dtype=np.float64)
        self.b_o = np.zeros(d_model, dtype=np.float64)

        # Store last attention weights for visualization
        self.last_attention_weights: Optional[np.ndarray] = None

    def forward(self, x: np.ndarray) -> np.ndarray:
        """Compute multi-head self-attention.

        Args:
            x: Input of shape (seq_len, d_model).
        Returns:
            Output of shape (seq_len, d_model).
        """
        seq_len = x.shape[0]

        # Linear projections
        Q = x @ self.W_q + self.b_q  # (seq_len, d_model)
        K = x @ self.W_k + self.b_k
        V = x @ self.W_v + self.b_v

        # Reshape to (num_heads, seq_len, d_head)
        Q = Q.reshape(seq_len, self.num_heads, self.d_head).transpose(1, 0, 2)
        K = K.reshape(seq_len, self.num_heads, self.d_head).transpose(1, 0, 2)
        V = V.reshape(seq_len, self.num_heads, self.d_head).transpose(1, 0, 2)

        # Scaled dot-product attention: (num_heads, seq_len, seq_len)
        scale = np.sqrt(self.d_head)
        scores = np.matmul(Q, K.transpose(0, 2, 1)) / scale
        attn_weights = _softmax(scores, axis=-1)  # (num_heads, seq_len, seq_len)

        # Store for visualization
        self.last_attention_weights = attn_weights.copy()

        # Apply attention to values
        attn_output = np.matmul(attn_weights, V)  # (num_heads, seq_len, d_head)

        # Concatenate heads: (seq_len, d_model)
        attn_output = attn_output.transpose(1, 0, 2).reshape(seq_len, self.d_model)

        # Output projection
        output = attn_output @ self.W_o + self.b_o
        return output

    def get_weight_names(self) -> list:
        return ["W_q", "W_k", "W_v", "W_o", "b_q", "b_k", "b_v", "b_o"]


# ───────────────────── Transformer Encoder Layer ────────────────────────

class TransformerEncoderLayer:
    """Single Transformer encoder layer: self-attention + feed-forward, each
    with residual connections and layer normalization (pre-norm style)."""

    def __init__(self, d_model: int, num_heads: int, d_ff: int):
        self.attention = MultiHeadAttention(d_model, num_heads)

        # Layer norm parameters
        self.ln1_gamma = np.ones(d_model, dtype=np.float64)
        self.ln1_beta = np.zeros(d_model, dtype=np.float64)
        self.ln2_gamma = np.ones(d_model, dtype=np.float64)
        self.ln2_beta = np.zeros(d_model, dtype=np.float64)

        # Feed-forward network: two linear layers with GELU activation
        scale1 = np.sqrt(2.0 / d_model)
        scale2 = np.sqrt(2.0 / d_ff)
        self.ff_W1 = np.random.randn(d_model, d_ff).astype(np.float64) * scale1
        self.ff_b1 = np.zeros(d_ff, dtype=np.float64)
        self.ff_W2 = np.random.randn(d_ff, d_model).astype(np.float64) * scale2
        self.ff_b2 = np.zeros(d_model, dtype=np.float64)

    def forward(self, x: np.ndarray) -> np.ndarray:
        """Forward pass through encoder layer.

        Args:
            x: shape (seq_len, d_model)
        Returns:
            shape (seq_len, d_model)
        """
        # Pre-norm self-attention with residual
        normed = _layer_norm(x, self.ln1_gamma, self.ln1_beta)
        attn_out = self.attention.forward(normed)
        x = x + attn_out  # Residual

        # Pre-norm feed-forward with residual
        normed = _layer_norm(x, self.ln2_gamma, self.ln2_beta)
        ff_out = _gelu(normed @ self.ff_W1 + self.ff_b1)
        ff_out = ff_out @ self.ff_W2 + self.ff_b2
        x = x + ff_out  # Residual

        return x

    def get_all_params(self) -> dict:
        """Return all trainable parameters as a flat dict."""
        params = {}
        for name in self.attention.get_weight_names():
            params[f"attn_{name}"] = getattr(self.attention, name)
        params["ln1_gamma"] = self.ln1_gamma
        params["ln1_beta"] = self.ln1_beta
        params["ln2_gamma"] = self.ln2_gamma
        params["ln2_beta"] = self.ln2_beta
        params["ff_W1"] = self.ff_W1
        params["ff_b1"] = self.ff_b1
        params["ff_W2"] = self.ff_W2
        params["ff_b2"] = self.ff_b2
        return params

    def set_param(self, name: str, value: np.ndarray):
        """Set a parameter by name."""
        if name.startswith("attn_"):
            setattr(self.attention, name[5:], value)
        else:
            setattr(self, name, value)


# ──────────────────────── Transformer Encoder ───────────────────────────

class TransformerEncoder:
    """Stack of TransformerEncoderLayers with input projection and positional
    encoding. Outputs a fixed-size vector via mean pooling over the sequence."""

    def __init__(self, feature_dim: int, d_model: int, num_heads: int,
                 d_ff: int, num_layers: int, seq_len: int):
        self.feature_dim = feature_dim
        self.d_model = d_model
        self.num_layers = num_layers
        self.seq_len = seq_len

        # Input projection: feature_dim -> d_model
        scale = np.sqrt(2.0 / feature_dim)
        self.input_proj_W = np.random.randn(feature_dim, d_model).astype(np.float64) * scale
        self.input_proj_b = np.zeros(d_model, dtype=np.float64)

        # Positional encoding (fixed, not trainable)
        self.pos_encoding = _sinusoidal_encoding(seq_len, d_model)

        # Encoder layers
        self.layers: list[TransformerEncoderLayer] = [
            TransformerEncoderLayer(d_model, num_heads, d_ff)
            for _ in range(num_layers)
        ]

        # Final layer norm
        self.final_ln_gamma = np.ones(d_model, dtype=np.float64)
        self.final_ln_beta = np.zeros(d_model, dtype=np.float64)

    def forward(self, x: np.ndarray) -> np.ndarray:
        """Forward pass through the full transformer encoder.

        Args:
            x: Input features of shape (seq_len, feature_dim).
        Returns:
            Pooled output of shape (d_model,).
        """
        seq_len = x.shape[0]

        # Project to d_model
        h = x @ self.input_proj_W + self.input_proj_b  # (seq_len, d_model)

        # Add positional encoding
        h = h + self.pos_encoding[:seq_len]

        # Pass through encoder layers
        for layer in self.layers:
            h = layer.forward(h)

        # Final layer norm
        h = _layer_norm(h, self.final_ln_gamma, self.final_ln_beta)

        # Mean pooling over sequence dimension -> (d_model,)
        pooled = np.mean(h, axis=0)

        return pooled

    def get_all_params(self) -> dict:
        """Collect all trainable parameters with unique prefixed names."""
        params = {
            "input_proj_W": self.input_proj_W,
            "input_proj_b": self.input_proj_b,
            "final_ln_gamma": self.final_ln_gamma,
            "final_ln_beta": self.final_ln_beta,
        }
        for i, layer in enumerate(self.layers):
            for name, val in layer.get_all_params().items():
                params[f"layer{i}_{name}"] = val
        return params

    def set_param(self, name: str, value: np.ndarray):
        """Set a parameter by its prefixed name."""
        if name.startswith("layer"):
            # Parse "layer0_attn_W_q" -> layer_idx=0, param_name="attn_W_q"
            rest = name[5:]  # remove "layer"
            idx_str, param_name = rest.split("_", 1)
            layer_idx = int(idx_str)
            self.layers[layer_idx].set_param(param_name, value)
        elif name == "input_proj_W":
            self.input_proj_W = value
        elif name == "input_proj_b":
            self.input_proj_b = value
        elif name == "final_ln_gamma":
            self.final_ln_gamma = value
        elif name == "final_ln_beta":
            self.final_ln_beta = value

    def get_last_attention_weights(self) -> dict:
        """Return attention weights from the last forward pass, per layer."""
        weights = {}
        for i, layer in enumerate(self.layers):
            w = layer.attention.last_attention_weights
            if w is not None:
                weights[f"layer_{i}"] = w  # (num_heads, seq_len, seq_len)
        return weights


# ──────────────────── Transformer Trading Model ─────────────────────────

class TransformerTradingModel:
    """Transformer-lite trading signal model.

    Combines a numpy-based Transformer encoder (self-attention + positional
    encoding + feed-forward sublayers) with a scikit-learn MLPClassifier head
    for BUY/SELL/HOLD classification.

    Training approach:
      1. Forward-pass each training sequence through the Transformer encoder
         to produce a fixed-size (d_model,) embedding.
      2. Feed all embeddings to the MLPClassifier for supervised training.
      3. Periodically perturb the Transformer encoder weights via evolution
         strategy to improve the representations, then retrain the MLP.

    Thread-safe via threading.Lock.
    """

    def __init__(self):
        self._lock = threading.Lock()

        # Transformer encoder
        self.encoder = TransformerEncoder(
            feature_dim=FEATURE_DIM,
            d_model=D_MODEL,
            num_heads=NUM_HEADS,
            d_ff=D_FF,
            num_layers=NUM_LAYERS,
            seq_len=SEQ_LENGTH,
        )

        # Classification head
        self.classifier: Optional[MLPClassifier] = None
        self.scaler = StandardScaler()

        # Training buffer: list of (sequence, label) tuples
        self._buffer: deque = deque(maxlen=MAX_BUFFER_SIZE)
        self._new_samples = 0
        self._trained = False
        self._training_accuracy: Optional[float] = None
        self._last_train_time: Optional[float] = None
        self._total_predictions = 0
        self._last_attention_weights: Optional[dict] = None

        # Load persisted model if available
        self._load()

        logger.info(
            f"TransformerTradingModel initialized: d_model={D_MODEL}, "
            f"heads={NUM_HEADS}, layers={NUM_LAYERS}, "
            f"seq_len={SEQ_LENGTH}, features={FEATURE_DIM}"
        )

    # ─────────────────────────── Prediction ─────────────────────────────

    def predict(self, feature_sequence: list) -> dict:
        """Predict trading action from a sequence of feature vectors.

        Args:
            feature_sequence: List of numpy arrays, each of shape (FEATURE_DIM,).
                              Should contain exactly SEQ_LENGTH (20) vectors.
                              If longer, the last SEQ_LENGTH vectors are used.
                              If shorter, zero-padded on the left.
        Returns:
            dict with keys:
              - action: "BUY", "SELL", or "HOLD"
              - confidence: 0-100
              - attention_weights: dict of per-layer attention matrices
              - probabilities: dict of {action: probability}
              - method: "transformer" or "default"
        """
        with self._lock:
            # Validate and shape input
            seq = self._prepare_sequence(feature_sequence)
            if seq is None:
                return self._default_prediction()

            if not self._trained or self.classifier is None:
                return self._default_prediction()

            try:
                # Normalize input features
                seq_flat = seq.reshape(-1, FEATURE_DIM)
                if hasattr(self.scaler, "mean_") and self.scaler.mean_ is not None:
                    seq_flat = self.scaler.transform(seq_flat)
                seq_normed = seq_flat.reshape(SEQ_LENGTH, FEATURE_DIM)

                # Forward through transformer encoder
                embedding = self.encoder.forward(seq_normed)  # (d_model,)

                # Store attention weights
                self._last_attention_weights = self.encoder.get_last_attention_weights()

                # Classify
                embedding_2d = embedding.reshape(1, -1)
                probs = self.classifier.predict_proba(embedding_2d)[0]  # (3,)
                best_idx = int(np.argmax(probs))

                self._total_predictions += 1

                return {
                    "action": ACTION_NAMES[best_idx],
                    "confidence": round(float(np.max(probs)) * 100, 1),
                    "attention_weights": self._format_attention_weights(),
                    "probabilities": {
                        ACTION_NAMES[i]: round(float(probs[i]) * 100, 1)
                        for i in range(OUTPUT_CLASSES)
                    },
                    "method": "transformer",
                    "training_samples": len(self._buffer),
                }
            except Exception as e:
                logger.warning(f"Transformer prediction failed: {e}")
                return self._default_prediction()

    # ─────────────────────── Recording Sequences ────────────────────────

    def record_sequence(self, features: np.ndarray, outcome: str):
        """Record a labeled training sequence.

        Args:
            features: Array of shape (seq_len, FEATURE_DIM) or a flat 1D array
                      that will be reshaped. If longer than SEQ_LENGTH, the last
                      SEQ_LENGTH rows are used.
            outcome: One of "BUY", "SELL", "HOLD" — the correct action label.
        """
        outcome_upper = outcome.upper()
        if outcome_upper not in ACTION_MAP:
            logger.warning(f"Invalid outcome '{outcome}', ignoring")
            return

        with self._lock:
            seq = self._coerce_to_sequence(features)
            if seq is None:
                return

            label = ACTION_MAP[outcome_upper]
            self._buffer.append((seq.copy(), label))
            self._new_samples += 1

            # Auto-retrain check
            if (len(self._buffer) >= MIN_SAMPLES_TO_TRAIN
                    and self._new_samples >= RETRAIN_THRESHOLD):
                self._train_internal()

    # ──────────────────────────── Training ──────────────────────────────

    def train(self):
        """Manually trigger retraining on accumulated sequences."""
        with self._lock:
            self._train_internal()

    def _train_internal(self):
        """Train the model (must be called while holding self._lock).

        Steps:
            1. Fit the scaler on all buffered feature data.
            2. Optionally evolve the Transformer encoder weights.
            3. Forward-pass all sequences through the encoder to get embeddings.
            4. Train the MLPClassifier on embeddings.
        """
        n = len(self._buffer)
        if n < MIN_SAMPLES_TO_TRAIN:
            logger.info(f"Not enough samples to train: {n}/{MIN_SAMPLES_TO_TRAIN}")
            return

        t0 = time.time()
        logger.info(f"Starting transformer training on {n} samples...")

        all_seqs = np.array([s[0] for s in self._buffer])   # (n, SEQ_LENGTH, FEATURE_DIM)
        all_labels = np.array([s[1] for s in self._buffer])  # (n,)

        # 1. Fit scaler on all feature data
        flat_features = all_seqs.reshape(-1, FEATURE_DIM)
        self.scaler.fit(flat_features)
        all_seqs_normed = self.scaler.transform(flat_features).reshape(n, SEQ_LENGTH, FEATURE_DIM)

        # 2. Evolution step for the Transformer encoder (lightweight)
        self._evolve_encoder(all_seqs_normed, all_labels, iterations=15, noise_scale=0.01)

        # 3. Generate embeddings through the (possibly improved) encoder
        embeddings = np.zeros((n, D_MODEL), dtype=np.float64)
        for i in range(n):
            embeddings[i] = self.encoder.forward(all_seqs_normed[i])

        # 4. Train MLPClassifier on embeddings
        self.classifier = MLPClassifier(
            hidden_layer_sizes=(64, 32),
            activation="relu",
            solver="adam",
            max_iter=300,
            early_stopping=True,
            validation_fraction=0.15,
            n_iter_no_change=15,
            random_state=42,
            warm_start=False,
        )

        try:
            self.classifier.fit(embeddings, all_labels)
        except Exception as e:
            logger.error(f"MLPClassifier training failed: {e}")
            return

        # 5. Evaluate accuracy
        predictions = self.classifier.predict(embeddings)
        accuracy = float(np.mean(predictions == all_labels)) * 100
        self._training_accuracy = accuracy

        self._trained = True
        self._new_samples = 0
        self._last_train_time = time.time()

        elapsed = time.time() - t0
        logger.info(
            f"Transformer training complete: {n} samples, "
            f"accuracy={accuracy:.1f}%, elapsed={elapsed:.1f}s"
        )

        self._save()

    def _evolve_encoder(self, seqs_normed: np.ndarray, labels: np.ndarray,
                        iterations: int = 15, noise_scale: float = 0.01):
        """Improve encoder weights via a simple evolution strategy.

        Perturbs all encoder parameters with Gaussian noise, evaluates
        downstream classification accuracy with a quick logistic regression,
        and keeps perturbations that improve performance.
        """
        n = len(seqs_normed)

        def _evaluate() -> float:
            """Quick evaluation: embeddings -> simple accuracy with current MLP or logistic."""
            embs = np.zeros((n, D_MODEL), dtype=np.float64)
            for i in range(n):
                embs[i] = self.encoder.forward(seqs_normed[i])

            # Use a simple logistic regression for fast evaluation
            from sklearn.linear_model import LogisticRegression
            try:
                clf = LogisticRegression(max_iter=100, solver="lbfgs", multi_class="multinomial")
                clf.fit(embs, labels)
                preds = clf.predict(embs)
                return float(np.mean(preds == labels))
            except Exception:
                return 0.0

        best_score = _evaluate()

        for iteration in range(iterations):
            # Save current state
            saved = {name: val.copy() for name, val in self.encoder.get_all_params().items()}

            # Perturb
            for name, val in self.encoder.get_all_params().items():
                noise = np.random.randn(*val.shape) * noise_scale
                self.encoder.set_param(name, val + noise)

            score = _evaluate()

            if score > best_score:
                best_score = score
                logger.debug(f"Evolution iter {iteration}: improved to {score:.3f}")
            else:
                # Revert
                for name, val in saved.items():
                    self.encoder.set_param(name, val)

    # ─────────────────── Attention Weight Inspection ────────────────────

    def get_attention_weights(self) -> dict:
        """Return the attention weights from the last prediction.

        Returns:
            dict with keys like "layer_0", "layer_1", each containing:
              - per_head: list of (seq_len, seq_len) attention matrices
              - mean: (seq_len, seq_len) average across heads
              - top_attended: list of (position, weight) most-attended positions
        """
        with self._lock:
            return self._format_attention_weights()

    def _format_attention_weights(self) -> dict:
        """Format raw attention weights into a JSON-serializable dict."""
        if self._last_attention_weights is None:
            return {}

        result = {}
        for layer_name, weights in self._last_attention_weights.items():
            # weights shape: (num_heads, seq_len, seq_len)
            num_heads = weights.shape[0]
            mean_attn = np.mean(weights, axis=0)  # (seq_len, seq_len)

            # Find most-attended positions (by mean attention to each position)
            position_importance = np.mean(mean_attn, axis=0)  # (seq_len,)
            top_indices = np.argsort(position_importance)[::-1][:5]
            top_attended = [
                {"position": int(idx), "weight": round(float(position_importance[idx]), 4)}
                for idx in top_indices
            ]

            result[layer_name] = {
                "per_head": [
                    weights[h].tolist() for h in range(min(num_heads, NUM_HEADS))
                ],
                "mean": mean_attn.tolist(),
                "top_attended": top_attended,
                "shape": list(weights.shape),
            }

        return result

    # ─────────────────── Confidence Adjustment ──────────────────────────

    def get_confidence_adjustment(self, feature_sequence: list,
                                  proposed_action: str) -> int:
        """Return a confidence adjustment (-15 to +15) based on transformer prediction.

        If the transformer agrees with the proposed action with high confidence,
        return a positive boost. If it disagrees strongly, return a penalty.

        Args:
            feature_sequence: List of feature vectors (same as predict input).
            proposed_action: "BUY", "SELL", or "HOLD".
        Returns:
            Integer adjustment in [-15, +15].
        """
        pred = self.predict(feature_sequence)
        if pred["method"] == "default":
            return 0

        pred_action = pred["action"]
        pred_conf = pred["confidence"]
        proposed_upper = proposed_action.upper()

        # Strong agreement: boost confidence
        if pred_action == proposed_upper:
            if pred_conf >= 70:
                return min(15, int((pred_conf - 50) / 3))
            elif pred_conf >= 50:
                return min(10, int((pred_conf - 40) / 4))
            else:
                return max(0, int((pred_conf - 33) / 5))

        # Mild disagreement: small penalty
        if pred_conf < 50:
            return -3

        # Strong disagreement: larger penalty
        if pred_conf >= 70:
            return -15
        elif pred_conf >= 60:
            return -10
        else:
            return -5

    # ────────────────────────── Status ──────────────────────────────────

    def get_status(self) -> dict:
        """Return model status information.

        Returns:
            dict with keys:
              - trained: bool
              - training_samples: int
              - accuracy: float or None
              - last_train_time: ISO timestamp or None
              - total_predictions: int
              - buffer_size: int
              - buffer_capacity: int
              - new_samples_pending: int
              - architecture: dict with model config
        """
        with self._lock:
            return {
                "trained": self._trained,
                "training_samples": len(self._buffer),
                "accuracy": round(self._training_accuracy, 1) if self._training_accuracy else None,
                "last_train_time": (
                    time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(self._last_train_time))
                    if self._last_train_time else None
                ),
                "total_predictions": self._total_predictions,
                "buffer_size": len(self._buffer),
                "buffer_capacity": MAX_BUFFER_SIZE,
                "new_samples_pending": self._new_samples,
                "architecture": {
                    "type": "transformer-lite",
                    "d_model": D_MODEL,
                    "num_heads": NUM_HEADS,
                    "d_ff": D_FF,
                    "num_layers": NUM_LAYERS,
                    "seq_length": SEQ_LENGTH,
                    "feature_dim": FEATURE_DIM,
                    "output_classes": OUTPUT_CLASSES,
                    "classifier": "MLPClassifier(64, 32)",
                },
            }

    # ──────────────────────── Internal Helpers ──────────────────────────

    def _prepare_sequence(self, feature_sequence: list) -> Optional[np.ndarray]:
        """Validate and reshape input feature sequence.

        Returns:
            ndarray of shape (SEQ_LENGTH, FEATURE_DIM) or None on failure.
        """
        if feature_sequence is None or len(feature_sequence) == 0:
            return None

        try:
            # Convert list of arrays to 2D array
            if isinstance(feature_sequence, np.ndarray):
                arr = feature_sequence.astype(np.float64)
            else:
                arr = np.array(feature_sequence, dtype=np.float64)

            # Handle 1D input (single feature vector)
            if arr.ndim == 1:
                if arr.shape[0] == SEQ_LENGTH * FEATURE_DIM:
                    arr = arr.reshape(SEQ_LENGTH, FEATURE_DIM)
                else:
                    logger.warning(f"Cannot reshape 1D input of length {arr.shape[0]}")
                    return None

            if arr.ndim != 2 or arr.shape[1] != FEATURE_DIM:
                logger.warning(f"Invalid input shape {arr.shape}, expected (*, {FEATURE_DIM})")
                return None

            # Trim or pad to SEQ_LENGTH
            if arr.shape[0] > SEQ_LENGTH:
                arr = arr[-SEQ_LENGTH:]
            elif arr.shape[0] < SEQ_LENGTH:
                pad = np.zeros((SEQ_LENGTH - arr.shape[0], FEATURE_DIM), dtype=np.float64)
                arr = np.vstack([pad, arr])

            return arr

        except Exception as e:
            logger.warning(f"Failed to prepare sequence: {e}")
            return None

    def _coerce_to_sequence(self, features: np.ndarray) -> Optional[np.ndarray]:
        """Coerce features input to (SEQ_LENGTH, FEATURE_DIM) shape."""
        try:
            arr = np.asarray(features, dtype=np.float64)

            if arr.ndim == 1:
                if arr.shape[0] == SEQ_LENGTH * FEATURE_DIM:
                    arr = arr.reshape(SEQ_LENGTH, FEATURE_DIM)
                elif arr.shape[0] == FEATURE_DIM:
                    # Single vector: pad with zeros
                    pad = np.zeros((SEQ_LENGTH - 1, FEATURE_DIM), dtype=np.float64)
                    arr = np.vstack([pad, arr.reshape(1, -1)])
                else:
                    logger.warning(f"Cannot coerce 1D array of length {arr.shape[0]}")
                    return None
            elif arr.ndim == 2:
                if arr.shape[1] != FEATURE_DIM:
                    logger.warning(f"Feature dim mismatch: {arr.shape[1]} != {FEATURE_DIM}")
                    return None
                if arr.shape[0] > SEQ_LENGTH:
                    arr = arr[-SEQ_LENGTH:]
                elif arr.shape[0] < SEQ_LENGTH:
                    pad = np.zeros((SEQ_LENGTH - arr.shape[0], FEATURE_DIM), dtype=np.float64)
                    arr = np.vstack([pad, arr])
            else:
                logger.warning(f"Invalid ndim {arr.ndim}")
                return None

            return arr

        except Exception as e:
            logger.warning(f"Failed to coerce sequence: {e}")
            return None

    @staticmethod
    def _default_prediction() -> dict:
        """Return a neutral prediction when the model is untrained."""
        return {
            "action": "HOLD",
            "confidence": 33,
            "attention_weights": {},
            "probabilities": {"BUY": 33.0, "SELL": 33.0, "HOLD": 34.0},
            "method": "default",
            "training_samples": 0,
        }

    # ────────────────────── Persistence ─────────────────────────────────

    def _save(self):
        """Persist transformer encoder weights, scaler, and classifier to disk."""
        try:
            save_data = {}

            # Encoder parameters
            for name, val in self.encoder.get_all_params().items():
                save_data[f"enc_{name}"] = val

            # Scaler
            if hasattr(self.scaler, "mean_") and self.scaler.mean_ is not None:
                save_data["scaler_mean"] = self.scaler.mean_
                save_data["scaler_scale"] = self.scaler.scale_

            # Save encoder + scaler
            np.savez(MODEL_DIR / "transformer_encoder.npz", **save_data)

            # Save classifier separately via joblib
            if self.classifier is not None:
                import joblib
                joblib.dump(self.classifier, MODEL_DIR / "transformer_classifier.joblib")

            # Save metadata
            meta = {
                "trained": self._trained,
                "accuracy": self._training_accuracy or 0,
                "total_predictions": self._total_predictions,
                "last_train_time": self._last_train_time or 0,
                "buffer_size": len(self._buffer),
            }
            np.savez(MODEL_DIR / "transformer_meta.npz", **meta)

            logger.info("Transformer model saved")
        except Exception as e:
            logger.warning(f"Failed to save transformer model: {e}")

    def _load(self):
        """Load persisted model from disk."""
        enc_path = MODEL_DIR / "transformer_encoder.npz"
        clf_path = MODEL_DIR / "transformer_classifier.joblib"
        meta_path = MODEL_DIR / "transformer_meta.npz"

        # Load encoder
        if enc_path.exists():
            try:
                data = np.load(enc_path)
                for key in data.files:
                    if key.startswith("enc_"):
                        param_name = key[4:]  # strip "enc_" prefix
                        self.encoder.set_param(param_name, data[key])
                    elif key == "scaler_mean":
                        self.scaler.mean_ = data["scaler_mean"]
                        self.scaler.scale_ = data["scaler_scale"]
                        self.scaler.var_ = data["scaler_scale"] ** 2
                        self.scaler.n_features_in_ = FEATURE_DIM
                logger.info("Loaded transformer encoder weights")
            except Exception as e:
                logger.warning(f"Failed to load transformer encoder: {e}")

        # Load classifier
        if clf_path.exists():
            try:
                import joblib
                self.classifier = joblib.load(clf_path)
                self._trained = True
                logger.info("Loaded transformer classifier")
            except Exception as e:
                logger.warning(f"Failed to load transformer classifier: {e}")

        # Load metadata
        if meta_path.exists():
            try:
                meta = np.load(meta_path, allow_pickle=True)
                self._training_accuracy = float(meta.get("accuracy", 0)) or None
                self._total_predictions = int(meta.get("total_predictions", 0))
                lt = float(meta.get("last_train_time", 0))
                self._last_train_time = lt if lt > 0 else None
            except Exception as e:
                logger.warning(f"Failed to load transformer metadata: {e}")


# ───────────────────────── Singleton Access ─────────────────────────────

_instance: Optional[TransformerTradingModel] = None
_instance_lock = threading.Lock()


def get_transformer_model() -> TransformerTradingModel:
    """Return the singleton TransformerTradingModel instance (thread-safe)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = TransformerTradingModel()
    return _instance
