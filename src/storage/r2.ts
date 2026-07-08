import type { StaticFileData, StaticFileStore } from "../model.js";
import { joinObjectKey } from "../utils/commons.js";
import { historyFileName } from "../utils/path.js";

type R2Payload = Parameters<R2Bucket["put"]>[1];

export interface R2StoreOptions {
  assetsPrefix?: string;
  bucket: R2Bucket;
  historyPrefix?: string;
  prefix?: string;
  reportsPrefix?: string;
}

const isWebReadableStream = (data: StaticFileData): data is ReadableStream<Uint8Array> =>
  typeof data === "object" &&
  data !== null &&
  "getReader" in data &&
  typeof (data as { getReader?: unknown }).getReader === "function";

const isNodeReadableStream = (data: StaticFileData): data is NodeJS.ReadableStream =>
  typeof data === "object" &&
  data !== null &&
  "pipe" in data &&
  typeof (data as { pipe?: unknown }).pipe === "function";

const readNodeStream = async (stream: NodeJS.ReadableStream): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];

  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      chunks.push(new TextEncoder().encode(chunk));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    } else {
      chunks.push(new Uint8Array(chunk as ArrayBuffer));
    }
  }

  const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const buffer = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer;
};

const toR2Payload = async (data: StaticFileData): Promise<R2Payload> => {
  if (data instanceof Uint8Array || data instanceof Blob || isWebReadableStream(data)) {
    return data;
  }

  if (isNodeReadableStream(data)) {
    return readNodeStream(data);
  }

  throw new Error("Unsupported R2 payload type");
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

export class R2Store implements StaticFileStore {
  private readonly assetsPrefix: string;
  private readonly historyPrefix: string;
  private readonly prefix?: string;
  private readonly reportsPrefix: string;

  constructor(private readonly options: R2StoreOptions) {
    this.prefix = options.prefix;
    this.reportsPrefix = options.reportsPrefix ?? "files";
    this.assetsPrefix = options.assetsPrefix ?? "assets";
    this.historyPrefix = options.historyPrefix ?? "history";
  }

  async put(reportId: string, relativePath: string, data: StaticFileData): Promise<void> {
    await this.putObject(this.reportObjectKey(reportId, relativePath), data);
  }

  async get(reportId: string, relativePath: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.getObject(this.reportObjectKey(reportId, relativePath));
  }

  async exists(reportId: string, relativePath: string): Promise<boolean> {
    return (await this.options.bucket.head(this.reportObjectKey(reportId, relativePath))) !== null;
  }

  async list(reportId: string): Promise<string[]> {
    const prefix = this.reportPrefix(reportId);
    const keys = await this.listObjectKeys(prefix);

    return keys
      .map((key) => key.slice(prefix.length))
      .filter(Boolean)
      .sort();
  }

  async delete(reportId: string): Promise<void> {
    const keys = await this.listObjectKeys(this.reportPrefix(reportId));

    for (const keysChunk of chunk(keys, 1000)) {
      await this.options.bucket.delete(keysChunk);
    }
  }

  async putHistory(reportId: string, data: StaticFileData): Promise<void> {
    await this.putObject(this.historyObjectKey(reportId), data);
  }

  async getHistory(reportId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.getObject(this.historyObjectKey(reportId));
  }

  async deleteHistory(reportId: string): Promise<void> {
    await this.options.bucket.delete(this.historyObjectKey(reportId));
  }

  async putAsset(relativePath: string, data: StaticFileData): Promise<void> {
    await this.putObject(this.assetObjectKey(relativePath), data);
  }

  async getAsset(relativePath: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.getObject(this.assetObjectKey(relativePath));
  }

  private async putObject(key: string, data: StaticFileData): Promise<void> {
    await this.options.bucket.put(key, await toR2Payload(data));
  }

  private async getObject(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const object = await this.options.bucket.get(key);

    if (!object) {
      return null;
    }

    return new Uint8Array(await object.arrayBuffer());
  }

  private async listObjectKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.options.bucket.list({ cursor, prefix });

      keys.push(...result.objects.map((object) => object.key));
      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);

    return keys;
  }

  private reportPrefix(reportId: string): string {
    return `${joinObjectKey(this.prefix, this.reportsPrefix, reportId)}/`;
  }

  private reportObjectKey(reportId: string, relativePath: string): string {
    return joinObjectKey(this.reportPrefix(reportId), relativePath);
  }

  private assetObjectKey(relativePath: string): string {
    return joinObjectKey(this.prefix, this.assetsPrefix, relativePath);
  }

  private historyObjectKey(reportId: string): string {
    return joinObjectKey(this.prefix, this.historyPrefix, historyFileName(reportId));
  }
}
