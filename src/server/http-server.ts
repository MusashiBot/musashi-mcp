/**
 * @deprecated This HTTP+SSE server is no longer used in production.
 * The active transport is StreamableHttpServer in streamable-http-server.ts
 * which implements the MCP Streamable HTTP transport (2025-06-18).
 * This file is retained for reference only and will be removed in a future cleanup.
 *
 * HTTP server for MCP protocol
 * Handles session creation, SSE streaming, and message routing
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { SessionManager } from './session-manager.js';
import { sessionRateLimiter, messageRateLimiter, hourlyRateLimiter, sseLimiter } from './rate-limiter.js';
import { verifyApiKey, extractApiKey } from '../transports/auth.js';

export interface HttpServerOptions {
  port: number;
  sessionManager: SessionManager;
  onMessage: (sessionId: string, message: any) => void;
}

export class HttpServer {
  private app: express.Application;
  private server: any;
  private sessionManager: SessionManager;
  private onMessage: (sessionId: string, message: any) => void;

  constructor(options: HttpServerOptions) {
    this.app = express();
    this.sessionManager = options.sessionManager;
    this.onMessage = options.onMessage;

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // CORS configuration
    const ALLOWED_ORIGINS = [
      'https://claude.ai',
      'https://www.claude.ai',
      'https://api.anthropic.com',
      'http://localhost:3000',
      'http://localhost:5173',
    ];

    this.app.use(cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) {
          callback(null, true);
          return;
        }

        if (ALLOWED_ORIGINS.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('CORS not allowed'));
        }
      },
      credentials: true,
    }));

    // JSON body parsing
    this.app.use(express.json());

    // Request logging
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      console.log(`[HTTP] ${req.method} ${req.path} - ${req.ip}`);
      next();
    });

    // Apply rate limiters
    this.app.use(hourlyRateLimiter);
  }

  private setupRoutes(): void {
    // Health check endpoint (public, no auth)
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        transport: 'http-sse',
        uptime_seconds: Math.floor(process.uptime()),
        active_sessions: this.sessionManager.getActiveSessionCount(),
        active_connections: this.sessionManager.getActiveConnectionCount(),
        memory_usage: process.memoryUsage(),
      });
    });

    // MCP capabilities endpoint (public, no auth)
    this.app.get('/mcp/capabilities', (_req: Request, res: Response) => {
      res.json({
        name: 'musashi',
        version: '1.0.0',
        description: 'Real-time prediction market intelligence from Polymarket and Kalshi',
        transport: 'http-sse',
        endpoints: {
          session: 'POST /mcp/session',
          stream: 'GET /mcp/stream/:sessionId',
          message: 'POST /mcp/message',
        },
        rate_limits: {
          sessions_per_hour: 10,
          messages_per_minute: 60,
          concurrent_streams: 5,
        },
      });
    });

    // Authentication middleware for protected routes
    const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
      const apiKey = extractApiKey(req.headers.authorization);

      if (!apiKey) {
        res.status(401).json({ error: 'Missing API key. Use Authorization: Bearer mcp_sk_...' });
        return;
      }

      if (!verifyApiKey(apiKey)) {
        res.status(401).json({ error: 'Invalid API key' });
        return;
      }

      // Store API key in request for later use
      (req as any).apiKey = apiKey;
      next();
    };

    // Session creation endpoint
    this.app.post('/mcp/session', authMiddleware, sessionRateLimiter, (req: Request, res: Response) => {
      try {
        const apiKey = (req as any).apiKey;
        const session = this.sessionManager.createSession(apiKey);

        res.json({
          session_id: session.id,
          created_at: session.createdAt.toISOString(),
          expires_at: session.expiresAt.toISOString(),
        });
      } catch (error: any) {
        console.error('[HTTP] Session creation failed:', error);
        res.status(429).json({ error: error.message });
      }
    });

    // SSE stream endpoint
    this.app.get('/mcp/stream/:sessionId', authMiddleware, (req: Request, res: Response) => {
      const { sessionId } = req.params;
      const apiKey = (req as any).apiKey;

      // Verify session exists and belongs to API key
      const session = this.sessionManager.getSession(sessionId);

      if (!session) {
        res.status(404).json({ error: 'Session not found or expired' });
        return;
      }

      if (!this.sessionManager.verifySessionOwnership(sessionId, apiKey)) {
        res.status(403).json({ error: 'Session does not belong to this API key' });
        return;
      }

      // Check SSE connection limit
      if (!sseLimiter.registerConnection(apiKey, sessionId)) {
        res.status(429).json({
          error: 'Maximum concurrent SSE streams exceeded (5)',
          current_streams: sseLimiter.getConnectionCount(apiKey),
        });
        return;
      }

      // Try to attach SSE connection
      if (!this.sessionManager.attachSSEConnection(sessionId, res)) {
        sseLimiter.unregisterConnection(apiKey, sessionId);
        res.status(409).json({ error: 'Session already has an active stream' });
        return;
      }

      // Setup SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

      // Send initial connection event
      res.write(`data: ${JSON.stringify({ type: 'connected', session_id: sessionId })}\n\n`);

      // Send keepalive every 15 seconds
      const keepaliveInterval = setInterval(() => {
        res.write(': keepalive\n\n');
      }, 15000);

      // Handle client disconnect
      req.on('close', () => {
        clearInterval(keepaliveInterval);
        this.sessionManager.detachSSEConnection(sessionId);
        sseLimiter.unregisterConnection(apiKey, sessionId);
        console.log(`[HTTP] SSE stream closed for session ${sessionId}`);
      });

      console.log(`[HTTP] SSE stream opened for session ${sessionId}`);
    });

    // Message sending endpoint
    this.app.post('/mcp/message', authMiddleware, messageRateLimiter, (req: Request, res: Response) => {
      const apiKey = (req as any).apiKey;
      const { session_id, message } = req.body;

      // Validate request body
      if (!session_id || typeof session_id !== 'string') {
        res.status(400).json({ error: 'Missing or invalid session_id' });
        return;
      }

      if (!message || typeof message !== 'object') {
        res.status(400).json({ error: 'Missing or invalid message' });
        return;
      }

      // Verify session
      const session = this.sessionManager.getSession(session_id);

      if (!session) {
        res.status(404).json({ error: 'Session not found or expired' });
        return;
      }

      if (!this.sessionManager.verifySessionOwnership(session_id, apiKey)) {
        res.status(403).json({ error: 'Session does not belong to this API key' });
        return;
      }

      // Validate JSON-RPC message format
      if (!message.jsonrpc || message.jsonrpc !== '2.0') {
        res.status(400).json({ error: 'Invalid JSON-RPC message. Expected jsonrpc: "2.0"' });
        return;
      }

      if (!message.method || typeof message.method !== 'string') {
        res.status(400).json({ error: 'Invalid JSON-RPC message. Missing method field' });
        return;
      }

      // Process message via callback
      try {
        this.onMessage(session_id, message);
        res.json({ success: true });
      } catch (error: any) {
        console.error('[HTTP] Message processing failed:', error);
        res.status(500).json({ error: 'Failed to process message', details: error.message });
      }
    });

    // 404 handler
    this.app.use((_req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not found',
        available_endpoints: [
          'GET /health',
          'GET /mcp/capabilities',
          'POST /mcp/session',
          'GET /mcp/stream/:sessionId',
          'POST /mcp/message',
        ],
      });
    });

    // Error handler
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('[HTTP] Error:', err);

      // Don't expose internal errors in production
      const message = process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message;

      res.status(500).json({ error: message });
    });
  }

  /**
   * Start HTTP server
   */
  async start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(port, () => {
          console.log(`[HTTP] MCP server listening on port ${port}`);
          console.log(`[HTTP] Health check: http://localhost:${port}/health`);
          console.log(`[HTTP] Capabilities: http://localhost:${port}/mcp/capabilities`);
          resolve();
        });

        this.server.on('error', (error: Error) => {
          console.error('[HTTP] Server error:', error);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop HTTP server gracefully
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        console.log('[HTTP] Shutting down gracefully...');

        this.server.close(() => {
          console.log('[HTTP] Server closed');
          resolve();
        });

        // Force close after 5 seconds
        setTimeout(() => {
          console.log('[HTTP] Force closing server');
          resolve();
        }, 5000);
      } else {
        resolve();
      }
    });
  }
}
