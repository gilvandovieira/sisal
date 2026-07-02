import {
  connect,
  createSqliteMigrator,
  type SqliteDatabase,
} from "@sisal/sqlite";
import { generateSqliteUpStatements } from "@sisal/sqlite/ddl";

import { envEquals } from "../_shared/env.ts";
import type {
  IntegrationMigratorOptions,
  IntegrationTarget,
} from "../_shared/target.ts";

let dbPath: string | undefined;
let dbHandle: SqliteDatabase | undefined;
let temporalDbHandle: SqliteDatabase | undefined;

export const sqliteTarget: IntegrationTarget = {
  id: "sqlite",
  label: "SQLite",
  family: "sqlite",
  snapshotDialect: "sqlite",
  ignore: !envEquals("SISAL_SQLITE_IT", "1"),
  capabilities: {
    nativeIlike: false,
    rightFullJoin: true,
    returning: true,
    upsert: true,
    distinctOn: false,
    rowLocking: false,
    nativeArrays: false,
    typedFunctions: false,
    dataModifyingCte: false,
    mutationCte: true,
    schemaFunctions: false,
    schemaTriggers: true,
    richIndexes: true,
    mutationUpdateFrom: true,
    bareUpsertSelect: false,
  },
  valueShape: {
    boolean: "integer",
    json: "text",
    array: "jsonText",
    binary: "uint8array",
    numeric: "number",
    dateTrunc: "text",
  },
  sql: { supportsCascadeDrops: false, metadataFlavor: "pragma" },
  async db() {
    if (dbHandle === undefined) {
      dbPath = await Deno.makeTempFile({ suffix: ".sqlite" });
      dbHandle = await connect({ path: dbPath });
    }
    return dbHandle;
  },
  async temporalDb() {
    if (temporalDbHandle === undefined) {
      await this.db();
      temporalDbHandle = await connect({
        path: dbPath!,
        temporal: { parse: true },
      });
    }
    return temporalDbHandle;
  },
  generateUp(snapshot) {
    return generateSqliteUpStatements(snapshot);
  },
  async migrator(options: IntegrationMigratorOptions = {}) {
    await this.db();
    return await createSqliteMigrator({
      path: dbPath!,
      historyTable: options.historyTable,
      useTransaction: options.useTransaction as boolean | undefined,
    });
  },
  async close() {
    await temporalDbHandle?.close();
    temporalDbHandle = undefined;
    await dbHandle?.close();
    dbHandle = undefined;
    if (dbPath !== undefined) {
      try {
        await Deno.remove(dbPath);
      } catch {
        // Temp cleanup is best effort.
      }
      dbPath = undefined;
    }
  },
};
