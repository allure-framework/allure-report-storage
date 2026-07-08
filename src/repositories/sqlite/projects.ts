import type { Kysely } from "kysely";

import type { AllureReportStorageDatabase, SqliteReportRepositoryOptions } from "../../model.js";
import { KyselyProjectRepository } from "../projects.js";
import { createSqliteKysely } from "./reports.js";

export class SqliteProjectRepository extends KyselyProjectRepository {
  private constructor(db: Kysely<AllureReportStorageDatabase>) {
    super(db);
  }

  static async create(options: SqliteReportRepositoryOptions): Promise<SqliteProjectRepository> {
    const repository = new SqliteProjectRepository(createSqliteKysely(options));

    await repository.ensureSchema();

    return repository;
  }
}
