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

## Sisal API pressure points

Honest gaps this example ran into. Each is a candidate for future Sisal work.
The redaction posture itself is the happy path — Sisal does the parameter, DSN,
token, and error-cause scrubbing for you — so the friction here is almost
entirely in **bridging Sisal's `Logger` contract to a real sink**, not in the
logging behavior.

1. **No built-in logger bridges — every sink is hand-wired.** Sisal accepts a
   `Logger` but ships no adapter for the common ones, so each of the three
   loggers here is a hand-written shim: the console logger (`mod.ts:24-37`), the
   `@std/log` bridge (`std_log.ts:30-55`), and the Pino bridge
   (`pino.ts:17-38`). A first-party `@sisal/logger-std` / Pino/Pequi bridge
   would delete all of this glue. _API gap._
2. **`LoggerMethod`'s dual call signature forces an `as LoggerMethod` cast.**
   The contract is an overloaded interface — `(message)` **and**
   `(record, message)` (`packages/core/logger.ts:65-68`) — which a single arrow
   function can't satisfy structurally, so both shims that build a method from
   scratch cast their closure (`mod.ts:27`, `std_log.ts:27`). A helper that
   adapts a plain `(record?, message) => void` into a `LoggerMethod` would
   remove the unsafe cast. _API gap._
3. **`@std/log`'s argument order is reversed, so the bridge reorders by hand.**
   Sisal calls `(record, message)` for structured events, but `@std/log`'s
   methods are `(message, ...args)`; the shim has to detect the one-arg case and
   swap the operands (`std_log.ts:17-28`). Pino happens to be record-first, so
   its methods bind directly (`pino.ts:31-37`) — the mismatch is purely the
   third-party signature, not something Sisal can normalize away.
   _Driver/runtime limitation._
4. **`@std/log` has no `trace` level, so `trace` is folded into `debug`.**
   Sisal's `Logger.trace` is optional (`packages/core/logger.ts:76`), but
   `@std/log` bottoms out at `DEBUG`, so the bridge maps both Sisal levels onto
   `logger.debug` (`std_log.ts:49`) and loses the trace/debug distinction at the
   sink. _Driver/runtime limitation._
5. **Pino is `npm:` and drags in extra Deno permissions and config.** Pino is
   imported as `npm:pino` (`deno.json:8`), and because it reads the host
   environment the tasks need `--allow-sys=hostname` (`deno.json:12-13`) and the
   logger sets `base: undefined` to suppress the pid/hostname fields Sisal never
   asked for (`pino.ts:21`). The pure-JSR `@std/log` path needs neither.
   _Driver/runtime limitation._
6. **`memoryOrmDriver()` can only demonstrate the parameter-redaction half.**
   The demo runs against the memory driver (`shared.ts:32-33`), which has no
   connection string and never raises a driver error — so it can exercise SQL
   text and bind-parameter redaction but **cannot** show the DSN, token, and
   driver-error-cause scrubbing the Notes below advertise (`README.md:113-116`,
   SEC-010 / SEC-011 / SEC-003). Seeing those redactions in action requires a
   real adapter. _Driver/runtime limitation._

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
