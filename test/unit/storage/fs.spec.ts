import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { FsStore } from "../../../src/storage/fs.js";

const tempDirs: string[] = [];

const createStore = (): { root: string; store: FsStore } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-storage-fs-test-"));

  tempDirs.push(root);

  return {
    root,
    store: new FsStore(path.join(root, "files")),
  };
};

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("FsStore", () => {
  it("atomically replaces streamed files after validating their length", async () => {
    const { root, store } = createStore();

    await store.put("r1", "index.html", new TextEncoder().encode("original"));
    await store.put("r1", "index.html", Readable.from(["replacement"]), { contentLength: 11 });

    expect(new TextDecoder().decode((await store.get("r1", "index.html"))!)).toBe("replacement");
    expect(fs.readdirSync(path.join(root, "files", "r1"))).toEqual(["index.html"]);
  });

  it("keeps the previous file and removes temporary data when a stream fails", async () => {
    const { root, store } = createStore();

    await store.put("r1", "index.html", new TextEncoder().encode("original"));

    const failedStream = Readable.from(
      (async function* () {
        yield "partial";
        throw new Error("client disconnected");
      })(),
    );

    await expect(store.put("r1", "index.html", failedStream, { contentLength: 100 })).rejects.toThrow(
      "client disconnected",
    );

    expect(new TextDecoder().decode((await store.get("r1", "index.html"))!)).toBe("original");
    expect(fs.readdirSync(path.join(root, "files", "r1"))).toEqual(["index.html"]);
  });

  it("rejects a completed stream whose length does not match", async () => {
    const { root, store } = createStore();

    await expect(
      store.put("r1", "file.txt", Readable.from(["short"]), {
        contentLength: 10,
      }),
    ).rejects.toThrow("uploaded file size mismatch: expected 10, received 5");

    expect(await store.get("r1", "file.txt")).toBeNull();
    expect(fs.readdirSync(path.join(root, "files", "r1"))).toEqual([]);
  });
});
