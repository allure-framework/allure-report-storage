import { describe, expect, it, vi } from "vitest";

import type { WorkerBindings } from "../../src/model.js";
import { decodeAccessToken } from "../../src/utils/accessToken.js";
import worker from "../../src/worker.js";
import { MemoryD1Database, MemoryR2Bucket } from "./support/cloudflare.js";

const ACCESS_TOKEN = "test-bootstrap-token";
const SECRET = "test-signing-secret";

const createEnv = (): WorkerBindings => ({
  ACCESS_TOKEN,
  REPORTS_BUCKET: new MemoryR2Bucket(),
  REPORTS_DB: new MemoryD1Database(),
  SECRET,
});

const executionContext = {
  passThroughOnException() {},
  waitUntil() {},
};

const createAwaitableExecutionContext = () => {
  const promises: Promise<unknown>[] = [];

  return {
    context: {
      passThroughOnException() {},
      waitUntil(promise: Promise<unknown>) {
        promises.push(promise);
      },
    },
    wait: () => Promise.all(promises),
  };
};

const jsonBody = (payload: unknown): Pick<RequestInit, "body" | "headers"> => ({
  body: JSON.stringify(payload),
  headers: { "content-type": "application/json" },
});

const createAccessToken = async (
  env: WorkerBindings,
  origin = "https://allure-report-storage.example",
): Promise<string> => {
  const response = (await worker.fetch(
    new Request(new URL("/api/token", origin), {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      method: "POST",
    }),
    env,
    executionContext as ExecutionContext,
  )) as Response;

  expect(response.status).toBe(200);

  return ((await response.json()) as { access_token: string }).access_token;
};

const request = (
  env: WorkerBindings,
  pathname: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);

  if (pathname.startsWith("/api/") && pathname !== "/api/ping") {
    headers.set("authorization", `Bearer ${accessToken}`);
  }

  return worker.fetch(
    new Request(new URL(pathname, "https://allure-report-storage.example"), {
      ...init,
      headers,
      redirect: init.redirect ?? "manual",
    }),
    env,
    executionContext as ExecutionContext,
  ) as Promise<Response>;
};

describe("Cloudflare Worker entrypoint", () => {
  it.each([
    [undefined, "http://internal-storage:3000"],
    ["", "http://internal-storage:3000"],
    [" \t ", "http://internal-storage:3000"],
    ["https://reports.example.com", "https://reports.example.com"],
    [" https://Reports.Example.com:8443/ ", "https://reports.example.com:8443"],
  ])("uses the PUBLIC_URL binding %j for token generation", async (publicUrl, expectedUrl) => {
    const env = { ...createEnv(), PUBLIC_URL: publicUrl };
    const accessToken = await createAccessToken(env, "http://internal-storage:3000");

    expect(await decodeAccessToken(accessToken, SECRET)).toEqual({
      accessToken: expect.any(String),
      url: expectedUrl,
    });

    const response = await request(env, "/api/reports", accessToken, {
      ...jsonBody({ branch: "main", repo: "qameta/allure-report-storage" }),
      method: "POST",
    });

    expect(response.status).toBe(200);
  });

  it("rejects an invalid PUBLIC_URL binding instead of issuing a token", async () => {
    const env = { ...createEnv(), PUBLIC_URL: "https://reports.example.com/allure" };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await request(env, "/api/token", ACCESS_TOKEN, { method: "POST" });

      expect(response.status).toBe(500);
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("PUBLIC_URL must be") }),
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("uses D1 and R2 bindings for the report lifecycle", async () => {
    const env = createEnv();
    const accessToken = await createAccessToken(env);

    let response = await request(env, "/api/reports/r1", accessToken, {
      method: "PUT",
      ...jsonBody({ branch: "main", name: "Worker report", repo: "qameta/allure-report-storage" }),
    });
    expect(response.status).toBe(200);

    const formData = new FormData();
    formData.set("filename", "index.html");
    formData.set("file", new Blob(["<html>worker</html>"]), "index.html");

    response = await request(env, "/api/reports/r1/upload", accessToken, {
      body: formData,
      method: "POST",
    });
    expect(response.status).toBe(200);

    response = await request(env, "/api/reports/r1/complete", accessToken, {
      method: "POST",
      ...jsonBody({ historyPoint: { total: 1 } }),
    });
    expect(response.status).toBe(200);

    response = await request(env, "/api/history?repo=qameta%2Fallure-report-storage", accessToken);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { history: Array<{ total: number }> }).history).toEqual([{ total: 1 }]);

    response = await request(env, "/r1/index.html", accessToken);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("worker");
  });

  it("runs scheduled retention sweep and preserves branch newest report", async () => {
    const env = createEnv();
    const accessToken = await createAccessToken(env);

    for (const reportId of ["scheduled-1", "scheduled-2", "scheduled-3"] as const) {
      let response = await request(env, `/api/reports/${reportId}`, accessToken, {
        method: "PUT",
        ...jsonBody({ branch: "main", repo: "qameta/allure-report-storage" }),
      });
      expect(response.status).toBe(200);

      response = await request(env, `/api/reports/${reportId}/complete`, accessToken, {
        method: "POST",
        ...jsonBody({ historyPoint: { id: reportId } }),
      });
      expect(response.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    env.REPORT_RETENTION_MAX_REPORTS_PER_BRANCH = "1";

    const scheduledContext = createAwaitableExecutionContext();

    await worker.scheduled({} as ScheduledController, env, scheduledContext.context as ExecutionContext);
    await scheduledContext.wait();

    const response = await request(env, "/api/history?repo=qameta%2Fallure-report-storage", accessToken);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { history: Array<{ id: string }> }).history).toEqual([{ id: "scheduled-3" }]);
  });
});
