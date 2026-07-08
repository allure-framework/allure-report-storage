import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildApp } from "../../../src/app.js";
import { SqliteAccessTokenRepository } from "../../../src/repositories/sqlite/accessTokens.js";
import { SqliteProjectRepository } from "../../../src/repositories/sqlite/projects.js";
import { SqliteReportRepository } from "../../../src/repositories/sqlite/reports.js";
import { FsStore } from "../../../src/storage/fs.js";

const ACCESS_TOKEN = "test-bootstrap-token";
const SECRET = "test-signing-secret";

type E2eAppContext = Awaited<ReturnType<typeof buildApp>>;

export interface E2eHarness {
  reset: () => Promise<void>;
  request: (pathname: string, init?: RequestInit & { token?: string | null }) => Promise<Response>;
  stop: () => Promise<void>;
}

export const createE2eHarness = async (): Promise<E2eHarness> => {
  let app: E2eAppContext | null = null;
  let accessToken = "";
  let baseUrl = "";
  let tempDir = "";

  const startApp = async (): Promise<void> => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "allure-report-storage-e2e-"));
    const databasePath = path.join(tempDir, "reports.sqlite");

    const repositories = {
      accessTokens: await SqliteAccessTokenRepository.create({ databasePath }),
      projects: await SqliteProjectRepository.create({ databasePath }),
      reports: await SqliteReportRepository.create({ databasePath }),
    };
    const fileStore = new FsStore(path.join(tempDir, "files"));
    app = await buildApp({ repositories, fileStore, accessToken: ACCESS_TOKEN, secret: SECRET, requestLogging: false });
    baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

    const tokenResponse = await fetch(new URL("/api/token", baseUrl), {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      method: "POST",
    });
    accessToken = ((await tokenResponse.json()) as { access_token: string }).access_token;
  };

  const closeApp = async (): Promise<void> => {
    if (app) {
      await app.close();
      app = null;
    }

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  };

  await startApp();

  return {
    reset: async () => {
      await closeApp();
      await startApp();
    },
    request: async (pathname, init = {}) => {
      const { token = accessToken, ...requestInit } = init;
      const headers = new Headers(requestInit.headers);

      if (token !== null) {
        headers.set("authorization", `Bearer ${token}`);
      }

      return fetch(new URL(pathname, baseUrl), {
        ...requestInit,
        headers,
        redirect: requestInit.redirect ?? "manual",
      });
    },
    stop: async () => {
      await closeApp();
    },
  };
};
