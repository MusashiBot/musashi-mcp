export interface OAuthClientRecord {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  tokenEndpointAuthMethod: 'none';
  createdAt: number;
  isActive: boolean;
}

export interface AuthCodeRecord {
  clientId: string;
  subject: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  scope: string;
  expiresAt: number;
}

export interface RefreshTokenRecord {
  clientId: string;
  subject: string;
  scope: string;
  /** UUID shared across an entire rotation chain — used for family revocation. */
  familyId: string;
  expiresAt: number;
  consumedAt?: number;
  revokedAt?: number;
  /** Hash of the successor token produced during rotation. */
  replacedBy?: string;
  createdAt: number;
}

export interface OAuthStore {
  getClient(clientId: string): Promise<OAuthClientRecord | null>;
  saveClient(client: OAuthClientRecord): Promise<void>;

  getAuthCode(hash: string): Promise<AuthCodeRecord | null>;
  saveAuthCode(hash: string, record: AuthCodeRecord, ttlSeconds: number): Promise<void>;
  /** Atomically fetches and removes the auth code. Returns null if absent. */
  consumeAuthCode(hash: string): Promise<AuthCodeRecord | null>;

  getRefreshToken(hash: string): Promise<RefreshTokenRecord | null>;
  saveRefreshToken(hash: string, record: RefreshTokenRecord, ttlSeconds: number): Promise<void>;
  /**
   * Atomically marks the old token consumed and saves the new one.
   * Returns true if the rotation succeeded, false if the old token was already
   * consumed (concurrent request won the race). Callers must treat false as
   * invalid_grant — do not issue tokens.
   */
  rotateRefreshToken(
    oldHash: string,
    newHash: string,
    newRecord: RefreshTokenRecord,
    ttlSeconds: number,
  ): Promise<boolean>;
  revokeRefreshTokenFamily(familyId: string, ttlSeconds: number): Promise<void>;
  isFamilyRevoked(familyId: string): Promise<boolean>;
}

interface MemoryEntry<T> {
  record: T;
  expiresAt: number | null;
}

export class MemoryOAuthStore implements OAuthStore {
  private clients = new Map<string, OAuthClientRecord>();
  private codes = new Map<string, MemoryEntry<AuthCodeRecord>>();
  private refreshTokens = new Map<string, MemoryEntry<RefreshTokenRecord>>();
  private revokedFamilies = new Map<string, number>(); // familyId → absolute expiry ms

  private isExpired(entry: MemoryEntry<unknown>): boolean {
    return entry.expiresAt !== null && Date.now() > entry.expiresAt;
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | null> {
    return this.clients.get(clientId) ?? null;
  }

  async saveClient(client: OAuthClientRecord): Promise<void> {
    this.clients.set(client.clientId, client);
  }

  async getAuthCode(hash: string): Promise<AuthCodeRecord | null> {
    const entry = this.codes.get(hash);
    if (!entry || this.isExpired(entry)) {
      this.codes.delete(hash);
      return null;
    }
    return entry.record;
  }

  async saveAuthCode(hash: string, record: AuthCodeRecord, ttlSeconds: number): Promise<void> {
    this.codes.set(hash, { record, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async consumeAuthCode(hash: string): Promise<AuthCodeRecord | null> {
    const entry = this.codes.get(hash);
    if (!entry || this.isExpired(entry)) {
      this.codes.delete(hash);
      return null;
    }
    this.codes.delete(hash);
    return entry.record;
  }

  async getRefreshToken(hash: string): Promise<RefreshTokenRecord | null> {
    const entry = this.refreshTokens.get(hash);
    if (!entry || this.isExpired(entry)) {
      this.refreshTokens.delete(hash);
      return null;
    }
    return entry.record;
  }

  async saveRefreshToken(
    hash: string,
    record: RefreshTokenRecord,
    ttlSeconds: number,
  ): Promise<void> {
    this.refreshTokens.set(hash, { record, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async rotateRefreshToken(
    oldHash: string,
    newHash: string,
    newRecord: RefreshTokenRecord,
    ttlSeconds: number,
  ): Promise<boolean> {
    const entry = this.refreshTokens.get(oldHash);
    if (!entry || this.isExpired(entry)) return false;
    if (entry.record.consumedAt !== undefined) return false;
    const updated: RefreshTokenRecord = {
      ...entry.record,
      consumedAt: Date.now(),
      replacedBy: newHash,
    };
    this.refreshTokens.set(oldHash, { record: updated, expiresAt: entry.expiresAt });
    this.refreshTokens.set(newHash, { record: newRecord, expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  async revokeRefreshTokenFamily(familyId: string, ttlSeconds: number): Promise<void> {
    this.revokedFamilies.set(familyId, Date.now() + ttlSeconds * 1000);
  }

  async isFamilyRevoked(familyId: string): Promise<boolean> {
    const exp = this.revokedFamilies.get(familyId);
    if (exp === undefined) return false;
    if (Date.now() > exp) {
      this.revokedFamilies.delete(familyId);
      return false;
    }
    return true;
  }
}
