/**
 * Declarative dialect capabilities — the `(engine, variant, version-range)`
 * key space pinned by v0.8 item 1 (the sequencing audit's Fix 1).
 *
 * Each {@link DialectCapability} names one dialect-divergent construct and
 * declares, as serializable data, exactly which identities it is unsupported
 * on and which variant/version refinements lift that. The declaration is the
 * same shape the render-time `guard` chunk carries, so the registry and the
 * renderer cannot disagree: {@link capabilityGuard} derives the render guard
 * from the declaration verbatim, and {@link capabilitySupported} answers the
 * same question without rendering (fail closed — an unknown server version
 * never lights a version-gated capability).
 *
 * {@link CAPABILITY_TARGETS} names the six capability targets the feature
 * matrix and integration suites key on (`pg`, `neon`, `sqlite`, `libsql`,
 * `mysql`, `mariadb`) as `(engine, variant)` identities — neon, libsql, and
 * mariadb are variants of their base engines. Version-gated capabilities
 * additionally need the identity's detected `version` (adapters fill it at
 * `connect()`).
 *
 * @module
 */
import { dialectGuard, dialectGuardApplies } from "./sql.ts";
import type {
  DialectGuardException,
  DialectGuardTarget,
  DialectIdentity,
  Sql,
  SqlDialect,
} from "./sql.ts";

/**
 * One named dialect capability: a construct label (used verbatim in the
 * typed `ORM_DIALECT_UNSUPPORTED` error) plus the declarative
 * unsupported-targets/exceptions data evaluated by both the renderer and
 * {@link capabilitySupported}.
 */
export interface DialectCapability {
  /** Stable registry id (kebab-case). */
  readonly id: string;
  /** Human construct name rendered into guard errors. */
  readonly construct: string;
  /** Identities the construct is unsupported on (engine or engine+variant). */
  readonly unsupported: readonly DialectGuardTarget[];
  /** Variant/version refinements that lift the guard (fail closed). */
  readonly unless?: readonly DialectGuardException[];
}

/**
 * The core capability registry: every render-guarded construct's
 * `(engine, variant, version-range)` truth in one place. The builder/operator
 * guard call sites derive their render guards from these entries via
 * {@link capabilityGuard}, so this table, the typed render errors, and the
 * {@link capabilitySupported} predicate stay one source of truth.
 */
export const DIALECT_CAPABILITIES = {
  /** `INSERT … RETURNING` — MariaDB ≥ 10.5 lights it; MySQL proper has none. */
  insertReturning: {
    id: "insert-returning",
    construct: "INSERT … RETURNING",
    unsupported: ["mysql"],
    unless: [{ variant: "mariadb", minVersion: "10.5" }],
  },
  /** `UPDATE … RETURNING` — MariaDB's floor is 13.0. */
  updateReturning: {
    id: "update-returning",
    construct: "UPDATE … RETURNING",
    unsupported: ["mysql"],
    unless: [{ variant: "mariadb", minVersion: "13.0" }],
  },
  /** `DELETE … RETURNING` — MariaDB ≥ 10.0.5 lights it. */
  deleteReturning: {
    id: "delete-returning",
    construct: "DELETE … RETURNING",
    unsupported: ["mysql"],
    unless: [{ variant: "mariadb", minVersion: "10.0.5" }],
  },
  /** Multi-table `UPDATE … FROM` plus `RETURNING` — single-table only on the MySQL family. */
  updateFromReturning: {
    id: "update-from-returning",
    construct: "UPDATE … FROM … RETURNING",
    unsupported: ["mysql"],
  },
  /** Multi-table `DELETE … USING` plus `RETURNING` — single-table only on the MySQL family. */
  deleteUsingReturning: {
    id: "delete-using-returning",
    construct: "DELETE … USING … RETURNING",
    unsupported: ["mysql"],
  },
  /** `DELETE … USING` — the SQLite family has no multi-table DELETE. */
  deleteUsing: {
    id: "delete-using",
    construct: "DELETE … USING",
    unsupported: ["sqlite"],
  },
  /** PostgreSQL `DISTINCT ON (…)`. */
  distinctOn: {
    id: "distinct-on",
    construct: "distinctOn",
    unsupported: ["sqlite", "mysql"],
  },
  /** `FULL JOIN` — the MySQL family has none (SQLite ≥ 3.39 renders it). */
  fullJoin: {
    id: "full-join",
    construct: "FULL JOIN",
    unsupported: ["mysql"],
  },
  /** `FOR UPDATE` / `FOR SHARE` row locking — no-op-free on the SQLite family. */
  rowLocking: {
    id: "row-locking",
    construct: '.for("update"/"share") row locking',
    unsupported: ["sqlite"],
  },
  /** Postgres array operators (`@>`, `<@`, `&&`) — no array type elsewhere. */
  arrayOperators: {
    id: "array-operators",
    construct: "postgres array operators",
    unsupported: ["sqlite", "mysql"],
  },
  /** A data-modifying CTE body — PostgreSQL-only; other families' CTEs are SELECT-only. */
  dataModifyingCte: {
    id: "data-modifying-cte",
    construct: "a data-modifying CTE (INSERT/UPDATE/DELETE in WITH)",
    unsupported: ["sqlite", "mysql"],
  },
  /** A `WITH` prefix on a mutation — MariaDB parses `WITH` on SELECT only. */
  mutationCte: {
    id: "mutation-cte",
    construct: "WITH … <mutation>",
    unsupported: [{ dialect: "mysql", variant: "mariadb" }],
  },
  /**
   * `GROUPS` window frames — PostgreSQL-first: the MySQL family has no
   * `GROUPS` unit at all, and SQLite added it in 3.28 (version-gated, fail
   * closed — a detected SQLite ≥ 3.28 identity lights it). `ROWS`/`RANGE`
   * frames are unguarded at Sisal's version floors.
   */
  windowGroupsFrame: {
    id: "window-groups-frame",
    construct: "GROUPS window frames",
    unsupported: ["mysql", "sqlite"],
    unless: [{ dialect: "sqlite", minVersion: "3.28" }],
  },
  /**
   * The third (`default`) argument of `lag()`/`lead()` — MariaDB's parser
   * rejects it (verified live on 11.8.8; MySQL 8.4 accepts it). Portable
   * spelling: `coalesce(over(lag(x), …), default)`.
   */
  windowOffsetDefault: {
    id: "window-offset-default",
    construct: "lag()/lead() default argument",
    unsupported: [{ dialect: "mysql", variant: "mariadb" }],
  },
  /**
   * Partial (`WHERE`) indexes — the MySQL family (both MySQL and MariaDB)
   * rejects them; PostgreSQL and the SQLite family support them. A
   * generation-time DDL divergence rather than a render guard: the
   * `@sisal/mysql` DDL generator reads this via {@link capabilitySupported}
   * and fails closed at generation time (no `capabilityGuard` render chunk).
   */
  partialIndex: {
    id: "partial-index",
    construct: "partial (WHERE) index",
    unsupported: ["mysql"],
  },
  /**
   * Functional (expression) indexes — supported on **base MySQL ≥ 8.0.13**,
   * never on MariaDB (its route is a generated column). Uses a base-engine
   * version gate so the MariaDB variant (11.x is numerically ≥ 8.0.13) never
   * clears the floor. A generation-time DDL divergence: the `@sisal/mysql` DDL
   * generator reads it via {@link capabilitySupported} with the snapshot's
   * detected identity and emits the functional key part only when it lifts.
   */
  functionalIndex: {
    id: "functional-index",
    construct: "functional (expression) index",
    unsupported: ["mysql"],
    unless: [{ baseEngine: true, minVersion: "8.0.13" }],
  },
} as const satisfies Record<string, DialectCapability>;

/** A key of the core capability registry. */
export type SisalCapabilityId = keyof typeof DIALECT_CAPABILITIES;

/**
 * The six capability targets the feature matrix and integration suites key
 * on, expressed in the `(engine, variant)` identity space. Version-gated
 * capabilities (`unless` with `minVersion`) additionally require a known
 * `version` on the identity — pass the adapter-detected identity, not these
 * bare targets, when the server version matters.
 */
export const CAPABILITY_TARGETS = {
  pg: { dialect: "postgres" },
  neon: { dialect: "postgres", variant: "neon" },
  sqlite: { dialect: "sqlite" },
  libsql: { dialect: "sqlite", variant: "libsql" },
  mysql: { dialect: "mysql" },
  mariadb: { dialect: "mysql", variant: "mariadb" },
} as const satisfies Record<string, DialectIdentity>;

/** A key of {@link CAPABILITY_TARGETS}. */
export type CapabilityTargetId = keyof typeof CAPABILITY_TARGETS;

/**
 * True when `identity` supports `capability` — the non-rendering form of the
 * render-time guard, with identical fail-closed semantics: a bare engine
 * identity matches engine-wide targets, a variant identity also matches its
 * variant-narrowed targets, and `minVersion` refinements lift only when the
 * identity's `version` is known and at least the floor.
 */
export function capabilitySupported(
  capability: DialectCapability,
  identity: SqlDialect | DialectIdentity,
): boolean {
  return !dialectGuardApplies(capability, identity);
}

/**
 * The render-time guard for a registry capability: a zero-width marker that
 * makes rendering throw the typed `ORM_DIALECT_UNSUPPORTED` error on
 * identities the capability declaration excludes. `construct` overrides the
 * error's construct label where one capability covers several spellings
 * (e.g. each array operator names itself).
 */
export function capabilityGuard(
  capability: DialectCapability,
  construct: string = capability.construct,
): Sql {
  return dialectGuard(
    construct,
    capability.unsupported,
    capability.unless === undefined ? {} : { unless: capability.unless },
  );
}
