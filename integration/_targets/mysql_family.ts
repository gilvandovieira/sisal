import { connect, createMysqlMigrator, type MysqlDatabase } from "@sisal/mysql";
import { generateMysqlUpStatements } from "@sisal/mysql/ddl";

import { env, envEquals } from "../_shared/env.ts";
import type {
  IntegrationAdapterId,
  IntegrationMigratorOptions,
  IntegrationTarget,
  IntegrationValueShape,
} from "../_shared/target.ts";

/**
 * Builds a mysql-family {@link IntegrationTarget}. MySQL proper and MariaDB
 * share one adapter, one DDL generator, and one scenario list; they differ
 * only in connection env, `RETURNING` lighting (the facade's auto-detected
 * identity lights MariaDB `INSERT`/`DELETE … RETURNING`), and the JSON value
 * shape (MariaDB's `JSON` is a `LONGTEXT` alias, so values read back as
 * strings where MySQL parses them).
 */
export function makeMysqlFamilyTarget(options: {
  readonly id: IntegrationAdapterId;
  readonly label: string;
  readonly urlEnv: string;
  readonly gateEnv: string;
  readonly returning: boolean;
  readonly mutationCte: boolean;
  readonly json: IntegrationValueShape["json"];
  readonly array: IntegrationValueShape["array"];
}): IntegrationTarget {
  const url = env(options.urlEnv);
  let dbHandle: MysqlDatabase | undefined;
  let temporalDbHandle: MysqlDatabase | undefined;

  return {
    id: options.id,
    label: options.label,
    family: "mysql",
    snapshotDialect: "mysql",
    // Gated like the SQLite suites: the IT flag must be set *and* a URL
    // provided; missing either skips the whole suite cleanly.
    ignore: !envEquals(options.gateEnv, "1") || url === undefined,
    capabilities: {
      nativeIlike: false,
      rightFullJoin: false, // RIGHT JOIN works; FULL JOIN is a typed guard.
      returning: options.returning,
      upsert: true,
      distinctOn: false,
      rowLocking: true,
      nativeArrays: false,
      typedFunctions: false,
      dataModifyingCte: false,
      // MariaDB parses WITH only on SELECT; MySQL 8+ allows it on mutations.
      mutationCte: options.mutationCte,
      schemaFunctions: false,
      schemaTriggers: true,
      richIndexes: false, // DESC works; partial/expression throw typed (B5).
      mutationUpdateFrom: true,
      bareUpsertSelect: true,
    },
    valueShape: {
      boolean: "integer",
      json: options.json,
      array: options.array,
      binary: "uint8array",
      numeric: "string",
      bigint: "string",
      dateTrunc: "text",
    },
    sql: {
      supportsCascadeDrops: false,
      metadataFlavor: "information_schema",
    },
    async db() {
      dbHandle ??= await connect({ url: url! });
      return dbHandle;
    },
    async temporalDb() {
      temporalDbHandle ??= await connect({
        url: url!,
        temporal: { parse: true },
      });
      return temporalDbHandle;
    },
    generateUp(snapshot) {
      return generateMysqlUpStatements(snapshot);
    },
    async migrator(options: IntegrationMigratorOptions = {}) {
      return await createMysqlMigrator({
        url: url!,
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
}
