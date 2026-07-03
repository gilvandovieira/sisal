import {
  connect,
  createPgMigrator,
  type PgDatabase,
  type PgDriverKind,
} from "@sisal/pg";
import { generatePostgresUpStatements } from "@sisal/pg/ddl";

import { env } from "../_shared/env.ts";
import type {
  IntegrationMigratorOptions,
  IntegrationTarget,
} from "../_shared/target.ts";

const URL = env("DATABASE_URL");
// Default (unset) exercises the package default — postgres.js since v0.10;
// SISAL_PG_DRIVER=db-postgres re-runs the suite on the pure-JSR driver.
const DRIVER = env("SISAL_PG_DRIVER") === "db-postgres"
  ? "db-postgres" as PgDriverKind
  : env("SISAL_PG_DRIVER") === "postgres-js"
  ? "postgres-js" as PgDriverKind
  : undefined;

let dbHandle: PgDatabase | undefined;
let temporalDbHandle: PgDatabase | undefined;

export const pgTarget: IntegrationTarget = {
  id: "pg",
  label: "Postgres",
  family: "postgres",
  snapshotDialect: "postgres",
  ignore: URL === undefined,
  capabilities: {
    nativeIlike: true,
    rightFullJoin: true,
    returning: true,
    upsert: true,
    distinctOn: true,
    rowLocking: true,
    nativeArrays: true,
    typedFunctions: true,
    dataModifyingCte: true,
    mutationCte: true,
    schemaFunctions: true,
    schemaTriggers: true,
    richIndexes: true,
    mutationUpdateFrom: true,
    bareUpsertSelect: true,
  },
  valueShape: {
    boolean: "boolean",
    json: "parsed",
    array: "native",
    binary: "uint8array",
    numeric: "string",
    bigint: "string",
    dateTrunc: "timestamp",
  },
  sql: { supportsCascadeDrops: true, metadataFlavor: "information_schema" },
  async db() {
    dbHandle ??= await connect({ url: URL!, driver: DRIVER });
    return dbHandle;
  },
  async temporalDb() {
    temporalDbHandle ??= await connect({
      url: URL!,
      driver: DRIVER,
      temporal: { parse: true },
    });
    return temporalDbHandle;
  },
  generateUp(snapshot) {
    return generatePostgresUpStatements(snapshot);
  },
  async migrator(options: IntegrationMigratorOptions = {}) {
    return await createPgMigrator({
      url: URL!,
      historyTable: options.historyTable,
      splitStatements: options.splitStatements as boolean | undefined,
      useTransaction: options.useTransaction as boolean | undefined,
    });
  },
  async close() {
    await temporalDbHandle?.close();
    temporalDbHandle = undefined;
    await dbHandle?.close();
    dbHandle = undefined;
  },
};
