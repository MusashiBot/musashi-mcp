import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

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
  throw lastError || new Error('Timed out waiting for server');
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
      MUSASHI_MCP_API_KEY: 'mcp_sk_test_cors_key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('CORS: OAuth open endpoints respond with wildcard access-control-allow-origin', async (t) => {
  const port = 5100 + Math.floor(Math.random() * 100);
  const child = createServer(port);
  t.after(() => stopChildProcess(child));
  await waitForHealth(port);

  // POST /oauth/register with unknown origin → still 400/201, wildcard CORS
  const regResponse = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://unknown.example.com',
    },
    body: JSON.stringify({ redirect_uris: ['https://chatgpt.com/connector/oauth/callback'] }),
  });
  assert.equal(regResponse.headers.get('access-control-allow-origin'), '*');

  // GET /health with any Origin → wildcard
  const healthResponse = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Origin: 'https://anything.example.com' },
  });
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.headers.get('access-control-allow-origin'), '*');

  // GET /.well-known/oauth-authorization-server with any Origin → wildcard
  const discoveryResponse = await fetch(
    `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`,
    { headers: { Origin: 'https://whatever.com' } },
  );
  assert.equal(discoveryResponse.status, 200);
  assert.equal(discoveryResponse.headers.get('access-control-allow-origin'), '*');

  // POST /oauth/token malformed body but CORS header still present
  const tokenResponse = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://attacker.example.com',
    },
    body: JSON.stringify({ grant_type: 'bad_grant' }),
  });
  assert.equal(tokenResponse.headers.get('access-control-allow-origin'), '*');
});

test('CORS: POST /oauth/authorize with Claude origin is not blocked by CORS', async (t) => {
  const port = 5200 + Math.floor(Math.random() * 100);
  const child = createServer(port);
  t.after(() => stopChildProcess(child));
  await waitForHealth(port);

  // Register first
  const regResponse = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://claude.ai/oauth/callback'] }),
  });
  const client = await regResponse.json();

  // POST /oauth/authorize with Claude app origin — should not get a CORS error
  const response = await fetch(`http://127.0.0.1:${port}/oauth/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://app.claude.ai',
    },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/oauth/callback',
      state: 'test-state',
      code_challenge: 'abc123',
      code_challenge_method: 'S256',
      api_key: 'wrong-key',
    }),
    redirect: 'manual',
  });

  // The request reaches the handler (auth fails, not CORS blocked)
  assert.notEqual(response.status, 0);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  // Should be 401 (bad api key), not a CORS error
  assert.equal(response.status, 401);
});

test('CORS: OPTIONS preflight on OAuth open endpoints returns 204 with wildcard ACAO', async (t) => {
  const port = 5250 + Math.floor(Math.random() * 50);
  const child = createServer(port);
  t.after(() => stopChildProcess(child));
  await waitForHealth(port);

  for (const path of ['/oauth/register', '/oauth/token', '/oauth/authorize']) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://unknown.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.ok(
      res.status === 204 || res.status === 200,
      `OPTIONS ${path} expected 200/204, got ${res.status}`,
    );
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      '*',
      `OPTIONS ${path} must return Access-Control-Allow-Origin: *`,
    );
  }
});

test('CORS: /mcp OPTIONS preflight responds with strict origin for allowed origins', async (t) => {
  const port = 5300 + Math.floor(Math.random() * 100);
  const child = createServer(port);
  t.after(() => stopChildProcess(child));
  await waitForHealth(port);

  // Allowed origin: claude.ai
  const claudeOptions = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://claude.ai',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(claudeOptions.headers.get('access-control-allow-origin'), 'https://claude.ai');

  // Allowed origin: app.claude.ai
  const appClaudeOptions = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.claude.ai',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(appClaudeOptions.headers.get('access-control-allow-origin'), 'https://app.claude.ai');

  // Disallowed origin for /mcp
  const attackerOptions = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://attacker.example.com',
      'Access-Control-Request-Method': 'POST',
    },
  });
  // Should not have a matching access-control-allow-origin header
  const acao = attackerOptions.headers.get('access-control-allow-origin');
  assert.ok(
    acao === null || acao === 'false' || !acao.includes('attacker.example.com'),
    `Expected no ACAO for attacker origin, got: ${acao}`,
  );
});
