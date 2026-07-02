---
title: Portability policies
---

# Portability policies

The cross-family value and lifecycle policies Sisal's examples, adapters, and
tests follow (v0.8 item 17). Per-engine details live in the
`docs/*-compatibility.md` pages; this page states the policies once.

## UTC literal policy (MySQL-family `DATETIME(6)`)

MySQL/MariaDB `DATETIME` rejects zone designators: a trailing `Z` or offset in a
datetime literal is a syntax error. The policy — the "executor UTC convention"
(v0.7 B8):

- **Store UTC, always.** `DATETIME(6)` columns carry naive UTC.
- Literals are written `YYYY-MM-DD HH:mm:ss.SSS000` (no `Z`, no offset).
- The core renderer tags `Temporal.Instant`/`ZonedDateTime` params and rewrites
  them to naive UTC **under the `mysql` render dialect only**; the MySQL
  adapter's pool sets `dateStrings: true` so values read back as the server's
  exact text instead of timezone-shifted client `Date`s.
- A `mode: "string"` timestamp column must be given a MySQL-valid literal (no
  `Z`) by the caller.

## `dateTrunc` / `dateBin` / `dateDiff` value shapes

The date helpers are dialect-mapped and their **result shapes differ by family**
— treat them as grouping/predicate values, not as portable timestamps:

| Helper      | PostgreSQL/Neon        | SQLite family (text)      | MySQL family (text)      |
| ----------- | ---------------------- | ------------------------- | ------------------------ |
| `dateTrunc` | `timestamp`            | `strftime` string         | `DATE_FORMAT` string     |
| `dateBin`   | `timestamp`            | `datetime` string         | `FROM_UNIXTIME` value    |
| `dateDiff`  | number (`trunc`/epoch) | number (`julianday` cast) | number (`TIMESTAMPDIFF`) |

Policy: compare bucketed values **within one engine** (group keys, keyset
cursors, window partitions); never compare a bucket string from one family with
a timestamp from another. `dateDiff` returns whole units truncated toward zero
on every family (live-verified identical values).

## DDL-cleanup pattern (no transactional DDL on the MySQL family)

PostgreSQL DDL is transactional — tests and showcases can wrap schema work in a
transaction and roll it back. MySQL/MariaDB DDL **implicitly commits**, so that
pattern silently breaks. The policy:

- Tests/examples against the MySQL family create **namespaced tables** (`it_*`,
  `w3_*`, …) and drop them in explicit cleanup steps, never relying on rollback.
- `@sisal/mysql`'s migrator defaults `useTransaction: false` for the same reason
  (a transaction around schema migrations would be a false promise); opt in only
  for DML-only migrations.
- Anything portable that must be atomic across engines belongs in DML (one
  transaction / `db.batch`), never mixed DML+DDL.

## Upsert (`ON DUPLICATE KEY UPDATE`) assignment order

PostgreSQL's `ON CONFLICT DO UPDATE SET …` reads the **pre-update row**
uniformly: a bare column reference in any assignment sees the existing value,
regardless of assignment order. MySQL/MariaDB's `ON DUPLICATE KEY UPDATE`
evaluates assignments **left-to-right**, so a reference to a sibling column set
**earlier** in the same statement sees that column's **already-updated** value.
The same builder can therefore compute different results per engine. The policy:

- **Assignment order is rendered verbatim** — the object key order of
  `onConflictDoUpdate({ set })` is the SQL order on every dialect, so the author
  controls MySQL's left-to-right evaluation deliberately.
- **Reference the proposed row with `excluded()`** (renders `VALUES(col)` on the
  MySQL family) when an assignment needs the incoming value; this is
  order-independent and always safe.
- **Order derived columns first.** A column computed from the _old_ values of
  siblings must be assigned before those siblings are updated, so it reads the
  pre-update values on MySQL too.
- **The renderer enforces this.** An ODKU assignment that reads a _different_
  sibling column set earlier in the same list throws a typed
  `ORM_DIALECT_UNSUPPORTED` under the `mysql` render dialect (naming both
  columns and the fix), rather than silently diverging from PostgreSQL.
  Self-references (`col = col + 1`), forward references (derived-first), and
  `excluded()` all pass.
