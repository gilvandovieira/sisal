# Advanced SQL example contracts

**Status:** Markdown contracts. **Nothing in this directory is runnable, and
none of it is part of the Deno workspace** (it is intentionally absent from the
root `deno.json` and the `deno task check` entrypoint list). There is no
`mod.ts`, no `deno.json`, and no code to execute here — only Markdown.

These files are compatibility contracts. Each one preserves an advanced-SQL
example idea — product-shaped, with the concrete SQL it would need — so that
planning can point at a real target instead of re-inventing it later. The first
runnable graduation lives in sibling workspace packages:
[`postgres-family-advanced-sql`](../postgres-family-advanced-sql/),
[`mysql-family-advanced-sql`](../mysql-family-advanced-sql/), and
[`sqlite-family-advanced-sql`](../sqlite-family-advanced-sql/). Those examples
use Sisal builders where the surface exists and safe parameterized `sql` where
the database can run the shape but Sisal still lacks the primitive.

> Why keep contracts after graduation? A runnable example proves today's
> executable shape. The contract records the long-lived product target and the
> missing Sisal primitive, especially when the runnable example still uses raw
> `sql` or skips a dialect.

## Runnable graduation status

| #  | Contract                                                       | PostgreSQL/Neon                           | MySQL/MariaDB                             | SQLite/libSQL                                      |
| -- | -------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| 01 | [ETL rollup](01-etl-rollup.md)                                 | runnable builder                          | runnable builder                          | runnable builder                                   |
| 02 | [Window analytics](02-window-analytics.md)                     | runnable parameterized raw SQL            | runnable parameterized raw SQL            | capability-probed parameterized raw SQL            |
| 03 | [Sessionization](03-sessionization.md)                         | runnable parameterized raw SQL            | runnable parameterized raw SQL            | skipped until portable date/window helpers         |
| 04 | [Top-N per group](04-top-n-per-group.md)                       | runnable parameterized raw SQL            | runnable parameterized raw SQL            | capability-probed parameterized raw SQL            |
| 05 | [Cohort retention](05-cohort-retention.md)                     | runnable parameterized raw SQL            | runnable parameterized raw SQL            | skipped until date-bucket semantics are normalized |
| 06 | [Funnel analysis](06-funnel-analysis.md)                       | runnable parameterized raw SQL            | runnable parameterized raw SQL            | skipped until first-event helpers land             |
| 07 | [Recursive comments](07-recursive-comments.md)                 | runnable parameterized raw SQL            | runnable parameterized raw SQL            | capability-probed parameterized raw SQL            |
| 08 | [Job-queue locking](08-job-queue-locking.md)                   | runnable builder `FOR UPDATE SKIP LOCKED` | runnable builder `FOR UPDATE SKIP LOCKED` | capability-probed CAS `UPDATE ... RETURNING`       |
| 09 | [Idempotent backfill](09-idempotent-backfill.md)               | runnable builder/raw hybrid               | runnable builder/raw hybrid               | skipped until checkpoint contracts land            |
| 10 | [JSON → table extraction](10-json-table-extraction.md)         | runnable parameterized raw SQL            | runnable parameterized raw `JSON_TABLE`   | capability-probed `json_each`                      |
| 11 | [Generated columns & indexes](11-generated-columns-indexes.md) | runnable raw DDL                          | generated-column DDL; no partial index    | capability-probed raw DDL                          |
| 12 | [MySQL compatibility](12-mysql-compatibility.md)               | cross-reference only                      | runnable pressure cases + typed guards    | not applicable                                     |

## How a contract maps to the roadmap

Each contract names a **roadmap owner** — the release(s) that must land the
missing primitive before the example can become runnable. The chain the
contracts ride on:

| Release   | Theme                                 | What it unblocks for these contracts                                |
| --------- | ------------------------------------- | ------------------------------------------------------------------- |
| **v0.6**  | Foundations & Readiness               | ETL-rollup verify, locking + checkpoint design, MySQL investigation |
| **v0.7**  | Analytics Readiness & MySQL Support   | analytics IR sketch; ships `@sisal/mysql`                           |
| **v0.8**  | Advanced SQL IR (`@sisal/core`)       | recursive CTEs, array/`unnest`, JSON-table IR                       |
| **v0.9**  | Adapter Hardening & Capability Matrix | generated columns / partial+expression index DDL                    |
| **v0.10** | `@sisal/etl` Preview                  | the ETL job + runner + checkpoint + lock                            |
| **v0.11** | `@sisal/analytics` Preview            | window functions, ranking, period comparisons                       |

## Dialect gaps are tracked in the feature matrix

When a contract finds work that **genuinely cannot run on a dialect** (no
equivalent SQL, not just a missing builder), that is not a failure to hide — we
move on and **record it**. The durable, test-backed home for "doesn't work here"
is [`docs/feature-matrix.md`](../../docs/feature-matrix.md) (generated from
`tools/feature_matrix.ts`; legend: ✅ tested · ⚠️ works with a round-trip
difference · ❌ genuine dialect limit · — not applicable).

So each contract's **dialect classification** is the design-time precursor to a
matrix row: the "fail guarded" bucket becomes a `❌` cell once the feature lands
and a guard/test pins it. The advanced SQL examples do not add feature-matrix
rows yet. `deno task docs:matrix:check` requires every ✅/⚠️ to be backed by a
named integration scenario, and these examples are mostly render/smoke
demonstrations plus roadmap pressure points. Matrix rows are added only when the
feature becomes a supported Sisal capability.

## Contract template

Every file in this directory follows the same skeleton:

- **Status** — documentation-only future contract.
- **Roadmap owner** — the release(s) that unblock it.
- **Related runnable examples** — the existing examples it extends.
- **Product use case** — the real thing it would demonstrate.
- **SQL shape to preserve** — the target SQL, written out.
- **Required future Sisal primitives** — what must be built first.
- **Dialect classification** — PostgreSQL · Neon · SQLite · libSQL · future
  MySQL.
- **Portable / emulatable / dialect-native / fail-guarded** — the honest split,
  and what becomes a `❌` feature-matrix row.
- **Non-goals** — what the example must _not_ turn into.
- **Future acceptance criteria** — the bar for it to become runnable.

## The contracts

| #  | Contract                                                       | Roadmap owner             | Core gap                          |
| -- | -------------------------------------------------------------- | ------------------------- | --------------------------------- |
| 01 | [ETL rollup](01-etl-rollup.md)                                 | v0.6 A1/A3/A4 → v0.10     | verify + pin (mostly built)       |
| 02 | [Window analytics](02-window-analytics.md)                     | v0.7 → v0.11              | window functions (none today)     |
| 03 | [Sessionization](03-sessionization.md)                         | v0.7 → v0.11              | window functions + gap grouping   |
| 04 | [Top-N per group](04-top-n-per-group.md)                       | v0.7 → v0.11              | `row_number() OVER (PARTITION …)` |
| 05 | [Cohort retention](05-cohort-retention.md)                     | v0.6 + v0.7 → v0.10/v0.11 | CTEs + buckets + analytics        |
| 06 | [Funnel analysis](06-funnel-analysis.md)                       | v0.7 → v0.11              | first-event windows + comparisons |
| 07 | [Recursive comments](07-recursive-comments.md)                 | v0.8 + v0.7 (MySQL)       | `WITH RECURSIVE` builder          |
| 08 | [Job-queue locking](08-job-queue-locking.md)                   | v0.6 A2 → v0.10           | per-dialect locking strategy      |
| 09 | [Idempotent backfill](09-idempotent-backfill.md)               | v0.6 A3/A4 → v0.10        | checkpoint / watermark table      |
| 10 | [JSON → table extraction](10-json-table-extraction.md)         | v0.8 + v0.6/v0.7 (MySQL)  | per-dialect JSON-table IR         |
| 11 | [Generated columns & indexes](11-generated-columns-indexes.md) | v0.8 + v0.9               | DDL for generated/expr/partial    |
| 12 | [MySQL compatibility](12-mysql-compatibility.md)               | v0.6 C + v0.7 B           | the `@sisal/mysql` adapter        |

See [`examples/README.md`](../README.md) for how these relate to the
**runnable** examples.
