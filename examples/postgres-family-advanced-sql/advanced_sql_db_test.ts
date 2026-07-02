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
  name: "postgres advanced SQL smoke executes when opted in",
  ignore: env("SISAL_POSTGRES_ADVANCED_SQL_IT") !== "1" ||
    env("DATABASE_URL") === undefined,
  async fn() {
    await runLive(env("DATABASE_URL")!);
    assertEquals(true, true);
  },
});
