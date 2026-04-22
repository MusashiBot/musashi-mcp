import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const VALID_KEY = 'mcp_sk_test_v1_tools_key';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, attempts = 40) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`Health check returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw lastError || new Error('Timed out waiting for HTTP health endpoint');
}

async function stopChildProcess(child) {
  if (child.exitCode !== null || child.killed) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timeout = wait(1500).then(() => {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  });
  await Promise.race([exited, timeout]);
  await exited.catch(() => undefined);
}

function startMockMusashiApi(handlers) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const handler = handlers[url.pathname];
      if (!handler) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      const result = await handler(url);
      res.statusCode = result.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result.body ?? {}));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

async function initSession(port) {
  const initResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Protocol-Version': '2025-06-18',
      Authorization: `Bearer ${VALID_KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'v1-tools-test', version: '1.0.0' },
      },
    }),
  });
  assert.equal(initResponse.status, 200);
  return initResponse.headers.get('mcp-session-id');
}

async function jsonRpc(port, sessionId, id, method, params) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Protocol-Version': '2025-06-18',
      'Mcp-Session-Id': sessionId,
      Authorization: `Bearer ${VALID_KEY}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function parseEnvelope(callResult) {
  const content = callResult?.result?.content;
  assert.ok(Array.isArray(content), 'expected content array');
  assert.equal(content[0].type, 'text');
  return JSON.parse(content[0].text);
}

test('V1 market tools — full surface wired and envelope shape is correct', async (t) => {
  const marketsSearchBody = {
    data: {
      markets: [
        {
          id: 'musashi-kalshi-FEDCUT-2026SEP',
          platform: 'kalshi',
          platform_id: 'FEDCUT-2026SEP',
          title: 'Will the Fed cut rates at or before September 2026?',
          category: 'fed_policy',
          status: 'open',
          yes_price: 0.67,
          no_price: 0.33,
          closes_at: '2026-09-17T18:00:00Z',
          resolved: false,
        },
      ],
    },
  };

  const marketLookupBody = {
    data: {
      market: {
        id: 'musashi-kalshi-FEDCUT-2026SEP',
        platform: 'kalshi',
        platform_id: 'FEDCUT-2026SEP',
        title: 'Will the Fed cut rates at or before September 2026?',
        description: 'Resolves YES if FOMC announces a cut by Sep 2026.',
        category: 'fed_policy',
        status: 'open',
        yes_price: 0.67,
        no_price: 0.33,
        volume_24h: 104210.5,
        open_interest: 55000,
        liquidity: 82000,
        spread: 0.01,
        closes_at: '2026-09-17T18:00:00Z',
        settles_at: '2026-09-18T00:00:00Z',
        resolved: false,
        resolution: null,
        resolved_at: null,
        source_missing_at: null,
      },
    },
  };

  const marketHistoryBody = {
    data: {
      market: {
        id: 'musashi-kalshi-FEDCUT-2026SEP',
        platform: 'kalshi',
        platform_id: 'FEDCUT-2026SEP',
        title: 'Will the Fed cut rates at or before September 2026?',
        category: 'fed_policy',
        status: 'open',
      },
      snapshots: [
        {
          snapshot_time: '2026-04-22T14:00:00Z',
          yes_price: 0.66,
          no_price: 0.34,
          volume_24h: 100000,
          open_interest: 54000,
          liquidity: 80000,
          spread: 0.01,
        },
        {
          snapshot_time: '2026-04-22T15:00:00Z',
          yes_price: 0.67,
          no_price: 0.33,
          volume_24h: 104210,
          open_interest: 55000,
          liquidity: 82000,
          spread: 0.01,
        },
      ],
    },
  };

  const resolutionContextBody = {
    data: {
      market: {
        id: 'musashi-kalshi-FEDCUT-2026SEP',
        platform: 'kalshi',
        platform_id: 'FEDCUT-2026SEP',
        title: 'Will the Fed cut rates at or before September 2026?',
        category: 'fed_policy',
        status: 'open',
      },
      market_resolved: false,
      market_resolution: null,
      market_resolved_at: null,
      category_resolution_count: 12,
      similar_market_resolution_count: null,
      notes: 'No similar market group available; counts are category-level only.',
    },
  };

  const mockCalls = [];
  const { server: apiServer, port: apiPort } = await startMockMusashiApi({
    '/api/markets/search': async (url) => {
      mockCalls.push(['/api/markets/search', url.search]);
      return { status: 200, body: marketsSearchBody };
    },
    '/api/markets/lookup': async (url) => {
      mockCalls.push(['/api/markets/lookup', url.search]);
      return { status: 200, body: marketLookupBody };
    },
    '/api/markets/history': async (url) => {
      mockCalls.push(['/api/markets/history', url.search]);
      return { status: 200, body: marketHistoryBody };
    },
    '/api/markets/resolution-context': async (url) => {
      mockCalls.push(['/api/markets/resolution-context', url.search]);
      return { status: 200, body: resolutionContextBody };
    },
  });

  const mcpPort = 5100 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ['dist/index.js', '--transport=http'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(mcpPort),
      MUSASHI_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      MUSASHI_MCP_API_KEY: VALID_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    await stopChildProcess(child);
    await new Promise((resolve) => apiServer.close(resolve));
  });

  await waitForHealth(`http://127.0.0.1:${mcpPort}/health`);
  const sessionId = await initSession(mcpPort);

  // tools/list should include the four V1 tools.
  const listPayload = await jsonRpc(mcpPort, sessionId, 2, 'tools/list');
  const toolNames = listPayload.result.tools.map((t) => t.name);
  for (const expected of [
    'search_markets',
    'get_market',
    'get_market_history',
    'get_market_resolution_context',
  ]) {
    assert.ok(toolNames.includes(expected), `tools/list missing ${expected}`);
  }

  // search_markets happy path.
  const searchResult = await jsonRpc(mcpPort, sessionId, 3, 'tools/call', {
    name: 'search_markets',
    arguments: { query: 'Fed cuts', limit: 5 },
  });
  const searchEnvelope = parseEnvelope(searchResult);
  assert.equal(searchEnvelope.ok, true);
  assert.equal(searchEnvelope.data.markets.length, 1);
  assert.equal(searchEnvelope.data.markets[0].platform, 'kalshi');

  // search_markets invalid input.
  const searchBad = await jsonRpc(mcpPort, sessionId, 4, 'tools/call', {
    name: 'search_markets',
    arguments: { query: '' },
  });
  const searchBadEnvelope = parseEnvelope(searchBad);
  assert.equal(searchBadEnvelope.ok, false);
  assert.equal(searchBadEnvelope.error.type, 'invalid_input');

  // get_market by market_id.
  const getMarketResult = await jsonRpc(mcpPort, sessionId, 5, 'tools/call', {
    name: 'get_market',
    arguments: { market_id: 'musashi-kalshi-FEDCUT-2026SEP' },
  });
  const getMarketEnvelope = parseEnvelope(getMarketResult);
  assert.equal(getMarketEnvelope.ok, true);
  assert.equal(getMarketEnvelope.data.settles_at, '2026-09-18T00:00:00Z');
  assert.equal(getMarketEnvelope.data.resolved, false);

  // get_market exclusive identifiers.
  const getMarketBoth = await jsonRpc(mcpPort, sessionId, 6, 'tools/call', {
    name: 'get_market',
    arguments: { market_id: 'a', platform_id: 'b' },
  });
  const getMarketBothEnvelope = parseEnvelope(getMarketBoth);
  assert.equal(getMarketBothEnvelope.ok, false);
  assert.equal(getMarketBothEnvelope.error.type, 'invalid_input');

  // get_market_history.
  const historyResult = await jsonRpc(mcpPort, sessionId, 7, 'tools/call', {
    name: 'get_market_history',
    arguments: { platform_id: 'FEDCUT-2026SEP', window: '24h', limit: 50 },
  });
  const historyEnvelope = parseEnvelope(historyResult);
  assert.equal(historyEnvelope.ok, true);
  assert.equal(historyEnvelope.data.window, '24h');
  assert.equal(historyEnvelope.data.snapshots.length, 2);
  // Ensure ordered ascending.
  assert.ok(
    historyEnvelope.data.snapshots[0].snapshot_time <=
      historyEnvelope.data.snapshots[1].snapshot_time,
  );

  // get_market_resolution_context.
  const resolutionResult = await jsonRpc(mcpPort, sessionId, 8, 'tools/call', {
    name: 'get_market_resolution_context',
    arguments: { market_id: 'musashi-kalshi-FEDCUT-2026SEP' },
  });
  const resolutionEnvelope = parseEnvelope(resolutionResult);
  assert.equal(resolutionEnvelope.ok, true);
  assert.equal(resolutionEnvelope.data.category_resolution_count, 12);
  assert.equal(resolutionEnvelope.data.similar_market_resolution_count, null);
  assert.match(resolutionEnvelope.data.notes, /similar market group/);

  // Each mock endpoint should have been hit at least once.
  const hit = new Set(mockCalls.map(([path]) => path));
  for (const path of [
    '/api/markets/search',
    '/api/markets/lookup',
    '/api/markets/history',
    '/api/markets/resolution-context',
  ]) {
    assert.ok(hit.has(path), `Mock endpoint not hit: ${path}`);
  }
});

test('V1 market tools — upstream 5xx maps to upstream_unavailable', async (t) => {
  const { server: apiServer, port: apiPort } = await startMockMusashiApi({
    '/api/markets/search': async () => ({
      status: 503,
      body: { error: { message: 'db read replica down' } },
    }),
  });

  const mcpPort = 5400 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ['dist/index.js', '--transport=http'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(mcpPort),
      MUSASHI_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      MUSASHI_MCP_API_KEY: VALID_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    await stopChildProcess(child);
    await new Promise((resolve) => apiServer.close(resolve));
  });

  await waitForHealth(`http://127.0.0.1:${mcpPort}/health`);
  const sessionId = await initSession(mcpPort);

  const result = await jsonRpc(mcpPort, sessionId, 9, 'tools/call', {
    name: 'search_markets',
    arguments: { query: 'Fed' },
  });
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.type, 'upstream_unavailable');
});

test('V1 market tools — 404 from upstream maps to not_found', async (t) => {
  const { server: apiServer, port: apiPort } = await startMockMusashiApi({
    '/api/markets/lookup': async () => ({
      status: 404,
      body: { error: { message: 'Market not found.' } },
    }),
  });

  const mcpPort = 5600 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ['dist/index.js', '--transport=http'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(mcpPort),
      MUSASHI_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      MUSASHI_MCP_API_KEY: VALID_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    await stopChildProcess(child);
    await new Promise((resolve) => apiServer.close(resolve));
  });

  await waitForHealth(`http://127.0.0.1:${mcpPort}/health`);
  const sessionId = await initSession(mcpPort);

  const result = await jsonRpc(mcpPort, sessionId, 10, 'tools/call', {
    name: 'get_market',
    arguments: { market_id: 'musashi-kalshi-DOESNOTEXIST' },
  });
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.type, 'not_found');
});
