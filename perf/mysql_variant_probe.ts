/**
 * MySQL-vs-MariaDB variant capability probe (v0.6.0 workstream C, task C5).
 *
 * Runs the capability set where the two engines are known or suspected to
 * diverge — plus the constructs Sisal's builder can render — against a live
 * server, so the C5 split decision in `docs/mysql-readiness.md` rests on
 * first-hand verdicts, not documentation. This also converts the C2/C3
 * research claims (`RETURNING` support, the ON DUPLICATE KEY UPDATE row
 * alias) from sourced facts into executed ones.
 *
 * Run it against both engines and diff the output:
 * ```sh
 * MYSQL_URL=mysql://root:root@localhost:33084/sisal deno task perf:mysql:variant
 * MYSQL_URL=mysql://root:root@localhost:33110/sisal \
 *   MYSQL_SERVER_LABEL=mariadb11 deno task perf:mysql:variant
 * ```
 *
 * The driver is loaded through a runtime-computed specifier, so it stays a
 * soft, run-time-only dependency (no workspace MySQL dependency — a v0.6
 * non-goal).
 *
 * @module
 */

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

interface Conn {
  query(sql: string, args?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

async function connect(url: string): Promise<Conn> {
  // Runtime-computed specifier: soft run-time dependency only.
  const mod = await import(["npm:", "mysql2@^3.22.5/promise"].join("")) as {
    default: { createConnection(config: unknown): Promise<Conn> };
  };
  const parsed = new URL(url);
  return await mod.default.createConnection({
    host: parsed.hostname,
    port: parsed.port === "" ? 3306 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

/** One capability: setup + the statement whose acceptance is the verdict. */
interface Capability {
  readonly id: string;
  readonly what: string;
  readonly setup?: readonly string[];
  readonly probe: string;
}

const CAPABILITIES: Capability[] = [
  {
    id: "insert-returning",
    what: "INSERT … RETURNING (C3: MariaDB 10.5+, MySQL never)",
    setup: [
      "drop table if exists it_v_ret",
      "create table it_v_ret (id int primary key, t varchar(20))",
    ],
    probe: "insert into it_v_ret values (1, 'a') returning id",
  },
  {
    id: "delete-returning",
    what: "DELETE … RETURNING (C3: MariaDB 10.0.5+, MySQL never)",
    setup: ["insert into it_v_ret values (2, 'b')"],
    probe: "delete from it_v_ret where id = 2 returning id",
  },
  {
    id: "update-returning",
    what: "UPDATE … RETURNING (C3: MariaDB 13.0+ only — expect rejected here)",
    probe: "update it_v_ret set t = 'c' where id = 1 returning id",
  },
  {
    id: "odku-values-fn",
    what: "ON DUPLICATE KEY UPDATE … VALUES(col) (C2's chosen portable form)",
    probe: "insert into it_v_ret values (1, 'x')" +
      " on duplicate key update t = values(t)",
  },
  {
    id: "odku-row-alias",
    what: "ODKU row alias `AS new … new.col` (C2: MySQL 8.0.19+ only)",
    probe: "insert into it_v_ret values (1, 'y') as new" +
      " on duplicate key update t = new.t",
  },
  {
    id: "full-outer-join",
    what: "FULL OUTER JOIN (Sisal's fullJoin — pg/sqlite have it)",
    probe: "select * from it_v_ret a full outer join it_v_ret b on a.id = b.id",
  },
  {
    id: "right-join",
    what: "RIGHT JOIN (Sisal's rightJoin)",
    probe: "select * from it_v_ret a right join it_v_ret b on a.id = b.id",
  },
  {
    id: "lateral",
    what: "LATERAL derived table (MySQL 8.0.14+)",
    probe: "select * from it_v_ret a," +
      " lateral (select a.id + 1 as next_id) l",
  },
  {
    id: "intersect",
    what: "INTERSECT (MySQL 8.0.31+, MariaDB 10.3+)",
    probe: "select 1 intersect select 1",
  },
  {
    id: "except",
    what: "EXCEPT (MySQL 8.0.31+, MariaDB 10.3+)",
    probe: "select 1 except select 2",
  },
  {
    id: "cte",
    what: "WITH … SELECT (both, MySQL 8 / MariaDB 10.2+)",
    probe: "with x as (select 1 as a) select a from x",
  },
  {
    id: "window-fn",
    what: "window functions (both, MySQL 8 / MariaDB 10.2+)",
    probe: "select id, row_number() over (order by id) as rn from it_v_ret",
  },
  {
    id: "json-arrow",
    what: "JSON `->>` path operator",
    setup: [
      "drop table if exists it_v_json",
      "create table it_v_json (j json)",
      `insert into it_v_json values ('{"a": 1}')`,
    ],
    probe: "select j->>'$.a' as v from it_v_json",
  },
  {
    id: "json-table",
    what: "JSON_TABLE (MySQL 8, MariaDB 10.6+)",
    probe: "select jt.a from json_table('[{\"a\":1}]', '$[*]'" +
      " columns (a int path '$.a')) as jt",
  },
  {
    id: "json-value",
    what: "JSON_VALUE (MySQL 8.0.21+, MariaDB 10.0+)",
    probe: `select json_value('{"a":1}', '$.a') as v`,
  },
  {
    id: "create-sequence",
    what: "CREATE SEQUENCE (MariaDB 10.3+ only)",
    setup: ["drop table if exists it_v_seq"],
    probe: "create sequence it_v_seq",
  },
  {
    id: "uuid-type",
    what: "native UUID column type (MariaDB 10.7+ only)",
    setup: ["drop table if exists it_v_uuid"],
    probe: "create table it_v_uuid (u uuid)",
  },
];

const CLEANUP = [
  "drop table if exists it_v_ret",
  "drop table if exists it_v_json",
  "drop table if exists it_v_uuid",
  "drop sequence if exists it_v_seq",
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

  const version = await conn.query("select version() as v") as [
    Array<{ v: unknown }>,
    unknown,
  ];
  console.log(
    `MySQL-vs-MariaDB variant probe — server=${serverLabel} ` +
      `(${String(version[0][0].v)})\n`,
  );

  for (const capability of CAPABILITIES) {
    for (const statement of capability.setup ?? []) {
      try {
        await conn.query(statement);
      } catch {
        // Setup best-effort; the probe verdict is what matters.
      }
    }
    let verdict: string;
    try {
      await conn.query(capability.probe);
      verdict = "✓ supported";
    } catch (error) {
      verdict = `✗ rejected — ${
        (error as Error).message.split("\n")[0].slice(0, 70)
      }`;
    }
    console.log(`  ${capability.id.padEnd(18)} ${verdict}`);
    console.log(`  ${"".padEnd(18)} (${capability.what})`);
  }

  for (const statement of CLEANUP) {
    try {
      await conn.query(statement);
    } catch {
      // MySQL has no DROP SEQUENCE; ignore.
    }
  }
  await conn.end();
}

if (import.meta.main) {
  await main();
}
