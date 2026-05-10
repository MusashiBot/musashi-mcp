import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamableHttpServer } from '../dist/server/streamable-http-server.js';

test('StreamableHttpServer removes broken SSE streams when sendMessage fails', async () => {
  const server = new StreamableHttpServer({
    port: 0,
    onRequest: async () => ({ jsonrpc: '2.0', id: 1, result: {} }),
    onNotification: async () => {},
    onResponse: async () => {},
  });

  try {
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
  } finally {
    if (server.cleanupInterval) {
      clearInterval(server.cleanupInterval);
    }
  }
});
