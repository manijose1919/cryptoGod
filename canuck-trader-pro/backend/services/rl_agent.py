"""
Reinforcement Learning Agent (Deep Q-Network style, numpy-only)

Uses a neural-network-like approach with numpy:
- 2-layer MLP as Q-function approximator
- Experience replay buffer
- Epsilon-greedy exploration with decay
- State: recent candle features + position info
- Actions: BUY, HOLD, SELL
- Reward: realized P&L (delayed reward on exit)
"""

import logging
import time
import json
import os
from pathlib import Path
from typing import Optional
from collections import deque

import numpy as np

logger = logging.getLogger("rl_agent")

MODEL_DIR = Path(__file__).parent.parent / "models"
MODEL_DIR.mkdir(exist_ok=True)

# Actions
ACTION_BUY = 0
ACTION_HOLD = 1
ACTION_SELL = 2
ACTION_NAMES = ["BUY", "HOLD", "SELL"]

# State dimension: 20 market features + 3 position features = 23
STATE_DIM = 23
N_ACTIONS = 3


class ReplayBuffer:
    """Fixed-size circular buffer for experience replay."""

    def __init__(self, capacity: int = 10000):
        self.buffer = deque(maxlen=capacity)

    def push(self, state, action, reward, next_state, done):
        self.buffer.append((state, action, reward, next_state, done))

    def sample(self, batch_size: int):
        indices = np.random.choice(len(self.buffer), batch_size, replace=False)
        batch = [self.buffer[i] for i in indices]
        states = np.array([b[0] for b in batch])
        actions = np.array([b[1] for b in batch])
        rewards = np.array([b[2] for b in batch])
        next_states = np.array([b[3] for b in batch])
        dones = np.array([b[4] for b in batch])
        return states, actions, rewards, next_states, dones

    def __len__(self):
        return len(self.buffer)


class NumpyMLP:
    """Simple 2-layer MLP using only numpy. Q-function approximator."""

    def __init__(self, input_dim: int, hidden_dim: int, output_dim: int):
        # He initialization
        self.W1 = np.random.randn(input_dim, hidden_dim) * np.sqrt(2.0 / input_dim)
        self.b1 = np.zeros(hidden_dim)
        self.W2 = np.random.randn(hidden_dim, hidden_dim) * np.sqrt(2.0 / hidden_dim)
        self.b2 = np.zeros(hidden_dim)
        self.W3 = np.random.randn(hidden_dim, output_dim) * np.sqrt(2.0 / hidden_dim)
        self.b3 = np.zeros(output_dim)

    def forward(self, x: np.ndarray) -> np.ndarray:
        """Forward pass. x shape: (batch, input_dim) or (input_dim,)."""
        single = x.ndim == 1
        if single:
            x = x.reshape(1, -1)
        h1 = np.maximum(0, x @ self.W1 + self.b1)  # ReLU
        h2 = np.maximum(0, h1 @ self.W2 + self.b2)  # ReLU
        out = h2 @ self.W3 + self.b3
        return out[0] if single else out

    def train_batch(self, states, targets, lr: float = 0.001):
        """One gradient step via backprop."""
        batch_size = states.shape[0]

        # Forward
        h1_pre = states @ self.W1 + self.b1
        h1 = np.maximum(0, h1_pre)
        h2_pre = h1 @ self.W2 + self.b2
        h2 = np.maximum(0, h2_pre)
        output = h2 @ self.W3 + self.b3

        # Loss gradient (MSE)
        d_out = 2.0 * (output - targets) / batch_size

        # Backprop through layer 3
        dW3 = h2.T @ d_out
        db3 = d_out.sum(axis=0)
        dh2 = d_out @ self.W3.T

        # Backprop through ReLU + layer 2
        dh2 = dh2 * (h2_pre > 0)
        dW2 = h1.T @ dh2
        db2 = dh2.sum(axis=0)
        dh1 = dh2 @ self.W2.T

        # Backprop through ReLU + layer 1
        dh1 = dh1 * (h1_pre > 0)
        dW1 = states.T @ dh1
        db1 = dh1.sum(axis=0)

        # Gradient clipping
        for grad in [dW1, db1, dW2, db2, dW3, db3]:
            np.clip(grad, -1.0, 1.0, out=grad)

        # SGD update
        self.W1 -= lr * dW1
        self.b1 -= lr * db1
        self.W2 -= lr * dW2
        self.b2 -= lr * db2
        self.W3 -= lr * dW3
        self.b3 -= lr * db3

    def copy_from(self, other: "NumpyMLP"):
        """Copy weights from another network (for target network)."""
        self.W1 = other.W1.copy()
        self.b1 = other.b1.copy()
        self.W2 = other.W2.copy()
        self.b2 = other.b2.copy()
        self.W3 = other.W3.copy()
        self.b3 = other.b3.copy()


class DQNAgent:
    """DQN trading agent with experience replay and target network."""

    def __init__(
        self,
        gamma: float = 0.95,
        epsilon_start: float = 1.0,
        epsilon_end: float = 0.05,
        epsilon_decay: float = 0.995,
        batch_size: int = 32,
        target_update_freq: int = 50,
        learning_rate: float = 0.0005,
        replay_capacity: int = 10000,
    ):
        self.gamma = gamma
        self.epsilon = epsilon_start
        self.epsilon_end = epsilon_end
        self.epsilon_decay = epsilon_decay
        self.batch_size = batch_size
        self.target_update_freq = target_update_freq
        self.lr = learning_rate

        self.q_net = NumpyMLP(STATE_DIM, 64, N_ACTIONS)
        self.target_net = NumpyMLP(STATE_DIM, 64, N_ACTIONS)
        self.target_net.copy_from(self.q_net)

        self.replay = ReplayBuffer(replay_capacity)
        self.step_count = 0
        self.train_count = 0
        self.total_reward = 0.0
        self.trade_results: list = []  # For reward shaping vol calculation

        # Current episode state
        self._current_state: Optional[np.ndarray] = None
        self._current_action: Optional[int] = None
        self._in_position = False

        self._load()

    def build_state(self, features: np.ndarray, position_info: dict) -> np.ndarray:
        """Build RL state vector from market features and position info.

        Args:
            features: Full feature vector from feature_engineer (99 dims)
            position_info: {has_position: bool, unrealized_pnl: float, hold_duration_min: float}
        """
        # Take 20 key market features (returns, vol, RSI, momentum area)
        if len(features) >= 20:
            market_feats = features[:20].copy()
        else:
            market_feats = np.zeros(20)
            market_feats[:len(features)] = features[:len(features)]

        # Normalize to [-1, 1] range (clip extreme values)
        market_feats = np.clip(market_feats, -5, 5) / 5.0

        # Position features
        has_pos = 1.0 if position_info.get("has_position", False) else 0.0
        unrealized = np.clip(position_info.get("unrealized_pnl", 0.0), -5, 5) / 5.0
        hold_dur = min(position_info.get("hold_duration_min", 0.0), 60.0) / 60.0

        state = np.concatenate([market_feats, [has_pos, unrealized, hold_dur]])
        return state.astype(np.float32)

    def select_action(self, state: np.ndarray) -> int:
        """Epsilon-greedy action selection."""
        if np.random.random() < self.epsilon:
            return np.random.randint(N_ACTIONS)
        q_values = self.q_net.forward(state)
        return int(np.argmax(q_values))

    def get_action_recommendation(self, features: np.ndarray, position_info: dict) -> dict:
        """Get RL agent's recommended action with confidence.

        Returns: {action: "BUY"|"HOLD"|"SELL", confidence: 0-100, q_values: [...]}
        """
        state = self.build_state(features, position_info)
        q_values = self.q_net.forward(state)

        best_action = int(np.argmax(q_values))
        # Convert Q-value advantage to confidence (0-100)
        q_range = q_values.max() - q_values.min()
        if q_range > 0:
            confidence = min(100, max(0, (q_values[best_action] - q_values.mean()) / q_range * 100))
        else:
            confidence = 33  # Uncertain

        return {
            "action": ACTION_NAMES[best_action],
            "confidence": round(float(confidence), 1),
            "q_values": {ACTION_NAMES[i]: round(float(q_values[i]), 4) for i in range(N_ACTIONS)},
            "epsilon": round(self.epsilon, 4),
            "training_steps": self.train_count,
            "replay_size": len(self.replay),
        }

    def step(self, features: np.ndarray, position_info: dict, reward: float = 0.0):
        """Called each cycle. Records transitions and trains.

        Args:
            features: Current feature vector
            position_info: Current position state
            reward: Reward from last action (P&L on exit, small penalty for holding)
        """
        new_state = self.build_state(features, position_info)

        # Store transition if we had a previous state
        if self._current_state is not None and self._current_action is not None:
            done = reward != 0  # Episode ends on trade exit
            self.replay.push(self._current_state, self._current_action, reward, new_state, done)
            self.total_reward += reward

        # Select action
        action = self.select_action(new_state)
        self._current_state = new_state
        self._current_action = action
        self.step_count += 1

        # Train
        if len(self.replay) >= self.batch_size:
            self._train_step()

        # Decay epsilon
        self.epsilon = max(self.epsilon_end, self.epsilon * self.epsilon_decay)

        # Update target network
        if self.step_count % self.target_update_freq == 0:
            self.target_net.copy_from(self.q_net)

        # Auto-save every 500 steps
        if self.step_count % 500 == 0:
            self._save()

        return ACTION_NAMES[action]

    def record_trade_reward(self, pnl_pct: float, hold_duration_min: float = 0):
        """Record shaped reward when a trade completes.

        Reward shaping:
        - Sharpe-inspired: reward = pnl / max(vol, 0.5) (risk-adjusted)
        - Time penalty: -0.01 per minute held (encourages quick profitable exits)
        - Loss aversion: losses penalized 1.5x
        - Quick win bonus: +0.5 if profitable within 10 minutes
        - Curiosity bonus: +0.1 for trades in novel states (new state space regions)
        """
        # Base: risk-adjusted PnL
        vol = max(np.std(self.trade_results[-20:]) if len(self.trade_results) >= 20 else 1.0, 0.5)
        risk_adj_pnl = pnl_pct / vol

        if pnl_pct > 0:
            reward = risk_adj_pnl * 1.0
            # Quick win bonus
            if hold_duration_min > 0 and hold_duration_min < 10:
                reward += 0.5
        else:
            reward = risk_adj_pnl * 1.5  # Loss aversion

        # Time penalty (discourage holding too long)
        if hold_duration_min > 30:
            reward -= 0.01 * min(hold_duration_min - 30, 100)

        # Curiosity: if this state is far from centroid of seen states, bonus
        if self._current_state is not None:
            if len(self.replay.buffer) > 50:
                recent_states = np.array([t[0] for t in list(self.replay.buffer)[-50:]])
                centroid = recent_states.mean(axis=0)
                dist = np.linalg.norm(self._current_state - centroid)
                avg_dist = np.mean([np.linalg.norm(s - centroid) for s in recent_states])
                if avg_dist > 0 and dist > avg_dist * 1.5:
                    reward += 0.1  # Curiosity bonus for exploring new territory

        # Store trade result for future vol calculation
        self.trade_results.append(pnl_pct)
        if len(self.trade_results) > 200:
            self.trade_results = self.trade_results[-200:]

        if self._current_state is not None and self._current_action is not None:
            next_state = self._current_state.copy()
            self.replay.push(self._current_state, self._current_action, reward, next_state, True)
            self.total_reward += reward

    def _train_step(self):
        """One training step on a minibatch from replay buffer."""
        states, actions, rewards, next_states, dones = self.replay.sample(self.batch_size)

        # Current Q-values
        current_q = self.q_net.forward(states)

        # Target Q-values (Double DQN: use q_net to select, target_net to evaluate)
        next_q_online = self.q_net.forward(next_states)
        next_q_target = self.target_net.forward(next_states)

        best_next_actions = np.argmax(next_q_online, axis=1)
        next_q_values = next_q_target[np.arange(len(best_next_actions)), best_next_actions]

        # Bellman target
        targets = current_q.copy()
        for i in range(len(actions)):
            if dones[i]:
                targets[i, actions[i]] = rewards[i]
            else:
                targets[i, actions[i]] = rewards[i] + self.gamma * next_q_values[i]

        self.q_net.train_batch(states, targets, lr=self.lr)
        self.train_count += 1

    def get_confidence_adjustment(self, features: np.ndarray, position_info: dict, proposed_action: str) -> int:
        """Return confidence adjustment (-10 to +10) based on RL agent's opinion.

        If RL agrees with proposed action, boost. If disagrees, penalize.
        """
        if self.train_count < 100:
            return 0  # Not enough training

        rec = self.get_action_recommendation(features, position_info)
        if rec["action"] == proposed_action:
            return min(10, max(0, int(rec["confidence"] / 10)))
        elif rec["action"] == "HOLD":
            return -3  # RL thinks we should wait
        else:
            return -5  # RL disagrees

    def _save(self):
        path = MODEL_DIR / "rl_agent.npz"
        try:
            np.savez(
                path,
                W1=self.q_net.W1, b1=self.q_net.b1,
                W2=self.q_net.W2, b2=self.q_net.b2,
                W3=self.q_net.W3, b3=self.q_net.b3,
                tW1=self.target_net.W1, tb1=self.target_net.b1,
                tW2=self.target_net.W2, tb2=self.target_net.b2,
                tW3=self.target_net.W3, tb3=self.target_net.b3,
                epsilon=np.array([self.epsilon]),
                step_count=np.array([self.step_count]),
                train_count=np.array([self.train_count]),
                total_reward=np.array([self.total_reward]),
            )
        except Exception as e:
            logger.warning(f"Failed to save RL agent: {e}")

    def _load(self):
        path = MODEL_DIR / "rl_agent.npz"
        if not path.exists():
            return
        try:
            data = np.load(path)
            self.q_net.W1 = data["W1"]
            self.q_net.b1 = data["b1"]
            self.q_net.W2 = data["W2"]
            self.q_net.b2 = data["b2"]
            self.q_net.W3 = data["W3"]
            self.q_net.b3 = data["b3"]
            self.target_net.W1 = data["tW1"]
            self.target_net.b1 = data["tb1"]
            self.target_net.W2 = data["tW2"]
            self.target_net.b2 = data["tb2"]
            self.target_net.W3 = data["tW3"]
            self.target_net.b3 = data["tb3"]
            self.epsilon = float(data["epsilon"][0])
            self.step_count = int(data["step_count"][0])
            self.train_count = int(data["train_count"][0])
            self.total_reward = float(data["total_reward"][0])
            logger.info(f"Loaded RL agent: {self.train_count} training steps, epsilon={self.epsilon:.3f}")
        except Exception as e:
            logger.warning(f"Could not load RL agent: {e}")

    def get_status(self) -> dict:
        return {
            "step_count": self.step_count,
            "train_count": self.train_count,
            "epsilon": round(self.epsilon, 4),
            "replay_size": len(self.replay),
            "total_reward": round(self.total_reward, 4),
            "model_loaded": self.step_count > 0,
        }


# Singleton
_instance: Optional[DQNAgent] = None


def get_rl_agent() -> DQNAgent:
    global _instance
    if _instance is None:
        _instance = DQNAgent()
    return _instance
