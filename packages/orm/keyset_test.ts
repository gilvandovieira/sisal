/**
 * Tests for keyset (cursor) pagination: the expanded `or`/`and` and row-value
 * predicate forms, `ORDER BY` emission, ascending/descending comparators,
 * `nextCursor` derivation from a full page, cursor-type inference, and the
 * validation guards.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  asc,
  columns,
  createDatabase,
  defineTable,
  desc,
  eq,
  type OrmDriver,
  type OrmQueryResult,
  renderSql,
  type Sql,
  sql,
  type SqlQuery,
} from "./mod.ts";

const db = createDatabase({ dialect: "postgres" });

const posts = defineTable("posts", {
  id: columns.uuid().primaryKey(),
  status: columns.text().notNull(),
  hot_score: columns.doublePrecision().notNull(),
  created_at: columns.timestamp({ withTimezone: true }).notNull(),
});

function renderText(query: { toSql(): Sql }): string {
  return renderSql(query.toSql(), { dialect: "postgres" }).text;
}

function rowsDriver(rows: Array<Record<string, unknown>>): OrmDriver {
  return {
    query<T>(_query: SqlQuery): Promise<OrmQueryResult<T>> {
      return Promise.resolve({ rows: rows as T[], rowCount: rows.length });
    },
    execute(_query: SqlQuery): Promise<OrmQueryResult> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

const date = new Date("2024-01-01T00:00:00Z");

Deno.test("keyset: first page emits only ORDER BY (no predicate)", () => {
  assertEquals(
    renderText(
      db.select().from(posts).keyset({
        orderBy: [
          desc(posts.columns.hot_score),
          desc(posts.columns.created_at),
          desc(posts.columns.id),
        ],
      }).limit(20),
    ),
    'select * from "posts" order by "posts"."hot_score" desc, ' +
      '"posts"."created_at" desc, "posts"."id" desc limit $1',
  );
});

Deno.test("keyset: expanded form ANDs with an existing where", () => {
  const rendered = renderSql(
    db.select().from(posts)
      .where(eq(posts.columns.status, "published"))
      .keyset({
        orderBy: [desc(posts.columns.created_at), desc(posts.columns.id)],
        after: { created_at: date, id: "p1" },
      })
      .limit(2)
      .toSql(),
    { dialect: "postgres" },
  );
  assertEquals(
    rendered.text,
    'select * from "posts" where ("posts"."status" = $1) and ' +
      '(("posts"."created_at" < $2) or ' +
      '("posts"."created_at" = $3 and "posts"."id" < $4)) ' +
      'order by "posts"."created_at" desc, "posts"."id" desc limit $5',
  );
  assertEquals(rendered.params, ["published", date, date, "p1", 2]);
});

Deno.test("keyset: row-value form emits (a, b) < (x, y)", () => {
  const rendered = renderSql(
    db.select().from(posts).keyset({
      orderBy: [desc(posts.columns.created_at), desc(posts.columns.id)],
      after: { created_at: date, id: "p1" },
      form: "row-value",
    }).limit(2).toSql(),
    { dialect: "postgres" },
  );
  assertEquals(
    rendered.text,
    'select * from "posts" where ("posts"."created_at", "posts"."id") < ' +
      '($1, $2) order by "posts"."created_at" desc, "posts"."id" desc limit $3',
  );
  assertEquals(rendered.params, [date, "p1", 2]);
});

Deno.test("keyset: ascending terms use the > comparator", () => {
  const text = renderText(
    db.select().from(posts).keyset({
      orderBy: [asc(posts.columns.created_at), asc(posts.columns.id)],
      after: { created_at: date, id: "p1" },
    }).limit(2),
  );
  assert(text.includes('"posts"."created_at" > $1'), text);
  assert(text.includes('"posts"."id" > $3'), text);
  assert(text.includes('order by "posts"."created_at" asc'), text);
});

Deno.test("keyset: nextCursor comes from the last row of a full page", async () => {
  const rows = [
    { id: "a", status: "x", hot_score: 9, created_at: date },
    { id: "b", status: "x", hot_score: 8, created_at: date },
  ];
  const database = createDatabase({
    driver: rowsDriver(rows),
    dialect: "postgres",
  });
  const page = await database.select().from(posts).keyset({
    orderBy: [
      desc(posts.columns.hot_score),
      desc(posts.columns.created_at),
      desc(posts.columns.id),
    ],
  }).limit(2).execute();

  assertEquals(page.rows, rows);
  assertEquals(page.nextCursor, { hot_score: 8, created_at: date, id: "b" });

  // Cursor type is inferred from the orderBy columns.
  if (page.nextCursor !== null) {
    const cursor: { hot_score: number; created_at: Date; id: string } =
      page.nextCursor;
    assertEquals(cursor.id, "b");
  }
});

Deno.test("keyset: a partial page yields a null nextCursor", async () => {
  const database = createDatabase({
    driver: rowsDriver([{
      id: "a",
      status: "x",
      hot_score: 9,
      created_at: date,
    }]),
    dialect: "postgres",
  });
  const page = await database.select().from(posts).keyset({
    orderBy: [desc(posts.columns.hot_score), desc(posts.columns.id)],
  }).limit(2).execute();
  assertEquals(page.nextCursor, null);
});

Deno.test("keyset: row-value rejects mixed sort directions", () => {
  assertThrows(() =>
    db.select().from(posts).keyset({
      orderBy: [desc(posts.columns.created_at), asc(posts.columns.id)],
      after: { created_at: date, id: "p1" },
      form: "row-value",
    })
  );
});

Deno.test("keyset: a cursor missing an ordered column is rejected", () => {
  assertThrows(() =>
    db.select().from(posts).keyset({
      orderBy: [desc(posts.columns.created_at), desc(posts.columns.id)],
      // deno-lint-ignore no-explicit-any -- omit the `id` cursor value
      after: { created_at: date } as any,
    })
  );
});

Deno.test("keyset: non-column orderBy terms are rejected", () => {
  assertThrows(() =>
    // deno-lint-ignore no-explicit-any -- desc() of a raw expression has no column
    db.select().from(posts).keyset({ orderBy: [desc(sql`1`)] as any })
  );
});
