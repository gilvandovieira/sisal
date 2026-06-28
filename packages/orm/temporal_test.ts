import { assertEquals, assertInstanceOf } from "@std/assert";
import {
  columns,
  createDatabase,
  defineFunction,
  defineTable,
  type InferInsert,
  type InferSelect,
  type OrmDriver,
  type OrmQueryResult,
  relations,
  renderSql,
  serializeSqlValue,
  sql,
  type SqlQuery,
} from "./mod.ts";

const temporalRows = defineTable("temporal_rows", {
  id: columns.text().primaryKey(),
  day: columns.date().notNull(),
  clock: columns.time().notNull(),
  localAt: columns.timestamp().notNull(),
  instantAt: columns.timestamp({ withTimezone: true }).notNull(),
  legacyAt: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  textAt: columns.timestamp({ withTimezone: true, mode: "string" }).notNull(),
});

function rowsDriver(rows: Array<Record<string, unknown>>): OrmDriver {
  return {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      void query;
      return Promise.resolve({ rows: rows as T[], rowCount: rows.length });
    },
    execute<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      void query;
      return Promise.resolve({ rows: rows as T[], rowCount: rows.length });
    },
  };
}

Deno.test("temporal: column modes infer semantic Temporal, Date, and string types", () => {
  const row: InferSelect<typeof temporalRows> = {
    id: "r1",
    day: Temporal.PlainDate.from("2026-06-28"),
    clock: Temporal.PlainTime.from("12:34:56.123456789"),
    localAt: Temporal.PlainDateTime.from("2026-06-28T12:34:56.123456789"),
    instantAt: Temporal.Instant.from("2026-06-28T12:34:56.123456789Z"),
    legacyAt: new Date(0),
    textAt: "2026-06-28T12:34:56.123456Z",
  };
  const insert: InferInsert<typeof temporalRows> = row;

  assertEquals(row.day.toString(), "2026-06-28");
  assertEquals(insert.instantAt.toString(), "2026-06-28T12:34:56.123456789Z");
  assertInstanceOf(row.legacyAt, Date);
});

Deno.test("temporal: SQL parameters serialize to ISO strings", () => {
  assertEquals(
    serializeSqlValue(Temporal.PlainDate.from("2026-06-28")),
    "2026-06-28",
  );
  assertEquals(
    serializeSqlValue(Temporal.PlainTime.from("12:34:56.123456789")),
    "12:34:56.123456789",
  );
  assertEquals(
    serializeSqlValue(
      Temporal.PlainDateTime.from("2026-06-28T12:34:56.123456789"),
    ),
    "2026-06-28T12:34:56.123456789",
  );
  assertEquals(
    serializeSqlValue(Temporal.Instant.from("2026-06-28T12:34:56.123456789Z")),
    "2026-06-28T12:34:56.123456789Z",
  );
  assertEquals(
    serializeSqlValue(
      Temporal.ZonedDateTime.from(
        "2026-06-28T09:34:56.123456789-03:00[America/Fortaleza]",
      ),
    ),
    "2026-06-28T12:34:56.123456789Z",
  );
  assertEquals(
    serializeSqlValue([
      Temporal.PlainDate.from("2026-06-28"),
      Temporal.Instant.from("2026-06-28T12:00:00Z"),
    ]),
    ["2026-06-28", "2026-06-28T12:00:00Z"],
  );

  const rendered = renderSql(
    sql`select ${Temporal.Instant.from("2026-06-28T12:00:00.123456789Z")}`,
    { dialect: "postgres" },
  );
  assertEquals(rendered.text, "select $1");
  assertEquals(rendered.params, ["2026-06-28T12:00:00.123456789Z"]);
});

Deno.test("temporal: parse=false preserves driver row values", async () => {
  const database = createDatabase({
    dialect: "postgres",
    driver: rowsDriver([
      {
        id: "r1",
        day: "2026-06-28",
        clock: "12:34:56.123456",
        localAt: "2026-06-28 12:34:56.123456",
        instantAt: "2026-06-28T12:34:56.123456Z",
        legacyAt: new Date(0),
        textAt: new Date(0),
      },
    ]),
  });

  const [row] = await database.select().from(temporalRows).execute();
  assertEquals(typeof row.day, "string");
  assertEquals(typeof row.localAt, "string");
  assertInstanceOf(row.legacyAt, Date);
  assertInstanceOf(row.textAt, Date);
});

Deno.test("temporal: parse=true decodes known select columns", async () => {
  const database = createDatabase({
    dialect: "postgres",
    temporal: { parse: true },
    driver: rowsDriver([
      {
        id: "r1",
        day: "2026-06-28",
        clock: "12:34:56.123456",
        localAt: "2026-06-28 12:34:56.123456",
        instantAt: "2026-06-28T12:34:56.123456Z",
        legacyAt: new Date(0),
        textAt: new Date(0),
      },
    ]),
  });

  const [row] = await database.select().from(temporalRows).execute();
  assertInstanceOf(row.day, Temporal.PlainDate);
  assertInstanceOf(row.clock, Temporal.PlainTime);
  assertInstanceOf(row.localAt, Temporal.PlainDateTime);
  assertInstanceOf(row.instantAt, Temporal.Instant);
  assertInstanceOf(row.legacyAt, Date);
  assertEquals(row.textAt, "1970-01-01T00:00:00.000Z");
});

Deno.test("temporal: raw SQL rows do not auto-parse", async () => {
  const database = createDatabase({
    dialect: "postgres",
    temporal: { parse: true },
    driver: rowsDriver([{ day: "2026-06-28" }]),
  });

  const result = await database.query<{ day: unknown }>(
    sql`select current_date`,
  );
  assertEquals(result.rows[0].day, "2026-06-28");
});

Deno.test("temporal: returning rows decode when metadata is available", async () => {
  const database = createDatabase({
    dialect: "postgres",
    temporal: { parse: true },
    driver: rowsDriver([
      {
        id: "r1",
        day: "2026-06-28",
        clock: "12:34:56.123456",
        localAt: "2026-06-28T12:34:56.123456",
        instantAt: "2026-06-28T12:34:56.123456Z",
        legacyAt: new Date(0),
        textAt: "2026-06-28T12:34:56.123456Z",
      },
    ]),
  });

  const result = await database.insert(temporalRows).values({
    id: "r1",
    day: Temporal.PlainDate.from("2026-06-28"),
    clock: Temporal.PlainTime.from("12:34:56.123456"),
    localAt: Temporal.PlainDateTime.from("2026-06-28T12:34:56.123456"),
    instantAt: Temporal.Instant.from("2026-06-28T12:34:56.123456Z"),
    legacyAt: new Date(0),
    textAt: "2026-06-28T12:34:56.123456Z",
  }).returning().execute();

  assertInstanceOf(result.rows[0].day, Temporal.PlainDate);
  assertInstanceOf(result.rows[0].instantAt, Temporal.Instant);
});

Deno.test("temporal: function returns decode scalar and table shapes", async () => {
  const tableFn = defineFunction("app.temporal_table", {
    returns: {
      day: columns.date().notNull(),
      instantAt: columns.timestamp({ withTimezone: true }).notNull(),
    },
  });
  const scalarFn = defineFunction("app.temporal_scalar", {
    returns: columns.timestamp({ withTimezone: true }),
  });
  const tableDb = createDatabase({
    dialect: "postgres",
    temporal: { parse: true },
    driver: rowsDriver([
      {
        day: "2026-06-28",
        instantAt: "2026-06-28T12:34:56.123456Z",
      },
    ]),
  });
  const scalarDb = createDatabase({
    dialect: "postgres",
    temporal: { parse: true },
    driver: rowsDriver([{ result: "2026-06-28T12:34:56.123456Z" }]),
  });

  const [row] = await tableDb.call(tableFn, {}).execute();
  const scalar = await scalarDb.call(scalarFn, {}).one();

  assertInstanceOf(row.day, Temporal.PlainDate);
  assertInstanceOf(row.instantAt, Temporal.Instant);
  assertInstanceOf(scalar, Temporal.Instant);
});

Deno.test("temporal: relational queries decode known columns", async () => {
  const users = defineTable("temporal_users", {
    id: columns.text().primaryKey(),
    birthday: columns.date().notNull(),
  });
  const posts = defineTable("temporal_posts", {
    id: columns.text().primaryKey(),
    userId: columns.text().references("temporal_users", "id"),
    publishedAt: columns.timestamp({ withTimezone: true }).notNull(),
  });
  const userRelations = relations(users, ({ many }) => ({
    posts: many(posts, {
      fields: [users.columns.id],
      references: [posts.columns.userId],
    }),
  }));
  const driver: OrmDriver = {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      if (query.text.includes('"temporal_users"')) {
        return Promise.resolve({
          rows: [{ id: "u1", birthday: "2026-06-28" }] as T[],
          rowCount: 1,
        });
      }
      return Promise.resolve({
        rows: [{
          id: "p1",
          userId: "u1",
          publishedAt: "2026-06-28T12:00:00Z",
        }] as T[],
        rowCount: 1,
      });
    },
    execute() {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  const db = createDatabase({
    dialect: "postgres",
    schema: { users },
    relations: [userRelations],
    temporal: { parse: true },
    driver,
  });

  const [user] = await db.query.users.findMany({ with: { posts: true } });

  assertInstanceOf(user.birthday, Temporal.PlainDate);
  assertInstanceOf(user.posts[0]?.publishedAt, Temporal.Instant);
});
