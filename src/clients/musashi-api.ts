import type { McpError } from '../schemas/market.js';

export interface MusashiApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class MusashiApiError extends Error {
  readonly kind: McpError['type'];
  readonly status?: number;

  constructor(kind: McpError['type'], message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

type JsonRecord = Record<string, unknown>;

export class MusashiApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: MusashiApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  async getJson<T = JsonRecord>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: controller.signal });
    } catch (error) {
      throw new MusashiApiError(
        'upstream_unavailable',
        `Musashi API unreachable: ${getErrorMessage(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const rawText = await response.text();
    let body: JsonRecord = {};
    if (rawText) {
      try {
        body = JSON.parse(rawText) as JsonRecord;
      } catch {
        throw new MusashiApiError(
          'upstream_unavailable',
          `Musashi API returned non-JSON response (${response.status}).`,
          response.status,
        );
      }
    }

    if (response.status === 404) {
      const message = pickMessage(body, 'Resource not found.');
      throw new MusashiApiError('not_found', message, 404);
    }

    if (response.status === 400) {
      const message = pickMessage(body, 'Invalid input.');
      throw new MusashiApiError('invalid_input', message, 400);
    }

    if (response.status >= 500 || response.status === 502 || response.status === 503) {
      const message = pickMessage(body, `Upstream unavailable (HTTP ${response.status}).`);
      throw new MusashiApiError('upstream_unavailable', message, response.status);
    }

    if (!response.ok) {
      const message = pickMessage(body, `Request failed with HTTP ${response.status}.`);
      throw new MusashiApiError('internal_error', message, response.status);
    }

    return body as T;
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function pickMessage(body: JsonRecord, fallback: string): string {
  const candidate =
    typeof body.error === 'string'
      ? body.error
      : isRecord(body.error) && typeof body.error.message === 'string'
        ? body.error.message
        : typeof body.message === 'string'
          ? body.message
          : null;
  return candidate ?? fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
