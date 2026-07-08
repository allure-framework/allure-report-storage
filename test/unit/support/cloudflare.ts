import { DatabaseSync } from "node:sqlite";

type R2PutValue = Parameters<R2Bucket["put"]>[1];

const toSqliteValue = (value: unknown) => {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return value;
};

class MemoryD1PreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sqlText: string,
    private readonly parameters: unknown[] = [],
  ) {}

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const results = this.database.prepare(this.sqlText).all(...this.parameters.map(toSqliteValue)) as T[];

    return { meta: {}, results, success: true };
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new MemoryD1PreparedStatement(this.database, this.sqlText, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.database.prepare(this.sqlText).get(...this.parameters.map(toSqliteValue)) as T | undefined) ?? null;
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return this.database.prepare(this.sqlText).raw(...this.parameters.map(toSqliteValue)) as T[];
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = this.database.prepare(this.sqlText).run(...this.parameters.map(toSqliteValue));

    return { meta: { changes: Number(result.changes) }, results: [], success: true };
  }
}

export class MemoryD1Database implements D1Database {
  private readonly database = new DatabaseSync(":memory:");

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.all(statements.map((statement) => statement.all<T>()));
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.database.exec(query);

    return { count: 0, duration: 0 };
  }

  prepare(query: string): D1PreparedStatement {
    return new MemoryD1PreparedStatement(this.database, query);
  }

  withSession(): D1DatabaseSession {
    throw new Error("D1 sessions are not implemented in tests");
  }

  close(): void {
    this.database.close();
  }
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);

  copy.set(bytes);

  return copy.buffer;
};

const streamToBytes = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    chunks.push(result.value);
  }

  const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
};

const toBytes = async (value: R2PutValue): Promise<Uint8Array> => {
  if (value === null) {
    return new Uint8Array();
  }

  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }

  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  return streamToBytes(value);
};

const createReadableStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

export class MemoryR2Bucket implements R2Bucket {
  private readonly objects = new Map<string, Uint8Array>();

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const bytes = this.objects.get(key);

    if (!bytes) {
      return null;
    }

    return {
      arrayBuffer: async () => toArrayBuffer(bytes),
      body: createReadableStream(bytes),
      key,
    } as R2ObjectBody;
  }

  async head(key: string): Promise<R2Object | null> {
    return this.objects.has(key) ? ({ key } as R2Object) : null;
  }

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const prefix = options.prefix ?? "";
    const limit = options.limit ?? 1000;
    const start = options.cursor ? Number(options.cursor) : 0;
    const matching = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .map((key) => ({ key }));
    const objects = matching.slice(start, start + limit);
    const next = start + limit;

    return {
      cursor: next < matching.length ? String(next) : undefined,
      objects: objects as R2Object[],
      truncated: next < matching.length,
    };
  }

  async put(key: string, value: R2PutValue): Promise<R2Object> {
    this.objects.set(key, await toBytes(value));

    return { key } as R2Object;
  }
}
