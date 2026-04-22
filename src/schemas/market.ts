export type McpErrorType =
  | 'not_found'
  | 'invalid_input'
  | 'upstream_unavailable'
  | 'internal_error';

export interface McpError {
  type: McpErrorType;
  message: string;
}

export type McpEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: McpError };

export type MarketStatus = 'open' | 'closed' | 'resolved';
export type ResolutionOutcome = 'YES' | 'NO';

export interface SearchMarketResult {
  id: string;
  platform: string;
  platform_id: string;
  title: string;
  category: string | null;
  status: MarketStatus;
  yes_price: number | null;
  no_price: number | null;
  closes_at: string | null;
  resolved: boolean;
}

export interface SearchMarketsData {
  markets: SearchMarketResult[];
}

export interface MarketDetail {
  id: string;
  platform: string;
  platform_id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: MarketStatus;
  yes_price: number | null;
  no_price: number | null;
  volume_24h: number | null;
  open_interest: number | null;
  liquidity: number | null;
  spread: number | null;
  closes_at: string | null;
  settles_at: string | null;
  resolved: boolean;
  resolution: ResolutionOutcome | null;
  resolved_at: string | null;
  source_missing_at: string | null;
}

export interface MarketIdentityBlock {
  id: string;
  platform: string;
  platform_id: string;
  title: string;
  category: string | null;
  status: MarketStatus;
}

export interface SnapshotPoint {
  snapshot_time: string;
  yes_price: number | null;
  no_price: number | null;
  volume_24h: number | null;
  open_interest: number | null;
  liquidity: number | null;
  spread: number | null;
}

export interface MarketHistoryData {
  market: MarketIdentityBlock;
  window: '24h' | '7d' | '30d' | 'all';
  snapshots: SnapshotPoint[];
}

export interface ResolutionContextData {
  market: MarketIdentityBlock;
  market_resolved: boolean;
  market_resolution: ResolutionOutcome | null;
  market_resolved_at: string | null;
  category_resolution_count: number | null;
  similar_market_resolution_count: number | null;
  notes: string | null;
}
