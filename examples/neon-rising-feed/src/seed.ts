/**
 * Deterministic seed data: 24 posts + crafted activity, all pinned to DEMO_NOW.
 *
 * The dataset is designed so `/new` and `/rising` clearly diverge, and so each
 * product behavior is provable:
 *
 *   1. a brand-new post with fresh activity ranks high in /rising;
 *   2. an old post with many OLD votes but no recent activity does NOT;
 *   3. a post with many comments in the last 15m ranks high (comments weigh 3);
 *   4. a post with steady activity over the last hour ranks moderately;
 *   5. a post with a report spike is penalized (reports weigh -8);
 *   6. a post with many UNIQUE actors beats one with repeat activity from one
 *      actor (unique_actors weigh +2, and repeats don't re-count).
 *
 * Determinism: every timestamp is derived from a fixed `DEMO_NOW`, never the
 * wall clock, and the rising score is recomputed at that same `DEMO_NOW`. Actor
 * UUIDs are random for the "distinct" case (scores depend on COUNTS and dedup,
 * not on the UUID values) and stable for the "same actor repeated" case.
 *
 * Activity is recorded through the live `app.record_post_activity` function —
 * one call per event — so seeding exercises the same atomic recorder the demo
 * and tests use. Counts are kept modest to keep the seed quick over Neon HTTP.
 *
 * @module
 */

import { raw } from "@sisal/orm";
import type { NeonDatabase } from "@sisal/neon";
import { posts } from "./schema.ts";
import { type ActivityKind, recordPostActivity } from "./activity.ts";
import { recomputeAllRisingScores } from "./recompute.ts";
import type { TimeInput } from "./rising.ts";

/** Fixed reference time for the whole demo; nothing here reads the wall clock. */
export const DEMO_NOW = Temporal.Instant.from("2026-06-28T12:00:00Z");

/** Key of the low-ranked post the demo boosts to show a /rising reorder. */
export const DEMO_TARGET_KEY = "sleeper";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** "distinct" = a fresh actor per event; any other string = a stable actor. */
type Actor = "distinct" | string;

interface ActivityEvent {
  readonly kind: ActivityKind;
  /** Minutes before DEMO_NOW the event happened (picks the 5-minute bucket). */
  readonly minutesAgo: number;
  readonly count: number;
  /** Defaults to "distinct". */
  readonly actor?: Actor;
}

interface PostSpec {
  readonly key: string;
  readonly title: string;
  readonly body: string | null;
  /** Hours before DEMO_NOW the post was created. */
  readonly hoursAgo: number;
  readonly activity: readonly ActivityEvent[];
}

const POST_SPECS: readonly PostSpec[] = [
  // 1. Brand-new post, fresh burst: should top /rising.
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
  // 3. Comment storm in the last 15m: comments weigh 3, so this ranks high.
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
  // 6a. Many unique actors: breadth is rewarded (+2 per unique actor).
  {
    key: "diverse",
    title: "Ten people independently found this useful",
    body: null,
    hoursAgo: 0.8,
    activity: [
      { kind: "upvote", minutesAgo: 5, count: 10 }, // 10 distinct actors
    ],
  },
  // 4. Steady activity across the last hour: moderate /rising rank.
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
  // 6b. Same actor repeated: 10 upvotes but only ONE unique actor → loses to
  //     `diverse` even though raw upvote count is identical.
  {
    key: "spammy",
    title: "One very enthusiastic fan keeps clicking",
    body: "Vote brigading, sort of.",
    hoursAgo: 0.9,
    activity: [
      { kind: "upvote", minutesAgo: 5, count: 10, actor: "fan" },
    ],
  },
  // 5. Report spike: penalized hard (-8 each), drops below the > 0 cutoff.
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
  // 2. Old popular: lots of activity, but all > 2h ago → outside every window,
  //    so it does NOT rise (it would still rank on a /hot feed).
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
  // The demo's reorder target: present but low, until the demo boosts it.
  {
    key: DEMO_TARGET_KEY,
    title: "A quiet post about to catch fire",
    body: "Watch this climb.",
    hoursAgo: 0.5,
    activity: [
      { kind: "upvote", minutesAgo: 10, count: 2 },
    ],
  },
  // 16 filler posts: varied recency + light activity so both feeds have spread.
  ...buildFillers(),
];

function buildFillers(): PostSpec[] {
  const titles = [
    "Notes on keyset pagination",
    "Why we picked Deno",
    "Postgres window functions, explained",
    "Our serverless cost breakdown",
    "Migrating off a heavy ORM",
    "A field guide to time buckets",
    "Debugging a slow feed query",
    "The case for boring databases",
    "Edge functions in practice",
    "What 'rising' really measures",
    "Cursor vs offset, one more time",
    "Designing for eventual recompute",
    "A small SQL function library",
    "Read replicas without tears",
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

/**
 * Wipes and reinserts the example data, then recomputes rising scores at `now`.
 * Returns the seeded posts (with ids) so callers can reference specific posts.
 */
export async function seed(
  db: NeonDatabase,
  now: TimeInput = DEMO_NOW,
): Promise<SeededPost[]> {
  // Idempotent reseed: children first (FK), then posts.
  await db.execute(raw("delete from post_activity_actors"));
  await db.execute(raw("delete from post_activity_buckets"));
  await db.execute(raw("delete from posts"));

  const nowMs = now instanceof Date ? now.getTime() : now.epochMilliseconds;
  const instantAt = (msAgo: number) =>
    Temporal.Instant.fromEpochMilliseconds(nowMs - msAgo);

  const seeded: SeededPost[] = [];
  const postRows = POST_SPECS.map((spec) => {
    const id = crypto.randomUUID();
    seeded.push({ key: spec.key, id, title: spec.title });
    return {
      id,
      title: spec.title,
      body: spec.body,
      // Nullable + no default ⇒ Sisal requires it on insert; pass null.
      rising_score_updated_at: null,
      created_at: instantAt(spec.hoursAgo * HOUR_MS),
    };
  });
  await db.insert(posts).values(postRows).execute();

  // Record activity event-by-event through app.record_post_activity. Stable
  // actors share one UUID per (post, actor key); "distinct" gets a fresh UUID.
  for (let i = 0; i < POST_SPECS.length; i += 1) {
    const spec = POST_SPECS[i];
    const postId = seeded[i].id;
    const stableActors = new Map<string, string>();
    for (const event of spec.activity) {
      const at = instantAt(event.minutesAgo * MINUTE_MS);
      for (let n = 0; n < event.count; n += 1) {
        const actorId = resolveActor(event.actor, stableActors);
        await recordPostActivity(db, {
          postId,
          actorId,
          kind: event.kind,
          at,
        });
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
        `${DEMO_NOW.toString()}.`,
    );
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main();
}
