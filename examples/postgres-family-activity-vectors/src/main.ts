/**
 * The demo: the whole computation chain end to end, at a fixed DEMO_NOW.
 *
 *   raw events  →  hourly buckets  →  consolidated stats (window MAs)
 *               →  activity vectors  →  similar posts  →  retention rollups
 *
 *   deno run --env-file=.env --allow-env --allow-net --allow-read src/main.ts
 *   deno run --env-file=.env --allow-env --allow-net --allow-read src/main.ts --reset
 *
 * Plain run clears the data and re-seeds (run `deno task migrate` first);
 * `--reset` drops and recreates the schema too. Output is identical every run.
 *
 * @module
 */

import { raw } from "@sisal/orm";
import { openDb } from "./db.ts";
import { runMigrations } from "./migrate.ts";
import { DEMO_NOW, representativePostId, seed } from "./seed.ts";
import { foldEventsToBuckets } from "./events.ts";
import { computeStats, getStats, statsToVector } from "./stats.ts";
import { getSimilarPosts } from "./queries.ts";
import { pruneEvents, rollupDaily, rollupMonthly } from "./retention.ts";
import { postEvents } from "./schema.ts";
import { VECTOR_VERSION } from "./vector.ts";

function fmt(value: number, places = 2): string {
  return value.toFixed(places);
}

async function printVectorTable(
  db: Awaited<ReturnType<typeof openDb>>,
  categoryOf: Map<string, string>,
): Promise<void> {
  console.log("consolidated stats / activity vector (at DEMO_NOW):\n");
  const header = [
    "category".padEnd(14),
    "v1h".padStart(5),
    "c1h".padStart(5),
    "r1h".padStart(5),
    "ua1h".padStart(5),
    "vMA6".padStart(7),
    "cMA6".padStart(7),
    "hot".padStart(6),
    "rising".padStart(7),
    "ageMin".padStart(8),
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const [postId, category] of categoryOf) {
    const s = await getStats(db, postId);
    if (s === undefined) continue;
    const v = statsToVector(s);
    console.log([
      category.padEnd(14),
      String(v[0]).padStart(5),
      String(v[1]).padStart(5),
      String(v[2]).padStart(5),
      String(v[3]).padStart(5),
      fmt(v[4]).padStart(7),
      fmt(v[5]).padStart(7),
      fmt(v[6]).padStart(6),
      fmt(v[7]).padStart(7),
      fmt(v[8]).padStart(8),
    ].join(" "));
  }
  console.log();
}

async function printSimilar(
  db: Awaited<ReturnType<typeof openDb>>,
  categoryKey: string,
  categoryOf: Map<string, string>,
): Promise<void> {
  const sourceId = representativePostId(categoryKey);
  const similar = await getSimilarPosts(db, sourceId, 4);
  console.log(`most similar to a "${categoryKey}" post:`);
  for (const s of similar) {
    console.log(
      `  ${fmt(s.similarity, 4)}  ${s.title}  [${categoryOf.get(s.id)}]`,
    );
  }
  console.log();
}

export async function main(): Promise<void> {
  const reset = Deno.args.includes("--reset");
  const db = await openDb();
  try {
    if (reset) {
      await runMigrations(db, { reset: true });
    } else {
      await db.execute(raw("delete from posts"));
    }

    // 1. raw events
    const seeded = await seed(db);
    const categoryOf = new Map(seeded.map((p) => [p.id, p.category]));

    // 2. fold events -> hourly buckets (one set-based statement)
    const window = {
      from: new Date(DEMO_NOW.getTime() - 24 * 3600_000),
      until: new Date(DEMO_NOW.getTime() + 3600_000),
    };
    const buckets = await foldEventsToBuckets(db, window.from, window.until);

    // 3. compute consolidated stats (window-function moving averages) for all
    const computed = await computeStats(db, DEMO_NOW);
    console.log(
      `\nfolded ${buckets} hourly bucket(s); computed ${computed} ` +
        `'${VECTOR_VERSION}' stats row(s)\n`,
    );

    // 4. the vectors
    await printVectorTable(db, categoryOf);

    // 5. similar posts (the secondary payoff)
    for (const category of ["fast_spike", "comment_heavy", "report_heavy"]) {
      await printSimilar(db, category, categoryOf);
    }

    // 6. retention: roll up, then prune raw events; rollups survive
    const daily = await rollupDaily(db, window.from, window.until);
    const monthly = await rollupMonthly(db, window.from, window.until);
    const eventsBefore = (await db.select({ id: postEvents.columns.id })
      .from(postEvents).execute()).length;
    // Keep raw events short-term: prune anything older than 3 hours (already
    // folded into buckets + rollups). Stats survive in the consolidated tables.
    const cutoff = new Date(DEMO_NOW.getTime() - 3 * 3600_000);
    const pruned = await pruneEvents(db, cutoff);
    const eventsAfter = (await db.select({ id: postEvents.columns.id })
      .from(postEvents).execute()).length;
    console.log(
      `retention: ${daily} daily + ${monthly} monthly rollup row(s); ` +
        `pruned ${pruned} of ${eventsBefore} raw events (${eventsAfter} remain). ` +
        `Stats + rollups are preserved after pruning.\n`,
    );

    // Stats are intact even though the raw events are gone.
    const stillThere = await getStats(db, representativePostId("fast_spike"));
    console.log(
      `a fast-spike post's vector after pruning: [${
        stillThere
          ? statsToVector(stillThere).map((n) => fmt(n, 1)).join(", ")
          : "?"
      }]`,
    );
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main();
}
