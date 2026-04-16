import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callTool,
  initializeMcp,
  pass,
  randomTestPort,
  runMcpCase,
  spawnMcpServer,
  stopChild,
  testOptions,
  textFromToolResult,
  waitForServer,
} from './helpers/mcp-test-harness.mjs';
import { WALLET } from './helpers/mcp-tool-cases.mjs';

const LIVE_API_BASE_URL = (process.env.MUSASHI_MCP_LIVE_API_BASE_URL || 'https://musashi-api.vercel.app').replace(/\/$/, '');
const LIVE_MARKET_ID = process.env.MUSASHI_MCP_LIVE_MARKET_ID || process.env.MUSASHI_TEST_MARKET_ID || 'polymarket-test-market';
const LIVE_TIMEOUT_MS = readIntEnv('MUSASHI_MCP_LIVE_TIMEOUT_MS', 20000);

test('live active-wallet API endpoints are reachable', testOptions(), runMcpCase(async () => {
  const smartMoney = await requestLiveJson('/api/markets/smart-money?category=crypto&window=24h&limit=1');
  assert.equal(smartMoney.status, 200);
  assert.equal(smartMoney.body.success, true);
  assert.ok(Array.isArray(smartMoney.body.data?.markets), 'smart-money markets must be an array');

  const marketId = smartMoney.body.data.markets[0]?.marketId || LIVE_MARKET_ID;
  const walletFlow = await requestLiveJson(`/api/markets/wallet-flow?marketId=${encodeURIComponent(marketId)}&window=24h&limit=1`);
  assert.equal(walletFlow.status, 200);
  assert.equal(walletFlow.body.success, true);
  assert.equal(typeof walletFlow.body.data?.flow, 'object');

  const activity = await requestLiveJson(`/api/wallet/activity?wallet=${encodeURIComponent(WALLET)}&limit=1`);
  assert.equal(activity.status, 200);
  assert.equal(activity.body.success, true);
  assert.ok(Array.isArray(activity.body.data?.activity), 'wallet activity must be an array');

  const positions = await requestLiveJson(`/api/wallet/positions?wallet=${encodeURIComponent(WALLET)}&limit=1&minValue=0`);
  assert.equal(positions.status, 200);
  assert.equal(positions.body.success, true);
  assert.ok(Array.isArray(positions.body.data?.positions), 'wallet positions must be an array');

  return pass(`live active-wallet endpoints reachable at ${LIVE_API_BASE_URL}`);
}));

test('MCP active-wallet tools reach live API', testOptions(), runMcpCase(async () => {
  const port = randomTestPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawnMcpServer(port, LIVE_API_BASE_URL);

  try {
    await waitForServer(`${baseUrl}/health`);
    const sessionId = await initializeMcp(baseUrl, 'mcp-live-active-wallet-test');
    const marketId = await resolveLiveMarketId();

    const activity = await callTool(baseUrl, sessionId, 'get_wallet_activity', { wallet: WALLET, limit: 1 });
    assert.match(textFromToolResult(activity), /Wallet activity|No wallet activity/);
    assert.match(textFromToolResult(activity), new RegExp(escapeRegExp(WALLET), 'i'));

    const positions = await callTool(baseUrl, sessionId, 'get_wallet_positions', { wallet: WALLET, limit: 1, minValue: 0 });
    assert.match(textFromToolResult(positions), /Wallet positions|No open wallet positions/);
    assert.match(textFromToolResult(positions), new RegExp(escapeRegExp(WALLET), 'i'));

    const walletFlow = await callTool(baseUrl, sessionId, 'get_market_wallet_flow', { marketId, window: '24h', limit: 1 });
    assert.match(textFromToolResult(walletFlow), /Wallet flow/);

    const smartMoney = await callTool(baseUrl, sessionId, 'get_smart_money_markets', { category: 'crypto', window: '24h', limit: 1 });
    assert.match(textFromToolResult(smartMoney), /Smart-money markets|No smart-money markets/);

    return pass(`MCP active-wallet tools reached ${LIVE_API_BASE_URL}`);
  } finally {
    await stopChild(child);
  }
}));

async function resolveLiveMarketId() {
  const smartMoney = await requestLiveJson('/api/markets/smart-money?category=crypto&window=24h&limit=1');
  return smartMoney.body.data?.markets?.[0]?.marketId || LIVE_MARKET_ID;
}

async function requestLiveJson(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);

  try {
    const response = await fetch(`${LIVE_API_BASE_URL}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const text = await response.text();
    let body;

    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON from ${path}, got status ${response.status}: ${text.slice(0, 160)}`);
    }

    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
