# Logging

## What this example teaches

Structured observability for Sisal — a **bring-your-own-logger** pipeline that
is silent until you opt in, and a redaction posture that keeps connection
secrets out of your logs. It shows:

- the **single-sink `Logger` contract** — one `log(event)` method (plus an
  optional `isEnabled` fast-path) that any backend adapts to;
- **bundled bridges** — `consoleLogger()` (zero setup) and `fromStdLog(...)`
  (adapts an [`@std/log`](std_log.ts) logger), plus a [Pino](pino.ts) bridge in
  ~10 lines;
- **verbosity presets** — `developmentLogging(...)` (verbose, raw parameters)
  and `productionLogging(...)` (quiet, redacted);
- **SQL text logging** (`orm.sql`) — the rendered statement with `$1, $2`
  placeholders, never interpolated values;
- **parameter modes** (`orm.bind`) — `"redacted"` safe summaries (default),
  `"values"` raw values for debugging, or `"off"`;
- **silent by default** — attach no logger and Sisal logs nothing (a failing
  query still throws a redacted `SisalError`).

It uses `memoryOrmDriver()`, so it runs with **no database and no network** —
you can inspect exactly what Sisal would log against a real adapter.

## Setup (copy-paste)

The obvious wiring with the standard Deno logger, `@std/log`:

```ts
import * as log from "@std/log";
import {
  createDatabase,
  developmentLogging,
  fromStdLog,
  memoryOrmDriver, // swap for a real adapter's connect() in your app
} from "@sisal/orm";

// 1. Configure @std/log however you like.
log.setup({
  handlers: { console: new log.ConsoleHandler("DEBUG") },
  loggers: { sisal: { level: "DEBUG", handlers: ["console"] } },
});

// 2. Bridge it into Sisal and pick a verbosity preset.
const db = createDatabase({
  dialect: "postgres",
  driver: memoryOrmDriver(),
  logging: developmentLogging(fromStdLog(log.getLogger("sisal"))),
});
```

`developmentLogging(...)` logs SQL, result shapes, and **raw** bind parameters
(so you can copy a failing query and replay it). For production, swap one call:

```ts
logging: productionLogging(fromStdLog(log.getLogger("sisal"))),
```

`productionLogging(...)` drops to `warn`/`error` with **redacted** parameters —
a failing query still logs its SQL text (an `orm.query` error event) so you can
find it. Want it fully silent? **Pass no `logging` option at all.**

No sink handy? `consoleLogger()` needs zero setup:

```ts
logging: developmentLogging(consoleLogger()),
```

## Packages used

`@sisal/orm` (`createDatabase`, `memoryOrmDriver`, `Logger`, `consoleLogger`,
`fromStdLog`, `developmentLogging`, `productionLogging`), `@std/log`, `pino`.

## Dialect target

Driverless — the logging pipeline is dialect-neutral (the example renders
Postgres SQL for illustration).

## What is portable

The `logging` option, the `Logger` contract, categories, presets, and redaction
behavior are identical across every adapter (`@sisal/pg`, `@sisal/sqlite`,
`@sisal/mysql`, …) and the migration CLI.

## What is dialect-specific

Only the rendered SQL text differs per dialect (`$1` vs `?`); the logging
pipeline is the same everywhere.

## How to run

```sh
deno task std     # @std/log bridge
deno task pino    # Pino bridge (uses isEnabled to honor pino's own level)
deno task run     # both, redacted, then a run with parameters "off"
```

No environment variables are required.

## Expected output

Structured log lines per statement: an `orm.sql` event with the parameterized
SQL, and an `orm.bind` event whose `params` are **redacted summaries** by
default. A secret-looking value (`"password=swordfish"`) shows as
`{ "type": "string", "length": 18, "redacted": true }` — the value never
appears. Under `developmentLogging(...)` (or `sql: { parameters: "values" }`)
the raw value appears instead, by design. With `parameters: "off"`, the bind
events carry no summaries at all.

## The parameter nuance (and what is _always_ redacted)

Bind parameters are **your data**, and seeing them is often the fastest way to
work out why a query misbehaves. So the parameter mode is a deliberate choice:

- `"redacted"` (default) — safe summaries; secret-looking strings are flagged,
  not printed.
- `"values"` — the **raw** values, for local debugging or a scoped production
  incident. This can put user data (and secrets a statement is inserting) into
  your logs, so it is opt-in.
- `"off"` — no parameter information at all.

**Connection strings, DSNs, tokens, and credential-like fields are a separate
concern and are _always_ redacted**, in both logs and errors, regardless of the
parameter mode (SEC-010 / SEC-011 / SEC-003). Raw parameters never open that
door. Never print raw DSNs or values yourself — bypassing the logger defeats the
redaction. See [`docs/security.md`](../../docs/security.md) and
[`SECURITY.md`](../../SECURITY.md).

## Cost when you don't use it

Logging is **zero-cost when off**: with no logger attached (or a level/category
gated off), the query path allocates no event records, no timing, and never
renders parameters. The optional `isEnabled` hook (see [pino.ts](pino.ts), which
forwards `pino.isLevelEnabled`) lets a sink veto a level so even a high Sisal
verbosity setting builds nothing the sink would drop. `deno task bench`
(scenario `logging`) measures the off-vs-verbose delta.

## Sisal API pressure points

Honest gaps this example used to surface — now resolved by the v0.11 logging
refactor:

1. **Every sink was hand-wired.** `consoleLogger()` and `fromStdLog(...)` now
   ship in `@sisal/orm`; the Pino bridge is a ~10-line `log(event)` adapter.
   _(resolved)_
2. **The overloaded `LoggerMethod` forced `as LoggerMethod` casts.** The
   contract is now a single `log(event)` method — bridges need no casts.
   _(resolved)_
3. **No way to log real parameters for prod debugging.** The `"values"`
   parameter mode (and `developmentLogging`) now log raw binds by choice, while
   connection secrets stay redacted. _(resolved)_
4. **No dev/prod verbosity presets.** `developmentLogging` / `productionLogging`
   ship. _(resolved)_

Remaining, and correctly **not** a Sisal gap: `@std/log` has no `trace` level,
so `fromStdLog` folds Sisal's `trace` into `debug`; and Pino (`npm:`) drags in
`--allow-sys=hostname`. Both live in the bridge/backend, not in Sisal.
