import type { Request, Response } from 'express';
import crypto from 'crypto';
import { verifyApiKey } from '../transports/auth.js';

interface AuthorizationCodeRecord {
  apiKey: string;
  expiresAt: number;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain'; // Added to support PKCE code challenge method, defaulting to 'plain' if not provided
}

const authCodes = new Map<string, AuthorizationCodeRecord>();
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();

  for (const [code, record] of authCodes.entries()) {
    if (record.expiresAt < now) {
      authCodes.delete(code);
    }
  }
}, 60_000);

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
  redirectUri: string;
  state: string;
  codeChallenge?: string;
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
    <input type="hidden" name="redirect_uri" value="${escapeHtml(options.redirectUri)}" />
    <input type="hidden" name="state" value="${escapeHtml(options.state)}" />
    <input type="hidden" name="code_challenge" value="${escapeHtml(options.codeChallenge || '')}" />
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
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none'],
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

export function handleOAuthAuthorize(req: Request, res: Response): void {
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
  const codeChallengeMethod = 
    (req.query.code_challenge_method as string) || 
    (req.body?.code_challenge_method as string) || 
    'plain'; // Default to 'plain' per OAuth2 specs if not provided

  if (!redirectUri || !state) {
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'Missing required parameters',
    });
    return;
  }

  if (req.method === 'POST') {
    const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key : '';

    if (!apiKey || !verifyApiKey(apiKey)) {
      res.status(401).send(
        renderAuthorizeForm({
          redirectUri,
          state,
          codeChallenge,
          error: 'Invalid API key. Please try again.',
        })
      );
      return;
    }

    const code = `auth_${crypto.randomBytes(32).toString('hex')}`;
    authCodes.set(code, {
      apiKey,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      codeChallenge: codeChallenge || undefined,
      codeChallengeMethod: codeChallenge ? (codeChallengeMethod as 'S256' | 'plain') : undefined, 
    });

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', code);
    redirectUrl.searchParams.set('state', state);

    res.redirect(redirectUrl.toString());
    return;
  }

  res.send(
    renderAuthorizeForm({
      redirectUri,
      state,
      codeChallenge,
    })
  );
}

export function handleOAuthToken(req: Request, res: Response): void {
  const grantType = typeof req.body?.grant_type === 'string' ? req.body.grant_type : '';
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  const codeVerifier = typeof req.body?.code_verifier === 'string' ? req.body.code_verifier : '';

  if (grantType !== 'authorization_code') {
    res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code grant type is supported',
    });
    return;
  }

  if (!code) {
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'Missing authorization code',
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

  // If a challenge exists, missing code_verifier is rejected 
  if (authData.codeChallenge) {
    if (!codeVerifier) { //If missing 
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'code_verifier is required when code_challenge is present',
      });
      return;
    }

    let isValid = false;

    if (authData.codeChallengeMethod === 'S256') {
      // S256: Hash the verifier and compare
      const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      isValid = challenge === authData.codeChallenge;
    } else {
      // plain: Direct string comparison
      isValid = codeVerifier === authData.codeChallenge;
    }

    if (!isValid) { //If not matching
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Code verifier does not match challenge',
      });
      return;
    }
  }

  authCodes.delete(code);

  res.json({
    access_token: authData.apiKey,
    token_type: 'Bearer',
    expires_in: 31_536_000,
    scope: 'mcp:read mcp:write',
  });
}
