import { describe, expect, it } from "vitest";

import type { WorkerBindings } from "../../src/model.js";
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

const createAccessToken = async (env: WorkerBindings): Promise<string> => {
  const response = (await worker.fetch(
    new Request(new URL("/api/token", "https://allure-report-storage.example"), {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      method: "POST",
    }),
    env,
    executionContext as ExecutionContext,
  )) as Response;

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
