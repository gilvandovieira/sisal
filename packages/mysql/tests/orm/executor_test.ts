/**
 * Network-free unit tests for the `@sisal/mysql` executor, driver, and facade
 * wiring (v0.7 B3). A fake pool/client records every statement, so the tests
 * prove the adapter shape — result mapping, transaction isolation, Temporal
 * param normalization, batch atomicity, and the end-to-end facade rendering
 * (backticks/`?`/ODKU under the `mysql` dialect; MariaDB `RETURNING` through
 * the B1 identity) — without a server or the mysql2 dependency.
 *
 * @module
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { columns, defineTable, eq, excluded } from "@sisal/orm";

import { Buffer } from "node:buffer";

import { connect } from "../../src/orm/mod.ts";
import { createMysqlOrmDriver } from "../../src/orm/driver.ts";
import { createMysqlExecutor } from "../../src/orm/executor.ts";
import {
  adaptMariadbPool,
  mariadbConfigFromUrl,
} from "../../src/orm/mariadb_pool.ts";
import { mysqlConfigFromUrl } from "../../src/orm/pool.ts";
import { parseMysqlServerVersion } from "../../src/orm/version.ts";
import type {
  MysqlClient,
  MysqlDriverRows,
  MysqlPool,
} from "../../src/orm/pool.ts";

interface QueryCall {
  readonly sql: string;
  readonly params: unknown[];
}

class RecordingMysqlClient implements MysqlClient {
  readonly queries: QueryCall[] = [];
  released = false;
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

  release(): void {
    this.released = true;
  }
}

class QueueMysqlPool implements MysqlPool {
  readonly #clients: MysqlClient[];
  ended = false;

  constructor(clients: MysqlClient[]) {
    this.#clients = clients;
  }

  getConnection(): Promise<MysqlClient> {
    const client = this.#clients.shift();
    if (client === undefined) {
      return Promise.reject(new Error("pool exhausted"));
    }
    return Promise.resolve(client);
  }

  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }
}

Deno.test("@sisal/mysql - executor maps rows and affected-row headers", async () => {
  const client = new RecordingMysqlClient();
  client.results.push([{ id: 1 }], { affectedRows: 3, insertId: 7 });
  const executor = createMysqlExecutor({ client });

  const read = await executor.execute("select * from t");
  assertEquals(read.rows, [{ id: 1 }]);
  assertEquals(read.rowCount, 1);

  const write = await executor.execute("update t set n = 1");
  assertEquals(write.rows, []);
  assertEquals(write.rowCount, 3);
});

Deno.test("@sisal/mysql - executor isolates the transaction client", async () => {
  const transactionClient = new RecordingMysqlClient();
  const outsideClient = new RecordingMysqlClient();
  const pool = new QueueMysqlPool([transactionClient, outsideClient]);
  const executor = createMysqlExecutor({ pool });

  await executor.transaction!(async (tx) => {
    await tx.execute("insert into notes values (?)", ["tx"]);
    await executor.execute("select outside");
  });

  assertEquals(transactionClient.queries, [
    { sql: "begin", params: [] },
    { sql: "insert into notes values (?)", params: ["tx"] },
    { sql: "commit", params: [] },
  ]);
  assertEquals(outsideClient.queries, [
    { sql: "select outside", params: [] },
  ]);
  assertEquals(transactionClient.released, true);
  assertEquals(outsideClient.released, true);
});

Deno.test("@sisal/mysql - executor rolls back and rethrows on failure", async () => {
  const client = new RecordingMysqlClient();
  const pool = new QueueMysqlPool([client]);
  const executor = createMysqlExecutor({ pool });

  await assertRejects(
    () =>
      executor.transaction!(async (tx) => {
        await tx.execute("insert into notes values (?)", ["boom"]);
        throw new Error("boom");
      }),
    Error,
    "boom",
  );

  assertEquals(client.queries.map((q) => q.sql), [
    "begin",
    "insert into notes values (?)",
    "rollback",
  ]);
  assertEquals(client.released, true);
});

Deno.test("@sisal/mysql - executor normalizes Temporal params", async () => {
  const client = new RecordingMysqlClient();
  const executor = createMysqlExecutor({ client });

  await executor.execute("insert into events values (?, ?)", [
    Temporal.PlainDate.from("2026-06-28"),
    Temporal.Instant.from("2026-06-28T12:00:00.123456789Z"),
  ]);

  assertEquals(client.queries, [
    {
      sql: "insert into events values (?, ?)",
      // Instants render as naive UTC (microsecond precision): MySQL rejects
      // a trailing `Z`/offset in datetime literals — the executor UTC
      // convention.
      params: ["2026-06-28", "2026-06-28 12:00:00.123456"],
    },
  ]);
});

Deno.test("@sisal/mysql - driver batch runs as one transaction", async () => {
  const client = new RecordingMysqlClient();
  const pool = new QueueMysqlPool([client]);
  const driver = createMysqlOrmDriver({ pool });

  await driver.batch!([
    { text: "insert into t values (?)", params: [1] },
    { text: "insert into t values (?)", params: [2] },
  ]);

  assertEquals(client.queries.map((q) => q.sql), [
    "begin",
    "insert into t values (?)",
    "insert into t values (?)",
    "commit",
  ]);
});

Deno.test("@sisal/mysql - executor close ends only an owned pool", async () => {
  const injected = new QueueMysqlPool([]);
  const executor = createMysqlExecutor({ pool: injected });
  await executor.close!();
  assertEquals(injected.ended, false); // injected pools are not owned
});

const posts = defineTable("posts", {
  id: columns.integer().primaryKey(),
  title: columns.text().notNull(),
});

Deno.test("@sisal/mysql - the facade renders the mysql dialect end to end", async () => {
  const client = new RecordingMysqlClient();
  const db = await connect({ client, detectVersion: false });
  assertEquals(db.dialect, "mysql");
  assertEquals(db.dialectIdentity, { dialect: "mysql" });

  await db.insert(posts).values({ id: 1, title: "a" }).onConflictDoUpdate({
    target: posts.columns.id,
    set: { title: excluded(posts.columns.title) },
  }).execute();

  assertEquals(client.queries, [{
    sql: "insert into `posts` (`id`, `title`) values (?, ?) " +
      "on duplicate key update `title` = values(`title`)",
    params: [1, "a"],
  }]);
});

Deno.test("@sisal/mysql - a MariaDB identity lights RETURNING through connect", async () => {
  const client = new RecordingMysqlClient();
  client.results.push([{ id: 1, title: "a" }]);
  const db = await connect({
    client,
    variant: "mariadb",
    version: "11.8.8-MariaDB",
  });
  assertEquals(db.dialectIdentity, {
    dialect: "mysql",
    variant: "mariadb",
    version: "11.8.8-MariaDB",
  });

  const inserted = await db.insert(posts).values({ id: 1, title: "a" })
    .returning().execute();
  assertEquals(inserted.rows, [{ id: 1, title: "a" }]);
  assertStringIncludes(client.queries[0].sql, "returning");

  // The same statement through a base-mysql facade keeps the typed guard.
  const guarded = await connect({
    client: new RecordingMysqlClient(),
    detectVersion: false,
  });
  await assertRejects(
    () =>
      guarded.insert(posts).values({ id: 2, title: "b" }).returning()
        .execute(),
  );

  // UPDATE … RETURNING stays guarded on MariaDB 11.x (13.0+ floor).
  await assertRejects(
    () =>
      db.update(posts).set({ title: "c" }).where(eq(posts.columns.id, 1))
        .returning().execute(),
  );
});

// ---- B4: detection, value normalization, and the mariadb driver -------------

Deno.test("@sisal/mysql - parseMysqlServerVersion identifies the variant", () => {
  assertEquals(parseMysqlServerVersion("8.4.10"), { version: "8.4.10" });
  assertEquals(parseMysqlServerVersion("11.8.8-MariaDB-ubu2404"), {
    variant: "mariadb",
    version: "11.8.8-MariaDB-ubu2404",
  });
  assertEquals(parseMysqlServerVersion(" 10.11.6-MariaDB "), {
    variant: "mariadb",
    version: "10.11.6-MariaDB",
  });
});

Deno.test("@sisal/mysql - connect auto-detects the server identity", async () => {
  const client = new RecordingMysqlClient();
  client.results.push(
    [{ v: "11.8.8-MariaDB-ubu2404" }],
    [{ id: 1, title: "a" }],
  );
  const db = await connect({ client });

  assertEquals(client.queries[0].sql, "select version() as v");
  assertEquals(db.dialectIdentity, {
    dialect: "mysql",
    variant: "mariadb",
    version: "11.8.8-MariaDB-ubu2404",
  });

  // The detected identity immediately lights MariaDB INSERT … RETURNING.
  const inserted = await db.insert(posts).values({ id: 1, title: "a" })
    .returning().execute();
  assertEquals(inserted.rows, [{ id: 1, title: "a" }]);
  assertStringIncludes(client.queries[1].sql, "returning");

  // A base-MySQL server detects to "no variant" and stays guarded.
  const mysqlClient = new RecordingMysqlClient();
  mysqlClient.results.push([{ v: "8.4.10" }]);
  const mysqlDb = await connect({ client: mysqlClient });
  assertEquals(mysqlDb.dialectIdentity, {
    dialect: "mysql",
    version: "8.4.10",
  });
  await assertRejects(
    () =>
      mysqlDb.insert(posts).values({ id: 2, title: "b" }).returning()
        .execute(),
  );
});

Deno.test("@sisal/mysql - detection defaults off for injected executors", async () => {
  const calls: string[] = [];
  const db = await connect({
    executor: {
      execute<Row = Record<string, unknown>>(sql: string) {
        calls.push(sql);
        return Promise.resolve({ rows: [] as Row[], rowCount: 0 });
      },
    },
  });
  assertEquals(calls, []); // no version probe
  assertEquals(db.dialectIdentity, { dialect: "mysql" });

  // Explicit identity also skips detection on a real source.
  const client = new RecordingMysqlClient();
  const explicit = await connect({
    client,
    variant: "mariadb",
    version: "10.11",
  });
  assertEquals(client.queries, []);
  assertEquals(explicit.dialectIdentity.version, "10.11");
});

Deno.test("@sisal/mysql - BLOB Buffers are re-viewed as plain Uint8Array", async () => {
  const bytes = Buffer.from([1, 2, 3]);
  const client = new RecordingMysqlClient();
  client.results.push([{ data: bytes, note: "text" }]);
  const executor = createMysqlExecutor({ client });

  const result = await executor.execute<{ data: Uint8Array; note: string }>(
    "select data, note from bin",
  );
  const value = result.rows[0].data;
  assertEquals(value.constructor, Uint8Array);
  assertEquals([...value], [1, 2, 3]);
  assertEquals(result.rows[0].note, "text"); // non-binary values untouched
});

Deno.test("@sisal/mysql - adaptMariadbPool maps rows and OkPackets", async () => {
  const statements: string[] = [];
  let released = false;
  const fakeMariadb = {
    getConnection() {
      return Promise.resolve({
        query(sql: string) {
          statements.push(sql);
          if (sql.startsWith("select")) {
            return Promise.resolve([{ id: 1 }]);
          }
          return Promise.resolve({ affectedRows: 2, insertId: 9n });
        },
        release() {
          released = true;
        },
      });
    },
  };

  const executor = createMysqlExecutor({
    pool: adaptMariadbPool(fakeMariadb),
  });

  const read = await executor.execute("select * from t");
  assertEquals(read.rows, [{ id: 1 }]);
  assertEquals(read.rowCount, 1);

  const write = await executor.execute("update t set n = 1");
  assertEquals(write.rows, []);
  assertEquals(write.rowCount, 2);
  assertEquals(statements, ["select * from t", "update t set n = 1"]);
  assertEquals(released, true);
});

Deno.test("@sisal/mysql - adaptMariadbPool re-views binary params as Buffers", async () => {
  // The MariaDB connector JSON-serializes a plain Uint8Array param (silent
  // BLOB corruption — caught live by the B4 probe); the adapter must hand it
  // Buffers.
  const seen: unknown[][] = [];
  const fakeMariadb = {
    getConnection() {
      return Promise.resolve({
        query(_sql: string, params?: unknown[]) {
          seen.push(params ?? []);
          return Promise.resolve({ affectedRows: 1 });
        },
        release() {},
      });
    },
  };

  const executor = createMysqlExecutor({
    pool: adaptMariadbPool(fakeMariadb),
  });
  await executor.execute("insert into bin values (?, ?)", [
    new Uint8Array([7, 8, 9]),
    "text",
  ]);

  const [blob, text] = seen[0];
  assertEquals(Buffer.isBuffer(blob), true);
  assertEquals([...(blob as Uint8Array)], [7, 8, 9]);
  assertEquals(text, "text");
});

Deno.test("mysql2 pool config disables CLIENT_FOUND_ROWS (SEC-008)", () => {
  const config = mysqlConfigFromUrl({
    url: "mysql://app:secret@db.example.com:3306/sisal",
  });
  // Without this, a conflicting no-op upsert reports 1 affected row and the
  // advisory-lock claim / tryInsert cannot tell an insert from a conflict.
  assertEquals(config.flags, ["-FOUND_ROWS"]);
  // The mandated decode options are still present.
  assertEquals(config.supportBigNumbers, true);
  assertEquals(config.bigNumberStrings, true);
  assertEquals(config.dateStrings, true);
  assertEquals(config.host, "db.example.com");
  assertEquals(config.database, "sisal");
});

Deno.test("MariaDB pool config disables found-rows (SEC-008)", () => {
  const config = mariadbConfigFromUrl({
    url: "mysql://app:secret@db.example.com:3306/sisal",
  });
  assertEquals(config.foundRows, false);
  assertEquals(config.supportBigNumbers, true);
  assertEquals(config.bigNumberStrings, true);
  assertEquals(config.dateStrings, true);
});

Deno.test("mysql2 pool config forwards the ssl option (SEC-009)", () => {
  const url = "mysql://app:secret@db.example.com:3306/sisal";
  // `ssl: true` → TLS with default verification (mysql2 reads {} as "on").
  assertEquals(mysqlConfigFromUrl({ url, ssl: true }).ssl, {});
  // An object is forwarded verbatim to the driver's TLS layer.
  const tls = { ca: "-----BEGIN CERT-----", rejectUnauthorized: true };
  assertEquals(mysqlConfigFromUrl({ url, ssl: tls }).ssl, tls);
  // No ssl option → no ssl key (unencrypted, as before).
  assertEquals("ssl" in mysqlConfigFromUrl({ url }), false);
});

Deno.test("MariaDB pool config forwards the ssl option (SEC-009)", () => {
  const url = "mysql://app:secret@db.example.com:3306/sisal";
  assertEquals(mariadbConfigFromUrl({ url, ssl: true }).ssl, true);
  const tls = { ca: "-----BEGIN CERT-----" };
  assertEquals(mariadbConfigFromUrl({ url, ssl: tls }).ssl, tls);
  assertEquals("ssl" in mariadbConfigFromUrl({ url }), false);
});

Deno.test("pool config rejects TLS URL params rather than failing open (SEC-009)", () => {
  for (
    const url of [
      "mysql://app:secret@db.example.com:3306/sisal?ssl-mode=REQUIRED",
      "mysql://app:secret@db.example.com:3306/sisal?sslmode=verify-ca",
      "mysql://app:secret@db.example.com:3306/sisal?ssl=true",
    ]
  ) {
    assertThrows(
      () => mysqlConfigFromUrl({ url }),
      Error,
      "ssl",
    );
    assertThrows(
      () => mariadbConfigFromUrl({ url }),
      Error,
      "ssl",
    );
  }
});
