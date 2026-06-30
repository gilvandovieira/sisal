# 11 — Generated columns & indexes (documentation-only future contract)

**Status:** documentation-only future contract. Not runnable; not in the
workspace.

**Roadmap owner:** [v0.8](../../docs/v0.8.0-roadmap.md) (the IR/expression work
that makes a generated-column/expression-index expression first-class) and
[v0.9](../../docs/v0.9.0-roadmap.md) (adapter hardening + the capability matrix
where the DDL divergences land). This is a **schema/DDL contract** — it extends
the snapshot → DDL pipeline; do **not** implement it as part of this scaffold.

**Related runnable examples:** [`neon-hot-feed`](../neon-hot-feed/README.md)
(stores + indexes a computed `hot_score`; its README already flags richer-DDL as
a pressure point) and
[`neon-activity-vectors`](../neon-activity-vectors/README.md) (named, indexable
feature columns).

## Product use case

Push computed values and filtered hot-paths **into the schema** instead of
recomputing them per query: a **generated column** (`search_text` derived from
other columns, or `hot_bucket` from `hot_score`), an **expression index** (index
`lower(email)` for case-insensitive lookup), and a **partial index** (index only
`WHERE status = 'active'` to keep the index small and fast). These are the
schema-level performance moves the `*-feed` examples reach for and currently
can't express in the snapshot.

## SQL shape to preserve

```sql
-- generated (stored) column
ALTER TABLE posts
  ADD COLUMN title_search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', title)) STORED;

-- expression index
CREATE INDEX users_lower_email_idx ON users (lower(email));

-- partial index
CREATE INDEX posts_active_hot_idx ON posts (hot_score DESC)
  WHERE status = 'active';
```

## Required future Sisal primitives

Today the snapshot → DDL pipeline emits **additive**
`CREATE TABLE`/`ADD COLUMN`, DESC index ordering (v0.4), `CHECK`, and `sql`
server defaults (v0.5). Missing:

- **Generated-column DDL** — `.generatedAs(sql\`…\`, { stored
  })`carried into
  the snapshot and emitted as`GENERATED ALWAYS AS (…)
  STORED`/`VIRTUAL`.
- **Expression indexes** — an index over an expression, not just columns
  (`index(lower(email))`).
- **Partial indexes** — an index with a `WHERE` predicate.
- **Per-dialect emission** in `generate{Postgres,Sqlite,Libsql}UpStatements`
  (and a future `generateMysqlUpStatements`) — each engine spells these
  differently, and some not at all.
- The usual **destructive-diff withholding** must extend to these (a changed
  generation expression is an alter, not additive).

## Dialect classification

| Capability         | PostgreSQL        | Neon | SQLite                    | libSQL | future MySQL      |
| ------------------ | ----------------- | ---- | ------------------------- | ------ | ----------------- |
| generated columns  | ✅ stored/virtual | ✅   | ✅ (3.31+) stored/virtual | ✅     | ✅ stored/virtual |
| expression indexes | ✅                | ✅   | ✅ (3.9+)                 | ✅     | ✅ (8.0.13+ func) |
| partial indexes    | ✅                | ✅   | ✅                        | ✅     | ❌ none           |
| **Sisal DDL emit** | ❌                | ❌   | ❌                        | ❌     | ❌                |

The standout split: **MySQL has no partial indexes** — a genuine `❌` to record,
the kind your "if it can't be done on a database, the matrix tracks it" rule is
for.

## Portable / emulatable / dialect-native / fail-guarded

- **Portable (once the DDL exists):** generated columns and expression indexes
  render on pg/neon/sqlite/libsql and MySQL 8; the snapshot stays one source of
  truth.
- **Emulatable:** a partial index on MySQL emulates poorly (a generated boolean
  column + a full index, or a filtered application query) — document it as a
  non-equivalent emulation, prefer **fail guarded**.
- **Dialect-native:** `tsvector`/`to_tsvector` generation is Postgres-native;
  the SQLite family has no `tsvector` (use FTS5 separately) — a per-engine wall.
- **Fail guarded → feature-matrix:** **partial indexes on MySQL** and
  **`tsvector` generation off Postgres** become `❌` rows in
  [`docs/feature-matrix.md`](../../docs/feature-matrix.md); the DDL generator
  withholds them with a typed reason rather than emitting invalid SQL.

## Non-goals

Not full-text-search design, not a migration auto-`ALTER` for changed generation
expressions (destructive diffs stay withheld), not covering-index tuning advice.
A schema that _declares_ generated columns + expression/partial indexes and
generates correct additive DDL per dialect.

## Future acceptance criteria

- `defineTable` can declare a generated column and expression/partial indexes;
  `generate*UpStatements` emit correct DDL per dialect, pinned by render tests.
- Unsupported combinations (partial index on MySQL, `tsvector` off Postgres)
  throw a typed guard and are `❌` in the matrix — verified, not assumed.
- Round-trip integration tests confirm a generated column computes and an
  expression/partial index is used by the planner on each supporting engine.
