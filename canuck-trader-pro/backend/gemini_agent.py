"""
Gemini CLI Agent
Calls the Gemini CLI as a subprocess for AI-powered analysis.
"""
import json
import logging
import subprocess
from typing import Optional

import config

logger = logging.getLogger(__name__)


class GeminiAgent:
    """Wraps the Gemini CLI for trade analysis and sentiment scoring."""

    def __init__(self):
        self.cli_path = config.GEMINI_CLI_PATH
        self.model = config.GEMINI_MODEL

    def _call_cli(self, prompt: str, timeout: int = 30) -> Optional[str]:
        """Call gemini CLI with a prompt, return stdout text."""
        try:
            result = subprocess.run(
                [self.cli_path, "-m", self.model, prompt],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            if result.returncode != 0:
                logger.error(f"Gemini CLI error: {result.stderr.strip()}")
                return None
            return result.stdout.strip()
        except FileNotFoundError:
            logger.error(f"Gemini CLI not found at: {self.cli_path}")
            return None
        except subprocess.TimeoutExpired:
            logger.warning("Gemini CLI timed out")
            return None
        except Exception as e:
            logger.error(f"Gemini CLI unexpected error: {e}")
            return None

    def analyze_trade(self, symbol: str, signals: dict, market_context: dict) -> Optional[dict]:
        """Ask Gemini to evaluate a potential trade setup.

        Returns: {"action": "BUY"|"SELL"|"HOLD", "confidence": 0-100, "reasoning": "..."}
        """
        prompt = (
            f"You are a crypto trading analyst. Analyze this setup and respond ONLY with valid JSON.\n\n"
            f"Symbol: {symbol}\n"
            f"Strategy signals: {json.dumps(signals, default=str)}\n"
            f"Market context: {json.dumps(market_context, default=str)}\n\n"
            f"Respond with JSON: {{\"action\": \"BUY\"|\"SELL\"|\"HOLD\", "
            f"\"confidence\": 0-100, \"reasoning\": \"brief explanation\"}}"
        )

        raw = self._call_cli(prompt)
        if not raw:
            return None

        try:
            # Try to extract JSON from response (Gemini may add markdown fences)
            text = raw
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]
            return json.loads(text.strip())
        except (json.JSONDecodeError, IndexError):
            logger.warning(f"Could not parse Gemini trade analysis: {raw[:200]}")
            return None

    def score_sentiment(self, headlines: list[str], symbol: str) -> Optional[dict]:
        """Ask Gemini to score news sentiment for a crypto asset.

        Returns: {"score": -100 to 100, "summary": "..."}
        """
        if not headlines:
            return {"score": 0, "summary": "No news available"}

        headlines_text = "\n".join(f"- {h}" for h in headlines[:15])
        prompt = (
            f"Score the overall crypto market sentiment for {symbol} based on these headlines.\n"
            f"Respond ONLY with valid JSON.\n\n"
            f"Headlines:\n{headlines_text}\n\n"
            f"Respond with JSON: {{\"score\": -100 to 100 (negative=bearish, positive=bullish), "
            f"\"summary\": \"one sentence summary\"}}"
        )

        raw = self._call_cli(prompt)
        if not raw:
            return None

        try:
            text = raw
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]
            result = json.loads(text.strip())
            result["score"] = max(-100, min(100, int(result.get("score", 0))))
            return result
        except (json.JSONDecodeError, IndexError, ValueError):
            logger.warning(f"Could not parse Gemini sentiment: {raw[:200]}")
            return None

    def get_market_summary(self, portfolio_state: dict) -> Optional[str]:
        """Ask Gemini for a brief market overview given current portfolio state."""
        prompt = (
            f"Give a 2-3 sentence crypto market summary for a Canadian trader.\n"
            f"Portfolio: {json.dumps(portfolio_state, default=str)}\n"
            f"Focus on: key trends, risk warnings, opportunity highlights."
        )
        return self._call_cli(prompt)
