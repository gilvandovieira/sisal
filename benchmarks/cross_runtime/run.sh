#!/usr/bin/env bash
# Cross-runtime Sisal benchmark: Node vs Bun.
#
# Builds the @sisaljs/* npm packages, links them into a throwaway consumer
# alongside the real postgres.js driver, and runs benchmarks/cross_runtime/
# bench.mjs under each runtime. The bench separates two variables:
#   • Part 1 — Sisal render (CPU, no DB): the library's own speed on each engine.
#   • Part 2 — pg e2e: raw-driver time (runtime + driver + db baseline) vs Sisal,
#     so (sisal − raw) is Sisal's marginal overhead with the db time cancelled.
#
# postgres.js is the driver because it runs identically on Node and Bun (Bun has
# no node:sqlite, so Sisal's SQLite adapter can't run there yet). Point it at the
# compose Postgres:
#   docker compose -f docker/compose.yaml up -d pg16
#
# Usage:
#   benchmarks/cross_runtime/run.sh              # build + run node and bun
#   SKIP_BUILD=1 benchmarks/cross_runtime/run.sh # reuse an existing npm/ build
#   DB_URL=postgres://…  benchmarks/cross_runtime/run.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${TMPDIR:-/tmp}/sisal-cross-runtime"
DB_URL="${DB_URL:-postgres://postgres:postgres@localhost:55416/sisal}"
cd "$ROOT"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "▸ building npm packages (orm, core, migrate, pg)…"
  deno run -A tools/build_npm.ts core orm migrate pg >/dev/null
fi

echo "▸ setting up consumer at $WORK"
rm -rf "$WORK" && mkdir -p "$WORK"
cat > "$WORK/package.json" <<JSON
{
  "name": "sisal-cross-runtime", "private": true, "type": "module",
  "dependencies": {
    "@sisaljs/core": "file:$ROOT/npm/core",
    "@sisaljs/orm": "file:$ROOT/npm/orm",
    "@sisaljs/migrate": "file:$ROOT/npm/migrate",
    "@sisaljs/pg": "file:$ROOT/npm/pg",
    "postgres": "^3.4.7",
    "@js-temporal/polyfill": "^0.5.1"
  }
}
JSON
cp benchmarks/cross_runtime/bench.mjs "$WORK/bench.mjs"
cp benchmarks/cross_runtime/setup_temporal.mjs "$WORK/setup_temporal.mjs"
(cd "$WORK" && npm install --install-links --silent)

RESULTS="$WORK/results.jsonl"
: > "$RESULTS"

run_runtime() { # name, binary
  local name="$1" bin="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "▸ $name not found — skipping"
    return
  fi
  echo "═════════ $name ═════════"
  # Capture the ##RESULT## line for the comparison while streaming the summary.
  DB_URL="$DB_URL" "$bin" "$WORK/bench.mjs" | tee /dev/stderr \
    | grep '^##RESULT##' | sed 's/^##RESULT## //' >> "$RESULTS" || true
} 2>&1

run_runtime node node
run_runtime bun bun

echo
echo "═════════ comparison ═════════"
deno run --allow-read "$ROOT/benchmarks/cross_runtime/compare.ts" "$RESULTS"
