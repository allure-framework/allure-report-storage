import { sql, type Kysely } from "kysely";

import type { AllureReportStorageDatabase, Report, ReportsTable } from "../model.js";
import type {
  CompleteReportResult,
  CreateOrUpdateDraftInput,
  CreateOrUpdateDraftResult,
  LatestCompletedReportsPage,
  ListHistoryQuery,
  ListLatestCompletedPageQuery,
  ListReportsQuery,
  ListRetentionCandidatesQuery,
  ListStaleBranchReportsQuery,
  ReportDeletionClaim,
  ReportRepository,
} from "./api.js";

const nowIso = () => new Date().toISOString();

const toIsoString = (value: Date | string | null): string | null => {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const MAX_DATE_TIME = 8_640_000_000_000_000;

const toRetentionThresholdIso = (query: ListRetentionCandidatesQuery): string => {
  const threshold = (query.now ?? new Date()).getTime() - (query.maxReportAgeMs ?? 0);
  const thresholdDate = new Date(threshold);

  if (!Number.isFinite(threshold) || Math.abs(threshold) > MAX_DATE_TIME || Number.isNaN(thresholdDate.getTime())) {
    throw new Error("Retention age threshold is outside supported Date range");
  }

  return thresholdDate.toISOString();
};

const toStaleBranchThresholdIso = (query: ListStaleBranchReportsQuery): string =>
  toRetentionThresholdIso({ maxReportAgeMs: query.maxBranchAgeMs, now: query.now });

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
    const row = await this.db
      .selectFrom("reports")
      .selectAll()
      .where("id", "=", reportId)
      .where("status", "not in", ["deleting", "deleting_claimed"])
      .executeTakeFirst();

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
          .where("reports.status", "=", "draft"),
      )
      .returningAll()
      .executeTakeFirst();

    if (row) {
      return { report: mapRowToReport(row), conflict: false };
    }

    const existing = await this.findAnyById(input.reportId);

    if (
      existing?.status === "completed" ||
      existing?.status === "deleting" ||
      existing?.status === "deleting_claimed"
    ) {
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

    const existing = await this.findAnyById(reportId);

    if (!existing) {
      return { report: null, notFound: true, conflict: false };
    }

    return { report: null, notFound: false, conflict: true };
  }

  async delete(reportId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("reports")
      .where("id", "=", reportId)
      .where("status", "not in", ["deleting", "deleting_claimed"])
      .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }

  async claimReportDeletion(report: Report): Promise<ReportDeletionClaim | null> {
    const claimId = crypto.randomUUID();
    const claimedAt = nowIso();
    const claim = await this.db
      .insertInto("report_deletion_claims")
      .values({ claim_id: claimId, claimed_at: claimedAt, report_id: report.id })
      .onConflict((oc) => oc.column("report_id").doNothing())
      .returning("claim_id")
      .executeTakeFirst();

    if (!claim) {
      return null;
    }

    const row = await this.db
      .updateTable("reports")
      .set({ status: "deleting_claimed", updated_at: claimedAt })
      .where("id", "=", report.id)
      .where("status", "in", ["deleting", "deleting_claimed"])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("report_deletion_claims as deletion_claim")
            .select("deletion_claim.report_id")
            .whereRef("deletion_claim.report_id", "=", "reports.id")
            .where("deletion_claim.claim_id", "=", claimId),
        ),
      )
      .returningAll()
      .executeTakeFirst();

    if (!row) {
      await this.db
        .deleteFrom("report_deletion_claims")
        .where("report_id", "=", report.id)
        .where("claim_id", "=", claimId)
        .execute();

      return null;
    }

    return { claimId, report: mapRowToReport(row) };
  }

  async completeReportDeletion(claim: ReportDeletionClaim): Promise<boolean> {
    const result = await this.db
      .deleteFrom("reports")
      .where("id", "=", claim.report.id)
      .where("status", "=", "deleting_claimed")
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("report_deletion_claims as deletion_claim")
            .select("deletion_claim.report_id")
            .whereRef("deletion_claim.report_id", "=", "reports.id")
            .where("deletion_claim.claim_id", "=", claim.claimId),
        ),
      )
      .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }

  async markRetentionCandidateForDeletion(report: Report): Promise<Report | null> {
    if (report.completedAt === null) {
      return null;
    }

    const row = await this.db
      .updateTable("reports")
      .set({ status: "deleting", updated_at: nowIso() })
      .where("id", "=", report.id)
      .where("status", "=", "completed")
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("reports as newer_reports")
            .select("newer_reports.id")
            .whereRef("newer_reports.repo", "=", "reports.repo")
            .whereRef("newer_reports.branch", "=", "reports.branch")
            .where("newer_reports.status", "=", "completed")
            .where((innerEb) =>
              innerEb.or([
                innerEb("newer_reports.completed_at", ">", report.completedAt),
                innerEb.and([
                  innerEb("newer_reports.completed_at", "=", report.completedAt),
                  innerEb("newer_reports.id", ">", report.id),
                ]),
              ]),
            ),
        ),
      )
      .returningAll()
      .executeTakeFirst();

    return row ? mapRowToReport(row) : null;
  }

  async markStaleBranchReportForDeletion(report: Report, query: ListStaleBranchReportsQuery): Promise<Report | null> {
    if (report.completedAt === null) {
      return null;
    }

    const threshold = toStaleBranchThresholdIso(query);
    let updateQuery = this.db
      .updateTable("reports")
      .set({ status: "deleting", updated_at: nowIso() })
      .where("id", "=", report.id)
      .where("status", "=", "completed")
      .where("branch", "!=", query.mainBranch)
      .where("completed_at", "<", threshold)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("reports as recent_reports")
              .select("recent_reports.id")
              .whereRef("recent_reports.repo", "=", "reports.repo")
              .whereRef("recent_reports.branch", "=", "reports.branch")
              .where("recent_reports.status", "=", "completed")
              .where("recent_reports.completed_at", ">=", threshold),
          ),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("projects as configured_projects")
              .select("configured_projects.repo")
              .whereRef("configured_projects.repo", "=", "reports.repo")
              .whereRef("configured_projects.main_branch", "=", "reports.branch"),
          ),
        ),
      );

    if (query.protectedBranches && query.protectedBranches.length > 0) {
      updateQuery = updateQuery.where("branch", "not in", query.protectedBranches);
    }

    const row = await updateQuery.returningAll().executeTakeFirst();

    return row ? mapRowToReport(row) : null;
  }

  async releaseReportDeletion(claim: ReportDeletionClaim): Promise<boolean> {
    const row = await this.db
      .updateTable("reports")
      .set({ status: "deleting", updated_at: nowIso() })
      .where("id", "=", claim.report.id)
      .where("status", "=", "deleting_claimed")
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("report_deletion_claims as deletion_claim")
            .select("deletion_claim.report_id")
            .whereRef("deletion_claim.report_id", "=", "reports.id")
            .where("deletion_claim.claim_id", "=", claim.claimId),
        ),
      )
      .returning("id")
      .executeTakeFirst();

    if (!row) {
      return false;
    }

    await this.db
      .deleteFrom("report_deletion_claims")
      .where("report_id", "=", claim.report.id)
      .where("claim_id", "=", claim.claimId)
      .execute();

    return true;
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

  async listLatestCompletedPage(query: ListLatestCompletedPageQuery): Promise<LatestCompletedReportsPage> {
    let repositoriesQuery = this.db
      .selectFrom("reports as repository_reports")
      .select("repository_reports.repo")
      .distinct()
      .where("repository_reports.status", "=", "completed");

    if (query.afterRepo !== undefined) {
      repositoriesQuery = repositoriesQuery.where("repository_reports.repo", ">", query.afterRepo);
    }

    const repositoryRows = await repositoriesQuery
      .orderBy("repository_reports.repo")
      .limit(query.limit + 1)
      .execute();
    const hasNextPage = repositoryRows.length > query.limit;
    const repositories = repositoryRows.slice(0, query.limit).map((row) => row.repo);

    if (repositories.length === 0) {
      return { nextRepo: null, reports: [] };
    }

    const rankedReports = this.db
      .selectFrom("reports")
      .select(["id", "repo", "branch"])
      .select(
        sql<number>`row_number() over (partition by repo, branch order by completed_at desc, id desc)`.as(
          "latest_rank",
        ),
      )
      .where("status", "=", "completed")
      .where("repo", "in", repositoriesQuery.orderBy("repository_reports.repo").limit(query.limit));
    const rows = await this.db
      .selectFrom(rankedReports.as("ranked_reports"))
      .select(["id", "repo", "branch"])
      .where("latest_rank", "=", 1)
      .orderBy("repo")
      .orderBy("branch")
      .execute();

    return {
      nextRepo: hasNextPage ? repositories.at(-1)! : null,
      reports: rows.map((row) => ({ branch: row.branch, repo: row.repo, reportId: row.id })),
    };
  }

  async listRetentionCandidates(query: ListRetentionCandidatesQuery): Promise<Report[]> {
    if (query.maxReportsPerBranch === undefined && query.maxReportAgeMs === undefined) {
      return [];
    }

    let rankedReports = this.db
      .selectFrom("reports")
      .selectAll()
      .select(
        sql<number>`row_number() over (partition by repo, branch order by completed_at desc, id desc)`.as(
          "retention_rank",
        ),
      )
      .where("status", "=", "completed");

    if (query.repo) {
      rankedReports = rankedReports.where("repo", "=", query.repo);
    }

    if (query.branch) {
      rankedReports = rankedReports.where("branch", "=", query.branch);
    }

    const ageThreshold = query.maxReportAgeMs === undefined ? undefined : toRetentionThresholdIso(query);
    const rows = await this.db
      .selectFrom(rankedReports.as("ranked_reports"))
      .select(["id", "repo", "branch", "name", "status", "created_at", "updated_at", "completed_at"])
      .where("retention_rank", ">", 1)
      .where((eb) => {
        const predicates = [];

        if (query.maxReportsPerBranch !== undefined) {
          predicates.push(eb("retention_rank", ">", Math.max(query.maxReportsPerBranch, 1)));
        }

        if (ageThreshold !== undefined) {
          predicates.push(eb("completed_at", "<", ageThreshold));
        }

        return eb.or(predicates);
      })
      .orderBy("repo")
      .orderBy("branch")
      .orderBy("completed_at", "desc")
      .orderBy("id", "desc")
      .execute();

    return rows.map(mapRowToReport);
  }

  async listReportsPendingDeletion(): Promise<Report[]> {
    const rows = await this.db
      .selectFrom("reports")
      .selectAll()
      .where("status", "in", ["deleting", "deleting_claimed"])
      .orderBy("updated_at")
      .orderBy("id")
      .execute();

    return rows.map(mapRowToReport);
  }

  async listStaleBranchReports(query: ListStaleBranchReportsQuery): Promise<Report[]> {
    const threshold = toStaleBranchThresholdIso(query);
    const reportsWithLatestCompletion = this.db
      .selectFrom("reports")
      .selectAll()
      .select(sql<string>`max(completed_at) over (partition by repo, branch)`.as("retention_latest_completed_at"))
      .where("status", "=", "completed");

    let staleReports = this.db
      .selectFrom(reportsWithLatestCompletion.as("stale_reports"))
      .select(["id", "repo", "branch", "name", "status", "created_at", "updated_at", "completed_at"])
      .where("branch", "!=", query.mainBranch)
      .where("retention_latest_completed_at", "<", threshold)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("projects as configured_projects")
              .select("configured_projects.repo")
              .whereRef("configured_projects.repo", "=", "stale_reports.repo")
              .whereRef("configured_projects.main_branch", "=", "stale_reports.branch"),
          ),
        ),
      );

    if (query.protectedBranches && query.protectedBranches.length > 0) {
      staleReports = staleReports.where("branch", "not in", query.protectedBranches);
    }

    const rows = await staleReports.orderBy("repo").orderBy("branch").orderBy("completed_at").orderBy("id").execute();

    return rows.map(mapRowToReport);
  }

  async listCompletedScopes(): Promise<Array<{ branch: string; repo: string }>> {
    return this.db
      .selectFrom("reports")
      .select(["repo", "branch"])
      .distinct()
      .where("status", "=", "completed")
      .execute();
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
      .createTable("projects")
      .ifNotExists()
      .addColumn("repo", "text", (column) => column.primaryKey())
      .addColumn("main_branch", "text", (column) => column.notNull())
      .execute();

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
      .createTable("report_deletion_claims")
      .ifNotExists()
      .addColumn("report_id", "text", (column) => column.primaryKey())
      .addColumn("claim_id", "text", (column) => column.notNull())
      .addColumn("claimed_at", "text", (column) => column.notNull())
      .execute();

    await sql`
      create trigger if not exists reports_delete_cleanup_claim
      after delete on reports
      begin
        delete from report_deletion_claims where report_id = old.id;
      end
    `.execute(this.db);

    await this.db.schema
      .createIndex("reports_completed_repo_branch_lookup_idx")
      .ifNotExists()
      .on("reports")
      .columns(["status", "repo", "branch", "completed_at"])
      .execute();

    await this.db.schema
      .createIndex("reports_completed_repo_branch_id_lookup_idx")
      .ifNotExists()
      .on("reports")
      .columns(["status", "repo", "branch", "completed_at", "id"])
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

  private async findAnyById(reportId: string): Promise<Report | null> {
    const row = await this.db.selectFrom("reports").selectAll().where("id", "=", reportId).executeTakeFirst();

    return row ? mapRowToReport(row) : null;
  }
}
