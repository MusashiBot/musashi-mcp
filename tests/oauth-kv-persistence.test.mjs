/**
 * Tests for OAuthStore abstraction (unit) and cross-instance persistence (integration).
 *
 * Unit tests use MemoryOAuthStore in-process — no real Redis, no child processes.
 * KvOAuthStore cross-instance tests use a shared MockRedis to verify that state
 * written through one store instance is readable by another (simulating separate
 * server processes sharing the same Redis backend).
 *
 * Store isolation: each top-level test creates a fresh MemoryOAuthStore instance
 * and calls setOAuthStore(). after() at file level calls resetOAuthStoreForTests()
 * to clear the singleton when the file finishes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { MemoryOAuthStore } from '../dist/server/oauth-store.js';
import { KvOAuthStore } from '../dist/server/kv-oauth-store.js';

// ---------------------------------------------------------------------------
// Unit tests: MemoryOAuthStore
// ---------------------------------------------------------------------------

test('MemoryOAuthStore: saveClient and getClient', async () => {
  const store = new MemoryOAuthStore();
  const client = {
    clientId: 'test_client_1',
    redirectUris: ['https://example.com/callback'],
    tokenEndpointAuthMethod: 'none',
    createdAt: Date.now(),
    isActive: true,
  };

  await store.saveClient(client);
  const retrieved = await store.getClient('test_client_1');
  assert.deepEqual(retrieved, client);

  const missing = await store.getClient('nonexistent');
  assert.equal(missing, null);
});

test('MemoryOAuthStore: saveAuthCode + consumeAuthCode is single-use', async () => {
  const store = new MemoryOAuthStore();
  const hash = crypto.randomBytes(16).toString('hex');
  const record = {
    clientId: 'c1',
    subject: 's1',
    redirectUri: 'https://example.com/callback',
    codeChallenge: 'ch',
    codeChallengeMethod: 'S256',
    scope: 'mcp:read mcp:write',
    expiresAt: Date.now() + 300_000,
  };

  await store.saveAuthCode(hash, record, 300);
  const first = await store.consumeAuthCode(hash);
  assert.deepEqual(first, record);

  const second = await store.consumeAuthCode(hash);
  assert.equal(second, null);
});

test('MemoryOAuthStore: saveAuthCode with 1s TTL expires', async () => {
  const store = new MemoryOAuthStore();
  const hash = crypto.randomBytes(16).toString('hex');
  const record = {
    clientId: 'c1',
    subject: 's1',
    redirectUri: 'https://example.com/callback',
    scope: 'mcp:read mcp:write',
    expiresAt: Date.now() + 1000,
  };

  await store.saveAuthCode(hash, record, 1);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const retrieved = await store.getAuthCode(hash);
  assert.equal(retrieved, null);
});

test('MemoryOAuthStore: getAuthCode removes expired entry on read (cleanup)', async () => {
  const store = new MemoryOAuthStore();
  const hash = crypto.randomBytes(16).toString('hex');
  const record = {
    clientId: 'c1',
    subject: 's1',
    redirectUri: 'https://example.com/callback',
    scope: 'mcp:read mcp:write',
    expiresAt: Date.now() + 1000,
  };

  await store.saveAuthCode(hash, record, 1);
  await new Promise((resolve) => setTimeout(resolve, 1100));

  // getAuthCode returns null and removes the entry
  assert.equal(await store.getAuthCode(hash), null);
  // consumeAuthCode also sees null — confirms entry was deleted by getAuthCode
  assert.equal(await store.consumeAuthCode(hash), null);
});

test('MemoryOAuthStore: getRefreshToken removes expired entry on read (cleanup)', async () => {
  const store = new MemoryOAuthStore();
  const hash = crypto.randomBytes(16).toString('hex');
  const newHash = crypto.randomBytes(16).toString('hex');
  const record = {
    clientId: 'c1',
    subject: 's1',
    scope: 'mcp:read mcp:write',
    familyId: crypto.randomUUID(),
    expiresAt: Date.now() + 1000,
    createdAt: Date.now(),
  };

  await store.saveRefreshToken(hash, record, 1);
  await new Promise((resolve) => setTimeout(resolve, 1100));

  // getRefreshToken returns null and removes the entry
  assert.equal(await store.getRefreshToken(hash), null);
  // rotateRefreshToken returns false — confirms entry is gone
  assert.equal(await store.rotateRefreshToken(hash, newHash, record, 2592000), false);
});

test('MemoryOAuthStore: saveRefreshToken and getRefreshToken', async () => {
  const store = new MemoryOAuthStore();
  const hash = crypto.randomBytes(16).toString('hex');
  const record = {
    clientId: 'c1',
    subject: 's1',
    scope: 'mcp:read mcp:write',
    familyId: crypto.randomUUID(),
    expiresAt: Date.now() + 2_592_000_000,
    createdAt: Date.now(),
  };

  await store.saveRefreshToken(hash, record, 2592000);
  const retrieved = await store.getRefreshToken(hash);
  assert.deepEqual(retrieved, record);
});

test('MemoryOAuthStore: rotateRefreshToken marks old consumed and issues new', async () => {
  const store = new MemoryOAuthStore();
  const oldHash = crypto.randomBytes(16).toString('hex');
  const newHash = crypto.randomBytes(16).toString('hex');
  const familyId = crypto.randomUUID();

  const oldRecord = {
    clientId: 'c1',
    subject: 's1',
    scope: 'mcp:read mcp:write',
    familyId,
    expiresAt: Date.now() + 2_592_000_000,
    createdAt: Date.now(),
  };
  const newRecord = {
    ...oldRecord,
    createdAt: Date.now() + 1,
  };

  await store.saveRefreshToken(oldHash, oldRecord, 2592000);
  const rotated = await store.rotateRefreshToken(oldHash, newHash, newRecord, 2592000);
  assert.equal(rotated, true);

  const updatedOld = await store.getRefreshToken(oldHash);
  assert.ok(updatedOld !== null, 'old token should still be retrievable');
  assert.ok(typeof updatedOld.consumedAt === 'number', 'old token should have consumedAt');

  const newToken = await store.getRefreshToken(newHash);
  assert.deepEqual(newToken, newRecord);
});

test('MemoryOAuthStore: rotateRefreshToken returns false if already consumed', async () => {
  const store = new MemoryOAuthStore();
  const oldHash = crypto.randomBytes(16).toString('hex');
  const newHashA = crypto.randomBytes(16).toString('hex');
  const newHashB = crypto.randomBytes(16).toString('hex');
  const familyId = crypto.randomUUID();

  const oldRecord = {
    clientId: 'c1',
    subject: 's1',
    scope: 'mcp:read mcp:write',
    familyId,
    expiresAt: Date.now() + 2_592_000_000,
    createdAt: Date.now(),
  };
  const newRecord = { ...oldRecord, createdAt: Date.now() + 1 };

  await store.saveRefreshToken(oldHash, oldRecord, 2592000);

  const first = await store.rotateRefreshToken(oldHash, newHashA, newRecord, 2592000);
  assert.equal(first, true);

  const second = await store.rotateRefreshToken(oldHash, newHashB, newRecord, 2592000);
  assert.equal(second, false, 'second rotation of same token must return false');

  // Only the first new token exists
  assert.ok(await store.getRefreshToken(newHashA) !== null);
  assert.equal(await store.getRefreshToken(newHashB), null);
});

test('MemoryOAuthStore: revokeRefreshTokenFamily and isFamilyRevoked', async () => {
  const store = new MemoryOAuthStore();
  const familyId = crypto.randomUUID();

  assert.equal(await store.isFamilyRevoked(familyId), false);
  await store.revokeRefreshTokenFamily(familyId, 2592000);
  assert.equal(await store.isFamilyRevoked(familyId), true);
});

// ---------------------------------------------------------------------------
// KvOAuthStore cross-instance tests using a shared MockRedis
//
// Two KvOAuthStore instances share one MockRedis to verify that state written
// by instance A is correctly read, consumed, and checked by instance B — the
// same contract that holds in production when two server processes share Upstash.
// ---------------------------------------------------------------------------

/**
 * Minimal Map-backed Redis mock that satisfies all operations used by KvOAuthStore.
 * TTLs are tracked but not enforced (tests don't rely on TTL expiry).
 */
class MockRedis {
  constructor() {
    this._store = new Map(); // key → { value: string, expiresAt: number|null }
  }

  _entry(key) {
    const e = this._store.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && Date.now() > e.expiresAt) {
      this._store.delete(key);
      return null;
    }
    return e;
  }

  async get(key) {
    const e = this._entry(key);
    if (!e) return null;
    try { return JSON.parse(e.value); } catch { return e.value; }
  }

  async set(key, value, opts) {
    const expiresAt = opts?.ex ? Date.now() + opts.ex * 1000 : null;
    this._store.set(key, { value: typeof value === 'string' ? value : JSON.stringify(value), expiresAt });
    return 'OK';
  }

  async getdel(key) {
    const e = this._entry(key);
    if (!e) return null;
    this._store.delete(key);
    try { return JSON.parse(e.value); } catch { return e.value; }
  }

  async ttl(key) {
    const e = this._entry(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((e.expiresAt - Date.now()) / 1000));
  }

  pipeline() {
    const ops = [];
    const pipe = {
      set: (key, value, opts) => { ops.push({ op: 'set', key, value, opts }); return pipe; },
      exec: async () => {
        const results = [];
        for (const { op, key, value, opts } of ops) {
          if (op === 'set') results.push(await this.set(key, value, opts));
        }
        return results;
      },
    };
    return pipe;
  }

  async eval(script, keys, args) {
    // Inline implementation of the ROTATE_SCRIPT logic.
    // Checks consumedAt atomically; returns 1 on success, 0 if already consumed.
    const rawOld = this._store.get(keys[0]);
    if (!rawOld) throw new Error('NOT_FOUND');
    let data;
    try { data = JSON.parse(rawOld.value); } catch { throw new Error('DECODE_ERROR'); }
    if (data.consumedAt != null) return 0;
    const oldTtlSec = Number(args[1]);
    const expiresAt = oldTtlSec > 0 ? Date.now() + oldTtlSec * 1000 : Date.now() + 300_000;
    this._store.set(keys[0], { value: args[0], expiresAt });
    const newTtlSec = Number(args[3]);
    this._store.set(keys[1], { value: args[2], expiresAt: Date.now() + newTtlSec * 1000 });
    return 1;
  }
}

test('KvOAuthStore: cross-instance — saveClient on A, getClient on B', async () => {
  const mockRedis = new MockRedis();
  const storeA = new KvOAuthStore(mockRedis);
  const storeB = new KvOAuthStore(mockRedis);

  const client = {
    clientId: 'kv_client_1',
    redirectUris: ['https://example.com/callback'],
    tokenEndpointAuthMethod: 'none',
    createdAt: Date.now(),
    isActive: true,
  };

  await storeA.saveClient(client);
  const retrieved = await storeB.getClient('kv_client_1');
  assert.deepEqual(retrieved, client);

  const missing = await storeB.getClient('nonexistent');
  assert.equal(missing, null);
});

test('KvOAuthStore: cross-instance — saveAuthCode on A, consumeAuthCode on B is single-use', async () => {
  const mockRedis = new MockRedis();
  const storeA = new KvOAuthStore(mockRedis);
  const storeB = new KvOAuthStore(mockRedis);

  const hash = crypto.randomBytes(16).toString('hex');
  const record = {
    clientId: 'c1',
    subject: 's1',
    redirectUri: 'https://example.com/callback',
    codeChallenge: 'ch',
    codeChallengeMethod: 'S256',
    scope: 'mcp:read mcp:write',
    expiresAt: Date.now() + 300_000,
  };

  await storeA.saveAuthCode(hash, record, 300);

  // B reads first (simulating validate-before-consume)
  const readByB = await storeB.getAuthCode(hash);
  assert.ok(readByB !== null, 'B should be able to read a code written by A');

  // B consumes — must succeed
  const consumed = await storeB.consumeAuthCode(hash);
  assert.deepEqual(consumed, record);

  // A tries to consume again — must return null
  const second = await storeA.consumeAuthCode(hash);
  assert.equal(second, null, 'second consumeAuthCode must return null');
});

test('KvOAuthStore: cross-instance — rotateRefreshToken on A only succeeds once', async () => {
  const mockRedis = new MockRedis();
  const storeA = new KvOAuthStore(mockRedis);
  const storeB = new KvOAuthStore(mockRedis);

  const oldHash = crypto.randomBytes(16).toString('hex');
  const newHashA = crypto.randomBytes(16).toString('hex');
  const newHashB = crypto.randomBytes(16).toString('hex');
  const familyId = crypto.randomUUID();

  const oldRecord = {
    clientId: 'c1',
    subject: 's1',
    scope: 'mcp:read mcp:write',
    familyId,
    expiresAt: Date.now() + 2_592_000_000,
    createdAt: Date.now(),
  };
  const newRecordA = { ...oldRecord, createdAt: Date.now() + 1 };
  const newRecordB = { ...oldRecord, createdAt: Date.now() + 2 };

  await storeA.saveRefreshToken(oldHash, oldRecord, 2592000);

  // A rotates first
  const rotatedByA = await storeA.rotateRefreshToken(oldHash, newHashA, newRecordA, 2592000);
  assert.equal(rotatedByA, true);

  // B tries to rotate the same old token — must fail
  const rotatedByB = await storeB.rotateRefreshToken(oldHash, newHashB, newRecordB, 2592000);
  assert.equal(rotatedByB, false, 'B rotation must fail because A already consumed the token');

  // Only A's new token exists
  const tokenFromA = await storeB.getRefreshToken(newHashA);
  assert.ok(tokenFromA !== null, "A's new token must be readable by B");

  const tokenFromB = await storeB.getRefreshToken(newHashB);
  assert.equal(tokenFromB, null, "B's new token must not exist");
});

// ---------------------------------------------------------------------------
// Full OAuth flow on a single server instance (memory store)
// ---------------------------------------------------------------------------

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
      MUSASHI_MCP_API_KEY: 'mcp_sk_test_kv_key',
      MCP_OAUTH_TOKEN_SECRET: 'test-secret-for-kv-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('Full OAuth flow on a single server instance (memory store)', async (t) => {
  const portA = 5500 + Math.floor(Math.random() * 100);
  const childA = createServer(portA);

  t.after(async () => {
    await stopChildProcess(childA);
  });

  await waitForHealth(portA);

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  // Register
  const regResponse = await fetch(`http://127.0.0.1:${portA}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
    }),
  });
  assert.equal(regResponse.status, 201);
  const client = await regResponse.json();

  // Authorize
  const authResponse = await fetch(`http://127.0.0.1:${portA}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector/oauth/callback',
      state: 'test-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      api_key: 'mcp_sk_test_kv_key',
    }),
    redirect: 'manual',
  });
  assert.equal(authResponse.status, 302);
  const code = new URL(authResponse.headers.get('location')).searchParams.get('code');
  assert.ok(code);

  // Exchange code
  const tokenResponse = await fetch(`http://127.0.0.1:${portA}/oauth/token`, {
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
  assert.equal(tokenResponse.status, 200);
  const tokenPayload = await tokenResponse.json();
  assert.equal(typeof tokenPayload.access_token, 'string');
  assert.equal(typeof tokenPayload.refresh_token, 'string');

  // Refresh token exchange
  const refreshResponse = await fetch(`http://127.0.0.1:${portA}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokenPayload.refresh_token,
      client_id: client.client_id,
    }),
  });
  assert.equal(refreshResponse.status, 200);
  const refreshPayload = await refreshResponse.json();
  assert.equal(typeof refreshPayload.access_token, 'string');
  assert.equal(typeof refreshPayload.refresh_token, 'string');

  // Original refresh token is now invalid (rotated)
  const replayResponse = await fetch(`http://127.0.0.1:${portA}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokenPayload.refresh_token,
      client_id: client.client_id,
    }),
  });
  assert.equal(replayResponse.status, 400);
  const replayPayload = await replayResponse.json();
  assert.equal(replayPayload.error, 'invalid_grant');
});
