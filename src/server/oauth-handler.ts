import type { Request, Response } from 'express';
import crypto from 'crypto';
import { verifyApiKey } from '../transports/auth.js';

interface AuthorizationCodeRecord {
  apiKey: string;
  clientId?: string;
  redirectUri: string;
  expiresAt: number;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain';
}

interface OAuthClientRecord {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  clientName?: string;
  tokenEndpointAuthMethod: 'none' | 'client_secret_post';
}

interface AccessTokenClaims {
  sub: string;
  client_id: string;
  scope: string;
  exp: number;
  iat: number;
  jti: string;
}

const authCodes = new Map<string, AuthorizationCodeRecord>();
const oauthClients = new Map<string, OAuthClientRecord>();
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const accessTokenSecret = process.env.MCP_OAUTH_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

setInterval(() => {
  const now = Date.now();
  for (const [code, record] of authCodes.entries()) {
    if (record.expiresAt < now) authCodes.delete(code);
  }
}, 60_000);

function isSupportedCodeChallengeMethod(value: string): value is 'S256' | 'plain' {
  return value === 'S256' || value === 'plain';
}

function getRegisteredClient(clientId: string | undefined): OAuthClientRecord | null {
  if (!clientId) {
    return null;
  }

  return oauthClients.get(clientId) ?? null;
}

function getAccessTokenSigningKey(): Buffer {
  return crypto.createHash('sha256').update(accessTokenSecret).digest();
}

function encodeBase64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signAccessToken(tokenBody: string): string {
  return crypto.createHmac('sha256', getAccessTokenSigningKey()).update(tokenBody).digest('base64url');
}

function buildApiKeySubject(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function issueAccessToken(apiKey: string, clientId: string): { token: string; expiresIn: number } {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    sub: buildApiKeySubject(apiKey),
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
    const parsedClaims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')) as AccessTokenClaims;
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

function buildClientMetadata(client: OAuthClientRecord) {
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret: client.clientSecret,
    client_secret_expires_at: client.clientSecret ? 0 : undefined,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    client_name: client.clientName,
  };
}

function validateRedirectUri(redirectUri: string): boolean {
  try {
    const parsed = new URL(redirectUri);
    return parsed.protocol === 'https:' || parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

function getBaseUrl(req: Request): string {
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

export function handleOAuthDiscovery(req: Request, res: Response): void {
  const baseUrl = getBaseUrl(req);
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  });
}

export function handleOAuthProtectedResourceMetadata(req: Request, res: Response): void {
  const baseUrl = getBaseUrl(req);
  res.json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp:read', 'mcp:write'],
  });
}

export function handleOAuthRegister(req: Request, res: Response): void {
  const redirectUris = Array.isArray(req.body?.redirect_uris)
    ? req.body.redirect_uris.filter((value: unknown): value is string => typeof value === 'string')
    : [];
  const clientName = typeof req.body?.client_name === 'string' ? req.body.client_name : undefined;
  const tokenEndpointAuthMethod =
    req.body?.token_endpoint_auth_method === 'client_secret_post' ? 'client_secret_post' : 'none';

  if (redirectUris.length === 0 || redirectUris.some((redirectUri: string) => !validateRedirectUri(redirectUri))) {
    res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: 'A valid https:// or localhost redirect URI is required',
    });
    return;
  }

  const clientId = `mcp_client_${crypto.randomBytes(16).toString('hex')}`;
  const clientSecret =
    tokenEndpointAuthMethod === 'client_secret_post' ? crypto.randomBytes(24).toString('hex') : undefined;

  const client: OAuthClientRecord = {
    clientId,
    clientSecret,
    redirectUris,
    clientName,
    tokenEndpointAuthMethod,
  };

  oauthClients.set(clientId, client);
  res.status(201).json(buildClientMetadata(client));
}

export function handleOAuthAuthorize(req: Request, res: Response): void {
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

  const codeChallengeMethod: 'S256' | 'plain' =
    rawCodeChallengeMethod === ''
      ? 'plain'
      : rawCodeChallengeMethod === 'plain'
        ? 'plain'
        : 'S256';

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

  const client = getRegisteredClient(clientId);
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

  if (
    codeChallenge &&
    rawCodeChallengeMethod &&
    !isSupportedCodeChallengeMethod(rawCodeChallengeMethod)
  ) {
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'Unsupported code_challenge_method',
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
        })
      );
      return;
    }

    const code = `auth_${crypto.randomBytes(32).toString('hex')}`;
    authCodes.set(code, {
      apiKey,
      clientId,
      redirectUri,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      codeChallenge: codeChallenge || undefined,
      codeChallengeMethod: codeChallenge ? codeChallengeMethod : undefined,
    });

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', code);
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
    })
  );
}

export function handleOAuthToken(req: Request, res: Response): void {
  const grantType    = typeof req.body?.grant_type    === 'string' ? req.body.grant_type    : '';
  const code         = typeof req.body?.code          === 'string' ? req.body.code          : '';
  const codeVerifier = typeof req.body?.code_verifier === 'string' ? req.body.code_verifier : '';
  const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : '';
  const clientSecret = typeof req.body?.client_secret === 'string' ? req.body.client_secret : '';
  const redirectUri = typeof req.body?.redirect_uri === 'string' ? req.body.redirect_uri : '';

  if (grantType !== 'authorization_code') {
    res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code grant type is supported',
    });
    return;
  }

  if (!code || !clientId || !redirectUri) {
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'Missing required parameters (code, client_id, redirect_uri)',
    });
    return;
  }

  const authData = authCodes.get(code);
  if (!authData) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code',
    });
    return;
  }

  if (authData.expiresAt < Date.now()) {
    authCodes.delete(code);
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Authorization code has expired',
    });
    return;
  }

  if (!authData.clientId || clientId !== authData.clientId) {
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

  const client = getRegisteredClient(authData.clientId);
  if (!client) {
    res.status(400).json({
      error: 'invalid_client',
      error_description: 'Unknown or unregistered client_id',
    });
    return;
  }

  if (client.tokenEndpointAuthMethod === 'client_secret_post' && client.clientSecret !== clientSecret) {
    res.status(401).json({
      error: 'invalid_client',
      error_description: 'Invalid client authentication',
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

    const challenge =
      authData.codeChallengeMethod === 'plain'
        ? codeVerifier
        : crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    if (challenge !== authData.codeChallenge) {
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Code verifier does not match challenge',
      });
      return;
    }
  }

  authCodes.delete(code);
  const accessToken = issueAccessToken(authData.apiKey, client.clientId);

  res.json({
    access_token: accessToken.token,
    token_type: 'Bearer',
    expires_in: accessToken.expiresIn,
    scope: 'mcp:read mcp:write',
  });
}
