# Logging

## What this example teaches

Safe, structured observability for Sisal — and the redaction posture that keeps
secrets out of your logs. It shows:

- **enabling logging** on a `Database` via the `logging` option (a `logger`, a
  `level`, and per-category overrides);
- **SQL text logging** (the `orm.sql` category) — the rendered statement with
  `$1, $2` placeholders, never interpolated values;
- **parameter redaction** (the `orm.bind` category) — bind values are emitted
  only as safe summaries: strings collapse to a length plus a secret-detected
  flag, objects/tokens to a redacted key list, bytes to a byte length; low-
  cardinality scalars (numbers/booleans) keep their value so logs stay useful;
- **`parameters: "off"`** — omit even the safe summaries when a workload must
  not leak parameter cardinality at all;
- **adapter/driver context** — every event carries its `category` and `level`;
- two concrete `Logger` adapters: [`@std/log`](std_log.ts) and [Pino](pino.ts),
  plus a trivial console logger.

It uses `memoryOrmDriver()`, so it runs with **no database and no network** —
you can inspect exactly what Sisal would log against a real adapter.

## Packages used

`@sisal/orm` (`createDatabase`, `memoryOrmDriver`, `Logger`), `@std/log`,
`pino`.

## Dialect target

Driverless — the logging pipeline is dialect-neutral (the example renders
Postgres SQL for illustration).

## What is portable

The `logging` option, categories, and redaction behavior are identical across
every adapter (`@sisal/pg`, `@sisal/sqlite`, `@sisal/mysql`, …) and the
migration CLI.

## What is dialect-specific

Only the rendered SQL text differs per dialect (`$1` vs `?`); redaction is the
same everywhere.

## How to run

```sh
deno task std     # @std/log adapter
deno task pino    # Pino adapter
deno task run     # both, redacted, then a run with parameters "off"
```

No environment variables are required.

## Expected output

Structured log lines for each statement: an `orm.sql` event with the parameter-
ized SQL, and an `orm.bind` event whose `params` are **redacted summaries**. A
secret-looking value (`"password=swordfish"`) shows as
`{ "type": "string", "length": 18, "redacted": true }` — the value never
appears. With `parameters: "off"`, the bind events carry no summaries at all.

## Notes

This aligns with [`docs/security.md`](../../docs/security.md) and
[`SECURITY.md`](../../SECURITY.md): Sisal redacts SQL parameter values,
connection strings (DSNs), tokens, credential-like fields, and driver error
causes in both logs and errors (SEC-010 / SEC-011 / SEC-003).

**Debug vs production guidance:** use `level: "trace"` with
`parameters: "redacted"` while developing to see SQL + bind shapes; in
production prefer a higher `level` (e.g. `"info"` or `"warn"`) and, for the most
sensitive workloads, `parameters: "off"`. Never print raw DSNs, tokens, or
parameter values yourself — bypassing the logger defeats the redaction.
