// Cross-runtime Sisal benchmark: runs under both Node and Bun (see run.sh) and
// deliberately separates two variables:
//
//   Part 1 — Sisal CPU render (no DB): builds + renders queries to {text,params}.
//            Pure library + JS engine, zero I/O. This is "Sisal's own speed",
//            and comparing runtimes here compares their JS engines on Sisal's
//            hot path.
//
//   Part 2 — pg e2e (postgres.js + real Postgres): the same workload run once
//            through Sisal and once through the raw driver. The raw path is the
//            "runtime + driver + database" baseline; (sisal − raw) isolates
//            Sisal's marginal overhead, with the database time cancelling out.
//
// postgres.js is the driver because it runs identically on Node and Bun (Bun
// lacks node:sqlite, so Sisal's SQLite adapter can't run there today). Output:
// a human summary plus one `##RESULT## {json}` line that run.sh aggregates.
import "./setup_temporal.mjs"; // must precede @sisaljs/* — installs Temporal on Bun
import {
  and,
  asc,
  columns,
  createDatabase,
  defineTable,
  desc,
  eq,
  gt,
  renderSql,
  sql,
} from "@sisaljs/orm";

const runtime = globalThis.Bun ? "bun" : globalThis.Deno ? "deno" : "node";
const temporalSource = globalThis.__SISAL_TEMPORAL_POLYFILL__
  ? "polyfill"
  : "native";
const version = globalThis.Bun?.version ?? globalThis.Deno?.version?.deno ??
  process.versions.node;

// ---- timing ----------------------------------------------------------------

/** Median ns/op of a synchronous op, after warm-up (JIT) and several samples. */
function benchSync(fn, { iters, samples = 9, warmup = 3 }) {
  for (let w = 0; w < warmup; w++) for (let i = 0; i < iters; i++) fn(i);
  const perOp = [];
  for (let s = 0; s < samples; s++) {
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn(i);
    const t1 = performance.now();
    perOp.push(((t1 - t0) * 1e6) / iters); // ms → ns, per op
  }
  perOp.sort((a, b) => a - b);
  return perOp[Math.floor(perOp.length / 2)];
}

/** Median ms of an async workload, after warm-up and several samples. */
async function benchAsync(fn, { samples = 7, warmup = 2 }) {
  for (let w = 0; w < warmup; w++) await fn();
  const times = [];
  for (let s = 0; s < samples; s++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

// ---- fixtures --------------------------------------------------------------

const db = createDatabase({ dialect: "postgres" });

const posts = defineTable("bench_posts", {
  id: columns.integer().primaryKey(),
  authorId: columns.integer().notNull(),
  title: columns.text().notNull(),
  status: columns.text().notNull().default("draft"),
  hotScore: columns.integer().notNull().default(0),
});
const authors = defineTable("bench_authors", {
  id: columns.integer().primaryKey(),
  name: columns.text().notNull(),
});
const p = posts.columns;
const a = authors.columns;

// ---- Part 1: Sisal CPU render (no DB) --------------------------------------

const RENDER = {
  "select+where": () =>
    db.select().from(posts).where(eq(p.status, "published")).toSql(),
  "insert row": () =>
    db.insert(posts).values({
      id: 1,
      authorId: 2,
      title: "hello",
      status: "published",
      hotScore: 7,
    }).toSql(),
  "update+where": () =>
    db.update(posts).set({ hotScore: 9 }).where(eq(p.id, 1)).toSql(),
  "join+filter+order": () =>
    db.select({ id: p.id, author: a.name, hot: p.hotScore })
      .from(posts)
      .innerJoin(authors, eq(a.id, p.authorId))
      .where(and(gt(p.hotScore, 10), eq(p.status, "published")))
      .orderBy(desc(p.hotScore), asc(p.id))
      .limit(20)
      .toSql(),
  "sql template": () =>
    renderSql(
      sql`select * from bench_posts where id = ${1} and status = ${"published"}`,
      { dialect: "postgres" },
    ),
};

function runRender() {
  const render = {};
  for (const [name, fn] of Object.entries(RENDER)) {
    render[name] = benchSync(fn, { iters: 20_000 });
  }
  return render; // ns/op per workload
}

// ---- Part 2: pg e2e (Sisal vs raw driver) ----------------------------------
// A uniform read workload — serial point-selects on one connection — so the
// headline metric is unambiguous queries/sec (throughput = 1 / round-trip
// latency). Both paths issue identical SQL, so (sisal − raw) per query is
// Sisal's build + result-mapping cost with the database round-trip cancelled.

const SEED_ROWS = 200; // rows the timed workload reads
const QUERIES = 1000; // serial point-selects per sample

async function runE2e(dbUrl) {
  const { connect } = await import("@sisaljs/pg");
  const postgres = (await import("postgres")).default;

  const orm = await connect({ url: dbUrl });
  const raw = postgres(dbUrl, { max: 1 });

  const seed = Array.from({ length: SEED_ROWS }, (_, i) => ({
    id: i + 1,
    authorId: (i % 10) + 1,
    title: `post ${i}`,
    status: i % 2 === 0 ? "published" : "draft",
    hotScore: i,
  }));

  try {
    // Setup (untimed): identical starting state for both paths.
    await orm.execute(`drop table if exists bench_posts`);
    await orm.execute(
      `create table bench_posts (id integer primary key, author_id integer not null, ` +
        `title text not null, status text not null default 'draft', hot_score integer not null default 0)`,
    );
    await orm.insert(posts).values(seed).execute();

    // Sisal path: point selects built + executed + result-mapped by the ORM.
    const sisalWorkload = async () => {
      for (let i = 0; i < QUERIES; i++) {
        await orm.select({ title: p.title, hot: p.hotScore })
          .from(posts).where(eq(p.id, (i % SEED_ROWS) + 1)).execute();
      }
    };

    // Raw path: the equivalent SQL hand-written on postgres.js. Same DB work,
    // so (sisal − raw) is Sisal's build + result-mapping cost, not the database.
    const rawWorkload = async () => {
      for (let i = 0; i < QUERIES; i++) {
        const id = (i % SEED_ROWS) + 1;
        await raw`select title, hot_score from bench_posts where id = ${id}`;
      }
    };

    const sisalMs = await benchAsync(sisalWorkload, {});
    const rawMs = await benchAsync(rawWorkload, {});
    return {
      queries: QUERIES,
      rawRps: (QUERIES / rawMs) * 1000,
      sisalRps: (QUERIES / sisalMs) * 1000,
      rawUsPerQuery: (rawMs / QUERIES) * 1000,
      sisalUsPerQuery: (sisalMs / QUERIES) * 1000,
      overheadUsPerQuery: ((sisalMs - rawMs) / QUERIES) * 1000,
      overheadPct: ((sisalMs - rawMs) / rawMs) * 100,
    };
  } finally {
    await orm.close();
    await raw.end({ timeout: 5 });
  }
}

// ---- main ------------------------------------------------------------------

const dbUrl = process.env.DB_URL;
const result = { runtime, version, temporalSource, render: runRender() };
if (dbUrl) {
  result.e2e = await runE2e(dbUrl);
}

const us = (ns) => `${(ns / 1000).toFixed(3)}µs`;
console.log(`\n── ${runtime} v${version} (Temporal: ${temporalSource}) ──`);
console.log("Part 1 — Sisal render (CPU, no DB), ns/op median:");
for (const [name, ns] of Object.entries(result.render)) {
  console.log(`  ${name.padEnd(20)} ${us(ns).padStart(10)}  (${Math.round(1e9 / ns).toLocaleString()} ops/s)`);
}
if (result.e2e) {
  const e = result.e2e;
  const rps = (n) => `${Math.round(n).toLocaleString()} q/s`;
  console.log(
    `Part 2 — pg e2e, serial point-selects, single connection ` +
      `(${e.queries}/sample):\n` +
      `  raw driver   ${rps(e.rawRps).padStart(11)}  ` +
      `(${e.rawUsPerQuery.toFixed(1)}µs/query)  ← runtime + driver + db baseline\n` +
      `  sisal        ${rps(e.sisalRps).padStart(11)}  ` +
      `(${e.sisalUsPerQuery.toFixed(1)}µs/query)\n` +
      `  sisal cost   +${e.overheadUsPerQuery.toFixed(1)}µs/query ` +
      `(+${e.overheadPct.toFixed(1)}% latency)`,
  );
} else {
  console.log("Part 2 — skipped (no DB_URL)");
}

console.log(`##RESULT## ${JSON.stringify(result)}`);
