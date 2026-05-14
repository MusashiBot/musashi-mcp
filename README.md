# musashi-mcp

`musashi-mcp` exposes Musashi market intelligence as MCP tools for clients such as Claude and ChatGPT.

It connects to `musashi-api` and makes these capabilities available over MCP:

- `analyze_text`
- `get_arbitrage`
- `get_movers`
- `ground_probability`
- `get_feed`
- `get_feed_stats`
- `get_feed_accounts`
- `get_wallet_activity`
- `get_wallet_positions`
- `get_market_wallet_flow`
- `get_smart_money_markets`
- `get_market_brief`
- `explain_market_move`
- `get_health`

Wallet and market context tool status:

- `get_wallet_activity`, `get_wallet_positions`, `get_market_wallet_flow`, and `get_smart_money_markets` are backed by `musashi-api` endpoints.
- `get_market_brief` and `explain_market_move` compose existing `musashi-api` primitives without direct market-source calls.

## Quick start

### Hosted server

Production MCP endpoint:

```text
https://musashi-production.up.railway.app/mcp
```

OAuth discovery endpoint:

```text
https://musashi-production.up.railway.app/.well-known/oauth-authorization-server
```

OAuth dynamic client registration endpoint:

```text
https://musashi-production.up.railway.app/oauth/register
```

To authorize access, the server expects a valid `mcp_sk_...` key from `MCP_API_KEYS` or `MUSASHI_MCP_API_KEY`.

## Connect from Claude

If your Claude account supports custom MCP connectors:

1. Open Claude MCP or connector settings.
2. Add a custom MCP server.
3. Use this server URL:

```text
https://musashi-production.up.railway.app/mcp
```

4. Choose `OAuth` if prompted.
5. Complete the Musashi authorization form with a valid `mcp_sk_...` key.

## Connect from ChatGPT

If ChatGPT Apps or Developer Mode is enabled for your account:

1. Open `Settings` -> `Apps`.
2. Create a new custom app.
3. Set `MCP Server URL` to:

```text
https://musashi-production.up.railway.app/mcp
```

4. Leave authentication as `OAuth`.
5. If ChatGPT uses automatic registration, continue with the discovered OAuth settings.
6. If ChatGPT asks for manual client credentials, use a client created via the registration endpoint above.
7. Complete the Musashi authorization form with a valid `mcp_sk_...` key.

If the connection succeeds, ChatGPT should be able to discover and call Musashi tools from chat.

## Example prompts

Once the app is connected, these are good smoke tests:

- `Use the Musashi app to get health status.`
- `Use the Musashi app to get feed statistics.`
- `Use the Musashi app to list tracked feed accounts.`
- `Use the Musashi app to show market movers with a minimum change of 0.03.`
- `Use the Musashi app to analyze this text: Bitcoin will be above 150k by the end of 2026.`
- `Use the Musashi app to show wallet activity for 0x...`
- `Use the Musashi app to show open positions for 0x...`
- `Use the Musashi app to explain wallet flow for this market: ...`
- `Use the Musashi app to find smart money markets in crypto.`
- `Use the Musashi app to get a market brief for BTC 100k.`
- `Use the Musashi app to explain why this market moved: BTC 100k.`

## Local development

### Requirements

- Node.js `>=18`
- `pnpm`
- a reachable `musashi-api` instance

Install dependencies:

```bash
pnpm install
```

### Available scripts

- `pnpm build`: compile the server to `dist/`
- `pnpm dev`: run stdio transport locally
- `pnpm dev:http`: run the streamable HTTP transport locally
- `pnpm test`: build the server and run local smoke tests
- `pnpm start`: run the compiled stdio server from `dist/`
- `pnpm start:http`: run the compiled HTTP server from `dist/`
- `pnpm watch`: run TypeScript in watch mode
- `pnpm clean`: remove `dist/`

### Environment variables

- `MUSASHI_API_BASE_URL`: Musashi API base URL
- `PORT`: HTTP port when running with `--transport=http`
- `MUSASHI_MCP_PUBLIC_BASE_URL`: optional public MCP server base URL for OAuth metadata
- `MUSASHI_MCP_API_KEY`: optional single valid MCP API key
- `MCP_API_KEYS`: optional comma-separated list of valid MCP API keys
- `MCP_OAUTH_TOKEN_SECRET`: **required in production** — secret for signing OAuth access tokens; without it, a random secret is generated at startup and all tokens are invalidated on every server restart
- `UPSTASH_REDIS_REST_URL`: **required in production** — Upstash Redis REST URL for shared OAuth state
- `UPSTASH_REDIS_REST_TOKEN`: **required in production** — Upstash Redis REST token
- `MCP_RATE_LIMIT_PER_MINUTE`: message rate limit per authenticated principal (default: 60)
- `MCP_RATE_LIMIT_PER_HOUR`: hourly backstop per authenticated principal (default: 1000)

**Production requirements** (HTTP transport, Railway or `NODE_ENV=production`):

`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and `MCP_OAUTH_TOKEN_SECRET` must all be set or the server exits with code 1 at startup. Without shared KV, registered OAuth clients and auth codes are process-local and lost on every restart, breaking GPT/Claude reconnects.

**Token lifecycle:**

- Access tokens expire after 1 hour.
- Refresh tokens expire after 30 days. When a refresh token is used, it is rotated — the old token is consumed and a new token is issued. If a consumed token is replayed, the entire token family is revoked and the user must re-authenticate.
- When the refresh token expires, the user must complete the OAuth flow again.

Example local values:

```bash
MUSASHI_API_BASE_URL=http://127.0.0.1:3000
PORT=3030
MUSASHI_MCP_PUBLIC_BASE_URL=https://your-mcp-server.example.com
MUSASHI_MCP_API_KEY=mcp_sk_your_key_here
```

For local wallet tools, `MUSASHI_API_BASE_URL` must point at a `musashi-api` server that has `/api/wallet/activity` and `/api/wallet/positions` available.

### Run over stdio

```bash
MUSASHI_API_BASE_URL=http://127.0.0.1:3000 pnpm dev
```

Use this when your MCP client launches the server process directly.

### Run over HTTP

```bash
MUSASHI_API_BASE_URL=http://127.0.0.1:3000 PORT=3030 pnpm dev:http
```

Useful local endpoints:

- `GET /health`
- `GET /.well-known/oauth-authorization-server`
- `GET /oauth/authorize`
- `POST /oauth/authorize`
- `POST /oauth/token`
- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`

## Basic checks

Build:

```bash
pnpm build
```

Smoke tests:

```bash
pnpm test
```

Manual health check:

```bash
curl http://127.0.0.1:3030/health
```

Manual OAuth discovery check:

```bash
curl http://127.0.0.1:3030/.well-known/oauth-authorization-server
```

Manual OAuth verification:

```bash
BASE=http://127.0.0.1:3030

# 1. Register a public client
CLIENT_JSON=$(curl -s -X POST "${BASE}/oauth/register" \
  -H 'Content-Type: application/json' \
  -d '{"redirect_uris":["http://127.0.0.1/callback"]}')
CLIENT_ID=$(node -e "console.log(JSON.parse(process.argv[1]).client_id)" -- "${CLIENT_JSON}")

# 2. Generate a PKCE S256 verifier and challenge
VERIFIER=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
CHALLENGE=$(node -e \
  "const c=require('crypto');process.stdout.write(c.createHash('sha256').update(process.argv[1]).digest('base64url'))" \
  -- "${VERIFIER}")

# 3. Open the authorization URL in a browser and submit a valid mcp_sk_... key
# code_challenge_method is S256 by default and may be omitted
echo "${BASE}/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=http://127.0.0.1/callback&state=test-state&code_challenge=${CHALLENGE}"

# 4. After submitting the key, the browser redirects to:
#    http://127.0.0.1/callback?code=AUTH_CODE&state=test-state
#    Copy the code value from the URL, then run:
read -rp "Paste auth code: " AUTH_CODE
curl -s -X POST "${BASE}/oauth/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=authorization_code&code=${AUTH_CODE}&client_id=${CLIENT_ID}&redirect_uri=http://127.0.0.1/callback&code_verifier=${VERIFIER}"
```

## Notes

- **Breaking release**: this version invalidates all existing OAuth sessions and registered connector state. GPT/Claude users must reconnect once after deployment. There is no migration path.
- OAuth PKCE: only `S256` is supported. All clients are public (`token_endpoint_auth_method: none`) and **must** provide `code_challenge`; omitting it returns a `400 invalid_request`. `code_challenge_method` may be omitted (defaults to S256) or set to `S256` explicitly; any other value is rejected. `client_secret_post` is not supported.
- Production requires shared KV (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`). Without it, registered OAuth clients and auth codes are per-process and lost on every restart. The in-memory store is for local development only.
- Set `MCP_OAUTH_TOKEN_SECRET` to a stable value in production. Without it, all OAuth tokens are invalidated on every server restart.
- Session continuity: once the KV store is configured and the server is deployed, connector registrations and sessions survive service restarts. Users only need to reconnect once when first deploying this version.
- `pnpm test` is a smoke suite, not a full MCP interoperability suite.
- Behavior depends on a healthy and reachable `musashi-api`.
