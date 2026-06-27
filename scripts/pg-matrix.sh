#!/usr/bin/env bash
#
# Runs the Sisal PostgreSQL feature suite against PostgreSQL 16, 17, and 18 and
# prints a per-feature compatibility matrix.
#
# Requires Docker and a local Deno. Brings the servers up with
# docker/compose.yaml, runs integration/pg_features_test.ts against each over a
# published port, then tears the servers down.
#
#   scripts/pg-matrix.sh                 # run the full matrix
#   KEEP_UP=1 scripts/pg-matrix.sh       # leave servers running afterwards
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f docker/compose.yaml)
VERSIONS=(16 17 18)
declare -A PORT=([16]=55416 [17]=55417 [18]=55418)

strip_ansi() { sed -r 's/\x1b\[[0-9;]*m//g'; }

cleanup() {
  if [ "${KEEP_UP:-0}" != "1" ]; then
    "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "Starting PostgreSQL ${VERSIONS[*]} ..."
"${COMPOSE[@]}" up -d "${VERSIONS[@]/#/pg}"

for v in "${VERSIONS[@]}"; do
  printf "Waiting for pg%s to be healthy" "$v"
  for _ in $(seq 1 60); do
    status=$("${COMPOSE[@]}" ps "pg$v" --format '{{.Health}}' 2>/dev/null || true)
    [ "$status" = "healthy" ] && break
    printf "."
    sleep 1
  done
  echo " ok"
done

mkdir -p .pg-matrix
for v in "${VERSIONS[@]}"; do
  echo "=== PostgreSQL $v ==="
  url="postgres://postgres:postgres@localhost:${PORT[$v]}/sisal"
  DATABASE_URL="$url" deno test --allow-net --allow-env --allow-read \
    integration/pg_features_test.ts 2>&1 | strip_ansi | tee ".pg-matrix/pg$v.log" \
    || true
done

echo
echo "================ Compatibility matrix ================"
# Collect the union of feature names (drop the trailing "pg: " prefix noise).
mapfile -t FEATURES < <(grep -hoE '^pg: [^.]+ \.\.\.' ".pg-matrix/pg${VERSIONS[0]}.log" \
  | sed -E 's/ \.\.\.$//' | sed -E 's/\s+$//')

printf '%-52s' "Feature"
for v in "${VERSIONS[@]}"; do printf '%-6s' "pg$v"; done
echo
for feat in "${FEATURES[@]}"; do
  printf '%-52s' "$feat"
  for v in "${VERSIONS[@]}"; do
    line=$(grep -F "$feat ..." ".pg-matrix/pg$v.log" || true)
    if echo "$line" | grep -q ' ok'; then printf '%-6s' "PASS"
    elif echo "$line" | grep -q 'FAILED'; then printf '%-6s' "FAIL"
    else printf '%-6s' "-"; fi
  done
  echo
done

echo
for v in "${VERSIONS[@]}"; do
  printf 'pg%s: ' "$v"
  grep -E '^(ok|FAILED|error)' ".pg-matrix/pg$v.log" | tail -1 || echo "no summary"
done
