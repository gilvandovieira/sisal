# Runner image for the Sisal PostgreSQL feature/compatibility suite.
# Used by docker/compose.yaml to run integration/pg_features_test.ts against a
# PostgreSQL service. DATABASE_URL is supplied by compose at run time.
FROM denoland/deno:2.9.3@sha256:6288db6be1c26473bb9d1843f906d9a219c0dda57fd85de4aac90296951cf6ef

WORKDIR /app
COPY . .

# Pre-warm the dependency cache (resolves @db/postgres + std).
RUN deno cache integration/pg_features_test.ts || true

ENTRYPOINT ["deno"]
CMD ["test", "--allow-net", "--allow-env", "--allow-read", \
  "integration/pg_features_test.ts"]
