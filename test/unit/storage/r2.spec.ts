import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { R2Store } from "../../../src/storage/r2.js";
import { MemoryR2Bucket } from "../support/cloudflare.js";

describe("R2Store", () => {
  it("stores, lists, and deletes report files using R2 object keys", async () => {
    const bucket = new MemoryR2Bucket();
    const store = new R2Store({ bucket, prefix: "prod" });

    await store.put("r1", "index.html", new Blob(["hello"]));
    await store.put("r1", "nested/file.txt", Readable.from(["world"]));
    await store.putHistory("r1", new TextEncoder().encode('{"point":"history"}'));
    await store.put("r2", "index.html", new TextEncoder().encode("other"));

    expect(await store.exists("r1", "index.html")).toBe(true);
    expect(await store.list("r1")).toEqual(["index.html", "nested/file.txt"]);
    expect(new TextDecoder().decode((await store.get("r1", "nested/file.txt"))!)).toBe("world");
    expect(new TextDecoder().decode((await store.getHistory("r1"))!)).toBe('{"point":"history"}');

    await store.delete("r1");

    expect(await store.exists("r1", "index.html")).toBe(false);
    expect(await store.list("r1")).toEqual([]);
    expect(await store.getHistory("r1")).not.toBeNull();

    await store.deleteHistory("r1");

    expect(await store.getHistory("r1")).toBeNull();
    expect(await store.exists("r2", "index.html")).toBe(true);
  });

  it("stores shared assets separately from report files", async () => {
    const bucket = new MemoryR2Bucket();
    const store = new R2Store({ assetsPrefix: "shared", bucket, reportsPrefix: "reports" });

    await store.put("r1", "app.js", new TextEncoder().encode("report"));
    await store.putAsset("app.js", new TextEncoder().encode("asset"));

    expect(new TextDecoder().decode((await store.get("r1", "app.js"))!)).toBe("report");
    expect(new TextDecoder().decode((await store.getAsset("app.js"))!)).toBe("asset");
  });
});
