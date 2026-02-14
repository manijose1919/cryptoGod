"""
Bayesian Hyperparameter Optimization

Uses Optuna's TPE (Tree-structured Parzen Estimator) to find optimal:
1. ML model hyperparameters (learning rate, depth, estimators)
2. Trading strategy parameters (confidence thresholds, position sizing, ATR multipliers)
3. Ensemble weights

Runs in background, saves best params to models/best_params.json.
"""
import json
import logging
import threading
import time
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import optuna
import pandas as pd

import config
from services.walk_forward import WalkForwardEngine

logger = logging.getLogger(__name__)
optuna.logging.set_verbosity(optuna.logging.WARNING)

PARAMS_PATH = Path("models/best_params.json")


class HyperOptimizer:
    """Bayesian optimization for trading system parameters."""

    def __init__(self):
        self._running = False
        self._last_result: Optional[dict] = None
        self._study: Optional[optuna.Study] = None
        self._best_params: dict = self._load_best()
        self._wf_engine = WalkForwardEngine()

    def _load_best(self) -> dict:
        if PARAMS_PATH.exists():
            try:
                with open(PARAMS_PATH) as f:
                    return json.load(f)
            except Exception:
                pass
        return {}

    def _save_best(self, params: dict):
        self._best_params = params
        PARAMS_PATH.parent.mkdir(exist_ok=True)
        with open(PARAMS_PATH, "w") as f:
            json.dump(params, f, indent=2)

    def optimize_trading_params(
        self,
        df: pd.DataFrame,
        n_trials: int = 30,
        n_windows: int = 3,
    ) -> dict:
        """Optimize trading parameters using walk-forward validation.

        Searches over: position_pct, stop_atr_mult, tp_rr_ratio, min_confidence
        Objective: maximize Sharpe ratio (out-of-sample from walk-forward)
        """
        self._running = True

        def objective(trial: optuna.Trial) -> float:
            params = {
                "position_pct": trial.suggest_float("position_pct", 0.03, 0.20),
                "stop_atr_mult": trial.suggest_float("stop_atr_mult", 1.0, 3.5),
                "tp_rr_ratio": trial.suggest_float("tp_rr_ratio", 1.0, 4.0),
                "min_confidence": trial.suggest_int("min_confidence", 25, 65),
            }

            try:
                wf_result = self._wf_engine.walk_forward(
                    df, n_windows=n_windows, **params
                )
                if "error" in wf_result:
                    return -999

                sharpe = wf_result.get("avg_sharpe", -999)
                pf = wf_result.get("avg_profit_factor", 0)
                trades = wf_result.get("total_trades", 0)

                # Penalize too few trades (not enough signal)
                if trades < 5:
                    return -999

                # Combined objective: Sharpe + profit factor bonus
                return sharpe + (pf * 0.1 if pf < float("inf") else 0)
            except Exception as e:
                logger.debug(f"Trial failed: {e}")
                return -999

        study = optuna.create_study(
            direction="maximize",
            sampler=optuna.samplers.TPESampler(seed=42),
        )
        study.optimize(objective, n_trials=n_trials, show_progress_bar=False)
        self._study = study
        self._running = False

        best = study.best_params
        best_value = study.best_value

        result = {
            "best_params": best,
            "best_score": round(best_value, 4),
            "n_trials": n_trials,
            "n_completed": len(study.trials),
            "optimization_history": [
                {"trial": t.number, "value": round(t.value, 4) if t.value else None, "params": t.params}
                for t in study.trials[:20]
            ],
        }
        self._last_result = result
        self._save_best(best)
        logger.info(f"Hyperopt complete: best Sharpe={best_value:.3f}, params={best}")
        return result

    def optimize_ml_params(
        self,
        X: np.ndarray,
        y: np.ndarray,
        n_trials: int = 20,
    ) -> dict:
        """Optimize ML model hyperparameters using cross-validation.

        Searches over: n_estimators, max_depth, learning_rate, subsample
        """
        from sklearn.model_selection import cross_val_score
        from sklearn.ensemble import GradientBoostingClassifier
        from sklearn.preprocessing import StandardScaler

        self._running = True
        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(X)

        def objective(trial: optuna.Trial) -> float:
            params = {
                "n_estimators": trial.suggest_int("n_estimators", 50, 300),
                "max_depth": trial.suggest_int("max_depth", 2, 8),
                "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
                "subsample": trial.suggest_float("subsample", 0.6, 1.0),
                "min_samples_leaf": trial.suggest_int("min_samples_leaf", 3, 15),
            }

            clf = GradientBoostingClassifier(**params, random_state=42)
            try:
                cv_folds = min(5, max(2, len(y) // 20))
                scores = cross_val_score(clf, X_scaled, y, cv=cv_folds, scoring="accuracy")
                return scores.mean()
            except Exception:
                return 0

        study = optuna.create_study(direction="maximize")
        study.optimize(objective, n_trials=n_trials, show_progress_bar=False)
        self._running = False

        result = {
            "best_params": study.best_params,
            "best_accuracy": round(study.best_value, 4),
            "n_trials": n_trials,
        }
        self._last_result = result
        return result

    def run_in_background(self, df: pd.DataFrame, n_trials: int = 30):
        """Run optimization in a background thread."""
        if self._running:
            return {"status": "already_running"}

        thread = threading.Thread(
            target=self.optimize_trading_params,
            args=(df, n_trials),
            daemon=True,
        )
        thread.start()
        return {"status": "started", "n_trials": n_trials}

    def get_status(self) -> dict:
        return {
            "running": self._running,
            "best_params": self._best_params,
            "last_result": self._last_result,
        }

    def get_best_params(self) -> dict:
        return self._best_params.copy()


# Module-level singleton
_hyperopt: Optional[HyperOptimizer] = None


def get_hyperoptimizer() -> HyperOptimizer:
    global _hyperopt
    if _hyperopt is None:
        _hyperopt = HyperOptimizer()
    return _hyperopt
