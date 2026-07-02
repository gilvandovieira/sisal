# MySQL-family rising feed (Sisal example)

The MySQL/MariaDB counterpart to
[`postgres-family-feed`](../postgres-family-feed/) and
[`sqlite-family-feed`](../sqlite-family-feed/). It builds the same product
feature:

- posts;
- 5-minute activity buckets;
- unique actor dedupe;
- stored `rising_score`;
- `/new` and `/rising` feeds with keyset pagination.

It deliberately keeps MySQL-family differences visible:

- ids are `varchar(36)` UUID strings, not `text`, because MySQL cannot key
  `TEXT`;
- timestamps are UTC `DATETIME(6)` strings like `2026-06-28 12:00:00.000000`,
  not ISO strings with `Z`;
- upserts render as `ON DUPLICATE KEY UPDATE`;
- MySQL proper has no general `RETURNING`, so the CTE recompute writes and then
  fetches;
- actor dedupe pre-checks the actor row and then uses mutation `rowCount` from
  `onConflictDoNothing()` on the insert path, because rowCount alone is not a
  reliable inserted-vs-conflicted signal for Sisal's portable MySQL no-op
  upsert;
- the bucket upsert assigns the derived `activity_score` before incrementing the
  counters because MySQL evaluates `ON DUPLICATE KEY UPDATE` assignments
  left-to-right.

## Run

```sh
cd examples/mysql-family-feed
docker compose up -d
cp .env.example .env

deno task reset
deno task seed
deno task demo
```

Driver selection:

```sh
SISAL_ADAPTER=mysql2 deno task demo
SISAL_ADAPTER=mariadb MARIADB_URL=mysql://root:root@localhost:33110/sisal \
  deno task demo
```

Connection URL precedence is `MYSQL_URL ?? MARIADB_URL ?? DATABASE_URL`.

## What To Look At

- `src/schema.ts` — typed table mirrors using `varchar(36)` keys and
  `DATETIME(6)` strings.
- `src/rising.ts` — deterministic score model and MySQL-safe timestamp helpers.
- `src/activity.ts` — transactional activity recording, actor dedupe, and bucket
  upsert.
- `src/recompute.ts` — portable TypeScript recompute + `db.batch`.
- `src/recompute_ctes.ts` — builder-native chained CTE recompute,
  `filter(sum(...))`, `dateSub`, MySQL multi-table `UPDATE`, MariaDB fallback,
  then fetch-after-write.
- `src/queries.ts` — `/new` and `/rising` keyset feeds.

## Tests

Network-free:

```sh
deno test --allow-read rising_test.ts
```

Live MySQL:

```sh
SISAL_MYSQL_RISING_FEED_IT=1 \
MYSQL_URL=mysql://root:root@localhost:33084/sisal \
deno test -A feed_db_test.ts
```

Live MariaDB:

```sh
SISAL_MARIADB_RISING_FEED_IT=1 SISAL_ADAPTER=mariadb \
MARIADB_URL=mysql://root:root@localhost:33110/sisal \
deno test -A feed_db_test.ts
```

## v0.8 Pressure Points

This example feeds the v0.8 IR/core roadmap:

- CTE recompute repeats filtered aggregate fragments because expression aliases
  are not first-class enough yet.
- `coalesce`, `greatest`, and the derived `rising_score` expression still use
  raw `sql` fragments.
- The composition wants a stable statement-assembly or `@sisal/core` compile
  target, but today it depends on ORM builders.
- Capability checks need variant/version facts: MySQL and MariaDB share one
  adapter, but `RETURNING` is different.
