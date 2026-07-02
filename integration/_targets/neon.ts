import { connect, createNeonMigrator, type NeonDatabase } from "@sisal/neon";
import { generatePostgresUpStatements } from "@sisal/neon/ddl";

import { env } from "../_shared/env.ts";
import { configureNeonWebSocketProxy } from "../_shared/neon.ts";
import type {
  IntegrationMigratorOptions,
  IntegrationTarget,
} from "../_shared/target.ts";

const URL = env("NEON_DATABASE_URL");
const WS_PROXY = env("NEON_WS_PROXY");

let dbHandle: NeonDatabase | undefined;
let temporalDbHandle: NeonDatabase | undefined;

export const neonTarget: IntegrationTarget = {
  id: "neon",
  label: "Neon",
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
    if (dbHandle === undefined) {
      await configureNeonWebSocketProxy(WS_PROXY);
      dbHandle = await connect({ url: URL! });
    }
    return dbHandle;
  },
  async temporalDb() {
    if (temporalDbHandle === undefined) {
      await configureNeonWebSocketProxy(WS_PROXY);
      temporalDbHandle = await connect({
        url: URL!,
        temporal: { parse: true },
      });
    }
    return temporalDbHandle;
  },
  generateUp(snapshot) {
    return generatePostgresUpStatements(snapshot);
  },
  async migrator(options: IntegrationMigratorOptions = {}) {
    await configureNeonWebSocketProxy(WS_PROXY);
    return await createNeonMigrator({
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
