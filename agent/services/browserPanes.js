// ─── Browser panes ────────────────────────────────────────────────────────
// The pane/tab model on top of a pooled Chrome (services/chrome.js) and the
// CDP client (services/cdp.js).
//
// A pane owns a set of page targets — its tabs — and screencasts whichever one
// is active. Only the active tab is streamed: a background tab still runs, but
// nobody is looking at it, and every streamed frame is bandwidth over the relay.
//
// State that must survive an agent restart (position, size, profile, the URLs
// that were open) is persisted; the CDP target ids are not, because they are
// meaningless to a Chrome that has since been restarted. On restore the tabs
// are recreated from their URLs.

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { config } from '../src/config.js';
import { acquireChrome, releaseChrome, DEFAULT_PROFILE_DIR } from './chrome.js';

const STATE_FILE = join(config.dataDir, 'browser-panes.json');

const DEFAULT_SIZE = { width: 900, height: 640 };
const BLANK_URL = 'about:blank';

// JPEG rather than PNG: a page of text compresses to tens of kilobytes instead
// of megabytes, and the relay caps a WebSocket frame at 1MB. Quality 65 is the
// point where text stays crisp at 1x while a screenshot-heavy page still fits.
const SCREENCAST = { format: 'jpeg', quality: 65, everyNthFrame: 1 };

// Cap on frames forwarded to the canvas. Measured on github.com without one:
// 44 frames/second at ~39KB each, or 1.6MB/s for a single pane — enough to
// saturate a shared canvas for something no eye can follow.
//
// The throttle drops frames here rather than delaying the screencast ack.
// Delaying the ack was the first attempt and it does not work: Chrome allows
// several unacknowledged frames in flight, so pacing the acks still let 44fps
// through. Acking promptly and discarding locally is also the cheaper half —
// the expensive hop is the relay, not the loopback read.
const MAX_FPS = 20;
const MIN_FRAME_INTERVAL_MS = Math.round(1000 / MAX_FPS);

// Chrome renders at the size it is told, and the pane is the only thing that
// knows how big that is. This is the ceiling used before the client reports its
// real viewport, and the cap on what a client can ask for — a pane sized past
// this would produce frames that no longer fit the relay's 1MB limit.
const MAX_VIEWPORT = { width: 2560, height: 1600 };

/**
 * Only http(s) and about:blank may be loaded.
 *
 * file:// would turn a pane into a file browser for the whole machine, and
 * javascript: would run in whatever page is loaded. Anyone who reaches the
 * canvas can drive these panes, so the check is here rather than in the UI.
 *
 * @returns {string} the normalised URL
 * @throws {Error} when the scheme is not allowed
 */
export function normaliseUrl(input) {
  const raw = (input || '').trim();
  if (!raw) return BLANK_URL;
  if (raw === BLANK_URL) return raw;

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open ${parsed.protocol} in a browser pane — http and https only`);
  }
  return parsed.toString();
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return [];
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')).panes || [];
  } catch (error) {
    console.error('[BrowserPanes] Error loading state:', error.message);
    return [];
  }
}

function saveState(panes) {
  try {
    const dir = config.dataDir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ version: 1, panes }, null, 2));
  } catch (error) {
    console.error('[BrowserPanes] Error saving state:', error.message);
  }
}

export class BrowserPaneService extends EventEmitter {
  constructor() {
    super();
    /**
     * paneId -> {
     *   id, position, size, profileDir,
     *   chrome, tabs: Map<targetId, {sessionId, url, title}>,
     *   activeTabId, viewport, attached
     * }
     */
    this.panes = new Map();
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Recreate the panes recorded on disk. Tabs come back as URLs, lazily. */
  restore() {
    for (const saved of loadState()) {
      this.panes.set(saved.id, {
        id: saved.id,
        position: saved.position,
        size: saved.size || DEFAULT_SIZE,
        profileDir: saved.profileDir || DEFAULT_PROFILE_DIR,
        savedTabs: saved.tabs || [{ url: BLANK_URL }],
        savedActiveIndex: saved.activeIndex || 0,
        chrome: null,
        tabs: new Map(),
        activeTabId: null,
        viewport: { ...DEFAULT_SIZE, deviceScaleFactor: 1 },
        attached: false,
      });
    }
    return this.listPanes();
  }

  persist() {
    const panes = [];
    for (const pane of this.panes.values()) {
      const tabs = pane.tabs.size
        ? [...pane.tabs.entries()].map(([, tab]) => ({ url: tab.url, title: tab.title }))
        : pane.savedTabs || [];
      const activeIndex = pane.tabs.size
        ? Math.max(0, [...pane.tabs.keys()].indexOf(pane.activeTabId))
        : pane.savedActiveIndex || 0;
      panes.push({
        id: pane.id,
        position: pane.position,
        size: pane.size,
        profileDir: pane.profileDir,
        tabs,
        activeIndex,
      });
    }
    saveState(panes);
  }

  listPanes() {
    return [...this.panes.values()].map((pane) => this.describe(pane.id));
  }

  describe(paneId) {
    const pane = this.panes.get(paneId);
    if (!pane) return null;
    return {
      id: pane.id,
      position: pane.position,
      size: pane.size,
      profileDir: pane.profileDir,
      // Before attach there are no CDP targets yet, but the pane still has
      // tabs — the ones it was restored with. Reporting those (with a null id,
      // since nothing can be selected until Chrome is up) lets the tab strip
      // render immediately instead of appearing empty until the first frame.
      tabs: pane.tabs.size
        ? [...pane.tabs.entries()].map(([id, tab]) => ({
            id,
            url: tab.url,
            title: tab.title,
            active: id === pane.activeTabId,
          }))
        : (pane.savedTabs || []).map((tab, index) => ({
            id: null,
            url: tab.url,
            title: tab.title || tab.url,
            active: index === (pane.savedActiveIndex || 0),
            pending: true,
          })),
      activeTabId: pane.activeTabId,
    };
  }

  async createPane({ url, position, size, profileDir } = {}) {
    const pane = {
      id: randomUUID(),
      position: position || { x: 120, y: 120 },
      size: size || { ...DEFAULT_SIZE },
      profileDir: profileDir || DEFAULT_PROFILE_DIR,
      savedTabs: [{ url: normaliseUrl(url) }],
      savedActiveIndex: 0,
      chrome: null,
      tabs: new Map(),
      activeTabId: null,
      viewport: { ...DEFAULT_SIZE, deviceScaleFactor: 1 },
      attached: false,
    };
    this.panes.set(pane.id, pane);
    this.persist();
    return this.describe(pane.id);
  }

  async closePane(paneId) {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    if (pane.frameTimer) clearTimeout(pane.frameTimer);
    pane.attached = false;

    if (pane.chrome) {
      for (const targetId of pane.tabs.keys()) {
        await pane.chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      }
      releaseChrome(pane.profileDir);
    }
    this.panes.delete(paneId);
    this.persist();
  }

  async patchPane(paneId, updates = {}) {
    const pane = this.panes.get(paneId);
    if (!pane) throw new Error('Browser pane not found');
    if (updates.position) pane.position = updates.position;
    if (updates.size) pane.size = updates.size;
    this.persist();
    return this.describe(paneId);
  }

  // ── attaching ───────────────────────────────────────────────────────────

  /**
   * Bring a pane online: start Chrome if needed, open its tabs, and begin
   * streaming the active one. Idempotent — a browser that reconnects re-attaches
   * every pane it remembers.
   */
  async attach(paneId, viewport = {}) {
    const pane = this.panes.get(paneId);
    if (!pane) throw new Error('Browser pane not found');

    pane.viewport = {
      width: clamp(viewport.width || pane.size.width, 200, MAX_VIEWPORT.width),
      height: clamp(viewport.height || pane.size.height, 200, MAX_VIEWPORT.height),
      deviceScaleFactor: clamp(viewport.deviceScaleFactor || 1, 1, 2),
    };

    if (!pane.chrome) {
      pane.chrome = await acquireChrome(pane.profileDir);
      this._wireBrowserEvents(pane);
      await pane.chrome.cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    }

    if (pane.tabs.size === 0) {
      const saved = pane.savedTabs?.length ? pane.savedTabs : [{ url: BLANK_URL }];
      for (const tab of saved) {
        await this._openTab(pane, tab.url, { activate: false });
      }
      const ids = [...pane.tabs.keys()];
      pane.activeTabId = ids[Math.min(pane.savedActiveIndex || 0, ids.length - 1)] || null;
    }

    pane.attached = true;
    if (pane.activeTabId) await this._activate(pane, pane.activeTabId);
    this._emitTabs(pane);
    return this.describe(paneId);
  }

  /** Stop streaming without closing anything — the pane is off-screen. */
  async detach(paneId) {
    const pane = this.panes.get(paneId);
    if (!pane || !pane.chrome) return;
    pane.attached = false;
    await this._stopScreencast(pane);
  }

  // ── tabs ────────────────────────────────────────────────────────────────

  async newTab(paneId, url) {
    const pane = this._requireLive(paneId);
    const targetId = await this._openTab(pane, normaliseUrl(url), { activate: true });
    this._emitTabs(pane);
    this.persist();
    return targetId;
  }

  async closeTab(paneId, tabId) {
    const pane = this._requireLive(paneId);
    if (!pane.tabs.has(tabId)) return;

    await pane.chrome.cdp.send('Target.closeTarget', { targetId: tabId }).catch(() => {});
    pane.tabs.delete(tabId);

    if (pane.activeTabId === tabId) {
      const next = [...pane.tabs.keys()][0] || null;
      pane.activeTabId = next;
      if (next) await this._activate(pane, next);
    }
    // A pane with no tabs left is an empty window, not a closed one: give it a
    // blank tab so the pane still has somewhere to type a URL.
    if (pane.tabs.size === 0) {
      const blank = await this._openTab(pane, BLANK_URL, { activate: true });
      pane.activeTabId = blank;
    }
    this._emitTabs(pane);
    this.persist();
  }

  async selectTab(paneId, tabId) {
    const pane = this._requireLive(paneId);
    if (!pane.tabs.has(tabId) || pane.activeTabId === tabId) return;
    await this._activate(pane, tabId);
    this._emitTabs(pane);
    this.persist();
  }

  // ── navigation ──────────────────────────────────────────────────────────

  async navigate(paneId, url) {
    const pane = this._requireLive(paneId);
    const session = this._activeSession(pane);
    await pane.chrome.cdp.send('Page.navigate', { url: normaliseUrl(url) }, session);
  }

  async goBack(paneId) { await this._historyStep(paneId, -1); }
  async goForward(paneId) { await this._historyStep(paneId, 1); }

  async reload(paneId) {
    const pane = this._requireLive(paneId);
    await pane.chrome.cdp.send('Page.reload', {}, this._activeSession(pane));
  }

  async _historyStep(paneId, delta) {
    const pane = this._requireLive(paneId);
    const session = this._activeSession(pane);
    const history = await pane.chrome.cdp.send('Page.getNavigationHistory', {}, session);
    const index = history.currentIndex + delta;
    if (index < 0 || index >= history.entries.length) return; // end of history
    await pane.chrome.cdp.send(
      'Page.navigateToHistoryEntry',
      { entryId: history.entries[index].id },
      session
    );
  }

  // ── input and viewport ──────────────────────────────────────────────────

  async setViewport(paneId, width, height, deviceScaleFactor = 1) {
    const pane = this._requireLive(paneId);
    pane.viewport = {
      width: clamp(Math.round(width), 200, MAX_VIEWPORT.width),
      height: clamp(Math.round(height), 200, MAX_VIEWPORT.height),
      deviceScaleFactor: clamp(deviceScaleFactor, 1, 2),
    };
    await this._applyViewport(pane, pane.activeTabId);
  }

  /**
   * Forward a mouse event. The client sends CSS pixels relative to the pane's
   * content box; Chrome is rendering at exactly that size, so no scaling is
   * needed here — getting that wrong is the classic "clicks land 40px off"
   * bug, so the conversion deliberately lives in one place, the client.
   */
  async dispatchMouse(paneId, event) {
    const pane = this._requireLive(paneId);
    await pane.chrome.cdp.send('Input.dispatchMouseEvent', event, this._activeSession(pane));
  }

  async dispatchKey(paneId, event) {
    const pane = this._requireLive(paneId);
    await pane.chrome.cdp.send('Input.dispatchKeyEvent', event, this._activeSession(pane));
  }

  async insertText(paneId, text) {
    const pane = this._requireLive(paneId);
    await pane.chrome.cdp.send('Input.insertText', { text }, this._activeSession(pane));
  }

  // ── internals ───────────────────────────────────────────────────────────

  _requireLive(paneId) {
    const pane = this.panes.get(paneId);
    if (!pane) throw new Error('Browser pane not found');
    if (!pane.chrome) throw new Error('Browser pane is not attached');
    return pane;
  }

  _activeSession(pane) {
    const tab = pane.tabs.get(pane.activeTabId);
    if (!tab) throw new Error('Browser pane has no active tab');
    return tab.sessionId;
  }

  async _openTab(pane, url, { activate }) {
    const { targetId } = await pane.chrome.cdp.send('Target.createTarget', { url });
    const { sessionId } = await pane.chrome.cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });

    await pane.chrome.cdp.send('Page.enable', {}, sessionId).catch(() => {});
    pane.tabs.set(targetId, { sessionId, url, title: url });

    if (activate) {
      pane.activeTabId = targetId;
      await this._activate(pane, targetId);
    }
    return targetId;
  }

  async _activate(pane, tabId) {
    if (pane.activeTabId && pane.activeTabId !== tabId) await this._stopScreencast(pane);
    pane.activeTabId = tabId;
    await this._applyViewport(pane, tabId);
    if (pane.attached) await this._startScreencast(pane);
  }

  async _applyViewport(pane, tabId) {
    const tab = pane.tabs.get(tabId);
    if (!tab) return;
    await pane.chrome.cdp
      .send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: pane.viewport.width,
          height: pane.viewport.height,
          deviceScaleFactor: pane.viewport.deviceScaleFactor,
          mobile: false,
        },
        tab.sessionId
      )
      .catch(() => {});
  }

  async _startScreencast(pane) {
    const tab = pane.tabs.get(pane.activeTabId);
    if (!tab) return;
    await pane.chrome.cdp
      .send(
        'Page.startScreencast',
        {
          ...SCREENCAST,
          maxWidth: pane.viewport.width * pane.viewport.deviceScaleFactor,
          maxHeight: pane.viewport.height * pane.viewport.deviceScaleFactor,
        },
        tab.sessionId
      )
      .catch((err) => this.emit('error', { paneId: pane.id, message: err.message }));
  }

  async _stopScreencast(pane) {
    if (pane.frameTimer) {
      clearTimeout(pane.frameTimer);
      pane.frameTimer = null;
    }
    pane.pendingFrame = null;
    const tab = pane.tabs.get(pane.activeTabId);
    if (!tab) return;
    await pane.chrome.cdp.send('Page.stopScreencast', {}, tab.sessionId).catch(() => {});
  }

  _wireBrowserEvents(pane) {
    const cdp = pane.chrome.cdp;

    cdp.on('Page.screencastFrame', (params, sessionId) => {
      const tab = pane.tabs.get(pane.activeTabId);
      if (!tab || tab.sessionId !== sessionId) return;

      // Ack immediately and unconditionally: Chrome stops sending once enough
      // frames are unacknowledged, so a dropped ack freezes the pane for good.
      // Fire-and-forget, because the reply is meaningless by the time the next
      // frame is painted.
      cdp.sendNoReply('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId);

      const frame = { paneId: pane.id, tabId: pane.activeTabId, data: params.data, metadata: params.metadata };
      const sinceEmit = Date.now() - (pane.lastEmitAt || 0);

      if (sinceEmit >= MIN_FRAME_INTERVAL_MS) {
        pane.lastEmitAt = Date.now();
        this.emit('frame', frame);
        return;
      }

      // Inside the interval: hold the newest frame and emit it on the trailing
      // edge. Plain dropping would be simpler but leaves the pane showing a
      // stale image whenever a burst ends mid-interval — which is exactly what
      // the end of a page load or a scroll is.
      pane.pendingFrame = frame;
      if (pane.frameTimer) return;
      pane.frameTimer = setTimeout(() => {
        pane.frameTimer = null;
        const held = pane.pendingFrame;
        pane.pendingFrame = null;
        if (!held || !pane.attached) return;
        pane.lastEmitAt = Date.now();
        this.emit('frame', held);
      }, MIN_FRAME_INTERVAL_MS - sinceEmit);
    });

    // One event stream carries title and URL for every tab, which is what the
    // tab strip needs; polling Target.getTargets would be the alternative.
    cdp.on('Target.targetInfoChanged', ({ targetInfo }) => {
      const tab = pane.tabs.get(targetInfo.targetId);
      if (!tab) return;
      tab.url = targetInfo.url;
      tab.title = targetInfo.title || targetInfo.url;
      this._emitTabs(pane);
    });

    // A page opened with target=_blank or window.open becomes a new target
    // rather than a navigation. Adopting it as a tab in the pane that opened it
    // is what a browser does; without this the click appears to do nothing and
    // an invisible page runs on in the background.
    cdp.on('Target.targetCreated', async ({ targetInfo }) => {
      if (targetInfo.type !== 'page') return;
      if (!targetInfo.openerId || !pane.tabs.has(targetInfo.openerId)) return;
      if (pane.tabs.has(targetInfo.targetId)) return;
      try {
        const { sessionId } = await cdp.send('Target.attachToTarget', {
          targetId: targetInfo.targetId,
          flatten: true,
        });
        await cdp.send('Page.enable', {}, sessionId).catch(() => {});
        pane.tabs.set(targetInfo.targetId, {
          sessionId,
          url: targetInfo.url,
          title: targetInfo.title || targetInfo.url,
        });
        await this._activate(pane, targetInfo.targetId);
        this._emitTabs(pane);
        this.persist();
      } catch (err) {
        this.emit('error', { paneId: pane.id, message: `Could not adopt popup: ${err.message}` });
      }
    });

    cdp.on('Target.targetDestroyed', ({ targetId }) => {
      if (!pane.tabs.has(targetId)) return;
      pane.tabs.delete(targetId);
      if (pane.activeTabId === targetId) {
        pane.activeTabId = [...pane.tabs.keys()][0] || null;
        if (pane.activeTabId) this._activate(pane, pane.activeTabId).catch(() => {});
      }
      this._emitTabs(pane);
      this.persist();
    });

    // A page's own alert()/confirm() blocks its renderer until something
    // answers it, and nothing here can: there is no chrome around the page to
    // show a dialog in. Left alone, the tab stops painting and every later CDP
    // command against it times out. Dismissing keeps the tab usable; the cost
    // is that a confirm() always reads as Cancel.
    cdp.on('Page.javascriptDialogOpening', (params, sessionId) => {
      cdp.sendNoReply('Page.handleJavaScriptDialog', { accept: false }, sessionId);
      this.emit('dialog', { paneId: pane.id, type: params.type, message: params.message });
    });
  }

  _emitTabs(pane) {
    this.emit('tabs', {
      paneId: pane.id,
      tabs: this.describe(pane.id).tabs,
      activeTabId: pane.activeTabId,
    });
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export const browserPaneService = new BrowserPaneService();
