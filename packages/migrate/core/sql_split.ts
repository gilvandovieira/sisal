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

// True for a character that may appear in an identifier — used to tell a
// standalone `E`/`e` escape-string prefix from the tail of an identifier.
function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

/**
 * Splits a SQL script into individual statements on top-level `;`, ignoring
 * semicolons inside string literals (including PostgreSQL `E'…'` escape strings
 * with backslash escapes), quoted identifiers, line comments, **nested** block
 * comments, and PostgreSQL dollar-quoted bodies (`$$ … $$`, `$tag$ … $tag$`).
 * Each returned statement is trimmed; empty statements (and a trailing `;`) are
 * dropped.
 */
export function splitSqlStatements(text: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let singleQuoted = false;
  // The open single-quoted string is a Postgres escape string (`E'…'`), in which
  // a backslash escapes the next character.
  let escapeString = false;
  let doubleQuoted = false;
  let lineComment = false;
  // Postgres block comments nest (`/* a /* b */ c */`), so track depth, not a
  // boolean — a `;` stays hidden until the outermost comment closes.
  let blockDepth = 0;
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

    if (blockDepth > 0) {
      if (char === "/" && next === "*") {
        blockDepth += 1;
        index += 1;
      } else if (char === "*" && next === "/") {
        blockDepth -= 1;
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
      if (escapeString && char === "\\") {
        // Skip the escaped character (a quote or backslash included), so a
        // `\'` inside `E'…'` does not end the string.
        index += 1;
      } else if (char === "'" && next === "'") {
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
        escapeString = false;
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
      blockDepth = 1;
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
      // A Postgres escape string is written `E'…'` / `e'…'`, where the prefix is
      // a standalone token (not the tail of an identifier).
      escapeString = (text[index - 1] === "E" || text[index - 1] === "e") &&
        !isIdentifierChar(text[index - 2]);
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
