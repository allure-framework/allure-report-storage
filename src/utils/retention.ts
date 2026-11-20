import type { Report, RetentionPolicy, StaticFileStore } from "../model.js";
import type { ListStaleBranchReportsQuery, ReportRepository, Repositories } from "../repositories/api.js";
import { createErrorLog } from "./error.js";

const isReportRetentionEnabled = (policy: RetentionPolicy): boolean =>
  policy.maxReportsPerBranch !== undefined || policy.maxReportAgeMs !== undefined;

const isRetentionSweepEnabled = (policy: RetentionPolicy): boolean =>
  isReportRetentionEnabled(policy) || policy.staleBranchAgeMs !== undefined;

const deleteReportFilesAndRow = async (
  fileStore: StaticFileStore,
  reportsRepository: ReportRepository,
  report: Report,
): Promise<void> => {
  await Promise.all([fileStore.delete(report.id), fileStore.deleteHistory(report.id)]);
  await reportsRepository.delete(report.id);
};

const deleteReportAndFiles = async (
  fileStore: StaticFileStore,
  reportsRepository: ReportRepository,
  report: Report,
): Promise<boolean> => {
  const latest = await reportsRepository.findLatestByRepoAndBranch(report.repo, report.branch);

  if (!latest || latest.id === report.id) {
    return false;
  }

  const marked = await reportsRepository.markRetentionCandidateForDeletion(report);

  if (!marked) {
    return false;
  }

  await deleteReportFilesAndRow(fileStore, reportsRepository, report);

  return true;
};

const cleanupCandidates = async (
  fileStore: StaticFileStore,
  reportsRepository: ReportRepository,
  candidates: Report[],
): Promise<string[]> => {
  const deletedIds: string[] = [];
  const failures: Error[] = [];

  for (const report of candidates) {
    try {
      if (await deleteReportAndFiles(fileStore, reportsRepository, report)) {
        deletedIds.push(report.id);
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));

      console.error(createErrorLog(`report retention cleanup failed for report "${report.id}"`, error));
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "report retention cleanup failed");
  }

  return deletedIds;
};

const cleanupStaleBranchCandidates = async (
  fileStore: StaticFileStore,
  reportsRepository: ReportRepository,
  candidates: Report[],
  query: ListStaleBranchReportsQuery,
): Promise<string[]> => {
  const deletedIds: string[] = [];
  const failures: Error[] = [];

  for (const report of candidates) {
    try {
      const marked = await reportsRepository.markStaleBranchReportForDeletion(report, query);

      if (marked) {
        await deleteReportFilesAndRow(fileStore, reportsRepository, report);
        deletedIds.push(report.id);
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));

      console.error(createErrorLog(`stale branch retention cleanup failed for report "${report.id}"`, error));
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "stale branch retention cleanup failed");
  }

  return deletedIds;
};

const cleanupReportsPendingDeletion = async (
  fileStore: StaticFileStore,
  reportsRepository: ReportRepository,
  reports: Report[],
): Promise<string[]> => {
  const deletedIds: string[] = [];
  const failures: Error[] = [];

  for (const report of reports) {
    try {
      await deleteReportFilesAndRow(fileStore, reportsRepository, report);
      deletedIds.push(report.id);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));

      console.error(createErrorLog(`pending report cleanup failed for report "${report.id}"`, error));
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "pending report cleanup failed");
  }

  return deletedIds;
};

export const cleanupReportRetentionScope = async (input: {
  branch: string;
  fileStore: StaticFileStore;
  policy: RetentionPolicy;
  repo: string;
  reportsRepository: ReportRepository;
  now?: Date;
}): Promise<string[]> => {
  if (!isReportRetentionEnabled(input.policy)) {
    return [];
  }

  const candidates = await input.reportsRepository.listRetentionCandidates({
    branch: input.branch,
    maxReportAgeMs: input.policy.maxReportAgeMs,
    maxReportsPerBranch: input.policy.maxReportsPerBranch,
    now: input.now,
    repo: input.repo,
  });
  return cleanupCandidates(input.fileStore, input.reportsRepository, candidates);
};

export const cleanupReportRetention = async (input: {
  fileStore: StaticFileStore;
  mainBranch?: string;
  now?: Date;
  policy: RetentionPolicy;
  repositories: Repositories;
}): Promise<string[]> => {
  if (!isRetentionSweepEnabled(input.policy)) {
    return [];
  }

  const candidates = await input.repositories.reports.listRetentionCandidates({
    maxReportAgeMs: input.policy.maxReportAgeMs,
    maxReportsPerBranch: input.policy.maxReportsPerBranch,
    now: input.now,
  });
  const deletedIds = await cleanupCandidates(input.fileStore, input.repositories.reports, candidates);

  let staleDeletedIds: string[] = [];

  if (input.policy.staleBranchAgeMs !== undefined) {
    const staleBranchQuery = {
      mainBranch: input.mainBranch ?? "main",
      maxBranchAgeMs: input.policy.staleBranchAgeMs,
      now: input.now,
      protectedBranches: [...new Set(input.policy.protectedBranches ?? [])],
    };
    const staleCandidates = await input.repositories.reports.listStaleBranchReports(staleBranchQuery);

    staleDeletedIds = await cleanupStaleBranchCandidates(
      input.fileStore,
      input.repositories.reports,
      staleCandidates,
      staleBranchQuery,
    );
  }

  const reportsPendingDeletion = await input.repositories.reports.listReportsPendingDeletion();
  const retriedDeletedIds = await cleanupReportsPendingDeletion(
    input.fileStore,
    input.repositories.reports,
    reportsPendingDeletion,
  );

  return [...deletedIds, ...staleDeletedIds, ...retriedDeletedIds];
};

export const parseRetentionPolicy = (getValue: (name: string) => string | undefined): RetentionPolicy => {
  const countValue = getValue("REPORT_RETENTION_MAX_REPORTS_PER_BRANCH")?.trim();
  const ageDaysValue = getValue("REPORT_RETENTION_MAX_REPORT_AGE_DAYS")?.trim();
  const staleBranchDaysValue = getValue("REPORT_RETENTION_STALE_BRANCH_DAYS")?.trim();
  const protectedBranchesValue = getValue("REPORT_RETENTION_PROTECTED_BRANCHES")?.trim();
  const policy: RetentionPolicy = {};

  if (countValue) {
    const value = Number(countValue);

    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("REPORT_RETENTION_MAX_REPORTS_PER_BRANCH must be a positive integer");
    }

    policy.maxReportsPerBranch = value;
  }

  if (ageDaysValue) {
    const value = Number(ageDaysValue);

    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("REPORT_RETENTION_MAX_REPORT_AGE_DAYS must be a positive number");
    }

    const maxReportAgeMs = value * 24 * 60 * 60 * 1000;

    if (!Number.isFinite(maxReportAgeMs) || Math.abs(maxReportAgeMs) > 8_640_000_000_000_000) {
      throw new Error("REPORT_RETENTION_MAX_REPORT_AGE_DAYS must fit in supported Date range");
    }

    policy.maxReportAgeMs = maxReportAgeMs;
  }

  if (staleBranchDaysValue) {
    const value = Number(staleBranchDaysValue);

    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("REPORT_RETENTION_STALE_BRANCH_DAYS must be a positive number");
    }

    const staleBranchAgeMs = value * 24 * 60 * 60 * 1000;

    if (!Number.isFinite(staleBranchAgeMs) || Math.abs(staleBranchAgeMs) > 8_640_000_000_000_000) {
      throw new Error("REPORT_RETENTION_STALE_BRANCH_DAYS must fit in supported Date range");
    }

    policy.staleBranchAgeMs = staleBranchAgeMs;
  }

  if (protectedBranchesValue) {
    policy.protectedBranches = [
      ...new Set(
        protectedBranchesValue
          .split(",")
          .map((branch) => branch.trim())
          .filter(Boolean),
      ),
    ];
  }

  return policy;
};
