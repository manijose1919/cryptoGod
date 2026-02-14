/**
 * ZMQ Client - Subscribes to Python backend PUB and sends commands via REQ.
 */
const zmq = require("zeromq");

class ZMQClient {
  constructor({ pubAddr = "tcp://127.0.0.1:5555", reqAddr = "tcp://127.0.0.1:5556" } = {}) {
    this.pubAddr = pubAddr;
    this.reqAddr = reqAddr;
    this.sub = null;
    this.req = null;
    this._handlers = {};
    this._connected = false;
  }

  /** Register a handler for a topic: on("SIGNALS", (data) => {...}) */
  on(topic, handler) {
    if (!this._handlers[topic]) this._handlers[topic] = [];
    this._handlers[topic].push(handler);
  }

  /** Start the SUB socket and begin receiving messages. */
  async startSubscriber() {
    this.sub = new zmq.Subscriber();
    this.sub.connect(this.pubAddr);

    // Subscribe to all topics
    this.sub.subscribe("");
    this._connected = true;

    // Receive loop
    (async () => {
      for await (const [msg] of this.sub) {
        try {
          const str = msg.toString();
          const spaceIdx = str.indexOf(" ");
          if (spaceIdx === -1) continue;

          const topic = str.substring(0, spaceIdx);
          const data = JSON.parse(str.substring(spaceIdx + 1));

          const handlers = this._handlers[topic] || [];
          for (const h of handlers) {
            try { h(data); } catch (e) { /* ignore handler errors */ }
          }

          // Also fire wildcard handlers
          const wildcards = this._handlers["*"] || [];
          for (const h of wildcards) {
            try { h(topic, data); } catch (e) { /* ignore */ }
          }
        } catch (e) {
          // Skip malformed messages
        }
      }
    })();
  }

  /** Send a command to the backend via REQ socket. */
  async sendCommand(command, params = {}) {
    if (!this.req) {
      this.req = new zmq.Request();
      this.req.connect(this.reqAddr);
    }

    const msg = JSON.stringify({ command, params });
    await this.req.send(msg);
    const [reply] = await this.req.receive();
    return JSON.parse(reply.toString());
  }

  /** Convenience: pause trading */
  async pause() { return this.sendCommand("pause"); }

  /** Convenience: resume trading */
  async resume() { return this.sendCommand("resume"); }

  /** Convenience: panic sell all */
  async panic() { return this.sendCommand("panic"); }

  /** Convenience: get status */
  async status() { return this.sendCommand("status"); }

  /** Convenience: get portfolio */
  async portfolio() { return this.sendCommand("portfolio"); }

  async close() {
    if (this.sub) this.sub.close();
    if (this.req) this.req.close();
  }
}

module.exports = ZMQClient;
