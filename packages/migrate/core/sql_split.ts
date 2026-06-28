/**
 * A dollar-quote-aware SQL statement splitter.
 *
 * A `.sql` migration file usually holds several statements separated by `;`,
 * but some drivers — notably PostgreSQL's serverless/HTTP transports (Neon) —
 * send each query through the extended protocol, which permits exactly one
 * statement per call. Naively splitting on `;` would also break the bodies of
 * `CREATE FUNCTION ... $$ ... ; ... $$`. {@link splitSqlStatements} splits the
 * script on **top-level** semicolons only, leaving statements intact.
 *
 * @module
 */

// A Postgres dollar-quote delimiter: `$$` or `$tag$` (tag is an identifier).
const DOLLAR_QUOTE_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

/** Returns the dollar-quote delimiter (`$$`, `$tag$`) opening at `index`, else undefined. */
function dollarTagAt(text: string, index: number): string | undefined {
  DOLLAR_QUOTE_TAG.lastIndex = index;
  const match = DOLLAR_QUOTE_TAG.exec(text);
  return match !== null ? match[0] : undefined;
}

/**
 * Splits a SQL script into individual statements on top-level `;`, ignoring
 * semicolons inside string literals, quoted identifiers, line/block comments,
 * and PostgreSQL dollar-quoted bodies (`$$ … $$`, `$tag$ … $tag$`). Each
 * returned statement is trimmed; empty statements (and a trailing `;`) are
 * dropped.
 */
export function splitSqlStatements(text: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockComment = false;
  // The open dollar-quote delimiter (`$$`, `$tag$`), or undefined outside one.
  // Postgres treats everything inside a dollar-quoted body verbatim, `;` too.
  let dollarTag: string | undefined;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (dollarTag !== undefined) {
      // Inside a dollar-quoted body: only the matching closer ends it.
      if (text.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = undefined;
      }
      continue;
    }

    if (singleQuoted) {
      if (char === "'" && next === "'") {
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }

    if (doubleQuoted) {
      if (char === '"' && next === '"') {
        index += 1;
      } else if (char === '"') {
        doubleQuoted = false;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (char === "$") {
      const opener = dollarTagAt(text, index);
      if (opener !== undefined) {
        dollarTag = opener;
        index += opener.length - 1;
        continue;
      }
    }

    if (char === "'") {
      singleQuoted = true;
      continue;
    }

    if (char === '"') {
      doubleQuoted = true;
      continue;
    }

    if (char === ";") {
      // A statement that is only `;`/whitespace (e.g. a stray or doubled
      // semicolon) is dropped — executing it is a syntax error on most drivers.
      const statement = text.slice(start, index + 1).trim();
      if (statement.length > 0 && statement !== ";") {
        statements.push(statement);
      }
      start = index + 1;
    }
  }

  const tail = text.slice(start).trim();
  if (tail.length > 0) {
    statements.push(tail);
  }

  return statements;
}
