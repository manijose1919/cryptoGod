"""
ZMQ Server
PUB socket on :5555 for broadcasting data to dashboard.
REP socket on :5556 for receiving commands (pause, panic, status).
"""
import json
import logging
import threading
import time

import zmq

import config

logger = logging.getLogger(__name__)


class ZMQServer:
    """Manages ZMQ PUB and REP sockets for dashboard communication."""

    def __init__(self):
        self.context = zmq.Context()

        # PUB socket - broadcasts data to all subscribers
        self.pub_socket = self.context.socket(zmq.PUB)
        self.pub_socket.bind(f"tcp://*:{config.ZMQ_PUB_PORT}")

        # REP socket - handles command requests
        self.rep_socket = self.context.socket(zmq.REP)
        self.rep_socket.bind(f"tcp://*:{config.ZMQ_REP_PORT}")

        self._command_handlers = {}
        self._running = False
        self._rep_thread = None

        logger.info(f"ZMQ PUB on :{config.ZMQ_PUB_PORT}, REP on :{config.ZMQ_REP_PORT}")

    def register_command(self, name: str, handler):
        """Register a command handler: handler(params) -> response_dict."""
        self._command_handlers[name] = handler

    # ── Publishing ─────────────────────────────────────────────────────────

    def publish(self, topic: str, data: dict):
        """Publish data on a topic. Dashboard subscribes to topics."""
        message = json.dumps(data, default=str)
        self.pub_socket.send_string(f"{topic} {message}")

    def publish_signals(self, symbol: str, analysis: dict):
        """Publish strategy signals for a symbol."""
        self.publish("SIGNALS", {"symbol": symbol, **analysis})

    def publish_portfolio(self, portfolio: dict):
        """Publish portfolio state."""
        self.publish("PORTFOLIO", portfolio)

    def publish_trade(self, trade: dict):
        """Publish a trade execution."""
        self.publish("TRADE", trade)

    def publish_sentiment(self, sentiments: dict):
        """Publish sentiment data."""
        self.publish("SENTIMENT", sentiments)

    def publish_heartbeat(self):
        """Publish heartbeat with timestamp."""
        self.publish("HEARTBEAT", {"ts": time.time(), "status": "alive"})

    def publish_log(self, level: str, message: str):
        """Publish a log message to dashboard."""
        self.publish("LOG", {"level": level, "message": message, "ts": time.time()})

    def publish_prices(self, prices: dict):
        """Publish current prices for all pairs."""
        self.publish("PRICES", prices)

    def publish_ai_analysis(self, symbol: str, analysis: dict):
        """Publish AI analysis result."""
        self.publish("AI", {"symbol": symbol, **analysis})

    def publish_scan(self, scan_data: dict):
        """Publish full market scan with per-pair strategy breakdowns."""
        self.publish("SCAN", scan_data)

    def publish_risk(self, risk_data: dict):
        """Publish risk manager state."""
        self.publish("RISK", risk_data)

    def publish_strategies(self, strategy_data: dict):
        """Publish strategy performance rankings and weights."""
        self.publish("STRATEGIES", strategy_data)

    def publish_session(self, session_data: dict):
        """Publish session summary info."""
        self.publish("SESSION", session_data)

    # ── Command Handling ───────────────────────────────────────────────────

    def _handle_commands(self):
        """REP socket loop: receive commands, dispatch to handlers, reply."""
        poller = zmq.Poller()
        poller.register(self.rep_socket, zmq.POLLIN)

        while self._running:
            events = dict(poller.poll(timeout=1000))
            if self.rep_socket in events:
                try:
                    raw = self.rep_socket.recv_string()
                    request = json.loads(raw)
                    cmd = request.get("command", "")
                    params = request.get("params", {})

                    if cmd in self._command_handlers:
                        response = self._command_handlers[cmd](params)
                    else:
                        response = {"error": f"Unknown command: {cmd}"}

                    self.rep_socket.send_string(json.dumps(response, default=str))
                except json.JSONDecodeError:
                    self.rep_socket.send_string(json.dumps({"error": "Invalid JSON"}))
                except Exception as e:
                    logger.error(f"Command handler error: {e}")
                    self.rep_socket.send_string(json.dumps({"error": str(e)}))

    def start_command_listener(self):
        """Start the REP command listener in a background thread."""
        self._running = True
        self._rep_thread = threading.Thread(target=self._handle_commands, daemon=True)
        self._rep_thread.start()
        logger.info("ZMQ command listener started")

    def stop(self):
        """Stop the server and close sockets."""
        self._running = False
        if self._rep_thread:
            self._rep_thread.join(timeout=3)
        self.pub_socket.close()
        self.rep_socket.close()
        self.context.term()
        logger.info("ZMQ server stopped")
