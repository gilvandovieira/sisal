import { assertEquals } from "@std/assert";

import { runLive } from "./mod.ts";

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

const runMysql = env("SISAL_MYSQL_ADVANCED_SQL_IT") === "1";
const runMariadb = env("SISAL_MARIADB_ADVANCED_SQL_IT") === "1";
const url = runMariadb
  ? env("MARIADB_URL") ?? env("DATABASE_URL")
  : env("MYSQL_URL") ?? env("DATABASE_URL");

Deno.test({
  name: "mysql-family advanced SQL smoke executes when opted in",
  ignore: (!runMysql && !runMariadb) || url === undefined,
  async fn() {
    await runLive(url!);
    assertEquals(true, true);
  },
});
