import type { MusashiApiClient } from '../clients/musashi-api.js';
import type {
  MarketIdentityBlock,
  MarketStatus,
  ResolutionContextData,
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

export const getMarketResolutionContextDefinition = {
  name: 'get_market_resolution_context',
  description:
    'Return simple honest historical/trust context for a Musashi market. Returns null where context cannot be computed honestly. Read-only, Musashi V1.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      market_id: {
        type: 'string',
        description: 'Musashi market id. Provide this OR platform_id.',
      },
      platform_id: {
        type: 'string',
        description: 'Raw platform id. Provide this OR market_id.',
      },
    },
  },
};

export async function handleGetMarketResolutionContext(
  args: JsonRecord,
  api: MusashiApiClient,
): Promise<McpToolResult> {
  const marketId = getStringArg(args.market_id);
  const platformId = getStringArg(args.platform_id);

  const identityError = requireExactlyOne({ market_id: marketId, platform_id: platformId });
  if (identityError) {
    return invalidInput(identityError);
  }

  return runTool<ResolutionContextData>(async () => {
    const params = new URLSearchParams();
    if (marketId) params.set('market_id', marketId);
    if (platformId) params.set('platform_id', platformId);

    const payload = await api.getJson(`/api/markets/resolution-context?${params.toString()}`);
    const parsed = extractResolutionContext(payload);

    if (!parsed) {
      return errEnvelope({
        type: 'upstream_unavailable',
        message: 'Musashi API returned an unexpected shape for get_market_resolution_context.',
      });
    }

    return okEnvelope(parsed);
  });
}

function extractResolutionContext(payload: unknown): ResolutionContextData | null {
  if (!isRecord(payload)) return null;
  const source = isRecord(payload.data) ? payload.data : payload;

  const marketRaw = isRecord((source as JsonRecord).market)
    ? ((source as JsonRecord).market as JsonRecord)
    : null;
  if (!marketRaw) return null;

  const market = normalizeIdentity(marketRaw);
  if (!market) return null;

  const resolutionRaw = (source as JsonRecord).market_resolution;
  const marketResolution: ResolutionOutcome | null =
    resolutionRaw === 'YES' || resolutionRaw === 'NO' ? resolutionRaw : null;

  return {
    market,
    market_resolved: Boolean((source as JsonRecord).market_resolved),
    market_resolution: marketResolution,
    market_resolved_at: asNullableString((source as JsonRecord).market_resolved_at),
    category_resolution_count: asNullableNumber((source as JsonRecord).category_resolution_count),
    similar_market_resolution_count: asNullableNumber(
      (source as JsonRecord).similar_market_resolution_count,
    ),
    notes: asNullableString((source as JsonRecord).notes),
  };
}

function normalizeIdentity(value: JsonRecord): MarketIdentityBlock | null {
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
  };
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
