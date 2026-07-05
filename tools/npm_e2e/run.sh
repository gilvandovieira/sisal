#!/usr/bin/env bash
# Node e2e battery for the built @sisaljs/* npm packages.
#
# Builds every package with dnt, links them into a throwaway consumer project
# alongside the real npm drivers, and runs tools/npm_e2e/adapter_e2e.mjs against
# each adapter's database. Complements the Deno integration suites: this proves
# the *npm artifacts* run on Node against real databases.
#
# Databases come from docker/compose.yaml:
#   docker compose -f docker/compose.yaml up -d \
#     pg16 neon-pg neon-proxy mysql mariadb
#
# Usage:
#   tools/npm_e2e/run.sh            # build + run every adapter it can reach
#   SKIP_BUILD=1 tools/npm_e2e/run.sh   # reuse an existing npm/ build
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${TMPDIR:-/tmp}/sisal-npm-e2e"
cd "$ROOT"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "▸ building all npm packages"
  deno run -A tools/build_npm.ts all
fi

echo "▸ setting up consumer at $WORK"
rm -rf "$WORK" && mkdir -p "$WORK"
cat > "$WORK/package.json" <<JSON
{
  "name": "sisal-npm-e2e", "private": true, "type": "module",
  "dependencies": {
    "@sisaljs/core": "file:$ROOT/npm/core",
    "@sisaljs/orm": "file:$ROOT/npm/orm",
    "@sisaljs/migrate": "file:$ROOT/npm/migrate",
    "@sisaljs/pg": "file:$ROOT/npm/pg",
    "@sisaljs/neon": "file:$ROOT/npm/neon",
    "@sisaljs/sqlite": "file:$ROOT/npm/sqlite",
    "@sisaljs/libsql": "file:$ROOT/npm/libsql",
    "@sisaljs/mysql": "file:$ROOT/npm/mysql",
    "postgres": "^3.4.7",
    "mysql2": "^3.22.5",
    "mariadb": "^3.5.3",
    "@libsql/client": "^0.17.4",
    "@neondatabase/serverless": "^1.0.0"
  }
}
JSON
cp tools/npm_e2e/adapter_e2e.mjs "$WORK/adapter_e2e.mjs"
# --install-links copies file: deps as real dirs so nested @sisaljs/* resolve.
(cd "$WORK" && npm install --install-links --silent)

PG_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:55416/sisal}"
NEON_URL="${NEON_DATABASE_URL:-postgres://postgres:postgres@localhost/sisal}"
NEON_PROXY="${NEON_WS_PROXY:-localhost:5499}"
MYSQL_URL="${MYSQL_URL:-mysql://root:root@localhost:33306/sisal}"
MARIADB_URL="${MARIADB_URL:-mysql://root:root@localhost:33307/sisal}"

fail=0
run() { # adapter, url, [extra env KEY=VAL ...]
  local adapter="$1" url="$2"; shift 2
  echo "───── $adapter ─────"
  if env ADAPTER="$adapter" DB_URL="$url" "$@" node "$WORK/adapter_e2e.mjs"; then :; else fail=1; fi
}

run sqlite  ":memory:"
run libsql  "file:$WORK/e2e-libsql.db"
run pg      "$PG_URL"
run neon    "$NEON_URL" NEON_WS_PROXY="$NEON_PROXY"
run mysql   "$MYSQL_URL"
run mariadb "$MARIADB_URL"

echo
[ "$fail" = "0" ] && echo "✔ all adapters passed the Node e2e battery" \
  || { echo "✘ one or more adapters failed"; exit 1; }
