import {
  CompiledQuery,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from "kysely";

import type { AllureReportStorageDatabase } from "../../model.js";
import { KyselyReportRepository } from "../reports.js";

export interface D1ReportRepositoryOptions {
  database: D1Database;
}

const toD1Value = (value: unknown): unknown => {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (value instanceof ArrayBuffer) {
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    return value;
  }

  if (value === undefined) {
    return null;
  }

  throw new Error(`Unsupported D1 parameter type: ${typeof value}`);
};

const toD1Values = (parameters: ReadonlyArray<unknown>): unknown[] => parameters.map(toD1Value);

const assertSuccessful = (result: D1Result): void => {
  if (!result.success) {
    throw new Error(result.error ?? "D1 query failed");
  }
};

const queryReturnsRows = (compiledQuery: CompiledQuery): boolean => {
  const query = compiledQuery.query as { kind: string; returning?: unknown };

  return query.kind === "SelectQueryNode" || query.returning !== undefined;
};

class D1Connection implements DatabaseConnection {
  constructor(private readonly database: D1Database) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.database.prepare(compiledQuery.sql);
    const boundStatement =
      compiledQuery.parameters.length > 0 ? statement.bind(...toD1Values(compiledQuery.parameters)) : statement;

    if (queryReturnsRows(compiledQuery)) {
      const result = await boundStatement.all<R>();

      assertSuccessful(result);

      return { rows: result.results ?? [] };
    }

    const result = await boundStatement.run();

    assertSuccessful(result);

    return {
      numAffectedRows: result.meta?.changes === undefined ? undefined : BigInt(result.meta.changes),
      rows: [],
    };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("D1 driver does not support streaming queries");
  }
}

class D1Driver implements Driver {
  private readonly connection: D1Connection;

  constructor(database: D1Database) {
    this.connection = new D1Connection(database);
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }

  async beginTransaction(connection: DatabaseConnection, _settings: TransactionSettings): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

class D1Dialect implements Dialect {
  constructor(private readonly database: D1Database) {}

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new D1Driver(this.database);
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }
}

export const createD1Kysely = (database: D1Database): Kysely<AllureReportStorageDatabase> =>
  new Kysely<AllureReportStorageDatabase>({
    dialect: new D1Dialect(database),
  });

export class D1ReportRepository extends KyselyReportRepository {
  private constructor(db: Kysely<AllureReportStorageDatabase>) {
    super(db);
  }

  static async create(options: D1ReportRepositoryOptions): Promise<D1ReportRepository> {
    const repository = new D1ReportRepository(createD1Kysely(options.database));

    await repository.ensureSchema();

    return repository;
  }
}
