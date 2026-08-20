// ─── Browser panes ────────────────────────────────────────────────────────
// A real Chrome, rendered into a pane. The agent streams JPEG frames of the
// active tab and accepts input events; this module paints those frames and
// turns pointer and keyboard activity back into them.
//
// The pane exists because iframe panes cannot show most of the web: sites
// refuse to be framed (github.com sends `x-frame-options: deny`, google.com
// and app.shortcut.com send SAMEORIGIN), and that is the remote site's header,
// so nothing on this end can change it. A browser pane is not subject to it
// because there is no framing — Chrome loads the page as itself.
//
// Structurally this is the terminal pane with a different renderer: xterm.js
// draws cells from a byte stream, this draws frames from an image stream, and
// both forward input over the same relay.

import { escapeHtml, truncateUrl } from './utils.js';
import { sendWs } from './ws-transport.js';
import { setupPaneListeners } from './pane-interaction.js';

let _ctx = null;

export function initBrowserPaneDeps(ctx) { _ctx = ctx; }

// paneId -> { canvas, ctx2d, tabsEl, urlInput, tabs, activeTabId, lastViewport }
const browserPanes = new Map();

export function getBrowserPane(paneId) { return browserPanes.get(paneId); }

// ── rendering ─────────────────────────────────────────────────────────────

/**
 * Paint a frame. Frames are base64 JPEG; createImageBitmap decodes off the
 * main thread, which matters at 20fps — an <img> src assignment decodes
 * synchronously on decode-heavy pages and shows up as canvas jank.
 */
export async function drawBrowserFrame(paneId, base64Data) {
  const entry = browserPanes.get(paneId);
  if (!entry) return;

  try {
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));

    // Chrome renders at the size it was told, which is the size this pane
    // asked for, so the frame maps 1:1 onto the canvas backing store. Anything
    // else here would be a resize race, not a scaling decision.
    if (entry.canvas.width !== bitmap.width || entry.canvas.height !== bitmap.height) {
      entry.canvas.width = bitmap.width;
      entry.canvas.height = bitmap.height;
    }
    entry.ctx2d.drawImage(bitmap, 0, 0);
    bitmap.close();
    entry.loadingEl?.remove();
    entry.loadingEl = null;
    // Frames are arriving again, so whatever the last failure said is no
    // longer true.
    entry.canvas.parentElement?.querySelector('.browser-error')?.remove();
  } catch {
    // A corrupt frame is not worth tearing the pane down for; the next one
    // repaints the whole viewport anyway.
  }
}

/**
 * Replace the loading overlay with the reason nothing is coming. Only for
 * errors that end the pane's session — a transient one would clear itself on
 * the next frame, and overwriting a working view with an error would be worse
 * than saying nothing.
 */
export function showBrowserPaneError(paneId, message) {
  const entry = browserPanes.get(paneId);
  if (!entry) return;
  const content = entry.canvas.parentElement;
  if (!content) return;

  entry.loadingEl?.remove();
  entry.loadingEl = null;

  let errorEl = content.querySelector('.browser-error');
  if (!errorEl) {
    errorEl = document.createElement('div');
    errorEl.className = 'browser-loading browser-error';
    content.appendChild(errorEl);
  }
  errorEl.textContent = message;
}

export function updateBrowserTabs(paneId, tabs, activeTabId) {
  const entry = browserPanes.get(paneId);
  if (!entry) return;
  entry.tabs = tabs;
  entry.activeTabId = activeTabId;
  renderTabStrip(paneId);

  const active = tabs.find((t) => t.active);
  if (active && document.activeElement !== entry.urlInput) {
    entry.urlInput.value = active.url === 'about:blank' ? '' : active.url;
  }
  const title = document.querySelector(`#pane-${paneId} .pane-title`);
  if (title) title.textContent = `🌐 ${active ? truncateUrl(active.title || active.url) : 'Browser'}`;
}

function renderTabStrip(paneId) {
  const entry = browserPanes.get(paneId);
  if (!entry) return;

  entry.tabsEl.innerHTML = '';
  for (const tab of entry.tabs) {
    const el = document.createElement('div');
    el.className = `browser-tab${tab.active ? ' active' : ''}`;
    // A tab restored from disk has no CDP target yet, so it cannot be selected
    // or closed until the pane attaches. Showing it greyed is better than
    // showing an empty strip and then having tabs appear.
    if (tab.pending) el.classList.add('pending');
    el.title = tab.url;
    el.innerHTML =
      `<span class="browser-tab-title">${escapeHtml(tab.title || tab.url || 'New tab')}</span>` +
      '<button class="browser-tab-close" aria-label="Close tab">&times;</button>';

    el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (e.target.closest('.browser-tab-close')) return;
      if (!tab.id || tab.active) return;
      send(paneId, 'browser:tab:select', { tabId: tab.id });
    });
    el.querySelector('.browser-tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!tab.id) return;
      send(paneId, 'browser:tab:close', { tabId: tab.id });
    });
    entry.tabsEl.appendChild(el);
  }

  const newTab = document.createElement('button');
  newTab.className = 'browser-tab-new';
  newTab.textContent = '+';
  newTab.setAttribute('aria-label', 'New tab');
  newTab.addEventListener('click', (e) => {
    e.stopPropagation();
    send(paneId, 'browser:tab:new', { url: 'about:blank' });
  });
  entry.tabsEl.appendChild(newTab);
}

// ── pane construction ─────────────────────────────────────────────────────

export function renderBrowserPane(paneData) {
  const existing = document.getElementById(`pane-${paneData.id}`);
  if (existing) existing.remove();

  const pane = document.createElement('div');
  pane.className = 'pane browser-pane';
  pane.id = `pane-${paneData.id}`;
  pane.style.left = `${paneData.x}px`;
  pane.style.top = `${paneData.y}px`;
  pane.style.width = `${paneData.width}px`;
  pane.style.height = `${paneData.height}px`;
  pane.style.zIndex = paneData.zIndex;
  pane.dataset.paneId = paneData.id;

  if (!paneData.shortcutNumber) paneData.shortcutNumber = _ctx.getNextShortcutNumber();

  pane.innerHTML = `
    <div class="pane-header">
      <span class="pane-title">🌐 Browser</span>
      ${_ctx.paneNameHtml(paneData)}
      <div class="pane-header-right">
        ${_ctx.shortcutBadgeHtml(paneData)}
        <button class="pane-expand" aria-label="Expand pane" data-tooltip="Expand"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 9 4 4 9 4"/><polyline points="15 4 20 4 20 9"/><polyline points="20 15 20 20 15 20"/><polyline points="9 20 4 20 4 15"/></svg></button>
        <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>
    <div class="browser-tabs"></div>
    <div class="browser-toolbar">
      <button class="browser-nav" data-action="back" aria-label="Back" data-tooltip="Back">‹</button>
      <button class="browser-nav" data-action="forward" aria-label="Forward" data-tooltip="Forward">›</button>
      <button class="browser-nav" data-action="reload" aria-label="Reload" data-tooltip="Reload">⟳</button>
      <input class="browser-url" type="text" spellcheck="false" placeholder="Search or enter address" />
    </div>
    <div class="pane-content browser-content">
      <canvas class="browser-canvas"></canvas>
      <div class="browser-loading">Starting Chrome…</div>
    </div>
    <div class="pane-resize-handle"></div>
    <div class="pane-resize-handle-left"></div>
  `;

  setupPaneListeners(pane, paneData);
  _ctx.getCanvas().appendChild(pane);

  const canvas = pane.querySelector('.browser-canvas');
  const entry = {
    canvas,
    ctx2d: canvas.getContext('2d'),
    tabsEl: pane.querySelector('.browser-tabs'),
    urlInput: pane.querySelector('.browser-url'),
    loadingEl: pane.querySelector('.browser-loading'),
    tabs: paneData.tabs || [],
    activeTabId: paneData.activeTabId || null,
    lastViewport: { width: 0, height: 0 },
  };
  browserPanes.set(paneData.id, entry);

  wireToolbar(pane, paneData);
  wireInput(pane, paneData);
  renderTabStrip(paneData.id);

  // Attach once the pane has a real size — the agent sizes Chrome from this,
  // and a zero-height content box would render a 200px-tall page.
  requestAnimationFrame(() => syncViewport(paneData, { attach: true }));

  const observer = new ResizeObserver(() => syncViewport(paneData, { attach: false }));
  observer.observe(pane.querySelector('.browser-content'));
  entry.observer = observer;

  return pane;
}

export function destroyBrowserPane(paneId) {
  const entry = browserPanes.get(paneId);
  if (!entry) return;
  entry.observer?.disconnect();
  browserPanes.delete(paneId);
}

// ── plumbing ──────────────────────────────────────────────────────────────

function send(paneId, type, payload) {
  const paneData = _ctx.state.panes.find((p) => p.id === paneId);
  sendWs(type, { paneId, ...payload }, paneData?.agentId);
}

function viewportOf(paneEl) {
  const content = paneEl.querySelector('.browser-content');
  return {
    width: Math.max(200, Math.round(content.clientWidth)),
    height: Math.max(200, Math.round(content.clientHeight)),
  };
}

/**
 * How many device pixels Chrome should render per CSS pixel.
 *
 * Rendering at 1 and then displaying on a Retina screen means the canvas is
 * upscaled 2x by the compositor, which is the whole reason text looked soft.
 * The board's zoom multiplies that again, so it is folded in — zoom past 1 and
 * the pane is being magnified as well.
 *
 * Capped at 2: pixels are quadratic in this number, and a frame that grows past
 * the relay's 1MB limit disconnects the agent rather than merely looking bad.
 */
function scaleFactorFor() {
  const zoom = _ctx.state?.zoom || 1;
  return Math.min(2, Math.max(1, (window.devicePixelRatio || 1) * zoom));
}

let resizeTimer = null;
function syncViewport(paneData, { attach }) {
  const paneEl = document.getElementById(`pane-${paneData.id}`);
  const entry = browserPanes.get(paneData.id);
  if (!paneEl || !entry) return;

  const { width, height } = viewportOf(paneEl);
  if (!attach && width === entry.lastViewport.width && height === entry.lastViewport.height) return;
  entry.lastViewport = { width, height };

  if (attach) {
    send(paneData.id, 'browser:attach', { width, height, deviceScaleFactor: scaleFactorFor() });
    return;
  }
  // Debounced: a drag-resize fires continuously, and each resize makes Chrome
  // relayout the page.
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    send(paneData.id, 'browser:resize', { width, height, deviceScaleFactor: scaleFactorFor() });
  }, 120);
}

function wireToolbar(paneEl, paneData) {
  const entry = browserPanes.get(paneData.id);

  paneEl.querySelectorAll('.browser-nav').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      send(paneData.id, 'browser:history', { action: btn.dataset.action });
    });
  });

  entry.urlInput.addEventListener('keydown', (e) => {
    // The canvas binds single-key shortcuts on document; without this, typing
    // an address drives the canvas instead of the address bar.
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    const value = entry.urlInput.value.trim();
    if (value) send(paneData.id, 'browser:navigate', { url: value });
  });
  entry.urlInput.addEventListener('mousedown', (e) => e.stopPropagation());
}

/**
 * Forward pointer and keyboard activity as CDP input events.
 *
 * Coordinates are converted exactly once, here: the canvas is rendered at the
 * pane's own scale, and the canvas may additionally be zoomed by the board. A
 * second conversion anywhere downstream is what makes clicks land tens of
 * pixels away from the cursor, so the agent takes CSS pixels and does no
 * arithmetic of its own.
 */
function wireInput(paneEl, paneData) {
  const entry = browserPanes.get(paneData.id);
  const canvas = entry.canvas;
  let buttonsDown = 0;

  const pointOf = (e) => {
    const rect = canvas.getBoundingClientRect();
    // rect is already in screen pixels including every enclosing scale, so
    // dividing by its own dimensions gives a scale-free fraction of the
    // viewport, which then maps onto the size the agent rendered.
    // Fractions of the viewport, so this is unaffected by the device pixel
    // ratio and by the board's zoom: CDP wants CSS pixels of the emulated
    // viewport, which is what lastViewport holds.
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    return {
      x: Math.round(fx * entry.lastViewport.width),
      y: Math.round(fy * entry.lastViewport.height),
    };
  };

  const CDP_BUTTONS = ['left', 'middle', 'right'];

  canvas.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    canvas.focus();
    buttonsDown |= 1 << e.button;
    send(paneData.id, 'browser:input', {
      kind: 'mouse',
      event: { type: 'mousePressed', ...pointOf(e), button: CDP_BUTTONS[e.button] || 'left', buttons: buttonsDown, clickCount: e.detail || 1, modifiers: modifiersOf(e) },
    });
  });

  canvas.addEventListener('mouseup', (e) => {
    // Deliberately NOT stopPropagation. Canvas gestures (middle-drag pan,
    // rubber-band select) start on a container-level capture listener and end
    // on a document-level mouseup, so swallowing mouseup here strands whichever
    // one is in flight — the pan never releases and the cursor stays grabbing
    // with no way out. Mousedown is still stopped, which is what keeps a click
    // inside the page from dragging the pane.
    buttonsDown &= ~(1 << e.button);
    send(paneData.id, 'browser:input', {
      kind: 'mouse',
      event: { type: 'mouseReleased', ...pointOf(e), button: CDP_BUTTONS[e.button] || 'left', buttons: buttonsDown, clickCount: e.detail || 1, modifiers: modifiersOf(e) },
    });
  });

  // Throttled to animation frames: hover effects need movement, but one
  // message per mousemove event would swamp the relay on a fast drag.
  let movePending = null;
  canvas.addEventListener('mousemove', (e) => {
    if (movePending) { movePending = e; return; }
    movePending = e;
    requestAnimationFrame(() => {
      const ev = movePending;
      movePending = null;
      if (!ev) return;
      send(paneData.id, 'browser:input', {
        kind: 'mouse',
        event: { type: 'mouseMoved', ...pointOf(ev), button: 'none', buttons: buttonsDown, modifiers: modifiersOf(ev) },
      });
    });
  });

  canvas.addEventListener('wheel', (e) => {
    if (_ctx.getTabHeld()) return; // Tab+scroll pans the board
    e.stopPropagation();
    e.preventDefault();
    send(paneData.id, 'browser:input', {
      kind: 'mouse',
      event: { type: 'mouseWheel', ...pointOf(e), button: 'none', buttons: buttonsDown, deltaX: -e.deltaX, deltaY: -e.deltaY, modifiers: modifiersOf(e) },
    });
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // A canvas is not focusable by default, and without focus there are no key
  // events to forward.
  canvas.tabIndex = 0;

  canvas.addEventListener('keydown', (e) => {
    e.stopPropagation();
    // Let the browser's own reload/devtools/tab-switch shortcuts through.
    if (e.metaKey && ['r', 'w', 't', 'q'].includes(e.key.toLowerCase())) return;
    e.preventDefault();

    send(paneData.id, 'browser:input', {
      kind: 'key',
      event: {
        type: e.key.length === 1 && !e.ctrlKey && !e.metaKey ? 'keyDown' : 'rawKeyDown',
        key: e.key,
        code: e.code,
        text: e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : undefined,
        windowsVirtualKeyCode: e.keyCode,
        nativeVirtualKeyCode: e.keyCode,
        modifiers: modifiersOf(e),
      },
    });
  });

  canvas.addEventListener('keyup', (e) => {
    e.stopPropagation();
    send(paneData.id, 'browser:input', {
      kind: 'key',
      event: { type: 'keyUp', key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers: modifiersOf(e) },
    });
  });

  // Paste arrives as one event rather than a key sequence, and insertText is
  // the only way to get multi-character content in without synthesising a
  // keystroke per character.
  canvas.addEventListener('paste', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain');
    if (text) send(paneData.id, 'browser:input', { kind: 'text', text });
  });
}

// CDP packs modifiers into a bitfield: alt 1, ctrl 2, meta 4, shift 8.
function modifiersOf(e) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}
