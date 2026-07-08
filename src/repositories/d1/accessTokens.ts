import type { Kysely } from "kysely";

import type { AllureReportStorageDatabase } from "../../model.js";
import { KyselyAccessTokenRepository } from "../accessTokens.js";
import { createD1Kysely, type D1ReportRepositoryOptions } from "./reports.js";

export class D1AccessTokenRepository extends KyselyAccessTokenRepository {
  private constructor(db: Kysely<AllureReportStorageDatabase>) {
    super(db);
  }

  static async create(options: D1ReportRepositoryOptions): Promise<D1AccessTokenRepository> {
    const repository = new D1AccessTokenRepository(createD1Kysely(options.database));

    await repository.ensureSchema();

    return repository;
  }
}
