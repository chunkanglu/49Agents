import test from 'node:test';
import assert from 'node:assert/strict';

import { normaliseUrl } from '../services/browserPanes.js';

test('a bare hostname becomes https, not http', () => {
  // The iframe pane prefixes http:// and that choice is load-bearing there
  // (local dev servers). A real browser pane has no such constraint, so it
  // should default to the secure scheme the way an address bar does.
  assert.equal(normaliseUrl('example.com'), 'https://example.com/');
});

test('an explicit scheme is preserved', () => {
  assert.equal(normaliseUrl('http://localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(normaliseUrl('https://example.com/a?b=c'), 'https://example.com/a?b=c');
});

test('empty input opens a blank tab', () => {
  assert.equal(normaliseUrl(''), 'about:blank');
  assert.equal(normaliseUrl(undefined), 'about:blank');
  assert.equal(normaliseUrl('about:blank'), 'about:blank');
});

test('file: URLs are refused', () => {
  // A pane is drivable by anyone who can reach the canvas. Allowing file://
  // would turn it into a file browser for the whole machine.
  assert.throws(() => normaliseUrl('file:///etc/passwd'), /http and https only/);
});

test('javascript: URLs are refused', () => {
  assert.throws(() => normaliseUrl('javascript:fetch("/steal")'), /http and https only/);
});

test('other schemes are refused rather than silently prefixed', () => {
  // The prefixing rule must not turn a rejected scheme into an accepted one.
  assert.throws(() => normaliseUrl('chrome://settings'), /http and https only/);
  assert.throws(() => normaliseUrl('data:text/html,<script>1</script>'), /http and https only/);
});

test('surrounding whitespace is trimmed', () => {
  assert.equal(normaliseUrl('  example.com  '), 'https://example.com/');
});

test('unparseable input reports itself rather than becoming a search', () => {
  assert.throws(() => normaliseUrl('http://['), /Not a valid URL/);
});

test('host:port is a host and a port, not a scheme', () => {
  // The reported bug: "localhost:3000" matched a naive scheme regex, so the
  // pane refused to open the single most common thing anyone would type.
  assert.equal(normaliseUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normaliseUrl('127.0.0.1:8080/app'), 'http://127.0.0.1:8080/app');
});

test('local addresses default to http, public ones to https', () => {
  // A dev server or a box on the LAN or tailnet is almost never serving TLS,
  // and guessing https there fails the handshake instead of loading the page.
  assert.equal(normaliseUrl('localhost'), 'http://localhost/');
  assert.equal(normaliseUrl('192.168.1.10:3000'), 'http://192.168.1.10:3000/');
  assert.equal(normaliseUrl('100.67.102.37:1071'), 'http://100.67.102.37:1071/');
  assert.equal(normaliseUrl('mybox.local'), 'http://mybox.local/');
  assert.equal(normaliseUrl('example.com'), 'https://example.com/');
  assert.equal(normaliseUrl('example.com:8443'), 'https://example.com:8443/');
});

test('an explicit scheme still wins over the local guess', () => {
  assert.equal(normaliseUrl('https://localhost:3000'), 'https://localhost:3000/');
  assert.equal(normaliseUrl('http://example.com'), 'http://example.com/');
});
