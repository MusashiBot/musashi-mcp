import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port, attempts = 40) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await wait(250);
  }
  throw lastError || new Error(`Timed out waiting for server on port ${port}`);
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

function createServer(port) {
  return spawn(process.execPath, ['dist/index.js', '--transport=http'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      MUSASHI_API_BASE_URL: 'http://127.0.0.1:3000',
      MUSASHI_MCP_API_KEY: 'mcp_sk_test_refresh_key',
      MCP_OAUTH_TOKEN_SECRET: 'test-refresh-token-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function doFullAuthFlow(port) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const regResponse = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
    }),
  });
  const client = await regResponse.json();

  const authResponse = await fetch(`http://127.0.0.1:${port}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector/oauth/callback',
      state: 'state-1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      api_key: 'mcp_sk_test_refresh_key',
    }),
    redirect: 'manual',
  });
  const code = new URL(authResponse.headers.get('location')).searchParams.get('code');

  const tokenResponse = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector/oauth/callback',
      code_verifier: verifier,
    }),
  });
  const tokenPayload = await tokenResponse.json();
  return { client, tokenPayload };
}

test('auth code exchange response includes refresh_token field', async (t) => {
  const port = 5700 + Math.floor(Math.random() * 100);
  const child = createServer(port);
  t.after(() => stopChildProcess(child));
  await waitForHealth(port);

  const { tokenPayload } = await doFullAuthFlow(port);
  assert.equal(tokenPayload.token_type, 'Bearer');
  assert.equal(typeof tokenPayload.access_token, 'string');
  assert.equal(typeof tokenPayload.refresh_token, 'string');
  assert.equal(tokenPayload.expires_in, 3600);
});

test('refresh_token grant returns new access_token and refresh_token', async (t) => {
  const port = 5800 + Math.floor(Math.random() * 100);
  const child = createServer(port);
  t.after(() => stopChildProcess(child));
  await waitForHealth(port);

  const { client, tokenPayload } = await doFullAuthFlow(port);
  const originalRefreshToken = tokenPayload.refresh_token;

  const refreshResponse = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: originalRefreshToken,
      client_id: client.client_id,
    }),
  });

  assert.equal(refreshResponse.status, 200);
  const refreshPayload = await refreshResponse.json();
  assert.equal(typeof refreshPayload.access_token, 'string');
  assert.equal(typeof refreshPayload.refresh_token, 'string');
  // The new refresh token must differ from the old one (rotation)
  assert.notEqual(refreshPayload.refresh_token, originalRefreshToken);
});

test('rotated refresh token cannot be replayed', async (t) => {
  const port = 5850 + Math.floor(Math.random() * 50);
  const child = createServer(port);
  t.after(() => stopChildProcess(child));
  await waitForHealth(port);

  const { client, tokenPayload } = await doFullAuthFlow(port);
  const originalRefreshToken = tokenPayload.refresh_token;

  // Use the token once to rotate it
  const firstRefresh = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: originalRefreshToken,
      client_id: client.client_id,
    }),
  });
  assert.equal(firstRefresh.status, 200);

  // Replay the original token — must fail
  const replayResponse = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: originalRefreshToken,
      client_id: client.client_id,
    }),
  });
  assert.equal(replayResponse.status, 400);
  const replayPayload = await replayResponse.json();
  assert.equal(replayPayload.error, 'invalid_grant');

  // After replay detection, the new token from the rotation should also be revoked
  const newToken = (await firstRefresh.json()).refresh_token;
  const siblingResponse = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: newToken,
      client_id: client.client_id,
    }),
  });
  assert.equal(siblingResponse.status, 400);
  const siblingPayload = await siblingResponse.json();
  assert.equal(siblingPayload.error, 'invalid_grant');
});

test('concurrent refresh — only one request succeeds, the other gets invalid_grant', async (t) => {
  const port = 5870 + Math.floor(Math.random() * 30);
  const child = createServer(port);
  t.after(() => stopChildProcess(child));
  await waitForHealth(port);

  const { client, tokenPayload } = await doFullAuthFlow(port);

  // Fire two refresh requests simultaneously with the same token.
  const [resA, resB] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokenPayload.refresh_token,
        client_id: client.client_id,
      }),
    }),
    fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokenPayload.refresh_token,
        client_id: client.client_id,
      }),
    }),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [200, 400], 'exactly one request must succeed and one must fail');

  const failedRes = resA.status === 400 ? resA : resB;
  const failedPayload = await failedRes.json();
  assert.equal(failedPayload.error, 'invalid_grant');

  const successRes = resA.status === 200 ? resA : resB;
  const successPayload = await successRes.json();
  assert.equal(typeof successPayload.access_token, 'string');
  assert.equal(typeof successPayload.refresh_token, 'string');
});

test('refresh_token grant with missing refresh_token param returns 400 invalid_request', async (t) => {
  const port = 5900 + Math.floor(Math.random() * 100);
  const child = createServer(port);
  t.after(() => stopChildProcess(child));
  await waitForHealth(port);

  const response = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token' }),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error, 'invalid_request');
});

test('refresh_token grant with completely unknown token returns 400 invalid_grant', async (t) => {
  const port = 5950 + Math.floor(Math.random() * 50);
  const child = createServer(port);
  t.after(() => stopChildProcess(child));
  await waitForHealth(port);

  const response = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: crypto.randomBytes(40).toString('hex'),
    }),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error, 'invalid_grant');
});
