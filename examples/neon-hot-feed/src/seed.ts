/**
 * Seed data: ~24 posts across an ~18h window, plus votes from fake users.
 *
 * The dataset is crafted so `/new` and `/hot` clearly diverge:
 * - recent posts with strong votes rise to the top of `/hot`;
 * - older posts with many votes still rank well on `/hot` (but are buried in
 *   `/new`);
 * - downvoted posts sink below even unvoted ones;
 * - the freshest posts lead `/new` regardless of votes.
 *
 * Posts are inserted with the Sisal builder. Votes are inserted in bulk with
 * the builder too, then the post aggregates and the stored hot_score are
 * recomputed with one raw SQL statement (a data-modifying UPDATE ... FROM that
 * calls app.calculate_hot_score). That keeps seeding fast and consistent; the
 * per-vote app.vote_post function is exercised live by the demo and the tests.
 *
 * @module
 */

import { raw } from "@sisal/orm";
import type { NeonDatabase } from "@sisal/neon";
import { posts, postVotes } from "./schema.ts";

/** One seeded post the demo/tests can refer back to. */
export interface SeededPost {
  readonly id: string;
  readonly title: string;
  readonly hoursAgo: number;
  readonly up: number;
  readonly down: number;
}

interface PostSpec {
  readonly title: string;
  readonly body: string | null;
  readonly hoursAgo: number;
  readonly up: number;
  readonly down: number;
}

const HOUR_MS = 60 * 60 * 1000;

/** Title of the post the demo upvotes to show the hot feed reorder. */
export const RISING_POST_TITLE = "Vote dedup with ON CONFLICT";

const POST_SPECS: readonly PostSpec[] = [
  {
    title: "Show HN: I built a tiny Deno ORM",
    body: "Driverless, JSR-only.",
    hoursAgo: 1.0,
    up: 58,
    down: 3,
  },
  {
    title: "Postgres is underrated for analytics",
    body: null,
    hoursAgo: 13,
    up: 142,
    down: 6,
  },
  {
    title: "Ask: how do you structure serverless DB access?",
    body: "Pooled vs direct?",
    hoursAgo: 0.2,
    up: 4,
    down: 0,
  },
  {
    title: "Why we moved off the JVM",
    body: null,
    hoursAgo: 6,
    up: 3,
    down: 41,
  },
  {
    title: "A gentle intro to keyset pagination",
    body: "No more OFFSET.",
    hoursAgo: 3,
    up: 33,
    down: 2,
  },
  {
    title: "Deno Deploy edge functions in practice",
    body: null,
    hoursAgo: 0.5,
    up: 9,
    down: 1,
  },
  {
    title: "The hidden cost of OFFSET pagination",
    body: "It scans and skips.",
    hoursAgo: 9,
    up: 21,
    down: 1,
  },
  {
    title: "Neon branching changed our workflow",
    body: null,
    hoursAgo: 2,
    up: 12,
    down: 0,
  },
  {
    title: "I regret using a heavy ORM",
    body: "Too much magic.",
    hoursAgo: 7,
    up: 2,
    down: 18,
  },
  {
    title: "TIL: extract(epoch) is immutable for timestamptz",
    body: null,
    hoursAgo: 4,
    up: 17,
    down: 1,
  },
  {
    title: "Benchmarking HTTP vs WebSocket Postgres",
    body: "Round trips matter.",
    hoursAgo: 11,
    up: 30,
    down: 4,
  },
  {
    title: "Our migration horror story",
    body: null,
    hoursAgo: 15,
    up: 8,
    down: 2,
  },
  {
    title: "Stop storing computed values? Not for feeds.",
    body: "Stability wins.",
    hoursAgo: 5,
    up: 26,
    down: 3,
  },
  {
    title: "How Reddit ranks hot, explained",
    body: "log10 + time.",
    hoursAgo: 16,
    up: 60,
    down: 5,
  },
  {
    title: "Cursor pagination with composite keys",
    body: null,
    hoursAgo: 2.5,
    up: 7,
    down: 0,
  },
  {
    title: "A bad take on SQL functions",
    body: "Spicy.",
    hoursAgo: 8,
    up: 1,
    down: 12,
  },
  {
    title: "Deno workspaces for monorepos",
    body: null,
    hoursAgo: 0.8,
    up: 5,
    down: 0,
  },
  {
    title: "Why we stopped using a query DSL",
    body: "Raw SQL escape hatches.",
    hoursAgo: 10,
    up: 14,
    down: 3,
  },
  {
    title: "Indexing for DESC order-by",
    body: null,
    hoursAgo: 12,
    up: 9,
    down: 1,
  },
  {
    title: "The case for driverless ORMs",
    body: "Inject the executor.",
    hoursAgo: 3.5,
    up: 19,
    down: 1,
  },
  {
    title: "Postmortem: connection pool exhaustion",
    body: null,
    hoursAgo: 14,
    up: 5,
    down: 1,
  },
  {
    title: RISING_POST_TITLE,
    body: "One user, one vote.",
    hoursAgo: 1.5,
    up: 6,
    down: 0,
  },
  {
    title: "Serverless cron without a server",
    body: null,
    hoursAgo: 17,
    up: 2,
    down: 0,
  },
  {
    title: "A quiet post with no votes yet",
    body: "Hello, world.",
    hoursAgo: 0.3,
    up: 0,
    down: 0,
  },
];

/**
 * Wipes and reinserts the example data. Returns the seeded posts (with ids) so
 * callers can reference specific posts (e.g. the rising-post demo).
 */
export async function seed(db: NeonDatabase): Promise<SeededPost[]> {
  // Idempotent reseed: post_votes first (FK), then posts.
  await db.execute(raw("delete from post_votes"));
  await db.execute(raw("delete from posts"));

  const now = Date.now();
  const seeded: SeededPost[] = [];
  const postRows = POST_SPECS.map((spec) => {
    const id = crypto.randomUUID();
    seeded.push({
      id,
      title: spec.title,
      hoursAgo: spec.hoursAgo,
      up: spec.up,
      down: spec.down,
    });
    return {
      id,
      title: spec.title,
      body: spec.body,
      created_at: new Date(now - spec.hoursAgo * HOUR_MS),
    };
  });

  await db.insert(posts).values(postRows).execute();

  // One vote row per fake user. Only -1 / 1 are stored.
  const voteRows: Array<{ post_id: string; user_id: string; value: number }> =
    [];
  for (const post of seeded) {
    for (let i = 0; i < post.up; i += 1) {
      voteRows.push({
        post_id: post.id,
        user_id: crypto.randomUUID(),
        value: 1,
      });
    }
    for (let i = 0; i < post.down; i += 1) {
      voteRows.push({
        post_id: post.id,
        user_id: crypto.randomUUID(),
        value: -1,
      });
    }
  }
  if (voteRows.length > 0) {
    await db.insert(postVotes).values(voteRows).execute();
  }

  await recomputeAggregates(db);
  return seeded;
}

/**
 * Recomputes upvotes/downvotes/score and the stored hot_score for every post
 * from the current post_votes rows, in one statement.
 *
 * Raw SQL escape hatch: a data-modifying `UPDATE ... FROM (... LEFT JOIN ...)`
 * that calls the `app.calculate_hot_score` SQL function per row. The builder
 * does not express correlated aggregate updates or calls to SQL functions in a
 * SET clause — see the README "Sisal API pressure points".
 */
export async function recomputeAggregates(db: NeonDatabase): Promise<void> {
  await db.execute(raw(`
    update posts p
    set
      upvotes = coalesce(v.up, 0),
      downvotes = coalesce(v.down, 0),
      score = coalesce(v.up, 0) - coalesce(v.down, 0),
      hot_score = app.calculate_hot_score(
        coalesce(v.up, 0) - coalesce(v.down, 0), base.created_at
      ),
      updated_at = now()
    from posts base
    left join (
      select
        post_id,
        count(*) filter (where value = 1) as up,
        count(*) filter (where value = -1) as down
      from post_votes
      group by post_id
    ) v on v.post_id = base.id
    where p.id = base.id
  `));
}

async function main(): Promise<void> {
  const { openDb } = await import("./db.ts");
  const db = await openDb();
  try {
    const seeded = await seed(db);
    console.log(`seeded ${seeded.length} posts and their votes.`);
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main();
}
