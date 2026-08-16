import { describe, expect, it } from "vitest";

import { buildApp } from "../../../src/app.js";
import { SqliteAccessTokenRepository } from "../../../src/repositories/sqlite/accessTokens.js";
import { SqliteProjectRepository } from "../../../src/repositories/sqlite/projects.js";
import { SqliteReportRepository } from "../../../src/repositories/sqlite/reports.js";
import { FsStore } from "../../../src/storage/fs.js";
import { decodeAccessToken } from "../../../src/utils/accessToken.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ACCESS_TOKEN = "test-bootstrap-token";
const SECRET = "test-signing-secret";

type TestApp = Awaited<ReturnType<typeof buildApp>>;

const withApp = async (
  run: (app: TestApp) => Promise<void>,
  appOptions: Partial<Parameters<typeof buildApp>[0]> = {},
) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-storage-token-test-"));
  const app = await buildApp({
    accessToken: ACCESS_TOKEN,
    fileStore: new FsStore(path.join(tempDir, "files")),
    repositories: {
      accessTokens: await SqliteAccessTokenRepository.create({ databasePath: ":memory:" }),
      projects: await SqliteProjectRepository.create({ databasePath: ":memory:" }),
      reports: await SqliteReportRepository.create({ databasePath: ":memory:" }),
    },
    requestLogging: false,
    secret: SECRET,
    ...appOptions,
  });

  try {
    await run(app);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

const mintTokenUrl = async (app: TestApp, headers: Record<string, string> = {}): Promise<string> => {
  const response = await app.request("/api/token", {
    headers: { authorization: `Bearer ${ACCESS_TOKEN}`, ...headers },
    method: "POST",
  });

  expect(response.status).toBe(200);

  const { access_token: accessToken } = (await response.json()) as { access_token: string };
  const payload = await decodeAccessToken(accessToken, SECRET);

  expect(payload).not.toBeNull();

  return payload!.url;
};

describe("POST /api/token — embedded service url", () => {
  it("uses the request origin when no proxy headers or publicUrl are present", async () => {
    await withApp(async (app) => {
      expect(await mintTokenUrl(app)).toBe("http://localhost");
    });
  });

  it("honors X-Forwarded-Proto so tokens minted behind a TLS-terminating proxy embed https", async () => {
    await withApp(async (app) => {
      expect(await mintTokenUrl(app, { "x-forwarded-proto": "https" })).toBe("https://localhost");
    });
  });

  it("honors X-Forwarded-Host alongside X-Forwarded-Proto", async () => {
    await withApp(async (app) => {
      expect(
        await mintTokenUrl(app, {
          "x-forwarded-host": "reports.example.com",
          "x-forwarded-proto": "https",
        }),
      ).toBe("https://reports.example.com");
    });
  });

  it("uses only the first value of comma-separated forwarded headers", async () => {
    await withApp(async (app) => {
      expect(
        await mintTokenUrl(app, {
          "x-forwarded-host": "reports.example.com, internal.proxy",
          "x-forwarded-proto": "https, http",
        }),
      ).toBe("https://reports.example.com");
    });
  });

  it("prefers an explicitly configured publicUrl over request origin and forwarded headers", async () => {
    await withApp(
      async (app) => {
        expect(await mintTokenUrl(app, { "x-forwarded-proto": "http" })).toBe("https://reports.example.com");
      },
      { publicUrl: "https://reports.example.com/" },
    );
  });
});
