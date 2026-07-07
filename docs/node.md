---
title: Use Sisal from Node
---

# Use Sisal from Node/npm

Sisal is JSR-first and Deno-native, and the same package set is published to
**npm** under the **`@sisaljs`** scope for **Node.js 24+**. The API is identical
to the JSR packages; the install command, import scope, and adapter driver peer
dependencies are the parts that differ (`@sisal/*` on JSR → `@sisaljs/*` on
npm).

> Requirements: **Node 24+**. Node 24 runs ESM natively and ships the built-in
> `node:sqlite` driver. The npm build is **ESM-only**.
>
> **Temporal:** Sisal is Temporal-native. A native `Temporal` global arrives in
> **Node 25+**; on Node 24 it is available behind `node --harmony-temporal`, or
> install
> [`@js-temporal/polyfill`](https://www.npmjs.com/package/@js-temporal/polyfill)
> and set `globalThis.Temporal` before importing Sisal. **Without a `Temporal`
> global, Sisal still runs** — non-temporal columns and queries work normally;
> only date/time (`Temporal`) values need the global.

## Install

Each engine family is one adapter plus its driver (a peer dependency you install
yourself, so a Postgres app never pulls in `mysql2`):

```sh
# PostgreSQL (postgres.js)
npm i @sisaljs/orm @sisaljs/pg postgres

# SQLite — no driver needed; uses the built-in node:sqlite
npm i @sisaljs/orm @sisaljs/sqlite

# MySQL / MariaDB (mysql2; add `mariadb` for the MariaDB connector)
npm i @sisaljs/orm @sisaljs/mysql mysql2

# Migrations CLI
npm i -D @sisaljs/migrate
```

## Query

```js
import { columns, createSchemaSnapshot, defineTable, eq } from "@sisaljs/orm";
import { connect } from "@sisaljs/sqlite";
import { generateSqliteUpStatements } from "@sisaljs/sqlite/ddl";

const posts = defineTable("posts", {
  id: columns.integer().primaryKey(),
  title: columns.text().notNull(),
  views: columns.integer().notNull().default(0),
});

const { statements } = generateSqliteUpStatements(
  createSchemaSnapshot({ dialect: "sqlite", tables: [posts] }),
);

const db = await connect({ path: ":memory:" });
for (const statement of statements) await db.execute(statement);
await db.insert(posts).values({ id: 1, title: "hello", views: 20 }).execute();
const rows = await db.select().from(posts).where(eq(posts.columns.views, 20))
  .execute();
await db.close();
```

Runnable examples live in [`examples/node/`](../examples/node/) — one per engine
family (`sqlite`, `pg`, `mysql`).

## Migrations CLI

`@sisaljs/migrate` ships a `sisal` bin:

```sh
npx sisal init --target postgres   # scaffolds sisal.migrate.ts for Node
npx sisal generate initial
npx sisal migrate
```

`sisal init` detects the runtime and scaffolds a Node-flavored config (npm scope
imports, `process.env` for secrets). The config file is `sisal.migrate.ts` —
Node 24 runs TypeScript directly.

## Runtime notes

- **SQLite** uses the built-in `node:sqlite` (`DatabaseSync`) — the one adapter
  with a real Deno-vs-Node driver fork. Injected databases bypass it.
- **PostgreSQL** queries are **prepared** by default (postgres.js); pass
  `connect({ url, prepare: false })` for PgBouncer/Neon transaction pooling.
- **bigint** comes back as `string` (pg/mysql) or `BigInt`; normalize with
  `String(...)` if you mix engines.
- **Bun** is not yet supported: it lacks `node:sqlite` and (as of 1.3) a native
  `Temporal` global.
