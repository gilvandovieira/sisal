/**
 * The core capability registry (v0.8 item 1): the
 * `(engine, variant, version-range)` key space, the fail-closed
 * `capabilitySupported` predicate, and the registry/renderer agreement
 * invariant — a construct throws at render time exactly when its registry
 * declaration says the identity does not support it.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  CAPABILITY_TARGETS,
  capabilityGuard,
  capabilitySupported,
  DIALECT_CAPABILITIES,
  OrmError,
  renderSql,
  sql,
} from "./mod.ts";
import type { DialectIdentity, SisalCapabilityId } from "./mod.ts";

// Detected identities the integration suites run against; the bare
// CAPABILITY_TARGETS stay version-less (fail closed for version-gated rows).
const MARIADB_11: DialectIdentity = {
  dialect: "mysql",
  variant: "mariadb",
  version: "11.8.8",
};
const MARIADB_13: DialectIdentity = {
  dialect: "mysql",
  variant: "mariadb",
  version: "13.0.1",
};
const MYSQL_84: DialectIdentity = { dialect: "mysql", version: "8.4.10" };

Deno.test("capabilities: the six-target truth table", () => {
  // supported-target lists per capability, over the six bare targets. A
  // version-gated capability is NOT supported on a bare (version-less)
  // variant target — fail closed.
  const expected: Record<SisalCapabilityId, readonly string[]> = {
    insertReturning: ["pg", "neon", "sqlite", "libsql"],
    updateReturning: ["pg", "neon", "sqlite", "libsql"],
    deleteReturning: ["pg", "neon", "sqlite", "libsql"],
    updateFromReturning: ["pg", "neon", "sqlite", "libsql"],
    deleteUsingReturning: ["pg", "neon", "sqlite", "libsql"],
    deleteUsing: ["pg", "neon", "mysql", "mariadb"],
    distinctOn: ["pg", "neon"],
    fullJoin: ["pg", "neon", "sqlite", "libsql"],
    rowLocking: ["pg", "neon", "mysql", "mariadb"],
    arrayOperators: ["pg", "neon"],
    dataModifyingCte: ["pg", "neon"],
    mutationCte: ["pg", "neon", "sqlite", "libsql", "mysql"],
    // Version-gated on sqlite (3.28+) — fail closed on the bare target.
    windowGroupsFrame: ["pg", "neon"],
    // MariaDB's parser rejects lag/lead's third argument (live, 11.8.8).
    windowOffsetDefault: ["pg", "neon", "sqlite", "libsql", "mysql"],
    // Partial (WHERE) indexes: the MySQL family rejects them (DDL-level).
    partialIndex: ["pg", "neon", "sqlite", "libsql"],
    // Functional (expression) indexes: base MySQL ≥ 8.0.13 only; version-gated,
    // so the bare (version-less) mysql/mariadb targets fail closed.
    functionalIndex: ["pg", "neon", "sqlite", "libsql"],
  };
  for (const [id, capability] of Object.entries(DIALECT_CAPABILITIES)) {
    for (const [target, identity] of Object.entries(CAPABILITY_TARGETS)) {
      assertEquals(
        capabilitySupported(capability, identity),
        expected[id as SisalCapabilityId].includes(target),
        `${id} on ${target}`,
      );
    }
  }
});

Deno.test("capabilities: version refinements lift per detected identity", () => {
  const { insertReturning, updateReturning, deleteReturning } =
    DIALECT_CAPABILITIES;
  // MariaDB 11.8: INSERT/DELETE light, UPDATE stays below its 13.0 floor.
  assert(capabilitySupported(insertReturning, MARIADB_11));
  assert(capabilitySupported(deleteReturning, MARIADB_11));
  assert(!capabilitySupported(updateReturning, MARIADB_11));
  // MariaDB 13.0 lights UPDATE … RETURNING too.
  assert(capabilitySupported(updateReturning, MARIADB_13));
  // MySQL proper never lights RETURNING, at any version.
  assert(!capabilitySupported(insertReturning, MYSQL_84));
  // Fail closed: an unidentified MariaDB server stays guarded.
  assert(
    !capabilitySupported(insertReturning, CAPABILITY_TARGETS.mariadb),
  );
  // A bare dialect string is the base-engine identity.
  assert(!capabilitySupported(insertReturning, "mysql"));
  assert(capabilitySupported(insertReturning, "postgres"));
});

Deno.test("capabilities: registry and renderer cannot disagree", () => {
  const identities: ReadonlyArray<DialectIdentity> = [
    ...Object.values(CAPABILITY_TARGETS),
    MARIADB_11,
    MARIADB_13,
    MYSQL_84,
  ];
  for (const capability of Object.values(DIALECT_CAPABILITIES)) {
    for (const identity of identities) {
      const query = sql`select 1 ${capabilityGuard(capability)}`;
      const supported = capabilitySupported(capability, identity);
      if (supported) {
        assertEquals(renderSql(query, identity).text, "select 1 ");
      } else {
        const error = assertThrows(() => renderSql(query, identity), OrmError);
        assertEquals(error.code, "ORM_DIALECT_UNSUPPORTED");
        assert(
          error.message.includes(capability.construct),
          error.message,
        );
      }
    }
  }
});

Deno.test("capabilities: construct override names the concrete spelling", () => {
  const guard = capabilityGuard(
    DIALECT_CAPABILITIES.arrayOperators,
    'arrayContains ("@>")',
  );
  const error = assertThrows(
    () => renderSql(sql`${guard}`, { dialect: "sqlite" }),
    OrmError,
    'arrayContains ("@>")',
  );
  assertEquals(error.code, "ORM_DIALECT_UNSUPPORTED");
});
