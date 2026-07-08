import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { Kysely, SqliteDialect } from "kysely";

import type { AllureReportStorageDatabase, SqliteReportRepositoryOptions } from "../../model.js";
import { KyselyReportRepository } from "../reports.js";

type SqliteParameter = null | number | bigint | string | NodeJS.ArrayBufferView;

const toSqliteParameter = (value: unknown): SqliteParameter => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (ArrayBuffer.isView(value)) {
    return value as NodeJS.ArrayBufferView;
  }

  if (value === undefined) {
    return null;
  }

  throw new Error(`Unsupported SQLite parameter type: ${typeof value}`);
};

const toSqliteParameters = (parameters: ReadonlyArray<unknown>): SqliteParameter[] => parameters.map(toSqliteParameter);

class NodeSqliteStatement {
  constructor(private readonly statement: StatementSync) {}

  get reader(): boolean {
    return this.statement.columns().length > 0;
  }

  all(parameters: ReadonlyArray<unknown>): unknown[] {
    return this.statement.all(...toSqliteParameters(parameters));
  }

  run(parameters: ReadonlyArray<unknown>): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.statement.run(...toSqliteParameters(parameters));
  }

  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown> {
    return this.statement.iterate(...toSqliteParameters(parameters)) as IterableIterator<unknown>;
  }
}

class NodeSqliteDatabase {
  constructor(private readonly database: DatabaseSync) {}

  close(): void {
    this.database.close();
  }

  prepare(sqlText: string): NodeSqliteStatement {
    return new NodeSqliteStatement(this.database.prepare(sqlText));
  }
}

const ensureDatabaseDirectory = (databasePath: string): void => {
  if (databasePath === ":memory:" || databasePath.startsWith("file:")) {
    return;
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
};

export const createSqliteKysely = (options: SqliteReportRepositoryOptions): Kysely<AllureReportStorageDatabase> => {
  if (options.databasePath.trim().length === 0) {
    throw new Error("SQLite database path is required");
  }

  ensureDatabaseDirectory(options.databasePath);

  const database = new DatabaseSync(options.databasePath);

  database.exec("PRAGMA busy_timeout = 5000");

  return new Kysely<AllureReportStorageDatabase>({
    dialect: new SqliteDialect({ database: new NodeSqliteDatabase(database) }),
  });
};

export class SqliteReportRepository extends KyselyReportRepository {
  private constructor(db: Kysely<AllureReportStorageDatabase>) {
    super(db);
  }

  static async create(options: SqliteReportRepositoryOptions): Promise<SqliteReportRepository> {
    const repository = new SqliteReportRepository(createSqliteKysely(options));

    await repository.ensureSchema();

    return repository;
  }
}
