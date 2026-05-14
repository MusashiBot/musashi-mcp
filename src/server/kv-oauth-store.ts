import { Redis } from '@upstash/redis';
import type {
  AuthCodeRecord,
  OAuthClientRecord,
  OAuthStore,
  RefreshTokenRecord,
} from './oauth-store.js';

const CLIENT_PREFIX = 'oauth:client:';
const CODE_PREFIX = 'oauth:code:';
const REFRESH_PREFIX = 'oauth:refresh:';
const FAMILY_PREFIX = 'oauth:family:';

/**
 * Production OAuth store backed by Upstash Redis (HTTP client, multi-instance safe).
 *
 * Key structure:
 *   oauth:client:{clientId}      — OAuthClientRecord JSON, no TTL
 *   oauth:code:{hash}            — AuthCodeRecord JSON, 300s TTL
 *   oauth:refresh:{hash}         — RefreshTokenRecord JSON, 2592000s TTL
 *   oauth:family:{familyId}      — "revoked" string, 2592000s TTL
 *
 * Auth codes are consumed atomically via GETDEL.
 *
 * Refresh token rotation uses a Lua script executed atomically on the Redis server.
 * The script reads the old token, checks consumedAt, and only writes if not yet
 * consumed — eliminating the concurrent double-rotation window that a pipeline
 * (two-command, non-transactional) would leave open.
 */

// Lua script: atomically check-and-rotate a refresh token.
// KEYS[1] = old token key, KEYS[2] = new token key
// ARGV[1] = consumed old token JSON, ARGV[2] = old TTL seconds,
// ARGV[3] = new token JSON, ARGV[4] = new TTL seconds
// Returns 1 on success, 0 if already consumed, redis error if key missing.
const ROTATE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return redis.error_reply('NOT_FOUND') end
local ok, data = pcall(cjson.decode, current)
if not ok then return redis.error_reply('DECODE_ERROR') end
if data.consumedAt ~= nil then return 0 end
local oldTtl = tonumber(ARGV[2])
if oldTtl > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', oldTtl)
else
  redis.call('SET', KEYS[1], ARGV[1], 'EX', 300)
end
redis.call('SET', KEYS[2], ARGV[3], 'EX', tonumber(ARGV[4]))
return 1
`.trim();

export class KvOAuthStore implements OAuthStore {
  private redis: Redis;

  constructor(url: string, token: string);
  constructor(redis: Redis);
  constructor(urlOrRedis: string | Redis, token?: string) {
    if (typeof urlOrRedis === 'string') {
      this.redis = new Redis({ url: urlOrRedis, token: token! });
    } else {
      this.redis = urlOrRedis;
    }
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | null> {
    const raw = await this.redis.get<OAuthClientRecord>(CLIENT_PREFIX + clientId);
    return raw ?? null;
  }

  async saveClient(client: OAuthClientRecord): Promise<void> {
    await this.redis.set(CLIENT_PREFIX + client.clientId, JSON.stringify(client));
  }

  async getAuthCode(hash: string): Promise<AuthCodeRecord | null> {
    const raw = await this.redis.get<AuthCodeRecord>(CODE_PREFIX + hash);
    return raw ?? null;
  }

  async saveAuthCode(hash: string, record: AuthCodeRecord, ttlSeconds: number): Promise<void> {
    await this.redis.set(CODE_PREFIX + hash, JSON.stringify(record), { ex: ttlSeconds });
  }

  async consumeAuthCode(hash: string): Promise<AuthCodeRecord | null> {
    const raw = await this.redis.getdel<AuthCodeRecord>(CODE_PREFIX + hash);
    return raw ?? null;
  }

  async getRefreshToken(hash: string): Promise<RefreshTokenRecord | null> {
    const raw = await this.redis.get<RefreshTokenRecord>(REFRESH_PREFIX + hash);
    return raw ?? null;
  }

  async saveRefreshToken(
    hash: string,
    record: RefreshTokenRecord,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.set(REFRESH_PREFIX + hash, JSON.stringify(record), { ex: ttlSeconds });
  }

  async rotateRefreshToken(
    oldHash: string,
    newHash: string,
    newRecord: RefreshTokenRecord,
    ttlSeconds: number,
  ): Promise<boolean> {
    const existing = await this.redis.get<RefreshTokenRecord>(REFRESH_PREFIX + oldHash);
    if (!existing) return false;

    const oldTtl = await this.redis.ttl(REFRESH_PREFIX + oldHash);
    const updatedOld: RefreshTokenRecord = {
      ...existing,
      consumedAt: Date.now(),
      replacedBy: newHash,
    };

    const result = await this.redis.eval(
      ROTATE_SCRIPT,
      [REFRESH_PREFIX + oldHash, REFRESH_PREFIX + newHash],
      [
        JSON.stringify(updatedOld),
        String(oldTtl),
        JSON.stringify(newRecord),
        String(ttlSeconds),
      ],
    );

    // Lua returns 1 on success, 0 if already consumed
    return result === 1;
  }

  async revokeRefreshTokenFamily(familyId: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(FAMILY_PREFIX + familyId, 'revoked', { ex: ttlSeconds });
  }

  async isFamilyRevoked(familyId: string): Promise<boolean> {
    const val = await this.redis.get(FAMILY_PREFIX + familyId);
    return val === 'revoked';
  }
}
