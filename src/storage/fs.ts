import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { StaticFileData, StaticFileStore } from "../model.js";
import { historyFileName } from "../utils/path.js";

const isWebReadableStream = (data: StaticFileData): data is ReadableStream<Uint8Array> =>
  typeof data === "object" &&
  data !== null &&
  "getReader" in data &&
  typeof (data as { getReader?: unknown }).getReader === "function";

const toNodeReadable = (data: Exclude<StaticFileData, Uint8Array>): NodeJS.ReadableStream => {
  if (data instanceof Blob) {
    return Readable.fromWeb(data.stream() as unknown as NodeReadableStream<Uint8Array>);
  }

  if (isWebReadableStream(data)) {
    return Readable.fromWeb(data as unknown as NodeReadableStream<Uint8Array>);
  }

  return data;
};

const writeStaticFile = async (fullPath: string, data: StaticFileData): Promise<void> => {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });

  if (data instanceof Uint8Array) {
    await fs.promises.writeFile(fullPath, data);
    return;
  }

  await pipeline(toNodeReadable(data), fs.createWriteStream(fullPath));
};

export class FsStore implements StaticFileStore {
  constructor(
    private readonly baseDir: string,
    private readonly assetsDir = path.join(path.dirname(baseDir), "assets"),
    private readonly historyDir = path.join(path.dirname(baseDir), "history"),
  ) {}

  async put(reportId: string, relativePath: string, data: StaticFileData): Promise<void> {
    const fullPath = this.resolvePath(reportId, relativePath);

    await writeStaticFile(fullPath, data);
  }

  async get(reportId: string, relativePath: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const fullPath = this.resolvePath(reportId, relativePath);

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return null;
    }

    return new Uint8Array(fs.readFileSync(fullPath));
  }

  async exists(reportId: string, relativePath: string): Promise<boolean> {
    const fullPath = this.resolvePath(reportId, relativePath);

    return fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
  }

  async list(reportId: string): Promise<string[]> {
    const root = path.join(this.baseDir, reportId);

    if (!fs.existsSync(root)) {
      return [];
    }

    const results: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(entryPath);
        } else if (entry.isFile()) {
          results.push(path.relative(root, entryPath).replaceAll("\\", "/"));
        }
      }
    };

    walk(root);

    return results;
  }

  async delete(reportId: string): Promise<void> {
    fs.rmSync(path.join(this.baseDir, reportId), { recursive: true, force: true });
  }

  async putHistory(reportId: string, data: StaticFileData): Promise<void> {
    await writeStaticFile(this.resolveHistoryPath(reportId), data);
  }

  async getHistory(reportId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const fullPath = this.resolveHistoryPath(reportId);

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return null;
    }

    const rawHistoryPoint = await readFile(fullPath);

    return new Uint8Array(rawHistoryPoint);
  }

  async deleteHistory(reportId: string): Promise<void> {
    fs.rmSync(this.resolveHistoryPath(reportId), { force: true });
  }

  async putAsset(relativePath: string, data: StaticFileData): Promise<void> {
    const fullPath = this.resolveAssetPath(relativePath);

    await writeStaticFile(fullPath, data);
  }

  async getAsset(relativePath: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const fullPath = this.resolveAssetPath(relativePath);

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return null;
    }

    return new Uint8Array(fs.readFileSync(fullPath));
  }

  private resolvePath(reportId: string, relativePath: string): string {
    return path.join(this.baseDir, reportId, relativePath);
  }

  private resolveAssetPath(relativePath: string): string {
    return path.join(this.assetsDir, relativePath);
  }

  private resolveHistoryPath(reportId: string): string {
    return path.join(this.historyDir, historyFileName(reportId));
  }
}
