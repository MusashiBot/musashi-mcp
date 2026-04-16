import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

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
  assert.deepEqual(payload.token_endpoint_auth_methods_supported.sort(), ['client_secret_post', 'none']);
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
    code_challenge: 'plain-verifier',
    code_challenge_method: 'plain',
  })}`);
  assert.equal(authorizeFormResponse.status, 200);
  const authorizeFormHtml = await authorizeFormResponse.text();
  assert.match(authorizeFormHtml, new RegExp(`name="client_id" value="${client.client_id}"`));

  const formData = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: 'https://chatgpt.com/connector/oauth/callback',
    state: 'state-123',
    code_challenge: 'plain-verifier',
    code_challenge_method: 'plain',
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
      code_challenge: 'plain-verifier',
      code_challenge_method: 'plain',
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
  assert.equal(payload.expires_in, 900);
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
