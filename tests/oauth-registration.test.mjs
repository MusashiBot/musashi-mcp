import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const TEST_VERIFIER = 'plain-verifier';
const TEST_CHALLENGE = crypto.createHash('sha256').update(TEST_VERIFIER).digest('base64url');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url, attempts = 40) {
  let lastError;

  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }

      lastError = new Error(`Request returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await wait(250);
  }

  throw lastError || new Error('Timed out waiting for server');
}

async function stopChildProcess(child) {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
  });

  child.kill('SIGTERM');

  const timeout = wait(1500).then(() => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
  });

  await Promise.race([exited, timeout]);
  await exited.catch(() => undefined);
}

function createServerEnv(port) {
  return {
    ...process.env,
    PORT: String(port),
    MUSASHI_API_BASE_URL: 'http://127.0.0.1:3000',
    MUSASHI_MCP_API_KEY: 'mcp_sk_test_oauth_key',
  };
}

function createServer(port) {
  return spawn(process.execPath, ['dist/index.js', '--transport=http'], {
    cwd: new URL('..', import.meta.url),
    env: createServerEnv(port),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('OAuth discovery advertises a registration endpoint', async (t) => {
  const port = 3900 + Math.floor(Math.random() * 300);
  const child = createServer(port);

  t.after(async () => {
    await stopChildProcess(child);
  });

  const response = await waitForJson(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
  const payload = await response.json();

  assert.equal(payload.registration_endpoint, `http://127.0.0.1:${port}/oauth/register`);
  assert.deepEqual(payload.token_endpoint_auth_methods_supported, ['none']);
  assert.ok(Array.isArray(payload.grant_types_supported));
  assert.ok(payload.grant_types_supported.includes('refresh_token'));
});

test('OAuth register creates a public client and token exchange requires PKCE verifier', async (t) => {
  const port = 4200 + Math.floor(Math.random() * 300);
  const child = createServer(port);

  t.after(async () => {
    await stopChildProcess(child);
  });

  await waitForJson(`http://127.0.0.1:${port}/health`);

  const registerResponse = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_name: 'ChatGPT Musashi Test',
      redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
      token_endpoint_auth_method: 'none',
    }),
  });

  assert.equal(registerResponse.status, 201);
  const client = await registerResponse.json();
  assert.equal(typeof client.client_id, 'string');

  const authorizeFormResponse = await fetch(`http://127.0.0.1:${port}/oauth/authorize?${new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: 'https://chatgpt.com/connector/oauth/callback',
    state: 'state-form',
    code_challenge: TEST_CHALLENGE,
    code_challenge_method: 'S256',
  })}`);
  assert.equal(authorizeFormResponse.status, 200);
  const authorizeFormHtml = await authorizeFormResponse.text();
  assert.match(authorizeFormHtml, new RegExp(`name="client_id" value="${client.client_id}"`));

  const formData = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: 'https://chatgpt.com/connector/oauth/callback',
    state: 'state-123',
    code_challenge: TEST_CHALLENGE,
    code_challenge_method: 'S256',
    api_key: 'mcp_sk_test_oauth_key',
  });

  const authorizeResponse = await fetch(`http://127.0.0.1:${port}/oauth/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData,
    redirect: 'manual',
  });

  assert.equal(authorizeResponse.status, 302);
  const location = authorizeResponse.headers.get('location');
  assert.ok(location);

  const code = new URL(location).searchParams.get('code');
  assert.ok(code);

  const missingVerifierResponse = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector/oauth/callback',
    }),
  });

  assert.equal(missingVerifierResponse.status, 400);
  const missingVerifierPayload = await missingVerifierResponse.json();
  assert.equal(missingVerifierPayload.error, 'invalid_grant');
  assert.match(missingVerifierPayload.error_description, /code_verifier/i);
});

test('OAuth token exchange succeeds for registered public clients with matching verifier', async (t) => {
  const port = 4500 + Math.floor(Math.random() * 300);
  const child = createServer(port);

  t.after(async () => {
    await stopChildProcess(child);
  });

  await waitForJson(`http://127.0.0.1:${port}/health`);

  const registerResponse = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_name: 'ChatGPT Musashi Test',
      redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const client = await registerResponse.json();

  const authorizeResponse = await fetch(`http://127.0.0.1:${port}/oauth/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector/oauth/callback',
      state: 'state-456',
      code_challenge: TEST_CHALLENGE,
      code_challenge_method: 'S256',
      api_key: 'mcp_sk_test_oauth_key',
    }),
    redirect: 'manual',
  });

  const code = new URL(authorizeResponse.headers.get('location')).searchParams.get('code');

  const tokenResponse = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector/oauth/callback',
      code_verifier: 'plain-verifier',
    }),
  });

  assert.equal(tokenResponse.status, 200);
  const payload = await tokenResponse.json();
  assert.equal(typeof payload.access_token, 'string');
  assert.notEqual(payload.access_token, 'mcp_sk_test_oauth_key');
  assert.equal(payload.access_token.split('.').length, 3);
  assert.equal(payload.token_type, 'Bearer');
  assert.equal(payload.expires_in, 3600);
  assert.equal(typeof payload.refresh_token, 'string');
});

test('OAuth authorize rejects unknown clients and mismatched redirect_uri', async (t) => {
  const port = 4700 + Math.floor(Math.random() * 200);
  const child = createServer(port);

  t.after(async () => {
    await stopChildProcess(child);
  });

  await waitForJson(`http://127.0.0.1:${port}/health`);

  const unknownClientResponse = await fetch(`http://127.0.0.1:${port}/oauth/authorize?client_id=unknown&redirect_uri=https://chatgpt.com/connector/oauth/callback&state=abc`);
  assert.equal(unknownClientResponse.status, 400);
  const unknownClientPayload = await unknownClientResponse.json();
  assert.equal(unknownClientPayload.error, 'invalid_client');

  const registerResponse = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_name: 'ChatGPT Musashi Test',
      redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const client = await registerResponse.json();

  const mismatchedRedirectResponse = await fetch(`http://127.0.0.1:${port}/oauth/authorize?client_id=${client.client_id}&redirect_uri=https://chat.openai.com/oauth/callback&state=abc`);
  assert.equal(mismatchedRedirectResponse.status, 400);
  const mismatchedRedirectPayload = await mismatchedRedirectResponse.json();
  assert.equal(mismatchedRedirectPayload.error, 'invalid_request');
});

test('OAuth register rejects client_secret_post with 400', async (t) => {
  const port = 4900 + Math.floor(Math.random() * 100);
  const child = createServer(port);

  t.after(async () => {
    await stopChildProcess(child);
  });

  await waitForJson(`http://127.0.0.1:${port}/health`);

  const response = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  });

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error, 'invalid_client_metadata');
});

test('OAuth register rejects client_secret_basic with 400', async (t) => {
  const port = 5000 + Math.floor(Math.random() * 100);
  const child = createServer(port);
  t.after(async () => stopChildProcess(child));
  await waitForJson(`http://127.0.0.1:${port}/health`);

  const response = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
      token_endpoint_auth_method: 'client_secret_basic',
    }),
  });

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error, 'invalid_client_metadata');
});

// ---------------------------------------------------------------------------
// Helper: register + authorize, return code without exchanging it
// ---------------------------------------------------------------------------
async function doGetCode(port) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const regRes = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://chatgpt.com/connector/oauth/callback'] }),
  });
  const client = await regRes.json();

  const authRes = await fetch(`http://127.0.0.1:${port}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector/oauth/callback',
      state: 'state-1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      api_key: 'mcp_sk_test_oauth_key',
    }),
    redirect: 'manual',
  });
  const code = new URL(authRes.headers.get('location')).searchParams.get('code');
  return { client, code, verifier };
}

test('auth code survives bad first exchange (wrong redirect_uri), succeeds on second attempt', async (t) => {
  const port = 5100 + Math.floor(Math.random() * 100);
  const child = createServer(port);
  t.after(async () => stopChildProcess(child));
  await waitForJson(`http://127.0.0.1:${port}/health`);

  const { client, code, verifier } = await doGetCode(port);

  // First attempt: wrong redirect_uri — must fail without burning the code.
  const badRes = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'https://wrong.example.com/callback',
      code_verifier: verifier,
    }),
  });
  assert.equal(badRes.status, 400);
  const badPayload = await badRes.json();
  assert.equal(badPayload.error, 'invalid_grant');

  // Second attempt: correct params — code must still be valid.
  const goodRes = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
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
  assert.equal(goodRes.status, 200);
  const goodPayload = await goodRes.json();
  assert.equal(typeof goodPayload.access_token, 'string');
  assert.equal(typeof goodPayload.refresh_token, 'string');
});

test('concurrent code exchange — only one request succeeds', async (t) => {
  const port = 5200 + Math.floor(Math.random() * 100);
  const child = createServer(port);
  t.after(async () => stopChildProcess(child));
  await waitForJson(`http://127.0.0.1:${port}/health`);

  const { client, code, verifier } = await doGetCode(port);

  const makeExchange = () =>
    fetch(`http://127.0.0.1:${port}/oauth/token`, {
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

  const [resA, resB] = await Promise.all([makeExchange(), makeExchange()]);
  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [200, 400], 'exactly one exchange must succeed');

  const failedRes = resA.status === 400 ? resA : resB;
  const failedPayload = await failedRes.json();
  assert.equal(failedPayload.error, 'invalid_grant');

  const successRes = resA.status === 200 ? resA : resB;
  const successPayload = await successRes.json();
  assert.equal(typeof successPayload.access_token, 'string');
});
