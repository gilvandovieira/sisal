import { assertEquals } from "@std/assert";

import { runLive } from "./mod.ts";

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

Deno.test({
  name: "sqlite advanced SQL smoke executes when opted in",
  ignore: env("SISAL_SQLITE_ADVANCED_SQL_IT") !== "1",
  async fn() {
    await runLive();
    assertEquals(true, true);
  },
});
