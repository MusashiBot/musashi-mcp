import type { MusashiApiClient } from '../clients/musashi-api.js';
import type {
  MarketStatus,
  SearchMarketResult,
  SearchMarketsData,
} from '../schemas/market.js';
import {
  clampLimit,
  errEnvelope,
  getNumberArg,
  getStringArg,
  invalidInput,
  isRecord,
  okEnvelope,
  runTool,
  type McpToolResult,
} from './shared.js';

type JsonRecord = Record<string, unknown>;

export const searchMarketsDefinition = {
  name: 'search_markets',
  description:
    'Find relevant Musashi market candidates from a free-text query. Returns a concise list of markets with pricing and status. Read-only, Musashi V1.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search text describing the market you want to find.',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 25,
        description: 'Max markets to return. Default 10, max 25.',
      },
      category: {
        type: 'string',
        description: 'Optional Musashi category filter.',
      },
      status: {
        type: 'string',
        enum: ['open', 'closed', 'resolved'],
        description: 'Optional market status filter.',
      },
    },
    required: ['query'],
  },
};

export async function handleSearchMarkets(
  args: JsonRecord,
  api: MusashiApiClient,
): Promise<McpToolResult> {
  const query = getStringArg(args.query);
  if (!query) {
    return invalidInput('`query` is required and must be a non-empty string.');
  }

  const limit = clampLimit(getNumberArg(args.limit), { fallback: 10, min: 1, max: 25 });
  const category = getStringArg(args.category);
  const statusArg = getStringArg(args.status);
  const status = statusArg && ['open', 'closed', 'resolved'].includes(statusArg)
    ? (statusArg as MarketStatus)
    : undefined;
  if (statusArg && !status) {
    return invalidInput('`status` must be one of open | closed | resolved.');
  }

  return runTool<SearchMarketsData>(async () => {
    const params = new URLSearchParams({ query, limit: String(limit) });
    if (category) params.set('category', category);
    if (status) params.set('status', status);

    const payload = await api.getJson(`/api/markets/search?${params.toString()}`);
    const markets = extractMarketList(payload);

    if (!markets) {
      return errEnvelope({
        type: 'upstream_unavailable',
        message: 'Musashi API returned an unexpected shape for search_markets.',
      });
    }

    return okEnvelope({ markets: markets.slice(0, limit) });
  });
}

function extractMarketList(payload: unknown): SearchMarketResult[] | null {
  if (!isRecord(payload)) return null;
  const data = isRecord(payload.data) ? payload.data : payload;
  const raw = Array.isArray((data as JsonRecord).markets)
    ? ((data as JsonRecord).markets as unknown[])
    : null;
  if (!raw) return null;

  return raw.map(normalizeSearchResult).filter((item): item is SearchMarketResult => item !== null);
}

function normalizeSearchResult(value: unknown): SearchMarketResult | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : null;
  const platform = typeof value.platform === 'string' ? value.platform : null;
  const platformId =
    typeof value.platform_id === 'string'
      ? value.platform_id
      : typeof value.platformId === 'string'
        ? value.platformId
        : null;
  const title = typeof value.title === 'string' ? value.title : null;
  const statusRaw = typeof value.status === 'string' ? value.status : null;

  if (!id || !platform || !platformId || !title || !statusRaw) return null;
  if (!['open', 'closed', 'resolved'].includes(statusRaw)) return null;

  return {
    id,
    platform,
    platform_id: platformId,
    title,
    category: typeof value.category === 'string' ? value.category : null,
    status: statusRaw as MarketStatus,
    yes_price: asNullableNumber(value.yes_price ?? value.yesPrice),
    no_price: asNullableNumber(value.no_price ?? value.noPrice),
    closes_at: asNullableString(value.closes_at ?? value.closesAt),
    resolved: Boolean(value.resolved),
  };
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
