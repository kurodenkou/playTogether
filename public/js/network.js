/**
 * NetworkClient — thin WebSocket wrapper
 *
 * Wraps the browser WebSocket and exposes a typed event-based API.
 * Messages are JSON objects with a mandatory `type` field.
 *
 * Usage:
 *   const net = new NetworkClient();
 *   await net.connect();
 *   net.on('game-started', msg => { ... });
 *   net.send({ type: 'create-room', playerName: 'Alice' });
 */
class NetworkClient extends EventTarget {
  constructor() {
    super();
    /** @type {WebSocket|null} */
    this.ws = null;
    this.connected = false;
    this._queue = [];   // messages queued before the socket opens
  }

  /** Open the WebSocket connection.  Resolves once the socket is ready. */
  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${proto}//${location.host}`);

      this.ws.onopen = () => {
        this.connected = true;
        // Flush any messages that were sent before connection opened
        while (this._queue.length) this.ws.send(this._queue.shift());
        resolve();
      };

      this.ws.onerror = (ev) => reject(new Error('WebSocket connection failed'));

      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        // Dispatch a typed CustomEvent for specific handlers,
        // plus a generic 'message' event for catch-all handlers.
        const typed   = new CustomEvent(msg.type,    { detail: msg });
        const generic = new CustomEvent('message',   { detail: msg });
        this.dispatchEvent(typed);
        this.dispatchEvent(generic);
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.dispatchEvent(new CustomEvent('disconnect'));
      };
    });
  }

  /**
   * Register a message handler.
   * @param {string}   type     - message type (e.g. 'room-created')
   * @param {function} handler  - called with the full message object
   * @returns {this}  for chaining
   */
  on(type, handler) {
    this.addEventListener(type, (ev) => handler(ev.detail));
    return this;
  }

  /** Send a JSON message.  Queues if the socket is not yet open. */
  send(msg) {
    const raw = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else {
      this._queue.push(raw);
    }
  }

  disconnect() {
    this.ws?.close();
  }
}
