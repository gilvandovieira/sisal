/**
 * Machine-readable source of truth for the cross-driver feature matrix
 * (`docs/feature-matrix.md`, v0.5.0 roadmap item 3).
 *
 * One row per feature, one cell per adapter. Each `tested`/`roundtrip` cell
 * carries a `scenario` reference backed by the shared integration scenario
 * registry. `tools/generate_feature_matrix.ts` renders this to Markdown and,
 * with `--check`, asserts every such scenario exists — so the matrix cannot
 * claim coverage no integration scenario backs (roadmap item 6).
 *
 * @module
 */

import {
  CAPABILITY_TARGETS,
  capabilitySupported,
  DIALECT_CAPABILITIES,
  type DialectCapability,
} from "@sisal/orm";

/** The six adapters, in matrix-column order. */
export const ADAPTERS = [
  "pg",
  "neon",
  "sqlite",
  "libsql",
  "mysql",
  "mariadb",
] as const;
export type Adapter = (typeof ADAPTERS)[number];

/** Display labels for the adapter columns. */
export const ADAPTER_LABELS: Record<Adapter, string> = {
  pg: "Postgres",
  neon: "Neon",
  sqlite: "SQLite",
  libsql: "libSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
};

/**
 * `tested` ✅ — backed by a named integration test. `roundtrip` ⚠️ — works, with
 * a documented value-shape difference. `unsupported` ❌ — a genuine dialect
 * limit. `na` — not applicable.
 */
export type CellStatus = "tested" | "roundtrip" | "unsupported" | "na";

export interface Cell {
  status: CellStatus;
  /** Short in-cell label for ⚠️ cells (e.g. "LIKE", "text", "0/1"). */
  label?: string;
  /** One-line explanation for ⚠️/❌ cells, rendered in the Notes section. */
  reason?: string;
  /**
   * Scenario reference in the shared integration scenario registry. Set on
   * `tested`/`roundtrip` cells; falls back to the row-level `scenario`.
   */
  scenario?: string;
}

export interface FeatureRow {
  feature: string;
  /** Default scenario reference for cells that omit their own. */
  scenario?: string;
  cells: Record<Adapter, Cell>;
}

const ok = (scenario?: string): Cell => ({
  status: "tested",
  ...(scenario === undefined ? {} : { scenario }),
});
const warn = (label: string, reason: string, scenario?: string): Cell => ({
  status: "roundtrip",
  label,
  reason,
  ...(scenario === undefined ? {} : { scenario }),
});
const no = (reason: string): Cell => ({ status: "unsupported", reason });
const na: Cell = { status: "na" };

/**
 * A feature row whose per-adapter support is DERIVED from a registry
 * {@link DialectCapability} (v0.8 item 1, per-cell wiring): each cell is ❌ with
 * `reason` on the targets `capabilitySupported` excludes, else ✅ tested against
 * `scenario`. Because the values come from `DIALECT_CAPABILITIES`, these cells
 * cannot drift from the render-time guards — edit the capability, the matrix
 * follows. Reserved for capabilities with a pure supported/unsupported split;
 * constructs that *work with a documented fallback* (e.g. the MySQL-family
 * `RETURNING` surface) stay ⚠️ and hand-authored.
 */
const capabilityRow = (
  feature: string,
  capability: DialectCapability,
  scenario: string,
  reason: string,
): FeatureRow => ({
  feature,
  cells: Object.fromEntries(
    ADAPTERS.map((adapter) => [
      adapter,
      capabilitySupported(capability, CAPABILITY_TARGETS[adapter])
        ? ok(scenario)
        : no(reason),
    ]),
  ) as Record<Adapter, Cell>,
});

// Shared reasons for the principled SQLite-family divergences (roadmap item 5).
const LIKE = "No `ILIKE` keyword in the SQLite family; `ilike`/`notIlike` " +
  "render as ASCII case-insensitive `LIKE`/`NOT LIKE`.";
const TEXT = "No `json`/array type; values auto-serialize to `TEXT` and read " +
  "back as JSON strings (`JSON.parse` on read).";
const BOOL = "No native boolean; stored as `INTEGER` `0`/`1`.";
const BLOB = "`@libsql/client` returns BLOBs as `ArrayBuffer` (wrap with " +
  "`new Uint8Array(value)`); SQLite and Postgres return `Uint8Array`.";
const PG_ONLY = " Rendering it for a SQLite-family or MySQL-family dialect " +
  "throws a typed `OrmError` at render time, before execution.";
const DISTINCT_ON = "`DISTINCT ON` is PostgreSQL-only; the SQLite and MySQL " +
  "families reject it." + PG_ONLY;
// Locking is unsupported on the SQLite family only — the MySQL family renders
// `FOR UPDATE`/`FOR SHARE` natively — so it must NOT reuse the pg-only tail
// (which also names the MySQL family). See `rowLocking` in capabilities.ts.
const LOCKING = "No row-level locking (`FOR UPDATE`/`FOR SHARE`) in the " +
  "SQLite family; rendering it for a SQLite-family dialect throws a typed " +
  "`OrmError` at render time, before execution. The MySQL family renders it " +
  "natively.";
const ARRAY_OPS = "No array type or operators (`@>`/`<@`/`&&`) in the SQLite " +
  "or MySQL families." + PG_ONLY;
const DB_CALL = "No stored-function caller off Postgres; " +
  "`defineFunction`/`db.call` render PostgreSQL `SELECT * FROM fn(args)`.";
const DM_CTE =
  "Data-modifying CTEs (`INSERT`/`UPDATE`/`DELETE` inside `WITH`) " +
  "are PostgreSQL-only; SQLite-family and MySQL-family CTEs are " +
  "`SELECT`-only." + PG_ONLY;
const DATE_TRUNC =
  "No `date_trunc`; `dateTrunc` renders via `strftime`, which " +
  "returns the truncated timestamp as an ISO-8601 `TEXT` string (PostgreSQL " +
  "returns a `timestamp`). Both order and group identically.";

// Shared reasons for the principled MySQL-family divergences (v0.7 B8).
const MYSQL_RETURNING =
  "MySQL 8/9 has no `RETURNING`; `.returning()` throws a typed `OrmError` " +
  "at render time. The adapter's `insertReturning()` helper answers the " +
  "common case with a transactional fetch-by-key fallback (per-row " +
  "`LAST_INSERT_ID`, no consecutive-id arithmetic).";
const MARIADB_RETURNING =
  "MariaDB `RETURNING` is per-statement: the auto-detected identity lights " +
  "`INSERT`/`DELETE … RETURNING` (floors 10.5 / 10.0.5); " +
  "`UPDATE … RETURNING` stays a typed guard (13.0 floor). " +
  "`insertReturning()` uses the real clause here.";
const MYSQL_FULL_JOIN =
  "No `FULL JOIN` in MySQL/MariaDB; rendering it throws a typed `OrmError`. " +
  "INNER/LEFT/RIGHT joins work.";
const MYSQL_LIKE =
  "No `ILIKE` keyword in MySQL/MariaDB; `ilike`/`notIlike` render as " +
  "`LIKE`/`NOT LIKE`, which the default utf8mb4 collations already compare " +
  "case-insensitively.";
const MYSQL_JSON =
  "No array type; `json`/`jsonb`/`.array()` columns map to `JSON`. MySQL " +
  "parses values back to objects/arrays on read.";
const MARIADB_JSON =
  "MariaDB's `JSON` is a `LONGTEXT` alias, so JSON/array values read back " +
  "as JSON strings (`JSON.parse` on read) — the same shape as the SQLite " +
  "family.";
const MYSQL_BOOL = "No native boolean; stored as `TINYINT(1)` `0`/`1`.";
const MYSQL_DATE_TRUNC =
  "No `date_trunc`; `dateTrunc` renders via `DATE_FORMAT`, which returns " +
  "the truncated bucket as `TEXT`. Both order and group identically.";
const MYSQL_INDEXES =
  "`DESC` index keys apply; partial (`WHERE`) indexes are unsupported by both " +
  "engines, so the DDL generator throws a typed `OrmError`. Functional " +
  "(expression) indexes are emitted on a detected base MySQL ≥ 8.0.13 and " +
  "throw below that, on MariaDB (which has none — use a generated column), or " +
  "when the version is unknown. Sisal emits plain `CREATE INDEX` for every " +
  "dialect (no `IF NOT EXISTS`, which MySQL proper lacks).";

/** A row where every adapter is `tested` against the same scenario. */
const allTested = (feature: string, scenario: string): FeatureRow => ({
  feature,
  scenario,
  cells: {
    pg: ok(),
    neon: ok(),
    sqlite: ok(),
    libsql: ok(),
    mysql: ok(),
    mariadb: ok(),
  },
});

/** The unified feature matrix. */
export const FEATURE_MATRIX: FeatureRow[] = [
  allTested("Connection + raw parameterized SQL", "connect + raw"),
  allTested("Generated DDL (all column types)", "generated DDL applies"),
  {
    feature: "Insert / update / delete / returning",
    scenario: "insert + returning",
    cells: {
      pg: ok(),
      neon: ok(),
      sqlite: ok(),
      libsql: ok(),
      mysql: warn("fetch-by-key", MYSQL_RETURNING),
      mariadb: warn("per-statement", MARIADB_RETURNING),
    },
  },
  allTested("Filter / ordering / pagination", "filter operators"),
  {
    feature: "Joins (inner / left / right / full)",
    scenario: "joins",
    cells: {
      pg: ok(),
      neon: ok(),
      sqlite: ok(),
      libsql: ok(),
      mysql: warn("no FULL", MYSQL_FULL_JOIN, "inner / left / right joins"),
      mariadb: warn("no FULL", MYSQL_FULL_JOIN, "inner / left / right joins"),
    },
  },
  allTested("Aggregates / group / having", "aggregates"),
  allTested("Conditional aggregate (`filter`)", "filter aggregate"),
  {
    feature: "Portable `dateTrunc` (time bucketing)",
    scenario: "dateTrunc",
    cells: {
      pg: ok(),
      neon: ok(),
      sqlite: warn("text", DATE_TRUNC),
      libsql: warn("text", DATE_TRUNC),
      mysql: warn("text", MYSQL_DATE_TRUNC),
      mariadb: warn("text", MYSQL_DATE_TRUNC),
    },
  },
  allTested(
    "Interval/date math (`now`/`dateAdd`/`dateSub`/`dateBin`)",
    "date math window",
  ),
  allTested("Subqueries / exists / scalar", "subqueries"),
  allTested("Upsert (`onConflict…`)", "upsert"),
  allTested(
    "`sql` in `SET` / `VALUES` / `onConflict`",
    "sql expressions in SET",
  ),
  allTested(
    "Column naming (snake_case / `.named()` / preserve)",
    "column naming",
  ),
  allTested("Keyset pagination (expanded + row-value)", "keyset pagination"),
  allTested("Prepared statements", "prepared statement"),
  allTested(
    "Transactions (commit + rollback)",
    "transaction commit and rollback",
  ),
  allTested("`db.batch` (non-interactive, atomic)", "batch runs statements"),
  allTested(
    "Atomic operation / transaction script (`defineAtomicOperation`)",
    "atomic operation",
  ),
  allTested(
    "Atomic op single-round-trip dispatch (CTE on PG / interactive on SQLite)",
    "single-round-trip dispatch",
  ),
  {
    feature: "Rich indexes (DESC / partial / expression)",
    scenario: "rich indexes",
    cells: {
      pg: ok(),
      neon: ok(),
      sqlite: ok(),
      libsql: ok(),
      mysql: warn("DESC only", MYSQL_INDEXES),
      mariadb: warn("DESC only", MYSQL_INDEXES),
    },
  },
  allTested("Migrator (apply / plan / idempotent)", "migrator applies"),
  allTested(
    "Stored schema objects (functions / triggers / views)",
    "schema objects",
  ),
  allTested(
    "Typed raw-query mapping (`db.query(...).as(table)`)",
    "typed raw-query mapping",
  ),
  allTested("Temporal date/time modes", "Temporal date/time modes"),
  {
    feature: "`ilike` / `notIlike`",
    cells: {
      pg: ok("filter operators"),
      neon: ok("filter operators"),
      sqlite: warn("LIKE", LIKE, "ilike works"),
      libsql: warn("LIKE", LIKE, "ilike works"),
      mysql: warn("LIKE", MYSQL_LIKE, "ilike works"),
      mariadb: warn("LIKE", MYSQL_LIKE, "ilike works"),
    },
  },
  {
    feature: "`json` / array round-trip",
    cells: {
      pg: ok("jsonb round-trip"),
      neon: ok("jsonb round-trip"),
      sqlite: warn("text", TEXT, "JSON object round-trips"),
      libsql: warn("text", TEXT, "JSON object round-trips"),
      mysql: warn("JSON", MYSQL_JSON, "JSON object round-trips"),
      mariadb: warn("text", MARIADB_JSON, "JSON object round-trips"),
    },
  },
  {
    feature: "`boolean` round-trip",
    cells: {
      pg: ok("filter operators"),
      neon: ok("filter operators"),
      sqlite: warn("0/1", BOOL, "boolean stored as INTEGER"),
      libsql: warn("0/1", BOOL, "boolean stored as INTEGER"),
      mysql: warn("0/1", MYSQL_BOOL, "boolean stored as TINYINT"),
      mariadb: warn("0/1", MYSQL_BOOL, "boolean stored as TINYINT"),
    },
  },
  {
    feature: "`bytea` / BLOB round-trip",
    scenario: "bytea",
    cells: {
      pg: ok(),
      neon: ok(),
      sqlite: ok(),
      libsql: warn("ArrayBuffer", BLOB),
      mysql: ok(),
      mariadb: ok(),
    },
  },
  allTested("Float (`float4`/`float8`) round-trip → `number`", "float"),
  capabilityRow(
    "`distinctOn`",
    DIALECT_CAPABILITIES.distinctOn,
    "distinctOn",
    DISTINCT_ON,
  ),
  capabilityRow(
    "Row locking (`.for(...)`)",
    DIALECT_CAPABILITIES.rowLocking,
    "for update",
    LOCKING,
  ),
  capabilityRow(
    "Array operators (`@>` / `<@` / `&&`)",
    DIALECT_CAPABILITIES.arrayOperators,
    "array operators",
    ARRAY_OPS,
  ),
  {
    feature: "Typed function caller (`db.call`)",
    cells: {
      pg: ok("typed function caller"),
      neon: ok("typed function caller"),
      sqlite: no(DB_CALL),
      libsql: no(DB_CALL),
      mysql: no(DB_CALL),
      mariadb: no(DB_CALL),
    },
  },
  capabilityRow(
    "Data-modifying CTE (`WITH … INSERT/UPDATE/DELETE … RETURNING`)",
    DIALECT_CAPABILITIES.dataModifyingCte,
    "data-modifying CTE",
    DM_CTE,
  ),
  {
    feature: "Mutation joins (`UPDATE … FROM` / `INSERT … SELECT`)",
    scenario: "mutation joins",
    cells: {
      pg: ok(),
      neon: ok(),
      sqlite: ok(),
      libsql: ok(),
      mysql: ok(),
      mariadb: ok(),
    },
  },
  allTested(
    "ETL rollup (insert-from-select + `FILTER` + `dateTrunc` + upsert)",
    "ETL rollup",
  ),
  allTested(
    "Advisory run lock (portable lock-row lease)",
    "advisory lock",
  ),
  allTested(
    "Atomic load+advance (ETL checkpoint watermark)",
    "checkpoint",
  ),
  allTested(
    "Retention horizon + replay refusal (ETL)",
    "checkpoint retention",
  ),
  allTested(
    "Write outcome (inserted vs conflicted/claimed)",
    "write outcome",
  ),
  allTested("Read CTE (WITH on SELECT)", "read cte"),
  allTested(
    "Recursive CTE (WITH RECURSIVE; MySQL 8+/MariaDB)",
    "recursive cte",
  ),
];

/** Resolves the effective backing scenario for a cell. */
export function cellScenario(
  row: FeatureRow,
  adapter: Adapter,
): string | undefined {
  return row.cells[adapter].scenario ?? row.scenario;
}

void na; // reserved for future not-applicable cells
