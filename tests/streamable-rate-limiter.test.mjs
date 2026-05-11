import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const REDIRECT_URI = 'http://127.0.0.1/callback';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort() {
  return 21000 + Math.floor(Math.random() * 2000);
}

async function waitForServer(url, attempts = 40) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`Status ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    await wait(250);
  }
  throw lastError ?? new Error('Server did not start in time');
}

async function stopChild(child) {
  if (child.exitCode !== null || child.killed) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([exited, wait(1500).then(() => child.kill('SIGKILL'))]);
  await exited.catch(() => {});
}

function spawnServer(port, env = {}) {
  return spawn(process.execPath, ['dist/index.js', '--transport=http'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      MUSASHI_API_BASE_URL: 'http://127.0.0.1:3000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'rate-limit-test', version: '0.0.1' },
  },
});

async function initialize(base, apiKey) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Protocol-Version': '2025-06-18',
      Authorization: `Bearer ${apiKey}`,
    },
    body: INIT_BODY,
  });
  assert.equal(res.status, 200, `initialize failed with ${res.status}`);
  const sessionId = res.headers.get('mcp-session-id');
  assert.ok(sessionId, 'Expected Mcp-Session-Id');
  return sessionId;
}

async function postNonInit(base, apiKey, sessionId) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Protocol-Version': '2025-06-18',
      Authorization: `Bearer ${apiKey}`,
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
}

async function registerOAuthClient(base) {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  return body.client_id;
}

async function oauthFlow(base, clientId, apiKey) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const authorizeRes = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'test-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      api_key: apiKey,
    }),
    redirect: 'manual',
  });
  assert.equal(authorizeRes.status, 302, `authorize failed with ${authorizeRes.status}`);
  const code = new URL(authorizeRes.headers.get('location')).searchParams.get('code');

  const tokenRes = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  assert.equal(tokenRes.status, 200, `token exchange failed with ${tokenRes.status}`);
  const body = await tokenRes.json();
  return body.access_token;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('initialize counts against messageLimiter; second non-init POST is 429', async (t) => {
  const port = randomPort();
  const child = spawnServer(port, {
    MUSASHI_MCP_API_KEY: 'mcp_sk_rate_test',
    MCP_RATE_LIMIT_PER_MINUTE: '2',
  });
  t.after(() => stopChild(child));
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/health`);

  // initialize: messageLimiter 1/2
  const sessionId = await initialize(base, 'mcp_sk_rate_test');

  // first non-init POST: messageLimiter 2/2
  const res1 = await postNonInit(base, 'mcp_sk_rate_test', sessionId);
  assert.equal(res1.status, 200, 'Expected 200 for first non-init POST');

  // second non-init POST: quota exhausted → 429
  const res2 = await postNonInit(base, 'mcp_sk_rate_test', sessionId);
  assert.equal(res2.status, 429, 'Expected 429 when messageLimiter quota is exhausted');
});

test('GET SSE bypasses messageLimiter', async (t) => {
  const port = randomPort();
  const child = spawnServer(port, {
    MUSASHI_MCP_API_KEY: 'mcp_sk_rate_test',
    MCP_RATE_LIMIT_PER_MINUTE: '2',
  });
  const controllers = [];
  t.after(async () => {
    for (const ac of controllers) ac.abort();
    await stopChild(child);
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/health`);

  // initialize: messageLimiter 1/2
  const sessionId = await initialize(base, 'mcp_sk_rate_test');

  // non-init POST: messageLimiter 2/2 — quota exhausted
  const res1 = await postNonInit(base, 'mcp_sk_rate_test', sessionId);
  assert.equal(res1.status, 200, 'Expected 200 for non-init POST before exhaustion');

  // GET SSE: should not be throttled by messageLimiter
  const ac = new AbortController();
  controllers.push(ac);
  const getRes = await fetch(`${base}/mcp`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      Authorization: 'Bearer mcp_sk_rate_test',
      'Mcp-Session-Id': sessionId,
    },
    signal: ac.signal,
  }).catch((err) => {
    if (err.name === 'AbortError') return { status: 200 };
    throw err;
  });
  assert.equal(getRes.status, 200, 'GET SSE should succeed even after messageLimiter quota exhausted');
});

test('DELETE bypasses messageLimiter', async (t) => {
  const port = randomPort();
  const child = spawnServer(port, {
    MUSASHI_MCP_API_KEY: 'mcp_sk_rate_test',
    MCP_RATE_LIMIT_PER_MINUTE: '2',
  });
  t.after(() => stopChild(child));
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/health`);

  // initialize: 1/2
  const sessionId = await initialize(base, 'mcp_sk_rate_test');

  // non-init POST: 2/2 — exhausted
  const res1 = await postNonInit(base, 'mcp_sk_rate_test', sessionId);
  assert.equal(res1.status, 200, 'Expected 200 before exhaustion');

  // DELETE: should not be throttled
  const deleteRes = await fetch(`${base}/mcp`, {
    method: 'DELETE',
    headers: {
      'MCP-Protocol-Version': '2025-06-18',
      Authorization: 'Bearer mcp_sk_rate_test',
      'Mcp-Session-Id': sessionId,
    },
  });
  assert.equal(deleteRes.status, 200, 'DELETE should succeed even after messageLimiter quota exhausted');
});

test('API-key principals are rate-limited independently (per-minute)', async (t) => {
  const port = randomPort();
  const child = spawnServer(port, {
    MCP_API_KEYS: 'mcp_sk_key_a,mcp_sk_key_b',
    MCP_RATE_LIMIT_PER_MINUTE: '2',
  });
  t.after(() => stopChild(child));
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/health`);

  // key_a: initialize (1/2) + non-init POST (2/2 exhausted)
  const sessionA = await initialize(base, 'mcp_sk_key_a');
  const res1 = await postNonInit(base, 'mcp_sk_key_a', sessionA);
  assert.equal(res1.status, 200);

  // key_b: should have its own bucket (1/2) — not affected by key_a's exhaustion
  const sessionB = await initialize(base, 'mcp_sk_key_b');
  assert.ok(sessionB, 'key_b should get a session ID even though key_a quota is exhausted');
});

test('OAuth principals on the same IP have separate per-minute rate limit buckets', async (t) => {
  const port = randomPort();
  const child = spawnServer(port, {
    MCP_API_KEYS: 'mcp_sk_oauth_a,mcp_sk_oauth_b',
    MCP_RATE_LIMIT_PER_MINUTE: '2',
  });
  t.after(() => stopChild(child));
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/health`);

  const clientId = await registerOAuthClient(base);
  const tokenA = await oauthFlow(base, clientId, 'mcp_sk_oauth_a');
  const tokenB = await oauthFlow(base, clientId, 'mcp_sk_oauth_b');

  // principal_a: initialize (1/2) + non-init POST (2/2 exhausted) + next → 429
  const sessionA = await initialize(base, tokenA);
  const postA1 = await postNonInit(base, tokenA, sessionA);
  assert.equal(postA1.status, 200, 'first non-init POST for principal_a should succeed');

  const postA2 = await postNonInit(base, tokenA, sessionA);
  assert.equal(postA2.status, 429, 'principal_a should be rate-limited');

  // principal_b on the same IP should have a separate bucket
  const sessionB = await initialize(base, tokenB);
  assert.ok(sessionB, 'principal_b should get a session even though principal_a is rate-limited');
});

test('OAuth principals on the same IP have separate hourly rate limit buckets', async (t) => {
  const port = randomPort();
  const child = spawnServer(port, {
    MCP_API_KEYS: 'mcp_sk_hourly_a,mcp_sk_hourly_b',
    MCP_RATE_LIMIT_PER_HOUR: '2',
    MCP_RATE_LIMIT_PER_MINUTE: '200',
  });
  t.after(() => stopChild(child));
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/health`);

  const clientId = await registerOAuthClient(base);
  const tokenA = await oauthFlow(base, clientId, 'mcp_sk_hourly_a');
  const tokenB = await oauthFlow(base, clientId, 'mcp_sk_hourly_b');

  // principal_a: initialize (hourly 1/2) + non-init POST (hourly 2/2 exhausted)
  const sessionA = await initialize(base, tokenA);
  const postA1 = await postNonInit(base, tokenA, sessionA);
  assert.equal(postA1.status, 200, 'first POST for principal_a should succeed');

  // third request for principal_a exceeds hourly limit
  const postA2 = await postNonInit(base, tokenA, sessionA);
  assert.equal(postA2.status, 429, 'principal_a hourly limit should be hit');

  // principal_b on the same IP should have an independent hourly bucket
  const sessionB = await initialize(base, tokenB);
  assert.ok(sessionB, 'principal_b should get a session even though principal_a hourly limit is exceeded');
});

test('unauthenticated info GET bypasses hourlyLimiter', async (t) => {
  const port = randomPort();
  const child = spawnServer(port, {
    MUSASHI_MCP_API_KEY: 'mcp_sk_info_test',
    MCP_RATE_LIMIT_PER_HOUR: '2',
  });
  t.after(() => stopChild(child));
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/health`);

  // Exhaust the hourly limit for the authenticated principal
  const sessionId = await initialize(base, 'mcp_sk_info_test');       // hourly 1/2
  const postRes = await postNonInit(base, 'mcp_sk_info_test', sessionId);  // hourly 2/2
  assert.equal(postRes.status, 200);

  // Unauthenticated info GET: no auth, no session, no SSE accept → should be skipped by hourlyLimiter
  const infoRes = await fetch(`${base}/mcp`);
  assert.equal(infoRes.status, 200, 'Unauthenticated info GET should succeed even after hourly limit is hit');
  const body = await infoRes.json();
  assert.equal(body.transport, 'streamable-http', 'Expected server info response');
});

test('per-principal SSE cap returns 429 on 11th stream', async (t) => {
  const port = randomPort();
  const child = spawnServer(port, {
    MUSASHI_MCP_API_KEY: 'mcp_sk_sse_cap_test',
  });
  const controllers = [];
  t.after(async () => {
    for (const ac of controllers) ac.abort();
    await stopChild(child);
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/health`);

  const sessionId = await initialize(base, 'mcp_sk_sse_cap_test');

  // Open 10 SSE streams (the per-principal cap is MAX_SSE_STREAMS_PER_PRINCIPAL = 10)
  for (let i = 0; i < 10; i++) {
    const ac = new AbortController();
    controllers.push(ac);
    const sseRes = await fetch(`${base}/mcp`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
        Authorization: 'Bearer mcp_sk_sse_cap_test',
        'Mcp-Session-Id': sessionId,
      },
      signal: ac.signal,
    }).catch((err) => {
      if (err.name === 'AbortError') return { status: 200 };
      throw err;
    });
    assert.equal(sseRes.status, 200, `SSE stream ${i + 1} should open successfully`);
  }

  // 11th stream should be rejected
  const eleventhRes = await fetch(`${base}/mcp`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      Authorization: 'Bearer mcp_sk_sse_cap_test',
      'Mcp-Session-Id': sessionId,
    },
  });
  assert.equal(eleventhRes.status, 429, 'Expected 429 when per-principal SSE cap is exceeded');
});
