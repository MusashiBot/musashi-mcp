import type { MusashiApiClient } from '../clients/musashi-api.js';
import type {
  MarketDetail,
  MarketStatus,
  ResolutionOutcome,
} from '../schemas/market.js';
import {
  errEnvelope,
  getStringArg,
  invalidInput,
  isRecord,
  okEnvelope,
  requireExactlyOne,
  runTool,
  type McpToolResult,
} from './shared.js';

type JsonRecord = Record<string, unknown>;

export const getMarketDefinition = {
  name: 'get_market',
  description:
    'Fetch one Musashi market by id or platform_id. Returns the current canonical market state. Read-only, Musashi V1.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      market_id: {
        type: 'string',
        description: 'Musashi market id (prefixed `musashi-`). Provide this OR platform_id.',
      },
      platform_id: {
        type: 'string',
        description: 'Raw platform id (e.g. Kalshi ticker). Provide this OR market_id.',
      },
    },
  },
};

export async function handleGetMarket(
  args: JsonRecord,
  api: MusashiApiClient,
): Promise<McpToolResult> {
  const marketId = getStringArg(args.market_id);
  const platformId = getStringArg(args.platform_id);

  const identityError = requireExactlyOne({ market_id: marketId, platform_id: platformId });
  if (identityError) {
    return invalidInput(identityError);
  }

  return runTool<MarketDetail>(async () => {
    const params = new URLSearchParams();
    if (marketId) params.set('market_id', marketId);
    if (platformId) params.set('platform_id', platformId);

    const payload = await api.getJson(`/api/markets/lookup?${params.toString()}`);
    const market = extractMarketDetail(payload);

    if (!market) {
      return errEnvelope({
        type: 'upstream_unavailable',
        message: 'Musashi API returned an unexpected shape for get_market.',
      });
    }

    return okEnvelope(market);
  });
}

function extractMarketDetail(payload: unknown): MarketDetail | null {
  if (!isRecord(payload)) return null;
  const source = isRecord(payload.data) ? payload.data : payload;
  const raw = isRecord((source as JsonRecord).market)
    ? ((source as JsonRecord).market as JsonRecord)
    : (source as JsonRecord);
  return normalizeMarketDetail(raw);
}

export function normalizeMarketDetail(value: JsonRecord): MarketDetail | null {
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

  const resolutionRaw = value.resolution;
  const resolution: ResolutionOutcome | null =
    resolutionRaw === 'YES' || resolutionRaw === 'NO' ? resolutionRaw : null;

  return {
    id,
    platform,
    platform_id: platformId,
    title,
    description: asNullableString(value.description),
    category: asNullableString(value.category),
    status: statusRaw as MarketStatus,
    yes_price: asNullableNumber(value.yes_price ?? value.yesPrice),
    no_price: asNullableNumber(value.no_price ?? value.noPrice),
    volume_24h: asNullableNumber(value.volume_24h ?? value.volume24h),
    open_interest: asNullableNumber(value.open_interest ?? value.openInterest),
    liquidity: asNullableNumber(value.liquidity),
    spread: asNullableNumber(value.spread),
    closes_at: asNullableString(value.closes_at ?? value.closesAt),
    settles_at: asNullableString(value.settles_at ?? value.settlesAt),
    resolved: Boolean(value.resolved),
    resolution,
    resolved_at: asNullableString(value.resolved_at ?? value.resolvedAt),
    source_missing_at: asNullableString(value.source_missing_at ?? value.sourceMissingAt),
  };
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
