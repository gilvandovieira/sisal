/**
 * Exits 0 if this workspace's version is already published on JSR, 1 otherwise.
 * Lets `publish.yml` skip an idempotent `deno publish` on a re-run — mirroring
 * `tools/npm_publish.ts`'s registry check — so a release that half-succeeded
 * (e.g. JSR published, npm failed on auth) can be finished by re-running without
 * `deno publish` erroring on the already-published version.
 *
 *   deno run --allow-read --allow-net=jsr.io tools/jsr_published.ts
 *
 * @module
 */

const version =
  (JSON.parse(await Deno.readTextFile("packages/core/deno.json")) as {
    version?: string;
  }).version ?? "0.0.0";

try {
  const meta = await (await fetch("https://jsr.io/@sisal/core/meta.json"))
    .json() as { versions?: Record<string, unknown> };
  const published = meta.versions?.[version] !== undefined;
  console.log(
    published
      ? `@sisal/core@${version} is already on JSR.`
      : `@sisal/core@${version} is not yet on JSR.`,
  );
  Deno.exit(published ? 0 : 1);
} catch (error) {
  // On a lookup failure, assume not published so the publish still attempts.
  console.warn(`JSR lookup failed (${error}); assuming not published.`);
  Deno.exit(1);
}
