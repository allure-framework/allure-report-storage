import type { Context, Env } from "hono";

import type { Repositories } from "./repositories/api.js";

export type ReportStatus = "draft" | "completed";

export interface Report {
  id: string;
  repo: string;
  branch: string;
  name: string | null;
  status: ReportStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AccessToken {
  id: string;
  accessTokenHash: string;
  createdAt: string;
}

export interface Project {
  repo: string;
  mainBranch: string;
}

export interface AccessTokensTable {
  id: string;
  access_token_hash: string;
  created_at: Date | string;
}

export interface ProjectsTable {
  repo: string;
  main_branch: string;
}

export interface ReportsTable {
  id: string;
  repo: string;
  branch: string;
  name: string | null;
  status: ReportStatus;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

export interface AllureReportStorageDatabase {
  access_tokens: AccessTokensTable;
  projects: ProjectsTable;
  reports: ReportsTable;
}

export interface SqliteReportRepositoryOptions {
  databasePath: string;
}

export interface AppVariables {
  accessToken: string;
  fileStore: StaticFileStore;
  mainBranch: string;
  repositories: Repositories;
  secret: string;
}

export type AppEnv<Bindings extends object = Record<string, never>> = Env & {
  Bindings: Bindings;
  Variables: AppVariables;
};

export type MaybePromise<T> = T | Promise<T>;

export interface AppContextOptions {
  accessToken: string;
  fileStore: StaticFileStore;
  mainBranch?: string;
  repositories: Repositories;
  secret: string;
}

export interface StaticBuildAppOptions extends AppContextOptions {
  requestLogging?: boolean;
}

export type BuildAppOptions = StaticBuildAppOptions;

export interface ListenOptions {
  host?: string;
  port?: number;
}

export interface DynamicBuildAppOptions<Bindings extends object = Record<string, never>> {
  createContext: (context: Context<AppEnv<Bindings>>) => MaybePromise<AppContextOptions>;
  requestLogging?: boolean;
}

export type BuildHttpAppOptions<Bindings extends object = Record<string, never>> =
  | DynamicBuildAppOptions<Bindings>
  | StaticBuildAppOptions;

export type WorkerBindings = Omit<WorkerEnv, "ACCESS_TOKEN" | "MAIN_BRANCH" | "SECRET"> & {
  ACCESS_TOKEN?: string;
  MAIN_BRANCH?: string;
  R2_ASSETS_PREFIX?: string;
  R2_PREFIX?: string;
  R2_REPORTS_PREFIX?: string;
  SECRET?: string;
};

export type StaticFileData = Uint8Array | Blob | ReadableStream<Uint8Array> | NodeJS.ReadableStream;

export interface StaticFileStore {
  put(reportId: string, relativePath: string, data: StaticFileData): Promise<void>;
  get(reportId: string, relativePath: string): Promise<Uint8Array<ArrayBuffer> | null>;
  exists(reportId: string, relativePath: string): Promise<boolean>;
  list(reportId: string): Promise<string[]>;
  delete(reportId: string): Promise<void>;
  putHistory(reportId: string, data: StaticFileData): Promise<void>;
  getHistory(reportId: string): Promise<Uint8Array<ArrayBuffer> | null>;
  deleteHistory(reportId: string): Promise<void>;
  putAsset(relativePath: string, data: StaticFileData): Promise<void>;
  getAsset(relativePath: string): Promise<Uint8Array<ArrayBuffer> | null>;
}
