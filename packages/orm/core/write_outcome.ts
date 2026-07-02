/**
 * The portable write-outcome (v0.9 T15, v0.8 item 16): a reliable
 * **inserted-vs-conflicted/claimed** signal for a conflict-guarded insert, which
 * `rowCount` alone cannot give across engines — the MySQL no-op
 * `ON DUPLICATE KEY UPDATE` rendering reports affected rows ambiguously (v0.8
 * found `onConflictDoNothing().execute().rowCount` unreliable there).
 *
 * `tryInsert` reads the signal the right way per dialect: it appends `RETURNING`
 * on the Postgres and SQLite families (a row comes back **iff** the insert won,
 * so the outcome is exact), and reads the affected-row count on the MySQL family
 * (no usable `RETURNING` on a no-op upsert — the count is 1 on insert, 0 on a
 * conflict). This is what lets the advisory-lock claim (T11) and future
 * queue-claim helpers report claimed-vs-not portably.
 *
 * Part of the `@sisal/orm` core.
 *
 * @module
 */

import { OrmError } from "@sisal/core";
import type { SqlDialect } from "@sisal/core";
import type { Database, OrmQueryResult } from "./database.ts";

/** The outcome of a conflict-guarded insert — did it write a new row? */
export interface WriteOutcome {
  /**
   * `true` when a new row was written; `false` when the insert hit an existing
   * key and did nothing — a conflict (the row is held/claimed by someone else).
   */
  readonly inserted: boolean;
  /** Rows affected as reported by the driver (for diagnostics/logging). */
  readonly rowCount: number;
}

// The minimal shape `tryInsert` drives: a built, conflict-guarded insert. The
// `InsertBuilder` satisfies it structurally, so callers pass their builder
// directly without this module importing the builder types.
interface RunnableInsert {
  returning(): { execute(): Promise<OrmQueryResult> };
  execute(): Promise<OrmQueryResult>;
}

// `RETURNING` is a reliable outcome signal for `ON CONFLICT DO NOTHING` on these
// dialects: a row is returned iff a row was written. The MySQL family renders a
// no-op `ON DUPLICATE KEY UPDATE`, which supports no `RETURNING` on MySQL or
// MariaDB, so it falls back to the affected-row count.
const RETURNING_INSERT_DIALECTS: ReadonlySet<SqlDialect> = new Set([
  "postgres",
  "sqlite",
]);

/**
 * Runs a **conflict-guarded** insert (you supply `.onConflictDoNothing()`) and
 * reports whether it wrote a new row — the portable "inserted vs
 * conflicted/claimed" outcome. On the Postgres/SQLite families it appends
 * `RETURNING` for an exact signal; on the MySQL family it reads the affected-row
 * count (1 on insert, 0 on conflict). Throws `ORM_DIALECT_UNSUPPORTED` on the
 * `generic` dialect.
 *
 * ```ts
 * const outcome = await tryInsert(
 *   db,
 *   db.insert(jobs).values(row).onConflictDoNothing(),
 * );
 * if (outcome.inserted) claimed(); else alreadyHeld();
 * ```
 */
export async function tryInsert(
  db: Database,
  insert: RunnableInsert,
): Promise<WriteOutcome> {
  if (db.dialect === "generic") {
    throw new OrmError(
      "Conflict-guarded insert outcomes are not supported by the generic " +
        "dialect",
      { code: "ORM_DIALECT_UNSUPPORTED", status: 400 },
    );
  }
  if (RETURNING_INSERT_DIALECTS.has(db.dialect)) {
    const result = await insert.returning().execute();
    return { inserted: result.rows.length > 0, rowCount: result.rows.length };
  }
  const result = await insert.execute();
  const rowCount = result.rowCount ?? 0;
  return { inserted: rowCount >= 1, rowCount };
}
