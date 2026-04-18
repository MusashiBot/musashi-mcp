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
  handleOAuthRegister,
  handleOAuthToken,
  getPublicBaseUrl,
  verifyOAuthAccessToken,
} from './oauth-handler.js';
import { extractApiKey, verifyApiKey, getTruncatedKey } from '../transports/auth.js';

const SUPPORTED_PROTOCOL_VERSION = '2025-06-18';
const LEGACY_PROTOCOL_VERSION = '2025-03-26';

interface Session {
  id: string;
  principal: string;
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
  private readonly SESSION_TTL_MS = 30 * 60 * 1000;
  private cleanupInterval: NodeJS.Timeout | null = null;

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
    const ALLOWED_ORIGINS = [
      'https://chatgpt.com',
      'https://www.chatgpt.com',
      'https://chat.openai.com',
      'https://claude.ai',
      'https://www.claude.ai',
      'https://api.anthropic.com',
      'http://localhost:3000',
      'http://localhost:5173',
    ];

    const corsMiddleware = cors({
      origin: (origin, callback) => {
        if (!origin) {
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
      if (req.path === '/oauth/authorize') {
        next();
        return;
      }
      corsMiddleware(req, res, next);
    });

    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      const sessionId = req.headers['mcp-session-id'] || 'none';
      console.log(`[Streamable HTTP] ${req.method} ${req.path} - Session: ${sessionId}`);
      next();
    });

    this.app.use(hourlyRateLimiter);
  }

  private setupRoutes(): void {
    const handleMcpRoute = async (req: Request, res: Response) => {
      try {
        if (req.method === 'GET') {
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
        }

        if (req.method === 'OPTIONS') {
          res.status(200).end();
          return;
        }

        if (req.method === 'POST') {
          await this.handlePost(req, res);
        } else if (req.method === 'GET') {
          await this.handleGet(req, res);
        } else if (req.method === 'DELETE') {
          await this.handleDelete(req, res);
        } else {
          res.status(405).json({ error: 'Method not allowed. Use POST, GET, or DELETE.' });
        }
      } catch (error: any) {
        console.error('[Streamable HTTP] Error handling request:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    };

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
    this.app.post('/oauth/register', handleOAuthRegister);
    this.app.post('/oauth/token', handleOAuthToken);

    this.app.all('/', handleMcpRoute);
    this.app.all('/mcp', handleMcpRoute);

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
          'POST /oauth/register',
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

    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('[Streamable HTTP] Error:', err);
      res.status(500).json({ error: err.message });
    });
  }

  private getRequestPrincipal(req: Request): string | null {
    const authorization = req.headers.authorization;
    const apiKey = extractApiKey(authorization);
    if (apiKey && verifyApiKey(apiKey)) {
      return `apikey:${apiKey}`;
    }

    const bearerToken = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';
    if (!bearerToken) {
      return null;
    }

    const claims = verifyOAuthAccessToken(bearerToken);
    if (!claims) {
      return null;
    }

    return `oauth:${claims.sub}:${claims.client_id}`;
  }

  private ensureAuthenticated(req: Request, res: Response): string | null {
    const principal = this.getRequestPrincipal(req);
    if (!principal) {
      const rawApiKey = extractApiKey(req.headers.authorization);
      if (rawApiKey) {
        console.warn(`[Streamable HTTP] Rejected invalid API key: ${getTruncatedKey(rawApiKey)}`);
      }
      const protectedResourceMetadata = `${getPublicBaseUrl(req)}/.well-known/oauth-protected-resource`;
      res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="mcp", resource_metadata="${protectedResourceMetadata}"`
      );
      res.status(401).json({
        error: 'Unauthorized. Provide a valid API key or OAuth access token in Authorization: Bearer <token>.',
      });
      return null;
    }

    return principal;
  }

  private async handlePost(req: Request, res: Response): Promise<void> {
    const principal = this.ensureAuthenticated(req, res);
    if (!principal) {
      return;
    }

    const protocolVersion = req.headers['mcp-protocol-version'] as string;
    if (!this.isValidProtocolVersion(protocolVersion)) {
      res.status(400).json({
        error: `Invalid or unsupported MCP-Protocol-Version. Expected: ${SUPPORTED_PROTOCOL_VERSION}`,
      });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const accept = req.headers['accept'] as string;
    if (!accept || (!accept.includes('application/json') && !accept.includes('text/event-stream'))) {
      res.status(400).json({
        error: 'Accept header must include application/json and/or text/event-stream',
      });
      return;
    }

    const message = req.body;
    if (!this.isValidJsonRpcMessage(message)) {
      res.status(400).json({ error: 'Invalid JSON-RPC message format' });
      return;
    }

    if (message.method !== 'initialize' && !sessionId) {
      res.status(400).json({
        error: 'Mcp-Session-Id header required for all requests except initialize',
      });
      return;
    }

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found or expired' });
        return;
      }
      if (session.principal !== principal) {
        res.status(403).json({
          error: 'Session does not belong to this authenticated principal',
        });
        return;
      }
    }

    if ('method' in message && 'id' in message) {
      await this.handleJsonRpcRequest(sessionId || null, message, req, res, principal);
    } else if ('method' in message && !('id' in message)) {
      await this.handleJsonRpcNotification(sessionId || null, message, res);
    } else if ('result' in message || 'error' in message) {
      await this.handleJsonRpcResponse(sessionId || null, message, res);
    } else {
      res.status(400).json({ error: 'Invalid JSON-RPC message type' });
    }
  }

  private async handleGet(req: Request, res: Response): Promise<void> {
    const principal = this.ensureAuthenticated(req, res);
    if (!principal) {
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const accept = req.headers['accept'] as string;
    if (!accept || !accept.includes('text/event-stream')) {
      res.status(405).json({ error: 'Method Not Allowed. GET requires Accept: text/event-stream' });
      return;
    }

    if (!sessionId) {
      res.status(400).json({ error: 'Mcp-Session-Id header required for GET requests' });
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }
    if (session.principal !== principal) {
      res.status(403).json({
        error: 'Session does not belong to this authenticated principal',
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    session.sseStreams.add(res);
    console.log(`[Streamable HTTP] Opened SSE stream for session ${sessionId} (${session.sseStreams.size} total)`);

    const keepaliveInterval = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(keepaliveInterval);
      session.sseStreams.delete(res);
      console.log(`[Streamable HTTP] Closed SSE stream for session ${sessionId} (${session.sseStreams.size} remaining)`);
    });
  }

  private async handleDelete(req: Request, res: Response): Promise<void> {
    const principal = this.ensureAuthenticated(req, res);
    if (!principal) {
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'Mcp-Session-Id header required for DELETE requests' });
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }
    if (session.principal !== principal) {
      res.status(403).json({
        error: 'Session does not belong to this authenticated principal',
      });
      return;
    }

    for (const stream of session.sseStreams) {
      try {
        stream.end();
      } catch {
        // ignore
      }
    }

    this.sessions.delete(sessionId);
    console.log(`[Streamable HTTP] Terminated session ${sessionId}`);
    res.status(200).json({ success: true });
  }

  private async handleJsonRpcRequest(
    sessionId: string | null,
    request: any,
    _req: Request,
    res: Response,
    principal: string
  ): Promise<void> {
    try {
      if (request.method === 'initialize') {
        const result = await this.onRequest(null, request);
        const newSessionId = this.createSession(principal);
        const session = this.sessions.get(newSessionId)!;
        session.initialized = true;
        res.setHeader('Mcp-Session-Id', newSessionId);
        res.status(200).json(result);
        console.log(`[Streamable HTTP] Created session ${newSessionId} via initialize`);
        return;
      }

      const result = await this.onRequest(sessionId, request);
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.lastActivity = new Date();
        }
      }

      res.status(200).json(result);
    } catch (error: any) {
      console.error('[Streamable HTTP] Request processing failed:', error);
      res.status(500).json({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32603, message: error.message || 'Internal error' },
      });
    }
  }

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
        error: { code: -32603, message: error.message || 'Internal error' },
      });
    }
  }

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
        error: { code: -32603, message: error.message || 'Internal error' },
      });
    }
  }

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

  private createSession(principal: string): string {
    const sessionId = `mcp_${randomBytes(16).toString('hex')}`;
    const now = new Date();
    this.sessions.set(sessionId, {
      id: sessionId,
      principal,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.SESSION_TTL_MS),
      sseStreams: new Set(),
      lastActivity: now,
      initialized: false,
    });
    return sessionId;
  }

  private isValidProtocolVersion(version: string | undefined): boolean {
    if (!version) {
      return true;
    }
    return version === SUPPORTED_PROTOCOL_VERSION || version === LEGACY_PROTOCOL_VERSION;
  }

  private isValidJsonRpcMessage(message: any): boolean {
    if (!message || typeof message !== 'object') {
      return false;
    }
    if (message.jsonrpc !== '2.0') {
      return false;
    }
    const hasMethod = 'method' in message;
    const hasResult = 'result' in message || 'error' in message;
    return hasMethod || hasResult;
  }

  private cleanupExpiredSessions(): void {
    const now = new Date();
    let expiredCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        for (const stream of session.sseStreams) {
          try {
            stream.end();
          } catch {
            // ignore
          }
        }
        this.sessions.delete(sessionId);
        expiredCount += 1;
      }
    }

    if (expiredCount > 0) {
      console.log(`[Streamable HTTP] Cleaned up ${expiredCount} expired sessions`);
    }
  }

  private startCleanupJob(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 5 * 60 * 1000);
  }

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

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        console.log('[Streamable HTTP] Shutting down gracefully...');
        if (this.cleanupInterval) {
          clearInterval(this.cleanupInterval);
          this.cleanupInterval = null;
        }
        for (const session of this.sessions.values()) {
          for (const stream of session.sseStreams) {
            try {
              stream.end();
            } catch {
              // ignore
            }
          }
        }
        this.sessions.clear();
        this.server.close(() => {
          console.log('[Streamable HTTP] Server closed');
          resolve();
        });
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
