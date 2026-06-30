# 07 — Recursive comments (documentation-only future contract)

**Status:** documentation-only future contract. Not runnable; not in the
workspace.

**Roadmap owner:** [v0.8](../../docs/v0.8.0-roadmap.md) (the stabilized fragment
IR is where a `WITH RECURSIVE` builder belongs) with a portability checkpoint at
[v0.7 Workstream B](../../docs/v0.7.0-roadmap.md) (`@sisal/mysql` — MySQL 8 /
MariaDB 10.2+ have recursive CTEs; older MySQL does not). **Sisal's
`db.with(...)` is non-recursive today** — there is no `WITH RECURSIVE` surface.

**Related runnable examples:**
[`neon-rising-feed-ctes`](../neon-rising-feed-ctes/README.md) (the existing
CTE-shaped example — recursive CTEs are the next rung) and the `*-rising-feed`
siblings.

## Product use case

Threaded discussion: nested **comments** on a post, **course-discussion**
replies, **book-club** threads — any adjacency-list tree
(`comments.parent_id →
comments.id`). The query walks the tree from a root,
carrying **depth** and a sortable **path** so the UI can render the thread in
order with indentation, in one statement instead of N+1 round trips.

## SQL shape to preserve

```sql
WITH RECURSIVE thread AS (
  SELECT id, parent_id, body, author_id,
         0                              AS depth,
         lpad(id::text, 10, '0')        AS path
  FROM comments
  WHERE post_id = $post_id AND parent_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_id, c.body, c.author_id,
         t.depth + 1,
         t.path || '.' || lpad(c.id::text, 10, '0')
  FROM comments c
  JOIN thread t ON c.parent_id = t.id
)
SELECT id, parent_id, body, author_id, depth, path
FROM thread
ORDER BY path;
```

## Required future Sisal primitives

- **`WITH RECURSIVE`** — a recursive CTE builder: an anchor query `UNION ALL` a
  recursive query that references the CTE name. **Absent** — `db.with(...)` is
  non-recursive.
- **Self-reference binding** — the recursive arm must reference the CTE as a
  relation (`JOIN thread t …`); needs the CTE to expose typed column refs to its
  own recursive term.
- **String/path accumulation** (`path || …`) and a depth counter — expressible
  via `sql` fragments once the recursive frame exists.
- A **cycle / depth guard** option (Postgres 14+ `CYCLE`, or a `WHERE depth < N`
  cap) so a malformed tree can't loop forever.

## Dialect classification

| Capability            | PostgreSQL | Neon | SQLite    | libSQL | future MySQL                |
| --------------------- | ---------- | ---- | --------- | ------ | --------------------------- |
| `WITH RECURSIVE`      | engine ✅  | ✅   | engine ✅ | ✅     | 8+/MariaDB 10.2+ ✅, 5.7 ❌ |
| `UNION ALL` recursion | engine ✅  | ✅   | engine ✅ | ✅     | ✅ (modern)                 |
| **Sisal builder**     | ❌ none    | ❌   | ❌ none   | ❌     | ❌ none                     |

Recursive CTEs are one of the **more portable** advanced features — all four
current engines support them at the engine level; the wall is the missing
builder, not the dialects. The genuine split is **MySQL 5.7 (no recursion)** vs
MySQL 8 / MariaDB, recorded in
[12-mysql-compatibility](12-mysql-compatibility.md).

## Portable / emulatable / dialect-native / fail-guarded

- **Portable (once built):** the same `WITH RECURSIVE` renders on
  pg/neon/sqlite/ libsql and MySQL 8 — minor casts aside (`id::text` ↔ `CAST`).
- **Emulatable:** on a recursion-less engine, the only fallback is **iterative
  application-side fetching** (one query per level) — which defeats the example;
  prefer to **fail guarded** there.
- **Dialect-native:** path/cast syntax (`||` vs `CONCAT`, `lpad`) varies — hide
  behind the expression layer.
- **Fail guarded → feature-matrix:** an engine without `WITH RECURSIVE` (MySQL
  5.7) becomes a `❌` recursive-CTE row in
  [`docs/feature-matrix.md`](../../docs/feature-matrix.md); the builder throws a
  typed guard rather than emitting non-recursive SQL.

## Non-goals

Not a materialized-path or nested-set schema redesign, not comment moderation,
not pagination-within-thread. One recursive read of an adjacency-list tree.

## Future acceptance criteria

- A `withRecursive(...)` builder renders the SQL above on all four current
  engines, result-typed with `depth`/`path`, and ordered correctly.
- A depth/cycle guard is exercised by a deliberately cyclic fixture (no infinite
  loop).
- The MySQL split is pinned: ✅ on 8 / MariaDB, typed-guard `❌` on 5.7,
  recorded in the matrix.
