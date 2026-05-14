import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamableHttpServer } from '../dist/server/streamable-http-server.js';

const BASE_OPTIONS = {
  port: 0,
  onRequest: async () => ({ jsonrpc: '2.0', id: 1, result: {} }),
  onNotification: async () => {},
  onResponse: async () => {},
};

test('StreamableHttpServer removes broken SSE streams when sendMessage fails', async () => {
  const server = new StreamableHttpServer(BASE_OPTIONS);

  const sessionId = 'mcp_test_session';
  const goodStream = {
    write: () => true,
    end: () => {},
  };
  const brokenStream = {
    write: () => {
      throw new Error('broken sse stream');
    },
    end: () => {},
  };

  server.sessions.set(sessionId, {
    id: sessionId,
    principal: 'apikey:test',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60000),
    sseStreams: new Set([brokenStream, goodStream]),
    lastActivity: new Date(),
    initialized: true,
  });

  const result = server.sendMessage(sessionId, { type: 'test' });

  assert.equal(result, true);
  const session = server.sessions.get(sessionId);
  assert.ok(session);
  assert.equal(session.sseStreams.size, 1);
  assert.ok(session.sseStreams.has(goodStream));
  assert.ok(!session.sseStreams.has(brokenStream));
});

test('StreamableHttpServer registerSseStream and unregisterSseStream round-trip', () => {
  const server = new StreamableHttpServer(BASE_OPTIONS);

  const principal = 'apikey:abc';

  server.registerSseStream(principal);
  server.registerSseStream(principal);
  assert.equal(server.sseStreamsByPrincipal.get(principal), 2);

  server.unregisterSseStream(principal);
  assert.equal(server.sseStreamsByPrincipal.get(principal), 1);

  server.unregisterSseStream(principal);
  assert.equal(server.sseStreamsByPrincipal.has(principal), false);
});

test('StreamableHttpServer sendMessage unregisters failed streams from sseStreamsByPrincipal', () => {
  const server = new StreamableHttpServer(BASE_OPTIONS);

  const sessionId = 'mcp_principal_test';
  const principal = 'apikey:test_principal';
  const brokenStream = {
    write: () => { throw new Error('broken'); },
    end: () => {},
  };

  server.sessions.set(sessionId, {
    id: sessionId,
    principal,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60000),
    sseStreams: new Set([brokenStream]),
    lastActivity: new Date(),
    initialized: true,
  });
  server.sseStreamsByPrincipal.set(principal, 1);

  server.sendMessage(sessionId, { type: 'test' });

  assert.equal(server.sseStreamsByPrincipal.has(principal), false,
    'sseStreamsByPrincipal should be cleared after failed stream removed');
});

test('StreamableHttpServer stop() clears sseStreamsByPrincipal even without a started server', async () => {
  const server = new StreamableHttpServer(BASE_OPTIONS);

  server.sseStreamsByPrincipal.set('apikey:a', 2);
  server.sseStreamsByPrincipal.set('apikey:b', 1);
  assert.equal(server.sseStreamsByPrincipal.size, 2);

  await server.stop();

  assert.equal(server.sseStreamsByPrincipal.size, 0, 'sseStreamsByPrincipal should be empty after stop()');
});

test('StreamableHttpServer: POST /oauth/register returns 201 on direct instantiation without oauthStore', async () => {
  // Regression: previously returned 500 because the module-level store singleton was never
  // initialized when StreamableHttpServer was constructed without going through main().
  const port = 6500 + Math.floor(Math.random() * 100);
  const server = new StreamableHttpServer({ ...BASE_OPTIONS, port });
  await server.start(port);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://example.com/callback'] }),
    });
    assert.notEqual(res.status, 500, 'must not 500 due to uninitialized store');
    assert.equal(res.status, 201);
  } finally {
    await server.stop();
  }
});
