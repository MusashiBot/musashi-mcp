/**
 * Rate limiting for MCP HTTP transport
 * Prevents abuse and ensures fair usage across API keys
 */

import rateLimit from 'express-rate-limit';
import { Request } from 'express';
import { extractApiKey } from '../transports/auth.js';

/**
 * Rate limit configuration from environment variables
 */
export const RATE_LIMIT_PER_MINUTE = parseInt(process.env.MCP_RATE_LIMIT_PER_MINUTE || '60', 10);
export const RATE_LIMIT_PER_HOUR = parseInt(process.env.MCP_RATE_LIMIT_PER_HOUR || '1000', 10);

/**
 * Session creation rate limiter
 * Prevents session spam attacks
 * Default: 10 sessions per hour per API key
 */
export const sessionRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    // Rate limit per API key
    const apiKey = extractApiKey(req.headers.authorization);
    return apiKey || req.ip || 'anonymous';
  },
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Rate limit exceeded. Max 10 sessions per hour.',
      retry_after_seconds: 3600,
    });
  },
  skip: (req) => {
    // Skip rate limiting for health check
    return req.path === '/health';
  },
});

/**
 * Message sending rate limiter
 * Allows responsive conversations while preventing spam
 * Default: 60 messages per minute per API key
 */
export const messageRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: RATE_LIMIT_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const apiKey = extractApiKey(req.headers.authorization);
    return apiKey || req.ip || 'anonymous';
  },
  handler: (_req, res) => {
    res.status(429).json({
      error: `Rate limit exceeded. Max ${RATE_LIMIT_PER_MINUTE} requests per minute.`,
      retry_after_seconds: 60,
    });
  },
});

/**
 * Hourly rate limiter for general API usage
 * Backstop for high-volume abusers
 * Default: 1000 requests per hour per API key
 */
export const hourlyRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: RATE_LIMIT_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const apiKey = extractApiKey(req.headers.authorization);
    return apiKey || req.ip || 'anonymous';
  },
  handler: (_req, res) => {
    res.status(429).json({
      error: `Rate limit exceeded. Max ${RATE_LIMIT_PER_HOUR} requests per hour.`,
      retry_after_seconds: 3600,
    });
  },
  skip: (req) => {
    // Skip for health check and capabilities endpoints
    return req.path === '/health' || req.path === '/mcp/capabilities';
  },
});

/**
 * In-memory tracking for concurrent SSE streams per API key
 */
class SSELimiter {
  private connections: Map<string, Set<string>> = new Map();
  private readonly MAX_CONCURRENT_STREAMS = 5;

  /**
   * Check if API key can open new SSE stream
   * @param apiKey - API key
   * @param _sessionId - Session ID
   * @returns true if allowed, false if limit exceeded
   */
  canConnect(apiKey: string, _sessionId: string): boolean {
    const sessions = this.connections.get(apiKey) || new Set();
    return sessions.size < this.MAX_CONCURRENT_STREAMS;
  }

  /**
   * Register new SSE connection
   * @param apiKey - API key
   * @param sessionId - Session ID
   * @returns true if registered, false if limit exceeded
   */
  registerConnection(apiKey: string, sessionId: string): boolean {
    if (!this.canConnect(apiKey, sessionId)) {
      return false;
    }

    const sessions = this.connections.get(apiKey) || new Set();
    sessions.add(sessionId);
    this.connections.set(apiKey, sessions);

    console.log(`[SSELimiter] Registered connection for ${apiKey.slice(0, 12)}... (${sessions.size}/${this.MAX_CONCURRENT_STREAMS})`);
    return true;
  }

  /**
   * Unregister SSE connection
   * @param apiKey - API key
   * @param sessionId - Session ID
   */
  unregisterConnection(apiKey: string, sessionId: string): void {
    const sessions = this.connections.get(apiKey);
    if (sessions) {
      sessions.delete(sessionId);

      if (sessions.size === 0) {
        this.connections.delete(apiKey);
      }

      console.log(`[SSELimiter] Unregistered connection for ${apiKey.slice(0, 12)}... (${sessions.size}/${this.MAX_CONCURRENT_STREAMS})`);
    }
  }

  /**
   * Get number of active connections for API key
   */
  getConnectionCount(apiKey: string): number {
    return this.connections.get(apiKey)?.size || 0;
  }

  /**
   * Get total number of connections across all API keys
   */
  getTotalConnections(): number {
    let total = 0;
    for (const sessions of this.connections.values()) {
      total += sessions.size;
    }
    return total;
  }
}

export const sseLimiter = new SSELimiter();

export const oauthRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.ip || 'anonymous',
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many OAuth requests. Try again later.',
      retry_after_seconds: 60,
    });
  },
});
