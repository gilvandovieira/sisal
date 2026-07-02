import {
  connect,
  createLibsqlMigrator,
  type LibsqlDatabase,
} from "@sisal/libsql";
import { generateLibsqlUpStatements } from "@sisal/libsql/ddl";

import { env } from "../_shared/env.ts";
import type {
  IntegrationMigratorOptions,
  IntegrationTarget,
} from "../_shared/target.ts";

const RUN = env("SISAL_LIBSQL_IT") === "1";
const REMOTE_URL = env("TURSO_DATABASE_URL");
const AUTH_TOKEN = env("TURSO_AUTH_TOKEN");

let dbUrl: string | undefined;
let dbHandle: LibsqlDatabase | undefined;
let temporalDbHandle: LibsqlDatabase | undefined;

function authOptions(): { authToken?: string } {
  return AUTH_TOKEN === undefined ? {} : { authToken: AUTH_TOKEN };
}

export const libsqlTarget: IntegrationTarget = {
  id: "libsql",
  label: "libSQL",
  family: "sqlite",
  snapshotDialect: "sqlite",
  ignore: !RUN,
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
    binary: "arraybuffer",
    numeric: "number",
    dateTrunc: "text",
  },
  sql: { supportsCascadeDrops: false, metadataFlavor: "pragma" },
  async db() {
    if (dbHandle === undefined) {
      dbUrl = REMOTE_URL ??
        `file:${await Deno.makeTempFile({ suffix: ".db" })}`;
      dbHandle = await connect({ url: dbUrl, ...authOptions() });
    }
    return dbHandle;
  },
  async temporalDb() {
    if (temporalDbHandle === undefined) {
      await this.db();
      temporalDbHandle = await connect({
        url: dbUrl!,
        ...authOptions(),
        temporal: { parse: true },
      });
    }
    return temporalDbHandle;
  },
  generateUp(snapshot) {
    return generateLibsqlUpStatements(snapshot);
  },
  async migrator(options: IntegrationMigratorOptions = {}) {
    await this.db();
    return await createLibsqlMigrator({
      url: dbUrl!,
      ...authOptions(),
      historyTable: options.historyTable,
      useTransaction: options.useTransaction as boolean | undefined,
    });
  },
  async close() {
    await temporalDbHandle?.close();
    temporalDbHandle = undefined;
    await dbHandle?.close();
    dbHandle = undefined;
    if (dbUrl !== undefined && dbUrl.startsWith("file:")) {
      try {
        await Deno.remove(dbUrl.slice("file:".length));
      } catch {
        // Temp cleanup is best effort.
      }
    }
    dbUrl = undefined;
  },
};
