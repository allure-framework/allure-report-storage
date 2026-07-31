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

export interface ListHistoryQuery {
  repo: string;
  branch: string;
  fallbackBranch: string;
  limit?: number;
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
  deleteRetentionCandidate(report: Report): Promise<boolean>;
  listHistory(query: ListHistoryQuery): Promise<Report[]>;
  listCompleted(query: ListReportsQuery): Promise<Report[]>;
  listRetentionCandidates(query: ListRetentionCandidatesQuery): Promise<Report[]>;
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
