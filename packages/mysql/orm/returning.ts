/**
 * `RETURNING` execution strategy for the MySQL/MariaDB adapter (v0.7 B7).
 *
 * MySQL 8/9 has no `RETURNING` clause at all, and MariaDB's arrives
 * per-statement and per-version — so the core renderer guards it (a typed
 * `ORM_DIALECT_UNSUPPORTED` throw) instead of emitting SQL one engine would
 * reject. {@link insertReturning} is the adapter's execution-side answer for
 * the common case, "give me back the rows I just inserted":
 *
 * 1. **Attempt real `INSERT … RETURNING` first.** On a facade whose detected
 *    identity lights it (MariaDB ≥ 10.5), this is one statement with true
 *    `RETURNING` semantics. The core guard stays the single source of truth
 *    for variant/version floors — this module never duplicates them; it
 *    catches exactly the typed guard error and falls back.
 * 2. **Fetch-by-key fallback** inside a transaction, honest about its
 *    preconditions instead of guessing:
 *    - Every row carries explicit values for the full primary key → one
 *      `INSERT`, one `SELECT` back by key, results in input order.
 *    - Single-column key with missing values → **one `INSERT` per row**,
 *      capturing each statement's own `LAST_INSERT_ID`. Deliberately no
 *      first-id-plus-offset arithmetic: with MySQL 8's default
 *      `innodb_autoinc_lock_mode = 2` a batch's generated ids are not
 *      guaranteed consecutive, so the arithmetic shortcut can silently
 *      return someone else's rows.
 *    - No primary key, a composite key with missing values, or a key the
 *      server generated without reporting (`DEFAULT (uuid())`) → a typed
 *      `OrmError`, never a wrong answer.
 *
 * @module
 */

import {
  and,
  type AnyTableDefinition,
  type Database,
  eq,
  inArray,
  type InferSelect,
  type InsertValues,
  isSql,
  or,
  OrmError,
  type TableDefinition,
} from "@sisal/orm";

// Must match the render guard's construct label in the ORM core
// (`RETURNING_GUARDS.insert`) — pinned by the unit tests.
const INSERT_RETURNING_CONSTRUCT = "INSERT … RETURNING";

// Marks this module's own contract errors so they can be re-surfaced from
// the facade's ORM_TRANSACTION_FAILED wrap.
const HELPER_MARKER = "insertReturning";

function helperError(
  message: string,
  code: "ORM_INVALID_QUERY" | "ORM_EXECUTE_FAILED",
): OrmError {
  return new OrmError(message, { code, details: { helper: HELPER_MARKER } });
}

// The facade wraps any error thrown inside `db.transaction(...)` as
// ORM_TRANSACTION_FAILED; unwrap this module's own typed errors so callers
// get the documented contract error, not the wrapper.
async function inTransaction<T>(
  db: Database,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(fn);
  } catch (error) {
    if (
      error instanceof OrmError && error.cause instanceof OrmError &&
      error.cause.details?.helper === HELPER_MARKER
    ) {
      throw error.cause;
    }
    throw error;
  }
}

/**
 * Inserts rows and returns them, choosing the best strategy the connected
 * server supports: real `INSERT … RETURNING` where the facade's detected
 * identity lights it (MariaDB ≥ 10.5), otherwise a transactional
 * fetch-by-key fallback. Rows come back in input order under both
 * strategies.
 *
 * Works on the main facade and inside `db.transaction(...)` callbacks alike
 * (the fallback then reuses the caller's transaction).
 *
 * The fallback needs a way to find the rows again, so it throws a typed
 * `OrmError` (`ORM_INVALID_QUERY`) when the table has no primary key, when a
 * composite key is not fully provided, or when a generated key is not
 * reported by the driver (only `AUTO_INCREMENT` keys are — a DB-side
 * `DEFAULT (uuid())` is invisible to it; generate such keys client-side or
 * pass them explicitly).
 */
export async function insertReturning<TTable extends AnyTableDefinition>(
  db: Database,
  table: TTable,
  values: InsertValues<TTable> | InsertValues<TTable>[],
): Promise<InferSelect<TTable>[]> {
  const rows = (Array.isArray(values) ? values : [values]) as Record<
    string,
    unknown
  >[];
  if (rows.length === 0) {
    return [];
  }

  try {
    const result = await db.insert(table).values(
      values as InsertValues<TTable>,
    ).returning().execute();
    return result.rows;
  } catch (error) {
    if (!isInsertReturningGuardError(error)) {
      throw error;
    }
  }

  const pkKeys = primaryKeyPropertyNames(table);
  if (pkKeys.length === 0) {
    throw new OrmError(
      `insertReturning fallback on table "${table.name}" requires a primary key to fetch the inserted rows back.`,
      { code: "ORM_INVALID_QUERY" },
    );
  }

  const allExplicit = rows.every((row) =>
    pkKeys.every((key) => isUsableKeyValue(row[key]))
  );

  if (allExplicit) {
    const keys = rows.map((row) => pkKeys.map((key) => row[key]));
    return await inTransaction(db, async (tx) => {
      await tx.insert(table).values(values as InsertValues<TTable>).execute();
      return await fetchInKeyOrder(tx, table, pkKeys, keys);
    });
  }

  if (pkKeys.length > 1) {
    throw new OrmError(
      `insertReturning fallback on table "${table.name}" requires explicit values for the full composite primary key (${
        pkKeys.join(", ")
      }); a composite key cannot be recovered from LAST_INSERT_ID.`,
      { code: "ORM_INVALID_QUERY" },
    );
  }

  // Single-column key, some rows without it: insert row-by-row so each
  // statement's own LAST_INSERT_ID identifies its row — correct under any
  // innodb_autoinc_lock_mode, unlike batch first-id arithmetic.
  const pkKey = pkKeys[0];
  return await inTransaction(db, async (tx) => {
    const keys: unknown[][] = [];
    for (const row of rows) {
      const result = await tx.insert(table).values(
        row as InsertValues<TTable>,
      ).execute();
      if (isUsableKeyValue(row[pkKey])) {
        keys.push([row[pkKey]]);
        continue;
      }
      const insertId = (result as { insertId?: number | string | bigint })
        .insertId;
      if (
        insertId === undefined || insertId === 0 || insertId === "0" ||
        insertId === 0n
      ) {
        throw helperError(
          `insertReturning fallback on table "${table.name}" got no AUTO_INCREMENT id for "${pkKey}"; server-generated non-AUTO_INCREMENT keys are not reported — provide the key explicitly.`,
          "ORM_INVALID_QUERY",
        );
      }
      keys.push([insertId]);
    }
    return await fetchInKeyOrder(tx, table, pkKeys, keys);
  });
}

function isInsertReturningGuardError(error: unknown): boolean {
  return error instanceof OrmError &&
    error.code === "ORM_DIALECT_UNSUPPORTED" &&
    error.details?.construct === INSERT_RETURNING_CONSTRUCT;
}

// Primary-key columns as JS property keys: column-level `.primaryKey()`
// flags, or a table-level `primaryKey(...)` extra (which stores *physical*
// names — map them back through the column definitions).
function primaryKeyPropertyNames(table: AnyTableDefinition): string[] {
  const definition = table as TableDefinition;
  const columns = Object.values(definition.columns);
  const flagged = columns
    .filter((column) => column.primaryKey)
    .map((column) => column.propertyName);
  if (flagged.length > 0) {
    return flagged;
  }

  for (const constraint of definition.extras ?? []) {
    if (constraint.kind !== "primaryKey") {
      continue;
    }
    return constraint.columns.map((physical) => {
      const column = columns.find((candidate) => candidate.name === physical);
      return column === undefined ? physical : column.propertyName;
    });
  }

  return [];
}

// A key value the fallback can match on: present, not DB-generated, and not
// an opaque SQL expression (whose produced value is unknowable client-side).
function isUsableKeyValue(value: unknown): boolean {
  return value !== undefined && value !== null && !isSql(value);
}

// SELECT the given key tuples back and re-order them to input order. Key
// comparisons stringify both sides: the same id can surface as number 7
// (LAST_INSERT_ID header), string "7" (the mandated bigint-as-string decode
// of a BIGINT column), or bigint 7n depending on driver and column type.
async function fetchInKeyOrder<TTable extends AnyTableDefinition>(
  db: Database,
  table: TTable,
  pkKeys: readonly string[],
  keys: readonly (readonly unknown[])[],
): Promise<InferSelect<TTable>[]> {
  const columns = (table as TableDefinition).columns;
  const condition = pkKeys.length === 1
    ? inArray(columns[pkKeys[0]], keys.map((key) => key[0]))
    : or(
      ...keys.map((key) =>
        and(...pkKeys.map((pkKey, i) => eq(columns[pkKey], key[i])))
      ),
    );

  const fetched = await db.select().from(table).where(condition!).execute();
  const byKey = new Map<string, InferSelect<TTable>>();
  for (const row of fetched) {
    const record = row as Record<string, unknown>;
    byKey.set(
      keyFingerprint(pkKeys.map((key) => record[key])),
      row as InferSelect<TTable>,
    );
  }

  return keys.map((key) => {
    const row = byKey.get(keyFingerprint(key));
    if (row === undefined) {
      throw helperError(
        `insertReturning fallback on table "${
          (table as TableDefinition).name
        }" could not fetch an inserted row back by key (${
          pkKeys.join(", ")
        } = ${key.map(String).join(", ")}).`,
        "ORM_EXECUTE_FAILED",
      );
    }
    return row;
  });
}

function keyFingerprint(key: readonly unknown[]): string {
  return key.map((part) => String(part)).join(" ");
}
