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
  assertEquals(skipped, ["03", "05", "06", "09"]);
});

Deno.test("sqlite renders builder ETL and optional raw cases", () => {
  const rendered = renderAdvancedSqlCases();
  const rollup = rendered.find((entry) => entry.id === "01");
  const topN = rendered.find((entry) => entry.id === "04");
  const json = rendered.find((entry) => entry.id === "10");
  assert(rollup !== undefined);
  assert(topN !== undefined);
  assert(json !== undefined);
  assertStringIncludes(rollup.sql[0], 'insert into "sisal_adv_hourly_stats"');
  assertStringIncludes(rollup.sql[0], "strftime");
  assertStringIncludes(topN.sql[0], "row_number() over");
  assertStringIncludes(json.sql[0], "json_each");
});

Deno.test("sqlite raw optional cases remain parameterized", () => {
  for (const entry of renderAdvancedSqlCases()) {
    if (entry.implementation !== "raw") continue;
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
