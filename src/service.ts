import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { getMimeType } from "hono/utils/mime";

import type { AppEnv, BuildHttpAppOptions } from "./model.js";
import { createAccessTokenSecret, decodeAccessToken, encodeAccessToken, hashAccessToken } from "./utils/accessToken.js";
import { listCompleteHistory, readHistoryDataPoint, resolveHistoryDataPoints } from "./utils/history.js";
import {
  isApiPath,
  isDynamicOptions,
  isPublicApiRequest,
  normalizeMainBranch,
  normalizeStringParam,
  parseBearerToken,
  requireEnvValue,
  tokensEqual,
  unauthorizedResponse,
} from "./utils/http.js";
import { normalizeUploadPath } from "./utils/path.js";
import { getReportFile, resolveReportEntrypointUrl } from "./utils/reportFiles.js";
import {
  buildReportFileUrl,
  buildReportUrl,
  createReportId,
  mapProject,
  mapReport,
  renderReportsTreePage,
} from "./utils/reports.js";
import { cleanupReportRetentionScope } from "./utils/retention.js";

type MultipartUploadItem = {
  file: Blob;
  path: string;
};

const runBestEffort = (promise: Promise<unknown>, executionContext?: ExecutionContext): void => {
  const handled = promise.catch((error: unknown) => {
    console.error("report retention cleanup failed", error);
  });

  if (executionContext) {
    executionContext.waitUntil(handled);
  }
};

const getExecutionContext = (context: { executionCtx?: ExecutionContext }): ExecutionContext | undefined => {
  try {
    return context.executionCtx;
  } catch {
    return undefined;
  }
};

const parseMultipartUploadBody = (
  body: FormData,
  fileErrorMessage: string,
): { error: string; items?: never } | { error?: never; items: MultipartUploadItem[] } => {
  const filenames = body.getAll("filename");
  const files = body.getAll("file");

  if (filenames.length === 0 && files.length === 1) {
    return { error: "filename is required" };
  }

  if (filenames.length === 1 && files.length === 0) {
    return { error: fileErrorMessage };
  }

  if (filenames.length === 0 || files.length === 0 || filenames.length !== files.length) {
    return { error: "invalid multipart form data" };
  }

  const paths: string[] = [];

  for (const filename of filenames) {
    if (typeof filename !== "string" || filename.trim().length === 0) {
      return { error: "filename is required" };
    }

    const filePath = normalizeUploadPath(filename);

    if (!filePath) {
      return { error: "invalid file path" };
    }

    paths.push(filePath);
  }

  const normalizedFiles: Blob[] = [];

  for (const file of files) {
    if (!(file instanceof Blob)) {
      return { error: fileErrorMessage };
    }

    normalizedFiles.push(file);
  }

  return {
    items: paths.map((path, index) => ({ file: normalizedFiles[index], path })),
  };
};

export const createHttpApp = <Bindings extends object = Record<string, never>>(
  options: BuildHttpAppOptions<Bindings>,
) => {
  const app = new Hono<AppEnv<Bindings>>();

  if (options.requestLogging ?? true) {
    app.use(logger(console.info));
  }

  app.use(async (c, next) => {
    const appContext = isDynamicOptions(options) ? await options.createContext(c) : options;

    c.set("accessToken", requireEnvValue(appContext.accessToken, "ACCESS_TOKEN"));
    c.set("fileStore", appContext.fileStore);
    c.set("mainBranch", normalizeMainBranch(appContext.mainBranch));
    c.set("repositories", appContext.repositories);
    c.set("retentionPolicy", appContext.retentionPolicy ?? {});
    c.set("secret", requireEnvValue(appContext.secret, "SECRET"));

    return next();
  });

  app.use(async (c, next) => {
    const pathname = new URL(c.req.url).pathname;

    if (isApiPath(pathname) && !isPublicApiRequest(pathname)) {
      const bearerToken = parseBearerToken(c.req.header("authorization"));
      const payload = bearerToken ? await decodeAccessToken(bearerToken, c.get("secret")) : null;

      if (!payload) {
        return unauthorizedResponse(c);
      }

      const storedAccessToken = await c
        .get("repositories")
        .accessTokens.findByAccessTokenHash(await hashAccessToken(payload.accessToken));

      if (!storedAccessToken) {
        return unauthorizedResponse(c);
      }
    }

    await next();
  });

  app.get("/api/ping", (c) => {
    return c.json({ pong: true, timestamp: Date.now() }, 200);
  });

  app.post("/api/token", async (c) => {
    const bearerToken = parseBearerToken(c.req.header("authorization"));

    if (!bearerToken || !tokensEqual(bearerToken, c.get("accessToken"))) {
      return unauthorizedResponse(c);
    }

    const url = new URL(c.req.url).origin;

    const payload = {
      accessToken: createAccessTokenSecret(),
      url,
    };
    const accessToken = await encodeAccessToken(payload, c.get("secret"));

    await c.get("repositories").accessTokens.create({
      accessTokenHash: await hashAccessToken(payload.accessToken),
      id: crypto.randomUUID(),
    });

    return c.json({ access_token: accessToken }, 200);
  });

  app.post("/api/projects/main-branch", async (c) => {
    const bearerToken = parseBearerToken(c.req.header("authorization"));

    if (!bearerToken || !tokensEqual(bearerToken, c.get("accessToken"))) {
      return unauthorizedResponse(c);
    }

    const body = await c.req.json().catch(() => ({}));
    const repo = normalizeStringParam(body.repo);
    const mainBranch = normalizeStringParam(body.mainBranch ?? body.main_branch);

    if (!repo) {
      return c.json({ error: "repo is required" }, 400);
    }

    if (!mainBranch) {
      return c.json({ error: "mainBranch is required" }, 400);
    }

    const project = await c.get("repositories").projects.upsertMainBranch({ mainBranch, repo });

    return c.json({ project: mapProject(project) }, 200);
  });

  app.post("/api/reports", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const branch = normalizeStringParam(body.branch);
    const repo = normalizeStringParam(body.repo);

    if (!branch) {
      return c.json({ error: "branch is required" }, 400);
    }

    if (!repo) {
      return c.json({ error: "repo is required" }, 400);
    }

    const reportsRepository = c.get("repositories").reports;
    const reportId =
      typeof body.reportUuid === "string" && body.reportUuid.length > 0 ? body.reportUuid : createReportId();
    const result = await reportsRepository.createOrUpdateDraft({
      reportId,
      repo,
      branch,
      name:
        typeof body.reportName === "string" ? body.reportName : typeof body.name === "string" ? body.name : undefined,
    });

    if (result.conflict) {
      return c.json({ error: "completed report is immutable" }, 409);
    }

    return c.json({ url: buildReportUrl(result.report.id) }, 200);
  });

  app.put("/api/reports/:report_id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const branch = normalizeStringParam(body.branch);
    const repo = normalizeStringParam(body.repo);

    if (!branch) {
      return c.json({ error: "branch is required" }, 400);
    }

    if (!repo) {
      return c.json({ error: "repo is required" }, 400);
    }

    const reportsRepository = c.get("repositories").reports;
    const result = await reportsRepository.createOrUpdateDraft({
      reportId: c.req.param("report_id"),
      repo,
      branch,
      name: typeof body.name === "string" ? body.name : undefined,
    });

    if (result.conflict) {
      return c.json({ error: "completed report is immutable" }, 409);
    }

    return c.json({ report: mapReport(result.report) }, 200);
  });

  app.post("/api/reports/:report_id/upload", async (c) => {
    let body: FormData;

    try {
      body = await c.req.formData();
    } catch {
      return c.json({ error: "invalid multipart form data" }, 400);
    }

    const parsed = parseMultipartUploadBody(body, "file is required");

    if ("error" in parsed) {
      return c.json({ error: parsed.error }, 400);
    }

    const fileStore = c.get("fileStore");
    const reportsRepository = c.get("repositories").reports;
    const report = await reportsRepository.findById(c.req.param("report_id"));

    if (!report) {
      return c.json({ error: "report not found" }, 404);
    }

    if (report.status === "completed") {
      return c.json({ error: "completed report is immutable" }, 409);
    }

    for (const item of parsed.items) {
      await fileStore.put(report.id, item.path, item.file);
    }

    return c.json(
      parsed.items.length === 1
        ? { uploaded: true, path: parsed.items[0].path }
        : { uploaded: true, paths: parsed.items.map((item) => item.path) },
      200,
    );
  });

  app.post("/api/assets/upload", async (c) => {
    let body: FormData;

    try {
      body = await c.req.formData();
    } catch {
      return c.json({ error: "invalid multipart form data" }, 400);
    }

    const parsed = parseMultipartUploadBody(body, "valid file is required");

    if ("error" in parsed) {
      return c.json({ error: parsed.error }, 400);
    }

    const fileStore = c.get("fileStore");

    for (const item of parsed.items) {
      await fileStore.putAsset(item.path, item.file);
    }

    return c.json(
      parsed.items.length === 1
        ? { uploaded: true, path: parsed.items[0].path }
        : { uploaded: true, paths: parsed.items.map((item) => item.path) },
      200,
    );
  });

  app.post("/api/reports/:report_id/complete", async (c) => {
    const reportId = c.req.param("report_id");
    const body = await c.req.json().catch(() => null);
    const historyPoint =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { historyPoint?: unknown }).historyPoint
        : undefined;

    if (historyPoint === undefined) {
      return c.json({ error: "history data point is required" }, 400);
    }

    const reportsRepository = c.get("repositories").reports;
    const existing = await reportsRepository.findById(reportId);

    if (!existing) {
      return c.json({ error: "report not found" }, 404);
    }

    if (existing.status === "completed") {
      return c.json({ error: "report already completed" }, 409);
    }

    const fileStore = c.get("fileStore");

    await fileStore.putHistory(reportId, new TextEncoder().encode(JSON.stringify(historyPoint)));

    const result = await reportsRepository.complete(reportId);

    if (result.notFound) {
      await fileStore.deleteHistory(reportId);

      return c.json({ error: "report not found" }, 404);
    }

    if (result.conflict) {
      await fileStore.deleteHistory(reportId);

      return c.json({ error: "report already completed" }, 409);
    }

    runBestEffort(
      cleanupReportRetentionScope({
        branch: result.report.branch,
        fileStore,
        policy: c.get("retentionPolicy"),
        repo: result.report.repo,
        reportsRepository,
      }),
      getExecutionContext(c as { executionCtx?: ExecutionContext }),
    );

    return c.json({ report: mapReport(result.report) }, 200);
  });

  app.post("/api/report/:report_id/delete", async (c) => {
    const reportId = c.req.param("report_id");
    const fileStore = c.get("fileStore");
    const reportsRepository = c.get("repositories").reports;
    const deleted = await reportsRepository.delete(reportId);

    if (!deleted) {
      return c.json({ error: "report not found" }, 404);
    }

    await Promise.all([fileStore.delete(reportId), fileStore.deleteHistory(reportId)]);

    return c.json({ deleted: true }, 200);
  });

  app.get("/api/history", async (c) => {
    const repo = normalizeStringParam(c.req.query("repo"));
    const mainBranch = c.get("mainBranch");
    const project = repo ? await c.get("repositories").projects.findByRepo(repo) : null;
    const projectMainBranch = project?.mainBranch ?? mainBranch;
    const branch = c.req.query("branch")?.trim() || projectMainBranch;
    const limitParam = c.req.query("limit");
    const limit = limitParam === undefined ? 10 : Number(limitParam);

    if (!repo) {
      return c.json({ error: "repo is required" }, 400);
    }

    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      return c.json({ error: "limit must be a positive integer" }, 400);
    }

    const fileStore = c.get("fileStore");
    const reportsRepository = c.get("repositories").reports;
    let reports = await reportsRepository.listHistory({ repo, branch, fallbackBranch: projectMainBranch, limit });

    if (!limit) {
      const history = await resolveHistoryDataPoints(fileStore, reportsRepository, reports, branch);

      return c.json({ history }, 200);
    }

    const history: unknown[] = [];

    for (const report of reports) {
      const dataPoint = await readHistoryDataPoint(fileStore, report);

      if (!dataPoint) {
        reports = await listCompleteHistory(reportsRepository, {
          repo,
          branch,
          fallbackBranch: projectMainBranch,
          limit,
        });

        const resolvedHistory = await resolveHistoryDataPoints(fileStore, reportsRepository, reports, branch);

        return c.json({ history: resolvedHistory.slice(0, limit) }, 200);
      }

      history.push(dataPoint);
    }

    return c.json({ history }, 200);
  });

  app.get("/reports/tree", async (c) => {
    const repo = normalizeStringParam(c.req.query("repo"));

    if (!repo) {
      return c.html(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>repo is required</title></head><body style='background:#f1f5f7ff;font-family:"JetBrainsMonoVF", ui-monospace, monospace;color:#010a18d4;'>repo is required</body></html>`,
        400,
      );
    }

    const project = await c.get("repositories").projects.findByRepo(repo);
    const mainBranch = project?.mainBranch ?? c.get("mainBranch");
    const reports = await c.get("repositories").reports.listCompleted({ repo });

    return c.html(renderReportsTreePage({ mainBranch, repo, reports }), 200);
  });

  app.all("/api/*", (c) => {
    return c.json({ error: "not found" }, 404);
  });

  app.get("/assets/:filePath{.+}", async (c) => {
    const filePath = normalizeUploadPath(c.req.param("filePath") ?? "");

    if (!filePath) {
      return c.json({ error: "file not found" }, 404);
    }

    const file = await c.get("fileStore").getAsset(filePath);

    if (!file) {
      return c.json({ error: "file not found" }, 404);
    }

    return c.body(file, 200, { "content-type": getMimeType(filePath) ?? "application/octet-stream" });
  });

  app.get("/:report_id", async (c) => {
    const entrypoint = await resolveReportEntrypointUrl(
      c.get("repositories").reports,
      c.get("fileStore"),
      c.req.param("report_id"),
    );

    if ("error" in entrypoint) {
      return c.json({ error: entrypoint.error }, 404);
    }

    return c.redirect(entrypoint.url);
  });

  app.get("/:report_id/:filePath{.+}", async (c) => {
    const filePath = normalizeUploadPath(c.req.param("filePath") ?? "");

    if (!filePath) {
      return c.json({ error: "file not found" }, 404);
    }

    const file = await getReportFile(
      c.get("repositories").reports,
      c.get("fileStore"),
      c.req.param("report_id"),
      filePath,
      c.req.header("accept"),
    );

    if ("error" in file) {
      return c.json({ error: file.error }, 404);
    }

    if (file.path === `${filePath}/index.html`) {
      return c.redirect(buildReportFileUrl(c.req.param("report_id"), ...file.path.split("/")));
    }

    return c.body(file.data, 200, { "content-type": getMimeType(file.path) ?? "application/octet-stream" });
  });

  app.notFound((c) => {
    return c.json({ error: "not found" }, 404);
  });

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return error.getResponse();
    }

    console.error(error);
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
};
