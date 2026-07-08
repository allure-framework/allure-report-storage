import path from "node:path";

import { S3Client } from "@aws-sdk/client-s3";

import { buildApp } from "./app.js";
import type { StaticFileStore } from "./model.js";
import { SqliteAccessTokenRepository } from "./repositories/sqlite/accessTokens.js";
import { SqliteProjectRepository } from "./repositories/sqlite/projects.js";
import { SqliteReportRepository } from "./repositories/sqlite/reports.js";
import { FsStore } from "./storage/fs.js";
import { S3Store } from "./storage/s3.js";

const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "0.0.0.0";
const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), "./data");
const accessToken = process.env.ACCESS_TOKEN;
const databasePath = process.env.DATABASE_PATH?.trim() || path.join(dataDir, "reports.sqlite");
const mainBranch = process.env.MAIN_BRANCH?.trim() || "main";
const secret = process.env.SECRET;
const storageBackend = (process.env.STORAGE_BACKEND ?? process.env.STORAGE_TYPE ?? "fs").trim().toLowerCase();

const optionalEnv = (name: string): string | undefined => process.env[name]?.trim() || undefined;

const requiredEnv = (name: string): string => {
  const value = optionalEnv(name);

  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }

  return value;
};

const parseBooleanEnv = (name: string, defaultValue: boolean): boolean => {
  const value = process.env[name]?.trim().toLowerCase();

  if (!value) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  throw new Error(`${name} must be a boolean value`);
};

const isR2Endpoint = (endpoint: string | undefined): boolean => {
  if (!endpoint) {
    return false;
  }

  try {
    return new URL(endpoint).hostname.toLowerCase().endsWith(".r2.cloudflarestorage.com");
  } catch {
    return false;
  }
};

const normalizeR2Endpoint = (endpoint: string | undefined, bucket: string): string | undefined => {
  if (!endpoint || !isR2Endpoint(endpoint)) {
    return endpoint;
  }

  const url = new URL(endpoint);
  const bucketPrefix = `${bucket.toLowerCase()}.`;
  const hostname = url.hostname.toLowerCase();

  if (hostname.startsWith(bucketPrefix)) {
    url.hostname = hostname.slice(bucketPrefix.length);
    url.pathname = "";
    url.search = "";
    url.hash = "";

    return url.toString().replace(/\/$/, "");
  }

  return endpoint;
};

const resolveForcePathStyle = (endpoint: string | undefined): boolean => {
  if (isR2Endpoint(endpoint)) {
    const explicit = optionalEnv("S3_FORCE_PATH_STYLE");

    if (explicit !== undefined) {
      parseBooleanEnv("S3_FORCE_PATH_STYLE", false);
    }

    return false;
  }

  return parseBooleanEnv("S3_FORCE_PATH_STYLE", endpoint !== undefined);
};

const createFileStore = (): StaticFileStore => {
  if (storageBackend === "fs") {
    return new FsStore(path.join(dataDir, "files"));
  }

  if (storageBackend === "s3") {
    const bucket = requiredEnv("S3_BUCKET");
    const endpoint = normalizeR2Endpoint(optionalEnv("S3_ENDPOINT"), bucket);
    const accessKeyId = optionalEnv("S3_ACCESS_KEY_ID") ?? optionalEnv("AWS_ACCESS_KEY_ID");
    const secretAccessKey = optionalEnv("S3_SECRET_ACCESS_KEY") ?? optionalEnv("AWS_SECRET_ACCESS_KEY");
    const sessionToken = optionalEnv("S3_SESSION_TOKEN") ?? optionalEnv("AWS_SESSION_TOKEN");

    if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
      throw new Error(
        "Both S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are required when either is set",
      );
    }

    return new S3Store({
      assetsPrefix: optionalEnv("S3_ASSETS_PREFIX"),
      bucket,
      client: new S3Client({
        credentials:
          accessKeyId && secretAccessKey
            ? {
                accessKeyId,
                secretAccessKey,
                sessionToken,
              }
            : undefined,
        endpoint,
        forcePathStyle: resolveForcePathStyle(endpoint),
        region: optionalEnv("S3_REGION") ?? "us-east-1",
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      }),
      prefix: optionalEnv("S3_PREFIX"),
      reportsPrefix: optionalEnv("S3_REPORTS_PREFIX"),
    });
  }

  throw new Error(`Unsupported STORAGE_BACKEND value: ${storageBackend}`);
};

const main = async (): Promise<void> => {
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new Error("ACCESS_TOKEN environment variable is required");
  }

  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new Error("SECRET environment variable is required");
  }

  const repositories = {
    accessTokens: await SqliteAccessTokenRepository.create({ databasePath }),
    projects: await SqliteProjectRepository.create({ databasePath }),
    reports: await SqliteReportRepository.create({ databasePath }),
  };
  const fileStore = createFileStore();
  const app = await buildApp({ repositories, fileStore, accessToken, mainBranch, secret });

  await app.listen({ port, host });
};

void main();
