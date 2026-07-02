/**
 * The `(engine, variant, version)` dialect identity (v0.7 B1) — the axis the
 * v0.6 readiness investigation decided on (`docs/mysql-readiness.md`,
 * decision 2). Pins the version comparator, the variant-aware guard
 * semantics (declarative targets + `unless` refinements, fail-closed on
 * unknown versions), the dormant MariaDB `RETURNING` refinements
 * (per-statement version floors from the C3/C5 probes), the database-facade
 * plumbing, and the snapshot's variant axis. The guard *signature* is the
 * piece that cannot migrate after the v0.8 IR freeze — these tests are its
 * contract.
 *
 * @module
 */
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  capabilitySupported,
  columns,
  compareServerVersions,
  createDatabase,
  createSchemaSnapshot,
  defineTable,
  dialectGuard,
  eq,
  OrmError,
  renderSql,
  sql,
} from "./mod.ts";
import type { OrmDriver } from "./mod.ts";

const posts = defineTable("posts", {
  id: columns.integer().primaryKey(),
  title: columns.text().notNull(),
});

Deno.test("identity: compareServerVersions orders dotted numeric prefixes", () => {
  assertEquals(compareServerVersions("8.4.10", "8.4.10"), 0);
  assertEquals(Math.sign(compareServerVersions("10.4", "10.5")), -1);
  assertEquals(Math.sign(compareServerVersions("10.5.1", "10.5")), 1);
  // Missing segments are zero.
  assertEquals(compareServerVersions("8.4", "8.4.0"), 0);
  // Real server strings: the suffix is ignored.
  assertEquals(
    Math.sign(compareServerVersions("11.8.8-MariaDB-ubu2404", "10.5")),
    1,
  );
  assertEquals(
    Math.sign(compareServerVersions("10.0.4-MariaDB", "10.0.5")),
    -1,
  );
  // Non-numeric versions compare as 0.0.0.
  assertEquals(Math.sign(compareServerVersions("unknown", "0.1")), -1);
});

Deno.test("identity: a variant-narrowed guard target hits only that variant", () => {
  const guarded = sql`${
    dialectGuard("mariadb-only quirk", [{
      dialect: "mysql",
      variant: "mariadb",
    }])
  }select 1`;
  // Base mysql (no variant) does not match a variant-narrowed target.
  assertEquals(
    renderSql(guarded, { dialect: "mysql" }).text,
    "select 1",
  );
  // The named variant does.
  const error = assertThrows(
    () =>
      renderSql(guarded, {
        dialect: "mysql",
        variant: "mariadb",
        version: "11.8.8-MariaDB-ubu2404",
      }),
    OrmError,
    "mariadb-only quirk",
  );
  assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
  // Other dialects are untouched.
  assertEquals(renderSql(guarded, { dialect: "postgres" }).text, "select 1");
});

Deno.test("identity: `unless` lifts a guard only for a known, sufficient version", () => {
  const q = () =>
    sql`${
      dialectGuard("capability", ["mysql"], {
        unless: [{ variant: "mariadb", minVersion: "10.5" }],
      })
    }select 1`;
  // Base mysql: guarded (unchanged behavior).
  assertThrows(() => renderSql(q(), { dialect: "mysql" }), OrmError);
  // MariaDB without a version: fail closed — still guarded.
  assertThrows(
    () => renderSql(q(), { dialect: "mysql", variant: "mariadb" }),
    OrmError,
  );
  // MariaDB below the floor: guarded.
  assertThrows(
    () =>
      renderSql(q(), {
        dialect: "mysql",
        variant: "mariadb",
        version: "10.4.9",
      }),
    OrmError,
  );
  // MariaDB at/above the floor: lifted.
  assertEquals(
    renderSql(q(), { dialect: "mysql", variant: "mariadb", version: "10.5" })
      .text,
    "select 1",
  );
  assertEquals(
    renderSql(q(), {
      dialect: "mysql",
      variant: "mariadb",
      version: "11.8.8-MariaDB-ubu2404",
    }).text,
    "select 1",
  );
});

Deno.test("identity: a `baseEngine` version gate lifts base MySQL only, never the MariaDB variant", () => {
  // "functional indexes on base MySQL ≥ 8.0.13, but never MariaDB" — the pattern
  // T8 needs. A variant-less `unless` (the old form) would wrongly lift MariaDB
  // 11.x (numerically ≥ 8.0.13); `baseEngine: true` excludes the variant.
  const q = () =>
    sql`${
      dialectGuard("functional index", ["mysql"], {
        unless: [{ baseEngine: true, minVersion: "8.0.13" }],
      })
    }select 1`;

  // Base MySQL ≥ 8.0.13 lifts; below the floor and unknown-version fail closed.
  assertEquals(
    renderSql(q(), { dialect: "mysql", version: "8.0.16" }).text,
    "select 1",
  );
  assertThrows(
    () => renderSql(q(), { dialect: "mysql", version: "8.0.10" }),
    OrmError,
  );
  assertThrows(() => renderSql(q(), { dialect: "mysql" }), OrmError);
  // MariaDB never lifts — even at a version numerically ≥ 8.0.13.
  assertThrows(
    () =>
      renderSql(q(), {
        dialect: "mysql",
        variant: "mariadb",
        version: "11.8.8-MariaDB-ubu2404",
      }),
    OrmError,
  );

  // `capabilitySupported` — the non-rendering form the DDL generator uses — agrees.
  const cap = {
    id: "functional-index",
    construct: "functional (expression) index",
    unsupported: ["mysql"],
    unless: [{ baseEngine: true, minVersion: "8.0.13" }],
  } as const;
  assertEquals(
    capabilitySupported(cap, { dialect: "mysql", version: "8.0.16" }),
    true,
  );
  assertEquals(capabilitySupported(cap, { dialect: "mysql" }), false);
  assertEquals(
    capabilitySupported(cap, {
      dialect: "mysql",
      variant: "mariadb",
      version: "11.8.8-MariaDB-ubu2404",
    }),
    false,
  );
});

Deno.test("identity: RETURNING lights up per statement kind on MariaDB", () => {
  const db = createDatabase({ dialect: "postgres" });
  const inserted = db.insert(posts).values({ id: 1, title: "a" }).returning()
    .toSql();
  const updated = db.update(posts).set({ title: "b" })
    .where(eq(posts.columns.id, 1)).returning().toSql();
  const deleted = db.delete(posts).where(eq(posts.columns.id, 1)).returning()
    .toSql();
  const mariadb118 = {
    dialect: "mysql" as const,
    variant: "mariadb",
    version: "11.8.8-MariaDB-ubu2404",
  };

  // Plain mysql: all three still guarded (the C3 behavior, unchanged).
  for (const q of [inserted, updated, deleted]) {
    assertThrows(() => renderSql(q, { dialect: "mysql" }), OrmError);
  }

  // MariaDB 11.8: INSERT (10.5+) and DELETE (10.0.5+) render; UPDATE (13.0+)
  // stays guarded — the per-statement floors from the C3/C5 probes.
  assertStringIncludes(renderSql(inserted, mariadb118).text, "returning");
  assertStringIncludes(renderSql(deleted, mariadb118).text, "returning");
  const error = assertThrows(
    () => renderSql(updated, mariadb118),
    OrmError,
    "UPDATE … RETURNING",
  );
  assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
  assertStringIncludes((error as Error).message, "mariadb");

  // MariaDB 13 lifts UPDATE … RETURNING too.
  assertStringIncludes(
    renderSql(updated, { ...mariadb118, version: "13.0.1-MariaDB" }).text,
    "returning",
  );
});

Deno.test("identity: the database facade carries and applies the identity", async () => {
  const seen: string[] = [];
  const record = (query: { text: string }) => {
    seen.push(query.text);
    return Promise.resolve({ rows: [] });
  };
  const driver: OrmDriver = {
    query: (q) => record(q),
    execute: (q) => record(q),
    transaction: (fn) =>
      fn({ query: (q) => record(q), execute: (q) => record(q) }),
  };

  const mariadb = createDatabase({
    driver,
    dialect: "mysql",
    variant: "mariadb",
    version: "11.8.8-MariaDB-ubu2404",
  });
  assertEquals(mariadb.dialectIdentity, {
    dialect: "mysql",
    variant: "mariadb",
    version: "11.8.8-MariaDB-ubu2404",
  });

  // The identity flows through execution: INSERT … RETURNING renders.
  await mariadb.insert(posts).values({ id: 1, title: "a" }).returning()
    .execute();
  assertStringIncludes(seen.at(-1) ?? "", "returning");

  // …and through transaction facades.
  await mariadb.transaction(async (tx) => {
    assertEquals(tx.dialectIdentity.variant, "mariadb");
    await tx.insert(posts).values({ id: 2, title: "b" }).returning().execute();
  });
  assertStringIncludes(seen.at(-1) ?? "", "returning");

  // A base-mysql facade still rejects it, through the same paths.
  const mysql = createDatabase({ driver, dialect: "mysql" });
  assertEquals(mysql.dialectIdentity, { dialect: "mysql" });
  try {
    await mysql.insert(posts).values({ id: 3, title: "c" }).returning()
      .execute();
    throw new Error("expected the RETURNING guard to throw");
  } catch (error) {
    assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
  }
});

Deno.test("identity: the snapshot carries the variant/version axis", () => {
  const withAxis = createSchemaSnapshot({
    dialect: "mysql",
    dialectVariant: "mariadb",
    dialectVersion: "10.11",
    tables: [posts],
  });
  assertEquals(withAxis.dialect, "mysql");
  assertEquals(withAxis.dialectVariant, "mariadb");
  assertEquals(withAxis.dialectVersion, "10.11");

  // Optional and additive: absent stays absent (older snapshots unchanged).
  const without = createSchemaSnapshot({ dialect: "mysql", tables: [posts] });
  assertEquals("dialectVariant" in without, false);
  assertEquals("dialectVersion" in without, false);
});
