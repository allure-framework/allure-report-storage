import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createE2eHarness } from "../support/harness.js";

const extractReportId = (reportUrl: string): string => decodeURIComponent(reportUrl.replace(/^\//, ""));

const readJson = async <T = any>(response: Response): Promise<T> => response.json() as Promise<T>;

const REPO = "qameta/allure-report-storage";

type HistoryResponse = { history: Array<{ point: string }> };

const pauseForHistoryOrdering = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 2));
};

const createUploadFormData = (filename: string, file: Buffer | string): FormData => {
  const formData = new FormData();
  const body = Buffer.isBuffer(file) ? file : Buffer.from(file);

  formData.set("filename", filename);
  formData.set("file", new Blob([new Uint8Array(body)], { type: "application/octet-stream" }), "file");

  return formData;
};

describe("reports API e2e", () => {
  let harness: Awaited<ReturnType<typeof createE2eHarness>>;

  beforeAll(async () => {
    harness = await createE2eHarness();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    if (harness) {
      await harness.stop();
    }
  });

  it("protects report and asset mutation endpoints", async () => {
    let response = await harness.request("/api/ping", { token: null });
    expect(response.status).toBe(200);
    expect((await readJson(response)).pong).toBe(true);

    response = await harness.request("/api/reports", {
      body: JSON.stringify({ repo: REPO, branch: "main", name: "Unauthorized" }),
      headers: { "content-type": "application/json" },
      method: "POST",
      token: null,
    });
    expect(response.status).toBe(401);
    expect((await readJson(response)).error).toBe("unauthorized");
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="allure-report-storage"');

    response = await harness.request("/api/reports", {
      body: JSON.stringify({ repo: REPO, branch: "main", name: "Wrong token" }),
      headers: { "content-type": "application/json" },
      method: "POST",
      token: "wrong-token",
    });
    expect(response.status).toBe(401);

    response = await harness.request("/api/assets/upload", {
      body: createUploadFormData("app.js", "console.log('blocked');"),
      method: "POST",
      token: null,
    });
    expect(response.status).toBe(401);
  });

  it("publishes a report and serves it over real HTTP", async () => {
    let response = await harness.request("/api/reports", {
      body: JSON.stringify({ repo: REPO, branch: "main", name: "Generated draft" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);

    const reportId = extractReportId((await readJson(response)).url);

    response = await harness.request(`/api/reports/${encodeURIComponent(reportId)}/upload`, {
      body: createUploadFormData("index.html", "<html><body>published</body></html>"),
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request(`/api/reports/${encodeURIComponent(reportId)}/complete`, {
      body: JSON.stringify({ historyPoint: { total: 10 } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect((await readJson(response)).report.status).toBe("completed");

    response = await harness.request(`/${encodeURIComponent(reportId)}`, { token: null });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/${encodeURIComponent(reportId)}/index.html`);

    response = await harness.request(`/${encodeURIComponent(reportId)}/index.html`, { token: null });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("published");
  });

  it("makes completed reports immutable", async () => {
    let response = await harness.request("/api/reports/immutable-report", {
      body: JSON.stringify({ repo: REPO, branch: "main", name: "Immutable draft" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/reports/immutable-report/upload", {
      body: createUploadFormData("index.html", "<html>locked</html>"),
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/reports/immutable-report/complete", {
      body: JSON.stringify({ historyPoint: { total: 1 } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/reports/immutable-report/complete", {
      body: JSON.stringify({ historyPoint: { total: 2 } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(409);
    expect((await readJson(response)).error).toBe("report already completed");

    response = await harness.request("/api/reports/immutable-report/upload", {
      body: createUploadFormData("another.html", "blocked"),
      method: "POST",
    });
    expect(response.status).toBe(409);
    expect((await readJson(response)).error).toBe("completed report is immutable");

    response = await harness.request("/api/reports/immutable-report", {
      body: JSON.stringify({ repo: REPO, branch: "release", name: "Blocked update" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(response.status).toBe(409);
    expect((await readJson(response)).error).toBe("completed report is immutable");
  });

  it("does not expose completed report discovery endpoints", async () => {
    const publish = async (reportId: string, branch: string, total: number): Promise<void> => {
      let response = await harness.request(`/api/reports/${reportId}`, {
        body: JSON.stringify({ repo: REPO, branch, name: reportId }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      expect(response.status).toBe(200);

      response = await harness.request(`/api/reports/${reportId}/upload`, {
        body: createUploadFormData("index.html", `<html>${reportId}</html>`),
        method: "POST",
      });
      expect(response.status).toBe(200);

      response = await harness.request(`/api/reports/${reportId}/complete`, {
        body: JSON.stringify({ historyPoint: { total } }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(response.status).toBe(200);
    };

    await publish("branch-report-001", "release", 1);
    await publish("branch-report-002", "main", 2);
    await publish("branch-report-003", "main", 3);

    let response = await harness.request("/api/reports");
    expect(response.status).toBe(404);
    expect((await readJson(response)).error).toBe("not found");

    response = await harness.request(`/api/reports?repo=${encodeURIComponent(REPO)}&branch=release`);
    expect(response.status).toBe(404);
    expect((await readJson(response)).error).toBe("not found");

    response = await harness.request(`/api/reports/latest?repo=${encodeURIComponent(REPO)}&branch=main`);
    expect(response.status).toBe(404);
    expect((await readJson(response)).error).toBe("not found");
  });

  it("deletes reports and their static files", async () => {
    let response = await harness.request("/api/reports/delete-e2e", {
      body: JSON.stringify({ repo: REPO, branch: "main", name: "Delete e2e" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/reports/delete-e2e/upload", {
      body: createUploadFormData("index.html", "<html>delete e2e</html>"),
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/reports/delete-e2e/complete", {
      body: JSON.stringify({ historyPoint: { total: 1 } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/report/delete-e2e/delete", { method: "POST" });
    expect(response.status).toBe(200);
    expect((await readJson(response)).deleted).toBe(true);

    response = await harness.request("/delete-e2e", { token: null });
    expect(response.status).toBe(404);
    expect((await readJson(response)).error).toBe("report not found");

    response = await harness.request("/delete-e2e/index.html", { token: null });
    expect(response.status).toBe(404);
    expect((await readJson(response)).error).toBe("report not found");

    response = await harness.request("/api/report/delete-e2e/delete", { method: "POST" });
    expect(response.status).toBe(404);
    expect((await readJson(response)).error).toBe("report not found");
  });

  it("downloads branch history with main branch fallback", async () => {
    const publish = async (reportId: string, branch: string, point: string): Promise<void> => {
      let response = await harness.request(`/api/reports/${reportId}`, {
        body: JSON.stringify({ repo: REPO, branch, name: point }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      expect(response.status).toBe(200);

      response = await harness.request(`/api/reports/${reportId}/complete`, {
        body: JSON.stringify({ historyPoint: { point } }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(response.status).toBe(200);

      await pauseForHistoryOrdering();
    };

    await publish("main-history-1", "main", "p1");
    await publish("main-history-2", "main", "p2");
    await publish("main-history-3", "main", "p3");
    await publish("child-history-1", "child", "p3.1");
    await publish("child-history-2", "child", "p3.2");
    await publish("child-history-3", "child", "p3.3");
    await publish("main-history-4", "main", "p4");
    await publish("main-history-5", "main", "p5");

    let response = await harness.request(`/api/history?repo=${encodeURIComponent(REPO)}&branch=child&limit=5`);
    expect(response.status).toBe(200);
    expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
      "p3.3",
      "p3.2",
      "p3.1",
      "p3",
      "p2",
    ]);

    response = await harness.request(`/api/history?repo=${encodeURIComponent(REPO)}&branch=child`);
    expect(response.status).toBe(200);
    expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
      "p3.3",
      "p3.2",
      "p3.1",
      "p3",
      "p2",
      "p1",
    ]);

    response = await harness.request(`/api/history?repo=${encodeURIComponent(REPO)}&branch=missing`);
    expect(response.status).toBe(200);
    expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
      "p5",
      "p4",
      "p3",
      "p2",
      "p1",
    ]);

    response = await harness.request(`/api/history?repo=${encodeURIComponent(REPO)}&limit=2`);
    expect(response.status).toBe(200);
    expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual(["p5", "p4"]);
  });

  it("uses a project main branch for history fallback", async () => {
    let response = await harness.request("/api/projects/main-branch", {
      body: JSON.stringify({ mainBranch: "trunk", repo: REPO }),
      headers: { "content-type": "application/json" },
      method: "POST",
      token: "test-bootstrap-token",
    });
    expect(response.status).toBe(200);

    for (const [reportId, branch, point] of [
      ["trunk-history-1", "trunk", "trunk-1"],
      ["trunk-history-2", "trunk", "trunk-2"],
      ["feature-history-1", "feature", "feature-1"],
    ] as const) {
      response = await harness.request(`/api/reports/${reportId}`, {
        body: JSON.stringify({ repo: REPO, branch, name: point }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      expect(response.status).toBe(200);

      response = await harness.request(`/api/reports/${reportId}/complete`, {
        body: JSON.stringify({ historyPoint: { point } }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(response.status).toBe(200);

      await pauseForHistoryOrdering();
    }

    response = await harness.request(`/api/history?repo=${encodeURIComponent(REPO)}&branch=feature&limit=2`);
    expect(response.status).toBe(200);
    expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
      "feature-1",
      "trunk-2",
    ]);

    response = await harness.request(`/api/history?repo=${encodeURIComponent(REPO)}&limit=2`);
    expect(response.status).toBe(200);
    expect((await readJson<HistoryResponse>(response)).history.map((item) => item.point)).toEqual([
      "trunk-2",
      "trunk-1",
    ]);
  });

  it("handles plugin entrypoints and static asset content types", async () => {
    let response = await harness.request("/api/reports/plugin-root-report", {
      body: JSON.stringify({ repo: REPO, branch: "main", name: "Plugin root" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/reports/plugin-root-report/upload", {
      body: createUploadFormData("plugin-a/index.html", "<html>plugin-a</html>"),
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/reports/plugin-root-report/upload", {
      body: createUploadFormData("widgets/summary.json", '{"total":1}'),
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/reports/plugin-root-report/upload", {
      body: createUploadFormData("plugin-a/data/test-results/case.json", '{"uid":"case"}'),
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/assets/upload", {
      body: createUploadFormData("plugin-style.css", "body { color: green; }"),
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/reports/plugin-root-report/complete", {
      body: JSON.stringify({ historyPoint: { total: 1 } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/plugin-root-report", { token: null });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/plugin-root-report/plugin-a/index.html");

    response = await harness.request("/plugin-root-report/plugin-a/index.html", { token: null });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("plugin-a");

    response = await harness.request("/plugin-root-report/plugin-a", { token: null });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/plugin-root-report/plugin-a/index.html");

    response = await harness.request("/plugin-root-report/plugin-a/widgets/summary.json", { token: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ total: 1 });

    response = await harness.request("/plugin-root-report/data/test-results/case.json", { token: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ uid: "case" });

    response = await harness.request("/plugin-root-report/plugin-a/data/test-results/case.json", { token: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ uid: "case" });

    response = await harness.request("/plugin-root-report/plugin-a/plugin-style.css", { token: null });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/css\b/);

    const dangerousPlugin = 'x"><img src=x onerror=alert(1)>';

    response = await harness.request("/api/reports/encoded-plugin-report", {
      body: JSON.stringify({ repo: REPO, branch: "main", name: "Encoded plugin root" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/reports/encoded-plugin-report/upload", {
      body: createUploadFormData(`${dangerousPlugin}/index.html`, "<html>encoded</html>"),
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/reports/encoded-plugin-report/complete", {
      body: JSON.stringify({ historyPoint: { total: 2 } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/encoded-plugin-report", { token: null });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `/encoded-plugin-report/${encodeURIComponent(dangerousPlugin)}/index.html`,
    );

    response = await harness.request("/api/reports/asset-types-report", {
      body: JSON.stringify({ repo: REPO, branch: "main", name: "Asset headers" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(response.status).toBe(200);

    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    response = await harness.request("/api/assets/upload", {
      body: createUploadFormData("app.js", "console.log('ok');"),
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/assets/upload", {
      body: createUploadFormData("styles.css", "body { color: red; }"),
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/assets/upload", {
      body: createUploadFormData("image.png", pngBytes),
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/api/reports/asset-types-report/complete", {
      body: JSON.stringify({ historyPoint: { total: 3 } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await harness.request("/assets/app.js", { token: null });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/javascript\b/);
    expect(await response.text()).toContain("console.log");

    response = await harness.request("/assets/styles.css");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/css\b/);

    response = await harness.request("/assets/image.png");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(pngBytes);
  });
});
