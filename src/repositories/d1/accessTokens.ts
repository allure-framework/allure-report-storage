import type { Kysely } from "kysely";

import type { AccessToken, AllureReportStorageDatabase } from "../../model.js";
import { KyselyAccessTokenRepository } from "../accessTokens.js";
import type { CreateAccessTokenInput } from "../api.js";
import { createD1Kysely, type D1ReportRepositoryOptions } from "./reports.js";

// A short positive cache removes one D1 read per uploaded file while keeping external token revocation bounded.
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 1_024;

interface CachedAccessToken {
  expiresAt: number;
  value: AccessToken;
}

interface AccessTokenCache {
  lookups: Map<string, Promise<AccessToken | null>>;
  values: Map<string, CachedAccessToken>;
}

const caches = new WeakMap<D1Database, AccessTokenCache>();

const getCache = (database: D1Database): AccessTokenCache => {
  const existing = caches.get(database);

  if (existing) {
    return existing;
  }

  const cache: AccessTokenCache = {
    lookups: new Map(),
    values: new Map(),
  };

  caches.set(database, cache);

  return cache;
};

const cacheAccessToken = (cache: AccessTokenCache, accessToken: AccessToken): void => {
  while (cache.values.size >= MAX_CACHE_ENTRIES) {
    const oldestHash = cache.values.keys().next().value;

    if (oldestHash === undefined) {
      break;
    }

    cache.values.delete(oldestHash);
  }

  cache.values.set(accessToken.accessTokenHash, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value: accessToken,
  });
};

export class D1AccessTokenRepository extends KyselyAccessTokenRepository {
  private constructor(
    db: Kysely<AllureReportStorageDatabase>,
    private readonly cache: AccessTokenCache,
  ) {
    super(db);
  }

  static async create(options: D1ReportRepositoryOptions): Promise<D1AccessTokenRepository> {
    return new D1AccessTokenRepository(createD1Kysely(options.database), getCache(options.database));
  }

  override async create(input: CreateAccessTokenInput): Promise<AccessToken> {
    const accessToken = await super.create(input);

    cacheAccessToken(this.cache, accessToken);

    return accessToken;
  }

  override async findByAccessTokenHash(accessTokenHash: string): Promise<AccessToken | null> {
    const cached = this.cache.values.get(accessTokenHash);

    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.value;
      }

      this.cache.values.delete(accessTokenHash);
    }

    const activeLookup = this.cache.lookups.get(accessTokenHash);

    if (activeLookup) {
      return activeLookup;
    }

    const lookup = super.findByAccessTokenHash(accessTokenHash);

    this.cache.lookups.set(accessTokenHash, lookup);

    try {
      const accessToken = await lookup;

      if (accessToken) {
        cacheAccessToken(this.cache, accessToken);
      }

      return accessToken;
    } finally {
      if (this.cache.lookups.get(accessTokenHash) === lookup) {
        this.cache.lookups.delete(accessTokenHash);
      }
    }
  }
}
