import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { advancedSqlCases, renderAdvancedSqlCases } from "./src/statements.ts";

Deno.test("mysql advanced SQL cases cover the graduated contracts", () => {
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

Deno.test("mysql advanced SQL renders ODKU rollup and raw windows", () => {
  const rendered = renderAdvancedSqlCases();
  const rollup = rendered.find((entry) => entry.id === "01");
  const windows = rendered.find((entry) => entry.id === "02");
  assert(rollup !== undefined);
  assert(windows !== undefined);
  assertStringIncludes(rollup.sql[0], "insert into `sisal_adv_hourly_stats`");
  assertStringIncludes(rollup.sql[0], "on duplicate key update");
  assertStringIncludes(rollup.sql[0], "count(case when");
  assertStringIncludes(windows.sql[0], "avg(votes) over");
  assertStringIncludes(windows.sql[0], "rank() over");
});

Deno.test("mysql raw advanced cases remain parameterized", () => {
  for (const entry of renderAdvancedSqlCases()) {
    if (entry.implementation !== "raw" && entry.implementation !== "hybrid") {
      continue;
    }
    assert(
      entry.params.some((params) => params.length > 0),
      `${entry.id} should bind runtime values`,
    );
  }
});

Deno.test("mysql returning pressure case is a typed guard", () => {
  const compatibility = renderAdvancedSqlCases().find((entry) =>
    entry.id === "12"
  );
  assert(compatibility !== undefined);
  assertEquals(compatibility.implementation, "guarded");
  assertStringIncludes(compatibility.sql[0], "on duplicate key update");
  assertStringIncludes(compatibility.errors.join("\n"), "RETURNING");
});

Deno.test("mysql generated-column case omits partial-index emulation", () => {
  const ddl = renderAdvancedSqlCases().find((entry) => entry.id === "11");
  assert(ddl !== undefined);
  assertEquals(ddl.implementation, "raw-ddl");
  assertStringIncludes(ddl.sql.join("\n"), "generated always as");
  assert(!ddl.sql.join("\n").includes(" where "));
});
