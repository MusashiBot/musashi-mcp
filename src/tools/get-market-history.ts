import type { MusashiApiClient } from '../clients/musashi-api.js';
import type {
  MarketHistoryData,
  MarketIdentityBlock,
  MarketStatus,
  SnapshotPoint,
} from '../schemas/market.js';
import {
  clampLimit,
  errEnvelope,
  getNumberArg,
  getStringArg,
  invalidInput,
  isRecord,
  okEnvelope,
  requireExactlyOne,
  runTool,
  type McpToolResult,
} from './shared.js';

type JsonRecord = Record<string, unknown>;

const WINDOWS = ['24h', '7d', '30d', 'all'] as const;
type Window = (typeof WINDOWS)[number];

export const getMarketHistoryDefinition = {
  name: 'get_market_history',
  description:
    'Show how a Musashi market has moved over time. Returns ordered snapshot points. Read-only, Musashi V1.',
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
      window: {
        type: 'string',
        enum: ['24h', '7d', '30d', 'all'],
        description: 'Time window for snapshots. Default `7d`.',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 1000,
        description: 'Max snapshots to return. Default 200, max 1000.',
      },
    },
  },
};

export async function handleGetMarketHistory(
  args: JsonRecord,
  api: MusashiApiClient,
): Promise<McpToolResult> {
  const marketId = getStringArg(args.market_id);
  const platformId = getStringArg(args.platform_id);

  const identityError = requireExactlyOne({ market_id: marketId, platform_id: platformId });
  if (identityError) {
    return invalidInput(identityError);
  }

  const windowRaw = getStringArg(args.window) ?? '7d';
  if (!WINDOWS.includes(windowRaw as Window)) {
    return invalidInput('`window` must be one of 24h | 7d | 30d | all.');
  }
  const window = windowRaw as Window;
  const limit = clampLimit(getNumberArg(args.limit), { fallback: 200, min: 1, max: 1000 });

  return runTool<MarketHistoryData>(async () => {
    const params = new URLSearchParams({ window, limit: String(limit) });
    if (marketId) params.set('market_id', marketId);
    if (platformId) params.set('platform_id', platformId);

    const payload = await api.getJson(`/api/markets/history?${params.toString()}`);
    const parsed = extractHistory(payload, window);

    if (!parsed) {
      return errEnvelope({
        type: 'upstream_unavailable',
        message: 'Musashi API returned an unexpected shape for get_market_history.',
      });
    }

    return okEnvelope({ ...parsed, snapshots: parsed.snapshots.slice(0, limit) });
  });
}

function extractHistory(payload: unknown, window: Window): MarketHistoryData | null {
  if (!isRecord(payload)) return null;
  const source = isRecord(payload.data) ? payload.data : payload;
  const marketRaw = isRecord((source as JsonRecord).market)
    ? ((source as JsonRecord).market as JsonRecord)
    : null;
  if (!marketRaw) return null;

  const market = normalizeIdentity(marketRaw);
  if (!market) return null;

  const rawSnapshots = Array.isArray((source as JsonRecord).snapshots)
    ? ((source as JsonRecord).snapshots as unknown[])
    : [];

  const snapshots = rawSnapshots
    .map(normalizeSnapshot)
    .filter((s): s is SnapshotPoint => s !== null)
    .sort((a, b) => a.snapshot_time.localeCompare(b.snapshot_time));

  return { market, window, snapshots };
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

function normalizeSnapshot(value: unknown): SnapshotPoint | null {
  if (!isRecord(value)) return null;
  const snapshotTime =
    typeof value.snapshot_time === 'string'
      ? value.snapshot_time
      : typeof value.snapshotTime === 'string'
        ? value.snapshotTime
        : null;
  if (!snapshotTime) return null;

  return {
    snapshot_time: snapshotTime,
    yes_price: asNullableNumber(value.yes_price ?? value.yesPrice),
    no_price: asNullableNumber(value.no_price ?? value.noPrice),
    volume_24h: asNullableNumber(value.volume_24h ?? value.volume24h),
    open_interest: asNullableNumber(value.open_interest ?? value.openInterest),
    liquidity: asNullableNumber(value.liquidity),
    spread: asNullableNumber(value.spread),
  };
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
