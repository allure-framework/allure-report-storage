import type { Report, RetentionPolicy, StaticFileStore } from "../model.js";
import type { ReportRepository, Repositories } from "../repositories/api.js";

const isRetentionEnabled = (policy: RetentionPolicy): boolean =>
  policy.maxReportsPerBranch !== undefined || policy.maxReportAgeMs !== undefined;

const deleteReportAndFiles = async (
  fileStore: StaticFileStore,
  reportsRepository: ReportRepository,
  report: Report,
): Promise<boolean> => {
  const latest = await reportsRepository.findLatestByRepoAndBranch(report.repo, report.branch);

  if (!latest || latest.id === report.id) {
    return false;
  }

  const deleted = await reportsRepository.deleteRetentionCandidate(report);

  if (!deleted) {
    return false;
  }

  await Promise.all([fileStore.delete(report.id), fileStore.deleteHistory(report.id)]);

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

      console.error(`report retention cleanup failed for report "${report.id}"`, error);
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "report retention cleanup failed");
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
  if (!isRetentionEnabled(input.policy)) {
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
  policy: RetentionPolicy;
  repositories: Repositories;
}): Promise<string[]> => {
  if (!isRetentionEnabled(input.policy)) {
    return [];
  }

  const candidates = await input.repositories.reports.listRetentionCandidates({
    maxReportAgeMs: input.policy.maxReportAgeMs,
    maxReportsPerBranch: input.policy.maxReportsPerBranch,
  });
  return cleanupCandidates(input.fileStore, input.repositories.reports, candidates);
};

export const parseRetentionPolicy = (getValue: (name: string) => string | undefined): RetentionPolicy => {
  const countValue = getValue("REPORT_RETENTION_MAX_REPORTS_PER_BRANCH")?.trim();
  const ageDaysValue = getValue("REPORT_RETENTION_MAX_REPORT_AGE_DAYS")?.trim();
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

  return policy;
};
