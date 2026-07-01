/**
 * Deterministic seed: 8 behavioral categories × 3 posts = 24 posts, each with
 * raw `post_events` over the last 6 hours.
 *
 * The seed inserts POSTS and raw EVENTS only — buckets, stats, and rollups are
 * COMPUTED from the events by the SQL functions (that is the whole point). Every
 * timestamp derives from a fixed {@link DEMO_NOW}; post ids are deterministic
 * (`"1"`..`"24"`, bigint→string), so a test can address "a fast-spike post".
 *
 * Each category has an hourly profile over the 6 hours ending at the current
 * hour (`date_trunc('hour', DEMO_NOW)`); the three posts in a category share it
 * scaled by ~±15 %, so their vectors cluster.
 *
 * @module
 */

import type { InferInsert } from "@sisal/orm";
import type { NeonDatabase } from "./db.ts";
import { openDb } from "./db.ts";
import { posts } from "./schema.ts";
import { type RawEvent, recordEvents } from "./events.ts";

/** The fixed reference time. Off the hour boundary so the current hour bucket
 * (12:00) has room for events at 12:15 that are still <= DEMO_NOW. */
export const DEMO_NOW = new Date("2026-06-28T12:30:00.000Z");

/** Counts for one hour of a category's profile. */
interface HourCounts {
  readonly votes: number;
  readonly comments: number;
  readonly reports: number;
  readonly actors: number;
}

/** A behavioral category and its 6-hour profile (index 5 = current hour). */
interface Category {
  readonly key: string;
  readonly title: string;
  readonly createdMinutesAgo: number;
  readonly hotScore: number;
  readonly risingScore: number;
  /** Exactly 6 hours, oldest first; index 5 is the current hour. */
  readonly hours: readonly HourCounts[];
}

const Z: HourCounts = { votes: 0, comments: 0, reports: 0, actors: 0 };

/** The eight categories, in a fixed order (index drives the deterministic id). */
export const CATEGORIES: readonly Category[] = [
  {
    key: "fast_spike",
    title: "Fast spike",
    createdMinutesAgo: 300,
    hotScore: 20,
    risingScore: 80,
    hours: [
      Z,
      { votes: 1, comments: 0, reports: 0, actors: 1 },
      { votes: 2, comments: 1, reports: 0, actors: 2 },
      { votes: 4, comments: 1, reports: 0, actors: 3 },
      { votes: 9, comments: 3, reports: 0, actors: 6 },
      { votes: 40, comments: 12, reports: 0, actors: 28 },
    ],
  },
  {
    key: "slow_burner",
    title: "Slow burner",
    createdMinutesAgo: 400,
    hotScore: 12,
    risingScore: 10,
    hours: Array.from({ length: 6 }, () => ({
      votes: 6,
      comments: 3,
      reports: 0,
      actors: 5,
    })),
  },
  {
    key: "comment_heavy",
    title: "Comment-heavy discussion",
    createdMinutesAgo: 300,
    hotScore: 10,
    risingScore: 12,
    hours: [
      { votes: 2, comments: 14, reports: 0, actors: 8 },
      { votes: 2, comments: 15, reports: 0, actors: 8 },
      { votes: 3, comments: 16, reports: 0, actors: 9 },
      { votes: 3, comments: 17, reports: 0, actors: 9 },
      { votes: 3, comments: 18, reports: 0, actors: 10 },
      { votes: 3, comments: 20, reports: 0, actors: 10 },
    ],
  },
  {
    key: "vote_heavy",
    title: "Vote-heavy meme",
    createdMinutesAgo: 300,
    hotScore: 16,
    risingScore: 18,
    hours: [
      { votes: 20, comments: 1, reports: 0, actors: 16 },
      { votes: 24, comments: 1, reports: 0, actors: 18 },
      { votes: 28, comments: 1, reports: 0, actors: 20 },
      { votes: 30, comments: 1, reports: 0, actors: 24 },
      { votes: 35, comments: 0, reports: 0, actors: 28 },
      { votes: 40, comments: 1, reports: 0, actors: 30 },
    ],
  },
  {
    key: "report_heavy",
    title: "Report-heavy risky post",
    createdMinutesAgo: 240,
    hotScore: 4,
    risingScore: 2,
    hours: [
      { votes: 5, comments: 2, reports: 6, actors: 5 },
      { votes: 5, comments: 1, reports: 7, actors: 5 },
      { votes: 6, comments: 2, reports: 8, actors: 6 },
      { votes: 6, comments: 2, reports: 9, actors: 6 },
      { votes: 5, comments: 1, reports: 9, actors: 5 },
      { votes: 6, comments: 2, reports: 10, actors: 6 },
    ],
  },
  {
    key: "old_famous",
    title: "Old famous post",
    createdMinutesAgo: 7200,
    hotScore: 95,
    risingScore: 2,
    hours: [Z, Z, Z, Z, Z, { votes: 1, comments: 0, reports: 0, actors: 1 }],
  },
  {
    key: "dead",
    title: "Dead post",
    createdMinutesAgo: 900,
    hotScore: 2,
    risingScore: 0,
    hours: [Z, Z, Z, Z, Z, Z],
  },
  {
    key: "fresh_new",
    title: "Fresh new post",
    createdMinutesAgo: 20,
    hotScore: 1,
    risingScore: 4,
    hours: [Z, Z, Z, Z, Z, { votes: 4, comments: 1, reports: 0, actors: 3 }],
  },
];

const POSTS_PER_CATEGORY = 3;
const POST_SCALES = [0.85, 1.0, 1.15] as const;

/** The current-hour boundary the windows align to. */
function currentHour(): Date {
  const d = new Date(DEMO_NOW);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** Deterministic post id (bigint as a string): "1".."24". */
export function postId(categoryIndex: number, index: number): string {
  return String(categoryIndex * POSTS_PER_CATEGORY + index + 1);
}

/** The representative (scale 1.0) post id for a category key, for demos/tests. */
export function representativePostId(categoryKey: string): string {
  const categoryIndex = CATEGORIES.findIndex((c) => c.key === categoryKey);
  if (categoryIndex < 0) {
    throw new Error(`representativePostId: unknown category '${categoryKey}'`);
  }
  return postId(categoryIndex, 1);
}

/** A seeded post, with its category so demo/tests can group results. */
export interface SeededPost {
  readonly id: string;
  readonly title: string;
  readonly category: string;
}

function scale(value: number, factor: number): number {
  return Math.round(value * factor);
}

/**
 * Emits the raw events for one (post, hour). A single actor counter cycles the
 * per-hour actor pool across all event types, so `count(distinct actor_id)` for
 * the hour equals `actors` (the profiles keep `max(counts) >= actors`).
 */
function eventsForHour(
  postIdValue: string,
  hourStart: Date,
  counts: HourCounts,
  actorBase: number,
): RawEvent[] {
  const total = counts.votes + counts.comments + counts.reports;
  if (total === 0) return [];
  // Place events 15 minutes into the hour: inside the bucket and <= DEMO_NOW.
  const at = new Date(hourStart.getTime() + 15 * 60_000);
  const events: RawEvent[] = [];
  let k = 0;
  const pool = Math.max(1, counts.actors);
  const emit = (eventType: RawEvent["event_type"], n: number) => {
    for (let i = 0; i < n; i += 1) {
      events.push({
        post_id: postIdValue,
        actor_id: String(actorBase + (k % pool)),
        event_type: eventType,
        created_at: at,
      });
      k += 1;
    }
  };
  emit("vote", counts.votes);
  emit("comment", counts.comments);
  emit("report", counts.reports);
  return events;
}

/**
 * Inserts the deterministic posts and their raw events. Returns the seeded posts
 * (id + category). Buckets/stats/rollups are computed downstream from these
 * events.
 */
export async function seed(db: NeonDatabase): Promise<SeededPost[]> {
  const base = currentHour();
  const postRows: Array<InferInsert<typeof posts>> = [];
  const events: RawEvent[] = [];
  const seeded: SeededPost[] = [];

  CATEGORIES.forEach((category, categoryIndex) => {
    for (let index = 0; index < POSTS_PER_CATEGORY; index += 1) {
      const id = postId(categoryIndex, index);
      const factor = POST_SCALES[index];
      const title = `${category.title} #${index + 1}`;
      const createdAt = new Date(
        DEMO_NOW.getTime() - category.createdMinutesAgo * 60_000,
      );

      postRows.push({
        id,
        title,
        body: `Seed post in the '${category.key}' behavioral category.`,
        status: "published",
        hot_score: category.hotScore,
        rising_score: category.risingScore,
        created_at: createdAt,
        updated_at: DEMO_NOW,
      });
      seeded.push({ id, title, category: category.key });

      category.hours.forEach((hour, hourIndex) => {
        const counts: HourCounts = {
          votes: scale(hour.votes, factor),
          comments: scale(hour.comments, factor),
          reports: scale(hour.reports, factor),
          actors: scale(hour.actors, factor),
        };
        // hourIndex 5 = current hour; index 0 = 5 hours earlier.
        const hourStart = new Date(
          base.getTime() - (5 - hourIndex) * 3600_000,
        );
        const actorBase = Number(id) * 100_000 + hourIndex * 1_000;
        events.push(...eventsForHour(id, hourStart, counts, actorBase));
      });
    }
  });

  // Explicit ids into a bigserial column are accepted; the builder serializes
  // each list into one statement.
  await db.insert(posts).values(postRows).execute();
  const inserted = await recordEvents(db, events);

  console.log(`seeded ${seeded.length} posts and ${inserted} raw events.`);
  return seeded;
}

async function main(): Promise<void> {
  const db = await openDb();
  try {
    await seed(db);
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main();
}
