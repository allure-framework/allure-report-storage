import type { Kysely } from "kysely";

import type { AllureReportStorageDatabase, Report, ReportsTable } from "../model.js";
import type {
  CompleteReportResult,
  CreateOrUpdateDraftInput,
  CreateOrUpdateDraftResult,
  ListHistoryQuery,
  ListReportsQuery,
  ReportRepository,
} from "./api.js";

const nowIso = () => new Date().toISOString();

const toIsoString = (value: Date | string | null): string | null => {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const mapRowToReport = (row: ReportsTable): Report => ({
  id: row.id,
  repo: row.repo,
  branch: row.branch,
  name: row.name,
  status: row.status,
  createdAt: toIsoString(row.created_at)!,
  updatedAt: toIsoString(row.updated_at)!,
  completedAt: toIsoString(row.completed_at),
});

export class KyselyReportRepository implements ReportRepository {
  constructor(protected readonly db: Kysely<AllureReportStorageDatabase>) {}

  async close(): Promise<void> {
    await this.db.destroy();
  }

  async findById(reportId: string): Promise<Report | null> {
    const row = await this.db.selectFrom("reports").selectAll().where("id", "=", reportId).executeTakeFirst();

    return row ? mapRowToReport(row) : null;
  }

  async createOrUpdateDraft(input: CreateOrUpdateDraftInput): Promise<CreateOrUpdateDraftResult> {
    const now = nowIso();
    const row = await this.db
      .insertInto("reports")
      .values({
        id: input.reportId,
        repo: input.repo,
        branch: input.branch,
        name: input.name ?? null,
        status: "draft",
        created_at: now,
        updated_at: now,
        completed_at: null,
      })
      .onConflict((oc) =>
        oc
          .column("id")
          .doUpdateSet((eb) => ({
            repo: eb.ref("excluded.repo"),
            branch: eb.ref("excluded.branch"),
            name: eb.ref("excluded.name"),
            updated_at: eb.ref("excluded.updated_at"),
          }))
          .where("reports.status", "!=", "completed"),
      )
      .returningAll()
      .executeTakeFirst();

    if (row) {
      return { report: mapRowToReport(row), conflict: false };
    }

    const existing = await this.findById(input.reportId);

    if (existing?.status === "completed") {
      return { report: null, conflict: true };
    }

    throw new Error(`Failed to create or update draft report "${input.reportId}"`);
  }

  async complete(reportId: string): Promise<CompleteReportResult> {
    const now = nowIso();

    const row = await this.db
      .updateTable("reports")
      .set({
        status: "completed",
        completed_at: now,
        updated_at: now,
      })
      .where("id", "=", reportId)
      .where("status", "=", "draft")
      .returningAll()
      .executeTakeFirst();

    if (row) {
      return { report: mapRowToReport(row), notFound: false, conflict: false };
    }

    const existing = await this.findById(reportId);

    if (!existing) {
      return { report: null, notFound: true, conflict: false };
    }

    return { report: null, notFound: false, conflict: true };
  }

  async delete(reportId: string): Promise<boolean> {
    const result = await this.db.deleteFrom("reports").where("id", "=", reportId).executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }

  async listHistory(query: ListHistoryQuery): Promise<Report[]> {
    const branchRows = await this.selectCompletedBranchHistory(query.repo, query.branch, query.limit);

    if (query.branch === query.fallbackBranch) {
      return branchRows.map(mapRowToReport);
    }

    if (query.limit !== undefined && branchRows.length >= query.limit) {
      return branchRows.map(mapRowToReport);
    }

    const remaining = query.limit === undefined ? undefined : query.limit - branchRows.length;
    const oldestBranchRow = branchRows.at(-1);
    let fallbackQuery = this.db
      .selectFrom("reports")
      .selectAll()
      .where("status", "=", "completed")
      .where("repo", "=", query.repo)
      .where("branch", "=", query.fallbackBranch);

    if (oldestBranchRow?.completed_at) {
      fallbackQuery = fallbackQuery.where((eb) =>
        eb.or([
          eb("completed_at", "<", oldestBranchRow.completed_at),
          eb.and([eb("completed_at", "=", oldestBranchRow.completed_at), eb("id", "<", oldestBranchRow.id)]),
        ]),
      );
    }

    fallbackQuery = fallbackQuery.orderBy("completed_at", "desc").orderBy("id", "desc");

    if (remaining !== undefined) {
      fallbackQuery = fallbackQuery.limit(remaining);
    }

    const fallbackRows = await fallbackQuery.execute();

    return [...branchRows, ...fallbackRows].map(mapRowToReport);
  }

  async listCompleted(query: ListReportsQuery): Promise<Report[]> {
    let queryBuilder = this.db.selectFrom("reports").selectAll().where("status", "=", "completed");

    if (query.repo) {
      queryBuilder = queryBuilder.where("repo", "=", query.repo);
    }

    if (query.branch) {
      queryBuilder = queryBuilder.where("branch", "=", query.branch);
    }

    queryBuilder = queryBuilder.orderBy("completed_at", "desc").orderBy("id", "desc");

    if (query.limit !== undefined) {
      queryBuilder = queryBuilder.limit(query.limit);
    }

    const rows = await queryBuilder.execute();

    return rows.map(mapRowToReport);
  }

  async findLatestByRepoAndBranch(repo: string, branch: string): Promise<Report | null> {
    const row = await this.db
      .selectFrom("reports")
      .selectAll()
      .where("status", "=", "completed")
      .where("repo", "=", repo)
      .where("branch", "=", branch)
      .orderBy("completed_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? mapRowToReport(row) : null;
  }

  protected async ensureSchema(): Promise<void> {
    await this.db.schema
      .createTable("reports")
      .ifNotExists()
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("repo", "text", (column) => column.notNull())
      .addColumn("branch", "text", (column) => column.notNull())
      .addColumn("name", "text")
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addColumn("completed_at", "text")
      .execute();

    await this.db.schema
      .createIndex("reports_completed_repo_branch_lookup_idx")
      .ifNotExists()
      .on("reports")
      .columns(["status", "repo", "branch", "completed_at"])
      .execute();
  }

  private async selectCompletedBranchHistory(repo: string, branch: string, limit?: number): Promise<ReportsTable[]> {
    let queryBuilder = this.db
      .selectFrom("reports")
      .selectAll()
      .where("status", "=", "completed")
      .where("repo", "=", repo)
      .where("branch", "=", branch)
      .orderBy("completed_at", "desc")
      .orderBy("id", "desc");

    if (limit !== undefined) {
      queryBuilder = queryBuilder.limit(limit);
    }

    return queryBuilder.execute();
  }
}
