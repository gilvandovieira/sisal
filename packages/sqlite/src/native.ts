/**
 * Runtime-native SQLite driver selection for `@sisal/sqlite`.
 *
 * The adapter's default driver differs by runtime: Deno uses the FFI-backed
 * `jsr:@db/sqlite`, while Node uses the built-in `node:sqlite`
 * (`DatabaseSync`, stable on Node 24+). Both satisfy the same structural
 * database surface the executor drives, so the choice is invisible above this
 * module. Injected databases always bypass it.
 *
 * Selection keys on **Deno FFI availability** ({@link hasDenoFfi}) rather than
 * a bare `globalThis.Deno` check on purpose: `@db/sqlite` requires
 * `Deno.dlopen`, and the dnt Deno test-shim used to run the suite under Node
 * defines a partial `Deno` global **without** FFI — so an FFI probe is the
 * signal that actually predicts whether `@db/sqlite` can load.
 *
 * > Phase-2 verification (npm-distribution-plan NPM-6): this module compiles
 * > under Deno today; its Node behavior — `node:sqlite` `readOnly` semantics on
 * > `:memory:`, `run()` change-count shape, and `INTEGER`→`number` vs the Deno
 * > path's `int64: true` `BigInt` reads — is confirmed once the dnt build runs
 * > the suite under real Node.
 *
 * @module
 */

/**
 * True when the current runtime exposes Deno FFI (`Deno.dlopen`) — the
 * capability the `jsr:@db/sqlite` driver needs. False on Node (including under
 * the dnt Deno test-shim, which provides no FFI), signalling that the adapter
 * should fall back to the built-in `node:sqlite` driver.
 */
export function hasDenoFfi(): boolean {
  const deno = (globalThis as { Deno?: { dlopen?: unknown } }).Deno;
  return typeof deno?.dlopen === "function";
}

/** A `node:sqlite` `StatementSync`, narrowed to the surface used here. */
interface NodeStatementSync {
  all(...params: readonly unknown[]): Record<string, unknown>[];
  run(...params: readonly unknown[]): { readonly changes: number | bigint };
}

/** A `node:sqlite` `DatabaseSync`, narrowed to the surface used here. */
interface NodeDatabaseSync {
  prepare(sql: string): NodeStatementSync;
  close(): void;
}

/** Constructor shape of `node:sqlite`'s `DatabaseSync`. */
type NodeDatabaseSyncCtor = new (
  path: string,
  options?: { readonly readOnly?: boolean },
) => NodeDatabaseSync;

/**
 * The structural database surface the SQLite executor drives — the shared
 * shape both `@db/sqlite` and the `node:sqlite` wrapper satisfy. Callers cast
 * this to their local `SqliteLikeDatabase` (structurally identical).
 */
export interface NativeSqliteDatabase {
  /** Prepares SQL, exposing `all` (rows) and `run` (change count). */
  prepare(sql: string): {
    all(...params: readonly unknown[]): Record<string, unknown>[];
    run(...params: readonly unknown[]): number;
  };
  /** Closes the underlying database. */
  close(): void;
}

/**
 * Opens a SQLite database with the built-in `node:sqlite` driver (Node 24+),
 * imported lazily, and adapts it to {@link NativeSqliteDatabase}: `run()` is
 * normalized to a numeric change count so it matches the `@db/sqlite` path the
 * executor expects.
 */
export async function openNodeSqlite(
  path: string,
  readonly: boolean,
): Promise<NativeSqliteDatabase> {
  const mod = await import("node:sqlite") as unknown as {
    DatabaseSync: NodeDatabaseSyncCtor;
  };

  const db = new mod.DatabaseSync(path, { readOnly: readonly });

  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        all: (...params: readonly unknown[]) =>
          statement.all(...coerceParams(params)),
        run: (...params: readonly unknown[]) =>
          Number(statement.run(...coerceParams(params)).changes),
      };
    },
    close: () => db.close(),
  };
}

/**
 * Coerces bind parameters to the value kinds `node:sqlite` accepts (null,
 * number, bigint, string, Uint8Array). The Deno `@db/sqlite` driver silently
 * maps a few extra kinds; `node:sqlite` throws on them, so match its stricter
 * contract here: booleans → `0`/`1` (SQLite's boolean round-trip) and
 * `undefined` → `null`. Other kinds are already serialized upstream by the
 * executor (JSON/arrays → TEXT, temporal → strings).
 */
function coerceParams(params: readonly unknown[]): unknown[] {
  return params.map((param) => {
    if (typeof param === "boolean") {
      return param ? 1 : 0;
    }
    if (param === undefined) {
      return null;
    }
    return param;
  });
}
