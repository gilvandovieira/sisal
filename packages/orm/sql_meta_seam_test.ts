/**
 * The additive IR extension seam (v0.8 item 4): opaque `meta` annotations on
 * `SqlChunk` survive composition through the `sql` tag and the query
 * builders, never change rendered output, and round-trip back out of a
 * composed statement — proving a future transformable AST can attach origin
 * data here as a non-breaking version bump.
 */
import { assert, assertEquals } from "@std/assert";
import {
  columns,
  createDatabase,
  defineTable,
  eq,
  renderSql,
  sql,
  sqlChunkMeta,
  withSqlChunkMeta,
} from "./mod.ts";
import type { Sql, SqlChunk, SqlChunkMeta, SqlExpression } from "./mod.ts";

const db = createDatabase({ dialect: "postgres" });

const posts = defineTable("posts", {
  id: columns.integer().primaryKey(),
  hotScore: columns.integer().notNull().default(0),
});

// Depth-first chunk walk, following nested `sql` chunks the way composition
// nests fragments.
function collectMeta(fragment: Sql): SqlChunkMeta[] {
  const found: SqlChunkMeta[] = [];
  const visit = (chunk: SqlChunk) => {
    const meta = sqlChunkMeta(chunk);
    if (meta !== undefined) {
      found.push(meta);
    }
    if (chunk.kind === "sql") {
      chunk.value.chunks.forEach(visit);
    }
  };
  fragment.chunks.forEach(visit);
  return found;
}

Deno.test("meta seam: annotations ride through sql-tag composition", () => {
  const fragment = sql`${posts.columns.hotScore} > ${5}`;
  const annotated = withSqlChunkMeta(fragment, {
    origin: "analytics:threshold",
  });
  const statement = sql`select * from posts where ${annotated}`;

  // Rendering is unaffected — annotated and plain render byte-identically.
  const plain = sql`select * from posts where ${fragment}`;
  for (const dialect of ["postgres", "sqlite", "mysql", "generic"] as const) {
    assertEquals(
      renderSql(statement, { dialect }),
      renderSql(plain, { dialect }),
    );
  }

  // The annotations round-trip out of the composed statement.
  const metas = collectMeta(statement);
  assert(metas.length > 0);
  assert(metas.every((meta) => meta.origin === "analytics:threshold"));
});

Deno.test("meta seam: annotations survive builder assembly", () => {
  const metric = withSqlChunkMeta(
    sql`${posts.columns.hotScore} * 2`,
    { origin: "analytics:metric", node: "doubleScore" },
  ) as SqlExpression<number>;
  const query = db.select({ id: posts.columns.id, doubled: metric })
    .from(posts).where(eq(posts.columns.id, 1)).toSql();

  const rendered = renderSql(query, { dialect: "postgres" });
  assertEquals(
    rendered.text,
    'select "posts"."id" as "id", "posts"."hot_score" * 2 as "doubled" ' +
      'from "posts" where "posts"."id" = $1',
  );

  const metas = collectMeta(query);
  assert(metas.some((meta) => meta.node === "doubleScore"));
});

Deno.test("meta seam: re-annotation merges over existing annotations", () => {
  const fragment = withSqlChunkMeta(sql`1 + 1`, { origin: "a", keep: true });
  const merged = withSqlChunkMeta(fragment, { origin: "b" });
  const metas = collectMeta(merged);
  assert(metas.length > 0);
  assert(metas.every((meta) => meta.origin === "b" && meta.keep === true));
});
