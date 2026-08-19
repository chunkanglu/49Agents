import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

import { CdpConnection } from '../services/cdp.js';

/**
 * Stand in for Chrome: a WebSocket server that speaks the same JSON-RPC shape.
 * `onMessage` receives each parsed command and may reply via the send helper.
 */
async function withFakeChrome(onMessage, fn) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  const url = `ws://127.0.0.1:${wss.address().port}`;

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      onMessage(JSON.parse(raw.toString()), (obj) => ws.send(JSON.stringify(obj)));
    });
  });

  const cdp = new CdpConnection(url);
  await cdp.connect();
  try {
    await fn(cdp, wss);
  } finally {
    cdp.close();
    await new Promise((resolve) => wss.close(resolve));
  }
}

test('send resolves with the command result', async () => {
  await withFakeChrome(
    (msg, reply) => reply({ id: msg.id, result: { targetId: 'T1', echoedUrl: msg.params.url } }),
    async (cdp) => {
      const result = await cdp.send('Target.createTarget', { url: 'https://example.com' });
      assert.equal(result.targetId, 'T1');
      assert.equal(result.echoedUrl, 'https://example.com');
    }
  );
});

test('send rejects when Chrome reports an error', async () => {
  await withFakeChrome(
    (msg, reply) => reply({ id: msg.id, error: { code: -32000, message: 'No target with given id' } }),
    async (cdp) => {
      await assert.rejects(
        () => cdp.send('Target.attachToTarget', { targetId: 'gone' }),
        /No target with given id/
      );
    }
  );
});

test('sessionId is included only when given', async () => {
  const seen = [];
  await withFakeChrome(
    (msg, reply) => { seen.push(msg); reply({ id: msg.id, result: {} }); },
    async (cdp) => {
      await cdp.send('Page.enable', {}, 'SESSION-1');
      await cdp.send('Target.getTargets');
      assert.equal(seen[0].sessionId, 'SESSION-1');
      assert.ok(!('sessionId' in seen[1]));
    }
  );
});

test('events are emitted per method and on the firehose', async () => {
  await withFakeChrome(
    (msg, reply) => {
      reply({ id: msg.id, result: {} });
      reply({ method: 'Page.screencastFrame', params: { data: 'AAA', sessionId: 'ignored' }, sessionId: 'S1' });
    },
    async (cdp) => {
      const perMethod = new Promise((resolve) =>
        cdp.once('Page.screencastFrame', (params, sessionId) => resolve({ params, sessionId }))
      );
      const firehose = new Promise((resolve) => cdp.once('event', resolve));
      await cdp.send('Page.enable', {}, 'S1');

      const one = await perMethod;
      assert.equal(one.params.data, 'AAA');
      assert.equal(one.sessionId, 'S1');
      assert.equal((await firehose).method, 'Page.screencastFrame');
    }
  );
});

test('pending commands reject when the connection closes', async () => {
  // A wedged renderer never replies. Closing must not leave the caller hanging
  // on a promise that can no longer settle.
  await withFakeChrome(
    () => {}, // deliberately never replies
    async (cdp) => {
      const pending = cdp.send('Page.navigate', { url: 'https://example.com' });
      cdp.close();
      await assert.rejects(() => pending, /CDP connection closed/);
    }
  );
});

test('send rejects instead of throwing once closed', async () => {
  await withFakeChrome(
    (msg, reply) => reply({ id: msg.id, result: {} }),
    async (cdp) => {
      cdp.close();
      await assert.rejects(() => cdp.send('Page.enable'), /CDP not connected/);
    }
  );
});
