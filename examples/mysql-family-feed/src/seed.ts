/**
 * Deterministic seed data: 24 posts + crafted activity, all pinned to DEMO_NOW.
 *
 * Same dataset and goals as the sibling rising-feed examples, but with
 * MySQL-safe DATETIME strings and the MySQL-family activity recorder.
 *
 * @module
 */

import { raw } from "@sisal/orm";
import type { MysqlDatabase } from "@sisal/mysql";
import { posts } from "./schema.ts";
import { type ActivityKind, recordPostActivity } from "./activity.ts";
import { recomputeAllRisingScores } from "./recompute.ts";
import { mysqlTimestamp } from "./rising.ts";

/** Fixed reference time for the whole demo; nothing here reads the wall clock. */
export const DEMO_NOW = new Date("2026-06-28T12:00:00.000Z");

/** Key of the low-ranked post the demo boosts to show a /rising reorder. */
export const DEMO_TARGET_KEY = "sleeper";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** "distinct" = a fresh actor per event; any other string = a stable actor. */
type Actor = "distinct" | string;

interface ActivityEvent {
  readonly kind: ActivityKind;
  readonly minutesAgo: number;
  readonly count: number;
  readonly actor?: Actor;
}

interface PostSpec {
  readonly key: string;
  readonly title: string;
  readonly body: string | null;
  readonly hoursAgo: number;
  readonly activity: readonly ActivityEvent[];
}

const POST_SPECS: readonly PostSpec[] = [
  {
    key: "fresh-burst",
    title: "Show: a tiny moving-average ranker in 80 lines",
    body: "Buckets + windows.",
    hoursAgo: 0.2,
    activity: [
      { kind: "upvote", minutesAgo: 2, count: 10 },
      { kind: "comment", minutesAgo: 3, count: 3 },
    ],
  },
  {
    key: "comment-storm",
    title: "Hot take: stored procedures are good, actually",
    body: "Spicy thread.",
    hoursAgo: 1.5,
    activity: [
      { kind: "comment", minutesAgo: 4, count: 9 },
      { kind: "upvote", minutesAgo: 6, count: 2 },
    ],
  },
  {
    key: "diverse",
    title: "Ten people independently found this useful",
    body: null,
    hoursAgo: 0.8,
    activity: [
      { kind: "upvote", minutesAgo: 5, count: 10 },
    ],
  },
  {
    key: "steady",
    title: "A long, even-paced discussion about indexes",
    body: null,
    hoursAgo: 2,
    activity: [
      { kind: "upvote", minutesAgo: 55, count: 2 },
      { kind: "upvote", minutesAgo: 45, count: 2 },
      { kind: "upvote", minutesAgo: 35, count: 2 },
      { kind: "upvote", minutesAgo: 25, count: 2 },
      { kind: "upvote", minutesAgo: 12, count: 2 },
    ],
  },
  {
    key: "spammy",
    title: "One very enthusiastic fan keeps clicking",
    body: "Vote brigading, sort of.",
    hoursAgo: 0.9,
    activity: [
      { kind: "upvote", minutesAgo: 5, count: 10, actor: "fan" },
    ],
  },
  {
    key: "reported",
    title: "Suspicious post getting flagged",
    body: null,
    hoursAgo: 0.6,
    activity: [
      { kind: "upvote", minutesAgo: 3, count: 6 },
      { kind: "report", minutesAgo: 4, count: 5 },
    ],
  },
  {
    key: "old-popular",
    title: "This was huge three hours ago",
    body: "Yesterday's news.",
    hoursAgo: 4,
    activity: [
      { kind: "upvote", minutesAgo: 200, count: 18 },
      { kind: "comment", minutesAgo: 205, count: 6 },
    ],
  },
  {
    key: DEMO_TARGET_KEY,
    title: "A quiet post about to catch fire",
    body: "Watch this climb.",
    hoursAgo: 0.5,
    activity: [
      { kind: "upvote", minutesAgo: 10, count: 2 },
    ],
  },
  ...buildFillers(),
];

function buildFillers(): PostSpec[] {
  const titles = [
    "Notes on keyset pagination",
    "Why we picked Deno",
    "SQLite window functions, explained",
    "Our serverless cost breakdown",
    "Migrating off a heavy ORM",
    "A field guide to time buckets",
    "Debugging a slow feed query",
    "The case for boring databases",
    "Edge functions in practice",
    "What rising really measures",
    "Cursor vs offset, one more time",
    "Designing for eventual recompute",
    "A small TypeScript scoring library",
    "Embedded replicas without tears",
    "Trend detection on a budget",
    "When to denormalize a feed",
  ];
  return titles.map((title, i) => ({
    key: `filler-${i}`,
    title,
    body: i % 3 === 0 ? null : "Filler content.",
    hoursAgo: 1 + i * 0.8,
    activity: i % 2 === 0
      ? [{ kind: "upvote" as const, minutesAgo: 8 + i, count: 1 + (i % 3) }]
      : [],
  }));
}

/** One seeded post the demo/tests can refer back to. */
export interface SeededPost {
  readonly key: string;
  readonly id: string;
  readonly title: string;
}

/** Wipes and reinserts the example data, then recomputes rising scores. */
export async function seed(
  db: MysqlDatabase,
  now: Date = DEMO_NOW,
): Promise<SeededPost[]> {
  await db.execute(raw("delete from post_activity_actors"));
  await db.execute(raw("delete from post_activity_buckets"));
  await db.execute(raw("delete from posts"));

  const seeded: SeededPost[] = [];
  const postRows = POST_SPECS.map((spec) => {
    const id = crypto.randomUUID();
    seeded.push({ key: spec.key, id, title: spec.title });
    const createdAt = new Date(now.getTime() - spec.hoursAgo * HOUR_MS);
    return {
      id,
      title: spec.title,
      body: spec.body,
      rising_score_updated_at: null,
      created_at: mysqlTimestamp(createdAt),
      updated_at: mysqlTimestamp(createdAt),
    };
  });
  await db.insert(posts).values(postRows).execute();

  for (let i = 0; i < POST_SPECS.length; i += 1) {
    const spec = POST_SPECS[i];
    const postId = seeded[i].id;
    const stableActors = new Map<string, string>();
    for (const event of spec.activity) {
      const at = new Date(now.getTime() - event.minutesAgo * MINUTE_MS);
      for (let n = 0; n < event.count; n += 1) {
        const actorId = resolveActor(event.actor, stableActors);
        await recordPostActivity(db, { postId, actorId, kind: event.kind, at });
      }
    }
  }

  await recomputeAllRisingScores(db, now);
  return seeded;
}

function resolveActor(
  actor: Actor | undefined,
  stable: Map<string, string>,
): string {
  if (actor === undefined || actor === "distinct") {
    return crypto.randomUUID();
  }
  const existing = stable.get(actor);
  if (existing !== undefined) return existing;
  const id = crypto.randomUUID();
  stable.set(actor, id);
  return id;
}

async function main(): Promise<void> {
  const { openDb } = await import("./db.ts");
  const db = await openDb();
  try {
    const seeded = await seed(db);
    console.log(
      `seeded ${seeded.length} posts + activity, recomputed at ` +
        `${mysqlTimestamp(DEMO_NOW)}.`,
    );
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main();
}
