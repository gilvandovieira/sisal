/**
 * Fake database proxy benchmark scenarios.
 *
 * These scenarios exercise Sisal's public driver and adapter boundaries without
 * requiring PostgreSQL, SQLite, libSQL, or Neon to be running locally.
 *
 * @module
 */

import {
  columns,
  createDatabase,
  defineTable,
  desc,
  eq,
  relations,
  sql,
} from "@sisal/orm";
import {
  createMigrator,
  defineMigration,
  memoryMigrationStore,
} from "@sisal/migrate";
import {
  createLibsqlMigrationDriver,
  createLibsqlOrmDriver,
} from "@sisal/libsql";
import { createPgMigrationDriver, createPgOrmDriver } from "@sisal/pg";
import {
  createSqliteMigrationDriver,
  createSqliteOrmDriver,
} from "@sisal/sqlite";

import type { BenchmarkScenario } from "../harness.ts";
import {
  createFakeDbProxy,
  type FakeDbProxy,
  type FakeDbProxyStats,
  type FakeDbRequest,
  type FakeDbRow,
} from "../fakedbproxy.ts";

const GROUP = "fake db proxy";
const LARGE_RESULT_ROWS = 128;
const BULK_STATEMENT_COUNT = 48;

const users = defineTable("users", {
  id: columns.uuid().primaryKey(),
  email: columns.text().notNull(),
  displayName: columns.text().notNull(),
});

const posts = defineTable("posts", {
  id: columns.uuid().primaryKey(),
  authorId: columns.uuid().notNull().references("users", "id"),
  title: columns.text().notNull(),
});

const userRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

const bulkMigration = defineMigration({
  id: "0001_bulk_fake_db_proxy",
  up: Array.from(
    { length: BULK_STATEMENT_COUNT },
    (_, index) => `insert into audit_log values (${index + 1});`,
  ),
  down: Array.from(
    { length: BULK_STATEMENT_COUNT },
    (_, index) => `delete from audit_log where id = ${index + 1};`,
  ),
});

const rawProxy = createFakeDbProxy({ rows: 0, rowCount: 0 });
const rawDb = createDatabase({
  driver: rawProxy.asOrmDriver(),
  dialect: "postgres",
});

const largeResultProxy = createFakeDbProxy({ rows: LARGE_RESULT_ROWS });
const largeResultDb = createDatabase({
  driver: largeResultProxy.asOrmDriver(),
  dialect: "postgres",
});

const builderProxy = createFakeDbProxy({
  rows: 1,
  rowCount: ({ operation }) => operation === "execute" ? 1 : 0,
});
const builderDb = createDatabase({
  driver: builderProxy.asOrmDriver(),
  dialect: "postgres",
});

const relationalProxy = createFakeDbProxy({ rows: relationalRows });
const relationalDb = createDatabase({
  driver: relationalProxy.asOrmDriver(),
  dialect: "postgres",
  schema: { users, posts },
  relations: [userRelations],
});

const asyncProxy = createFakeDbProxy({
  rows: 1,
  latency: { microtasks: 4 },
});
const asyncDb = createDatabase({
  driver: asyncProxy.asOrmDriver(),
  dialect: "postgres",
});

export const fakeDbProxyScenarios: readonly BenchmarkScenario[] = [
  {
    group: GROUP,
    name: "orm raw query empty result",
    baseline: true,
    async fn() {
      rawProxy.reset();
      await rawDb.query(sql`select * from users where id = ${"u_1"}`);
      assertStats(rawProxy, { queries: 1 });
    },
  },
  {
    group: GROUP,
    name: `orm raw query ${LARGE_RESULT_ROWS} synthetic rows`,
    async fn() {
      largeResultProxy.reset();
      const result = await largeResultDb.query(
        sql`select * from users order by id`,
      );
      if (result.rows.length !== LARGE_RESULT_ROWS) {
        throw new Error("Fake DB proxy returned an unexpected row count.");
      }
    },
  },
  {
    group: GROUP,
    name: "orm builders insert + select",
    async fn() {
      builderProxy.reset();

      await builderDb.insert(users).values({
        id: "u_1",
        email: "ada@example.com",
        displayName: "Ada",
      }).returning().execute();

      await builderDb.select({
        id: users.columns.id,
        email: users.columns.email,
      }).from(users).where(eq(users.columns.id, "u_1")).orderBy(
        desc(users.columns.email),
      ).limit(1).execute();

      assertStats(builderProxy, { queries: 1, executes: 1 });
    },
  },
  {
    group: GROUP,
    name: "relational findMany with nested load",
    async fn() {
      relationalProxy.reset();
      const rows = await relationalDb.query.users.findMany({
        columns: { id: true, email: true },
        with: {
          posts: { columns: { id: true, title: true } },
        },
        limit: 4,
      });

      if (rows.length !== 4 || rows[0]?.posts.length !== 2) {
        throw new Error("Fake relational rows were not attached correctly.");
      }
      assertStats(relationalProxy, { queries: 2 });
    },
  },
  {
    group: GROUP,
    name: "adapter executor injection matrix",
    async fn() {
      await runAdapterExecutorMatrix();
    },
  },
  {
    group: GROUP,
    name: `migration driver ${BULK_STATEMENT_COUNT} statements in transaction`,
    async fn() {
      await runMigrationDriverScenario();
    },
  },
  {
    group: GROUP,
    name: "orm query with async proxy ticks",
    async fn() {
      asyncProxy.reset();
      await asyncDb.query(sql`select ${1} as value`);
      assertStats(asyncProxy, { queries: 1 });
    },
  },
];

function relationalRows(request: FakeDbRequest): readonly FakeDbRow[] {
  if (request.sql.includes('from "users"')) {
    return Array.from({ length: 4 }, (_, index) => ({
      id: `u_${index + 1}`,
      email: `user${index + 1}@example.com`,
      displayName: `User ${index + 1}`,
    }));
  }

  if (request.sql.includes('from "posts"')) {
    return Array.from({ length: 8 }, (_, index) => ({
      id: `p_${index + 1}`,
      authorId: `u_${Math.floor(index / 2) + 1}`,
      title: `Post ${index + 1}`,
    }));
  }

  return [];
}

async function runAdapterExecutorMatrix(): Promise<void> {
  const pgProxy = createFakeDbProxy({ rows: 1, rowCount: 1 });
  const sqliteProxy = createFakeDbProxy({ rows: 1, rowCount: 1 });
  const libsqlProxy = createFakeDbProxy({ rows: 1, rowCount: 1 });

  const adapters = [
    {
      proxy: pgProxy,
      orm: createPgOrmDriver({ executor: pgProxy.asSqlExecutor() }),
      migrate: createPgMigrationDriver({ executor: pgProxy.asSqlExecutor() }),
    },
    {
      proxy: sqliteProxy,
      orm: createSqliteOrmDriver({ executor: sqliteProxy.asSqlExecutor() }),
      migrate: createSqliteMigrationDriver({
        executor: sqliteProxy.asSqlExecutor(),
      }),
    },
    {
      proxy: libsqlProxy,
      orm: createLibsqlOrmDriver({ executor: libsqlProxy.asSqlExecutor() }),
      migrate: createLibsqlMigrationDriver({
        executor: libsqlProxy.asSqlExecutor(),
      }),
    },
  ];

  for (const adapter of adapters) {
    await adapter.orm.query({
      text: "select ? as value",
      params: [1],
    });
    await adapter.orm.execute({
      text: "update users set display_name = ? where id = ?",
      params: ["Ada", "u_1"],
    });
    await adapter.migrate.execute("select 1;");

    assertStats(adapter.proxy, { executes: 3 });
  }
}

async function runMigrationDriverScenario(): Promise<void> {
  const proxy = createFakeDbProxy({ rowCount: 1 });
  const migrator = createMigrator({
    migrations: [bulkMigration],
    store: memoryMigrationStore(),
    driver: proxy.asMigrationDriver(),
  });

  await migrator.up();

  assertStats(proxy, {
    transactions: 1,
    executes: BULK_STATEMENT_COUNT,
  });
}

function assertStats(
  proxy: FakeDbProxy,
  expected: Partial<
    Pick<
      FakeDbProxyStats,
      "queries" | "executes" | "transactions"
    >
  >,
): void {
  const stats = proxy.stats;

  if (
    (expected.queries !== undefined && stats.queries !== expected.queries) ||
    (expected.executes !== undefined &&
      stats.executes !== expected.executes) ||
    (expected.transactions !== undefined &&
      stats.transactions !== expected.transactions)
  ) {
    throw new Error(
      `Unexpected fake DB stats: ${JSON.stringify(stats)}`,
    );
  }
}
