import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildApp } from "../../../src/app.js";
import type { StaticFileData, StaticFileStore } from "../../../src/model.js";
import { SqliteAccessTokenRepository } from "../../../src/repositories/sqlite/accessTokens.js";
import { SqliteProjectRepository } from "../../../src/repositories/sqlite/projects.js";
import { SqliteReportRepository } from "../../../src/repositories/sqlite/reports.js";
import { FsStore } from "../../../src/storage/fs.js";
import { historyFileName } from "../../../src/utils/path.js";
import { formatReportCreatedAt } from "../../../src/utils/reports.js";

const ACCESS_TOKEN = "test-bootstrap-token";
const REPO = "qameta/allure-report-storage";
const OTHER_REPO = "qameta/other-report-storage";
const SECRET = "test-signing-secret";

type HistoryResponse = { history: Array<{ point: string }> };
type TestApp = Awaited<ReturnType<typeof buildApp>> & { accessToken: string };

const withApp = async (
  run: (context: { app: TestApp; tempDir: string }) => Promise<void>,
  appOptions: Partial<Parameters<typeof buildApp>[0]> = {},
) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-storage-test-"));
  const repositories = {
    accessTokens: await SqliteAccessTokenRepository.create({ databasePath: ":memory:" }),
    projects: await SqliteProjectRepository.create({ databasePath: ":memory:" }),
    reports: await SqliteReportRepository.create({ databasePath: ":memory:" }),
  };
  const fileStore = new FsStore(path.join(tempDir, "files"));
  const app = await buildApp({
    repositories,
    fileStore,
    accessToken: ACCESS_TOKEN,
    secret: SECRET,
    requestLogging: false,
    ...appOptions,
  });
  const tokenResponse = await app.request("/api/token", {
    headers: {
      authorization: `Bearer ${appOptions.accessToken ?? ACCESS_TOKEN}`,
    },
    method: "POST",
  });
  const { access_token: generatedAccessToken } = (await tokenResponse.json()) as { access_token: string };
  const testApp = Object.assign(app, { accessToken: generatedAccessToken });

  try {
    await run({ app: testApp, tempDir });
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

const readJson = async <T = any>(response: Response): Promise<T> => response.json() as Promise<T>;

const jsonBody = (payload: unknown): Pick<RequestInit, "body" | "headers"> => ({
  body: JSON.stringify(payload),
  headers: { "content-type": "application/json" },
});

const requestBootstrap = async (app: TestApp, url: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);

  headers.set("authorization", `Bearer ${ACCESS_TOKEN}`);

  return app.request(url, {
    ...init,
    headers,
    redirect: init.redirect ?? "manual",
  });
};

const requestAuthorized = async (app: TestApp, url: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);

  headers.set("authorization", `Bearer ${app.accessToken}`);

  return app.request(url, {
    ...init,
    headers,
    redirect: init.redirect ?? "manual",
  });
};

const pauseForHistoryOrdering = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 2));
};

const createUploadFormData = (filename: string | null, file: Buffer | string | null): FormData => {
  const formData = new FormData();

  if (filename !== null) {
    formData.set("filename", filename);
  }

  if (file !== null) {
    const body = Buffer.isBuffer(file) ? file : Buffer.from(file);

    formData.set("file", new Blob([new Uint8Array(body)], { type: "application/octet-stream" }), "file");
  }

  return formData;
};

const createBatchUploadFormData = (
  entries: Array<{ file?: Blob | Buffer | string | null; filename?: string | null }>,
): FormData => {
  const formData = new FormData();

  for (const entry of entries) {
    if (entry.filename !== undefined && entry.filename !== null) {
      formData.append("filename", entry.filename);
    }

    if (entry.file !== undefined && entry.file !== null) {
      if (entry.file instanceof Blob) {
        formData.append("file", entry.file, "file");
      } else if (Buffer.isBuffer(entry.file)) {
        formData.append("file", new Blob([new Uint8Array(entry.file)], { type: "application/octet-stream" }), "file");
      } else {
        formData.append("file", new Blob([entry.file], { type: "application/octet-stream" }), "file");
      }
    }
  }

  return formData;
};

const publishHistoryPoint = async (
  app: TestApp,
  reportId: string,
  branch: string,
  point: string,
  repo = REPO,
): Promise<string> => {
  let response = await requestAuthorized(app, `/api/reports/${reportId}`, {
    method: "PUT",
    ...jsonBody({ repo, branch, name: point }),
  });

  expect(response.status).toBe(200);

  const { report } = await readJson<{ report: { createdAt: string } }>(response);
  response = await requestAuthorized(app, `/api/reports/${reportId}/complete`, {
    method: "POST",
    ...jsonBody({ historyPoint: { point } }),
  });

  expect(response.status).toBe(200);

  await pauseForHistoryOrdering();

  return report.createdAt;
};

const historyPointPath = (tempDir: string, reportId: string): string =>
  path.join(tempDir, "history", historyFileName(reportId));

const deleteHistoryPoint = (tempDir: string, reportId: string): void => {
  fs.rmSync(historyPointPath(tempDir, reportId), { force: true });
};

const writeHistoryPoint = (tempDir: string, reportId: string, point: string): void => {
  const filePath = historyPointPath(tempDir, reportId);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ point }));
};

const expectHistoryPoints = async (app: TestApp, expected: string[], branch = "main", limit = 10): Promise<void> => {
  const response = await requestAuthorized(
    app,
    `/api/history?repo=${encodeURIComponent(REPO)}&branch=${encodeURIComponent(branch)}&limit=${limit}`,
  );

  expect(response.status).toBe(200);
  expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual(expected);
};

describe("reports API", () => {
  it("applies count retention per branch and keeps newest completed report", async () => {
    await withApp(
      async ({ app, tempDir }) => {
        await publishHistoryPoint(app, "count-main-1", "main", "main-1");
        await publishHistoryPoint(app, "count-main-2", "main", "main-2");
        await publishHistoryPoint(app, "count-child-1", "child", "child-1");
        await publishHistoryPoint(app, "count-main-3", "main", "main-3");

        await expectHistoryPoints(app, ["main-3", "main-2"]);
        await expectHistoryPoints(app, ["child-1"], "child", 1);
        expect(fs.existsSync(historyPointPath(tempDir, "count-main-1"))).toBe(false);
      },
      { retentionPolicy: { maxReportsPerBranch: 2 } },
    );
  });

  it("applies age retention and protects newest completed report", async () => {
    await withApp(
      async ({ app }) => {
        await publishHistoryPoint(app, "age-main-1", "main", "age-1");
        await new Promise((resolve) => setTimeout(resolve, 3));
        await publishHistoryPoint(app, "age-main-2", "main", "age-2");

        await expectHistoryPoints(app, ["age-2"]);
      },
      { retentionPolicy: { maxReportAgeMs: 1 } },
    );

    await withApp(
      async ({ app }) => {
        await publishHistoryPoint(app, "age-newest", "main", "newest");

        await expectHistoryPoints(app, ["newest"]);
      },
      { retentionPolicy: { maxReportAgeMs: 0 } },
    );
  });

  it("unions count and age retention candidates", async () => {
    await withApp(
      async ({ app }) => {
        await publishHistoryPoint(app, "both-main-1", "main", "both-1");
        await publishHistoryPoint(app, "both-main-2", "main", "both-2");
        await new Promise((resolve) => setTimeout(resolve, 3));
        await publishHistoryPoint(app, "both-main-3", "main", "both-3");

        await expectHistoryPoints(app, ["both-3"]);
      },
      { retentionPolicy: { maxReportAgeMs: 1, maxReportsPerBranch: 2 } },
    );
  });

  it("does not clamp history limit to retention count", async () => {
    await withApp(
      async ({ app }) => {
        await publishHistoryPoint(app, "history-limit-1", "main", "limit-1");
        await publishHistoryPoint(app, "history-limit-2", "main", "limit-2");
        await publishHistoryPoint(app, "history-limit-3", "main", "limit-3");

        await expectHistoryPoints(app, ["limit-3", "limit-2", "limit-1"], "main", 3);
      },
      { retentionPolicy: { maxReportsPerBranch: 5 } },
    );
  });

  it("protects report and asset mutation endpoints", async () => {
    await withApp(async ({ app }) => {
      let response = await app.request("/api/ping");
      expect(response.status).toBe(200);
      expect((await readJson(response)).pong).toBe(true);

      response = await app.request("/api/token", { method: "POST" });
      expect(response.status).toBe(401);

      response = await app.request("/api/token", {
        headers: { authorization: "Bearer wrong-token" },
        method: "POST",
      });
      expect(response.status).toBe(401);

      response = await app.request("/api/token", {
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect((await readJson<{ access_token: string }>(response)).access_token).toMatch(/^ars1\./);

      response = await app.request("/api/projects/main-branch", { method: "POST" });
      expect(response.status).toBe(401);

      response = await app.request("/api/projects/main-branch", {
        headers: { authorization: "Bearer wrong-token" },
        method: "POST",
        ...jsonBody({ mainBranch: "trunk", repo: REPO }),
      });
      expect(response.status).toBe(401);

      response = await requestBootstrap(app, "/api/projects/main-branch", {
        method: "POST",
        ...jsonBody({ mainBranch: "trunk", repo: REPO }),
      });
      expect(response.status).toBe(200);
      expect((await readJson(response)).project).toMatchObject({ mainBranch: "trunk", repo: REPO });

      response = await app.request("/api/reports", {
        method: "POST",
        ...jsonBody({ repo: REPO, branch: "main", name: "Unauthorized" }),
      });
      expect(response.status).toBe(401);
      expect((await readJson(response)).error).toBe("unauthorized");
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="allure-report-storage"');

      response = await app.request("/api/reports", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
        body: JSON.stringify({ repo: REPO, branch: "main", name: "Wrong token" }),
      });
      expect(response.status).toBe(401);

      response = await app.request(`/api/history?repo=${encodeURIComponent(REPO)}`);
      expect(response.status).toBe(401);

      response = await app.request("/api/reports/protected-report", {
        method: "PUT",
        ...jsonBody({ repo: REPO, branch: "main", name: "Unauthorized" }),
      });
      expect(response.status).toBe(401);

      response = await app.request("/api/assets/upload", {
        body: createUploadFormData("app.js", "console.log('blocked');"),
        method: "POST",
      });
      expect(response.status).toBe(401);
    });
  });

  it("supports report lifecycle end to end", async () => {
    await withApp(async ({ app }) => {
      let response = await requestAuthorized(app, "/api/reports", {
        method: "POST",
        ...jsonBody({
          projectUuid: "legacy-project",
          reportUuid: "r1",
          reportName: "Draft 1",
          repo: REPO,
          branch: "main",
        }),
      });
      expect(response.status).toBe(200);
      expect((await readJson(response)).url).toBe("/r1");

      response = await requestAuthorized(app, "/api/reports/r1", {
        method: "PUT",
        ...jsonBody({ repo: REPO, branch: "release", name: "Draft 1 updated" }),
      });
      expect(response.status).toBe(200);
      expect((await readJson(response)).report).toMatchObject({ repo: REPO, branch: "release" });

      response = await requestAuthorized(app, "/api/reports/r1/upload", {
        body: createUploadFormData("index.html", "<html>root</html>"),
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ uploaded: true, path: "index.html" });

      response = await requestAuthorized(app, "/api/reports/r1/upload", {
        body: createUploadFormData("awesome/index.html", "<html>plugin</html>"),
        method: "POST",
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/missing/upload", {
        body: createUploadFormData("index.html", "missing"),
        method: "POST",
      });
      expect(response.status).toBe(404);

      response = await requestAuthorized(app, "/api/reports/r1/upload", {
        body: createUploadFormData(null, "missing filename"),
        method: "POST",
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toBe("filename is required");

      response = await requestAuthorized(app, "/api/reports/r1/complete", {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toBe("history data point is required");

      response = await requestAuthorized(app, "/api/reports/r1/complete", {
        method: "POST",
        ...jsonBody({ historyPoint: { total: 10 } }),
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/r1/complete", {
        method: "POST",
        ...jsonBody({ historyPoint: { total: 11 } }),
      });
      expect(response.status).toBe(409);

      response = await requestAuthorized(app, "/api/reports/r1/upload", {
        body: createUploadFormData("another.html", "blocked"),
        method: "POST",
      });
      expect(response.status).toBe(409);

      response = await requestAuthorized(app, "/r1");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/r1/index.html");

      response = await requestAuthorized(app, "/r1/index.html");
      expect(response.status).toBe(200);
      expect(await response.text()).toMatch(/root/);

      response = await requestAuthorized(app, "/api/reports/r2", {
        method: "PUT",
        ...jsonBody({ repo: REPO, branch: "main", name: "Plugins one" }),
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/r2/upload", {
        body: createUploadFormData("plugin-a/index.html", "<html>plugin-a</html>"),
        method: "POST",
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/r2/complete", {
        method: "POST",
        ...jsonBody({ historyPoint: { total: 1 } }),
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/r2");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/r2/plugin-a/index.html");

      response = await requestAuthorized(app, "/api/reports/r3", {
        method: "PUT",
        ...jsonBody({ repo: REPO, branch: "main", name: "Plugins many" }),
      });
      expect(response.status).toBe(200);

      await requestAuthorized(app, "/api/reports/r3/upload", {
        body: createUploadFormData("plugin-a/index.html", "A"),
        method: "POST",
      });
      await requestAuthorized(app, "/api/reports/r3/upload", {
        body: createUploadFormData("plugin-b/index.html", "B"),
        method: "POST",
      });
      await requestAuthorized(app, "/api/reports/r3/complete", {
        method: "POST",
        ...jsonBody({ historyPoint: { total: 2 } }),
      });

      response = await requestAuthorized(app, "/r3");
      expect(response.status).toBe(404);
      expect((await readJson(response)).error).toBe("entrypoint not found");

      response = await requestAuthorized(app, "/r2/plugin-a/index.html");
      expect(response.status).toBe(200);
      expect(await response.text()).toMatch(/plugin-a/);

      response = await requestAuthorized(app, "/api/reports");
      expect(response.status).toBe(404);
      expect((await readJson(response)).error).toBe("not found");

      response = await requestAuthorized(app, `/api/reports?repo=${encodeURIComponent(REPO)}&branch=release`);
      expect(response.status).toBe(404);
      expect((await readJson(response)).error).toBe("not found");

      response = await requestAuthorized(app, `/api/reports/latest?repo=${encodeURIComponent(REPO)}&branch=main`);
      expect(response.status).toBe(404);
      expect((await readJson(response)).error).toBe("not found");
    });
  });

  it("creates report ids when the create endpoint does not receive one", async () => {
    await withApp(async ({ app }) => {
      const response = await requestAuthorized(app, "/api/reports", {
        method: "POST",
        ...jsonBody({ projectUuid: "legacy-project", reportName: "Generated draft", repo: REPO, branch: "main" }),
      });

      expect(response.status).toBe(200);

      const { url } = await readJson<{ url: string }>(response);
      const reportId = decodeURIComponent(url.replace(/^\//, ""));

      expect(url).toMatch(/^\/[0-9a-f-]+$/i);

      const uploadResponse = await requestAuthorized(app, `/api/reports/${encodeURIComponent(reportId)}/upload`, {
        body: createUploadFormData("index.html", "<html>generated</html>"),
        method: "POST",
      });

      expect(uploadResponse.status).toBe(200);
    });
  });

  it("supports batch multipart uploads", async () => {
    await withApp(async ({ app, tempDir }) => {
      let response = await requestAuthorized(app, "/api/reports/batch-report", {
        method: "PUT",
        ...jsonBody({ repo: REPO, branch: "main", name: "Batch report" }),
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/batch-report/upload", {
        body: createBatchUploadFormData([
          { filename: "index.html", file: "<html>batch</html>" },
          { filename: "assets/app.js", file: "console.log('batch');" },
        ]),
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ uploaded: true, paths: ["index.html", "assets/app.js"] });
      expect(fs.existsSync(path.join(tempDir, "files", "batch-report", "index.html"))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "files", "batch-report", "assets", "app.js"))).toBe(true);

      response = await requestAuthorized(app, "/api/assets/upload", {
        body: createBatchUploadFormData([
          { filename: "styles.css", file: "body { color: red; }" },
          { filename: "icons/logo.svg", file: "<svg />" },
        ]),
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ uploaded: true, paths: ["styles.css", "icons/logo.svg"] });
      expect(fs.existsSync(path.join(tempDir, "assets", "styles.css"))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "assets", "icons", "logo.svg"))).toBe(true);
    });
  });

  it("rejects invalid multipart batches before writes", async () => {
    await withApp(async ({ app, tempDir }) => {
      let response = await requestAuthorized(app, "/api/reports/batch-invalid", {
        method: "PUT",
        ...jsonBody({ repo: REPO, branch: "main", name: "Batch invalid" }),
      });
      expect(response.status).toBe(200);

      const reportDir = path.join(tempDir, "files", "batch-invalid");

      response = await requestAuthorized(app, "/api/reports/batch-invalid/upload", {
        body: createBatchUploadFormData([{ filename: "ok.txt", file: "ok" }, { filename: "missing.txt" }]),
        method: "POST",
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toBe("invalid multipart form data");

      response = await requestAuthorized(app, "/api/reports/batch-invalid/upload", {
        body: createBatchUploadFormData([]),
        method: "POST",
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toBe("invalid multipart form data");

      response = await requestAuthorized(app, "/api/reports/batch-invalid/upload", {
        body: createBatchUploadFormData([{ filename: "  ", file: "bad" }]),
        method: "POST",
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toBe("filename is required");

      response = await requestAuthorized(app, "/api/reports/batch-invalid/upload", {
        body: createBatchUploadFormData([{ filename: "../bad.txt", file: "bad" }]),
        method: "POST",
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toBe("invalid file path");

      const invalidFileFormData = new FormData();

      invalidFileFormData.append("filename", "good.txt");
      invalidFileFormData.append("file", "not-a-blob");

      response = await requestAuthorized(app, "/api/reports/batch-invalid/upload", {
        body: invalidFileFormData,
        method: "POST",
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toBe("file is required");

      response = await requestAuthorized(app, "/api/assets/upload", {
        body: invalidFileFormData,
        method: "POST",
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toBe("valid file is required");

      expect(fs.existsSync(reportDir)).toBe(false);
    });
  });

  it("serves uploaded reports by direct browser link", async () => {
    await withApp(async ({ app }) => {
      let response = await requestAuthorized(app, "/api/reports/direct-link-report", {
        method: "PUT",
        ...jsonBody({ repo: REPO, branch: "main", name: "Direct browser link" }),
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/direct-link-report/upload", {
        body: createUploadFormData("awesome/index.html", "<html>direct report</html>"),
        method: "POST",
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/direct-link-report/upload", {
        body: createUploadFormData("widgets/summary.json", '{"total":1}'),
        method: "POST",
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/direct-link-report/upload", {
        body: createUploadFormData("awesome/data/test-results/case.json", '{"uid":"case"}'),
        method: "POST",
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/assets/upload", {
        body: createUploadFormData("direct-link.css", "body { color: green; }"),
        method: "POST",
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/assets/upload", {
        body: createUploadFormData("awesome/scoped.css", ".scoped { color: blue; }"),
        method: "POST",
      });
      expect(response.status).toBe(200);

      response = await app.request("/direct-link-report", { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/direct-link-report/awesome/index.html");

      response = await app.request("/direct-link-report/awesome/index.html");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("direct report");

      response = await app.request("/direct-link-report/awesome");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/direct-link-report/awesome/index.html");

      response = await app.request("/direct-link-report/awesome/suites/test-case", {
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html\b/);
      expect(await response.text()).toContain("direct report");

      response = await app.request("/direct-link-report/awesome/widgets/summary.json");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
      expect(await response.json()).toEqual({ total: 1 });

      response = await app.request("/direct-link-report/data/test-results/case.json");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
      expect(await response.json()).toEqual({ uid: "case" });

      response = await app.request("/direct-link-report/awesome/data/test-results/case.json");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
      expect(await response.json()).toEqual({ uid: "case" });

      response = await app.request("/direct-link-report/awesome/direct-link.css");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/css\b/);
      expect(await response.text()).toContain("green");

      response = await app.request("/direct-link-report/awesome/scoped.css");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/css\b/);
      expect(await response.text()).toContain("blue");

      response = await app.request("/assets/direct-link.css");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/css\b/);

      response = await requestAuthorized(app, "/api/reports");
      expect(response.status).toBe(404);
      expect((await readJson(response)).error).toBe("not found");

      response = await requestAuthorized(app, "/api/reports/direct-link-report/complete", {
        method: "POST",
        ...jsonBody({ historyPoint: { total: 1 } }),
      });
      expect(response.status).toBe(200);
    });
  });

  it("serves exact report file paths before resolving report entrypoints", async () => {
    const fileStore: StaticFileStore = {
      delete: async () => {},
      deleteHistory: async () => {},
      exists: async () => false,
      get: async (_reportId, relativePath) =>
        relativePath === "awesome/index.html" ? new Uint8Array(Buffer.from("<html>direct exact</html>")) : null,
      getAsset: async () => null,
      getHistory: async () => null,
      list: async () => {
        throw new Error("list should not be called for exact file paths");
      },
      put: async () => {},
      putAsset: async () => {},
      putHistory: async () => {},
    };

    await withApp(
      async ({ app }) => {
        const createResponse = await requestAuthorized(app, "/api/reports/direct-exact-report", {
          method: "PUT",
          ...jsonBody({ repo: REPO, branch: "main", name: "Direct exact report" }),
        });
        expect(createResponse.status).toBe(200);

        const response = await app.request("/direct-exact-report/awesome/index.html");

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("<html>direct exact</html>");
      },
      { fileStore },
    );
  });

  it("redirects directory index paths to their concrete index file", async () => {
    const fileStore: StaticFileStore = {
      delete: async () => {},
      deleteHistory: async () => {},
      exists: async () => false,
      get: async (_reportId, relativePath) =>
        relativePath === "awesome/index.html" ? new Uint8Array(Buffer.from("<html>directory index</html>")) : null,
      getAsset: async () => null,
      getHistory: async () => null,
      list: async () => {
        throw new Error("list should not be called for direct directory index paths");
      },
      put: async () => {},
      putAsset: async () => {},
      putHistory: async () => {},
    };

    await withApp(
      async ({ app }) => {
        const createResponse = await requestAuthorized(app, "/api/reports/direct-directory-report", {
          method: "PUT",
          ...jsonBody({ repo: REPO, branch: "main", name: "Direct directory report" }),
        });
        expect(createResponse.status).toBe(200);

        const response = await app.request("/direct-directory-report/awesome", { redirect: "manual" });

        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/direct-directory-report/awesome/index.html");
      },
      { fileStore },
    );
  });

  it("serves plugin-prefixed shared assets before resolving report entrypoints", async () => {
    const fileStore: StaticFileStore = {
      delete: async () => {},
      deleteHistory: async () => {},
      exists: async () => false,
      get: async () => null,
      getAsset: async (relativePath) =>
        relativePath === "styles.css" ? new Uint8Array(Buffer.from("body { color: green; }")) : null,
      getHistory: async () => null,
      list: async () => {
        throw new Error("list should not be called for plugin-prefixed shared assets");
      },
      put: async () => {},
      putAsset: async () => {},
      putHistory: async () => {},
    };

    await withApp(
      async ({ app }) => {
        const createResponse = await requestAuthorized(app, "/api/reports/direct-asset-report", {
          method: "PUT",
          ...jsonBody({ repo: REPO, branch: "main", name: "Direct asset report" }),
        });
        expect(createResponse.status).toBe(200);

        const response = await app.request("/direct-asset-report/awesome/styles.css");

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toMatch(/^text\/css\b/);
        expect(await response.text()).toBe("body { color: green; }");
      },
      { fileStore },
    );
  });

  it("passes multipart files to storage as blobs", async () => {
    const uploaded: { asset?: StaticFileData; report?: StaticFileData } = {};
    const fileStore: StaticFileStore = {
      delete: async () => {},
      deleteHistory: async () => {},
      exists: async () => false,
      get: async () => null,
      getAsset: async () => null,
      getHistory: async () => null,
      list: async () => [],
      put: async (_reportId, _relativePath, data) => {
        uploaded.report = data;
      },
      putAsset: async (_relativePath, data) => {
        uploaded.asset = data;
      },
      putHistory: async () => {},
    };

    await withApp(
      async ({ app }) => {
        let response = await requestAuthorized(app, "/api/reports/blob-upload", {
          method: "PUT",
          ...jsonBody({ repo: REPO, branch: "main", name: "Blob upload" }),
        });
        expect(response.status).toBe(200);

        response = await requestAuthorized(app, "/api/reports/blob-upload/upload", {
          body: createUploadFormData("index.html", "<html>blob</html>"),
          method: "POST",
        });
        expect(response.status).toBe(200);

        response = await requestAuthorized(app, "/api/assets/upload", {
          body: createUploadFormData("app.js", "console.log('blob');"),
          method: "POST",
        });
        expect(response.status).toBe(200);
      },
      { fileStore },
    );

    expect(uploaded.report).toBeInstanceOf(Blob);
    expect(uploaded.asset).toBeInstanceOf(Blob);
  });

  it("stores static files from blobs and readable streams", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-storage-stream-test-"));
    const store = new FsStore(path.join(tempDir, "files"));

    try {
      await store.put("stream-report", "blob.txt", new Blob(["blob-data"]));
      await store.putAsset("stream.txt", new Blob(["stream-data"]).stream());
      await store.putHistory("stream-report", new TextEncoder().encode('{"point":"history-data"}'));

      const reportFile = await store.get("stream-report", "blob.txt");
      const assetFile = await store.getAsset("stream.txt");
      const historyFile = await store.getHistory("stream-report");

      expect(reportFile).not.toBeNull();
      expect(assetFile).not.toBeNull();
      expect(historyFile).not.toBeNull();
      expect(Buffer.from(reportFile!)).toEqual(Buffer.from("blob-data"));
      expect(Buffer.from(assetFile!)).toEqual(Buffer.from("stream-data"));
      expect(Buffer.from(historyFile!)).toEqual(Buffer.from('{"point":"history-data"}'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("deletes reports and their stored files", async () => {
    await withApp(async ({ app, tempDir }) => {
      let response = await requestAuthorized(app, "/api/reports/delete-me", {
        method: "PUT",
        ...jsonBody({ repo: REPO, branch: "main", name: "Deleted report" }),
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/delete-me/upload", {
        body: createUploadFormData("index.html", "<html>delete me</html>"),
        method: "POST",
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/delete-me/upload", {
        body: createUploadFormData("assets/app.js", "console.log('delete me');"),
        method: "POST",
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/delete-me/complete", {
        method: "POST",
        ...jsonBody({ historyPoint: {} }),
      });
      expect(response.status).toBe(200);

      const reportDir = path.join(tempDir, "files", "delete-me");
      const historyFile = path.join(tempDir, "history", "delete-me.json");
      expect(fs.existsSync(path.join(reportDir, "index.html"))).toBe(true);
      expect(fs.existsSync(historyFile)).toBe(true);

      response = await requestAuthorized(app, "/api/report/delete-me/delete", { method: "POST" });
      expect(response.status).toBe(200);
      expect((await readJson(response)).deleted).toBe(true);
      expect(fs.existsSync(reportDir)).toBe(false);
      expect(fs.existsSync(historyFile)).toBe(false);

      response = await requestAuthorized(app, "/delete-me");
      expect(response.status).toBe(404);
      expect((await readJson(response)).error).toBe("report not found");

      response = await requestAuthorized(app, "/api/reports");
      expect(response.status).toBe(404);
      expect((await readJson(response)).error).toBe("not found");

      response = await requestAuthorized(app, "/api/report/delete-me/delete", { method: "POST" });
      expect(response.status).toBe(404);
      expect((await readJson(response)).error).toBe("report not found");
    });
  });

  it("deletes report row before cleaning files on manual delete", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-storage-delete-fail-test-"));

    class FailingDeleteStore extends FsStore {
      async delete(reportId: string): Promise<void> {
        if (reportId === "delete-atomic") {
          throw new Error("file delete failed");
        }

        await super.delete(reportId);
      }
    }

    try {
      await withApp(
        async ({ app }) => {
          let response = await requestAuthorized(app, "/api/reports/delete-atomic", {
            method: "PUT",
            ...jsonBody({ repo: REPO, branch: "main", name: "Deleted report" }),
          });
          expect(response.status).toBe(200);

          response = await requestAuthorized(app, "/api/reports/delete-atomic/complete", {
            method: "POST",
            ...jsonBody({ historyPoint: {} }),
          });
          expect(response.status).toBe(200);

          response = await requestAuthorized(app, "/api/report/delete-atomic/delete", { method: "POST" });
          expect(response.status).toBe(500);

          response = await requestAuthorized(app, "/api/report/delete-atomic/delete", { method: "POST" });
          expect(response.status).toBe(404);
          expect((await readJson(response)).error).toBe("report not found");
        },
        { fileStore: new FailingDeleteStore(path.join(tempDir, "files")) },
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns branch history with main branch fallback", async () => {
    await withApp(async ({ app }) => {
      await publishHistoryPoint(app, "main-p1", "main", "p1");
      await publishHistoryPoint(app, "main-p2", "main", "p2");
      await publishHistoryPoint(app, "main-p3", "main", "p3");
      await publishHistoryPoint(app, "child-p3-1", "child", "p3.1");
      await publishHistoryPoint(app, "child-p3-2", "child", "p3.2");
      await publishHistoryPoint(app, "child-p3-3", "child", "p3.3");
      await publishHistoryPoint(app, "main-p4", "main", "p4");
      await publishHistoryPoint(app, "main-p5", "main", "p5");

      await publishHistoryPoint(app, "other-main-p1", "main", "other-p1", OTHER_REPO);

      let response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=child&limit=5`);
      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
        "p3.3",
        "p3.2",
        "p3.1",
        "p3",
        "p2",
      ]);

      response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=child&limit=2`);
      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual(["p3.3", "p3.2"]);

      response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=child`);
      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
        "p3.3",
        "p3.2",
        "p3.1",
        "p3",
        "p2",
        "p1",
      ]);

      response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=missing&limit=3`);
      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual(["p5", "p4", "p3"]);

      response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=missing`);
      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
        "p5",
        "p4",
        "p3",
        "p2",
        "p1",
      ]);

      response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}`);
      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
        "p5",
        "p4",
        "p3",
        "p2",
        "p1",
      ]);

      response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=child&limit=0`);
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toBe("limit must be a positive integer");

      response = await requestAuthorized(app, "/api/history?branch=child");
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toBe("repo is required");
    });
  });

  it("limits history to 10 points when limit is omitted", async () => {
    await withApp(async ({ app }) => {
      for (let index = 1; index <= 11; index += 1) {
        await publishHistoryPoint(app, `default-limit-${index}`, "main", `p${index}`);
      }

      let response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}`);
      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
        "p11",
        "p10",
        "p9",
        "p8",
        "p7",
        "p6",
        "p5",
        "p4",
        "p3",
        "p2",
      ]);

      response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&limit=2`);
      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual(["p11", "p10"]);
    });
  });

  it("truncates history at a missing older point and deletes inconsistent reports", async () => {
    await withApp(async ({ app, tempDir }) => {
      await publishHistoryPoint(app, "a", "main", "a");
      await publishHistoryPoint(app, "b", "main", "b");
      await publishHistoryPoint(app, "c", "main", "c");
      await publishHistoryPoint(app, "d", "main", "d");
      await publishHistoryPoint(app, "e", "main", "e");
      deleteHistoryPoint(tempDir, "b");

      let response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=main&limit=4`);

      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual(["e", "d", "c"]);

      writeHistoryPoint(tempDir, "a", "a");
      writeHistoryPoint(tempDir, "b", "b");
      response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=main`);

      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual(["e", "d", "c"]);
    });
  });

  it("does not delete reports from another branch when branch history has a gap", async () => {
    await withApp(async ({ app, tempDir }) => {
      await publishHistoryPoint(app, "preserved-main-1", "main", "main-1");
      await publishHistoryPoint(app, "preserved-main-2", "main", "main-2");
      await publishHistoryPoint(app, "child-1", "child", "child-1");
      await publishHistoryPoint(app, "child-2", "child", "child-2");

      deleteHistoryPoint(tempDir, "child-1");

      const response = await requestAuthorized(
        app,
        `/api/history?repo=${encodeURIComponent(REPO)}&branch=child&limit=4`,
      );

      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual(["child-2"]);

      const mainResponse = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=main`);

      expect(mainResponse.status).toBe(200);
      expect((await readJson<HistoryResponse>(mainResponse)).history.map((item) => item.point)).toEqual([
        "main-2",
        "main-1",
      ]);
    });
  });

  it("deletes a missing newest point and keeps older history", async () => {
    await withApp(async ({ app, tempDir }) => {
      await publishHistoryPoint(app, "a", "main", "a");
      await publishHistoryPoint(app, "b", "main", "b");
      await publishHistoryPoint(app, "c", "main", "c");
      await publishHistoryPoint(app, "d", "main", "d");
      await publishHistoryPoint(app, "e", "main", "e");
      deleteHistoryPoint(tempDir, "e");

      let response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=main&limit=1`);

      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual(["d"]);

      response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=main`);

      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
        "d",
        "c",
        "b",
        "a",
      ]);

      writeHistoryPoint(tempDir, "e", "e");
      response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=main`);

      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
        "d",
        "c",
        "b",
        "a",
      ]);
    });
  });

  it("recovers from invalid history JSON and cleans up the report", async () => {
    await withApp(async ({ app, tempDir }) => {
      let response = await requestAuthorized(app, "/api/reports/bad-history", {
        method: "PUT",
        ...jsonBody({ repo: REPO, branch: "main", name: "Bad history" }),
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/bad-history/complete", {
        method: "POST",
        ...jsonBody({ historyPoint: { point: "ok" } }),
      });
      expect(response.status).toBe(200);

      fs.writeFileSync(historyPointPath(tempDir, "bad-history"), "not-json");

      response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=main`);

      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history).toEqual([]);
      expect(fs.existsSync(historyPointPath(tempDir, "bad-history"))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, "files", "bad-history"))).toBe(false);
    });
  });

  it("uses the configured main branch for history fallback", async () => {
    await withApp(
      async ({ app }) => {
        await publishHistoryPoint(app, "default-main-history", "main", "main-point");
        await publishHistoryPoint(app, "trunk-history-1", "trunk", "trunk-1");
        await publishHistoryPoint(app, "trunk-history-2", "trunk", "trunk-2");
        await publishHistoryPoint(app, "feature-history-1", "feature", "feature-1");

        const response = await requestAuthorized(
          app,
          `/api/history?repo=${encodeURIComponent(REPO)}&branch=feature&limit=3`,
        );

        expect(response.status).toBe(200);
        expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
          "feature-1",
          "trunk-2",
          "trunk-1",
        ]);

        const defaultBranchResponse = await requestAuthorized(
          app,
          `/api/history?repo=${encodeURIComponent(REPO)}&limit=2`,
        );

        expect(defaultBranchResponse.status).toBe(200);
        expect((await readJson<HistoryResponse>(defaultBranchResponse)).history.map((item) => item.point)).toEqual([
          "trunk-2",
          "trunk-1",
        ]);
      },
      { mainBranch: "trunk" },
    );
  });

  it("uses a project main branch for history fallback", async () => {
    await withApp(async ({ app }) => {
      let response = await requestBootstrap(app, "/api/projects/main-branch", {
        method: "POST",
        ...jsonBody({ mainBranch: "trunk", repo: REPO }),
      });

      expect(response.status).toBe(200);

      await publishHistoryPoint(app, "trunk-history-1", "trunk", "trunk-1");
      await publishHistoryPoint(app, "trunk-history-2", "trunk", "trunk-2");
      await publishHistoryPoint(app, "feature-history-1", "feature", "feature-1");

      response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&branch=feature&limit=2`);
      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
        "feature-1",
        "trunk-2",
      ]);

      response = await requestAuthorized(app, `/api/history?repo=${encodeURIComponent(REPO)}&limit=2`);
      expect(response.status).toBe(200);
      expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
        "trunk-2",
        "trunk-1",
      ]);
    });
  });

  it("renders a public report tree page", async () => {
    await withApp(async ({ app }) => {
      let response = await requestBootstrap(app, "/api/projects/main-branch", {
        method: "POST",
        ...jsonBody({ mainBranch: "trunk", repo: REPO }),
      });

      expect(response.status).toBe(200);

      const mainCreatedAt = await publishHistoryPoint(app, "tree-main-1", "trunk", "main-1");
      const childCreatedAt = await publishHistoryPoint(app, "tree-child-1", "feature", "child-1");
      response = await app.request(`/reports/tree?repo=${encodeURIComponent(REPO)}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html\b/);

      const html = await response.text();

      expect(html).not.toContain("<title>");
      expect(html).not.toContain("<h1>");
      expect(html).toContain('<div class="logo">');
      expect(html.indexOf('<div class="logo">')).toBeLessThan(html.indexOf("<ul>"));
      expect(html).toContain("width: 32px;");
      expect(html).toContain("height: 32px;");
      expect(html).toContain("font-size: 14px;");
      expect(html).toContain("color: #011228ad;");
      expect(html).toContain("trunk");
      expect(html).toContain("feature");
      expect(html).toContain("tree-main-1");
      expect(html).toContain("tree-child-1");
      expect(html).toContain('href="/tree-main-1"');
      expect(html).toContain('href="/tree-child-1"');
      expect(html).toContain(formatReportCreatedAt(mainCreatedAt));
      expect(html).toContain(formatReportCreatedAt(childCreatedAt));
      expect(html).toContain(`<time datetime="${mainCreatedAt}">${formatReportCreatedAt(mainCreatedAt)}</time>`);
      expect(html).toContain(`<time datetime="${childCreatedAt}">${formatReportCreatedAt(childCreatedAt)}</time>`);
    });
  });

  it("encodes plugin entrypoint redirects", async () => {
    await withApp(async ({ app }) => {
      const dangerousPlugin = 'x"><img src=x onerror=alert(1)>';

      let response = await requestAuthorized(app, "/api/reports/r4", {
        method: "PUT",
        ...jsonBody({ repo: REPO, branch: "main", name: "Encoded plugin redirect" }),
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/r4/upload", {
        body: createUploadFormData(`${dangerousPlugin}/index.html`, "B"),
        method: "POST",
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/reports/r4/complete", {
        method: "POST",
        ...jsonBody({ historyPoint: { total: 1 } }),
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/r4");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/r4/${encodeURIComponent(dangerousPlugin)}/index.html`);
    });
  });

  it("serves uploaded assets with extension-based content types", async () => {
    await withApp(async ({ app }) => {
      let response = await requestAuthorized(app, "/api/assets/upload", {
        body: createUploadFormData("app.js", "console.log('ok');"),
        method: "POST",
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/assets/upload", {
        body: createUploadFormData("styles.css", "body { color: red; }"),
        method: "POST",
      });
      expect(response.status).toBe(200);

      response = await requestAuthorized(app, "/api/assets/upload", {
        body: createUploadFormData(null, "missing filename"),
        method: "POST",
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toBe("filename is required");

      response = await requestAuthorized(app, "/assets/app.js");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/javascript\b/);

      response = await requestAuthorized(app, "/assets/styles.css");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/css\b/);
    });
  });
});
