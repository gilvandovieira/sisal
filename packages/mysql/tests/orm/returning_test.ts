/**
 * Network-free unit tests for the B7 `insertReturning` strategy: real
 * `INSERT … RETURNING` when the identity lights it, the transactional
 * fetch-by-key fallback otherwise, and typed errors for the corners the
 * fallback cannot answer honestly.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { columns, defineTable, OrmError, primaryKey, sql } from "@sisal/orm";

import { connect } from "../../src/orm/mod.ts";
import { insertReturning } from "../../src/orm/returning.ts";
import type { MysqlClient, MysqlDriverRows } from "../../src/orm/pool.ts";

interface QueryCall {
  readonly sql: string;
  readonly params: unknown[];
}

class RecordingMysqlClient implements MysqlClient {
  readonly queries: QueryCall[] = [];
  /** Next results to hand out, in order; defaults to empty row arrays. */
  readonly results: MysqlDriverRows[] = [];

  query<Row = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<[MysqlDriverRows<Row>, unknown]> {
    this.queries.push({ sql, params });
    const next = (this.results.shift() ?? []) as MysqlDriverRows<Row>;
    return Promise.resolve([next, undefined]);
  }
}

const users = defineTable("users", {
  id: columns.serial().primaryKey(),
  name: columns.text(),
});

const docs = defineTable("docs", {
  id: columns.uuid().primaryKey(),
  title: columns.text(),
});

const logs = defineTable("logs", {
  message: columns.text(),
});

const pairs = defineTable("pairs", {
  a: columns.integer().notNull(),
  b: columns.integer().notNull(),
  label: columns.text(),
}, (c) => [primaryKey({ columns: [c.a, c.b] })]);

async function mysqlDb(client: MysqlClient) {
  return await connect({ client, detectVersion: false });
}

Deno.test("@sisal/mysql - insertReturning uses real RETURNING on a lit MariaDB identity", async () => {
  const client = new RecordingMysqlClient();
  client.results.push([{ id: 1, name: "a" }, { id: 2, name: "b" }]);
  const db = await connect({
    client,
    variant: "mariadb",
    version: "11.8.8-MariaDB",
  });

  const rows = await insertReturning(db, users, [
    { name: "a" },
    { name: "b" },
  ]);

  assertEquals(rows, [{ id: 1, name: "a" }, { id: 2, name: "b" }]);
  // One statement, true RETURNING semantics — no transaction, no re-fetch.
  assertEquals(client.queries.length, 1);
  assertStringIncludes(client.queries[0].sql, "returning");
});

Deno.test("@sisal/mysql - insertReturning falls back to one insert + fetch for explicit keys", async () => {
  const client = new RecordingMysqlClient();
  client.results.push(
    [], // begin
    { affectedRows: 2 }, // insert
    // Fetch returns rows shuffled — output must follow input order.
    [{ id: "u2", title: "second" }, { id: "u1", title: "first" }],
  );
  const db = await mysqlDb(client);

  const rows = await insertReturning(db, docs, [
    { id: "u1", title: "first" },
    { id: "u2", title: "second" },
  ]);

  assertEquals(rows, [
    { id: "u1", title: "first" },
    { id: "u2", title: "second" },
  ]);
  const sqls = client.queries.map((call) => call.sql);
  assertEquals(sqls[0], "begin");
  assertStringIncludes(sqls[1], "insert into `docs`");
  assertStringIncludes(sqls[2], "where `docs`.`id` in (?, ?)");
  assertEquals(client.queries[2].params, ["u1", "u2"]);
  assertEquals(sqls[3], "commit");
});

Deno.test("@sisal/mysql - insertReturning captures per-row LAST_INSERT_ID, no consecutive-id arithmetic", async () => {
  const client = new RecordingMysqlClient();
  client.results.push(
    [], // begin
    // Non-consecutive generated ids — exactly what interleaved
    // innodb_autoinc_lock_mode can produce across statements.
    { affectedRows: 1, insertId: 7 },
    { affectedRows: 1, insertId: 9 },
    // The BIGINT-ish key comes back as a string on the wire (the mandated
    // bigint-as-string decode); matching must survive the type mismatch.
    [{ id: "9", name: "b" }, { id: "7", name: "a" }],
  );
  const db = await mysqlDb(client);

  const rows = await insertReturning(db, users, [{ name: "a" }, {
    name: "b",
  }]);

  assertEquals<unknown>(rows, [{ id: "7", name: "a" }, { id: "9", name: "b" }]);
  const sqls = client.queries.map((call) => call.sql);
  assertEquals(sqls[0], "begin");
  assertStringIncludes(sqls[1], "insert into `users`");
  assertStringIncludes(sqls[2], "insert into `users`");
  assertStringIncludes(sqls[3], "where `users`.`id` in (?, ?)");
  assertEquals(client.queries[3].params, [7, 9]);
  assertEquals(sqls[4], "commit");
});

Deno.test("@sisal/mysql - insertReturning mixes explicit and generated single-column keys per row", async () => {
  const client = new RecordingMysqlClient();
  client.results.push(
    [], // begin
    { affectedRows: 1, insertId: 41 }, // generated
    { affectedRows: 1 }, // explicit id, no id generated
    [{ id: 41, name: "gen" }, { id: 100, name: "explicit" }],
  );
  const db = await mysqlDb(client);

  const rows = await insertReturning(db, users, [
    { name: "gen" },
    { id: 100, name: "explicit" },
  ]);

  assertEquals(rows, [{ id: 41, name: "gen" }, { id: 100, name: "explicit" }]);
});

Deno.test("@sisal/mysql - insertReturning empty input returns [] without SQL", async () => {
  const client = new RecordingMysqlClient();
  const db = await mysqlDb(client);

  assertEquals(await insertReturning(db, users, []), []);
  assertEquals(client.queries.length, 0);
});

Deno.test("@sisal/mysql - insertReturning fallback corners fail typed", async () => {
  const db = await mysqlDb(new RecordingMysqlClient());

  // No primary key: nothing to fetch by.
  const noPk = await assertRejects(
    () => insertReturning(db, logs, { message: "x" }),
    OrmError,
    "requires a primary key",
  );
  assertEquals(noPk.code, "ORM_INVALID_QUERY");

  // Composite key not fully provided: LAST_INSERT_ID cannot recover it.
  await assertRejects(
    () => insertReturning(db, pairs, { a: 1, label: "x" } as never),
    OrmError,
    "composite primary key",
  );

  // A SQL-expression key value is unknowable client-side, and a DB-side
  // uuid() generates no AUTO_INCREMENT id the driver could report.
  await assertRejects(
    () => insertReturning(db, docs, { id: sql`uuid()`, title: "x" }),
    OrmError,
    "no AUTO_INCREMENT id",
  );
});

Deno.test("@sisal/mysql - insertReturning throws typed when no AUTO_INCREMENT id is reported", async () => {
  const client = new RecordingMysqlClient();
  client.results.push(
    [], // begin
    { affectedRows: 1, insertId: 0 }, // server generated nothing it reports
  );
  const db = await mysqlDb(client);

  const error = await assertRejects(
    () => insertReturning(db, users, { name: "a" }),
    OrmError,
    "no AUTO_INCREMENT id",
  );
  assertEquals(error.code, "ORM_INVALID_QUERY");
  // The failed transaction rolled back.
  assertEquals(client.queries.at(-1)?.sql, "rollback");
});

Deno.test("@sisal/mysql - insertReturning propagates non-guard errors unchanged", async () => {
  const failing: MysqlClient = {
    query<Row = Record<string, unknown>>(): Promise<
      [MysqlDriverRows<Row>, unknown]
    > {
      return Promise.reject(new Error("connection reset"));
    },
  };
  const db = await connect({
    client: failing,
    variant: "mariadb",
    version: "11.8.8-MariaDB",
  });

  const error = await assertRejects(() =>
    insertReturning(db, users, { name: "a" })
  );
  assert(error instanceof OrmError);
  // The execute failure surfaces as-is — no silent fallback on a lit
  // identity whose statement failed for unrelated reasons.
  assertEquals((error as OrmError).code, "ORM_EXECUTE_FAILED");
});
