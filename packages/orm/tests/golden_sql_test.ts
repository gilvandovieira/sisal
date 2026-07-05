/**
 * Golden per-dialect SQL baselines — v0.8 wave 0 (roadmap item 12, first
 * half).
 *
 * Every existing IR construct is rendered against every render target
 * (postgres, sqlite, mysql, generic, and the detected-MariaDB identity) and
 * pinned as a snapshot: the exact SQL text, the bound parameters in order,
 * and — where a dialect guard fires — the typed error instead. Prepared
 * plans pin the per-dialect placeholder styles the same way.
 *
 * These baselines are the net under the v0.8 wave-1 `dialectGuard`
 * generalization and the wave-2 `@sisal/core` extraction: both must leave
 * every snapshot byte-identical. Goldens for *new* v0.8 constructs are added
 * next to their construct in wave 3, not here.
 *
 * Update intentionally with:
 *
 * ```sh
 * deno test --allow-read --allow-write packages/orm/golden_sql_test.ts -- --update
 * ```
 */
import {
  and,
  arrayContained,
  arrayContains,
  arrayExpr,
  arrayOverlaps,
  asc,
  assembleInsertFromSelect,
  avg,
  between,
  coalesce,
  columns,
  count,
  countDistinct,
  createDatabase,
  dateAdd,
  dateBin,
  dateDiff,
  dateSub,
  dateTrunc,
  defineFunction,
  defineTable,
  desc,
  eq,
  excluded,
  exists,
  filter,
  greatest,
  gt,
  gte,
  identifier,
  ilike,
  inArray,
  isNotNull,
  isNull,
  jsonExtract,
  jsonTable,
  lag,
  lead,
  least,
  like,
  lt,
  lte,
  max,
  min,
  ne,
  not,
  notBetween,
  notExists,
  notIlike,
  notInArray,
  notLike,
  now,
  or,
  OrmError,
  over,
  placeholder,
  rank,
  raw,
  renderSql,
  rowNumber,
  sql,
  sum,
} from "../mod.ts";
import type { Database, DialectIdentity, Sql, SqlDialect } from "../mod.ts";

// `@std/testing/snapshot` is a Deno-test-runner feature: it resolves
// `__snapshots__` relative to the *source* file and honors `--update`. dnt does
// not bundle it for the Node build, so these two golden checks run under Deno
// and are skipped under Node (where the same renders are already pinned by the
// non-snapshot golden tests). The specifier is computed so dnt leaves it as an
// opaque runtime import instead of trying to resolve it. Detection keys on
// `Deno.dlopen` (FFI): dnt's Node test shim fakes `Deno.version` but not FFI, so
// this distinguishes real Deno from Node-under-shim.
const isRealDeno =
  typeof (globalThis as { Deno?: { dlopen?: unknown } }).Deno?.dlopen ===
    "function";

async function loadAssertSnapshot(): Promise<
  typeof import("@std/testing/snapshot").assertSnapshot
> {
  const specifier = ["@std", "testing/snapshot"].join("/");
  const mod = await import(specifier);
  return mod.assertSnapshot;
}

// ---- render targets ---------------------------------------------------------
// The four render dialects plus one detected identity: MariaDB lights
// INSERT/DELETE RETURNING and trips the WITH-on-mutation guard, so it is the
// one identity whose output diverges from bare "mysql" today.

const TARGETS: Record<string, SqlDialect | DialectIdentity> = {
  postgres: "postgres",
  sqlite: "sqlite",
  mysql: "mysql",
  generic: "generic",
  "mysql (mariadb 11.8.8)": {
    dialect: "mysql",
    variant: "mariadb",
    version: "11.8.8",
  },
};

type RenderedTarget =
  | { readonly text: string; readonly params: readonly unknown[] }
  | { readonly throws: string };

function renderAll(query: Sql): Record<string, RenderedTarget> {
  const rendered: Record<string, RenderedTarget> = {};
  for (const [label, target] of Object.entries(TARGETS)) {
    try {
      const { text, params } = renderSql(
        query,
        typeof target === "string" ? { dialect: target } : target,
      );
      rendered[label] = { text, params };
    } catch (error) {
      if (error instanceof OrmError) {
        rendered[label] = { throws: `${error.code}: ${error.message}` };
      } else {
        throw error;
      }
    }
  }
  return rendered;
}

// ---- fixtures ---------------------------------------------------------------
// snake_case naming is the default; camelCase keys pin the key <-> physical
// mapping (`hotScore` -> `hot_score`) through every construct.

const db = createDatabase({ dialect: "postgres" });

const posts = defineTable("posts", {
  id: columns.integer().primaryKey(),
  authorId: columns.integer().notNull(),
  title: columns.text().notNull(),
  status: columns.text().notNull().default("draft"),
  hotScore: columns.integer().notNull().default(0),
  published: columns.boolean().optional(),
  createdAt: columns.timestamp().optional(),
  tags: columns.text().array().optional(),
  meta: columns.jsonb().optional(),
});

const authors = defineTable("authors", {
  id: columns.integer().primaryKey(),
  name: columns.text().notNull(),
});

const archive = defineTable("posts_archive", {
  id: columns.integer().primaryKey(),
  title: columns.text().notNull(),
});

const votePost = defineFunction("app.vote_post", {
  args: { postId: columns.uuid(), value: columns.smallint() },
  returns: { id: columns.uuid().notNull(), score: columns.integer().notNull() },
});

const cursorDate = Temporal.PlainDateTime.from("2024-01-01T00:00:00");
const instant = Temporal.Instant.from("2026-01-02T03:04:05.123456Z");

const p = posts.columns;
const a = authors.columns;

// ---- the catalog ------------------------------------------------------------
// One entry per construct; the snapshot records its render on every target.

const CATALOG: ReadonlyArray<readonly [string, () => Sql]> = [
  // -- SELECT core
  [
    "select: star + where eq",
    () => db.select().from(posts).where(eq(p.status, "published")).toSql(),
  ],
  [
    "select: projection aliases + naming map",
    () => db.select({ id: p.id, hotScore: p.hotScore }).from(posts).toSql(),
  ],
  [
    "operators: comparisons",
    () =>
      db.select({ id: p.id }).from(posts).where(and(
        ne(p.status, "draft"),
        gt(p.hotScore, 1),
        gte(p.hotScore, 2),
        lt(p.id, 100),
        lte(p.id, 99),
      )).toSql(),
  ],
  ["operators: like family", () =>
    db.select({ id: p.id }).from(posts).where(or(
      like(p.title, "a%"),
      notLike(p.title, "b%"),
      ilike(p.title, "c%"),
      notIlike(p.title, "d%"),
    )).toSql()],
  ["operators: in / null", () =>
    db.select({ id: p.id }).from(posts).where(and(
      inArray(p.status, ["published", "archived"]),
      notInArray(p.id, [1, 2]),
      isNull(p.published),
      isNotNull(p.createdAt),
    )).toSql()],
  [
    "operators: between / not",
    () =>
      db.select({ id: p.id }).from(posts).where(and(
        between(p.hotScore, 1, 10),
        notBetween(p.id, 5, 6),
        not(eq(p.status, "hidden")),
      )).toSql(),
  ],
  [
    "operators: exists / notExists",
    () =>
      db.select({ id: p.id }).from(posts).where(and(
        exists(
          db.select({ id: a.id }).from(authors).where(eq(a.id, p.authorId)),
        ),
        notExists(
          db.select({ id: a.id }).from(authors).where(eq(a.name, "banned")),
        ),
      )).toSql(),
  ],
  [
    "operators: array (pg-only guards)",
    () =>
      db.select({ id: p.id }).from(posts).where(or(
        arrayContains(p.tags, ["deno"]),
        arrayContained(p.tags, ["deno", "sql"]),
        arrayOverlaps(p.tags, ["orm"]),
      )).toSql(),
  ],
  // -- joins
  ["join: inner + left", () =>
    db.select({ id: p.id, name: a.name }).from(posts)
      .innerJoin(authors, eq(p.authorId, a.id))
      .leftJoin(archive, eq(p.id, archive.columns.id))
      .toSql()],
  ["join: right", () =>
    db.select({ id: p.id, name: a.name }).from(posts)
      .rightJoin(authors, eq(p.authorId, a.id)).toSql()],
  [
    "join: full (guarded off postgres)",
    () =>
      db.select({ id: p.id, name: a.name }).from(posts)
        .fullJoin(authors, eq(p.authorId, a.id)).toSql(),
  ],
  // -- aggregation
  ["aggregates: group by + having", () =>
    db.select({
      status: p.status,
      total: count(),
      authors: countDistinct(p.authorId),
      score: sum(p.hotScore),
      average: avg(p.hotScore),
      lowest: min(p.hotScore),
      highest: max(p.hotScore),
    }).from(posts).groupBy(p.status).having(gt(count(), 1)).toSql()],
  ["aggregates: filter()", () =>
    db.select({
      published: filter(count(), eq(p.status, "published")),
      hotSum: filter(sum(p.hotScore), gt(p.hotScore, 10)),
    }).from(posts).groupBy(p.authorId).toSql()],
  // -- ordering / paging / row shape
  ["order + limit + offset", () =>
    db.select({ id: p.id }).from(posts)
      .orderBy(desc(p.hotScore), asc(p.id)).limit(10).offset(20).toSql()],
  [
    "distinct",
    () => db.select({ status: p.status }).from(posts).distinct().toSql(),
  ],
  [
    "distinctOn (guarded off postgres)",
    () =>
      db.select({ status: p.status, id: p.id }).from(posts)
        .distinctOn(p.status).orderBy(asc(p.status), desc(p.id)).toSql(),
  ],
  [
    "row locking: for update skip locked",
    () =>
      db.select({ id: p.id }).from(posts).where(eq(p.status, "queued"))
        .for("update", { skipLocked: true }).toSql(),
  ],
  ["row locking: for share nowait", () =>
    db.select({ id: p.id }).from(posts)
      .for("share", { noWait: true }).toSql()],
  ["keyset: expanded form", () =>
    db.select().from(posts).keyset({
      orderBy: [desc(p.createdAt), desc(p.id)],
      after: { createdAt: cursorDate, id: 7 },
    }).limit(2).toSql()],
  ["keyset: row-value form", () =>
    db.select().from(posts).keyset({
      orderBy: [desc(p.createdAt), desc(p.id)],
      after: { createdAt: cursorDate, id: 7 },
      form: "row-value",
    }).limit(2).toSql()],
  // -- compound queries
  ["compound: union", () =>
    db.select({ id: p.id }).from(posts)
      .union(db.select({ id: archive.columns.id }).from(archive)).toSql()],
  [
    "compound: unionAll + intersect + except",
    () =>
      db.select({ id: p.id }).from(posts)
        .unionAll(db.select({ id: archive.columns.id }).from(archive))
        .intersect(db.select({ id: p.id }).from(posts))
        .except(db.select({ id: archive.columns.id }).from(archive))
        .toSql(),
  ],
  // -- CTEs and subqueries
  ["cte: WITH ... SELECT", () => {
    const hot = db.$with("hot").as(
      db.select({ id: p.id }).from(posts).where(gt(p.hotScore, 10)),
    );
    return db.with(hot).select({ id: hot.id }).from(hot).toSql();
  }],
  ["subquery: derived table via .as()", () => {
    const hot = db.select({ id: p.id, hotScore: p.hotScore }).from(posts)
      .where(gt(p.hotScore, 10)).as("hot");
    return db.select({ id: hot.id }).from(hot).toSql();
  }],
  // -- date/time helpers
  ["dates: dateTrunc / now / dateAdd / dateSub", () =>
    db.select({
      bucket: dateTrunc("hour", p.createdAt),
      until: dateAdd(now(), { days: 1 }),
      since: dateSub(now(), { minutes: 30 }),
    }).from(posts).where(gte(p.createdAt, dateSub(now(), { hours: 6 })))
      .toSql()],
  ["dates: dateBin bucketing", () => {
    const bucket = dateBin({ minutes: 5 }, p.createdAt);
    return db.select({ bucket, n: count() }).from(posts).groupBy(bucket)
      .orderBy(asc(bucket)).toSql();
  }],
  // -- computed columns + nested selects (item 8)
  ["select: scalar subquery in projection", () =>
    db.select({
      id: a.id,
      posts: db.select({ n: count() }).from(posts)
        .where(eq(p.authorId, a.id)),
    }).from(authors).toSql()],
  // -- json/array primitives (item 14)
  [
    "json: arrayExpr construction",
    () =>
      db.select({ tags: arrayExpr<string>("a", "b", p.title) })
        .from(posts).toSql(),
  ],
  [
    "json: jsonExtract scalar path",
    () =>
      db.select({ title: jsonExtract(p.meta, "$.title") }).from(posts).toSql(),
  ],
  ["json: jsonTable set-returning FROM", () => {
    const items = jsonTable(p.meta, {
      sku: { type: "text", path: "$.sku" },
      qty: { type: "integer", path: "$.qty" },
    }, { as: "item", path: "$.items" });
    return db.select({ sku: items.columns.sku, qty: items.columns.qty })
      .from(items.from).toSql();
  }],
  // -- statement assembly (items 5/13)
  [
    "assembly: insert-from-select + upsert (core seam)",
    () =>
      assembleInsertFromSelect({
        into: archive,
        select: {
          select: { id: p.id, title: p.title },
          from: posts,
          where: eq(p.status, "archived"),
        },
        onConflictDoUpdate: {
          target: [archive.columns.id],
          set: { title: excluded(archive.columns.title) },
        },
      }),
  ],
  // -- wave-3 expression surface (items 7/9/10/11)
  ["expressions: coalesce + greatest + least", () =>
    db.select({
      score: coalesce<number>(p.hotScore, 0),
      capped: greatest<number>(p.hotScore, 0),
      floor: least<number>(p.hotScore, 100),
    }).from(posts).toSql()],
  ["dates: dateDiff whole units", () =>
    db.select({
      ageMinutes: dateDiff("minutes", p.createdAt, now()),
      ageDays: dateDiff("days", p.createdAt, now()),
    }).from(posts).toSql()],
  ["window: over partition/order/rows frame", () =>
    db.select({
      id: p.id,
      moving: over(avg(p.hotScore), {
        partitionBy: [p.authorId],
        orderBy: [asc(p.createdAt)],
        frame: { unit: "rows", start: { preceding: 5 }, end: "currentRow" },
      }),
    }).from(posts).toSql()],
  ["window: ranking + lag/lead", () =>
    db.select({
      pos: over(rank(), { orderBy: [desc(p.hotScore)] }),
      n: over(rowNumber(), { orderBy: [asc(p.id)] }),
      prev: over(lag<number>(p.hotScore, 1, 0), { orderBy: [asc(p.id)] }),
      next: over(lead<number>(p.hotScore), { orderBy: [asc(p.id)] }),
    }).from(posts).toSql()],
  ["window: groups frame (capability-gated)", () =>
    db.select({
      dense: over(sum(p.hotScore), {
        orderBy: [asc(p.hotScore)],
        frame: {
          unit: "groups",
          start: "unboundedPreceding",
          end: "currentRow",
        },
      }),
    }).from(posts).toSql()],
  ["cte: WITH RECURSIVE (column list + union all)", () => {
    const tree = db.$withRecursive("tree", ["id", "depth"]).as((self) =>
      db.select({ id: p.id, depth: sql`1` }).from(posts)
        .where(eq(p.id, 1))
        .unionAll(
          db.select({ id: p.id, depth: sql`${self.depth} + 1` }).from(self)
            .innerJoin(posts, eq(p.authorId, self.id))
            .where(lt(self.depth, 5)),
        )
    );
    return db.with(tree).select({ id: tree.id }).from(tree).toSql();
  }],
  // -- sql tag primitives
  ["sql tag: params + identifier + raw + nesting", () => {
    const cond = sql`${p.hotScore} > ${5}`;
    return sql`select ${identifier("posts.title")}, ${
      raw("1 + 1")
    } as two from posts where ${cond} and ${p.status} = ${"published"}`;
  }],
  [
    "sql tag: temporal instant param (mysql naive-UTC rewrite)",
    () => sql`select * from posts where created_at >= ${instant}`,
  ],
  // -- typed function caller (renders on every dialect; per-engine support
  // is a documented matrix limit, not a render guard)
  [
    "function call: db.call",
    () => db.call(votePost, { postId: "p1", value: 1 }).toSql(),
  ],
  // -- INSERT
  ["insert: single row (sql expression value)", () =>
    db.insert(posts).values({
      id: 1,
      authorId: 2,
      title: "hello",
      hotScore: sql`${raw("1 + 2")}`,
    }).toSql()],
  ["insert: multi-row", () =>
    db.insert(authors).values([
      { id: 1, name: "ada" },
      { id: 2, name: "grace" },
    ]).toSql()],
  ["insert: from select", () =>
    db.insert(archive).select(
      db.select({ id: p.id, title: p.title }).from(posts)
        .where(eq(p.status, "archived")),
    ).toSql()],
  [
    "insert: returning",
    () => db.insert(authors).values({ id: 3, name: "lin" }).returning().toSql(),
  ],
  [
    "upsert: onConflictDoUpdate + excluded()",
    () =>
      db.insert(posts).values({ id: 1, authorId: 2, title: "hi" })
        .onConflictDoUpdate({
          target: p.id,
          set: {
            title: excluded(p.title),
            hotScore: sql`${excluded(p.hotScore)} + 1`,
          },
        }).toSql(),
  ],
  [
    "upsert: onConflictDoNothing (bare)",
    () =>
      db.insert(authors).values({ id: 1, name: "ada" })
        .onConflictDoNothing().toSql(),
  ],
  [
    "upsert: conflict where (no mysql equivalent)",
    () =>
      db.insert(posts).values({ id: 1, authorId: 2, title: "hi" })
        .onConflictDoUpdate({
          target: p.id,
          set: { title: excluded(p.title) },
          where: gt(p.hotScore, 0),
        }).toSql(),
  ],
  ["cte: WITH ... INSERT (mariadb guard)", () => {
    const hot = db.$with("hot").as(
      db.select({ id: p.id, title: p.title }).from(posts)
        .where(gt(p.hotScore, 10)),
    );
    return db.with(hot).insert(archive).select(
      db.select({ id: hot.id, title: hot.title }).from(hot),
    ).toSql();
  }],
  // -- UPDATE
  ["update: set + where (sql expression)", () =>
    db.update(posts).set({
      status: "published",
      hotScore: sql`${p.hotScore} + 1`,
    }).where(eq(p.id, 1)).toSql()],
  [
    "update: unsafeAllowAllRows",
    () =>
      db.update(posts).set({ status: "draft" }).unsafeAllowAllRows().toSql(),
  ],
  [
    "update: from table (multi-table mapping)",
    () =>
      db.update(posts).set({ hotScore: 0 })
        .from(authors).where(eq(p.authorId, a.id)).toSql(),
  ],
  ["update: from subquery", () => {
    const hot = db.select({ id: p.id }).from(posts).where(gt(p.hotScore, 10))
      .as("hot");
    return db.update(posts).set({ status: "hot" })
      .from(hot).where(eq(p.id, hot.id)).toSql();
  }],
  [
    "update: returning",
    () =>
      db.update(posts).set({ status: "published" }).where(eq(p.id, 1))
        .returning({ id: p.id }).toSql(),
  ],
  [
    "update: from + returning (double guard)",
    () =>
      db.update(posts).set({ hotScore: 0 })
        .from(authors).where(eq(p.authorId, a.id))
        .returning({ id: p.id }).toSql(),
  ],
  ["cte: WITH ... UPDATE (mariadb guard)", () => {
    const hot = db.$with("hot").as(
      db.select({ id: p.id }).from(posts).where(gt(p.hotScore, 10)),
    );
    return db.with(hot).update(posts).set({ status: "hot" })
      .from(hot).where(eq(p.id, hot.id)).toSql();
  }],
  ["cte: data-modifying body (pg-only)", () => {
    const moved = db.$with("moved").as(
      db.delete(posts).where(eq(p.status, "archived"))
        .returning({ id: p.id, title: p.title }),
    );
    return db.with(moved).insert(archive).select(
      db.select({ id: moved.id, title: moved.title }).from(moved),
    ).toSql();
  }],
  // -- DELETE
  ["delete: where", () => db.delete(posts).where(eq(p.id, 1)).toSql()],
  [
    "delete: unsafeAllowAllRows",
    () => db.delete(archive).unsafeAllowAllRows().toSql(),
  ],
  [
    "delete: using (multi-table mapping)",
    () => db.delete(posts).using(authors).where(eq(p.authorId, a.id)).toSql(),
  ],
  [
    "delete: returning",
    () => db.delete(posts).where(eq(p.id, 1)).returning().toSql(),
  ],
  ["cte: WITH ... DELETE (mariadb guard)", () => {
    const stale = db.$with("stale").as(
      db.select({ id: p.id }).from(posts).where(lt(p.hotScore, 0)),
    );
    return db.with(stale).delete(posts).using(stale)
      .where(eq(p.id, stale.id)).toSql();
  }],
];

Deno.test("golden: every IR construct renders identically per dialect", async (t) => {
  if (!isRealDeno) return; // snapshot mechanism is Deno-only; see above
  const assertSnapshot = await loadAssertSnapshot();
  for (const [name, build] of CATALOG) {
    await t.step(name, async (step) => {
      await assertSnapshot(step, renderAll(build()));
    });
  }
});

// Prepared plans render at prepare() time with the facade's own dialect, so
// the placeholder styles ($1 vs ?) and deferred-binding order are pinned per
// dialect facade rather than through renderAll.
Deno.test("golden: prepared-plan placeholders per dialect", async (t) => {
  if (!isRealDeno) return; // snapshot mechanism is Deno-only; see above
  const assertSnapshot = await loadAssertSnapshot();
  const facades: Record<string, Database> = {
    postgres: createDatabase({ dialect: "postgres" }),
    sqlite: createDatabase({ dialect: "sqlite" }),
    mysql: createDatabase({ dialect: "mysql" }),
    generic: createDatabase({ dialect: "generic" }),
  };
  const plans: Record<string, { text: string; params: readonly unknown[] }> =
    {};
  for (const [label, facade] of Object.entries(facades)) {
    const prepared = facade.select({ id: p.id }).from(posts)
      .where(and(eq(p.status, placeholder("status")), gt(p.hotScore, 5)))
      .orderBy(desc(p.id)).limit(3)
      .prepare(`golden_${label}`);
    const bound = prepared.toSql({ status: "published" });
    plans[label] = { text: bound.text, params: bound.params ?? [] };
  }
  await assertSnapshot(t, plans);
});
