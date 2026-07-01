/**
 * Generates `docs/feature-matrix.md` from `tools/feature_matrix.ts` — the
 * unified cross-driver feature matrix (v0.5.0 roadmap item 3).
 *
 *   deno task docs:matrix         # write docs/feature-matrix.md
 *   deno task docs:matrix:check   # verify it is up to date + every ✅/⚠️ is
 *                                 # backed by a registered integration scenario
 *
 * The check also fails if the matrix claims a `tested`/`roundtrip` cell whose
 * named integration scenario does not exist in the matching suite (roadmap
 * item 6).
 *
 * @module
 */
import {
  type Adapter,
  ADAPTER_LABELS,
  ADAPTERS,
  type Cell,
  cellScenario,
  type CellStatus,
  FEATURE_MATRIX,
} from "./feature_matrix.ts";
import { featureScenariosForAdapter } from "../integration/_shared/scenarios.ts";

const OUT = new URL("../docs/feature-matrix.md", import.meta.url);

// ⚠️/❌ cells link to the reference section below that explains each one.
const ROUND_TRIP_ANCHOR = "round-trip-differences";
const LIMITS_ANCHOR = "postgresql-only-limits";

/** The visible (render-width) text of a cell, ignoring any link wrapper. */
function cellVisible(cell: Cell): string {
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

/** The cell as Markdown — ⚠️/❌ become links to their reference section. */
function cellMarkdown(cell: Cell): string {
  const visible = cellVisible(cell);
  if (cell.status === "roundtrip") return `[${visible}](#${ROUND_TRIP_ANCHOR})`;
  if (cell.status === "unsupported") return `[${visible}](#${LIMITS_ANCHOR})`;
  return visible;
}

/** Renders the matrix; columns align on visible width, ⚠️/❌ cells link out. */
function renderTable(): string {
  const headers = ["Feature", ...ADAPTERS.map((a) => ADAPTER_LABELS[a])];
  const visible = FEATURE_MATRIX.map((row) => [
    row.feature,
    ...ADAPTERS.map((a) => cellVisible(row.cells[a])),
  ]);
  const display = FEATURE_MATRIX.map((row) => [
    row.feature,
    ...ADAPTERS.map((a) => cellMarkdown(row.cells[a])),
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...visible.map((r) => r[i].length))
  );
  const pad = (text: string, len: number, i: number, center: boolean) => {
    const space = Math.max(0, widths[i] - len);
    if (!center) return text + " ".repeat(space);
    const left = Math.floor(space / 2);
    return " ".repeat(left) + text + " ".repeat(space - left);
  };
  const row = (cells: string[], lens: number[], center: boolean) =>
    "| " + cells.map((c, i) =>
      pad(c, lens[i], i, center && i > 0)
    ).join(" | ") +
    " |";

  const sep = "| " +
    widths.map((w, i) =>
      i === 0
        ? ":" + "-".repeat(Math.max(1, w - 1))
        : ":" + "-".repeat(Math.max(1, w - 2)) + ":"
    ).join(" | ") + " |";

  return [
    row(headers, headers.map((h) => h.length), false),
    sep,
    ...display.map((cells, ri) =>
      row(cells, visible[ri].map((v) => v.length), true)
    ),
  ].join("\n");
}

/** Per-feature reason bullets for every row carrying a cell of `status`. */
function reasonBullets(status: CellStatus): string {
  const bullets: string[] = [];
  for (const feature of FEATURE_MATRIX) {
    const reason = ADAPTERS
      .map((a) => feature.cells[a])
      .find((c) => c.status === status && c.reason !== undefined)?.reason;
    if (reason !== undefined) {
      bullets.push(`- **${feature.feature}** — ${reason}`);
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
backed by a registered shared integration scenario. The adapter entrypoints
still render those scenarios as target-prefixed Deno tests in
\`integration/<adapter>_features_test.ts\`; \`deno task docs:matrix:check\`
fails if a claimed scenario is missing, so this table cannot drift from the
suites.

**Legend.** ✅ tested · ⚠️ works, with a documented round-trip difference · ❌
genuine dialect limit · — not applicable.

${renderTable()}

The ⚠️ and ❌ cells link to the one-paragraph reason for each, below. They are
the only principled, permanent divergences — everything else behaves
identically across the four adapters.

## Round-trip differences

These ⚠️ cells work — the feature is exercised on every adapter — but a value
comes back in a different JS shape on the SQLite family than on PostgreSQL:

${reasonBullets("roundtrip")}

Value-shape summary (what a read yields, per adapter family):

| Type | \`@sisal/pg\` / \`@sisal/neon\` | \`@sisal/sqlite\` / \`@sisal/libsql\` |
| --- | --- | --- |
| \`numeric\` / \`bigint\` | string (precision-preserving) | number |
| \`json\` / \`jsonb\` / array | parsed value | JSON \`TEXT\` string (\`JSON.parse\` on read) |
| \`boolean\` | \`boolean\` | \`INTEGER\` \`0\`/\`1\` |
| \`bytea\` / BLOB | \`Uint8Array\` | \`Uint8Array\` (sqlite) · \`ArrayBuffer\` (libsql) |
| \`real\` / \`double precision\` (float4/float8) | number | number |

## PostgreSQL-only limits

The SQLite family has no equivalent for these PostgreSQL constructs. Rendering a
builder that uses one for a SQLite-family dialect throws a typed \`OrmError\`
(\`ORM_DIALECT_UNSUPPORTED\`) at render time (v0.5.0 item 4) — except the typed
function caller (\`db.call\`), which has no SQLite-family API surface at all:

${reasonBullets("unsupported")}

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

/** Asserts every tested/roundtrip cell's registered scenario exists. */
function validate(): { backed: number; errors: string[] } {
  const errors: string[] = [];
  let backed = 0;
  const namesByAdapter = new Map<Adapter, string[]>();
  for (const a of ADAPTERS) {
    const names = featureScenariosForAdapter(a).map((scenario) =>
      scenario.name
    );
    namesByAdapter.set(a, names);
  }
  for (const row of FEATURE_MATRIX) {
    for (const a of ADAPTERS) {
      const cell = row.cells[a];
      if (cell.status !== "tested" && cell.status !== "roundtrip") continue;
      const needle = cellScenario(row, a);
      if (needle === undefined) {
        errors.push(
          `${a} "${row.feature}": ${cell.status} cell has no scenario`,
        );
        continue;
      }
      const hit = namesByAdapter.get(a)!.some((n) => n.includes(needle));
      if (hit) backed += 1;
      else {
        errors.push(
          `${a} "${row.feature}": no registered scenario contains ` +
            `"${needle}" for integration/${a}_features_test.ts`,
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
        `backed by registered scenarios).`,
    );
    return;
  }
  Deno.writeTextFileSync(OUT, content);
  console.log(
    `Wrote docs/feature-matrix.md (${FEATURE_MATRIX.length} features × ` +
      `${ADAPTERS.length} adapters; ${backed} ✅/⚠️ backed by registered ` +
      `scenarios).`,
  );
}

main();
