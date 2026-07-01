/**
 * MySQL type/DDL mapping probe (v0.6.0 workstream C, task C4).
 *
 * Empirically validates the type + DDL mapping proposed for the future
 * `generateMysqlUpStatements` (v0.7) against a **real** MySQL/MariaDB server,
 * so every claim in `docs/mysql-ddl-mapping.md` is verified, not assumed:
 *
 * 1. Applies the proposed all-types `CREATE TABLE` (the MySQL analogue of the
 *    integration suites' `it_all_types`), inserts one rich row, and prints how
 *    the chosen driver (`mysql2`, with the C6-mandated `supportBigNumbers` +
 *    `bigNumberStrings`) decodes every column.
 * 2. Probes each DDL quirk the generator design depends on — inline
 *    `REFERENCES` silently ignored, `TEXT`/`JSON` literal defaults rejected,
 *    `TEXT` primary keys needing prefixes, `AUTO_INCREMENT` keying rules,
 *    `CREATE INDEX IF NOT EXISTS`, functional/partial/DESC indexes, `CHECK`
 *    enforcement, the `TIMESTAMP` 2038 range vs `DATETIME`, and the implicit
 *    `TIMESTAMP` default/on-update magic — printing a ✓/✗ verdict per quirk.
 *
 * Run it against both engines (MariaDB divergences feed C5):
 * ```sh
 * MYSQL_URL=mysql://root:root@localhost:33084/sisal deno task perf:mysql:ddl
 * MYSQL_URL=mysql://root:root@localhost:33110/sisal \
 *   MYSQL_SERVER_LABEL=mariadb11 deno task perf:mysql:ddl
 * ```
 *
 * The driver is loaded through a runtime-computed specifier, so it stays a
 * soft, run-time-only dependency (no workspace MySQL dependency — a v0.6
 * non-goal).
 *
 * @module
 */

/** The proposed column mapping, as one CREATE TABLE (see the C4 report). */
const ALL_TYPES_DDL = `create table \`it_mysql_types\` (
  \`id\` int not null auto_increment,
  \`c_text\` text,
  \`c_varchar\` varchar(50),
  \`c_char\` char(4),
  \`c_int\` int,
  \`c_smallint\` smallint,
  \`c_bigint\` bigint,
  \`c_numeric\` decimal(10, 2),
  \`c_real\` float,
  \`c_double\` double,
  \`c_bool\` boolean,
  \`c_json\` json,
  \`c_jsonb\` json,
  \`c_date\` date,
  \`c_time\` time(6),
  \`c_ts\` datetime(6),
  \`c_tstz\` timestamp(6) null,
  \`c_uuid\` char(36),
  \`c_text_arr\` json,
  \`c_blob\` longblob,
  primary key (\`id\`)
)`;

const ALL_TYPES_INSERT = `insert into \`it_mysql_types\` (
  c_text, c_varchar, c_char, c_int, c_smallint, c_bigint, c_numeric,
  c_real, c_double, c_bool, c_json, c_jsonb, c_date, c_time, c_ts, c_tstz,
  c_uuid, c_text_arr, c_blob
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const ALL_TYPES_ARGS: unknown[] = [
  "hello",
  "varchar value",
  "abcd",
  42,
  7,
  "9007199254740993", // 2^53 + 1 — precision canary
  "1234.50",
  1.5,
  2.5,
  true,
  JSON.stringify({ note: "n" }),
  JSON.stringify({ deep: { ok: true } }),
  "2026-06-28",
  "12:34:56.123456",
  "2026-06-28 12:34:56.123456",
  "2026-06-28 12:34:56.123456",
  "6f2e1b34-0000-4000-8000-000000000000",
  JSON.stringify(["x", "y"]), // .array() → JSON
  new Uint8Array([1, 2, 3]),
];

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) return `Date (${value.toISOString()})`;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return value.constructor.name;
  }
  if (typeof value === "bigint") return `bigint (${value})`;
  if (Array.isArray(value)) return `array ${JSON.stringify(value)}`;
  if (typeof value === "object") {
    if ((value as { type?: string }).type === "Buffer") return "Buffer";
    return `object ${JSON.stringify(value)}`;
  }
  return `${typeof value} (${String(value)})`;
}

interface Conn {
  query(sql: string, args?: unknown[]): Promise<unknown>;
  execute(sql: string, args?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

async function connect(url: string): Promise<Conn> {
  // Runtime-computed specifier: soft run-time dependency only.
  const mod = await import(["npm:", "mysql2@^3.22.5/promise"].join("")) as {
    default: {
      createConnection(config: unknown): Promise<Conn>;
    };
  };
  const parsed = new URL(url);
  return await mod.default.createConnection({
    host: parsed.hostname,
    port: parsed.port === "" ? 3306 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    // The C6-mandated executor options: mysql2's default BIGINT decode is
    // silently lossy past 2^53; these make it a precision-safe string.
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

async function rows(conn: Conn, sql: string): Promise<unknown[]> {
  const result = await conn.query(sql) as [unknown[], unknown];
  return result[0];
}

/** One quirk probe: statements to run and the expectation to verify. */
interface Quirk {
  readonly id: string;
  readonly what: string;
  run(conn: Conn): Promise<string>;
}

async function expectError(
  action: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return (error as Error).message.split("\n")[0].slice(0, 90);
  }
}

const QUIRKS: Quirk[] = [
  {
    id: "fk-inline",
    what: "inline column REFERENCES is silently ignored",
    run: async (conn) => {
      await conn.query("create table it_q_parent (id int primary key)");
      await conn.query(
        "create table it_q_child (id int primary key, " +
          "parent_id int references it_q_parent (id))",
      );
      const found = await rows(
        conn,
        "select count(*) as n from information_schema.referential_constraints" +
          " where constraint_schema = database()" +
          " and table_name = 'it_q_child'",
      ) as Array<{ n: unknown }>;
      return Number(found[0].n) === 0
        ? "IGNORED (no FK created) — table-level FOREIGN KEY required"
        : "honored (FK exists)";
    },
  },
  {
    id: "fk-table-level",
    what: "ALTER TABLE … ADD FOREIGN KEY (the pg generator's pattern)",
    run: async (conn) => {
      // Fresh child with NO inline reference, so the count isolates the
      // ALTER TABLE-added constraint (MariaDB honors inline refs, MySQL not).
      await conn.query("drop table if exists it_q_child2");
      await conn.query(
        "create table it_q_child2 (id int primary key, parent_id int)",
      );
      await conn.query(
        "alter table it_q_child2 add foreign key (parent_id)" +
          " references it_q_parent (id) on delete cascade",
      );
      const found = await rows(
        conn,
        "select count(*) as n from information_schema.referential_constraints" +
          " where constraint_schema = database()" +
          " and table_name = 'it_q_child2'",
      ) as Array<{ n: unknown }>;
      return Number(found[0].n) === 1 ? "works" : "FAILED";
    },
  },
  {
    id: "text-pk",
    what: "TEXT primary key without a prefix length",
    run: async (conn) => {
      const error = await expectError(() =>
        conn.query("create table it_q_textpk (id text primary key)")
      );
      return error === undefined ? "accepted" : `rejected — ${error}`;
    },
  },
  {
    id: "text-literal-default",
    what: "TEXT column with a literal DEFAULT",
    run: async (conn) => {
      const error = await expectError(() =>
        conn.query("create table it_q_textdef (t text default 'x')")
      );
      return error === undefined ? "accepted" : `rejected — ${error}`;
    },
  },
  {
    id: "json-literal-default",
    what: "JSON column with a literal DEFAULT '{}'",
    run: async (conn) => {
      const error = await expectError(() =>
        conn.query("create table it_q_jsondef1 (j json default '{}')")
      );
      return error === undefined ? "accepted" : `rejected — ${error}`;
    },
  },
  {
    id: "json-paren-default",
    what: "JSON column with a parenthesized expression DEFAULT ('{}')",
    run: async (conn) => {
      const error = await expectError(() =>
        conn.query("create table it_q_jsondef2 (j json default ('{}'))")
      );
      return error === undefined ? "accepted" : `rejected — ${error}`;
    },
  },
  {
    id: "uuid-paren-default",
    what: "CHAR(36) DEFAULT (uuid()) — expression default for uuid",
    run: async (conn) => {
      const error = await expectError(() =>
        conn.query("create table it_q_uuiddef (u char(36) default (uuid()))")
      );
      return error === undefined ? "accepted" : `rejected — ${error}`;
    },
  },
  {
    id: "auto-increment-unkeyed",
    what: "AUTO_INCREMENT on a non-key column",
    run: async (conn) => {
      const error = await expectError(() =>
        conn.query("create table it_q_ai (n int auto_increment)")
      );
      return error === undefined
        ? "accepted"
        : `rejected — ${error} (must be a key; one per table)`;
    },
  },
  {
    id: "index-if-not-exists",
    what: "CREATE INDEX IF NOT EXISTS",
    run: async (conn) => {
      await conn.query("create table it_q_idx (a int, b varchar(50))");
      const error = await expectError(() =>
        conn.query("create index if not exists it_q_idx_a on it_q_idx (a)")
      );
      return error === undefined ? "accepted" : `rejected — ${error}`;
    },
  },
  {
    id: "index-desc",
    what: "CREATE INDEX … (col DESC)",
    run: async (conn) => {
      const error = await expectError(() =>
        conn.query("create index it_q_idx_desc on it_q_idx (a desc)")
      );
      return error === undefined ? "accepted" : `rejected — ${error}`;
    },
  },
  {
    id: "index-functional",
    what: "functional index CREATE INDEX … ((lower(b)))",
    run: async (conn) => {
      const error = await expectError(() =>
        conn.query("create index it_q_idx_fn on it_q_idx ((lower(b)))")
      );
      return error === undefined ? "accepted" : `rejected — ${error}`;
    },
  },
  {
    id: "index-partial",
    what: "partial index CREATE INDEX … WHERE a > 0",
    run: async (conn) => {
      const error = await expectError(() =>
        conn.query("create index it_q_idx_part on it_q_idx (a) where a > 0")
      );
      return error === undefined ? "accepted" : `rejected — ${error}`;
    },
  },
  {
    id: "check-enforced",
    what: "CHECK constraint enforcement on insert",
    run: async (conn) => {
      await conn.query(
        "create table it_q_check (n int, constraint n_pos check (n > 0))",
      );
      const error = await expectError(() =>
        conn.query("insert into it_q_check values (-1)")
      );
      return error === undefined
        ? "NOT enforced (insert of -1 accepted)"
        : `enforced — ${error}`;
    },
  },
  {
    id: "timestamp-2038",
    what: "TIMESTAMP column accepts 2040-01-01 (the 2038 range limit)",
    run: async (conn) => {
      await conn.query(
        "create table it_q_ts (t timestamp(6) null, d datetime(6))",
      );
      const tsError = await expectError(() =>
        conn.query("insert into it_q_ts (t) values ('2040-01-01 00:00:00')")
      );
      const dtError = await expectError(() =>
        conn.query("insert into it_q_ts (d) values ('2040-01-01 00:00:00')")
      );
      const ts = tsError === undefined
        ? "TIMESTAMP accepts 2040"
        : `TIMESTAMP rejects 2040 (${tsError})`;
      const dt = dtError === undefined
        ? "DATETIME accepts 2040"
        : `DATETIME rejects 2040 (${dtError})`;
      return `${ts}; ${dt}`;
    },
  },
  {
    id: "timestamp-implicit-magic",
    what: "plain TIMESTAMP gets implicit DEFAULT/ON UPDATE CURRENT_TIMESTAMP",
    run: async (conn) => {
      await conn.query("create table it_q_tsmagic (t timestamp)");
      const described = await rows(
        conn,
        "select column_default as d, extra as e, is_nullable as n" +
          " from information_schema.columns" +
          " where table_schema = database()" +
          " and table_name = 'it_q_tsmagic' and column_name = 't'",
      ) as Array<{ d: unknown; e: unknown; n: unknown }>;
      const { d, e, n } = described[0];
      // `column_default` reports the literal string "NULL" for an explicit
      // NULL default on MariaDB — only CURRENT_TIMESTAMP markers are magic.
      const magic =
        String(d ?? "").toLowerCase().includes("current_timestamp") ||
        String(e).toLowerCase().includes("update");
      return magic
        ? `MAGIC PRESENT (default=${d}, extra=${e}, nullable=${n})`
        : `no magic (default=${d}, extra=${e}, nullable=${n})`;
    },
  },
  {
    id: "boolean-alias",
    what: "BOOLEAN column type is stored as",
    run: async (conn) => {
      const described = await rows(
        conn,
        "select column_type as t from information_schema.columns" +
          " where table_schema = database()" +
          " and table_name = 'it_mysql_types' and column_name = 'c_bool'",
      ) as Array<{ t: unknown }>;
      return String(described[0].t);
    },
  },
];

const DROP_TABLES = [
  "it_q_child",
  "it_q_child2",
  "it_q_parent",
  "it_q_textpk",
  "it_q_textdef",
  "it_q_jsondef1",
  "it_q_jsondef2",
  "it_q_uuiddef",
  "it_q_ai",
  "it_q_idx",
  "it_q_check",
  "it_q_ts",
  "it_q_tsmagic",
  "it_mysql_types",
];

async function main(): Promise<void> {
  const url = env("MYSQL_URL");
  if (url === undefined) {
    console.error(
      "MYSQL_URL is required, e.g. " +
        "MYSQL_URL=mysql://root:root@localhost:33084/sisal",
    );
    Deno.exit(2);
  }
  const serverLabel = env("MYSQL_SERVER_LABEL") ?? "mysql";
  const conn = await connect(url);

  const version = await rows(conn, "select version() as v") as Array<
    { v: unknown }
  >;
  console.log(
    `MySQL DDL/type mapping probe — server=${serverLabel} ` +
      `(${String(version[0].v)})\n`,
  );

  for (const table of DROP_TABLES) {
    await conn.query(`drop table if exists ${table}`);
  }

  // ---- 1. the proposed all-types mapping applies + round-trips ------------
  await conn.query(ALL_TYPES_DDL);
  await conn.execute(ALL_TYPES_INSERT, ALL_TYPES_ARGS);
  const back = await conn.execute(
    "select * from it_mysql_types where id = 1",
  ) as [Record<string, unknown>[], unknown];
  console.log(
    "proposed mapping applies; round-trip via mysql2 " +
      "(supportBigNumbers + bigNumberStrings):",
  );
  for (const [key, value] of Object.entries(back[0][0])) {
    console.log(`  ${key.padEnd(11)} ${describeValue(value)}`);
  }
  console.log();

  // ---- 2. the quirks the generator design depends on -----------------------
  console.log("DDL quirks:");
  for (const quirk of QUIRKS) {
    let finding: string;
    try {
      finding = await quirk.run(conn);
    } catch (error) {
      finding = `PROBE ERROR — ${(error as Error).message.slice(0, 90)}`;
    }
    console.log(`  ${quirk.id.padEnd(26)} ${finding}`);
  }

  for (const table of DROP_TABLES) {
    await conn.query(`drop table if exists ${table}`);
  }
  await conn.end();
}

if (import.meta.main) {
  await main();
}
