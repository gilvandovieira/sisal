# Runner image for the Sisal PostgreSQL feature/compatibility suite.
# Used by docker/compose.yaml to run integration/pg_features_test.ts against a
# PostgreSQL service. DATABASE_URL is supplied by compose at run time.
FROM denoland/deno:2.8.3@sha256:438618d8c0678c3154fc77ad6edad61f38cbc42803a181e7908d3e2c9e645022

WORKDIR /app
COPY . .

# Pre-warm the dependency cache (resolves @db/postgres + std).
RUN deno cache integration/pg_features_test.ts || true

ENTRYPOINT ["deno"]
CMD ["test", "--allow-net", "--allow-env", "--allow-read", \
  "integration/pg_features_test.ts"]
