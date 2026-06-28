/**
 * Network-free unit tests: the hot-score model and the SQL statement splitter.
 *
 * These run with only `--allow-read` and never touch a database. The
 * database-backed behavior (vote_post create/switch/remove, score consistency,
 * hot ordering, pagination) is covered by the gated suite in feed_db_test.ts.
 *
 * @module
 */

import { assertAlmostEquals, assertEquals } from "@std/assert";
import { createDatabase } from "@sisal/orm";

import {
  calculateHotScore,
  HOT_DECAY_SECONDS,
  HOT_EPOCH_SECONDS,
} from "./src/hot.ts";
import { splitSqlStatements } from "./src/sql_split.ts";
import { getHotFeed, getNewFeed } from "./src/queries.ts";
import type { NeonDatabase } from "./src/db.ts";

const EPOCH = new Date(HOT_EPOCH_SECONDS * 1000);

Deno.test("calculateHotScore: sign follows the score", () => {
  // At the epoch the age component is 0, so hot == sign * order.
  assertAlmostEquals(calculateHotScore(0, EPOCH), 0);
  assertAlmostEquals(calculateHotScore(10, EPOCH), 1); // +log10(10)
  assertAlmostEquals(calculateHotScore(-10, EPOCH), -1); // -log10(10)
  assertAlmostEquals(calculateHotScore(1, EPOCH), 0); // log10(1) == 0
  assertAlmostEquals(calculateHotScore(5, EPOCH), Math.log10(5));
});

Deno.test("calculateHotScore: age component grows by 1 per decay window", () => {
  const oneWindowLater = new Date(
    (HOT_EPOCH_SECONDS + HOT_DECAY_SECONDS) * 1000,
  );
  assertAlmostEquals(calculateHotScore(0, oneWindowLater), 1);
  assertAlmostEquals(calculateHotScore(10, oneWindowLater), 2); // sign*order + 1
});

Deno.test("calculateHotScore: monotonic in votes and in recency", () => {
  const t = new Date("2026-01-01T00:00:00Z");
  // More upvotes => higher score at the same time.
  if (!(calculateHotScore(100, t) > calculateHotScore(10, t))) {
    throw new Error("expected more votes to rank higher");
  }
  // Newer beats older at the same score.
  const older = new Date("2025-12-01T00:00:00Z");
  if (!(calculateHotScore(10, t) > calculateHotScore(10, older))) {
    throw new Error("expected newer post to rank higher");
  }
});

Deno.test("splitSqlStatements: splits top-level statements", () => {
  assertEquals(splitSqlStatements("select 1; select 2;"), [
    "select 1",
    "select 2",
  ]);
});

Deno.test("splitSqlStatements: keeps a $$ function body as one statement", () => {
  const fn = [
    "create function f() returns int language plpgsql as $$",
    "begin",
    "  perform 1;",
    "  return 2;",
    "end;",
    "$$;",
  ].join("\n");
  const statements = splitSqlStatements(`create schema app;\n${fn}`);
  assertEquals(statements.length, 2);
  // The function body's internal semicolons did not split it.
  if (!statements[1].includes("return 2;")) {
    throw new Error("function body was split");
  }
});

Deno.test("splitSqlStatements: ignores ; in comments and strings", () => {
  assertEquals(
    splitSqlStatements("select 1; /* a; b */ select 2;").length,
    2,
  );
  assertEquals(
    splitSqlStatements("insert into t values ('a;b'); select 1;").length,
    2,
  );
  // A line comment containing a semicolon does not create a new statement.
  assertEquals(
    splitSqlStatements("select 1 -- c; d\n; select 2;").length,
    2,
  );
});

Deno.test("feeds build and render without a database (postgres noop)", async () => {
  // A driverless postgres database returns empty rows; this exercises the
  // builder (new feed) and the raw sql template (hot feed) end to end.
  const db = createDatabase({ dialect: "postgres" }) as unknown as NeonDatabase;

  const newFeed = await getNewFeed(db, 10);
  assertEquals(newFeed.posts, []);
  assertEquals(newFeed.nextCursor, undefined);

  const hotFeed = await getHotFeed(db, 10, {
    hotScore: 1.5,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    id: "00000000-0000-0000-0000-000000000000",
  });
  assertEquals(hotFeed.posts, []);
});
