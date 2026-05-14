import type { Request, Response } from 'express';
import crypto from 'crypto';
import { verifyApiKey } from '../transports/auth.js';
import type { AuthCodeRecord, OAuthStore, RefreshTokenRecord } from './oauth-store.js';

interface AccessTokenClaims {
  sub: string;
  client_id: string;
  scope: string;
  exp: number;
  iat: number;
  jti: string;
}

const AUTH_CODE_TTL_SECONDS = 300;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

const accessTokenSecret =
  process.env.MCP_OAUTH_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

if (!process.env.MCP_OAUTH_TOKEN_SECRET) {
  console.warn(
    '[OAuth] MCP_OAUTH_TOKEN_SECRET not set; OAuth access tokens will be invalidated on every server restart',
  );
}

// ---------------------------------------------------------------------------
// Pure helpers — no store dependency
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getAccessTokenSigningKey(): Buffer {
  return crypto.createHash('sha256').update(accessTokenSecret).digest();
}

function encodeBase64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signAccessToken(tokenBody: string): string {
  return crypto
    .createHmac('sha256', getAccessTokenSigningKey())
    .update(tokenBody)
    .digest('base64url');
}

function buildApiKeySubject(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function issueAccessToken(sub: string, clientId: string): { token: string; expiresIn: number } {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    sub,
    client_id: clientId,
    scope: 'mcp:read mcp:write',
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    jti: crypto.randomBytes(12).toString('hex'),
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = encodeBase64UrlJson(header);
  const encodedClaims = encodeBase64UrlJson(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = signAccessToken(signingInput);
  return { token: `${signingInput}.${signature}`, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

export function verifyOAuthAccessToken(token: string): AccessTokenClaims | null {
  if (!token || typeof token !== 'string') {
    return null;
  }
  const segments = token.split('.');
  if (segments.length !== 3) {
    return null;
  }
  const [encodedHeader, encodedClaims, signature] = segments;
  if (!encodedHeader || !encodedClaims || !signature) {
    return null;
  }
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const expectedSignature = signAccessToken(signingInput);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const parsedClaims = JSON.parse(
      Buffer.from(encodedClaims, 'base64url').toString('utf8'),
    ) as AccessTokenClaims;
    if (
      typeof parsedClaims.exp !== 'number' ||
      typeof parsedClaims.sub !== 'string' ||
      typeof parsedClaims.client_id !== 'string'
    ) {
      return null;
    }
    if (parsedClaims.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsedClaims;
  } catch {
    return null;
  }
}

function buildClientMetadata(client: {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
}) {
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: 'none' as const,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: client.clientName,
  };
}

function validateRedirectUri(redirectUri: string): boolean {
  try {
    const parsed = new URL(redirectUri);
    return (
      parsed.protocol === 'https:' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost'
    );
  } catch {
    return false;
  }
}

export function getPublicBaseUrl(req: Request): string {
  const configuredBaseUrl = process.env.MUSASHI_MCP_PUBLIC_BASE_URL?.trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, '');
  }

  return `${req.protocol}://${req.get('host')}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderAuthorizeForm(options: {
  clientId?: string;
  redirectUri: string;
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  error?: string;
}): string {
  const errorBlock = options.error
    ? `<div class="error">${escapeHtml(options.error)}</div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Musashi Authorization</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 440px; margin: 72px auto; padding: 24px; color: #1f2937; }
    h1 { font-size: 28px; margin-bottom: 12px; }
    p { line-height: 1.5; color: #4b5563; }
    .info { background: #eff6ff; border: 1px solid #bfdbfe; color: #1d4ed8; padding: 12px; border-radius: 8px; margin: 20px 0; }
    .error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; padding: 12px; border-radius: 8px; margin-bottom: 16px; }
    input { width: 100%; box-sizing: border-box; padding: 12px; margin: 8px 0 16px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    button { width: 100%; border: 0; border-radius: 8px; padding: 12px; background: #0f62fe; color: white; font-size: 15px; cursor: pointer; }
    button:hover { background: #0043ce; }
  </style>
</head>
<body>
  <h1>Musashi Authorization</h1>
  <p>Claude is requesting access to your Musashi MCP server.</p>
  <div class="info">Enter a valid Musashi MCP API key to authorize access.</div>
  ${errorBlock}
	  <form method="POST">
	    <input type="password" name="api_key" placeholder="mcp_sk_..." required autofocus />
	    <input type="hidden" name="client_id" value="${escapeHtml(options.clientId || '')}" />
	    <input type="hidden" name="redirect_uri" value="${escapeHtml(options.redirectUri)}" />
	    <input type="hidden" name="state" value="${escapeHtml(options.state)}" />
    <input type="hidden" name="code_challenge" value="${escapeHtml(options.codeChallenge || '')}" />
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(options.codeChallengeMethod || 'S256')}" />
    <button type="submit">Authorize Access</button>
  </form>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Private grant helpers — take store as a parameter, no global dependency
// ---------------------------------------------------------------------------

async function handleAuthorizationCodeGrant(
  req: Request,
  res: Response,
  store: OAuthStore,
): Promise<void> {
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  const codeVerifier = typeof req.body?.code_verifier === 'string' ? req.body.code_verifier : '';
  const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : '';
  const redirectUri = typeof req.body?.redirect_uri === 'string' ? req.body.redirect_uri : '';

  if (!code || !clientId || !redirectUri) {
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'Missing required parameters (code, client_id, redirect_uri)',
    });
    return;
  }

  const codeHash = sha256Hex(code);

  // Step 1: Read-only lookup — validate everything before consuming the code.
  // consumeAuthCode (GETDEL) is called only after all checks pass, so a bad
  // request (wrong redirect_uri, bad code_verifier, etc.) cannot burn the code.
  const authData = await store.getAuthCode(codeHash);
  if (!authData) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code',
    });
    return;
  }

  if (authData.expiresAt < Date.now()) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Authorization code has expired',
    });
    return;
  }

  if (clientId !== authData.clientId) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'client_id does not match authorization code',
    });
    return;
  }

  if (redirectUri !== authData.redirectUri) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'redirect_uri does not match authorization code',
    });
    return;
  }

  const client = await store.getClient(authData.clientId);
  if (!client) {
    res.status(400).json({
      error: 'invalid_client',
      error_description: 'Unknown or unregistered client_id',
    });
    return;
  }

  if (authData.codeChallenge) {
    if (!codeVerifier) {
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'code_verifier is required when code_challenge was used',
      });
      return;
    }

    const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    if (challenge !== authData.codeChallenge) {
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Code verifier does not match challenge',
      });
      return;
    }
  }

  // Step 2: Atomic consume — exactly one concurrent request wins; the loser gets null.
  const consumed = await store.consumeAuthCode(codeHash);
  if (!consumed) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Authorization code has already been used',
    });
    return;
  }

  const accessToken = issueAccessToken(authData.subject, client.clientId);
  const rawRefreshToken = crypto.randomBytes(40).toString('hex');
  const refreshTokenHash = sha256Hex(rawRefreshToken);
  const refreshRecord: RefreshTokenRecord = {
    clientId: client.clientId,
    subject: authData.subject,
    scope: authData.scope,
    familyId: crypto.randomUUID(),
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000,
    createdAt: Date.now(),
  };
  await store.saveRefreshToken(refreshTokenHash, refreshRecord, REFRESH_TOKEN_TTL_SECONDS);

  res.json({
    access_token: accessToken.token,
    token_type: 'Bearer',
    expires_in: accessToken.expiresIn,
    scope: authData.scope,
    refresh_token: rawRefreshToken,
  });
}

async function handleRefreshTokenGrant(
  req: Request,
  res: Response,
  store: OAuthStore,
): Promise<void> {
  const rawRefreshToken =
    typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
  const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : '';

  if (!rawRefreshToken) {
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'Missing required parameter: refresh_token',
    });
    return;
  }

  const tokenHash = sha256Hex(rawRefreshToken);
  const tokenRecord = await store.getRefreshToken(tokenHash);

  if (!tokenRecord) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid or expired refresh token',
    });
    return;
  }

  // Replay detection: consumed token re-presented → revoke entire family
  if (tokenRecord.consumedAt !== undefined) {
    await store.revokeRefreshTokenFamily(tokenRecord.familyId, REFRESH_TOKEN_TTL_SECONDS);
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Refresh token has already been used',
    });
    return;
  }

  if (await store.isFamilyRevoked(tokenRecord.familyId)) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Refresh token family has been revoked',
    });
    return;
  }

  if (tokenRecord.expiresAt < Date.now()) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Refresh token has expired',
    });
    return;
  }

  if (clientId && clientId !== tokenRecord.clientId) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'client_id does not match refresh token',
    });
    return;
  }

  const client = await store.getClient(tokenRecord.clientId);
  if (!client) {
    res.status(400).json({
      error: 'invalid_client',
      error_description: 'Unknown or unregistered client_id',
    });
    return;
  }

  const accessToken = issueAccessToken(tokenRecord.subject, client.clientId);
  const newRawRefreshToken = crypto.randomBytes(40).toString('hex');
  const newRefreshTokenHash = sha256Hex(newRawRefreshToken);
  const newRefreshRecord: RefreshTokenRecord = {
    clientId: client.clientId,
    subject: tokenRecord.subject,
    scope: tokenRecord.scope,
    familyId: tokenRecord.familyId,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000,
    createdAt: Date.now(),
  };

  const rotated = await store.rotateRefreshToken(
    tokenHash,
    newRefreshTokenHash,
    newRefreshRecord,
    REFRESH_TOKEN_TTL_SECONDS,
  );

  if (!rotated) {
    // Another concurrent request already consumed this token between our read
    // and the atomic rotation — treat it like replay.
    await store.revokeRefreshTokenFamily(tokenRecord.familyId, REFRESH_TOKEN_TTL_SECONDS);
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Refresh token has already been used',
    });
    return;
  }

  res.json({
    access_token: accessToken.token,
    token_type: 'Bearer',
    expires_in: accessToken.expiresIn,
    scope: tokenRecord.scope,
    refresh_token: newRawRefreshToken,
  });
}

// ---------------------------------------------------------------------------
// Public factory — creates per-instance bound handlers, no global state
// ---------------------------------------------------------------------------

export interface OAuthHandlers {
  handleOAuthDiscovery: (req: Request, res: Response) => void;
  handleOAuthProtectedResourceMetadata: (req: Request, res: Response) => void;
  handleOAuthRegister: (req: Request, res: Response) => Promise<void>;
  handleOAuthAuthorize: (req: Request, res: Response) => Promise<void>;
  handleOAuthToken: (req: Request, res: Response) => Promise<void>;
}

export function createOAuthHandlers(store: OAuthStore): OAuthHandlers {
  function handleOAuthDiscovery(req: Request, res: Response): void {
    const baseUrl = getPublicBaseUrl(req);
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }

  function handleOAuthProtectedResourceMetadata(req: Request, res: Response): void {
    const baseUrl = getPublicBaseUrl(req);
    res.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:read', 'mcp:write'],
    });
  }

  async function handleOAuthRegister(req: Request, res: Response): Promise<void> {
    try {
      const redirectUris = Array.isArray(req.body?.redirect_uris)
        ? req.body.redirect_uris.filter(
            (value: unknown): value is string => typeof value === 'string',
          )
        : [];
      const clientName =
        typeof req.body?.client_name === 'string' ? req.body.client_name : undefined;

      const authMethod = req.body?.token_endpoint_auth_method;
      if (authMethod != null && authMethod !== 'none') {
        res.status(400).json({
          error: 'invalid_client_metadata',
          error_description:
            'Only token_endpoint_auth_method "none" is accepted (public clients with PKCE).',
        });
        return;
      }

      if (
        redirectUris.length === 0 ||
        redirectUris.some((redirectUri: string) => !validateRedirectUri(redirectUri))
      ) {
        res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: 'A valid https:// or localhost redirect URI is required',
        });
        return;
      }

      const clientId = `mcp_client_${crypto.randomBytes(16).toString('hex')}`;
      const client = {
        clientId,
        redirectUris,
        clientName,
        tokenEndpointAuthMethod: 'none' as const,
        createdAt: Date.now(),
        isActive: true,
      };

      await store.saveClient(client);
      res.status(201).json(buildClientMetadata(client));
    } catch (err) {
      console.error('[OAuth] register error:', err);
      res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
    }
  }

  async function handleOAuthAuthorize(req: Request, res: Response): Promise<void> {
    try {
      const clientId =
        typeof req.query.client_id === 'string'
          ? req.query.client_id
          : typeof req.body?.client_id === 'string'
            ? req.body.client_id
            : '';
      const redirectUri =
        typeof req.query.redirect_uri === 'string'
          ? req.query.redirect_uri
          : typeof req.body?.redirect_uri === 'string'
            ? req.body.redirect_uri
            : '';
      const state =
        typeof req.query.state === 'string'
          ? req.query.state
          : typeof req.body?.state === 'string'
            ? req.body.state
            : '';
      const codeChallenge =
        typeof req.query.code_challenge === 'string'
          ? req.query.code_challenge
          : typeof req.body?.code_challenge === 'string'
            ? req.body.code_challenge
            : '';
      const rawCodeChallengeMethod =
        typeof req.query.code_challenge_method === 'string'
          ? req.query.code_challenge_method
          : typeof req.body?.code_challenge_method === 'string'
            ? req.body.code_challenge_method
            : '';

      const codeChallengeMethod = 'S256' as const;
      if (rawCodeChallengeMethod && rawCodeChallengeMethod !== 'S256') {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'Unsupported code_challenge_method. Only S256 is supported.',
        });
        return;
      }

      if (!clientId || !redirectUri || !state) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing required parameters (client_id, redirect_uri, state)',
        });
        return;
      }

      if (!validateRedirectUri(redirectUri)) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'Invalid redirect_uri',
        });
        return;
      }

      const client = await store.getClient(clientId);
      if (!client) {
        res.status(400).json({
          error: 'invalid_client',
          error_description: 'Unknown or unregistered client_id',
        });
        return;
      }

      if (!client.redirectUris.includes(redirectUri)) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'redirect_uri does not match registered client',
        });
        return;
      }

      if (!codeChallenge) {
        res.status(400).json({
          error: 'invalid_request',
          error_description:
            'PKCE is required for public clients. Provide code_challenge with method S256.',
        });
        return;
      }

      if (req.method === 'POST') {
        const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key : '';

        if (!apiKey || !verifyApiKey(apiKey)) {
          res.status(401).send(
            renderAuthorizeForm({
              clientId,
              redirectUri,
              state,
              codeChallenge,
              codeChallengeMethod,
              error: 'Invalid API key. Please try again.',
            }),
          );
          return;
        }

        const rawCode = `auth_${crypto.randomBytes(32).toString('hex')}`;
        const codeHash = sha256Hex(rawCode);
        const authCodeRecord: AuthCodeRecord = {
          clientId,
          subject: buildApiKeySubject(apiKey),
          redirectUri,
          codeChallenge,
          codeChallengeMethod,
          scope: 'mcp:read mcp:write',
          expiresAt: Date.now() + AUTH_CODE_TTL_SECONDS * 1000,
        };
        await store.saveAuthCode(codeHash, authCodeRecord, AUTH_CODE_TTL_SECONDS);

        const redirectUrl = new URL(redirectUri);
        redirectUrl.searchParams.set('code', rawCode);
        redirectUrl.searchParams.set('state', state);

        res.redirect(redirectUrl.toString());
        return;
      }

      res.send(
        renderAuthorizeForm({
          clientId,
          redirectUri,
          state,
          codeChallenge,
          codeChallengeMethod,
        }),
      );
    } catch (err) {
      console.error('[OAuth] authorize error:', err);
      res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
    }
  }

  async function handleOAuthToken(req: Request, res: Response): Promise<void> {
    try {
      const grantType = typeof req.body?.grant_type === 'string' ? req.body.grant_type : '';

      if (grantType === 'authorization_code') {
        await handleAuthorizationCodeGrant(req, res, store);
      } else if (grantType === 'refresh_token') {
        await handleRefreshTokenGrant(req, res, store);
      } else {
        res.status(400).json({
          error: 'unsupported_grant_type',
          error_description:
            'Only authorization_code and refresh_token grant types are supported',
        });
      }
    } catch (err) {
      console.error('[OAuth] token error:', err);
      res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
    }
  }

  return {
    handleOAuthDiscovery,
    handleOAuthProtectedResourceMetadata,
    handleOAuthRegister,
    handleOAuthAuthorize,
    handleOAuthToken,
  };
}
