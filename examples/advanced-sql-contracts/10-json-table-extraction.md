# 10 — JSON → table extraction (documentation-only future contract)

**Status:** documentation-only future contract. Not runnable; not in the
workspace.

**Roadmap owner:** [v0.8](../../docs/v0.8.0-roadmap.md) (the expression/IR layer
where a set-returning JSON function belongs), with explicit **MySQL
investigation** in [v0.6 Workstream C](../../docs/v0.6.0-roadmap.md) and
implementation in [v0.7 Workstream B](../../docs/v0.7.0-roadmap.md). **This is a
dialect-specific contract** — every engine spells JSON-to-rows differently, so
there is no single portable shape.

**Related runnable examples:**
[`neon-activity-vectors`](../postgres-family-activity-vectors/README.md) (it
already round-trips `json`/`jsonb` columns and documents the SQLite-family TEXT
serialization divergence) and the `showcase-*` examples.

## Product use case

A webhook / import lands a **JSON payload** holding an array of line items
(`{"items":[{"sku":"A","qty":2}, …]}`), and the job must **explode it into
relational rows** — one row per item — to insert into a normalized table. This
is the "shred a document into a table" step every ingestion pipeline needs.

## SQL shape to preserve

The shape is **per dialect** — that is the whole point of this contract:

```sql
-- PostgreSQL / Neon: jsonb_to_recordset (typed columns) or jsonb_array_elements
SELECT x.sku, x.qty
FROM orders o,
     jsonb_to_recordset(o.payload -> 'items')
       AS x(sku text, qty int)
WHERE o.id = $id;
```

```sql
-- SQLite / libSQL: json_each over the array, json_extract per field
SELECT json_extract(e.value, '$.sku') AS sku,
       json_extract(e.value, '$.qty') AS qty
FROM orders o, json_each(o.payload, '$.items') AS e
WHERE o.id = $id;
```

```sql
-- future MySQL 8: JSON_TABLE (investigate in v0.6 C / build in v0.7 B)
SELECT t.sku, t.qty
FROM orders o,
     JSON_TABLE(o.payload, '$.items[*]'
       COLUMNS (sku VARCHAR(64) PATH '$.sku',
                qty INT         PATH '$.qty')) AS t
WHERE o.id = $id;
```

## Required future Sisal primitives

- **A set-returning JSON-table builder** that compiles to the right native
  function per dialect (`jsonb_to_recordset` / `json_each` / `JSON_TABLE`) with
  a **typed column spec** so the exploded rows infer their shape. **Absent.**
- **JSON path extraction** (`-> '$.x'` / `json_extract` / `PATH '$.x'`) as a
  portable expression. Partially expressible via the `sql` tag today; no typed
  surface.
- **`FROM`-clause function application** (a table-valued function in `FROM`) —
  the builder has no set-returning-function-in-`FROM` surface; this overlaps the
  `unnest` gap in [02-window-analytics](02-window-analytics.md).

## Dialect classification

| Capability              | PostgreSQL              | Neon  | SQLite               | libSQL       | future MySQL (8+)    |
| ----------------------- | ----------------------- | ----- | -------------------- | ------------ | -------------------- |
| JSON array → rows       | `jsonb_to_recordset` ✅ | ✅    | `json_each` ✅       | ✅           | `JSON_TABLE` ✅      |
| typed column projection | ✅ native columns       | ✅    | extract+cast         | extract+cast | `COLUMNS(...)`       |
| **Sisal builder**       | ❌ none                 | ❌    | ❌ none              | ❌           | ❌ none              |
| storage of JSON         | `json`/`jsonb` typed    | typed | TEXT (parse on read) | TEXT         | `JSON` (=`LONGTEXT`) |

Every cell is a **different native function** — this is the canonical
"dialect-native, not portable" contract.

## Portable / emulatable / dialect-native / fail-guarded

- **Portable (the _abstraction_, not the SQL):** one typed
  `jsonTable(col, path,
  columns)` builder can target all four (+MySQL) by
  compiling to each native function — the API is portable even though no SQL
  string is.
- **Emulatable:** on engines lacking a typed projection (SQLite/libSQL), emulate
  via `json_each` + `json_extract` + casts; values come back as TEXT and parse
  on read (the documented SQLite-family round-trip).
- **Dialect-native:** `jsonb_to_recordset`, `json_each`, `JSON_TABLE` are each
  native and non-interchangeable.
- **Fail guarded → feature-matrix:** an engine/version without any JSON-table
  function (very old SQLite without the JSON1 extension; MySQL 5.7 lacks
  `JSON_TABLE`) becomes a `❌` json-table row in
  [`docs/feature-matrix.md`](../../docs/feature-matrix.md) with a typed guard.

## Non-goals

Not a JSON schema validator, not arbitrary JSONPath, not document storage as a
first-class model. One "explode a known array field into typed rows" operation.

## Future acceptance criteria

- A typed `jsonTable(...)` builder renders the correct native function on each
  engine and infers the exploded row type from the column spec.
- The same logical extraction is proven equal across pg/neon (recordset),
  sqlite/libsql (json_each), and — once `@sisal/mysql` lands — MySQL 8
  (`JSON_TABLE`), on a shared fixture payload.
- Engines/versions without a JSON-table function throw a typed guard and are
  `❌` in the matrix.
