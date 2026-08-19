// ─── Chrome DevTools Protocol client ──────────────────────────────────────
// A minimal JSON-RPC-over-WebSocket client for talking to a local Chrome.
//
// Chrome already speaks a WebSocket protocol that can drive a page and stream
// what it renders, so a browser pane needs no server of its own: this is the
// same role ttyd plays for a terminal pane, except Chrome ships it.
//
// Deliberately not a dependency (puppeteer, playwright): the surface used here
// is a handful of domains — Target, Page, Input, Emulation, Runtime — and the
// agent already depends on `ws`.

import { EventEmitter } from 'events';
import WebSocket from 'ws';

// A screencast frame is a base64 JPEG of the whole viewport, and CDP sends it
// as one message. The default 100MB `ws` limit is far more than needed, but a
// cap that is too tight kills the connection mid-session on a large pane, so
// this is set generously and the frame size is controlled at the source
// instead (quality + maxWidth/maxHeight on Page.startScreencast).
const MAX_PAYLOAD = 64 * 1024 * 1024;

// Chrome answers everything used here in milliseconds. A command that has not
// come back within this window means the tab is wedged (a modal JS dialog, a
// crashed renderer), and the caller needs an error rather than a promise that
// never settles.
const COMMAND_TIMEOUT_MS = 30000;

export class CdpConnection extends EventEmitter {
  /**
   * @param {string} wsUrl - the webSocketDebuggerUrl reported by Chrome
   */
  constructor(wsUrl) {
    super();
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, { maxPayload: MAX_PAYLOAD });
      this.ws = ws;

      const onOpenError = (err) => reject(err);
      ws.once('error', onOpenError);
      ws.once('open', () => {
        ws.removeListener('error', onOpenError);
        ws.on('error', (err) => this.emit('error', err));
        ws.on('message', (raw) => this._onMessage(raw));
        ws.on('close', () => this._onClose());
        resolve(this);
      });
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // Chrome does not send malformed JSON; ignore rather than throw
    }

    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.method || 'cdp'})`));
      else resolve(msg.result ?? {});
      return;
    }

    if (!msg.method) return;
    // Two shapes, because callers want both: a firehose for logging, and a
    // per-method listener for the hot paths (screencast frames, navigation).
    this.emit('event', msg);
    this.emit(msg.method, msg.params ?? {}, msg.sessionId);
  }

  _onClose() {
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
    this.emit('close');
  }

  /**
   * Issue a CDP command.
   *
   * @param {string} method - e.g. 'Page.navigate'
   * @param {object} [params]
   * @param {string} [sessionId] - target session, for flattened attachment
   * @returns {Promise<object>} the command result
   */
  send(method, params = {}, sessionId) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP not connected (${method})`));
    }

    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out after ${COMMAND_TIMEOUT_MS}ms: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  /**
   * Fire-and-forget variant for messages where the reply is noise and a
   * rejection would be worse than silence — screencast frame acks, which
   * arrive at frame rate and are meaningless once the next frame is drawn.
   */
  sendNoReply(method, params = {}, sessionId) {
    this.send(method, params, sessionId).catch(() => {});
  }

  close() {
    this.closed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}
