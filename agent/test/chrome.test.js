import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChromeArgs, findChromeBinary, DEFAULT_PROFILE_DIR } from '../services/chrome.js';

test('CHROME_BIN wins and suppresses the search', () => {
  // An existing file that is certainly not Chrome: the point is that the
  // override is honoured verbatim rather than second-guessed.
  assert.equal(findChromeBinary({ CHROME_BIN: process.execPath }), process.execPath);
});

test('a CHROME_BIN that does not exist resolves to null rather than falling back', () => {
  // Silently launching a different browser than the one that was named would
  // be worse than reporting that the configured one is missing.
  assert.equal(findChromeBinary({ CHROME_BIN: '/nope/not/here' }), null);
});

test('the debugging port is never published beyond loopback', () => {
  // CDP is unauthenticated and total control of the browser. This assertion is
  // the security boundary for the whole feature.
  const args = buildChromeArgs('/tmp/profile');
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
});

test('the debugging port is OS-assigned', () => {
  // A fixed port would collide with a second pane, or with a Chrome the user
  // started themselves on the conventional 9222.
  const args = buildChromeArgs('/tmp/profile');
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(!args.some((a) => /^--remote-debugging-port=(?!0$)/.test(a)));
});

test('the profile directory is passed through as given', () => {
  const args = buildChromeArgs('/tmp/some profile/dir');
  assert.ok(args.includes('--user-data-dir=/tmp/some profile/dir'));
});

test('headless=new is used, not the legacy headless', () => {
  // Page.startScreencast — the entire rendering mechanism — needs the new
  // headless implementation.
  const args = buildChromeArgs('/tmp/profile');
  assert.ok(args.includes('--headless=new'));
});

test('background throttling is disabled', () => {
  // Chrome believes these windows are hidden, and would throttle timers and
  // rendering in them. The pane is exactly such a window.
  const args = buildChromeArgs('/tmp/profile');
  for (const flag of [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
});

test('the default profile is inside the agent state directory', () => {
  // Not the user's everyday Chrome profile: a pane is reachable by anyone who
  // can reach the canvas.
  assert.match(DEFAULT_PROFILE_DIR, /browser-profiles[/\\]default$/);
  assert.ok(!DEFAULT_PROFILE_DIR.includes('Library/Application Support/Google'));
});
