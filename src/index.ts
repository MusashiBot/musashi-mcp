#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { StreamableHttpServer } from './server/streamable-http-server.js';
import { MemoryOAuthStore, type OAuthStore } from './server/oauth-store.js';
import { KvOAuthStore } from './server/kv-oauth-store.js';

const API_BASE_URL = (process.env.MUSASHI_API_BASE_URL || 'https://musashi-api.vercel.app').replace(/\/$/, '');
const MCP_PROTOCOL_VERSION = '2025-06-18';

type JsonRecord = Record<string, any>;

interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
}

const PROMPTS: PromptDefinition[] = [
  {
    name: 'find_arbitrage_now',
    title: 'Find Arbitrage Now',
    description:
      'Use Musashi to find current arbitrage opportunities between Polymarket and Kalshi.',
    arguments: [
      {
        name: 'minSpread',
        description: 'Optional minimum spread as a decimal, for example 0.02 for 2%.',
      },
      {
        name: 'limit',
        description: 'Optional maximum number of opportunities to return.',
      },
    ],
  },
  {
    name: 'show_market_movers',
    title: 'Show Market Movers',
    description:
      'Use Musashi to show markets with the biggest recent price moves.',
    arguments: [
      {
        name: 'minChange',
        description: 'Optional minimum price move as a decimal, for example 0.03 for 3%.',
      },
      {
        name: 'limit',
        description: 'Optional maximum number of movers to return.',
      },
    ],
  },
  {
    name: 'ground_a_claim',
    title: 'Ground A Claim',
    description:
      'Use Musashi to compare a real-world claim to current market-implied probability.',
    arguments: [
      {
        name: 'claim',
        description: 'The claim or prediction to evaluate against live market data.',
        required: true,
      },
    ],
  },
];

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'n/a';
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatVolume(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'n/a';
  }

  return `$${value.toLocaleString()}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return 'n/a';
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'n/a';
  }

  return value.toLocaleString();
}

function formatWalletMetadata(metadata: JsonRecord | null | undefined): string {
  if (!metadata) {
    return '';
  }

  const cacheAge = metadata.cache_age_seconds ?? 'n/a';
  const processing = metadata.processing_time_ms ?? 'n/a';
  return `Source: ${metadata.source || 'polymarket'} | Cached: ${metadata.cached ? 'yes' : 'no'} | Cache age: ${cacheAge}s | Processing: ${processing}ms`;
}

function buildTextResult(lines: string[], isError = false): JsonRecord {
  return {
    content: [
      {
        type: 'text',
        text: lines.filter(Boolean).join('\n'),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

interface OptionalJsonResult {
  label: string;
  payload?: JsonRecord;
  error?: string;
}

interface MarketIdentity {
  marketId?: string;
  conditionId?: string;
  query?: string;
  title?: string;
  category?: string;
}

interface MarketContext {
  identity: MarketIdentity;
  title: string;
  market: JsonRecord | null;
  flow: JsonRecord | null;
  flowAgreesWithPriceMove: boolean | null;
  mover: JsonRecord | null;
  feedItems: JsonRecord[];
  arbitrage: JsonRecord | null;
  unavailable: string[];
}

async function fetchJson(path: string, init?: RequestInit): Promise<JsonRecord> {
  const signal = AbortSignal.timeout(30_000);
  const response = await fetch(`${API_BASE_URL}${path}`, { signal, ...init });
  const text = await response.text();

  let payload: JsonRecord = {};
  if (text) {
    try {
      payload = JSON.parse(text) as JsonRecord;
    } catch {
      throw new Error(`Invalid JSON response from ${path}: ${text.slice(0, 200)}`);
    }
  }

  if (!response.ok) {
    throw new Error(payload.error || `Request failed with HTTP ${response.status}`);
  }

  return payload;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getMarketIdentity(args: JsonRecord): MarketIdentity {
  return {
    marketId: getStringArg(args.marketId),
    conditionId: getStringArg(args.conditionId),
    query: getStringArg(args.query),
    category: getStringArg(args.category),
  };
}

function hasMarketIdentity(identity: MarketIdentity): boolean {
  return Boolean(identity.marketId || identity.conditionId || identity.query);
}

function buildMarketIdentityParams(identity: MarketIdentity): URLSearchParams {
  const params = new URLSearchParams();
  if (identity.marketId) params.set('marketId', identity.marketId);
  if (identity.conditionId) params.set('conditionId', identity.conditionId);
  if (identity.query) params.set('query', identity.query);
  return params;
}

function enrichMarketIdentity(
  base: MarketIdentity,
  flow: JsonRecord | null,
  market: JsonRecord | null,
): MarketIdentity {
  return {
    ...base,
    marketId: base.marketId || getStringArg(flow?.marketId) || getStringArg(market?.id),
    conditionId: base.conditionId || getStringArg(flow?.conditionId) || stripPolymarketPrefix(getStringArg(market?.id)),
    title: getStringArg(flow?.marketTitle) || getStringArg(market?.title) || base.query,
    category: base.category || getStringArg(market?.category),
  };
}

function firstMarketFromAnalyze(payload: JsonRecord | undefined): JsonRecord | null {
  const matches = payload?.data?.markets;
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const market = matches[0]?.market;
  return isRecord(market) ? market : null;
}

function getFlowFromPayload(payload: JsonRecord | undefined): JsonRecord | null {
  const flow = payload?.data?.flow;
  return isRecord(flow) ? flow : null;
}

function getMarketFromFlowPayload(payload: JsonRecord | undefined): JsonRecord | null {
  const market = payload?.data?.market;
  return isRecord(market) ? market : null;
}

function getFlowAgreement(payload: JsonRecord | undefined): boolean | null {
  const value = payload?.data?.flow_agrees_with_price_move;
  return typeof value === 'boolean' ? value : null;
}

function findRelatedMover(
  payload: JsonRecord | undefined,
  identity: MarketIdentity,
  title: string,
): JsonRecord | null {
  const movers = payload?.data?.movers;
  if (!Array.isArray(movers)) return null;

  return movers.find((mover: JsonRecord) =>
    marketMatchesIdentity(mover.market, identity, title)
  ) ?? null;
}

function findRelatedArbitrage(
  payload: JsonRecord | undefined,
  identity: MarketIdentity,
  title: string,
): JsonRecord | null {
  const opportunities = payload?.data?.opportunities;
  if (!Array.isArray(opportunities)) return null;

  return opportunities.find((opportunity: JsonRecord) =>
    marketMatchesIdentity(opportunity.polymarket, identity, title) ||
    marketMatchesIdentity(opportunity.kalshi, identity, title)
  ) ?? null;
}

function findRelatedFeedItems(
  payload: JsonRecord | undefined,
  identity: MarketIdentity,
  title: string,
  limit: number,
): JsonRecord[] {
  const tweets = payload?.data?.tweets;
  if (!Array.isArray(tweets)) return [];

  return tweets
    .filter((item: JsonRecord) => {
      const matches = Array.isArray(item.matches) ? item.matches : [];
      if (matches.some((match: JsonRecord) => marketMatchesIdentity(match.market, identity, title))) {
        return true;
      }

      return textMatchesIdentity(item.tweet?.text, identity, title);
    })
    .slice(0, limit);
}

function marketMatchesIdentity(
  market: unknown,
  identity: MarketIdentity,
  title: string,
): boolean {
  if (!isRecord(market)) return false;

  const marketId = getStringArg(market.id) || getStringArg(market.marketId);
  const conditionId = getStringArg(market.conditionId) || stripPolymarketPrefix(marketId);
  const marketTitle = getStringArg(market.title) || getStringArg(market.marketTitle);

  if (identity.marketId && equalsIgnoreCase(marketId, identity.marketId)) return true;
  if (identity.marketId && equalsIgnoreCase(stripPolymarketPrefix(identity.marketId), conditionId)) return true;
  if (identity.conditionId && equalsIgnoreCase(conditionId, identity.conditionId)) return true;

  return textMatchesIdentity(marketTitle, identity, title);
}

function textMatchesIdentity(
  value: unknown,
  identity: MarketIdentity,
  title: string,
): boolean {
  const text = normalizeText(getStringArg(value));
  if (!text) return false;

  const candidates = [identity.query, identity.title, title]
    .map(normalizeText)
    .filter(Boolean);

  return candidates.some(candidate =>
    text.includes(candidate) ||
    candidate.includes(text) ||
    tokenOverlap(text, candidate) >= 2
  );
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  return tokenize(right).filter(token => leftTokens.has(token)).length;
}

function tokenize(value: string): string[] {
  return value
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3);
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function getStringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function equalsIgnoreCase(left?: string, right?: string): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function stripPolymarketPrefix(value?: string): string | undefined {
  const stripped = value?.replace(/^polymarket-/i, '').trim();
  return stripped || undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class MusashiMcpServer {
  private readonly server: Server;
  private streamableHttpServer: StreamableHttpServer | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'musashi',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
        },
      }
    );

    this.registerToolHandlers();
    this.registerProcessHandlers();
  }

  private registerToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => this.listTools());

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return this.callTool(name, args ?? {});
    });
  }

  private listTools(): JsonRecord {
    return {
      tools: [
        {
          name: 'analyze_text',
          description:
            'Analyze a claim, tweet, headline, or free-form text against live prediction market data. Use this when the user mentions a statement, prediction, or news headline and wants to know what the markets say about it.',
          inputSchema: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description:
                  'The text, claim, tweet, or statement to analyze against live markets.',
              },
              minConfidence: { type: 'number', minimum: 0, maximum: 1 },
              maxResults: { type: 'number', minimum: 1, maximum: 100 },
            },
            required: ['text'],
          },
        },
        {
          name: 'get_arbitrage',
          description:
            'Find current arbitrage opportunities between Polymarket and Kalshi. Use this when the user asks about price discrepancies, spreads, or cross-platform trading opportunities.',
          inputSchema: {
            type: 'object',
            properties: {
              minSpread: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description: 'Optional minimum spread threshold as a decimal, for example 0.02 for 2%.',
              },
              minConfidence: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description: 'Optional minimum cross-platform match confidence.',
              },
              limit: {
                type: 'number',
                minimum: 1,
                maximum: 100,
                description: 'Optional maximum number of opportunities to return.',
              },
              category: {
                type: 'string',
                description: 'Optional market category filter.',
              },
            },
          },
        },
        {
          name: 'get_movers',
          description:
            'Get markets with the biggest recent price moves. Use this when the user asks what is moving, what changed, or wants to see large price swings.',
          inputSchema: {
            type: 'object',
            properties: {
              minChange: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description: 'Optional minimum price move threshold as a decimal.',
              },
              limit: {
                type: 'number',
                minimum: 1,
                maximum: 100,
                description: 'Optional maximum number of movers to return.',
              },
              category: {
                type: 'string',
                description: 'Optional market category filter.',
              },
            },
          },
        },
        {
          name: 'ground_probability',
          description:
            'Ground a real-world claim in live market-implied probability. Use this when the user wants to know the market\'s current probability estimate for a specific event or claim.',
          inputSchema: {
            type: 'object',
            properties: {
              claim: {
                type: 'string',
                description: 'The real-world claim or prediction to ground in live market data.',
              },
              llm_estimate: { type: 'number', minimum: 0, maximum: 1 },
              min_confidence: { type: 'number', minimum: 0, maximum: 1 },
              max_markets: { type: 'number', minimum: 1, maximum: 20 },
            },
            required: ['claim'],
          },
        },
        {
          name: 'get_feed',
          description:
            'Get recent analyzed feed items, tweets, and breaking signals from Musashi. Use this when the user asks about recent news, social signals, or what is being discussed in prediction market circles.',
          inputSchema: {
            type: 'object',
            properties: {
              category: { type: 'string' },
              minUrgency: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'critical'],
              },
              limit: { type: 'number', minimum: 1, maximum: 100 },
              since: { type: 'string' },
            },
          },
        },
        {
          name: 'get_feed_stats',
          description:
            'Get Musashi feed statistics including volume, urgency breakdown, and top-mentioned markets. Use this for an overview of feed activity rather than individual items.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_feed_accounts',
          description:
            'List the accounts and sources that Musashi monitors for its feed. Use this when the user asks about data sources or which accounts are tracked.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_wallet_activity',
          description: 'Fetch recent public Polymarket activity for a wallet.',
          inputSchema: {
            type: 'object',
            properties: {
              wallet: { type: 'string', description: 'Public Polymarket wallet address.' },
              limit: { type: 'number', minimum: 1, maximum: 100, description: 'Max activity rows.' },
              since: { type: 'string', description: 'Optional ISO lower-bound timestamp.' },
            },
            required: ['wallet'],
          },
        },
        {
          name: 'get_wallet_positions',
          description: 'Fetch current public Polymarket positions for a wallet.',
          inputSchema: {
            type: 'object',
            properties: {
              wallet: { type: 'string', description: 'Public Polymarket wallet address.' },
              minValue: { type: 'number', minimum: 0, description: 'Minimum current value.' },
              limit: { type: 'number', minimum: 1, maximum: 100, description: 'Max position rows.' },
            },
            required: ['wallet'],
          },
        },
        {
          name: 'get_market_wallet_flow',
          description: 'Explain recent public wallet flow for a market.',
          inputSchema: {
            type: 'object',
            properties: {
              marketId: { type: 'string', description: 'Musashi or Polymarket market id.' },
              conditionId: { type: 'string', description: 'Polymarket condition id.' },
              query: { type: 'string', description: 'Market search text.' },
              window: { type: 'string', enum: ['1h', '24h', '7d'], description: 'Flow time window.' },
              limit: { type: 'number', minimum: 1, maximum: 100, description: 'Max activity rows.' },
            },
          },
        },
        {
          name: 'get_smart_money_markets',
          description: 'Find markets with unusual smart-wallet activity.',
          inputSchema: {
            type: 'object',
            properties: {
              category: { type: 'string', description: 'Optional Musashi category.' },
              window: { type: 'string', enum: ['1h', '24h', '7d'], description: 'Ranking time window.' },
              minVolume: { type: 'number', minimum: 0, description: 'Minimum flow volume.' },
              limit: { type: 'number', minimum: 1, maximum: 100, description: 'Max markets.' },
            },
          },
        },
        {
          name: 'get_market_brief',
          description: 'Get a combined brief for a specific market including price, wallet flow, recent movers, feed mentions, and arbitrage context. Requires at least one of: marketId, conditionId, or query to identify the market.',
          inputSchema: {
            type: 'object',
            properties: {
              marketId: { type: 'string', description: 'Musashi or Polymarket market id.' },
              conditionId: { type: 'string', description: 'Polymarket condition id.' },
              query: { type: 'string', description: 'Market search text — use this if you only have the market name or a description.' },
              category: { type: 'string', description: 'Optional Musashi category.' },
              window: { type: 'string', enum: ['1h', '24h', '7d'], description: 'Wallet-flow window.' },
              flowLimit: { type: 'number', minimum: 1, maximum: 100, description: 'Max wallet-flow rows.' },
            },
            anyOf: [
              { required: ['marketId'] },
              { required: ['conditionId'] },
              { required: ['query'] },
            ],
          },
        },
        {
          name: 'explain_market_move',
          description: 'Explain why a specific market moved, using wallet flow, movers, feed, and arbitrage signals. Requires at least one of: marketId, conditionId, or query to identify the market. Returns a directional read and bottom-line interpretation.',
          inputSchema: {
            type: 'object',
            properties: {
              marketId: { type: 'string', description: 'Musashi or Polymarket market id.' },
              conditionId: { type: 'string', description: 'Polymarket condition id.' },
              query: { type: 'string', description: 'Market search text — use this if you only have the market name or a description.' },
              category: { type: 'string', description: 'Optional Musashi category.' },
              window: { type: 'string', enum: ['1h', '24h', '7d'], description: 'Wallet-flow window.' },
              minChange: { type: 'number', minimum: 0, maximum: 1, description: 'Minimum mover change.' },
              flowLimit: { type: 'number', minimum: 1, maximum: 100, description: 'Max wallet-flow rows.' },
            },
            anyOf: [
              { required: ['marketId'] },
              { required: ['conditionId'] },
              { required: ['query'] },
            ],
          },
        },
        {
          name: 'get_health',
          description:
            'Check the health and availability of the Musashi API and its data sources (Polymarket, Kalshi). Use this when the user asks if the service is working or data is fresh.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    };
  }

  private listPrompts(): JsonRecord {
    return {
      prompts: PROMPTS.map((prompt) => ({
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        arguments: prompt.arguments ?? [],
      })),
    };
  }

  private getPrompt(name: string, args: JsonRecord): JsonRecord {
    switch (name) {
      case 'find_arbitrage_now': {
        const minSpread = args.minSpread ? ` with a minimum spread of ${args.minSpread}` : '';
        const limit = args.limit ? ` and return up to ${args.limit} opportunities` : '';
        return {
          description: 'Find current arbitrage opportunities between Polymarket and Kalshi.',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Use Musashi to find current arbitrage opportunities between Polymarket and Kalshi${minSpread}${limit}.`,
              },
            },
          ],
        };
      }
      case 'show_market_movers': {
        const minChange = args.minChange ? ` with a minimum move of ${args.minChange}` : '';
        const limit = args.limit ? ` and return up to ${args.limit} markets` : '';
        return {
          description: 'Show the biggest market movers right now.',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Use Musashi to show the biggest market movers right now${minChange}${limit}.`,
              },
            },
          ],
        };
      }
      case 'ground_a_claim': {
        const claim = typeof args.claim === 'string' && args.claim.trim() ? args.claim.trim() : 'this claim';
        return {
          description: 'Ground a claim in live market probabilities.',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Use Musashi to ground the probability of this claim in live market data: ${claim}`,
              },
            },
          ],
        };
      }
      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  }

  private async callTool(name: string, args: JsonRecord): Promise<JsonRecord> {
    try {
      switch (name) {
        case 'analyze_text':
          return await this.handleAnalyzeText(args);
        case 'get_arbitrage':
          return await this.handleGetArbitrage(args);
        case 'get_movers':
          return await this.handleGetMovers(args);
        case 'ground_probability':
          return await this.handleGroundProbability(args);
        case 'get_feed':
          return await this.handleGetFeed(args);
        case 'get_feed_stats':
          return await this.handleGetFeedStats();
        case 'get_feed_accounts':
          return await this.handleGetFeedAccounts();
        case 'get_wallet_activity':
          return await this.handleGetWalletActivity(args);
        case 'get_wallet_positions':
          return await this.handleGetWalletPositions(args);
        case 'get_market_wallet_flow':
          return await this.handleGetMarketWalletFlow(args);
        case 'get_smart_money_markets':
          return await this.handleGetSmartMoneyMarkets(args);
        case 'get_market_brief':
          return await this.handleGetMarketBrief(args);
        case 'explain_market_move':
          return await this.handleExplainMarketMove(args);
        case 'get_health':
          return await this.handleGetHealth();
        default:
          return buildTextResult([`Unknown tool: ${name}`], true);
      }
    } catch (error) {
      return buildTextResult(
        [error instanceof Error ? error.message : 'Unknown MCP tool error'],
        true
      );
    }
  }

  private async handleAnalyzeText(args: JsonRecord): Promise<JsonRecord> {
    const payload = await fetchJson('/api/analyze-text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: args.text,
        minConfidence: args.minConfidence,
        maxResults: args.maxResults,
      }),
    });

    const data = payload.data ?? {};
    const matches = Array.isArray(data.markets) ? data.markets : [];

    if (matches.length === 0) {
      return buildTextResult([
        `No matching markets found for "${String(args.text || '')}".`,
      ]);
    }

    const lines = [`Found ${matches.length} matching markets:`, ''];

    matches.forEach((match: JsonRecord, index: number) => {
      const market = match.market ?? {};
      lines.push(`${index + 1}. ${market.title || 'Untitled market'}`);
      lines.push(`Platform: ${market.platform || 'n/a'}`);
      lines.push(`Yes price: ${formatPercent(market.yesPrice)}`);
      lines.push(`Volume 24h: ${formatVolume(market.volume24h)}`);
      lines.push(`Match confidence: ${formatPercent(match.confidence)}`);
      if (Array.isArray(match.matchedKeywords) && match.matchedKeywords.length > 0) {
        lines.push(`Matched keywords: ${match.matchedKeywords.join(', ')}`);
      }
      if (market.url) {
        lines.push(`URL: ${market.url}`);
      }
      lines.push('');
    });

    if (data.suggested_action) {
      lines.push('Suggested action:');
      lines.push(`Direction: ${data.suggested_action.direction}`);
      lines.push(`Confidence: ${formatPercent(data.suggested_action.confidence)}`);
      lines.push(`Edge: ${formatPercent(data.suggested_action.edge)}`);
      lines.push(`Reasoning: ${data.suggested_action.reasoning}`);
      lines.push('');
    }

    if (data.sentiment) {
      lines.push('Sentiment:');
      lines.push(`${data.sentiment.sentiment} (${formatPercent(data.sentiment.confidence)})`);
      lines.push('');
    }

    if (data.arbitrage) {
      lines.push('Arbitrage context:');
      lines.push(`Spread: ${formatPercent(data.arbitrage.spread)}`);
      lines.push(`Direction: ${data.arbitrage.direction}`);
      lines.push('');
    }

    if (data.metadata) {
      lines.push(
        `Processing: ${data.metadata.processing_time_ms ?? 'n/a'}ms | Data age: ${data.metadata.data_age_seconds ?? 'n/a'}s`
      );
    }

    return buildTextResult(lines);
  }

  private async handleGetArbitrage(args: JsonRecord): Promise<JsonRecord> {
    const params = new URLSearchParams();

    if (args.minSpread !== undefined) params.set('minSpread', String(args.minSpread));
    if (args.minConfidence !== undefined) params.set('minConfidence', String(args.minConfidence));
    if (args.limit !== undefined) params.set('limit', String(args.limit));
    if (args.category) params.set('category', String(args.category));

    const payload = await fetchJson(`/api/markets/arbitrage?${params.toString()}`);
    const opportunities = payload.data?.opportunities ?? [];

    if (!Array.isArray(opportunities) || opportunities.length === 0) {
      return buildTextResult(['No arbitrage opportunities found for the requested filters.']);
    }

    const lines = [`Found ${opportunities.length} arbitrage opportunities:`, ''];

    opportunities.forEach((opportunity: JsonRecord, index: number) => {
      const polymarket = opportunity.polymarket ?? {};
      const kalshi = opportunity.kalshi ?? {};
      lines.push(`${index + 1}. ${polymarket.title || kalshi.title || 'Untitled market'}`);
      lines.push(`Spread: ${formatPercent(opportunity.spread)}`);
      lines.push(`Direction: ${opportunity.direction || 'n/a'}`);
      lines.push(`Polymarket yes: ${formatPercent(polymarket.yesPrice)} | volume ${formatVolume(polymarket.volume24h)}`);
      lines.push(`Kalshi yes: ${formatPercent(kalshi.yesPrice)} | volume ${formatVolume(kalshi.volume24h)}`);
      lines.push(`Match confidence: ${formatPercent(opportunity.confidence)}`);
      if (opportunity.matchReason) {
        lines.push(`Match reason: ${opportunity.matchReason}`);
      }
      lines.push('');
    });

    return buildTextResult(lines);
  }

  private async handleGetMovers(args: JsonRecord): Promise<JsonRecord> {
    const params = new URLSearchParams();

    if (args.minChange !== undefined) params.set('minChange', String(args.minChange));
    if (args.limit !== undefined) params.set('limit', String(args.limit));
    if (args.category) params.set('category', String(args.category));

    const payload = await fetchJson(`/api/markets/movers?${params.toString()}`);
    const movers = payload.data?.movers ?? [];

    if (!Array.isArray(movers) || movers.length === 0) {
      return buildTextResult(['No significant movers found for the requested filters.']);
    }

    const lines = [`Found ${movers.length} market movers:`, ''];

    movers.forEach((mover: JsonRecord, index: number) => {
      const market = mover.market ?? {};
      lines.push(`${index + 1}. ${market.title || 'Untitled market'}`);
      lines.push(`Direction: ${mover.direction || 'n/a'}`);
      lines.push(`Change: ${formatPercent(mover.priceChange1h)}`);
      lines.push(`Previous: ${formatPercent(mover.previousPrice)} | Current: ${formatPercent(mover.currentPrice)}`);
      lines.push(`Platform: ${market.platform || 'n/a'} | Volume: ${formatVolume(market.volume24h)}`);
      lines.push('');
    });

    return buildTextResult(lines);
  }

  private async handleGroundProbability(args: JsonRecord): Promise<JsonRecord> {
    const payload = await fetchJson('/api/ground-probability', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        claim: args.claim,
        llm_estimate: args.llm_estimate,
        min_confidence: args.min_confidence,
        max_markets: args.max_markets,
      }),
    });

    const consensus = payload.market_consensus ?? {};
    const lines = ['Ground probability analysis:', ''];

    lines.push(`Claim: ${payload.claim || String(args.claim || '')}`);
    lines.push(`Market consensus: ${formatPercent(consensus.price)}`);
    lines.push(`Market-match confidence: ${formatPercent(consensus.confidence)}`);
    lines.push(`Markets considered: ${consensus.market_count ?? 0}`);

    if (payload.llm_estimate !== null && payload.llm_estimate !== undefined) {
      lines.push(`LLM estimate: ${formatPercent(payload.llm_estimate)}`);
    }

    if (payload.divergence) {
      lines.push(`Divergence type: ${payload.divergence.type}`);
      lines.push(`Divergence magnitude: ${payload.divergence.magnitude_percent?.toFixed?.(1) ?? 'n/a'} percentage points`);
      lines.push(`Insight: ${payload.divergence.insight}`);
    }

    const markets = Array.isArray(consensus.markets) ? consensus.markets : [];
    if (markets.length > 0) {
      lines.push('');
      lines.push('Supporting markets:');
      markets.forEach((market: JsonRecord, index: number) => {
        lines.push(`${index + 1}. ${market.title}`);
        lines.push(`Platform: ${market.platform}`);
        lines.push(`Yes price: ${formatPercent(market.yes_price)}`);
        lines.push(`Volume 24h: ${formatVolume(market.volume_24h)}`);
        lines.push(`Match confidence: ${formatPercent(market.match_confidence)}`);
        if (market.url) {
          lines.push(`URL: ${market.url}`);
        }
      });
    }

    if (payload.metadata) {
      lines.push('');
      lines.push(
        `Processing: ${payload.metadata.processing_time_ms ?? 'n/a'}ms | Data age: ${payload.metadata.data_age_seconds ?? 'n/a'}s`
      );
    }

    return buildTextResult(lines);
  }

  private async handleGetFeed(args: JsonRecord): Promise<JsonRecord> {
    const params = new URLSearchParams();

    if (args.category) params.set('category', String(args.category));
    if (args.minUrgency) params.set('minUrgency', String(args.minUrgency));
    if (args.limit !== undefined) params.set('limit', String(args.limit));
    if (args.since) params.set('since', String(args.since));

    const payload = await fetchJson(`/api/feed?${params.toString()}`);
    const tweets = payload.data?.tweets ?? [];

    if (!Array.isArray(tweets) || tweets.length === 0) {
      return buildTextResult(['No feed items found for the requested filters.']);
    }

    const lines = [`Found ${tweets.length} feed items:`, ''];

    tweets.forEach((tweet: JsonRecord, index: number) => {
      const rawTweet = tweet.tweet ?? {};
      lines.push(`${index + 1}. @${rawTweet.author || 'unknown'} (${tweet.urgency || 'n/a'} urgency)`);
      lines.push(`${rawTweet.text || ''}`);
      lines.push(`Collected: ${formatDate(tweet.collected_at)}`);
      lines.push(`Matches: ${Array.isArray(tweet.matches) ? tweet.matches.length : 0}`);
      lines.push('');
    });

    return buildTextResult(lines);
  }

  private async handleGetFeedStats(): Promise<JsonRecord> {
    const payload = await fetchJson('/api/feed/stats');
    const data = payload.data ?? {};
    const lines = ['Feed statistics:', ''];

    lines.push(`Last collection: ${formatDate(data.last_collection)}`);
    lines.push(`Tweets last 1h: ${data.tweets?.last_1h ?? 0}`);
    lines.push(`Tweets last 6h: ${data.tweets?.last_6h ?? 0}`);
    lines.push(`Tweets last 24h: ${data.tweets?.last_24h ?? 0}`);

    if (data.by_category) {
      lines.push('');
      lines.push('By category:');
      for (const [category, count] of Object.entries(data.by_category)) {
        lines.push(`${category}: ${count}`);
      }
    }

    if (data.by_urgency) {
      lines.push('');
      lines.push('By urgency:');
      for (const [urgency, count] of Object.entries(data.by_urgency)) {
        lines.push(`${urgency}: ${count}`);
      }
    }

    if (Array.isArray(data.top_markets) && data.top_markets.length > 0) {
      lines.push('');
      lines.push('Top markets:');
      data.top_markets.forEach((entry: JsonRecord, index: number) => {
        const market = entry.market ?? {};
        lines.push(`${index + 1}. ${market.title || 'Untitled market'} (${entry.mention_count ?? 0} mentions)`);
      });
    }

    return buildTextResult(lines);
  }

  private async handleGetFeedAccounts(): Promise<JsonRecord> {
    const payload = await fetchJson('/api/feed/accounts');
    const accounts = payload.data?.accounts ?? [];

    if (!Array.isArray(accounts) || accounts.length === 0) {
      return buildTextResult(['No tracked accounts found.']);
    }

    const lines = [`Tracked accounts (${accounts.length}):`, ''];

    accounts.forEach((account: JsonRecord, index: number) => {
      lines.push(`${index + 1}. @${account.username}`);
      lines.push(`Category: ${account.category || 'n/a'} | Priority: ${account.priority || 'n/a'}`);
      if (account.description) {
        lines.push(account.description);
      }
      lines.push('');
    });

    return buildTextResult(lines);
  }

  /**
   * Fetch and format wallet activity.
   *
   * @param args Tool input with wallet and optional filters.
   */
  private async handleGetWalletActivity(args: JsonRecord): Promise<JsonRecord> {
    const wallet = typeof args.wallet === 'string' ? args.wallet : '';
    const params = new URLSearchParams({ wallet });

    if (args.limit !== undefined) params.set('limit', String(args.limit));
    if (args.since) params.set('since', String(args.since));

    const payload = await fetchJson(`/api/wallet/activity?${params.toString()}`);
    const activity = payload.data?.activity ?? [];

    if (!Array.isArray(activity) || activity.length === 0) {
      return buildTextResult([
        `No wallet activity found for ${wallet || 'the requested wallet'}.`,
        formatWalletMetadata(payload.metadata),
      ]);
    }

    const lines = [`Wallet activity for ${payload.metadata?.wallet || wallet}:`, ''];

    activity.forEach((item: JsonRecord, index: number) => {
      lines.push(`${index + 1}. ${item.marketTitle || 'Untitled market'}`);
      lines.push(`Activity: ${item.activityType || 'unknown'} | Side: ${item.side || 'n/a'} | Outcome: ${item.outcome || 'n/a'}`);
      lines.push(`Price: ${formatPercent(item.price)} | Size: ${formatNumber(item.size)} | Value: ${formatVolume(item.value)}`);
      lines.push(`Time: ${formatDate(item.timestamp)}`);
      if (item.url) lines.push(`URL: ${item.url}`);
      lines.push('');
    });

    const metadataLine = formatWalletMetadata(payload.metadata);
    if (metadataLine) lines.push(metadataLine);

    return buildTextResult(lines);
  }

  /**
   * Fetch and format wallet positions.
   *
   * @param args Tool input with wallet and optional filters.
   */
  private async handleGetWalletPositions(args: JsonRecord): Promise<JsonRecord> {
    const wallet = typeof args.wallet === 'string' ? args.wallet : '';
    const params = new URLSearchParams({ wallet });

    if (args.minValue !== undefined) params.set('minValue', String(args.minValue));
    if (args.limit !== undefined) params.set('limit', String(args.limit));

    const payload = await fetchJson(`/api/wallet/positions?${params.toString()}`);
    const positions = payload.data?.positions ?? [];

    if (!Array.isArray(positions) || positions.length === 0) {
      return buildTextResult([
        `No open wallet positions found for ${wallet || 'the requested wallet'}.`,
        formatWalletMetadata(payload.metadata),
      ]);
    }

    const lines = [`Wallet positions for ${payload.metadata?.wallet || wallet}:`, ''];

    positions.forEach((position: JsonRecord, index: number) => {
      lines.push(`${index + 1}. ${position.marketTitle || 'Untitled market'}`);
      lines.push(`Outcome: ${position.outcome || 'n/a'} | Quantity: ${formatNumber(position.quantity)}`);
      lines.push(`Average: ${formatPercent(position.averagePrice)} | Current: ${formatPercent(position.currentPrice)}`);
      lines.push(`Value: ${formatVolume(position.currentValue)} | Realized PnL: ${formatVolume(position.realizedPnl)} | Unrealized PnL: ${formatVolume(position.unrealizedPnl)}`);
      lines.push(`Updated: ${formatDate(position.updatedAt)}`);
      if (position.url) lines.push(`URL: ${position.url}`);
      lines.push('');
    });

    const metadataLine = formatWalletMetadata(payload.metadata);
    if (metadataLine) lines.push(metadataLine);

    return buildTextResult(lines);
  }

  /**
   * Fetch and format market wallet flow.
   *
   * @param args Tool input with market identity and window.
   */
  private async handleGetMarketWalletFlow(args: JsonRecord): Promise<JsonRecord> {
    const params = new URLSearchParams();

    if (args.marketId) params.set('marketId', String(args.marketId));
    if (args.conditionId) params.set('conditionId', String(args.conditionId));
    if (args.query) params.set('query', String(args.query));
    if (args.window) params.set('window', String(args.window));
    if (args.limit !== undefined) params.set('limit', String(args.limit));

    const payload = await fetchJson(`/api/markets/wallet-flow?${params.toString()}`);
    const flow = payload.data?.flow ?? payload.data ?? {};
    const largeTrades = Array.isArray(flow.largeTrades) ? flow.largeTrades : [];

    const lines = [`Wallet flow for ${flow.marketTitle || flow.marketId || 'market'}:`, ''];
    lines.push(`Window: ${flow.window || args.window || '24h'}`);
    lines.push(`Net direction: ${flow.netDirection || 'unknown'} | Net volume: ${formatVolume(flow.netVolume)}`);
    lines.push(`Buy volume: ${formatVolume(flow.buyVolume)} | Sell volume: ${formatVolume(flow.sellVolume)}`);
    lines.push(`Wallets: ${formatNumber(flow.walletCount)} | Smart wallets: ${formatNumber(flow.smartWalletCount)}`);

    if (largeTrades.length > 0) {
      lines.push('');
      lines.push('Large trades:');
      largeTrades.slice(0, 5).forEach((trade: JsonRecord, index: number) => {
        lines.push(`${index + 1}. ${trade.marketTitle || flow.marketTitle || 'Untitled market'}`);
        lines.push(`Side: ${trade.side || 'n/a'} | Outcome: ${trade.outcome || 'n/a'} | Value: ${formatVolume(trade.value)}`);
        lines.push(`Price: ${formatPercent(trade.price)} | Time: ${formatDate(trade.timestamp)}`);
        if (trade.url) lines.push(`URL: ${trade.url}`);
      });
    }

    const metadataLine = formatWalletMetadata(payload.metadata);
    if (metadataLine) {
      lines.push('');
      lines.push(metadataLine);
    }

    return buildTextResult(lines);
  }

  /**
   * Fetch and format smart-money market rankings.
   *
   * @param args Tool input with ranking filters.
   */
  private async handleGetSmartMoneyMarkets(args: JsonRecord): Promise<JsonRecord> {
    const params = new URLSearchParams();

    if (args.category) params.set('category', String(args.category));
    if (args.window) params.set('window', String(args.window));
    if (args.minVolume !== undefined) params.set('minVolume', String(args.minVolume));
    if (args.limit !== undefined) params.set('limit', String(args.limit));

    const payload = await fetchJson(`/api/markets/smart-money?${params.toString()}`);
    const markets = payload.data?.markets ?? [];

    if (!Array.isArray(markets) || markets.length === 0) {
      return buildTextResult(['No smart-money markets found for the requested filters.']);
    }

    const lines = [`Smart-money markets (${markets.length}):`, ''];

    markets.forEach((market: JsonRecord, index: number) => {
      const flow = market.flow ?? {};
      lines.push(`${index + 1}. ${market.marketTitle || flow.marketTitle || 'Untitled market'}`);
      lines.push(`Score: ${formatNumber(market.score)} | Category: ${market.category || 'n/a'}`);
      lines.push(`Net direction: ${flow.netDirection || 'unknown'} | Net volume: ${formatVolume(flow.netVolume)}`);
      lines.push(`Wallets: ${formatNumber(flow.walletCount)} | Smart wallets: ${formatNumber(flow.smartWalletCount)}`);
      if (market.url) lines.push(`URL: ${market.url}`);
      lines.push('');
    });

    const metadataLine = formatWalletMetadata(payload.metadata);
    if (metadataLine) lines.push(metadataLine);

    return buildTextResult(lines);
  }

  /**
   * Build a compact market brief from existing API primitives.
   *
   * @param args Tool input with market identity and context filters.
   */
  private async handleGetMarketBrief(args: JsonRecord): Promise<JsonRecord> {
    const context = await this.loadMarketContext(args);
    const lines = [`Market brief: ${context.title}`, ''];
    const market = context.market ?? {};
    const flow = context.flow ?? {};

    lines.push('Market:');
    if (context.market) {
      lines.push(`YES: ${formatPercent(market.yesPrice)} | NO: ${formatPercent(market.noPrice)}`);
      lines.push(`24h volume: ${formatVolume(market.volume24h)} | Category: ${market.category || context.identity.category || 'n/a'}`);
      if (market.oneDayPriceChange !== undefined) {
        lines.push(`24h YES price change: ${formatPercent(market.oneDayPriceChange)}`);
      }
      if (market.url) lines.push(`URL: ${market.url}`);
    } else {
      lines.push('Current market price unavailable.');
    }

    lines.push('');
    lines.push('Wallet flow:');
    if (context.flow) {
      lines.push(`Window: ${flow.window || getStringArg(args.window) || '24h'}`);
      lines.push(`Net direction: ${flow.netDirection || 'unknown'} | Net volume: ${formatVolume(flow.netVolume)}`);
      lines.push(`Buy volume: ${formatVolume(flow.buyVolume)} | Sell volume: ${formatVolume(flow.sellVolume)}`);
      lines.push(`Wallets: ${formatNumber(flow.walletCount)} | Smart wallets: ${formatNumber(flow.smartWalletCount)}`);
      if (context.flowAgreesWithPriceMove !== null) {
        lines.push(`Flow agrees with price move: ${context.flowAgreesWithPriceMove ? 'yes' : 'no'}`);
      }
    } else {
      lines.push('Wallet flow unavailable.');
    }

    lines.push('');
    lines.push('Move context:');
    if (context.mover) {
      lines.push(`Recent move: ${context.mover.direction || 'n/a'} ${formatPercent(context.mover.priceChange1h)}`);
      lines.push(`Previous: ${formatPercent(context.mover.previousPrice)} | Current: ${formatPercent(context.mover.currentPrice)}`);
    } else {
      lines.push('No matching mover found in the current mover scan.');
    }

    lines.push('');
    lines.push('Feed mentions:');
    if (context.feedItems.length > 0) {
      context.feedItems.forEach((item, index) => {
        const tweet = item.tweet ?? {};
        lines.push(`${index + 1}. @${tweet.author || 'unknown'} (${item.urgency || 'n/a'} urgency)`);
        lines.push(String(tweet.text || '').slice(0, 220));
      });
    } else {
      lines.push('No related feed mentions found in the current feed window.');
    }

    lines.push('');
    lines.push('Arbitrage context:');
    if (context.arbitrage) {
      lines.push(`Spread: ${formatPercent(context.arbitrage.spread)} | Direction: ${context.arbitrage.direction || 'n/a'}`);
      lines.push(`Match confidence: ${formatPercent(context.arbitrage.confidence)}`);
      if (context.arbitrage.matchReason) lines.push(`Match reason: ${context.arbitrage.matchReason}`);
    } else {
      lines.push('No matching arbitrage opportunity found.');
    }

    if (context.unavailable.length > 0) {
      lines.push('');
      lines.push(`Note: Some data sources were unavailable (${context.unavailable.map(u => u.split(':')[0]).join(', ')}). Results may be partial.`);
    }

    return buildTextResult(lines);
  }

  /**
   * Explain a market move using existing primitives.
   *
   * @param args Tool input with market identity and context filters.
   */
  private async handleExplainMarketMove(args: JsonRecord): Promise<JsonRecord> {
    const context = await this.loadMarketContext(args);
    const lines = [`Market move explanation: ${context.title}`, ''];
    const signals: string[] = [];

    if (context.mover) {
      lines.push(`Move: ${context.mover.direction || 'n/a'} ${formatPercent(context.mover.priceChange1h)}`);
      lines.push(`From ${formatPercent(context.mover.previousPrice)} to ${formatPercent(context.mover.currentPrice)}`);
    } else {
      lines.push('Move: no matching mover found in the current mover scan.');
    }

    if (context.flow) {
      signals.push(
        `Wallet flow leans ${context.flow.netDirection || 'unknown'} with net volume ${formatVolume(context.flow.netVolume)} across ${formatNumber(context.flow.walletCount)} wallets.`
      );
      if (context.flow.smartWalletCount > 0) {
        signals.push(`${formatNumber(context.flow.smartWalletCount)} smart wallet(s) crossed the activity threshold in this window.`);
      }
      if (context.flowAgreesWithPriceMove === true) {
        signals.push('Wallet flow agrees with the observed price direction.');
      } else if (context.flowAgreesWithPriceMove === false) {
        signals.push('Wallet flow conflicts with the observed price direction, so the move may be fading or liquidity-driven.');
      }
    }

    if (context.feedItems.length > 0) {
      const topTweet = context.feedItems[0].tweet ?? {};
      signals.push(`${context.feedItems.length} related feed mention(s) found; top mention from @${topTweet.author || 'unknown'}: ${String(topTweet.text || '').slice(0, 160)}`);
    }

    if (context.arbitrage) {
      signals.push(`Related arbitrage context shows ${formatPercent(context.arbitrage.spread)} spread with ${formatPercent(context.arbitrage.confidence)} match confidence.`);
    }

    lines.push('');
    lines.push('Signals:');
    if (signals.length > 0) {
      signals.forEach((signal, index) => lines.push(`${index + 1}. ${signal}`));
    } else {
      lines.push('No strong explanatory signals were available from the current primitives.');
    }

    lines.push('');
    lines.push('Bottom line:');
    if (context.mover && context.flowAgreesWithPriceMove === true) {
      lines.push('The strongest read is directional confirmation: price moved with wallet flow.');
    } else if (context.mover && context.flowAgreesWithPriceMove === false) {
      lines.push('The move is not cleanly confirmed by wallet flow; treat it as mixed signal.');
    } else if (context.flow) {
      lines.push('Wallet flow is the clearest available signal, but mover confirmation is missing.');
    } else {
      lines.push('Context is incomplete; rerun after the wallet-flow and mover primitives have fresh data.');
    }

    if (context.unavailable.length > 0) {
      lines.push('');
      lines.push(`Note: Some data sources were unavailable (${context.unavailable.map(u => u.split(':')[0]).join(', ')}). Results may be partial.`);
    }

    return buildTextResult(lines);
  }

  /**
   * Load market context without failing the whole tool on partial outages.
   *
   * @param args Tool input with market identity.
   */
  private async loadMarketContext(args: JsonRecord): Promise<MarketContext> {
    const baseIdentity = getMarketIdentity(args);
    if (!hasMarketIdentity(baseIdentity)) {
      throw new Error('Provide marketId, conditionId, or query.');
    }

    const flowParams = buildMarketIdentityParams(baseIdentity);
    flowParams.set('window', getStringArg(args.window) || '24h');
    flowParams.set('limit', String(args.flowLimit ?? args.limit ?? 50));

    const flowResult = await this.fetchOptionalJson(
      'wallet flow',
      `/api/markets/wallet-flow?${flowParams.toString()}`,
    );
    const flow = getFlowFromPayload(flowResult.payload);
    let market = getMarketFromFlowPayload(flowResult.payload);
    let identity = enrichMarketIdentity(baseIdentity, flow, market);
    let title = identity.title || identity.query || identity.marketId || identity.conditionId || 'market';

    const analysisText = identity.query || title;
    const analysisResult = analysisText
      ? await this.fetchOptionalJson('market match', '/api/analyze-text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: analysisText, maxResults: 5 }),
        })
      : { label: 'market match' } as OptionalJsonResult;

    market = market || firstMarketFromAnalyze(analysisResult.payload);
    identity = enrichMarketIdentity(identity, flow, market);
    title = identity.title || title;

    const contextLimit = String(args.contextLimit ?? 20);
    const category = identity.category;
    const moverParams = new URLSearchParams({
      minChange: String(args.minChange ?? 0.01),
      limit: contextLimit,
    });
    const feedParams = new URLSearchParams({ limit: contextLimit });
    const arbitrageParams = new URLSearchParams({
      minSpread: String(args.minSpread ?? 0.01),
      minConfidence: String(args.minConfidence ?? 0.3),
      limit: contextLimit,
    });

    if (category) {
      moverParams.set('category', category);
      feedParams.set('category', category);
      arbitrageParams.set('category', category);
    }

    const [moversResult, feedResult, arbitrageResult] = await Promise.all([
      this.fetchOptionalJson('movers', `/api/markets/movers?${moverParams.toString()}`),
      this.fetchOptionalJson('feed', `/api/feed?${feedParams.toString()}`),
      this.fetchOptionalJson('arbitrage', `/api/markets/arbitrage?${arbitrageParams.toString()}`),
    ]);

    const unavailable = [flowResult, analysisResult, moversResult, feedResult, arbitrageResult]
      .filter(result => result.error)
      .map(result => `${result.label}: ${result.error}`);

    return {
      identity,
      title,
      market,
      flow,
      flowAgreesWithPriceMove: getFlowAgreement(flowResult.payload),
      mover: findRelatedMover(moversResult.payload, identity, title),
      feedItems: findRelatedFeedItems(feedResult.payload, identity, title, 3),
      arbitrage: findRelatedArbitrage(arbitrageResult.payload, identity, title),
      unavailable,
    };
  }

  private async fetchOptionalJson(
    label: string,
    path: string,
    init?: RequestInit,
  ): Promise<OptionalJsonResult> {
    try {
      return { label, payload: await fetchJson(path, init) };
    } catch (error) {
      return { label, error: getErrorMessage(error) };
    }
  }

  private async handleGetHealth(): Promise<JsonRecord> {
    const payload = await fetchJson('/api/health');
    const health = payload.data ?? {};

    return buildTextResult([
      'API health:',
      '',
      `Status: ${health.status || 'n/a'}`,
      `Response time: ${health.response_time_ms ?? 'n/a'}ms`,
      `Uptime: ${health.uptime_ms ?? 'n/a'}ms`,
      `Polymarket: ${health.services?.polymarket?.status || 'n/a'}`,
      `Kalshi: ${health.services?.kalshi?.status || 'n/a'}`,
    ]);
  }

  private registerProcessHandlers(): void {
    this.server.onerror = (error) => {
      console.error('[MCP] Server error:', error);
    };

    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup(): Promise<void> {
    if (this.streamableHttpServer) {
      await this.streamableHttpServer.stop();
    }
  }

  async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  async startHttp(port: number, oauthStore: OAuthStore): Promise<void> {
    this.streamableHttpServer = new StreamableHttpServer({
      port,
      oauthStore,
      onRequest: async (_sessionId: string | null, request: JsonRecord) => {
        return await this.handleJsonRpcRequest(request);
      },
      onNotification: async (_sessionId: string | null, notification: JsonRecord) => {
        await this.handleJsonRpcNotification(notification);
      },
      onResponse: async (_sessionId: string | null, response: JsonRecord) => {
        console.log('[MCP] Client response:', response);
      },
    });

    await this.streamableHttpServer.start(port);
  }

  private async handleJsonRpcRequest(request: JsonRecord): Promise<JsonRecord> {
    const { method, params, id } = request;

    console.log(`[MCP] JSON-RPC request: ${String(method)}`);

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
            prompts: {},
            resources: {},
          },
          serverInfo: {
            name: 'musashi',
            version: '1.0.0',
          },
        },
      };
    }

    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: this.listTools() };
    }

    if (method === 'prompts/list') {
      return { jsonrpc: '2.0', id, result: this.listPrompts() };
    }

    if (method === 'prompts/get') {
      const promptName = typeof params?.name === 'string' ? params.name : '';
      const promptArgs =
        params?.arguments && typeof params.arguments === 'object' ? params.arguments as JsonRecord : {};
      return { jsonrpc: '2.0', id, result: this.getPrompt(promptName, promptArgs) };
    }

    if (method === 'resources/list') {
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    }

    if (method === 'tools/call') {
      const toolName = typeof params?.name === 'string' ? params.name : '';
      const toolArgs =
        params?.arguments && typeof params.arguments === 'object' ? params.arguments as JsonRecord : {};
      const result = await this.callTool(toolName, toolArgs);
      return { jsonrpc: '2.0', id, result };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${String(method)}`,
      },
    };
  }

  private async handleJsonRpcNotification(notification: JsonRecord): Promise<void> {
    if (notification.method === 'notifications/initialized') {
      console.log('[MCP] Client initialized');
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const transportType = args.includes('--transport=http') ? 'http' : 'stdio';

  if (transportType === 'http') {
    const isProduction =
      process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_SERVICE_NAME);

    if (isProduction) {
      const missing: string[] = [];
      if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
        missing.push('UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN');
      }
      if (!process.env.MCP_OAUTH_TOKEN_SECRET) {
        missing.push('MCP_OAUTH_TOKEN_SECRET');
      }
      if (missing.length > 0) {
        console.error(`[OAuth] FATAL: Production requires: ${missing.join(', ')}`);
        process.exit(1);
      }
    }

    const store =
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
        ? new KvOAuthStore(
            process.env.UPSTASH_REDIS_REST_URL,
            process.env.UPSTASH_REDIS_REST_TOKEN,
          )
        : (() => {
            console.warn('[OAuth] No KV config — using in-memory store (dev only)');
            return new MemoryOAuthStore();
          })();

    const port = Number.parseInt(process.env.PORT || '3000', 10);
    const server = new MusashiMcpServer();
    await server.startHttp(port, store);
    return;
  }

  const server = new MusashiMcpServer();
  await server.startStdio();
}

main().catch((error) => {
  console.error('[MCP] Fatal error:', error);
  process.exit(1);
});
