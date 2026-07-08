import type { Kysely } from "kysely";

import type { AllureReportStorageDatabase, Project, ProjectsTable } from "../model.js";
import type { ProjectRepository, UpsertProjectMainBranchInput } from "./api.js";

const mapRowToProject = (row: ProjectsTable): Project => ({
  mainBranch: row.main_branch,
  repo: row.repo,
});

export class KyselyProjectRepository implements ProjectRepository {
  constructor(protected readonly db: Kysely<AllureReportStorageDatabase>) {}

  async close(): Promise<void> {
    await this.db.destroy();
  }

  async findByRepo(repo: string): Promise<Project | null> {
    const row = await this.db.selectFrom("projects").selectAll().where("repo", "=", repo).executeTakeFirst();

    return row ? mapRowToProject(row) : null;
  }

  async upsertMainBranch(input: UpsertProjectMainBranchInput): Promise<Project> {
    const row = await this.db
      .insertInto("projects")
      .values({
        main_branch: input.mainBranch,
        repo: input.repo,
      })
      .onConflict((oc) =>
        oc.column("repo").doUpdateSet({
          main_branch: input.mainBranch,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapRowToProject(row);
  }

  protected async ensureSchema(): Promise<void> {
    await this.db.schema
      .createTable("projects")
      .ifNotExists()
      .addColumn("repo", "text", (column) => column.primaryKey())
      .addColumn("main_branch", "text", (column) => column.notNull())
      .execute();
  }
}
