/**
 * Generates `docs/feature-matrix.md` from `tools/feature_matrix.ts` — the
 * unified cross-driver feature matrix (v0.5.0 roadmap item 3).
 *
 *   deno task docs:matrix         # write docs/feature-matrix.md
 *   deno task docs:matrix:check   # verify it is up to date + every ✅/⚠️ is
 *                                 # backed by a named integration test
 *
 * The check also fails if the matrix claims a `tested`/`roundtrip` cell whose
 * named integration test does not exist in the matching suite (roadmap item 6).
 *
 * @module
 */
import {
  type Adapter,
  ADAPTER_LABELS,
  ADAPTERS,
  type Cell,
  cellTest,
  FEATURE_MATRIX,
} from "./feature_matrix.ts";

const OUT = new URL("../docs/feature-matrix.md", import.meta.url);
const suiteUrl = (a: Adapter) =>
  new URL(`../integration/${a}_features_test.ts`, import.meta.url);

function cellSymbol(cell: Cell): string {
  switch (cell.status) {
    case "tested":
      return "✅";
    case "roundtrip":
      return `⚠️ ${cell.label}`;
    case "unsupported":
      return "❌";
    case "na":
      return "—";
  }
}

/** Renders a Markdown table with simple per-column padding (fmt-excluded). */
function renderTable(): string {
  const headers = ["Feature", ...ADAPTERS.map((a) => ADAPTER_LABELS[a])];
  const rows = FEATURE_MATRIX.map((
    row,
  ) => [row.feature, ...ADAPTERS.map((a) => cellSymbol(row.cells[a]))]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );
  const padCell = (s: string, i: number, center: boolean) => {
    const pad = widths[i] - s.length;
    if (!center) return s + " ".repeat(pad);
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + s + " ".repeat(pad - left);
  };
  const line = (cols: string[], center: boolean) =>
    "| " + cols.map((c, i) => padCell(c, i, center && i > 0)).join(" | ") +
    " |";

  const sep = "| " +
    widths.map((w, i) =>
      i === 0
        ? ":" + "-".repeat(Math.max(1, w - 1))
        : ":" + "-".repeat(Math.max(1, w - 2)) + ":"
    ).join(" | ") + " |";

  return [
    line(headers, false),
    sep,
    ...rows.map((r) => line(r, true)),
  ].join("\n");
}

/** One Notes bullet per feature that has any ⚠️/❌ cell. */
function renderNotes(): string {
  const bullets: string[] = [];
  for (const row of FEATURE_MATRIX) {
    const reasons = [
      ...new Set(
        ADAPTERS.map((a) => row.cells[a].reason).filter((r): r is string =>
          r !== undefined
        ),
      ),
    ];
    for (const reason of reasons) {
      bullets.push(`- **${row.feature}** — ${reason}`);
    }
  }
  return bullets.join("\n");
}

function render(): string {
  return `---
title: Feature matrix
---

<!-- GENERATED FILE — do not edit by hand.
     Source of truth: tools/feature_matrix.ts
     Regenerate: deno task docs:matrix   ·   Verify: deno task docs:matrix:check -->

# Cross-driver feature matrix

One row per feature, one column per adapter, across \`@sisal/pg\`,
\`@sisal/neon\`, \`@sisal/sqlite\`, and \`@sisal/libsql\`. Every ✅ and ⚠️ is
backed by a named integration test in
\`integration/<adapter>_features_test.ts\` — \`deno task docs:matrix:check\`
fails if a claimed test is missing, so this table cannot drift from the suites.

**Legend.** ✅ tested · ⚠️ works, with a documented round-trip difference · ❌
genuine dialect limit · — not applicable.

${renderTable()}

## Notes

The ⚠️ and ❌ cells above are the principled, permanent divergences — the
SQLite family (\`@sisal/sqlite\`, \`@sisal/libsql\`) has no equivalent for the
PostgreSQL-only constructs, and stores a few types differently:

${renderNotes()}

## Reproduce

Each adapter's suite is gated and run on its own (see the per-engine pages for
setup — Docker, env vars, the bundled \`neon-proxy\`):

\`\`\`sh
deno test --env-file=.env -A integration/pg_features_test.ts
deno test --env-file=.env -A integration/neon_features_test.ts
deno test --env-file=.env -A integration/sqlite_features_test.ts
deno test --env-file=.env -A integration/libsql_features_test.ts
\`\`\`

Per-engine behavior notes live on the
[Postgres](pg-compatibility.md), [Neon](neon-compatibility.md),
[SQLite](sqlite-compatibility.md), and [libSQL](libsql-compatibility.md) pages.
`;
}

/** Asserts every tested/roundtrip cell's named integration test exists. */
function validate(): { backed: number; errors: string[] } {
  const errors: string[] = [];
  let backed = 0;
  const namesByAdapter = new Map<Adapter, string[]>();
  for (const a of ADAPTERS) {
    const text = Deno.readTextFileSync(suiteUrl(a));
    const names = [...text.matchAll(new RegExp(`"${a}: ([^"]+)"`, "g"))].map((
      m,
    ) => m[1]);
    namesByAdapter.set(a, names);
  }
  for (const row of FEATURE_MATRIX) {
    for (const a of ADAPTERS) {
      const cell = row.cells[a];
      if (cell.status !== "tested" && cell.status !== "roundtrip") continue;
      const needle = cellTest(row, a);
      if (needle === undefined) {
        errors.push(`${a} "${row.feature}": ${cell.status} cell has no test`);
        continue;
      }
      const hit = namesByAdapter.get(a)!.some((n) => n.includes(needle));
      if (hit) backed += 1;
      else {
        errors.push(
          `${a} "${row.feature}": no test name contains "${needle}" in ` +
            `integration/${a}_features_test.ts`,
        );
      }
    }
  }
  return { backed, errors };
}

function main(): void {
  const check = Deno.args.includes("--check");
  const { backed, errors } = validate();
  if (errors.length > 0) {
    console.error("feature-matrix: coverage check failed:");
    for (const e of errors) console.error(`  - ${e}`);
    Deno.exit(1);
  }
  const content = render();
  const cells = FEATURE_MATRIX.length * ADAPTERS.length;
  if (check) {
    const current = (() => {
      try {
        return Deno.readTextFileSync(OUT);
      } catch {
        return null;
      }
    })();
    if (current !== content) {
      console.error(
        "docs/feature-matrix.md is out of date — run `deno task docs:matrix`.",
      );
      Deno.exit(1);
    }
    console.log(
      `docs/feature-matrix.md is up to date (${FEATURE_MATRIX.length} features ` +
        `× ${ADAPTERS.length} adapters = ${cells} cells; ${backed} ✅/⚠️ ` +
        `backed by named tests).`,
    );
    return;
  }
  Deno.writeTextFileSync(OUT, content);
  console.log(
    `Wrote docs/feature-matrix.md (${FEATURE_MATRIX.length} features × ` +
      `${ADAPTERS.length} adapters; ${backed} ✅/⚠️ backed by named tests).`,
  );
}

main();
