import { MusashiApiError } from '../clients/musashi-api.js';
import type { McpEnvelope, McpError } from '../schemas/market.js';

type JsonRecord = Record<string, unknown>;

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

export function okEnvelope<T>(data: T): McpEnvelope<T> {
  return { ok: true, data };
}

export function errEnvelope(error: McpError): McpEnvelope<never> {
  return { ok: false, error };
}

export function toolResultFromEnvelope<T>(envelope: McpEnvelope<T>): McpToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(envelope, null, 2),
      },
    ],
    ...(envelope.ok ? {} : { isError: true as const }),
  };
}

export async function runTool<T>(
  fn: () => Promise<McpEnvelope<T>>,
): Promise<McpToolResult> {
  try {
    const envelope = await fn();
    return toolResultFromEnvelope(envelope);
  } catch (error) {
    if (error instanceof MusashiApiError) {
      return toolResultFromEnvelope(
        errEnvelope({ type: error.kind, message: error.message }),
      );
    }
    return toolResultFromEnvelope(
      errEnvelope({
        type: 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown internal error.',
      }),
    );
  }
}

export function getStringArg(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

export function getNumberArg(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function clampLimit(
  value: number | undefined,
  defaults: { fallback: number; min: number; max: number },
): number {
  if (value === undefined) {
    return defaults.fallback;
  }
  const normalized = Math.floor(value);
  return Math.max(defaults.min, Math.min(defaults.max, normalized));
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function invalidInput(message: string): McpToolResult {
  return toolResultFromEnvelope(errEnvelope({ type: 'invalid_input', message }));
}

export function requireExactlyOne(
  identity: Record<string, string | undefined>,
): string | null {
  const populated = Object.values(identity).filter(Boolean);
  if (populated.length === 0) {
    return 'Provide one of: ' + Object.keys(identity).join(', ') + '.';
  }
  if (populated.length > 1) {
    return 'Provide only one of: ' + Object.keys(identity).join(', ') + '.';
  }
  return null;
}
