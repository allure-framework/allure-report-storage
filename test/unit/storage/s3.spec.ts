import { Readable } from "node:stream";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { S3Store } from "../../../src/storage/s3.js";

const createNotFoundError = (): Error & { $metadata: { httpStatusCode: number } } =>
  Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 }, name: "NoSuchKey" });

const isWebReadableStream = (body: unknown): body is ReadableStream<Uint8Array> =>
  typeof body === "object" &&
  body !== null &&
  "getReader" in body &&
  typeof (body as { getReader?: unknown }).getReader === "function";

const isAsyncIterable = (body: unknown): body is AsyncIterable<Buffer | Uint8Array | string> =>
  typeof body === "object" && body !== null && Symbol.asyncIterator in body;

const bodyToBuffer = async (body: unknown): Promise<Buffer> => {
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }

  if (isWebReadableStream(body)) {
    const chunks: Buffer[] = [];
    const reader = body.getReader();

    while (true) {
      const result = await reader.read();

      if (result.done) {
        return Buffer.concat(chunks);
      }

      chunks.push(Buffer.from(result.value));
    }
  }

  if (isAsyncIterable(body)) {
    const chunks: Buffer[] = [];

    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  throw new Error("unsupported body type");
};

const createS3Client = (objects = new Map<string, Buffer>()) => {
  const send = vi.fn(async (command: unknown): Promise<unknown> => {
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key;

      if (!key) {
        throw new Error("missing key");
      }

      expect(command.input.Bucket).toBe("bucket");
      objects.set(key, await bodyToBuffer(command.input.Body));

      return {};
    }

    if (command instanceof GetObjectCommand) {
      const key = command.input.Key;
      const body = key ? objects.get(key) : undefined;

      if (!body) {
        throw createNotFoundError();
      }

      return {
        Body: {
          transformToByteArray: async () => new Uint8Array(body),
        },
      };
    }

    if (command instanceof HeadObjectCommand) {
      const key = command.input.Key;

      if (!key || !objects.has(key)) {
        throw createNotFoundError();
      }

      return {};
    }

    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      const offset = Number(command.input.ContinuationToken ?? "0");
      const keys = Array.from(objects.keys())
        .filter((key) => key.startsWith(prefix))
        .sort();
      const pageKeys = keys.slice(offset, offset + 2);

      return {
        Contents: pageKeys.map((Key) => ({ Key })),
        NextContinuationToken: offset + 2 < keys.length ? String(offset + 2) : undefined,
      };
    }

    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        if (object.Key) {
          objects.delete(object.Key);
        }
      }

      return {};
    }

    throw new Error("unsupported command");
  });

  return { client: { send } as unknown as Pick<S3Client, "send">, objects, send };
};

const expectBytes = async (actual: Promise<Uint8Array<ArrayBuffer> | null>, expected: string): Promise<void> => {
  const bytes = await actual;

  expect(bytes).not.toBeNull();
  expect(Buffer.from(bytes!)).toEqual(Buffer.from(expected));
};

describe("S3Store", () => {
  it("stores and reads report files and shared assets", async () => {
    const { client, objects } = createS3Client();
    const store = new S3Store({
      assetsPrefix: "shared",
      bucket: "bucket",
      client,
      prefix: "env",
      reportsPrefix: "reports",
    });

    await store.put("r1", "index.html", new Uint8Array(Buffer.from("home")));
    await store.put("r1", "blob.txt", new Blob(["blob"]));
    await store.put("r1", "node.txt", Readable.from(["node"]));
    await store.putAsset("app.js", new Blob(["asset"]).stream());
    await store.putHistory("r1", new TextEncoder().encode('{"point":"history"}'));

    expect(Array.from(objects.keys()).sort()).toEqual([
      "env/history/r1.json",
      "env/reports/r1/blob.txt",
      "env/reports/r1/index.html",
      "env/reports/r1/node.txt",
      "env/shared/app.js",
    ]);
    await expectBytes(store.get("r1", "index.html"), "home");
    await expectBytes(store.get("r1", "blob.txt"), "blob");
    await expectBytes(store.get("r1", "node.txt"), "node");
    await expectBytes(store.getAsset("app.js"), "asset");
    await expectBytes(store.getHistory("r1"), '{"point":"history"}');
    expect(await store.exists("r1", "index.html")).toBe(true);
    expect(await store.exists("r1", "missing.txt")).toBe(false);
    expect(await store.get("r1", "missing.txt")).toBeNull();
    expect(await store.getAsset("missing.js")).toBeNull();
    expect(await store.getHistory("missing")).toBeNull();

    await store.deleteHistory("r1");

    expect(await store.getHistory("r1")).toBeNull();
  });

  it("lists and deletes report files without touching other objects", async () => {
    const { client, objects } = createS3Client(
      new Map([
        ["root/assets/app.js", Buffer.from("asset")],
        ["root/files/r1/deep/data.json", Buffer.from("data")],
        ["root/files/r1/index.html", Buffer.from("home")],
        ["root/files/r1/z.txt", Buffer.from("z")],
        ["root/files/r2/index.html", Buffer.from("other")],
      ]),
    );
    const store = new S3Store({ bucket: "bucket", client, prefix: "root" });

    expect(await store.list("r1")).toEqual(["deep/data.json", "index.html", "z.txt"]);

    await store.delete("r1");

    expect(Array.from(objects.keys()).sort()).toEqual(["root/assets/app.js", "root/files/r2/index.html"]);
  });
});
