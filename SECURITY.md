# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in Sisal, please report
it **privately** — do not open a public issue. Email the maintainer at
`gilvandolucasvieira@gmail.com` with:

- a description of the issue and its impact,
- steps (or a minimal reproduction) to trigger it, and
- the affected package(s) and version(s).

Please allow a reasonable window for a fix before any public disclosure. We will
acknowledge the report, work with you on a fix, and credit you unless you prefer
otherwise.

## Supported versions

Sisal is a `0.x` workspace; security fixes land on the latest published minor
(currently `0.9.x`). Pin a version and upgrade promptly when a fix is released.

## Security model (summary)

Sisal is a **driverless ORM and migration toolkit that runs inside your
application process** — it has no network surface, sessions, or auth of its own.
The full audit and roadmap live in [`docs/security.md`](docs/security.md); the
latest refresh (2026-07-02, v0.9.0) found no injection path, and every finding
it raised (SEC-008 through SEC-016) is now **resolved**, each pinned by a test.
In short:

- **Values are always bound parameters** — never concatenated into SQL.
- **Identifiers are validated and quoted**, so a value cannot break out of a
  quoted name.
- **Logs and errors carry the parameterized SQL text only** — never parameter
  values, connection strings, or tokens. A preserved driver `cause` is
  recursively sanitized (bind arrays and rendered SQL dropped, credential fields
  masked), so serializing `error.cause` does not leak values.
- **Unknown columns are rejected** on insert/update (mass-assignment guard), and
  **where-less `update`/`delete` throw** unless you call
  `.unsafeAllowAllRows()`.
- `raw(...)`, `identifier(...)`, `db.execute("…")`, and `db.query("…")` are
  **escape hatches** — as are the pre-rendered statement lists accepted by
  `db.batch` and a checkpoint's `advance`/`prune`. Pass only developer-authored
  SQL through them, never untrusted input.

These invariants are pinned by `packages/orm/security_test.ts`.

## MySQL/MariaDB deployment notes

- **TLS:** pass the `ssl` option to `connect()` (`ssl: true` for default CA
  verification, or an object to pin a CA / client certificate). TLS **cannot**
  be set through the URL query string — a `?ssl-mode=…` param is rejected with a
  clear error rather than silently connecting in cleartext (SEC-009).
- **Affected-row semantics:** the bundled pools disable `CLIENT_FOUND_ROWS`, so
  `tryInsert` and `db.tryAdvisoryLock` are reliable (SEC-008). One consequence:
  a plain `UPDATE` that sets a row to its current values reports 0 affected rows
  (rows _changed_), unlike PostgreSQL/SQLite (rows _matched_) — see
  [`docs/mysql-compatibility.md`](docs/mysql-compatibility.md). If you inject
  your own `pool`/`client`, disable found-rows there too for `tryInsert` to stay
  reliable (the advisory lock verifies ownership and is correct regardless).

## Operational guidance

- **Use least privilege.** Run migrations with a role that may `CREATE`/`ALTER`/
  `DROP`, and run the application with a separate role limited to the DML it
  needs. Never run the app with the migration role.
- **Keep secrets in the environment**, not in a committed `sisal.migrate.ts`.
  The CLI scaffolds `Deno.env.get(...)` for connection details for this reason.
- **Mind debug logs.** Debug logging includes SQL text (table/column names, no
  values); keep it off or routed appropriately in production.
- **Scope Deno permissions in CI/production.** `deno task sisal` and the CLI
  shebang grant broad read/write/env/net/FFI for local convenience. Narrow them
  for automated runs:

  ```sh
  # generate (no database): read config, write migrations
  deno run --allow-read=. --allow-write=./migrations \
    jsr:@sisal/migrate/cli generate

  # migrate against Postgres: only the DSN env var and the DB host
  deno run --allow-read=. --allow-env=DATABASE_URL \
    --allow-net=db.example.com:5432 jsr:@sisal/migrate/cli migrate

  # libSQL/Turso: URL + token env vars and the Turso host
  deno run --allow-read=. --allow-env=TURSO_DATABASE_URL,TURSO_AUTH_TOKEN \
    --allow-net=your-db.turso.io:443 jsr:@sisal/migrate/cli migrate

  # migrate against MySQL/MariaDB: the URL env var and the DB host
  deno run --allow-read=. --allow-env=MYSQL_URL \
    --allow-net=db.example.com:3306 jsr:@sisal/migrate/cli migrate
  ```

  SQLite (`@db/sqlite`) loads a native library on first run, so it needs the
  broader `--allow-ffi --allow-read --allow-write --allow-env --allow-net`.
