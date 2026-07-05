# Sisal benchmarks

Three complementary benchmark modes. All are **network/FFI-free** except the
cross-runtime e2e, which needs a Postgres.

## 1. Core micro-benchmarks — `deno task bench`

`benchmarks/mod.ts` (+ `scenarios/`) measures Sisal's own CPU cost with
`Deno.bench`: query build, SQL render per dialect, schema-snapshot creation, DDL
generation, the dispatch path (a fake driver), logging, and Temporal parsing. No
driver, no database. This is the raw library-speed suite the other two modes
build on.

## 2. Deno regression gate — `deno task bench:regression`

Proves a change set does **not** slow the Deno hot path. It benchmarks the
current working tree against a committed baseline (default `v0.11.1`) by running
the **same** `mod.ts` suite in both, then failing if anything regresses past the
threshold.

```sh
deno task bench:regression                 # vs v0.11.1, 9 rounds, 10% gate
deno run -A benchmarks/regression.ts v0.11.0
BENCH_ROUNDS=15 BENCH_THRESHOLD=5 deno task bench:regression
```

Noise handling (micro-benchmarks swing 2–5× round-to-round on GC/JIT jitter):

- the baseline is checked out into a throwaway **git worktree**, so both trees
  run identical benchmark definitions;
- rounds **alternate** which side runs first, cancelling machine drift;
- the compared metric is each side's **best (minimum) avg across rounds** — the
  least-perturbed estimate of real speed, so a single spike can't fake a
  regression; median and round-to-round spread are reported only as context;
- a regression is flagged only when even the **best** current run is > threshold
  slower than the best baseline run. Exit code is non-zero if any fires.

## 3. Cross-runtime e2e — `benchmarks/cross_runtime/run.sh` (Node vs Bun)

Compares Sisal on Node vs Bun and **separates the two variables** the raw wall
time conflates:

- **Part 1 — Sisal render (CPU, no DB):** builds + renders queries to
  `{text, params}`. Pure library + JS engine; comparing runtimes here compares
  their engines on Sisal's hot path.
- **Part 2 — pg e2e:** the same workload once through Sisal and once through the
  raw `postgres` driver. The raw path is the **runtime + driver + database**
  baseline; `(sisal − raw)` isolates **Sisal's marginal overhead**, with the
  database time cancelling out.

```sh
docker compose -f docker/compose.yaml up -d pg16
benchmarks/cross_runtime/run.sh
SKIP_BUILD=1 DB_URL=postgres://user:pass@host/db benchmarks/cross_runtime/run.sh
```

The runner builds the `@sisaljs/*` npm packages, links them into a throwaway
consumer with the real driver, runs `bench.mjs` under `node` and `bun`, and
prints a side-by-side comparison (`compare.ts`). `postgres.js` is the driver
because it runs identically on both runtimes — Bun has no `node:sqlite`, so
Sisal's SQLite adapter can't run there yet. Missing runtimes are skipped.
