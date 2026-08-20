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
import { acquireChrome, releaseChrome, CHROME_DEVICE_SCALE, DEFAULT_PROFILE_DIR } from './chrome.js';

const STATE_FILE = join(config.dataDir, 'browser-panes.json');

const DEFAULT_SIZE = { width: 900, height: 640 };
const BLANK_URL = 'about:blank';

// JPEG rather than PNG: a page of text compresses to tens of kilobytes instead
// of megabytes, and the relay caps a WebSocket frame at 1MB.
//
// Quality 45 rather than the 65 this started at, because frames are now
// rendered at 2x (see CHROME_DEVICE_SCALE) and the extra resolution hides the
// compression: text is visibly crisp at 45, and the saving is real. Measured on
// github.com loading into a 1000x700 pane:
//
//   quality 65   1848 KB/s   largest frame 97 KB
//   quality 40   1041 KB/s   largest frame 76 KB
const SCREENCAST = { format: 'jpeg', quality: 45, everyNthFrame: 1 };

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

  // "localhost:3000" is a host and a port, not a scheme and a path — but it
  // matches a naive scheme regex, and that made every local dev server come
  // back as "Refusing to open localhost:". A scheme is only taken as such when
  // it is followed by //, or when it is one of the schemeless forms that never
  // is (about:blank, javascript:, data:, mailto:).
  const hasScheme =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ||
    /^(about|javascript|data|mailto|file|chrome|view-source|blob):/i.test(raw);

  // Bare hosts default to https, except where https is the wrong guess: a dev
  // server on localhost or a machine on the LAN or tailnet is almost never
  // serving TLS, and guessing https there fails with a handshake error rather
  // than loading the page the user asked for.
  const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|[^/]*\.local|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)(:\d+)?(\/|$)/i;
  const withScheme = hasScheme ? raw : `${LOCAL_HOST.test(raw) ? 'http' : 'https'}://${raw}`;

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

  /**
   * Coalesce persistence. Navigation events arrive in bursts, and rewriting the
   * whole state file per redirect is wasted IO for a file only read at startup.
   */
  _schedulePersist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.persist();
    }, 1000);
    // Never hold the process open for a save that can be redone on next launch.
    this._persistTimer.unref?.();
  }

  persist() {
    const panes = [];
    for (const pane of this.panes.values()) {
      const tabs = pane.tabs.size
        ? [...pane.tabs.entries()].map(([, tab]) => ({ url: tab.url, title: tab.title }))
        : pane.savedTabs || [];

      // Keep the in-memory fallback in step with what is being written.
      // savedTabs used to be frozen at creation, so any path that fell back to
      // it — a pane whose Chrome had gone away, a re-attach before the tabs
      // were reopened — resurrected about:blank and threw away the real URLs,
      // even though the file on disk was correct.
      if (pane.tabs.size) {
        pane.savedTabs = tabs;
        pane.savedActiveIndex = Math.max(0, [...pane.tabs.keys()].indexOf(pane.activeTabId));
      }
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
    pane.pendingFrame = null;
    this._unwireBrowserEvents(pane);

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
    const pane = await this._ensureAttached(paneId);
    const targetId = await this._openTab(pane, normaliseUrl(url), { activate: true });
    this._emitTabs(pane);
    this.persist();
    return targetId;
  }

  async closeTab(paneId, tabId) {
    const pane = await this._ensureAttached(paneId);
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
    const pane = await this._ensureAttached(paneId);
    if (!pane.tabs.has(tabId) || pane.activeTabId === tabId) return;
    await this._activate(pane, tabId);
    this._emitTabs(pane);
    this.persist();
  }

  // ── navigation ──────────────────────────────────────────────────────────

  async navigate(paneId, url) {
    const pane = await this._ensureAttached(paneId);
    const session = this._activeSession(pane);
    await pane.chrome.cdp.send('Page.navigate', { url: normaliseUrl(url) }, session);
  }

  async goBack(paneId) { await this._historyStep(paneId, -1); }
  async goForward(paneId) { await this._historyStep(paneId, 1); }

  async reload(paneId) {
    const pane = await this._ensureAttached(paneId);
    await pane.chrome.cdp.send('Page.reload', {}, this._activeSession(pane));
  }

  async _historyStep(paneId, delta) {
    const pane = await this._ensureAttached(paneId);
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
    const pane = await this._ensureAttached(paneId);
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
    const pane = await this._ensureAttached(paneId);
    await pane.chrome.cdp.send('Input.dispatchMouseEvent', event, this._activeSession(pane));
  }

  async dispatchKey(paneId, event) {
    const pane = await this._ensureAttached(paneId);
    await pane.chrome.cdp.send('Input.dispatchKeyEvent', event, this._activeSession(pane));
  }

  async insertText(paneId, text) {
    const pane = await this._ensureAttached(paneId);
    await pane.chrome.cdp.send('Input.insertText', { text }, this._activeSession(pane));
  }

  // ── internals ───────────────────────────────────────────────────────────

  _requireLive(paneId) {
    const pane = this.panes.get(paneId);
    if (!pane) throw new Error('Browser pane not found');
    if (!pane.chrome) throw new Error('Browser pane is not attached');
    return pane;
  }

  /**
   * Attach a pane that has no Chrome yet, so an action can proceed.
   *
   * After an agent restart every pane is back as a record with no browser, and
   * a canvas that was already open never sends another browser:attach — so
   * clicking, typing and opening tabs all failed with "Browser pane is not
   * attached", for ever, with the log filling up and the pane looking frozen.
   * The client re-attaches on agent:online now, but anything that arrives
   * before that heals itself here rather than erroring.
   */
  async _ensureAttached(paneId) {
    const pane = this.panes.get(paneId);
    if (!pane) throw new Error('Browser pane not found');
    if (!pane.chrome) await this.attach(paneId, pane.viewport);
    return this._requireLive(paneId);
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

    // Chrome does not composite a target that is not the foreground window, so
    // a screencast on one yields nothing and the pane freezes on whatever it
    // last showed. Page.bringToFront fixes the selected tab and breaks every
    // other pane — measured: foregrounding one pane took the other from a live
    // stream to 0 frames in 4s, because panes share a browser process.
    //
    // Focus emulation is the way out: it makes each target behave as focused
    // independently, which is how Playwright keeps several pages live at once.
    await pane.chrome.cdp
      .send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)
      .catch(() => {});
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
    if (pane.attached) {
      await this._startScreencast(pane);
      // A page that is not repainting emits nothing, and a tab switch has to
      // repaint by definition — the viewer is looking at different content.
      // One explicit capture guarantees the first frame instead of waiting for
      // the page to happen to change.
      await this._captureOnce(pane);
    }
  }

  /**
   * Push a single frame immediately, independent of the screencast.
   * Used where the pane must change what it shows even though the page itself
   * is static: switching tabs, and re-attaching to an idle page.
   */
  async _captureOnce(pane) {
    const tab = pane.tabs.get(pane.activeTabId);
    if (!tab) return;
    try {
      const shot = await pane.chrome.cdp.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: SCREENCAST.quality, captureBeyondViewport: false },
        tab.sessionId
      );
      if (shot?.data) {
        pane.lastEmitAt = Date.now();
        this.emit('frame', { paneId: pane.id, tabId: pane.activeTabId, data: shot.data, metadata: {} });
      }
    } catch {
      // Not fatal: the screencast still delivers as soon as the page paints.
    }
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
          // Chrome renders at CHROME_DEVICE_SCALE regardless of what the client
          // asked for, so the cap has to allow those pixels through. Capping at
          // the client's own ratio instead would make Chrome downscale, undoing
          // the reason the flag is there.
          maxWidth: pane.viewport.width * CHROME_DEVICE_SCALE,
          maxHeight: pane.viewport.height * CHROME_DEVICE_SCALE,
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

    // These listeners live on a connection SHARED by every pane on the profile,
    // and several of the events are browser-level rather than per-target, so
    // every pane's handler runs for every pane's event. Two consequences, both
    // of which bit: they must be removed when the pane goes away, or each pane
    // ever opened leaves six behind for the life of the process; and one that
    // is already in flight can still arrive after the pane is deleted, which
    // crashed the agent outright —
    //
    //   TypeError: Cannot read properties of null (reading 'tabs')
    //       at BrowserPaneService._emitTabs
    //
    // because describe() returns null for a pane no longer in the map. Wiring
    // through this helper gives both the guard and the handle to unwire.
    this._unwireBrowserEvents(pane);
    const listeners = [];
    const on = (event, handler) => {
      const guarded = (...args) => {
        if (!this.panes.has(pane.id)) return undefined;
        return handler(...args);
      };
      cdp.on(event, guarded);
      listeners.push([event, guarded]);
    };
    pane.cdpListeners = { cdp, listeners };

    on('Page.screencastFrame', (params, sessionId) => {
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
    on('Target.targetInfoChanged', ({ targetInfo }) => {
      const tab = pane.tabs.get(targetInfo.targetId);
      if (!tab) return;
      tab.url = targetInfo.url;
      tab.title = targetInfo.title || targetInfo.url;
      this._emitTabs(pane);
      // Navigation is the only way a tab's URL ever changes, and without this
      // the file keeps the URL the tab was CREATED with — so a pane restored
      // after an agent restart came back as about:blank having lost wherever
      // you had browsed to. Debounced because this fires several times per page
      // load (each redirect, each title change).
      this._schedulePersist();
    });

    // A page opened with target=_blank or window.open becomes a new target
    // rather than a navigation. Adopting it as a tab in the pane that opened it
    // is what a browser does; without this the click appears to do nothing and
    // an invisible page runs on in the background.
    on('Target.targetCreated', async ({ targetInfo }) => {
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

    on('Target.targetDestroyed', ({ targetId }) => {
      if (!pane.tabs.has(targetId)) return;
      pane.tabs.delete(targetId);
      if (pane.activeTabId === targetId) {
        pane.activeTabId = [...pane.tabs.keys()][0] || null;
        if (pane.activeTabId) this._activate(pane, pane.activeTabId).catch(() => {});
      }
      this._emitTabs(pane);
      this.persist();
    });

    // A renderer that crashes stops painting and says nothing else: the pane
    // simply stops updating, which is indistinguishable from a page that is
    // busy. Chrome reports it at the browser level with the target id, so the
    // pane can say so and reload the tab rather than sit there frozen.
    on('Target.targetCrashed', ({ targetId, status }) => {
      const tab = pane.tabs.get(targetId);
      if (!tab) return;
      this.emit('error', {
        paneId: pane.id,
        message: `The page crashed (${status || 'unknown'}). Reloading.`,
      });
      cdp.send('Page.reload', {}, tab.sessionId).catch(() => {});
    });

    // A page's own alert()/confirm() blocks its renderer until something
    // answers it, and nothing here can: there is no chrome around the page to
    // show a dialog in. Left alone, the tab stops painting and every later CDP
    // command against it times out. Dismissing keeps the tab usable; the cost
    // is that a confirm() always reads as Cancel.
    on('Page.javascriptDialogOpening', (params, sessionId) => {
      cdp.sendNoReply('Page.handleJavaScriptDialog', { accept: false }, sessionId);
      this.emit('dialog', { paneId: pane.id, type: params.type, message: params.message });
    });
  }

  /** Detach this pane's listeners from the shared CDP connection. Idempotent. */
  _unwireBrowserEvents(pane) {
    const wired = pane.cdpListeners;
    if (!wired) return;
    for (const [event, handler] of wired.listeners) {
      wired.cdp.off(event, handler);
    }
    pane.cdpListeners = null;
  }

  _emitTabs(pane) {
    const info = this.describe(pane.id);
    // Gone between the event and here: closePane removes the pane from the map
    // while Chrome may still be delivering events about its tabs.
    if (!info) return;
    this.emit('tabs', {
      paneId: pane.id,
      tabs: info.tabs,
      activeTabId: pane.activeTabId,
    });
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export const browserPaneService = new BrowserPaneService();
