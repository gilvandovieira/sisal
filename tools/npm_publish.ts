/**
 * Publishes the built `npm/<pkg>/` artifacts to npm in **dependency order**
 * (core → orm,migrate → adapters → etl,analytics), with provenance, idempotently
 * — a version already on the registry is skipped, so re-running a release is
 * safe. Paired with `deno publish` (JSR) in `.github/workflows/publish.yml` so
 * JSR and npm ship identical versions (NPM-22).
 *
 * Auth is OIDC Trusted Publishing (no `NPM_TOKEN`): run inside a GitHub Actions
 * job with `permissions: id-token: write` and `@sisaljs` registered as a trusted
 * publisher for this repo+workflow on npmjs.com (NPM-21). `--provenance` attaches
 * the signed build attestation.
 *
 * Run `deno task build:npm:all` first so `npm/<pkg>/` exists.
 *
 * Usage:
 *   deno run -A tools/npm_publish.ts               # publish (latest tag)
 *   deno run -A tools/npm_publish.ts --dry-run     # validate, publish nothing
 *   deno run -A tools/npm_publish.ts --tag next    # pre-release dist-tag
 *
 * @module
 */

import { NPM_SCOPE, PACKAGES, readDenoJson } from "./npm_manifest.ts";

const dryRun = Deno.args.includes("--dry-run");
const tagFlag = Deno.args.indexOf("--tag");
const distTag = tagFlag >= 0 ? Deno.args[tagFlag + 1] : undefined;

/** Versions of `name` already on the registry (empty if never published). */
async function publishedVersions(name: string): Promise<Set<string>> {
  const { success, stdout } = await new Deno.Command("npm", {
    args: ["view", name, "versions", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!success) return new Set(); // 404 → not published yet
  const parsed = JSON.parse(new TextDecoder().decode(stdout)) as
    | string
    | string[];
  return new Set(Array.isArray(parsed) ? parsed : [parsed]);
}

let published = 0;
let skipped = 0;

for (const pkg of PACKAGES) {
  const name = `${NPM_SCOPE}/${pkg.id}`;
  const version = (await readDenoJson(pkg.id)).version ?? "0.0.0";

  if ((await publishedVersions(name)).has(version)) {
    console.log(`• skip ${name}@${version} (already on registry)`);
    skipped++;
    continue;
  }

  // `./` prefix so npm treats it as a directory, not a `github:npm/<id>` spec.
  const args = [
    "publish",
    `./npm/${pkg.id}`,
    "--provenance",
    "--access",
    "public",
  ];
  if (distTag) args.push("--tag", distTag);
  if (dryRun) args.push("--dry-run");

  console.log(`▸ npm ${args.join(" ")}`);
  const { success } = await new Deno.Command("npm", {
    args,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!success) {
    console.error(`✗ failed to publish ${name}@${version}`);
    Deno.exit(1);
  }
  published++;
}

console.log(
  `\n${dryRun ? "Dry run" : "Published"}: ${published} package(s), ` +
    `${skipped} already current.`,
);
