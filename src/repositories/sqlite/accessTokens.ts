import type { Kysely } from "kysely";

import type { AllureReportStorageDatabase, SqliteReportRepositoryOptions } from "../../model.js";
import { KyselyAccessTokenRepository } from "../accessTokens.js";
import { createSqliteKysely } from "./reports.js";

export class SqliteAccessTokenRepository extends KyselyAccessTokenRepository {
  private constructor(db: Kysely<AllureReportStorageDatabase>) {
    super(db);
  }

  static async create(options: SqliteReportRepositoryOptions): Promise<SqliteAccessTokenRepository> {
    const repository = new SqliteAccessTokenRepository(createSqliteKysely(options));

    await repository.ensureSchema();

    return repository;
  }
}
