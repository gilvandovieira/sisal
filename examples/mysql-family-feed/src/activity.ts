/**
 * Recording activity on MySQL/MariaDB.
 *
 * MySQL proper cannot use `INSERT ... RETURNING` to tell us whether the actor
 * row was newly inserted. This path pre-checks the actor row, then uses the
 * mutation `rowCount` from `onConflictDoNothing()` on the insert path. The live
 * tests prove rowCount alone is not enough with Sisal's portable MySQL no-op
 * upsert rendering, which is a real pressure point for v0.8/v0.9.
 *
 * @module
 */

import { and, eq, sql } from "@sisal/orm";
import type { MysqlDatabase } from "@sisal/mysql";
import { postActivityActors, postActivityBuckets } from "./schema.ts";
import {
  type ActivityKind,
  bucket5mMysql,
  bucketActivityScore,
  mysqlTimestamp,
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

/** Records one activity event and returns the updated bucket. */
export function recordPostActivity(
  db: MysqlDatabase,
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
  const bucketStart = bucket5mMysql(args.at);
  const now = mysqlTimestamp(new Date());
  const up = args.kind === "upvote" ? 1 : 0;
  const down = args.kind === "downvote" ? 1 : 0;
  const com = args.kind === "comment" ? 1 : 0;
  const rep = args.kind === "report" ? 1 : 0;

  return db.transaction(async (tx) => {
    const a = postActivityActors.columns;
    const existingActor = await tx.select({ actor_id: a.actor_id })
      .from(postActivityActors)
      .where(and(
        eq(a.post_id, args.postId),
        eq(a.bucket_start, bucketStart),
        eq(a.actor_id, args.actorId),
      ))
      .limit(1)
      .execute();
    let actorDelta = 0;
    if (existingActor.length === 0) {
      const insertedActor = await tx.insert(postActivityActors)
        .values({
          post_id: args.postId,
          bucket_start: bucketStart,
          actor_id: args.actorId,
          created_at: now,
        })
        .onConflictDoNothing({
          target: [
            postActivityActors.columns.post_id,
            postActivityActors.columns.bucket_start,
            postActivityActors.columns.actor_id,
          ],
        })
        .execute();
      actorDelta = Number(insertedActor.rowCount ?? 0) > 0 ? 1 : 0;
    }

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
          activity_score: sql`
            (${b.upvotes} + ${up}) * 1.0
            + (${b.downvotes} + ${down}) * -0.5
            + (${b.comments} + ${com}) * 3.0
            + (${b.unique_actors} + ${actorDelta}) * 2.0
            + (${b.reports} + ${rep}) * -8.0`,
          upvotes: sql`${b.upvotes} + ${up}`,
          downvotes: sql`${b.downvotes} + ${down}`,
          comments: sql`${b.comments} + ${com}`,
          reports: sql`${b.reports} + ${rep}`,
          unique_actors: sql`${b.unique_actors} + ${actorDelta}`,
          updated_at: now,
        },
      })
      .execute();

    const rows = await tx.select().from(postActivityBuckets)
      .where(and(
        eq(b.post_id, args.postId),
        eq(b.bucket_start, bucketStart),
      ))
      .execute();
    const row = rows[0];
    return {
      ...row,
      upvotes: Number(row.upvotes),
      downvotes: Number(row.downvotes),
      comments: Number(row.comments),
      reports: Number(row.reports),
      unique_actors: Number(row.unique_actors),
      activity_score: Number(row.activity_score),
    };
  });
}
