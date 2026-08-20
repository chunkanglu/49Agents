// ─── Chrome process manager ───────────────────────────────────────────────
// Launches and pools the Chrome instances that back browser panes.
//
// One process per profile directory, not per pane. Chrome costs a few hundred
// megabytes to start, and a pane is a set of tabs — which is what a single
// Chrome already is. So the layering mirrors tmux exactly: one server process,
// many sessions inside it.
//
//   tmux server  : tmux session : window     ==     Chrome process : pane : tab
//
// Panes on the same profile share a process and therefore share cookies, the
// same way tabs in a normal browser window do. A pane that opts into a
// different profile directory gets its own process, because a profile is fixed
// at launch — Chrome cannot switch --user-data-dir at runtime.

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync } from 'fs';
import { EventEmitter } from 'events';
import { join } from 'path';

import { config } from '../src/config.js';
import { CdpConnection } from './cdp.js';

// Where a pane's cookies and logins live when it does not name a profile.
// Deliberately NOT the user's real Chrome profile: a browser pane is reachable
// by anyone who can reach the canvas, and pointing it at the everyday profile
// would hand all of them that browser's logged-in sessions. Opting a pane into
// another profile is a per-pane setting, so that stays a deliberate act.
export const DEFAULT_PROFILE_DIR = join(config.dataDir, 'browser-profiles', 'default');

// Candidate binaries, in preference order. Chrome first because the screencast
// path is best tested there; the others speak the same protocol.
const BINARY_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

const LAUNCH_TIMEOUT_MS = 20000;

// Device pixels per CSS pixel that Chrome renders at.
//
// Page.startScreencast captures in DIPs and ignores the deviceScaleFactor from
// Emulation.setDeviceMetricsOverride — that call changes what the *page* sees
// in window.devicePixelRatio, but the frame still comes back at CSS size.
// Measured on a 1000x700 viewport: dsf via Emulation gives a 1000x700 JPEG,
// this flag gives 2000x1400. Displayed on any HiDPI screen the first is
// upscaled by the compositor, which is what made text look soft.
//
// It is a launch flag, so it applies to every pane on the profile. 2 covers
// current Retina and most high-DPI displays; a 1x client simply downsamples,
// which costs bandwidth but never looks worse.
export const CHROME_DEVICE_SCALE = 2;

/**
 * Locate a Chromium-family binary. CHROME_BIN wins and suppresses the search,
 * so an unusual install can be pointed at directly.
 * @returns {string|null}
 */
export function findChromeBinary(env = process.env) {
  if (env.CHROME_BIN) return existsSync(env.CHROME_BIN) ? env.CHROME_BIN : null;
  for (const candidate of BINARY_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Build the argument list for a Chrome launch.
 * Exported for the tests: the flags are the security-relevant part of this
 * module, and asserting on them is cheaper than asserting on a live process.
 */
export function buildChromeArgs(profileDir) {
  return [
    // headless=new renders the real page (not the old cut-down headless) and
    // supports Page.startScreencast, which is the whole mechanism here.
    '--headless=new',
    // Port 0 = let the OS pick. Panes must not collide with each other or with
    // a Chrome the user started themselves on the conventional 9222.
    '--remote-debugging-port=0',
    // CDP is unauthenticated and total control of the browser: arbitrary JS,
    // cookie access, file:// reads. It must never leave this machine. Pinned
    // for the same reason ttyd is pinned to loopback — the agent is its only
    // client, and the frames reach the canvas over the existing relay.
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--force-device-scale-factor=${CHROME_DEVICE_SCALE}`,
    // Nothing renders on a real display, so keep Chrome from throttling work
    // in what it believes are hidden windows — the pane is exactly that.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    'about:blank',
  ];
}

/**
 * A running Chrome plus its CDP connection, shared by every pane on one profile.
 */
class ChromeInstance extends EventEmitter {
  constructor(profileDir) {
    super();
    this.profileDir = profileDir;
    this.proc = null;
    this.cdp = null;
    this.adopted = false;
    this.adoptedPid = null;
    this.refCount = 0;
  }

  /**
   * The debugger endpoint of a Chrome already running on this profile.
   *
   * Chrome writes its OS-assigned port and browser path to DevToolsActivePort
   * inside the profile, which is the only way to find an instance whose port we
   * did not choose. Returns null when the file is absent or malformed.
   */
  _existingEndpoint() {
    try {
      const raw = readFileSync(join(this.profileDir, 'DevToolsActivePort'), 'utf-8').split('\n');
      const port = parseInt(raw[0], 10);
      const path = (raw[1] || '').trim();
      if (!port || !path) return null;
      return `ws://127.0.0.1:${port}${path}`;
    } catch {
      return null;
    }
  }

  /**
   * Chrome refuses to start on a profile another Chrome holds, exiting 21 and
   * printing nothing useful. The lock is three symlinks in the profile; they
   * outlive a Chrome that was SIGKILLed, which is exactly what happens when
   * `49ctl stop` escalates from TERM to KILL faster than the agent's shutdown
   * handler runs.
   *
   * Only ever called once the endpoint has been proven dead, so no live browser
   * can be unlocked out from under itself.
   */
  /**
   * The pid Chrome recorded in SingletonLock, which is a symlink named
   * `<host>-<pid>`. The only handle on a browser this process did not spawn.
   */
  _lockHolderPid() {
    try {
      const target = readlinkSync(join(this.profileDir, 'SingletonLock'));
      const pid = parseInt(target.split('-').pop(), 10);
      return Number.isInteger(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  _clearStaleLock() {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
      try {
        rmSync(join(this.profileDir, name), { force: true });
      } catch {
        // Best effort: a lock we cannot remove will simply fail the launch
        // again, with the same clear error.
      }
    }
  }

  async start() {
    const binary = findChromeBinary();
    if (!binary) {
      throw new Error(
        'No Chrome/Chromium found. Install Google Chrome, or set CHROME_BIN to the binary.'
      );
    }
    if (!existsSync(this.profileDir)) mkdirSync(this.profileDir, { recursive: true });

    // Adopt a Chrome that is already on this profile rather than fighting it.
    // The common case is an agent restart: the old agent's Chrome survives
    // (see _clearStaleLock), and adopting it means the panes come back with
    // their tabs still open instead of the launch failing with exit 21.
    const existing = this._existingEndpoint();
    if (existing) {
      try {
        this.cdp = new CdpConnection(existing);
        await this.cdp.connect();
        // Connecting is not enough. A Chrome that is shutting down still
        // accepts the socket and then drops it, which happens whenever an
        // agent restarts fast enough to overlap its predecessor's exit. One
        // round trip proves the browser is actually alive and serving.
        await this.cdp.send('Browser.getVersion');
        this.adopted = true;
        this.adoptedPid = this._lockHolderPid();
        // Same safety as the spawned path: if this browser goes away, the
        // instance must leave the pool rather than be handed to another pane.
        this.cdp.once('close', () => this.emit('exit', { code: null, signal: 'socket-closed' }));
        return this;
      } catch {
        // Nothing is listening, or what answered is on its way out. Either
        // way the lock beside the port file is stale.
        if (this.cdp) this.cdp.close();
        this.cdp = null;
        this._clearStaleLock();
      }
    }

    this.proc = spawn(binary, buildChromeArgs(this.profileDir), { stdio: ['ignore', 'pipe', 'pipe'] });

    let wsUrl;
    try {
      wsUrl = await this._readDevToolsUrl();
    } catch (err) {
      // Exit 21 is Chrome's "this profile is in use". Reaching here means the
      // endpoint check above found nothing to adopt, so the holder is gone and
      // the lock is stale; clear it and try once more.
      if (/code 21/.test(err.message)) {
        this._clearStaleLock();
        this.proc = spawn(binary, buildChromeArgs(this.profileDir), { stdio: ['ignore', 'pipe', 'pipe'] });
        wsUrl = await this._readDevToolsUrl();
      } else {
        throw err;
      }
    }

    this.cdp = new CdpConnection(wsUrl);
    await this.cdp.connect();

    this.proc.once('exit', (code, signal) => {
      this.emit('exit', { code, signal });
    });

    // A crash or an outside `kill` closes the socket without an exit event we
    // own (an adopted browser has no child handle at all). Either way the
    // instance is unusable and must not be handed to the next pane.
    this.cdp.once('close', () => this.emit('exit', { code: null, signal: 'socket-closed' }));

    return this;
  }

  /**
   * Chrome prints its debugger URL on stderr once, at startup. There is a
   * /json/version endpoint too, but it needs the port — which is the thing
   * being discovered, since the port is assigned by the OS.
   */
  _readDevToolsUrl() {
    return new Promise((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => {
        cleanup();
        this.stop();
        reject(new Error(`Chrome did not report a DevTools URL within ${LAUNCH_TIMEOUT_MS}ms`));
      }, LAUNCH_TIMEOUT_MS);

      const onData = (chunk) => {
        buffered += chunk.toString();
        const match = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          cleanup();
          resolve(match[1]);
        }
      };
      const onExit = (code) => {
        cleanup();
        reject(new Error(`Chrome exited with code ${code} before reporting a DevTools URL`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.proc.stderr.removeListener('data', onData);
        this.proc.removeListener('exit', onExit);
      };

      this.proc.stderr.on('data', onData);
      this.proc.once('exit', onExit);
    });
  }

  stop() {
    // An adopted Chrome has no child handle, so it is killed by pid. Browser.close
    // over CDP was the first attempt and loses the race: shutdown closes the
    // socket and exits the process before the message flushes, leaving the
    // orphan alive and the profile locked — the exact failure adoption exists
    // to end. The pid is in the profile's SingletonLock, where Chrome puts it.
    if (this.adopted && this.adoptedPid) {
      try {
        process.kill(this.adoptedPid);
      } catch {
        // Already gone, which is the desired state anyway.
      }
    }
    if (this.cdp) this.cdp.close();
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
    this.cdp = null;
    this.proc = null;

    // Remove the endpoint file we are about to stop honouring. Chrome deletes
    // it on exit, but not instantly, and a fast restart would otherwise adopt
    // the corpse: the socket still connects for a moment, so even a probe can
    // pass, and every command after that fails with "CDP connection closed".
    this._clearStaleLock();
  }
}

// profileDir -> ChromeInstance
const instances = new Map();
// profileDir -> in-flight start, so two panes opening at once share one launch
const starting = new Map();

/**
 * Acquire the Chrome for a profile, starting it if needed, and take a
 * reference. Every acquire must be paired with a release.
 *
 * @param {string} [profileDir]
 * @returns {Promise<ChromeInstance>}
 */
export async function acquireChrome(profileDir = DEFAULT_PROFILE_DIR) {
  const existing = instances.get(profileDir);
  if (existing) {
    existing.refCount++;
    return existing;
  }

  if (starting.has(profileDir)) {
    const instance = await starting.get(profileDir);
    instance.refCount++;
    return instance;
  }

  const launch = (async () => {
    const instance = new ChromeInstance(profileDir);
    instance.on('exit', () => {
      // A crashed Chrome must not be handed to the next pane that asks.
      if (instances.get(profileDir) === instance) instances.delete(profileDir);
    });
    await instance.start();
    instances.set(profileDir, instance);
    return instance;
  })();

  starting.set(profileDir, launch);
  try {
    const instance = await launch;
    instance.refCount++;
    return instance;
  } finally {
    starting.delete(profileDir);
  }
}

/**
 * Drop a reference, shutting Chrome down when the last pane on that profile
 * goes away. Leaving it running would hold a few hundred megabytes for a pane
 * the user has closed.
 */
export function releaseChrome(profileDir = DEFAULT_PROFILE_DIR) {
  const instance = instances.get(profileDir);
  if (!instance) return;
  instance.refCount--;
  if (instance.refCount > 0) return;
  instances.delete(profileDir);
  instance.stop();
}

/** Shut every Chrome down — used on agent exit. */
export function stopAllChrome() {
  for (const [profileDir, instance] of instances) {
    instances.delete(profileDir);
    instance.stop();
  }
}

/** Test/debug view of the pool. */
export function chromePoolSize() {
  return instances.size;
}
