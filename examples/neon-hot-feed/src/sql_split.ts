/**
 * A small, dollar-quote-aware SQL statement splitter.
 *
 * Why this exists (a Sisal API pressure point): a `.sql` migration file holds
 * several statements separated by `;`, but the Neon serverless driver sends
 * each query through PostgreSQL's extended protocol, which permits exactly one
 * statement per call. Naively splitting on `;` would also break the bodies of
 * `CREATE FUNCTION ... $$ ... ; ... $$`. Sisal does not ship a serverless-safe
 * raw-SQL migration runner, so the example provides this minimal one.
 *
 * The splitter ignores `;` that appears inside single-quoted strings, line
 * comments (`-- ...`), block comments, and dollar-quoted strings (`$$...$$` or
 * `$tag$...$tag$`).
 *
 * @module
 */

const DOLLAR_TAG = /^\$[A-Za-z_]*\$/;

/** Splits SQL text into individual statements, respecting strings/comments. */
export function splitSqlStatements(input: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inLineComment = false;
  let inBlockComment = false;
  let inSingleQuote = false;
  let dollarTag: string | null = null;
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    const next = index + 1 < input.length ? input[index + 1] : "";

    if (inLineComment) {
      current += char;
      if (char === "\n") inLineComment = false;
      index += 1;
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        index += 2;
        inBlockComment = false;
        continue;
      }
      index += 1;
      continue;
    }

    if (inSingleQuote) {
      current += char;
      if (char === "'") {
        if (next === "'") {
          // Escaped quote inside a string literal.
          current += next;
          index += 2;
          continue;
        }
        inSingleQuote = false;
      }
      index += 1;
      continue;
    }

    if (dollarTag !== null) {
      if (char === "$" && input.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += char;
      index += 1;
      continue;
    }

    // Outside any quoted/comment context.
    if (char === "-" && next === "-") {
      inLineComment = true;
      current += char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      current += char;
      index += 1;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      current += char;
      index += 1;
      continue;
    }

    if (char === "$") {
      const match = DOLLAR_TAG.exec(input.slice(index));
      if (match !== null) {
        dollarTag = match[0];
        current += dollarTag;
        index += dollarTag.length;
        continue;
      }
    }

    if (char === ";") {
      pushStatement(statements, current);
      current = "";
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  pushStatement(statements, current);
  return statements;
}

function pushStatement(statements: string[], candidate: string): void {
  const trimmed = candidate.trim();
  if (trimmed.length > 0) {
    statements.push(trimmed);
  }
}
