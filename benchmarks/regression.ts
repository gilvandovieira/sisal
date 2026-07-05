/**
 * Deno performance-regression gate: benchmarks the **current working tree**
 * against a committed baseline (default `v0.11.1`) and fails if any benchmark
 * regresses beyond a noise-aware threshold.
 *
 * It answers one question about the npm-distribution changes (lazy driver
 * imports, the sqlite runtime fork, computed specifiers, …): do they slow down
 * the Deno hot path? Both trees run the **same** `benchmarks/mod.ts` (the suite
 * is unchanged since the baseline), so any delta is the library code itself.
 *
 * Noise handling — sub-microsecond micro-benchmarks are dominated by GC/JIT and
 * scheduler jitter (their round-to-round avg can swing 2–5×), so a naive
 * median-of-a-few would flag pure noise as a regression. Instead:
 *  - The baseline is checked out into a throwaway `git worktree`, so both trees
 *    build from identical benchmark definitions.
 *  - Each round runs baseline then current; rounds **alternate order** so slow
 *    machine drift cancels instead of biasing one side.
 *  - The compared metric is each side's **best** (minimum) avg across all rounds
 *    — the least-perturbed, most-reproducible signal of "how fast can this code
 *    go." A one-off spike in a single round can't inflate it. Median and the
 *    round-to-round coefficient of variation are reported only as context.
 *  - A regression is flagged only when even the **best** current run is more
 *    than the threshold (default 10%) slower than the best baseline run.
 *
 * Usage:
 *   deno task bench:regression                 # vs v0.11.1, 9 rounds, 10% gate
 *   deno run -A benchmarks/regression.ts v0.11.0
 *   BENCH_ROUNDS=15 BENCH_THRESHOLD=5 deno task bench:regression
 *
 * @module
 */

const BASELINE_REF = Deno.args[0] ?? "v0.11.1";
const ROUNDS = Math.max(5, Number(Deno.env.get("BENCH_ROUNDS") ?? "9"));
const THRESHOLD_PCT = Number(Deno.env.get("BENCH_THRESHOLD") ?? "10");
const BENCH_FILE = "benchmarks/mod.ts";

interface BenchResult {
  readonly key: string; // group+name, unique across the suite
  readonly name: string; // display name
  readonly avg: number; // ns/iter
}

/** One benchmark's timing across rounds, per side. */
interface Series {
  readonly name: string;
  readonly baseline: number[];
  readonly current: number[];
}

/** Runs `deno bench --json` in `cwd` and returns each benchmark's avg (ns). */
async function runBench(cwd: string): Promise<BenchResult[]> {
  const command = new Deno.Command("deno", {
    args: ["bench", "--json", "-A", BENCH_FILE],
    cwd,
    stdout: "piped",
    stderr: "null",
  });
  const { code, stdout } = await command.output();
  if (code !== 0) {
    throw new Error(`deno bench failed in ${cwd} (exit ${code})`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(stdout)) as {
    benches: Array<
      {
        group: string;
        name: string;
        results: Array<{ ok?: { avg: number } }>;
      }
    >;
  };
  const out: BenchResult[] = [];
  for (const bench of parsed.benches) {
    const avg = bench.results[0]?.ok?.avg;
    if (typeof avg === "number") {
      // Key by group+name: a bare name can repeat across benchmark groups.
      out.push({
        key: (bench.group ?? "") + " " + bench.name,
        name: bench.name,
        avg,
      });
    }
  }
  return out;
}

/** Coefficient of variation (stdev / mean) — a unitless noise measure. */
function coefficientOfVariation(values: readonly number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) /
    values.length;
  return Math.sqrt(variance) / mean;
}

function fmtTime(ns: number): string {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(2)}µs`;
  return `${ns.toFixed(1)}ns`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

async function main(): Promise<void> {
  const worktree = await Deno.makeTempDir({ prefix: "sisal-bench-baseline-" });
  console.log(
    `Sisal Deno regression bench\n` +
      `  baseline : ${BASELINE_REF}\n` +
      `  current  : working tree\n` +
      `  rounds   : ${ROUNDS} (interleaved)\n` +
      `  metric   : best-of-${ROUNDS} avg per side\n` +
      `  gate     : best-vs-best > ${THRESHOLD_PCT}%\n`,
  );

  try {
    console.log(`▸ checking out ${BASELINE_REF} into a worktree…`);
    const add = await new Deno.Command("git", {
      args: ["worktree", "add", "--detach", "--force", worktree, BASELINE_REF],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (add.code !== 0) {
      throw new Error(
        `git worktree add failed: ${new TextDecoder().decode(add.stderr)}`,
      );
    }

    const series = new Map<string, Series>();
    const record = (side: "baseline" | "current", rows: BenchResult[]) => {
      for (const row of rows) {
        let entry = series.get(row.key);
        if (entry === undefined) {
          entry = { name: row.name, baseline: [], current: [] };
          series.set(row.key, entry);
        }
        entry[side].push(row.avg);
      }
    };

    for (let round = 1; round <= ROUNDS; round++) {
      // Alternate which side runs first so thermal/scheduler drift over the
      // round cancels rather than always penalising the same side.
      const currentFirst = round % 2 === 0;
      Deno.stdout.writeSync(
        new TextEncoder().encode(`▸ round ${round}/${ROUNDS} `),
      );
      if (currentFirst) {
        record("current", await runBench("."));
        record("baseline", await runBench(worktree));
      } else {
        record("baseline", await runBench(worktree));
        record("current", await runBench("."));
      }
      console.log("✓");
    }

    // ---- analysis ----------------------------------------------------------
    interface Row {
      readonly name: string;
      readonly base: number; // best (min) baseline avg
      readonly cur: number; // best (min) current avg
      readonly deltaPct: number; // best-vs-best delta
      readonly noisePct: number; // round-to-round spread (context only)
      readonly significant: boolean;
    }
    const min = (values: readonly number[]) => Math.min(...values);
    const rows: Row[] = [];
    for (const entry of series.values()) {
      if (entry.baseline.length === 0 || entry.current.length === 0) continue;
      // Best-of-N: compare each side's fastest round. Noise inflates times, so
      // the minimum is the cleanest estimate of the code's real speed.
      const base = min(entry.baseline);
      const cur = min(entry.current);
      const deltaPct = ((cur - base) / base) * 100;
      const noisePct = Math.max(
        coefficientOfVariation(entry.baseline),
        coefficientOfVariation(entry.current),
      ) * 100;
      const significant = deltaPct > THRESHOLD_PCT;
      rows.push({
        name: entry.name,
        base,
        cur,
        deltaPct,
        noisePct,
        significant,
      });
    }
    rows.sort((a, b) => b.deltaPct - a.deltaPct);

    const trim = (name: string) =>
      name.length > 52 ? name.slice(0, 51) + String.fromCharCode(8230) : name;
    const nameWidth = Math.min(
      52,
      Math.max(...rows.map((r) => trim(r.name).length)),
    );

    const line = (r: Row) => {
      const flag = r.significant
        ? "  ⛔ REGRESSION"
        : r.deltaPct < -THRESHOLD_PCT
        ? "  ⚡ faster"
        : "";
      const sign = r.deltaPct >= 0 ? "+" : "";
      return `  ${pad(trim(r.name), nameWidth)}  ` +
        `${padStart(fmtTime(r.base), 9)} → ${padStart(fmtTime(r.cur), 9)}  ` +
        `${padStart(`${sign}${r.deltaPct.toFixed(1)}%`, 7)}` +
        `  (±${r.noisePct.toFixed(1)}%)${flag}`;
    };

    console.log(
      `\n(best-of-${ROUNDS} avg per side; delta is best-vs-best, noise is ` +
        `round-to-round spread)\n${pad("benchmark", nameWidth + 2)}  ` +
        `${padStart("baseline", 9)}   ${
          padStart("current", 9)
        }   delta   noise\n` +
        "─".repeat(nameWidth + 46),
    );
    // Worst 12 and best 5 keep the report readable while surfacing extremes.
    const worst = rows.slice(0, 12);
    const best = rows.slice(-5).reverse();
    for (const r of worst) console.log(line(r));
    console.log(`  … ${rows.length - worst.length - best.length} more …`);
    for (const r of best) console.log(line(r));

    const regressions = rows.filter((r) => r.significant);
    const meanAbs = rows.reduce((a, r) => a + Math.abs(r.deltaPct), 0) /
      rows.length;
    const maxNoise = Math.max(...rows.map((r) => r.noisePct));

    console.log(
      `\nSummary: ${rows.length} benchmarks · mean |Δ| ${
        meanAbs.toFixed(1)
      }% · ` +
        `noise floor ≤ ${maxNoise.toFixed(1)}% · ` +
        `${regressions.length} significant regression(s)`,
    );

    if (regressions.length > 0) {
      console.log(
        `\n⛔ Significant regressions (best-vs-best > ${THRESHOLD_PCT}%):`,
      );
      for (const r of regressions) {
        console.log(
          `   ${trim(r.name)}: ${fmtTime(r.base)} → ${fmtTime(r.cur)} ` +
            `(+${r.deltaPct.toFixed(1)}%)`,
        );
      }
      Deno.exit(1);
    }
    console.log(
      `\n✔ No significant performance regression vs ${BASELINE_REF}. ` +
        `The npm-distribution changes do not slow the Deno hot path.`,
    );
  } finally {
    // Remove the worktree, then prune — if the temp dir was already reaped, the
    // remove is a no-op and prune clears the dangling registration.
    await new Deno.Command("git", {
      args: ["worktree", "remove", "--force", worktree],
      stdout: "null",
      stderr: "null",
    }).output();
    await new Deno.Command("git", {
      args: ["worktree", "prune"],
      stdout: "null",
      stderr: "null",
    }).output();
    await Deno.remove(worktree, { recursive: true }).catch(() => {});
  }
}

await main();
