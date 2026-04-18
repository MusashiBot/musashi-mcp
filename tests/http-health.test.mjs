import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, attempts = 40) {
  let lastError;

  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }

      lastError = new Error(`Health check returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await wait(250);
  }

  throw lastError || new Error('Timed out waiting for HTTP health endpoint');
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

test('HTTP transport serves a healthy status endpoint', async (t) => {
  const port = 3300 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ['dist/index.js', '--transport=http'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      MUSASHI_API_BASE_URL: 'http://127.0.0.1:3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });

  t.after(async () => {
    await stopChildProcess(child);
  });

  const response = await waitForHealth(`http://127.0.0.1:${port}/health`);
  const payload = await response.json();

  assert.equal(payload.status, 'healthy');
  assert.equal(payload.transport, 'streamable-http');
  assert.equal(payload.protocol_version, '2025-06-18');
  assert.equal(typeof payload.active_sessions, 'number');
  assert.equal(typeof payload.uptime_seconds, 'number');
  assert.match(logs, /Streamable HTTP/);
});

test('HTTP transport exposes OAuth discovery metadata', async (t) => {
  const port = 3600 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ['dist/index.js', '--transport=http'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      MUSASHI_API_BASE_URL: 'http://127.0.0.1:3000',
      MUSASHI_MCP_API_KEY: 'mcp_sk_test_oauth_key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    await stopChildProcess(child);
  });

  const discoveryResponse = await waitForHealth(
    `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`
  );
  const discovery = await discoveryResponse.json();

  assert.equal(discovery.authorization_endpoint, `http://127.0.0.1:${port}/oauth/authorize`);
  assert.equal(discovery.token_endpoint, `http://127.0.0.1:${port}/oauth/token`);
  assert.deepEqual(discovery.response_types_supported, ['code']);
  assert.deepEqual(discovery.grant_types_supported, ['authorization_code']);
});

test('HTTP transport honors configured public MCP base URL in OAuth metadata', async (t) => {
  const port = 3900 + Math.floor(Math.random() * 300);
  const publicBaseUrl = 'https://musashi-mcp.example.com';
  const child = spawn(process.execPath, ['dist/index.js', '--transport=http'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      MUSASHI_API_BASE_URL: 'http://127.0.0.1:3000',
      MUSASHI_MCP_API_KEY: 'mcp_sk_test_oauth_key',
      MUSASHI_MCP_PUBLIC_BASE_URL: `${publicBaseUrl}/`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    await stopChildProcess(child);
  });

  const protectedResourceResponse = await waitForHealth(
    `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`
  );
  const protectedResource = await protectedResourceResponse.json();
  assert.equal(protectedResource.resource, `${publicBaseUrl}/mcp`);
  assert.deepEqual(protectedResource.authorization_servers, [publicBaseUrl]);

  const discoveryResponse = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
  const discovery = await discoveryResponse.json();
  assert.equal(discovery.issuer, publicBaseUrl);
  assert.equal(discovery.authorization_endpoint, `${publicBaseUrl}/oauth/authorize`);
  assert.equal(discovery.token_endpoint, `${publicBaseUrl}/oauth/token`);
});
