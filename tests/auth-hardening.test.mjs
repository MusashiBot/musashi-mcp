/**
 * Auth hardening tests for the streamable HTTP MCP server.
 * Covers bearer auth enforcement on /mcp and PKCE validation on /oauth/token.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const VALID_KEY = 'mcp_sk_test_hardening_key_abc123';
const REDIRECT_URI = 'http://localhost/callback';

// ── Helpers ──────────────────────────────────────────────────────────────────

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort() {
  return 18000 + Math.floor(Math.random() * 2000);
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

function spawnServer(port) {
  return spawn(process.execPath, ['dist/index.js', '--transport=http'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      MUSASHI_API_BASE_URL: 'http://127.0.0.1:3000',
      MUSASHI_MCP_API_KEY: VALID_KEY,
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
    clientInfo: { name: 'test-client', version: '0.0.1' },
  },
});

const INIT_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'MCP-Protocol-Version': '2025-06-18',
};

// ── Bearer auth tests ─────────────────────────────────────────────────────────

test('unauthorized initialize is rejected (no token)', async (t) => {
  const port = randomPort();
  const child = spawnServer(port);
  t.after(() => stopChild(child));
  await waitForServer(`http://127.0.0.1:${port}/health`);

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: INIT_HEADERS,
    body: INIT_BODY,
  });

  assert.equal(res.status, 401, 'Expected 401 when no Authorization header is sent');
});

test('invalid bearer token is rejected', async (t) => {
  const port = randomPort();
  const child = spawnServer(port);
  t.after(() => stopChild(child));
  await waitForServer(`http://127.0.0.1:${port}/health`);

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { ...INIT_HEADERS, Authorization: 'Bearer mcp_sk_wrong_key_xyz' },
    body: INIT_BODY,
  });

  assert.equal(res.status, 401, 'Expected 401 for an invalid API key');
});

test('valid bearer token allows initialize and returns a session ID', async (t) => {
  const port = randomPort();
  const child = spawnServer(port);
  t.after(() => stopChild(child));
  await waitForServer(`http://127.0.0.1:${port}/health`);

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { ...INIT_HEADERS, Authorization: `Bearer ${VALID_KEY}` },
    body: INIT_BODY,
  });

  assert.equal(res.status, 200, 'Expected 200 for a valid API key');
  const sessionId = res.headers.get('mcp-session-id');
  assert.ok(sessionId, 'Expected Mcp-Session-Id header in response');
});

// ── PKCE tests ────────────────────────────────────────────────────────────────

/**
 * Obtain a real authorization code from the server by posting the API key
 * and code_challenge to /oauth/authorize.
 */
async function registerClient(baseUrl) {
  const res = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'PKCE hardening test',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
    }),
  });

  assert.equal(res.status, 201, 'Expected dynamic client registration to succeed');
  const body = await res.json();
  assert.equal(typeof body.client_id, 'string');
  return body.client_id;
}

async function getAuthCode(baseUrl, codeChallenge, codeChallengeMethod = 'S256') {
  const clientId = await registerClient(baseUrl);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: 'test-state',
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    api_key: VALID_KEY,
  });

  // Server does a redirect after a successful POST; we capture the `code`
  // from the Location header without following the redirect.
  const res = await fetch(`${baseUrl}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    redirect: 'manual',
  });

  assert.ok(res.status === 302, `Expected redirect, got ${res.status}`);
  const location = res.headers.get('location');
  const code = new URL(location).searchParams.get('code');
  assert.ok(code, 'Authorization code missing from redirect');
  return { clientId, code };
}

async function exchangeToken(baseUrl, authCode, codeVerifier) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authCode.code,
    client_id: authCode.clientId,
    redirect_uri: REDIRECT_URI,
  });
  if (codeVerifier !== undefined) params.set('code_verifier', codeVerifier);

  return fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

test('token exchange fails when code_verifier is missing but challenge exists', async (t) => {
  const port = randomPort();
  const child = spawnServer(port);
  t.after(() => stopChild(child));
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/health`);

  // Generate a real S256 challenge
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const code = await getAuthCode(base, challenge, 'S256');

  // Exchange WITHOUT sending the verifier
  const res = await exchangeToken(base, code, undefined);
  assert.equal(res.status, 400, 'Expected 400 when code_verifier is omitted');
  const body = await res.json();
  assert.equal(body.error, 'invalid_grant');
});

test('token exchange fails with a wrong code_verifier', async (t) => {
  const port = randomPort();
  const child = spawnServer(port);
  t.after(() => stopChild(child));
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/health`);

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const code = await getAuthCode(base, challenge, 'S256');

  // Exchange with a completely different verifier
  const res = await exchangeToken(base, code, 'mcp_sk_totally_wrong_verifier');
  assert.equal(res.status, 400, 'Expected 400 for wrong code_verifier');
  const body = await res.json();
  assert.equal(body.error, 'invalid_grant');
});

test('token exchange succeeds with correct S256 code_verifier', async (t) => {
  const port = randomPort();
  const child = spawnServer(port);
  t.after(() => stopChild(child));
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/health`);

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const code = await getAuthCode(base, challenge, 'S256');

  const res = await exchangeToken(base, code, verifier);
  assert.equal(res.status, 200, 'Expected 200 for correct S256 verifier');
  const body = await res.json();
  assert.equal(body.token_type, 'Bearer');
  assert.ok(body.access_token, 'Expected access_token in response');
});

test('token exchange succeeds with plain method', async (t) => {
  const port = randomPort();
  const child = spawnServer(port);
  t.after(() => stopChild(child));
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/health`);

  // plain: verifier === challenge
  const verifier = crypto.randomBytes(32).toString('base64url');
  const code = await getAuthCode(base, verifier, 'plain');

  const res = await exchangeToken(base, code, verifier);
  assert.equal(res.status, 200, 'Expected 200 for correct plain verifier');
  const body = await res.json();
  assert.equal(body.token_type, 'Bearer');
});
