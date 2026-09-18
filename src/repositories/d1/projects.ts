import type { Kysely } from "kysely";

import type { AllureReportStorageDatabase } from "../../model.js";
import { KyselyProjectRepository } from "../projects.js";
import { createD1Kysely, type D1ReportRepositoryOptions } from "./reports.js";

export class D1ProjectRepository extends KyselyProjectRepository {
  private constructor(db: Kysely<AllureReportStorageDatabase>) {
    super(db);
  }

  static async create(options: D1ReportRepositoryOptions): Promise<D1ProjectRepository> {
    return new D1ProjectRepository(createD1Kysely(options.database));
  }
}
