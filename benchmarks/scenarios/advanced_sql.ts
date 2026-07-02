/**
 * Render-throughput baselines for the v0.8 wave-3/4 constructs — windows,
 * `dateDiff`, `coalesce`/`greatest`, recursive CTEs, and core statement
 * assembly — so future IR refactors have before/after numbers for the new
 * surface, not just the v0.7-era constructs.
 */
import {
  asc,
  assembleInsertFromSelect,
  avg,
  coalesce,
  columns,
  count,
  createDatabase,
  dateDiff,
  dateTrunc,
  defineTable,
  desc,
  eq,
  excluded,
  filter,
  greatest,
  lag,
  lt,
  now,
  over,
  rank,
  renderSql,
  sql,
} from "@sisal/orm";
import type { BenchmarkScenario } from "../harness.ts";

const db = createDatabase({ dialect: "postgres" });

const events = defineTable("events", {
  id: columns.integer().primaryKey(),
  postId: columns.integer().notNull(),
  kind: columns.text().notNull(),
  occurredAt: columns.timestamp().optional(),
});
const stats = defineTable("event_stats", {
  postId: columns.integer().primaryKey(),
  views: columns.integer().notNull(),
});
const e = events.columns;

export const advancedSqlScenarios: readonly BenchmarkScenario[] = [
  {
    group: "advanced sql render",
    name: "window: over + rank + lag + rows frame",
    fn: () => {
      renderSql(
        db.select({
          pos: over(rank(), { orderBy: [desc(e.id)] }),
          prev: over(lag<number>(e.id), {
            partitionBy: [e.postId],
            orderBy: [asc(e.id)],
          }),
          moving: over(avg(e.id), {
            partitionBy: [e.postId],
            orderBy: [asc(e.id)],
            frame: { unit: "rows", start: { preceding: 5 }, end: "currentRow" },
          }),
        }).from(events).toSql(),
        { dialect: "postgres" },
      );
    },
  },
  {
    group: "advanced sql render",
    name: "expressions: coalesce + greatest + dateDiff",
    fn: () => {
      renderSql(
        db.select({
          score: coalesce<number>(e.id, 0),
          capped: greatest<number>(e.id, 10),
          age: dateDiff("minutes", e.occurredAt, now()),
        }).from(events).toSql(),
        { dialect: "mysql" },
      );
    },
  },
  {
    group: "advanced sql render",
    name: "recursive CTE: base + step + depth guard",
    fn: () => {
      const tree = db.$withRecursive("tree", ["id", "depth"]).as((self) =>
        db.select({ id: e.id, depth: sql`1` }).from(events)
          .where(eq(e.id, 1))
          .unionAll(
            db.select({ id: e.id, depth: sql`${self.depth} + 1` }).from(self)
              .where(lt(self.depth, 5)),
          )
      );
      renderSql(
        db.with(tree).select({ id: tree.id }).from(tree).toSql(),
        { dialect: "postgres" },
      );
    },
  },
  {
    group: "advanced sql render",
    name: "assembly: insert-from-select + upsert",
    fn: () => {
      const bucket = dateTrunc("hour", e.occurredAt);
      renderSql(
        assembleInsertFromSelect({
          into: stats,
          select: {
            select: {
              postId: e.postId,
              views: filter(count(), eq(e.kind, "view")),
            },
            from: events,
            groupBy: [e.postId, bucket],
          },
          onConflictDoUpdate: {
            target: [stats.columns.postId],
            set: { views: excluded(stats.columns.views) },
          },
        }),
        { dialect: "postgres" },
      );
    },
  },
];
