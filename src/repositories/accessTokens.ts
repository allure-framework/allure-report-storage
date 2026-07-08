import type { Kysely } from "kysely";

import type { AccessToken, AccessTokensTable, AllureReportStorageDatabase } from "../model.js";
import type { AccessTokenRepository, CreateAccessTokenInput } from "./api.js";

const nowIso = () => new Date().toISOString();

const toIsoString = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const mapRowToAccessToken = (row: AccessTokensTable): AccessToken => ({
  accessTokenHash: row.access_token_hash,
  createdAt: toIsoString(row.created_at),
  id: row.id,
});

export class KyselyAccessTokenRepository implements AccessTokenRepository {
  constructor(protected readonly db: Kysely<AllureReportStorageDatabase>) {}

  async close(): Promise<void> {
    await this.db.destroy();
  }

  async create(input: CreateAccessTokenInput): Promise<AccessToken> {
    const row = await this.db
      .insertInto("access_tokens")
      .values({
        access_token_hash: input.accessTokenHash,
        created_at: nowIso(),
        id: input.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapRowToAccessToken(row);
  }

  async findByAccessTokenHash(accessTokenHash: string): Promise<AccessToken | null> {
    const row = await this.db
      .selectFrom("access_tokens")
      .selectAll()
      .where("access_token_hash", "=", accessTokenHash)
      .executeTakeFirst();

    return row ? mapRowToAccessToken(row) : null;
  }

  protected async ensureSchema(): Promise<void> {
    await this.db.schema
      .createTable("access_tokens")
      .ifNotExists()
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("access_token_hash", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await this.db.schema
      .createIndex("access_tokens_hash_idx")
      .ifNotExists()
      .unique()
      .on("access_tokens")
      .column("access_token_hash")
      .execute();
  }
}
