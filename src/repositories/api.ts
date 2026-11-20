import type { AccessToken, Project, Report } from "../model.js";

export interface CreateAccessTokenInput {
  accessTokenHash: string;
  id: string;
}

export interface CreateOrUpdateDraftInput {
  reportId: string;
  repo: string;
  branch: string;
  name?: string;
}

export interface ListReportsQuery {
  repo?: string;
  branch?: string;
  limit?: number;
}

export interface ListRetentionCandidatesQuery {
  repo?: string;
  branch?: string;
  maxReportsPerBranch?: number;
  maxReportAgeMs?: number;
  now?: Date;
}

export interface ListStaleBranchReportsQuery {
  mainBranch: string;
  maxBranchAgeMs: number;
  now?: Date;
  protectedBranches?: string[];
}

export interface ReportDeletionClaim {
  claimId: string;
  report: Report;
}

export interface ListHistoryQuery {
  repo: string;
  branch: string;
  fallbackBranch: string;
  limit?: number;
}

export interface LatestCompletedReport {
  branch: string;
  repo: string;
  reportId: string;
}

export interface ListLatestCompletedPageQuery {
  afterRepo?: string;
  limit: number;
}

export interface LatestCompletedReportsPage {
  nextRepo: string | null;
  reports: LatestCompletedReport[];
}

export interface UpsertProjectMainBranchInput {
  repo: string;
  mainBranch: string;
}

export type CreateOrUpdateDraftResult =
  | {
      report: Report;
      conflict: false;
    }
  | {
      report: null;
      conflict: true;
    };

export type CompleteReportResult =
  | {
      report: Report;
      notFound: false;
      conflict: false;
    }
  | {
      report: null;
      notFound: true;
      conflict: false;
    }
  | {
      report: null;
      notFound: false;
      conflict: true;
    };

export interface ReportRepository {
  findById(reportId: string): Promise<Report | null>;
  createOrUpdateDraft(input: CreateOrUpdateDraftInput): Promise<CreateOrUpdateDraftResult>;
  complete(reportId: string): Promise<CompleteReportResult>;
  delete(reportId: string): Promise<boolean>;
  claimReportDeletion(report: Report): Promise<ReportDeletionClaim | null>;
  completeReportDeletion(claim: ReportDeletionClaim): Promise<boolean>;
  markRetentionCandidateForDeletion(report: Report): Promise<Report | null>;
  markStaleBranchReportForDeletion(report: Report, query: ListStaleBranchReportsQuery): Promise<Report | null>;
  releaseReportDeletion(claim: ReportDeletionClaim): Promise<boolean>;
  listHistory(query: ListHistoryQuery): Promise<Report[]>;
  listCompleted(query: ListReportsQuery): Promise<Report[]>;
  listLatestCompletedPage(query: ListLatestCompletedPageQuery): Promise<LatestCompletedReportsPage>;
  listRetentionCandidates(query: ListRetentionCandidatesQuery): Promise<Report[]>;
  listReportsPendingDeletion(): Promise<Report[]>;
  listStaleBranchReports(query: ListStaleBranchReportsQuery): Promise<Report[]>;
  listCompletedScopes(): Promise<Array<{ branch: string; repo: string }>>;
  findLatestByRepoAndBranch(repo: string, branch: string): Promise<Report | null>;
  close(): Promise<void>;
}

export interface ProjectRepository {
  findByRepo(repo: string): Promise<Project | null>;
  upsertMainBranch(input: UpsertProjectMainBranchInput): Promise<Project>;
  close(): Promise<void>;
}

export interface AccessTokenRepository {
  create(input: CreateAccessTokenInput): Promise<AccessToken>;
  findByAccessTokenHash(accessTokenHash: string): Promise<AccessToken | null>;
  close(): Promise<void>;
}

export interface Repositories {
  accessTokens: AccessTokenRepository;
  projects: ProjectRepository;
  reports: ReportRepository;
}
