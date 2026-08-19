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
import { existsSync, mkdirSync } from 'fs';
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
    this.refCount = 0;
  }

  async start() {
    const binary = findChromeBinary();
    if (!binary) {
      throw new Error(
        'No Chrome/Chromium found. Install Google Chrome, or set CHROME_BIN to the binary.'
      );
    }
    if (!existsSync(this.profileDir)) mkdirSync(this.profileDir, { recursive: true });

    this.proc = spawn(binary, buildChromeArgs(this.profileDir), { stdio: ['ignore', 'pipe', 'pipe'] });

    const wsUrl = await this._readDevToolsUrl();
    this.cdp = new CdpConnection(wsUrl);
    await this.cdp.connect();

    this.proc.once('exit', (code, signal) => {
      this.emit('exit', { code, signal });
    });

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
    if (this.cdp) this.cdp.close();
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
    this.cdp = null;
    this.proc = null;
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
