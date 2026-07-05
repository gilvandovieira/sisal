/**
 * Generates `docs/npm-manifests.json` — the frozen **intent** of every
 * `@sisaljs/*` package manifest, derived from `deno.json` + the descriptor
 * table in `tools/npm_manifest.ts`.
 *
 *   deno task npm:manifests   # write docs/npm-manifests.json
 *   deno task npm:check       # verify it matches the current deno.json inputs
 *
 * This is the freshness gate for the npm distribution (plan NPM-14, patterned on
 * `docs:matrix:check`). Because npm artifacts are generated — never hand-edited
 * — the risk is a `deno.json` change (a version bump, an added/removed export
 * subpath, a shifted dependency) that isn't reflected in what npm would ship.
 * The committed manifest snapshot freezes that surface; `--check` re-derives it
 * and fails on any difference, so drift is caught in CI without running a full
 * (slow) dnt build. `buildManifest` also throws if a package imports an
 * `@sisal/*` sibling it doesn't declare as a dependency.
 *
 * @module
 */

import { buildManifest, type NpmManifest, PACKAGES } from "./npm_manifest.ts";

const OUT = "docs/npm-manifests.json";

/** Re-derives the manifest snapshot for every package, in descriptor order. */
async function render(): Promise<string> {
  const manifests: Record<string, NpmManifest> = {};
  for (const pkg of PACKAGES) {
    manifests[pkg.id] = await buildManifest(pkg);
  }
  return JSON.stringify(manifests, null, 2) + "\n";
}

const check = Deno.args.includes("--check");
const content = await render();

if (check) {
  const current = await Deno.readTextFile(OUT).catch(() => null);
  if (current !== content) {
    console.error(
      `${OUT} is out of date — run \`deno task npm:manifests\` and commit the ` +
        `result. A deno.json version, export, or dependency change alters what ` +
        `npm would publish.`,
    );
    Deno.exit(1);
  }
  console.log(
    `${OUT} is up to date (${PACKAGES.length} package manifests in sync with ` +
      `deno.json).`,
  );
} else {
  await Deno.writeTextFile(OUT, content);
  console.log(`Wrote ${OUT} (${PACKAGES.length} package manifests).`);
}
