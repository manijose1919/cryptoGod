/**
 * Canuck-Trader-Pro Web Dashboard
 * Express + Socket.IO server that bridges ZMQ → Browser.
 * Access from any device at http://VPS_IP:3080
 */
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const ZMQClient = require("./zmq_client");

const PORT = process.env.PORT || 3080;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve static dashboard
app.use(express.static(path.join(__dirname, "public")));

// ZMQ client connects to Python backend
const zmq = new ZMQClient();

// State cache (so new browser connections get current data immediately)
const state = {
  prices: {},
  signals: {},
  portfolio: {},
  trades: [],
  sentiments: {},
  logs: [],
  lastHeartbeat: 0,
  ai: {},
};

// ── ZMQ → State + Socket.IO broadcast ──

zmq.on("PRICES", (data) => {
  state.prices = data;
  io.emit("prices", data);
});

zmq.on("SIGNALS", (data) => {
  const sym = data.symbol || "";
  state.signals[sym] = data;
  io.emit("signals", data);
});

zmq.on("PORTFOLIO", (data) => {
  state.portfolio = data;
  io.emit("portfolio", data);
});

zmq.on("TRADE", (data) => {
  state.trades.unshift(data);
  if (state.trades.length > 100) state.trades.pop();
  io.emit("trade", data);
});

zmq.on("SENTIMENT", (data) => {
  state.sentiments = data;
  io.emit("sentiment", data);
});

zmq.on("AI", (data) => {
  state.ai = data;
  io.emit("ai", data);
});

zmq.on("HEARTBEAT", (data) => {
  state.lastHeartbeat = data.ts;
  io.emit("heartbeat", data);
});

zmq.on("LOG", (data) => {
  state.logs.unshift(data);
  if (state.logs.length > 200) state.logs.pop();
  io.emit("log", data);
});

// ── Browser connects → send full state ──

io.on("connection", (socket) => {
  console.log(`Browser connected: ${socket.id}`);
  socket.emit("init", state);

  // Browser can send commands to Python backend
  socket.on("command", async (cmd) => {
    try {
      const result = await zmq.sendCommand(cmd.command, cmd.params || {});
      socket.emit("command_result", { command: cmd.command, result });
    } catch (err) {
      socket.emit("command_result", { command: cmd.command, error: err.message });
    }
  });

  socket.on("disconnect", () => {
    console.log(`Browser disconnected: ${socket.id}`);
  });
});

// ── Start ──

async function start() {
  await zmq.startSubscriber();
  console.log("ZMQ subscriber connected to Python backend");

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Dashboard running at http://0.0.0.0:${PORT}`);
    console.log(`Access from browser: http://YOUR_VPS_IP:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});
