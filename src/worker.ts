import type { WorkerBindings } from "./model.js";
import { D1AccessTokenRepository } from "./repositories/d1/accessTokens.js";
import { D1ProjectRepository } from "./repositories/d1/projects.js";
import { D1ReportRepository } from "./repositories/d1/reports.js";
import { createHttpApp } from "./service.js";
import { R2Store } from "./storage/r2.js";
import { cleanupReportRetention, parseRetentionPolicy } from "./utils/retention.js";

const requiredBinding = <T>(value: T | undefined, name: string): T => {
  if (value === undefined || value === null) {
    throw new Error(`${name} binding is required`);
  }

  return value;
};

const requiredString = (value: string | undefined, name: string): string => {
  const normalized = value?.trim();

  if (!normalized) {
    throw new Error(`${name} environment variable is required`);
  }

  return normalized;
};

const optionalString = (value: string | undefined): string | undefined => value?.trim() || undefined;

const createContext = async (env: WorkerBindings) => ({
  accessToken: requiredString(env.ACCESS_TOKEN, "ACCESS_TOKEN"),
  fileStore: new R2Store({
    assetsPrefix: optionalString(env.R2_ASSETS_PREFIX),
    bucket: requiredBinding(env.REPORTS_BUCKET, "REPORTS_BUCKET"),
    prefix: optionalString(env.R2_PREFIX),
    reportsPrefix: optionalString(env.R2_REPORTS_PREFIX),
  }),
  mainBranch: optionalString(env.MAIN_BRANCH),
  repositories: {
    accessTokens: await D1AccessTokenRepository.create({
      database: requiredBinding(env.REPORTS_DB, "REPORTS_DB"),
    }),
    projects: await D1ProjectRepository.create({
      database: requiredBinding(env.REPORTS_DB, "REPORTS_DB"),
    }),
    reports: await D1ReportRepository.create({
      database: requiredBinding(env.REPORTS_DB, "REPORTS_DB"),
    }),
  },
  retentionPolicy: parseRetentionPolicy((name) =>
    optionalString(env[name as keyof WorkerBindings] as string | undefined),
  ),
  secret: requiredString(env.SECRET, "SECRET"),
});

const app = createHttpApp<WorkerBindings>({
  createContext: async ({ env }) => createContext(env),
  requestLogging: false,
});

export default {
  fetch(request: Request, env: WorkerBindings, executionContext: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, executionContext as Parameters<typeof app.fetch>[2]);
  },
  async scheduled(_controller: ScheduledController, env: WorkerBindings, executionContext: ExecutionContext) {
    executionContext.waitUntil(
      createContext(env).then((context) =>
        cleanupReportRetention({
          fileStore: context.fileStore,
          policy: context.retentionPolicy,
          repositories: context.repositories,
        }),
      ),
    );
  },
};
