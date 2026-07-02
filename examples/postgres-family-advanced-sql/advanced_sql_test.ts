import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { advancedSqlCases, renderAdvancedSqlCases } from "./src/statements.ts";

Deno.test("postgres advanced SQL cases cover the graduated contracts", () => {
  const cases = advancedSqlCases();
  assertEquals(cases.map((entry) => entry.id), [
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

Deno.test("postgres advanced SQL renders builder ETL and raw windows", () => {
  const rendered = renderAdvancedSqlCases();
  const rollup = rendered.find((entry) => entry.id === "01");
  const windows = rendered.find((entry) => entry.id === "02");
  assert(rollup !== undefined);
  assert(windows !== undefined);
  assertStringIncludes(rollup.sql[0], 'insert into "sisal_adv_hourly_stats"');
  assertStringIncludes(rollup.sql[0], "count(*) filter");
  assertStringIncludes(rollup.sql[0], "on conflict");
  assertStringIncludes(windows.sql[0], "avg(votes) over");
  assertStringIncludes(windows.sql[0], "rank() over");
});

Deno.test("postgres raw advanced cases remain parameterized", () => {
  for (const entry of renderAdvancedSqlCases()) {
    if (entry.implementation !== "raw" && entry.implementation !== "hybrid") {
      continue;
    }
    if (entry.id === "09") {
      assert(entry.params.some((params) => params.length > 0));
      continue;
    }
    assert(
      entry.params.every((params) => params.length > 0),
      `${entry.id} should bind runtime values`,
    );
  }
});

Deno.test("postgres generated-column case stays raw DDL", () => {
  const ddl = renderAdvancedSqlCases().find((entry) => entry.id === "11");
  assert(ddl !== undefined);
  assertEquals(ddl.implementation, "raw-ddl");
  assertStringIncludes(ddl.sql.join("\n"), "generated always as");
  assertStringIncludes(ddl.sql.join("\n"), "where title_text is not null");
});
