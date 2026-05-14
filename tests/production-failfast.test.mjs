import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const DIST_ENTRY = new URL('../dist/index.js', import.meta.url);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnServer(env, port) {
  return spawn(process.execPath, [DIST_ENTRY.pathname, '--transport=http'], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      MUSASHI_API_BASE_URL: 'http://127.0.0.1:3000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function collectOutput(child) {
  const lines = [];
  child.stdout.on('data', (d) => lines.push(d.toString()));
  child.stderr.on('data', (d) => lines.push(d.toString()));
  return lines;
}

async function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForHealth(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return true;
    } catch (err) {
      lastError = err;
    }
    await wait(200);
  }
  throw lastError || new Error(`Health check timed out on port ${port}`);
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

test('production with no KV config exits with code 1', async () => {
  const port = 6100 + Math.floor(Math.random() * 100);
  const child = spawnServer(
    {
      NODE_ENV: 'production',
      // No UPSTASH_REDIS_REST_URL / TOKEN
      // No MCP_OAUTH_TOKEN_SECRET
    },
    port,
  );
  const exitCode = await waitForExit(child);
  assert.equal(exitCode, 1);
});

test('production with KV config but no MCP_OAUTH_TOKEN_SECRET exits with code 1', async () => {
  const port = 6200 + Math.floor(Math.random() * 100);
  const child = spawnServer(
    {
      NODE_ENV: 'production',
      UPSTASH_REDIS_REST_URL: 'https://fake-redis.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'fake-token',
      // No MCP_OAUTH_TOKEN_SECRET
    },
    port,
  );
  const exitCode = await waitForExit(child);
  assert.equal(exitCode, 1);
});

test('development with no KV config starts with a warning but does not exit', async (t) => {
  const port = 6300 + Math.floor(Math.random() * 100);
  const child = spawnServer(
    {
      NODE_ENV: 'development',
      MUSASHI_MCP_API_KEY: 'mcp_sk_test_failfast_key',
      // No KV config
    },
    port,
  );
  const output = collectOutput(child);
  t.after(() => stopChildProcess(child));

  await waitForHealth(port);

  const combined = output.join('');
  assert.ok(combined.includes('in-memory store'), `Expected warning in output: ${combined}`);
});

test('RAILWAY_SERVICE_NAME triggers production fail-fast without KV config', async () => {
  const port = 6400 + Math.floor(Math.random() * 100);
  const child = spawnServer(
    {
      RAILWAY_SERVICE_NAME: 'musashi-mcp',
      // No KV config, no MCP_OAUTH_TOKEN_SECRET
    },
    port,
  );
  const exitCode = await waitForExit(child);
  assert.equal(exitCode, 1);
});
