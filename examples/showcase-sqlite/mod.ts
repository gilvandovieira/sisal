/**
 * SQLite-class feature showcase for Sisal — runs end-to-end, no server needed.
 *
 * SQLite is embedded, so this example actually **executes** every feature
 * against an in-memory database (`:memory:`) via `jsr:@db/sqlite`. It is the
 * SQLite-dialect twin of `examples/showcase-postgres` and exercises the whole
 * adapter surface: rich schema + generated DDL, inserts with `returning`, the
 * full operator/join/aggregate set, upserts, `$onUpdate`, transactions
 * (commit + rollback), relational loading via `db.query.<table>.findMany`, and
 * additive/destructive migration diffing.
 *
 * Run it:
 *
 *   deno run --allow-ffi --allow-read --allow-write --allow-env --allow-net \
 *     examples/showcase-sqlite/mod.ts
 *
 * (`@db/sqlite` loads a native library on first run, hence the read/write/net
 * permissions; subsequent runs only touch the cache.)
 *
 * The same code runs unchanged on libSQL/Turso — `@sisal/libsql` reuses the
 * SQLite dialect; only the `connect(...)` call differs.
 *
 * @module
 */

import {
  and,
  asc,
  avg,
  between,
  columns,
  count,
  createDatabase,
  createSchemaSnapshot,
  defineTable,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  max,
  min,
  notLike,
  or,
  relations,
  sql,
  sum,
} from "@sisal/orm";
import {
  createSqliteDb,
  createSqliteOrmDriver,
  openSqliteDatabase,
} from "@sisal/sqlite";
import { generateSqliteUpStatements } from "@sisal/sqlite/ddl";

// ---------------------------------------------------------------------------
// Schema — foreign keys, defaults, uniqueness, $onUpdate, JSON, arrays, blobs.
// Columns are nullable by default; `.notNull()` opts out and `.primaryKey()`
// implies not-null. A plain nullable column is still required on insert unless
// it is `.optional()` or has a `.default()`.
// ---------------------------------------------------------------------------
const orgs = defineTable("orgs", {
  id: columns.integer().primaryKey(),
  name: columns.text().notNull(),
  plan: columns.text().notNull().default("free"),
});

const users = defineTable("users", {
  id: columns.integer().primaryKey(),
  orgId: columns.integer().references("orgs", "id"),
  email: columns.text().notNull().unique(),
  name: columns.text(),
  age: columns.integer(),
  active: columns.boolean().notNull().default(true),
  score: columns.numeric(10, 2).optional(),
});

const posts = defineTable("posts", {
  id: columns.integer().primaryKey(),
  authorId: columns.integer().notNull().references("users", "id"),
  title: columns.text().notNull(),
  body: columns.text().optional(),
  views: columns.integer().notNull().default(0),
  // `$onUpdate` recomputes the value on every UPDATE (here: a unix timestamp).
  updatedAt: columns.integer().$onUpdate(() => Math.floor(Date.now() / 1000)),
});

const documents = defineTable("documents", {
  id: columns.integer().primaryKey(),
  ownerId: columns.integer().references("users", "id"),
  // JSON/arrays auto-serialize to TEXT on SQLite and come back as strings.
  data: columns.jsonb<{ kind: string; words: number }>(),
  tags: columns.text().array(),
  blob: columns.bytea().optional(),
});

// Relations power `db.query.<table>.findMany({ with: { … } })`.
const usersRelations = relations(users, ({ one, many }) => ({
  org: one(orgs, {
    fields: [users.columns.orgId],
    references: [orgs.columns.id],
  }),
  posts: many(posts, {
    fields: [users.columns.id],
    references: [posts.columns.authorId],
  }),
}));

const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, {
    fields: [posts.columns.authorId],
    references: [users.columns.id],
  }),
}));

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

async function main(): Promise<void> {
  // One shared in-memory handle, two facades over it: `db` for builders + raw
  // execution, `rel` (with schema + relations) for relational loading.
  const handle = await openSqliteDatabase({ path: ":memory:" });
  const db = await createSqliteDb({ database: handle });
  const rel = createDatabase({
    driver: createSqliteOrmDriver({ database: handle }),
    dialect: "sqlite",
    schema: { orgs, users, posts },
    relations: [usersRelations, postsRelations],
  });

  try {
    // ---- 1. Generated DDL ------------------------------------------------
    section("Generated DDL (CREATE TABLE)");
    const snapshot = createSchemaSnapshot({
      dialect: "sqlite",
      tables: [orgs, users, posts, documents],
    });
    const { statements, destructive } = generateSqliteUpStatements(snapshot);
    console.log(`destructive changes withheld: ${destructive.length}`);
    for (const statement of statements) {
      console.log(statement);
      await db.execute(statement);
    }

    // ---- 2. Inserts (single, multi-row, returning) -----------------------
    section("Inserts + RETURNING");
    await db.insert(orgs).values([
      { id: 1, name: "Acme", plan: "pro" },
      { id: 2, name: "Globex", plan: "free" },
    ]).execute();

    const ada = await db.insert(users).values({
      id: 1,
      orgId: 1,
      email: "ada@example.com",
      name: "Ada",
      age: 36,
      score: "98.50",
    }).returning().execute();
    console.log("inserted user:", ada.rows[0]);

    await db.insert(users).values([
      { id: 2, orgId: 1, email: "bob@example.com", name: "Bob", age: 17 },
      { id: 3, orgId: 2, email: "cara@example.com", name: "Cara", age: 41 },
      { id: 4, orgId: null, email: "dan@example.com", name: null, age: null },
    ]).execute();

    await db.insert(posts).values([
      { id: 1, authorId: 1, title: "Hello", body: "first", updatedAt: null },
      { id: 2, authorId: 1, title: "Notes", body: null, updatedAt: null },
      { id: 3, authorId: 3, title: "Draft", body: "wip", updatedAt: null },
    ]).execute();

    await db.insert(documents).values({
      id: 1,
      ownerId: 1,
      data: { kind: "memo", words: 120 },
      tags: ["draft", "internal"],
      blob: new Uint8Array([0, 1, 2, 250, 255]),
    }).execute();

    // ---- 3. Filtering operators ------------------------------------------
    section("Operators (where)");
    const adults = await db.select({ id: users.columns.id })
      .from(users)
      .where(and(gte(users.columns.age, 18), isNotNull(users.columns.age)))
      .execute();
    console.log("adults with a known age:", adults.map((r) => r.id));

    const ranged = await db.select({ email: users.columns.email })
      .from(users)
      .where(
        or(
          between(users.columns.age, 18, 40),
          inArray(users.columns.id, [4]),
        ),
      )
      .execute();
    console.log("aged 18–40 or id 4:", ranged.map((r) => r.email));

    const noAge = await db.select({ id: users.columns.id }).from(users)
      .where(isNull(users.columns.age)).execute();
    console.log("missing age:", noAge.map((r) => r.id));

    // SQLite has no ILIKE — Sisal renders it as a case-insensitive LIKE.
    const byPattern = await db.select({ email: users.columns.email }).from(
      users,
    )
      .where(ilike(users.columns.email, "A%")).execute();
    console.log("ilike 'A%' →", byPattern.map((r) => r.email));
    const notA = await db.select({ id: users.columns.id }).from(users)
      .where(notLike(users.columns.email, "a%")).execute();
    console.log("notLike 'a%' count:", notA.length);

    // ---- 4. Ordering, limit/offset, distinct -----------------------------
    section("Ordering + distinct");
    const ordered = await db.select({ id: users.columns.id })
      .from(users)
      .where(isNotNull(users.columns.age))
      .orderBy(desc(users.columns.age), asc(users.columns.email))
      .limit(2)
      .offset(0)
      .execute();
    console.log("oldest two:", ordered.map((r) => r.id));

    const plans = await db.select({ plan: orgs.columns.plan }).from(orgs)
      .distinct().execute();
    console.log("distinct plans:", plans.map((r) => r.plan));

    // ---- 5. Joins --------------------------------------------------------
    section("Joins");
    const inner = await db.select({
      user: users.columns.email,
      org: orgs.columns.name,
    }).from(users)
      .innerJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
      .execute();
    console.log("inner join rows:", inner.length);

    const left = await db.select({
      user: users.columns.email,
      org: orgs.columns.name,
    }).from(users)
      .leftJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
      .execute();
    console.log("left join rows (incl. orphan):", left.length);

    // ---- 6. Aggregates + groupBy + having --------------------------------
    section("Aggregates + groupBy + having");
    const perOrg = await db.select({
      orgId: users.columns.orgId,
      members: count(),
      avgAge: avg(users.columns.age),
      total: sum(users.columns.age),
      youngest: min(users.columns.age),
      oldest: max(users.columns.age),
    }).from(users)
      .where(isNotNull(users.columns.orgId))
      .groupBy(users.columns.orgId)
      .having(gt(count(), 1))
      .execute();
    console.log("orgs with >1 member:", perOrg);

    // ---- 7. Upserts ------------------------------------------------------
    section("Upserts (onConflict)");
    await db.insert(orgs).values({ id: 1, name: "ignored" })
      .onConflictDoNothing({ target: orgs.columns.id }).execute();
    await db.insert(orgs).values({ id: 1, name: "ignored" })
      .onConflictDoUpdate({ target: orgs.columns.id, set: { plan: "team" } })
      .execute();
    const acme = await db.select({ plan: orgs.columns.plan }).from(orgs)
      .where(eq(orgs.columns.id, 1)).execute();
    console.log("Acme plan after upserts:", acme[0]?.plan);

    // ---- 8. Update (with $onUpdate) + delete, both RETURNING -------------
    section("Update + delete, RETURNING");
    const renamed = await db.update(posts).set({ title: "Hello, world" })
      .where(eq(posts.columns.id, 1)).returning().execute();
    console.log(
      "updated post:",
      renamed.rows[0]?.title,
      "@",
      renamed.rows[0]?.updatedAt,
    );

    const removed = await db.delete(posts).where(eq(posts.columns.id, 3))
      .returning().execute();
    console.log("deleted post id:", removed.rows[0]?.id);

    // ---- 9. Transactions (commit + rollback) -----------------------------
    section("Transactions");
    await db.transaction(async (tx) => {
      await tx.insert(orgs).values({ id: 9, name: "Tx Co" }).execute();
    });
    console.log(
      "committed org 9:",
      (await db.select().from(orgs)
        .where(eq(orgs.columns.id, 9)).execute()).length === 1,
    );

    try {
      await db.transaction(async (tx) => {
        await tx.insert(orgs).values({ id: 10, name: "Rollback" }).execute();
        throw new Error("intentional failure");
      });
    } catch {
      // expected
    }
    console.log(
      "rolled back org 10:",
      (await db.select().from(orgs)
        .where(eq(orgs.columns.id, 10)).execute()).length === 0,
    );

    // ---- 10. Raw parameterized SQL ---------------------------------------
    section("Raw SQL");
    const counted = await db.query<{ n: number }>(
      sql`select count(*) as n from users where active = ${1}`,
    );
    console.log("active users:", Number(counted.rows[0].n));

    // ---- 11. Relational loading (with nested relations) ------------------
    section("Relational queries (db.query.<table>)");
    const withGraph = await rel.query.users.findMany({
      columns: { id: true, email: true },
      with: {
        org: true,
        posts: { columns: { id: true, title: true } },
      },
      where: isNotNull(users.columns.orgId),
      orderBy: asc(users.columns.id),
    });
    for (const user of withGraph) {
      console.log(
        `${user.email} @ ${
          user.org?.name ?? "—"
        } — ${user.posts.length} post(s)`,
      );
    }

    const first = await rel.query.users.findFirst({
      with: { posts: true },
      where: eq(users.columns.id, 1),
    });
    console.log("findFirst →", first?.email, "posts:", first?.posts.length);

    // ---- 12. CTEs + set operations ---------------------------------------
    section("CTEs + set operations");

    // Fluent CTE: `$with(name).as(query)` infers the CTE's columns from the
    // inner query's projection; reference them as `cte.<column>`.
    const adultsCte = db.$with("adults").as(
      db.select({ orgId: users.columns.orgId, age: users.columns.age })
        .from(users).where(gt(users.columns.age, 18)),
    );
    const perOrgAdults = await db.with(adultsCte)
      .select({ orgId: adultsCte.orgId, n: count() })
      .from(adultsCte)
      .groupBy(adultsCte.orgId)
      .execute();
    console.log("adults per org:", perOrgAdults);

    // Set operations: union / intersect / except (+ All variants). Operands are
    // unwrapped, so the same query is valid on Postgres and SQLite.
    const active = db.select({ id: users.columns.id }).from(users)
      .where(eq(users.columns.active, true));
    const adult = db.select({ id: users.columns.id }).from(users)
      .where(gt(users.columns.age, 18));
    console.log(
      "active ∪ adult:",
      (await active.union(adult).orderBy(asc(users.columns.id)).execute())
        .map((row) => row.id),
    );
    console.log(
      "active ∩ adult:",
      (await active.intersect(adult).execute()).map((row) => row.id),
    );

    // Recursive CTEs are written with the sql template (self-reference).
    const series = await db.query<{ x: number }>(sql`
      with recursive seq(x) as (
        select 1 union all select x + 1 from seq where x < ${5}
      )
      select x from seq
    `);
    console.log("recursive 1..5:", series.rows.map((row) => row.x));

    // ---- 13. Migration diffing (additive + destructive detection) --------
    // DDL generators emit only additive SQL (CREATE TABLE / ADD COLUMN);
    // destructive diffs (drop table/column) are detected and returned in a
    // separate `destructive` array, never emitted.
    section("Migration diffs");
    const v1 = createSchemaSnapshot({
      dialect: "sqlite",
      tables: [
        defineTable("widgets", {
          id: columns.integer().primaryKey(),
          name: columns.text().notNull(),
        }),
      ],
    });
    const v2 = createSchemaSnapshot({
      dialect: "sqlite",
      tables: [
        defineTable("widgets", {
          id: columns.integer().primaryKey(),
          name: columns.text().notNull(),
          color: columns.text(), // new nullable column → additive ALTER
        }),
        defineTable("audits", { // new table → additive CREATE
          id: columns.integer().primaryKey(),
          at: columns.integer().notNull(),
        }),
      ],
    });
    const additive = generateSqliteUpStatements(v2, v1);
    console.log("additive statements:");
    for (const statement of additive.statements) console.log("  " + statement);

    const v3 = createSchemaSnapshot({
      dialect: "sqlite",
      tables: [
        // dropped `name`/`color` and the whole `audits` table
        defineTable("widgets", { id: columns.integer().primaryKey() }),
      ],
    });
    const shrink = generateSqliteUpStatements(v3, v2);
    console.log(
      `destructive changes withheld: ${
        shrink.destructive.map((change) => `${change.kind} ${change.table}`)
          .join(", ")
      }`,
    );

    console.log("\n✓ SQLite showcase complete.");
  } finally {
    handle.close();
  }
}

if (import.meta.main) {
  await main();
}
