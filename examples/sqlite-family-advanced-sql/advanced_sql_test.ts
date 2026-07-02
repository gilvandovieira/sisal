import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { advancedSqlCases, renderAdvancedSqlCases } from "./src/statements.ts";

Deno.test("sqlite advanced SQL records all contracts", () => {
  assertEquals(advancedSqlCases().map((entry) => entry.id), [
    "01",
    "02",
    "03",
    "04",
    "05",
    "06",
    "07",
    "08",
    "09",
    "10",
    "11",
    "12",
  ]);
});

Deno.test("sqlite conservative skips remain explicit", () => {
  const skipped = advancedSqlCases()
    .filter((entry) => entry.implementation === "skipped")
    .map((entry) => entry.id);
  // 03/05/06 shipped as builder/hybrid once window, dateDiff, and recursive
  // primitives landed; only the checkpoint contract (09) stays skipped.
  assertEquals(skipped, ["09"]);
});

Deno.test("sqlite renders builder-native window/recursive/JSON cases", () => {
  const rendered = renderAdvancedSqlCases();
  const byId = (id: string) => {
    const entry = rendered.find((candidate) => candidate.id === id);
    assert(entry !== undefined, `missing rendered case ${id}`);
    return entry;
  };
  const rollup = byId("01");
  const window = byId("02");
  const topN = byId("04");
  const recursive = byId("07");
  const json = byId("10");

  assertStringIncludes(rollup.sql[0], 'insert into "sisal_adv_hourly_stats"');
  assertStringIncludes(rollup.sql[0], "strftime");
  // Contract 02: over()/avg()/rank() windows with a ROWS frame.
  assertStringIncludes(window.sql[0], "avg(");
  assertStringIncludes(
    window.sql[0],
    "rows between 5 preceding and current row",
  );
  assertStringIncludes(window.sql[0], "rank() over");
  // Contract 04: rowNumber() window in a derived table.
  assertStringIncludes(topN.sql[0], "row_number() over");
  // Contract 07: $withRecursive shape with a depth guard.
  assertStringIncludes(recursive.sql[0], 'with recursive "thread"');
  assertStringIncludes(recursive.sql[0], "union all");
  // Contract 10: jsonTable() -> SQLite json_each + json_extract.
  assertStringIncludes(json.sql[0], "json_each");
  assertStringIncludes(json.sql[0], "json_extract");
});

Deno.test("sqlite migrated cases bind runtime values", () => {
  const migrated = new Set(["02", "03", "04", "05", "06", "07", "08", "10"]);
  for (const entry of renderAdvancedSqlCases()) {
    if (!migrated.has(entry.id)) continue;
    assert(
      entry.params.some((params) => params.length > 0),
      `${entry.id} should bind runtime values`,
    );
  }
});

Deno.test("sqlite generated-column case is capability-gated raw DDL", () => {
  const ddl = advancedSqlCases().find((entry) => entry.id === "11");
  const rendered = renderAdvancedSqlCases().find((entry) => entry.id === "11");
  assert(ddl !== undefined);
  assert(rendered !== undefined);
  assertEquals(ddl.requires, "generated");
  assertStringIncludes(rendered.sql.join("\n"), "generated always as");
  assertStringIncludes(rendered.sql.join("\n"), "where title_text is not null");
});
