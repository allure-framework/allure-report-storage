import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";

import type { StaticFileData, StaticFileStore } from "../model.js";
import { historyFileName } from "../utils/path.js";

export interface S3StoreOptions {
  bucket: string;
  client?: Pick<S3Client, "send">;
  prefix?: string;
  reportsPrefix?: string;
  assetsPrefix?: string;
  historyPrefix?: string;
}

interface S3Payload {
  body: PutObjectCommandInput["Body"];
  contentLength?: number;
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

const toS3Payload = (data: StaticFileData): S3Payload => {
  if (data instanceof Uint8Array) {
    return { body: data, contentLength: data.byteLength };
  }

  if (data instanceof Blob) {
    return {
      body: Readable.fromWeb(data.stream() as unknown as NodeReadableStream<Uint8Array>),
      contentLength: data.size,
    };
  }

  if (isWebReadableStream(data)) {
    return { body: Readable.fromWeb(data as unknown as NodeReadableStream<Uint8Array>) };
  }

  if (isNodeReadableStream(data)) {
    return { body: data as Readable };
  }

  return { body: data };
};

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, "");

const joinKey = (...segments: Array<string | undefined>): string =>
  segments
    .map((segment) => (segment === undefined ? "" : trimSlashes(segment)))
    .filter(Boolean)
    .join("/");

const isNotFoundError = (error: unknown): boolean => {
  if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
    return true;
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { $metadata?: { httpStatusCode?: number }; name?: string };

  return candidate.$metadata?.httpStatusCode === 404 || candidate.name === "NoSuchKey" || candidate.name === "NotFound";
};

const isNoSuchKeyError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { Code?: string; code?: string; name?: string };

  return candidate.name === "NoSuchKey" || candidate.Code === "NoSuchKey" || candidate.code === "NoSuchKey";
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

export class S3Store implements StaticFileStore {
  private readonly client: Pick<S3Client, "send">;
  private readonly prefix?: string;
  private readonly reportsPrefix: string;
  private readonly assetsPrefix: string;
  private readonly historyPrefix: string;

  constructor(private readonly options: S3StoreOptions) {
    this.client = options.client ?? new S3Client({});
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
    return this.objectExists(this.reportObjectKey(reportId, relativePath));
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
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.options.bucket,
          Delete: {
            Objects: keysChunk.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
    }
  }

  async putHistory(reportId: string, data: StaticFileData): Promise<void> {
    await this.putObject(this.historyObjectKey(reportId), data);
  }

  async getHistory(reportId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.getObject(this.historyObjectKey(reportId));
  }

  async deleteHistory(reportId: string): Promise<void> {
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.options.bucket,
        Delete: {
          Objects: [{ Key: this.historyObjectKey(reportId) }],
          Quiet: true,
        },
      }),
    );
  }

  async putAsset(relativePath: string, data: StaticFileData): Promise<void> {
    await this.putObject(this.assetObjectKey(relativePath), data);
  }

  async getAsset(relativePath: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.getObject(this.assetObjectKey(relativePath));
  }

  private async putObject(key: string, data: StaticFileData): Promise<void> {
    const payload = toS3Payload(data);

    await this.client.send(
      new PutObjectCommand({
        Body: payload.body,
        Bucket: this.options.bucket,
        ContentLength: payload.contentLength,
        Key: key,
      }),
    );
  }

  private async getObject(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
        }),
      );

      if (!response.Body) {
        return new Uint8Array();
      }

      return new Uint8Array(await response.Body.transformToByteArray());
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }

      throw error;
    }
  }

  private async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
        }),
      );

      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }

      throw error;
    }
  }

  private async listObjectKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    try {
      do {
        const response = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.options.bucket,
            ContinuationToken: continuationToken,
            Prefix: prefix,
          }),
        );

        for (const object of response.Contents ?? []) {
          if (object.Key) {
            keys.push(object.Key);
          }
        }

        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
    } catch (error) {
      if (isNoSuchKeyError(error)) {
        return [];
      }

      throw error;
    }

    return keys;
  }

  private reportPrefix(reportId: string): string {
    return `${joinKey(this.prefix, this.reportsPrefix, reportId)}/`;
  }

  private reportObjectKey(reportId: string, relativePath: string): string {
    return joinKey(this.reportPrefix(reportId), relativePath);
  }

  private assetObjectKey(relativePath: string): string {
    return joinKey(this.prefix, this.assetsPrefix, relativePath);
  }

  private historyObjectKey(reportId: string): string {
    return joinKey(this.prefix, this.historyPrefix, historyFileName(reportId));
  }
}
