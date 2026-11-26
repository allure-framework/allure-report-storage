// Keeps report files and history points gzipped in a SQLite database instead of one file each.
//
// A report holds thousands of small JSON files (two per test, ~0.4-3 KB). On a filesystem each one takes a
// whole block (4 KB on ext4), so a report takes about twice its size on disk; gzipped in SQLite pages it
// takes about a fifth of that. Shared assets (the plugins' scripts, stored once per Allure version) and files above
// MAX_BLOB_BYTES stay in the wrapped store.
//
// Off unless REPORT_FILES_STORE=sqlite. Reads fall back to the wrapped store, so reports written before the
// flag was turned on keep working until retention removes them; turning the flag off again loses access to
// the reports written while it was on.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";

import type { StaticFileData, StaticFileStore, StaticFileWriteOptions } from "../model.js";

// Larger files (videos, big attachments) gain little from avoiding block rounding and would be buffered
// in memory, so they go to the wrapped store.
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

const readAll = async (data: StaticFileData): Promise<Uint8Array> => {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }

  if ("getReader" in data && typeof data.getReader === "function") {
    return new Uint8Array(await new Response(data as ReadableStream<Uint8Array>).arrayBuffer());
  }

  const chunks: Buffer[] = [];

  for await (const chunk of data as Readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }

  return Buffer.concat(chunks);
};

const toArrayBufferView = (data: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(data);

export class SqliteFilesStore implements StaticFileStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly fallback: StaticFileStore,
  ) {}

  static open(databasePath: string, fallback: StaticFileStore): SqliteFilesStore {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });

    const db = new DatabaseSync(databasePath);

    // auto_vacuum only takes effect on a new database, before the first table exists.
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_files (
        report_id TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (report_id, path)
      );
      CREATE TABLE IF NOT EXISTS report_history (
        report_id TEXT PRIMARY KEY,
        data BLOB NOT NULL
      );
    `);

    return new SqliteFilesStore(db, fallback);
  }

  async put(
    reportId: string,
    relativePath: string,
    data: StaticFileData,
    options?: StaticFileWriteOptions,
  ): Promise<void> {
    if (options?.contentLength !== undefined && options.contentLength > MAX_BLOB_BYTES) {
      return this.fallback.put(reportId, relativePath, data, options);
    }

    const bytes = await readAll(data);

    if (options?.contentLength !== undefined && bytes.byteLength !== options.contentLength) {
      throw new Error(`uploaded file size mismatch: expected ${options.contentLength}, received ${bytes.byteLength}`);
    }

    if (bytes.byteLength > MAX_BLOB_BYTES) {
      return this.fallback.put(reportId, relativePath, bytes, options);
    }

    this.db
      .prepare("INSERT OR REPLACE INTO report_files (report_id, path, size, data) VALUES (?, ?, ?, ?)")
      .run(reportId, relativePath, bytes.byteLength, gzipSync(bytes));
  }

  async get(reportId: string, relativePath: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const row = this.db
      .prepare("SELECT data FROM report_files WHERE report_id = ? AND path = ?")
      .get(reportId, relativePath) as { data: Uint8Array } | undefined;

    return row ? toArrayBufferView(gunzipSync(row.data)) : this.fallback.get(reportId, relativePath);
  }

  async exists(reportId: string, relativePath: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 FROM report_files WHERE report_id = ? AND path = ?")
      .get(reportId, relativePath);

    return row !== undefined || this.fallback.exists(reportId, relativePath);
  }

  async list(reportId: string): Promise<string[]> {
    const rows = this.db.prepare("SELECT path FROM report_files WHERE report_id = ?").all(reportId) as {
      path: string;
    }[];

    return [...new Set([...rows.map((row) => row.path), ...(await this.fallback.list(reportId))])];
  }

  async delete(reportId: string): Promise<void> {
    this.db.prepare("DELETE FROM report_files WHERE report_id = ?").run(reportId);
    this.reclaimSpace();
    await this.fallback.delete(reportId);
  }

  async putHistory(reportId: string, data: StaticFileData): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO report_history (report_id, data) VALUES (?, ?)")
      .run(reportId, gzipSync(await readAll(data)));
  }

  async getHistory(reportId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const row = this.db.prepare("SELECT data FROM report_history WHERE report_id = ?").get(reportId) as
      | { data: Uint8Array }
      | undefined;

    return row ? toArrayBufferView(gunzipSync(row.data)) : this.fallback.getHistory(reportId);
  }

  async deleteHistory(reportId: string): Promise<void> {
    this.db.prepare("DELETE FROM report_history WHERE report_id = ?").run(reportId);
    await this.fallback.deleteHistory(reportId);
  }

  async putAsset(relativePath: string, data: StaticFileData, options?: StaticFileWriteOptions): Promise<void> {
    return this.fallback.putAsset(relativePath, data, options);
  }

  async getAsset(relativePath: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.fallback.getAsset(relativePath);
  }

  close(): void {
    this.db.close();
  }

  // Returns the pages freed by deleted reports to the filesystem, so the volume shrinks with retention.
  private reclaimSpace(): void {
    this.db.exec("PRAGMA incremental_vacuum");
  }
}

// Wraps the configured store when REPORT_FILES_STORE=sqlite; returns it unchanged otherwise.
export const withSqliteReportFiles = (
  store: StaticFileStore,
  dataDir: string,
  env: (name: string) => string | undefined = (name) => process.env[name],
): StaticFileStore => {
  const mode = (env("REPORT_FILES_STORE") ?? "").trim().toLowerCase();

  if (mode === "" || mode === "default") {
    return store;
  }

  if (mode !== "sqlite") {
    throw new Error(`Unsupported REPORT_FILES_STORE value: ${mode} (use sqlite, or leave it unset)`);
  }

  const databasePath = env("REPORT_FILES_DATABASE_PATH")?.trim() || path.join(dataDir, "report-files.sqlite");

  return SqliteFilesStore.open(databasePath, store);
};
