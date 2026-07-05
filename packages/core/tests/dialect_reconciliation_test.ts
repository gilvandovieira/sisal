/**
 * GI-1 reconciliation (v0.9 T4): the render dialect (`SqlDialect`), the
 * snapshot dialect (`SisalDialectName`), the runtime render list
 * (`SQL_DIALECTS`), and the six capability targets (`CAPABILITY_TARGETS`) are
 * all projections of the one `(engine, variant, version)` descriptor. These
 * tests keep them from drifting: the type-level `Equal` asserts stop compiling
 * if the 4-way unions diverge, and the runtime checks pin the 6-way ↔ 4-way
 * collapse and reject capability declarations that name an unknown
 * dialect/variant. `docs:matrix:check` covers the last projection (matrix
 * `ADAPTERS` ≡ `CAPABILITY_TARGETS`).
 *
 * @module
 */
import { assert, assertEquals } from "@std/assert";
import {
  CAPABILITY_TARGETS,
  DIALECT_CAPABILITIES,
  type DialectCapability,
  type DialectIdentity,
  type SisalDialectName,
  SQL_DIALECTS,
  type SqlDialect,
} from "../mod.ts";

const CAPABILITIES: readonly DialectCapability[] = Object.values(
  DIALECT_CAPABILITIES,
);
const TARGET_IDENTITIES: readonly DialectIdentity[] = Object.values(
  CAPABILITY_TARGETS,
);

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// The 6 capability targets collapse onto the render dialects: neon→pg,
// libsql→sqlite, mariadb→mysql. This is the 6-way ↔ 4-way projection.
const RENDER_COLLAPSE: Record<string, string[]> = {
  postgres: ["pg", "neon"],
  sqlite: ["sqlite", "libsql"],
  mysql: ["mysql", "mariadb"],
};

Deno.test("reconciliation: render / snapshot / runtime dialect unions are identical", () => {
  // Compile-time: these fail the type-check (before running) if `SqlDialect`,
  // `SisalDialectName`, or `SQL_DIALECTS` gains or loses a value.
  const listMatchesUnion: Expect<
    Equal<SqlDialect, (typeof SQL_DIALECTS)[number]>
  > = true;
  const renderMatchesSnapshot: Expect<Equal<SqlDialect, SisalDialectName>> =
    true;
  assertEquals([listMatchesUnion, renderMatchesSnapshot], [true, true]);
});

Deno.test("reconciliation: every capability target collapses to a render dialect", () => {
  const renderDialects = new Set<string>(SQL_DIALECTS);
  const collapse: Record<string, string[]> = {};
  for (const [target, identity] of Object.entries(CAPABILITY_TARGETS)) {
    assert(
      renderDialects.has(identity.dialect),
      `target ${target} renders as unknown dialect "${identity.dialect}"`,
    );
    (collapse[identity.dialect] ??= []).push(target);
  }
  assertEquals(collapse, RENDER_COLLAPSE);
});

Deno.test("reconciliation: every non-generic render dialect has a capability target", () => {
  for (const dialect of SQL_DIALECTS) {
    if (dialect === "generic") continue; // renders nothing engine-specific
    assert(
      dialect in RENDER_COLLAPSE,
      `render dialect "${dialect}" has no capability target`,
    );
  }
});

Deno.test("reconciliation: capability declarations reference only known dialects/variants", () => {
  const dialects = new Set<string>(SQL_DIALECTS);
  const variants = new Set(
    TARGET_IDENTITIES
      .map((identity) => identity.variant)
      .filter((variant): variant is string => variant !== undefined),
  );

  for (const capability of CAPABILITIES) {
    for (const target of capability.unsupported) {
      const dialect = typeof target === "string" ? target : target.dialect;
      assert(
        dialects.has(dialect),
        `${capability.id}: unsupported dialect "${dialect}" is not a SqlDialect`,
      );
      if (typeof target !== "string" && target.variant !== undefined) {
        assert(
          variants.has(target.variant),
          `${capability.id}: unsupported variant "${target.variant}" is unknown`,
        );
      }
    }
    for (const exception of capability.unless ?? []) {
      if (exception.dialect !== undefined) {
        assert(
          dialects.has(exception.dialect),
          `${capability.id}: unless dialect "${exception.dialect}" is not a SqlDialect`,
        );
      }
      if (exception.variant !== undefined) {
        assert(
          variants.has(exception.variant),
          `${capability.id}: unless variant "${exception.variant}" is unknown`,
        );
      }
    }
  }
});
