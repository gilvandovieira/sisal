# Sisal examples

This directory holds two kinds of thing, kept deliberately separate:

1. **Runnable examples** — real Deno workspace packages (each has a `deno.json`
   - `mod.ts`), listed in the root `deno.json` `workspace` array and
     type-checked by `deno task check`. You can run them against a real
     database.
2. **Documentation-only future contracts** — Markdown-only scaffolds that
   preserve advanced-SQL example ideas before the features they need exist. They
   are **not runnable and not part of the workspace**.

## Runnable examples

Each is a workspace package; see its own `README` (where present) and
`deno.json` tasks for how to run it.

| Example                                                    | Engine        | What it shows                                                                                                 |
| ---------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| [`basic-postgres`](basic-postgres/)                        | PostgreSQL    | Minimal `@sisal/pg` CRUD walkthrough.                                                                         |
| [`basic-sqlite`](basic-sqlite/)                            | SQLite        | Minimal `@sisal/sqlite` CRUD walkthrough.                                                                     |
| [`basic-libsql`](basic-libsql/)                            | libSQL/Turso  | Minimal `@sisal/libsql` CRUD walkthrough.                                                                     |
| [`showcase-postgres`](showcase-postgres/)                  | PostgreSQL    | Broader feature tour on Postgres.                                                                             |
| [`showcase-sqlite`](showcase-sqlite/)                      | SQLite        | Broader feature tour on SQLite.                                                                               |
| [`neon-hot-feed`](neon-hot-feed/README.md)                 | Neon/Postgres | Stored, indexed `hot_score`; atomic vote; keyset.                                                             |
| [`neon-rising-feed`](neon-rising-feed/README.md)           | Neon/Postgres | `/rising` feed via a stored function.                                                                         |
| [`neon-rising-feed-ctes`](neon-rising-feed-ctes/README.md) | Neon/Postgres | `/rising` recompute as builder-native chained CTEs.                                                           |
| [`libsql-rising-feed`](libsql-rising-feed/README.md)       | libSQL/Turso  | The SQLite-family `/rising` counterpart.                                                                      |
| [`postgres-rising-feed`](postgres-rising-feed/README.md)   | PostgreSQL    | The plain-Postgres `/rising` feed.                                                                            |
| [`neon-activity-vectors`](neon-activity-vectors/README.md) | Neon/Postgres | Advanced-SQL analytics: events → buckets → stats → activity vector + similarity (the v0.6 ETL-readiness PoC). |

These are the source of truth for "what Sisal can do today." If you change one,
keep it runnable and keep its row in the root `deno.json` workspace.

## Documentation-only future contracts

[`advanced-sql-contracts/`](advanced-sql-contracts/README.md) — **not runnable,
not in the workspace.** Twelve Markdown contracts that preserve advanced-SQL
example ideas (ETL rollups, window analytics, sessionization, top-N, cohort
retention, funnels, recursive comments, job-queue locking, idempotent backfill,
JSON→table extraction, generated columns/indexes, and MySQL compatibility) and
map each to the roadmap release that must build the missing primitive first.

They exist so future planning can point at a concrete, product-shaped target
without pretending the feature already ships. When one becomes buildable, it
graduates into a real runnable example here (with its own `deno.json` +
`mod.ts`, added to the workspace) — at which point its contract becomes the
example's spec. Genuine per-dialect limits surfaced by a contract are tracked,
when the feature lands, as `❌` rows in
[`docs/feature-matrix.md`](../docs/feature-matrix.md).

> **Not part of `deno task check`.** `advanced-sql-contracts/` has no `mod.ts`
> and is intentionally excluded from the root workspace, so adding contracts
> never touches the type-check or test surface.
