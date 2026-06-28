/**
 * Recording activity — orchestrated in TypeScript, because SQLite has no
 * stored procedures.
 *
 * In the Neon sibling this whole read-modify-write is ONE call to the
 * PostgreSQL function `app.record_post_activity`. SQLite/libSQL cannot define
 * such a function, so the same steps run here inside `db.transaction(...)`,
 * which Sisal hands a full builder-capable database. The transaction keeps the
 * three statements atomic:
 *
 *   1. record the actor (ON CONFLICT DO NOTHING) and detect whether this is the
 *      actor's FIRST touch in the bucket (a returned row ⇒ newly inserted);
 *   2. upsert the bucket, incrementing the right counter(s) and recomputing the
 *      bucket's activity_score from the post-update counters (raw `sql`
 *      expressions in `onConflictDoUpdate.set`);
 *   3. read the bucket back.
 *
 * Everything is parameterized — the increments and deltas are bound values, not
 * string-concatenated. `at` is the event time; pass it explicitly so seeding
 * and tests are deterministic.
 *
 * @module
 */

import { and, eq, sql } from "@sisal/orm";
import type { LibsqlDatabase } from "@sisal/libsql";
import { postActivityActors, postActivityBuckets } from "./schema.ts";
import {
  type ActivityKind,
  bucket5mIso,
  bucketActivityScore,
} from "./rising.ts";

export type { ActivityKind };

/** The bucket row returned after recording (mirror of the table row). */
export interface RecordedBucket {
  readonly post_id: string;
  readonly bucket_start: string;
  readonly upvotes: number;
  readonly downvotes: number;
  readonly comments: number;
  readonly reports: number;
  readonly unique_actors: number;
  readonly activity_score: number;
}

const KINDS: readonly ActivityKind[] = [
  "upvote",
  "downvote",
  "comment",
  "report",
];

/**
 * Records one activity event and returns the updated bucket.
 *
 * Atomic via `db.transaction(...)`. Throws on an unknown `kind`.
 */
export function recordPostActivity(
  db: LibsqlDatabase,
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
  const bucketStart = bucket5mIso(args.at);
  const nowIso = new Date().toISOString();
  const up = args.kind === "upvote" ? 1 : 0;
  const down = args.kind === "downvote" ? 1 : 0;
  const com = args.kind === "comment" ? 1 : 0;
  const rep = args.kind === "report" ? 1 : 0;

  return db.transaction(async (tx) => {
    // 1. Record the actor; a returned row means this insert actually happened,
    //    i.e. the actor's first touch in this (post, bucket).
    const insertedActor = await tx.insert(postActivityActors)
      .values({
        post_id: args.postId,
        bucket_start: bucketStart,
        actor_id: args.actorId,
        created_at: nowIso,
      })
      .onConflictDoNothing()
      .returning()
      .execute();
    const actorDelta = insertedActor.rows.length > 0 ? 1 : 0;

    // 2. Upsert the bucket. INSERT path uses the freshly-computed score; the
    //    ON CONFLICT path increments counters and recomputes activity_score
    //    from the post-update values with raw `sql` (column refs resolve to the
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
        created_at: nowIso,
        updated_at: nowIso,
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
          updated_at: nowIso,
        },
      })
      .execute();

    // 3. Read the updated bucket back.
    const rows = await tx.select().from(postActivityBuckets)
      .where(and(
        eq(b.post_id, args.postId),
        eq(b.bucket_start, bucketStart),
      ))
      .execute();
    return rows[0] as RecordedBucket;
  });
}
