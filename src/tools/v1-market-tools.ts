import { MusashiApiClient } from '../clients/musashi-api.js';
import {
  getMarketDefinition,
  handleGetMarket,
} from './get-market.js';
import {
  getMarketHistoryDefinition,
  handleGetMarketHistory,
} from './get-market-history.js';
import {
  getMarketResolutionContextDefinition,
  handleGetMarketResolutionContext,
} from './get-market-resolution-context.js';
import {
  searchMarketsDefinition,
  handleSearchMarkets,
} from './search-markets.js';
import type { McpToolResult } from './shared.js';

type JsonRecord = Record<string, unknown>;

export interface V1ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const V1_TOOL_DEFINITIONS: V1ToolDefinition[] = [
  searchMarketsDefinition,
  getMarketDefinition,
  getMarketHistoryDefinition,
  getMarketResolutionContextDefinition,
];

export const V1_TOOL_NAMES = new Set(V1_TOOL_DEFINITIONS.map((def) => def.name));

export function createV1Registry(api: MusashiApiClient) {
  return {
    definitions: V1_TOOL_DEFINITIONS,
    has(name: string): boolean {
      return V1_TOOL_NAMES.has(name);
    },
    async call(name: string, args: JsonRecord): Promise<McpToolResult> {
      switch (name) {
        case searchMarketsDefinition.name:
          return handleSearchMarkets(args, api);
        case getMarketDefinition.name:
          return handleGetMarket(args, api);
        case getMarketHistoryDefinition.name:
          return handleGetMarketHistory(args, api);
        case getMarketResolutionContextDefinition.name:
          return handleGetMarketResolutionContext(args, api);
        default:
          throw new Error(`Unknown V1 tool: ${name}`);
      }
    },
  };
}

export type V1ToolRegistry = ReturnType<typeof createV1Registry>;
