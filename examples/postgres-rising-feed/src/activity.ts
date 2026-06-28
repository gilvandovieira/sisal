/**
 * Recording activity — two ways, because normal PostgreSQL supports both.
 *
 * PRIMARY: {@link recordPostActivity} calls the PostgreSQL function
 * `app.record_post_activity` via a typed `defineFunction` descriptor and
 * `db.call(...).one()` — one parameterized statement, one round trip, with the
 * whole read-modify-write (dedupe the actor, bump the right counter, bump
 * unique_actors only on the actor's first touch, recompute the bucket score)
 * staying atomic and database-local. This matches the Neon example.
 *
 * OPTIONAL: {@link recordPostActivityWithTransaction} does the same work as an
 * **interactive** `db.transaction(...)` using the query builder. Normal
 * PostgreSQL has a regular session, so holding a transaction open across a few
 * statements is fine — unlike the Neon serverless shape the sibling example
 * avoids, and unlike libSQL which has no stored procedures at all and *must*
 * orchestrate in TypeScript. The two recorders produce identical buckets (the
 * integration test asserts this); the function is preferred as the main path.
 *
 * Note: `@sisal/pg` returns `double precision` columns as strings today (see the
 * README and v0.5.0 roadmap item 11), so `activity_score` is `Number(...)`-d at
 * the boundary to honor `RecordedBucket`'s typed `number`.
 *
 * @module
 */

import { and, columns, defineFunction, eq, sql } from "@sisal/orm";
import type { PgDatabase } from "@sisal/pg";
import { postActivityActors, postActivityBuckets } from "./schema.ts";
import { type ActivityKind, bucket5m, bucketActivityScore } from "./rising.ts";

export type { ActivityKind };

/** The bucket row returned after recording (mirror of the table row). */
export interface RecordedBucket {
  readonly post_id: string;
  readonly bucket_start: Date;
  readonly upvotes: number;
  readonly downvotes: number;
  readonly comments: number;
  readonly reports: number;
  readonly unique_actors: number;
  readonly activity_score: number;
}

/**
 * Typed descriptor for
 * `app.record_post_activity(post_id uuid, actor_id uuid, kind text, at
 * timestamptz) RETURNS TABLE (...)`. Arguments are positional and cast from
 * these column types; the result row is typed from `returns`.
 */
const recordActivityFn = defineFunction("app.record_post_activity", {
  args: {
    postId: columns.uuid(),
    actorId: columns.uuid(),
    kind: columns.text(),
    at: columns.timestamp({ withTimezone: true, mode: "date" }),
  },
  returns: {
    post_id: columns.uuid().notNull(),
    bucket_start: columns.timestamp({ withTimezone: true, mode: "date" })
      .notNull(),
    upvotes: columns.integer().notNull(),
    downvotes: columns.integer().notNull(),
    comments: columns.integer().notNull(),
    reports: columns.integer().notNull(),
    unique_actors: columns.integer().notNull(),
    activity_score: columns.doublePrecision().notNull(),
  },
});

const KINDS: readonly ActivityKind[] = [
  "upvote",
  "downvote",
  "comment",
  "report",
];

/**
 * Records one activity event and returns the updated bucket — the PRIMARY path,
 * a single atomic call to `app.record_post_activity`.
 *
 * `at` is the event time; pass it explicitly (it flows into `app.bucket_5m`)
 * so seeding and tests stay deterministic instead of depending on `now()`.
 * Values are bound parameters and cast in SQL — never string-concatenated.
 */
export async function recordPostActivity(
  db: PgDatabase,
  args: {
    readonly postId: string;
    readonly actorId: string;
    readonly kind: ActivityKind;
    readonly at: Date;
  },
): Promise<RecordedBucket> {
  const row = await db.call(recordActivityFn, args).one();
  return { ...row, activity_score: Number(row.activity_score) };
}

/**
 * Records one activity event as an OPTIONAL interactive transaction (acceptable
 * on a normal PostgreSQL session), orchestrated through the query builder. This
 * is the shape the Neon example avoids and the shape libSQL is forced into; it
 * is shown here to make the three-way comparison concrete. Produces the same
 * bucket as {@link recordPostActivity}.
 */
export function recordPostActivityWithTransaction(
  db: PgDatabase,
  args: {
    readonly postId: string;
    readonly actorId: string;
    readonly kind: ActivityKind;
    readonly at: Date;
  },
): Promise<RecordedBucket> {
  if (!KINDS.includes(args.kind)) {
    throw new Error(`invalid activity kind: ${args.kind}`);
  }
  const bucketStart = bucket5m(args.at);
  const now = new Date();
  const up = args.kind === "upvote" ? 1 : 0;
  const down = args.kind === "downvote" ? 1 : 0;
  const com = args.kind === "comment" ? 1 : 0;
  const rep = args.kind === "report" ? 1 : 0;

  return db.transaction(async (tx) => {
    // 1. Record the actor; a returned row means this is the actor's first touch
    //    in this (post, bucket).
    const insertedActor = await tx.insert(postActivityActors)
      .values({
        post_id: args.postId,
        bucket_start: bucketStart,
        actor_id: args.actorId,
        created_at: now,
      })
      .onConflictDoNothing()
      .returning()
      .execute();
    const actorDelta = insertedActor.rows.length > 0 ? 1 : 0;

    // 2. Upsert the bucket. The INSERT path uses the freshly-computed score; the
    //    ON CONFLICT path increments counters and recomputes activity_score from
    //    the post-update values with raw `sql` (column refs resolve to the
    //    existing row; the deltas bind as parameters).
    const b = postActivityBuckets.columns;
    await tx.insert(postActivityBuckets)
      .values({
        post_id: args.postId,
        bucket_start: bucketStart,
        upvotes: up,
        downvotes: down,
        comments: com,
        reports: rep,
        unique_actors: actorDelta,
        activity_score: bucketActivityScore({
          upvotes: up,
          downvotes: down,
          comments: com,
          uniqueActors: actorDelta,
          reports: rep,
        }),
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [b.post_id, b.bucket_start],
        set: {
          upvotes: sql`${b.upvotes} + ${up}`,
          downvotes: sql`${b.downvotes} + ${down}`,
          comments: sql`${b.comments} + ${com}`,
          reports: sql`${b.reports} + ${rep}`,
          unique_actors: sql`${b.unique_actors} + ${actorDelta}`,
          activity_score: sql`
            (${b.upvotes} + ${up}) * 1.0
            + (${b.downvotes} + ${down}) * -0.5
            + (${b.comments} + ${com}) * 3.0
            + (${b.unique_actors} + ${actorDelta}) * 2.0
            + (${b.reports} + ${rep}) * -8.0`,
          updated_at: now,
        },
      })
      .execute();

    // 3. Read the updated bucket back.
    const rows = await tx.select().from(postActivityBuckets)
      .where(and(eq(b.post_id, args.postId), eq(b.bucket_start, bucketStart)))
      .execute();
    const row = rows[0];
    return { ...row, activity_score: Number(row.activity_score) };
  });
}
