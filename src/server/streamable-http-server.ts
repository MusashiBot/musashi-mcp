/**
 * Streamable HTTP server for MCP protocol
 * Implements the new MCP Streamable HTTP transport (2025-06-18)
 * Replaces the old HTTP+SSE transport
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { randomBytes } from 'crypto';
import { hourlyRateLimiter } from './rate-limiter.js';
import {
  handleOAuthAuthorize,
  handleOAuthDiscovery,
  handleOAuthProtectedResourceMetadata,
  handleOAuthToken,
} from './oauth-handler.js';
import { verifyApiKey, extractApiKey } from '../transports/auth.js';

// Supported MCP protocol version
const SUPPORTED_PROTOCOL_VERSION = '2025-06-18';
const LEGACY_PROTOCOL_VERSION = '2025-03-26';

interface Session {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  sseStreams: Set<Response>;
  lastActivity: Date;
  initialized: boolean;
}

export interface StreamableHttpServerOptions {
  port: number;
  onRequest: (sessionId: string | null, request: any) => Promise<any>;
  onNotification: (sessionId: string | null, notification: any) => Promise<void>;
  onResponse: (sessionId: string | null, response: any) => Promise<void>;
}

export class StreamableHttpServer {
  private app: express.Application;
  private server: any;
  private sessions: Map<string, Session> = new Map();
  private onRequest: (sessionId: string | null, request: any) => Promise<any>;
  private onNotification: (sessionId: string | null, notification: any) => Promise<void>;
  private onResponse: (sessionId: string | null, response: any) => Promise<void>;

  private readonly SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

  constructor(options: StreamableHttpServerOptions) {
    this.app = express();
    this.app.set('trust proxy', true);
    this.onRequest = options.onRequest;
    this.onNotification = options.onNotification;
    this.onResponse = options.onResponse;

    this.setupMiddleware();
    this.setupRoutes();
    this.startCleanupJob();
  }

  private setupMiddleware(): void {
    // CORS configuration - MUST validate Origin to prevent DNS rebinding
    const ALLOWED_ORIGINS = [
      // OpenAI clients
      'https://chatgpt.com',
      'https://www.chatgpt.com',
      'https://chat.openai.com',

      // Anthropic clients
      'https://claude.ai',
      'https://www.claude.ai',
      'https://api.anthropic.com',

      // Local development
      'http://localhost:3000',
      'http://localhost:5173',
    ];

    const corsMiddleware = cors({
      origin: (origin, callback) => {
        // Security: Validate Origin header to prevent DNS rebinding attacks
        if (!origin) {
          // Allow requests with no origin (curl, mobile apps)
          callback(null, true);
          return;
        }

        if (ALLOWED_ORIGINS.includes(origin)) {
          callback(null, true);
        } else {
          console.warn(`[Streamable HTTP] Blocked request from unauthorized origin: ${origin}`);
          callback(new Error('CORS not allowed'));
        }
      },
      credentials: true,
      exposedHeaders: ['Mcp-Session-Id'],
    });

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      // OAuth authorize is served as a top-level page and form POST, not a cross-origin API.
      // Bypass CORS here so the browser can render and submit the authorization form normally.
      if (req.path === '/oauth/authorize') {
        next();
        return;
      }

      corsMiddleware(req, res, next);
    });

    // JSON body parsing
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Request logging
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      const sessionId = req.headers['mcp-session-id'] || 'none';
      console.log(`[Streamable HTTP] ${req.method} ${req.path} - Session: ${sessionId}`);
      next();
    });

    // Apply rate limiters
    this.app.use(hourlyRateLimiter);
  }

  private setupRoutes(): void {
    const handleMcpRoute = async (req: Request, res: Response) => {
      try {
        if (req.method === 'POST') {
          await this.handlePost(req, res);
        } else if (req.method === 'GET') {
          const accept = req.headers['accept'] as string | undefined;
          const sessionId = req.headers['mcp-session-id'] as string | undefined;

          if (!sessionId && (!accept || !accept.includes('text/event-stream'))) {
            res.status(200).json({
              name: 'musashi-mcp',
              transport: 'streamable-http',
              protocol_version: SUPPORTED_PROTOCOL_VERSION,
              mcp_endpoint: '/mcp',
              oauth_authorization_server: '/.well-known/oauth-authorization-server',
              oauth_protected_resource: '/.well-known/oauth-protected-resource',
            });
            return;
          }

          await this.handleGet(req, res);
        } else if (req.method === 'DELETE') {
          await this.handleDelete(req, res);
        } else if (req.method === 'OPTIONS') {
          res.status(200).end();
        } else {
          res.status(405).json({ error: 'Method not allowed. Use POST, GET, or DELETE.' });
        }
      } catch (error: any) {
        console.error('[Streamable HTTP] Error handling request:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    };
    
    // Authentication middleware for MCP routes
    const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
      const apiKey = extractApiKey(req.headers.authorization);
      if (!apiKey || !verifyApiKey(apiKey)) {
        res.status(401).json({ error: 'Unauthorized: Invalid or missing Bearer token' });
        return;
      }
      (req as any).apiKey = apiKey;
      next();
    };

    // Health check endpoint (public, no MCP protocol)
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        transport: 'streamable-http',
        protocol_version: SUPPORTED_PROTOCOL_VERSION,
        uptime_seconds: Math.floor(process.uptime()),
        active_sessions: this.sessions.size,
        memory_usage: process.memoryUsage(),
      });
    });

    this.app.get('/.well-known/oauth-authorization-server', handleOAuthDiscovery);
    this.app.get('/.well-known/oauth-protected-resource', handleOAuthProtectedResourceMetadata);
    this.app.get('/oauth/authorize', handleOAuthAuthorize);
    this.app.post('/oauth/authorize', handleOAuthAuthorize);
    this.app.post('/oauth/token', handleOAuthToken);

    // OAuth routes (authMiddleware applied)
    this.app.all('/', authMiddleware, handleMcpRoute);
    this.app.all('/mcp', authMiddleware, handleMcpRoute);

    // 404 handler
    this.app.use((_req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not found',
        available_endpoints: [
          'GET /',
          'GET /health',
          'GET /.well-known/oauth-protected-resource',
          'GET /.well-known/oauth-authorization-server',
          'GET /oauth/authorize',
          'POST /oauth/authorize',
          'POST /oauth/token',
          'POST / (send JSON-RPC messages)',
          'POST /mcp (send JSON-RPC messages)',
          'GET / (open SSE stream)',
          'GET /mcp (open SSE stream)',
          'DELETE / (terminate session)',
          'DELETE /mcp (terminate session)',
        ],
      });
    });

    // Error handler
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('[Streamable HTTP] Error:', err);
      res.status(500).json({ error: err.message });
    });
  }

  /**
   * Handle POST /mcp - Send JSON-RPC message to server
   */
  private async handlePost(req: Request, res: Response): Promise<void> {
    // Validate protocol version
    const protocolVersion = req.headers['mcp-protocol-version'] as string;
    if (!this.isValidProtocolVersion(protocolVersion)) {
      res.status(400).json({
        error: `Invalid or unsupported MCP-Protocol-Version. Expected: ${SUPPORTED_PROTOCOL_VERSION}`,
      });
      return;
    }

    // Get session ID from header
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Validate Accept header
    const accept = req.headers['accept'] as string;
    if (!accept || (!accept.includes('application/json') && !accept.includes('text/event-stream'))) {
      res.status(400).json({
        error: 'Accept header must include application/json and/or text/event-stream',
      });
      return;
    }

    // Validate JSON-RPC message
    const message = req.body;
    if (!this.isValidJsonRpcMessage(message)) {
      res.status(400).json({
        error: 'Invalid JSON-RPC message format',
      });
      return;
    }

    // Check if session is required (all messages except initialize)
    if (message.method !== 'initialize' && !sessionId) {
      res.status(400).json({
        error: 'Mcp-Session-Id header required for all requests except initialize',
      });
      return;
    }

    // Verify session exists if provided
    if (sessionId && !this.sessions.has(sessionId)) {
      res.status(404).json({
        error: 'Session not found or expired',
      });
      return;
    }

    // Handle different JSON-RPC message types
    if ('method' in message && 'id' in message) {
      // JSON-RPC Request - respond with result or SSE stream
      await this.handleJsonRpcRequest(sessionId || null, message, req, res);
    } else if ('method' in message && !('id' in message)) {
      // JSON-RPC Notification - acknowledge with 202
      await this.handleJsonRpcNotification(sessionId || null, message, res);
    } else if ('result' in message || 'error' in message) {
      // JSON-RPC Response - acknowledge with 202
      await this.handleJsonRpcResponse(sessionId || null, message, res);
    } else {
      res.status(400).json({ error: 'Invalid JSON-RPC message type' });
    }
  }

  /**
   * Handle GET /mcp - Open SSE stream for server messages
   */
  private async handleGet(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Validate Accept header
    const accept = req.headers['accept'] as string;
    if (!accept || !accept.includes('text/event-stream')) {
      res.status(405).json({
        error: 'Method Not Allowed. GET requires Accept: text/event-stream',
      });
      return;
    }

    if (!sessionId) {
      res.status(400).json({
        error: 'Mcp-Session-Id header required for GET requests',
      });
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({
        error: 'Session not found or expired',
      });
      return;
    }

    // Open SSE stream
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Add this stream to session
    session.sseStreams.add(res);
    console.log(`[Streamable HTTP] Opened SSE stream for session ${sessionId} (${session.sseStreams.size} total)`);

    // Send keepalive every 30 seconds
    const keepaliveInterval = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30000);

    // Handle client disconnect
    req.on('close', () => {
      clearInterval(keepaliveInterval);
      session.sseStreams.delete(res);
      console.log(`[Streamable HTTP] Closed SSE stream for session ${sessionId} (${session.sseStreams.size} remaining)`);
    });
  }

  /**
   * Handle DELETE /mcp - Terminate session
   */
  private async handleDelete(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
      res.status(400).json({
        error: 'Mcp-Session-Id header required for DELETE requests',
      });
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({
        error: 'Session not found or expired',
      });
      return;
    }

    // Close all SSE streams
    for (const stream of session.sseStreams) {
      try {
        stream.end();
      } catch (error) {
        // Ignore errors
      }
    }

    this.sessions.delete(sessionId);
    console.log(`[Streamable HTTP] Terminated session ${sessionId}`);

    res.status(200).json({ success: true });
  }

  /**
   * Handle JSON-RPC Request
   */
  private async handleJsonRpcRequest(
    sessionId: string | null,
    request: any,
    _req: Request,
    res: Response
  ): Promise<void> {
    try {
      // Special handling for initialize request
      if (request.method === 'initialize') {
        const result = await this.onRequest(null, request);

        // Create new session
        const newSessionId = this.createSession();
        const session = this.sessions.get(newSessionId)!;
        session.initialized = true;

        // Return session ID in header
        res.setHeader('Mcp-Session-Id', newSessionId);
        res.status(200).json(result);

        console.log(`[Streamable HTTP] Created session ${newSessionId} via initialize`);
        return;
      }

      // Process request via callback
      const result = await this.onRequest(sessionId, request);

      // Update session activity
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.lastActivity = new Date();
        }
      }

      // Return JSON response
      res.status(200).json(result);
    } catch (error: any) {
      console.error('[Streamable HTTP] Request processing failed:', error);
      res.status(500).json({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32603,
          message: error.message || 'Internal error',
        },
      });
    }
  }

  /**
   * Handle JSON-RPC Notification
   */
  private async handleJsonRpcNotification(
    sessionId: string | null,
    notification: any,
    res: Response
  ): Promise<void> {
    try {
      await this.onNotification(sessionId, notification);
      res.status(202).end();
    } catch (error: any) {
      console.error('[Streamable HTTP] Notification processing failed:', error);
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error.message || 'Internal error',
        },
      });
    }
  }

  /**
   * Handle JSON-RPC Response
   */
  private async handleJsonRpcResponse(
    sessionId: string | null,
    response: any,
    res: Response
  ): Promise<void> {
    try {
      await this.onResponse(sessionId, response);
      res.status(202).end();
    } catch (error: any) {
      console.error('[Streamable HTTP] Response processing failed:', error);
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error.message || 'Internal error',
        },
      });
    }
  }

  /**
   * Send message to session via SSE
   */
  sendMessage(sessionId: string, message: any): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.sseStreams.size === 0) {
      return false;
    }

    const data = JSON.stringify(message);
    let sent = false;

    for (const stream of session.sseStreams) {
      try {
        stream.write(`data: ${data}\n\n`);
        sent = true;
      } catch (error) {
        console.error(`[Streamable HTTP] Failed to send message to session ${sessionId}:`, error);
      }
    }

    return sent;
  }

  /**
   * Create new session
   */
  private createSession(): string {
    const sessionId = `mcp_${randomBytes(16).toString('hex')}`;
    const now = new Date();

    this.sessions.set(sessionId, {
      id: sessionId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.SESSION_TTL_MS),
      sseStreams: new Set(),
      lastActivity: now,
      initialized: false,
    });

    return sessionId;
  }

  /**
   * Validate protocol version
   */
  private isValidProtocolVersion(version: string | undefined): boolean {
    if (!version) {
      // Assume legacy version if not provided
      return true;
    }
    return version === SUPPORTED_PROTOCOL_VERSION || version === LEGACY_PROTOCOL_VERSION;
  }

  /**
   * Validate JSON-RPC message format
   */
  private isValidJsonRpcMessage(message: any): boolean {
    if (!message || typeof message !== 'object') {
      return false;
    }

    if (message.jsonrpc !== '2.0') {
      return false;
    }

    // Must have either method (request/notification) or result/error (response)
    const hasMethod = 'method' in message;
    const hasResult = 'result' in message || 'error' in message;

    return hasMethod || hasResult;
  }

  /**
   * Cleanup expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = new Date();
    let expiredCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        // Close all SSE streams
        for (const stream of session.sseStreams) {
          try {
            stream.end();
          } catch (error) {
            // Ignore
          }
        }

        this.sessions.delete(sessionId);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      console.log(`[Streamable HTTP] Cleaned up ${expiredCount} expired sessions`);
    }
  }

  /**
   * Start cleanup job
   */
  private startCleanupJob(): void {
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Start HTTP server
   */
  async start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(port, '0.0.0.0', () => {
          console.log(`[Streamable HTTP] MCP server listening on http://0.0.0.0:${port}`);
          console.log(`[Streamable HTTP] Protocol version: ${SUPPORTED_PROTOCOL_VERSION}`);
          console.log(`[Streamable HTTP] Health check: http://0.0.0.0:${port}/health`);
          console.log(`[Streamable HTTP] MCP endpoint: http://0.0.0.0:${port}/mcp`);
          resolve();
        });

        this.server.on('error', (error: Error) => {
          console.error('[Streamable HTTP] Server error:', error);
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
        console.log('[Streamable HTTP] Shutting down gracefully...');

        // Close all sessions
        for (const session of this.sessions.values()) {
          for (const stream of session.sseStreams) {
            try {
              stream.end();
            } catch (error) {
              // Ignore
            }
          }
        }
        this.sessions.clear();

        this.server.close(() => {
          console.log('[Streamable HTTP] Server closed');
          resolve();
        });

        // Force close after 5 seconds
        setTimeout(() => {
          console.log('[Streamable HTTP] Force closing server');
          resolve();
        }, 5000);
      } else {
        resolve();
      }
    });
  }
}
