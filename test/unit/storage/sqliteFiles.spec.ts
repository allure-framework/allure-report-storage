import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { FsStore } from "../../../src/storage/fs.js";
import { SqliteFilesStore, withSqliteReportFiles } from "../../../src/storage/sqliteFiles.js";

const tempDirs: string[] = [];
const openStores: SqliteFilesStore[] = [];

const createStores = (): { root: string; fallback: FsStore; store: SqliteFilesStore } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-storage-sqlite-files-test-"));
  const fallback = new FsStore(path.join(root, "files"));
  const store = SqliteFilesStore.open(path.join(root, "report-files.sqlite"), fallback);

  tempDirs.push(root);
  openStores.push(store);

  return { root, fallback, store };
};

const text = (data: Uint8Array | null): string | null => (data ? new TextDecoder().decode(data) : null);

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }

  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("SqliteFilesStore", () => {
  it("stores report files in the database, not on the filesystem", async () => {
    const { root, store } = createStores();
    const json = JSON.stringify({ labels: Array.from({ length: 50 }, (_, i) => ({ name: "tag", value: `v${i}` })) });

    await store.put("r1", "awesome/data/test-results/a.json", new TextEncoder().encode(json));

    expect(text(await store.get("r1", "awesome/data/test-results/a.json"))).toBe(json);
    expect(await store.exists("r1", "awesome/data/test-results/a.json")).toBe(true);
    expect(await store.list("r1")).toEqual(["awesome/data/test-results/a.json"]);
    expect(fs.existsSync(path.join(root, "files", "r1"))).toBe(false);
  });

  it("accepts every upload body type and checks the declared length", async () => {
    const { store } = createStores();

    await store.put("r1", "a.json", Readable.from(["node ", "stream"]), { contentLength: 11 });
    await store.put("r1", "b.json", new Blob(["blob"]));
    await store.put("r1", "c.json", new Response("web stream").body!);

    expect(text(await store.get("r1", "a.json"))).toBe("node stream");
    expect(text(await store.get("r1", "b.json"))).toBe("blob");
    expect(text(await store.get("r1", "c.json"))).toBe("web stream");
    await expect(store.put("r1", "d.json", Readable.from(["short"]), { contentLength: 99 })).rejects.toThrow(
      "uploaded file size mismatch",
    );
    expect(await store.exists("r1", "d.json")).toBe(false);
  });

  it("replaces a file that is uploaded again", async () => {
    const { store } = createStores();

    await store.put("r1", "index.html", new TextEncoder().encode("original"));
    await store.put("r1", "index.html", new TextEncoder().encode("replacement"));

    expect(text(await store.get("r1", "index.html"))).toBe("replacement");
    expect(await store.list("r1")).toEqual(["index.html"]);
  });

  it("reads reports written before the flag from the wrapped store", async () => {
    const { fallback, store } = createStores();

    await fallback.put("old", "index.html", new TextEncoder().encode("from disk"));
    await fallback.putHistory("old", new TextEncoder().encode('{"uuid":"old"}'));

    expect(text(await store.get("old", "index.html"))).toBe("from disk");
    expect(await store.exists("old", "index.html")).toBe(true);
    expect(text(await store.getHistory("old"))).toBe('{"uuid":"old"}');
    expect(await store.get("old", "missing.json")).toBeNull();
  });

  it("deletes a report from both places", async () => {
    const { fallback, store } = createStores();

    await store.put("r1", "a.json", new TextEncoder().encode("db"));
    await fallback.put("r1", "b.json", new TextEncoder().encode("disk"));
    await store.putHistory("r1", new TextEncoder().encode("history"));

    await store.delete("r1");
    await store.deleteHistory("r1");

    expect(await store.list("r1")).toEqual([]);
    expect(await store.getHistory("r1")).toBeNull();
  });

  it("keeps shared assets in the wrapped store", async () => {
    const { root, store } = createStores();

    await store.putAsset("app-123.js", new TextEncoder().encode("console.log(1)"));

    expect(text(await store.getAsset("app-123.js"))).toBe("console.log(1)");
    expect(fs.existsSync(path.join(root, "assets", "app-123.js"))).toBe(true);
  });

  it("leaves files above the size limit in the wrapped store", async () => {
    const { root, store } = createStores();
    const big = new Uint8Array(9 * 1024 * 1024);

    await store.put("r1", "attachments/video.webm", big, { contentLength: big.byteLength });

    expect(fs.existsSync(path.join(root, "files", "r1", "attachments", "video.webm"))).toBe(true);
    expect((await store.get("r1", "attachments/video.webm"))?.byteLength).toBe(big.byteLength);
  });
});

describe("withSqliteReportFiles", () => {
  it("returns the configured store when the flag is not set", () => {
    const fallback = new FsStore(path.join(os.tmpdir(), "unused"));

    expect(withSqliteReportFiles(fallback, os.tmpdir(), () => undefined)).toBe(fallback);
  });

  it("wraps the store when REPORT_FILES_STORE=sqlite", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-storage-sqlite-flag-test-"));
    const fallback = new FsStore(path.join(root, "files"));

    tempDirs.push(root);

    const store = withSqliteReportFiles(fallback, root, (name) =>
      name === "REPORT_FILES_STORE" ? "sqlite" : undefined,
    ) as SqliteFilesStore;

    openStores.push(store);

    expect(store).toBeInstanceOf(SqliteFilesStore);
    expect(fs.existsSync(path.join(root, "report-files.sqlite"))).toBe(true);
  });

  it("rejects an unknown value", () => {
    expect(() =>
      withSqliteReportFiles(new FsStore(os.tmpdir()), os.tmpdir(), (name) =>
        name === "REPORT_FILES_STORE" ? "postgres" : undefined,
      ),
    ).toThrow("Unsupported REPORT_FILES_STORE value");
  });
});
