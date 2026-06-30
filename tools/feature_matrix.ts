/**
 * Machine-readable source of truth for the cross-driver feature matrix
 * (`docs/feature-matrix.md`, v0.5.0 roadmap item 3).
 *
 * One row per feature, one cell per adapter. Each `tested`/`roundtrip` cell
 * carries a `test` substring that must appear in a `"<adapter>: …"` test name in
 * `integration/<adapter>_features_test.ts`; `tools/generate_feature_matrix.ts`
 * renders this to Markdown and, with `--check`, asserts every such test exists —
 * so the matrix cannot claim coverage no integration test backs (roadmap item 6).
 *
 * @module
 */

/** The four adapters, in matrix-column order. */
export const ADAPTERS = ["pg", "neon", "sqlite", "libsql"] as const;
export type Adapter = (typeof ADAPTERS)[number];

/** Display labels for the adapter columns. */
export const ADAPTER_LABELS: Record<Adapter, string> = {
  pg: "Postgres",
  neon: "Neon",
  sqlite: "SQLite",
  libsql: "libSQL",
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
   * Substring of the backing `"<adapter>: …"` integration-test name. Set on
   * `tested`/`roundtrip` cells; falls back to the row-level `test`.
   */
  test?: string;
}

export interface FeatureRow {
  feature: string;
  /** Default `test` substring for cells that omit their own. */
  test?: string;
  cells: Record<Adapter, Cell>;
}

const ok = (test?: string): Cell => ({
  status: "tested",
  ...(test === undefined ? {} : { test }),
});
const warn = (label: string, reason: string, test?: string): Cell => ({
  status: "roundtrip",
  label,
  reason,
  ...(test === undefined ? {} : { test }),
});
const no = (reason: string): Cell => ({ status: "unsupported", reason });
const na: Cell = { status: "na" };

// Shared reasons for the principled SQLite-family divergences (roadmap item 5).
const LIKE = "No `ILIKE` keyword in the SQLite family; `ilike`/`notIlike` " +
  "render as ASCII case-insensitive `LIKE`/`NOT LIKE`.";
const TEXT = "No `json`/array type; values auto-serialize to `TEXT` and read " +
  "back as JSON strings (`JSON.parse` on read).";
const BOOL = "No native boolean; stored as `INTEGER` `0`/`1`.";
const BLOB = "`@libsql/client` returns BLOBs as `ArrayBuffer` (wrap with " +
  "`new Uint8Array(value)`); SQLite and Postgres return `Uint8Array`.";
const PG_ONLY = " Rendering it for a SQLite-family dialect throws a typed " +
  "`OrmError` at render time, before execution.";
const DISTINCT_ON = "`DISTINCT ON` is PostgreSQL-only; SQLite-family engines " +
  "reject it." + PG_ONLY;
const LOCKING = "No row-level locking (`FOR UPDATE`/`FOR SHARE`) in the " +
  "SQLite family." + PG_ONLY;
const ARRAY_OPS = "No array type or operators (`@>`/`<@`/`&&`) in the SQLite " +
  "family." + PG_ONLY;
const DB_CALL = "No stored-function concept in the SQLite family; " +
  "`defineFunction`/`db.call` target Postgres.";
const DM_CTE =
  "Data-modifying CTEs (`INSERT`/`UPDATE`/`DELETE` inside `WITH`) " +
  "are PostgreSQL-only; the SQLite family's CTEs are `SELECT`-only." + PG_ONLY;

/** A row where every adapter is `tested` against the same `test` substring. */
const allTested = (feature: string, test: string): FeatureRow => ({
  feature,
  test,
  cells: { pg: ok(), neon: ok(), sqlite: ok(), libsql: ok() },
});

/** The unified feature matrix. */
export const FEATURE_MATRIX: FeatureRow[] = [
  allTested("Connection + raw parameterized SQL", "connect + raw"),
  allTested("Generated DDL (all column types)", "generated DDL applies"),
  allTested("Insert / update / delete / returning", "insert + returning"),
  allTested("Filter / ordering / pagination", "filter operators"),
  allTested("Joins (inner / left / right / full)", "joins"),
  allTested("Aggregates / group / having", "aggregates"),
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
  allTested("Rich indexes (DESC / partial / expression)", "rich indexes"),
  allTested("Migrator (apply / plan / idempotent)", "migrator applies"),
  allTested("Temporal date/time modes", "Temporal date/time modes"),
  {
    feature: "`ilike` / `notIlike`",
    cells: {
      pg: ok("filter operators"),
      neon: ok("filter operators"),
      sqlite: warn("LIKE", LIKE, "ilike works"),
      libsql: warn("LIKE", LIKE, "ilike works"),
    },
  },
  {
    feature: "`json` / array round-trip",
    cells: {
      pg: ok("jsonb round-trip"),
      neon: ok("jsonb round-trip"),
      sqlite: warn("text", TEXT, "JSON object round-trips"),
      libsql: warn("text", TEXT, "JSON object round-trips"),
    },
  },
  {
    feature: "`boolean` round-trip",
    cells: {
      pg: ok("filter operators"),
      neon: ok("filter operators"),
      sqlite: warn("0/1", BOOL, "boolean stored as INTEGER"),
      libsql: warn("0/1", BOOL, "boolean stored as INTEGER"),
    },
  },
  {
    feature: "`bytea` / BLOB round-trip",
    test: "bytea",
    cells: {
      pg: ok(),
      neon: ok(),
      sqlite: ok(),
      libsql: warn("ArrayBuffer", BLOB),
    },
  },
  allTested("Float (`float4`/`float8`) round-trip → `number`", "float"),
  {
    feature: "`distinctOn`",
    cells: {
      pg: ok("distinctOn"),
      neon: ok("distinctOn"),
      sqlite: no(DISTINCT_ON),
      libsql: no(DISTINCT_ON),
    },
  },
  {
    feature: "Row locking (`.for(...)`)",
    cells: {
      pg: ok("for update"),
      neon: ok("for update"),
      sqlite: no(LOCKING),
      libsql: no(LOCKING),
    },
  },
  {
    feature: "Array operators (`@>` / `<@` / `&&`)",
    cells: {
      pg: ok("array operators"),
      neon: ok("array operators"),
      sqlite: no(ARRAY_OPS),
      libsql: no(ARRAY_OPS),
    },
  },
  {
    feature: "Typed function caller (`db.call`)",
    cells: {
      pg: ok("typed function caller"),
      neon: ok("typed function caller"),
      sqlite: no(DB_CALL),
      libsql: no(DB_CALL),
    },
  },
  {
    feature: "Data-modifying CTE (`WITH … INSERT/UPDATE/DELETE … RETURNING`)",
    cells: {
      pg: ok("data-modifying CTE"),
      neon: ok("data-modifying CTE"),
      sqlite: no(DM_CTE),
      libsql: no(DM_CTE),
    },
  },
];

/** Resolves the effective backing-test substring for a cell. */
export function cellTest(
  row: FeatureRow,
  adapter: Adapter,
): string | undefined {
  return row.cells[adapter].test ?? row.test;
}

void na; // reserved for future not-applicable cells
