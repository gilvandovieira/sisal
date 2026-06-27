/**
 * Sisal lint plugin.
 *
 * `no-raw-interpolation` flags an interpolated template literal passed to the
 * unsanitized SQL escape hatch `raw(...)`. `raw` exists for developer-authored
 * SQL only; runtime values must go through the `sql` template (which binds them
 * as parameters), so interpolating a variable into `raw` is the classic
 * injection footgun. Build the dynamic part with `sql\`…${value}\`` or
 * `identifier(name)` instead, or — for a genuinely trusted constant — add
 * `// deno-lint-ignore sisal/no-raw-interpolation` with a one-line reason.
 *
 * The rule targets `raw` only (the dedicated unsanitized hatch); `db.execute`
 * is the general runner used legitimately for trusted DDL/migration strings, so
 * linting it is too noisy — that caution lives in `docs/security.md` instead.
 * Applications can widen the `calleeName` check to `execute` in their own copy.
 *
 * This rule is enabled on Sisal's own workspace (see the root `deno.json`) and
 * is a copyable recipe for applications using Sisal — see `docs/security.md`.
 *
 * @module
 */

function calleeName(callee: Deno.lint.Expression): string | undefined {
  if (callee.type === "Identifier") {
    return callee.name;
  }
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return undefined;
}

const plugin: Deno.lint.Plugin = {
  name: "sisal",
  rules: {
    "no-raw-interpolation": {
      create(context) {
        return {
          CallExpression(node) {
            if (calleeName(node.callee) !== "raw") {
              return;
            }
            for (const argument of node.arguments) {
              if (
                argument.type === "TemplateLiteral" &&
                argument.expressions.length > 0
              ) {
                context.report({
                  node: argument,
                  message: "Interpolating a value into raw(`…`) bypasses " +
                    "parameterization. Use the sql`…` template for values " +
                    "(it binds parameters) or identifier(name) for names.",
                });
              }
            }
          },
        };
      },
    },
  },
};

export default plugin;
