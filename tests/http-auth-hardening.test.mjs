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

test('Streamable MCP requires Authorization header', async (t) => {
  const port = 4950 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ['dist/index.js', '--transport=http'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      MUSASHI_API_BASE_URL: 'http://127.0.0.1:3000',
      MUSASHI_MCP_API_KEY: 'mcp_sk_auth_required_key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    await stopChildProcess(child);
  });

  await waitForHealth(`http://127.0.0.1:${port}/health`);

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'auth-test', version: '1.0.0' },
      },
    }),
  });

  assert.equal(response.status, 401);
});

test('Streamable MCP sessions are bound to authenticated principal', async (t) => {
  const port = 5150 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ['dist/index.js', '--transport=http'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      MUSASHI_API_BASE_URL: 'http://127.0.0.1:3000',
      MCP_API_KEYS: 'mcp_sk_session_owner_key,mcp_sk_different_owner_key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    await stopChildProcess(child);
  });

  await waitForHealth(`http://127.0.0.1:${port}/health`);

  const initializeResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Protocol-Version': '2025-06-18',
      Authorization: 'Bearer mcp_sk_session_owner_key',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'auth-test', version: '1.0.0' },
      },
    }),
  });

  assert.equal(initializeResponse.status, 200);
  const sessionId = initializeResponse.headers.get('mcp-session-id');
  assert.ok(sessionId);

  const mismatchedPrincipalResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Protocol-Version': '2025-06-18',
      'Mcp-Session-Id': sessionId,
      Authorization: 'Bearer mcp_sk_different_owner_key',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'prompts/list',
    }),
  });

  assert.equal(mismatchedPrincipalResponse.status, 403);
});
