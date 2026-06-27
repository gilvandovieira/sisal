/**
 * Dependency advisory + SBOM check.
 *
 * Reads `deno.lock`, prints the resolved JSR/npm dependency inventory (a
 * lightweight SBOM), and queries the OSV database for known vulnerabilities in
 * the npm dependencies. Exits non-zero when an advisory is found.
 *
 * OSV does not index the `JSR`/`Deno` ecosystems, so JSR dependencies are listed
 * for the record but cannot be advisory-checked here — that limitation is noted
 * in `docs/security.md` (SEC-002 family).
 *
 *   deno task audit            # or: deno run --allow-read --allow-net=api.osv.dev tools/check_advisories.ts
 *
 * @module
 */

const OSV_QUERYBATCH = "https://api.osv.dev/v1/querybatch";

interface LockFile {
  readonly jsr?: Record<string, unknown>;
  readonly npm?: Record<string, unknown>;
}

interface NpmPackage {
  readonly key: string;
  readonly name: string;
  readonly version: string;
}

/** Splits a lock key (`@scope/name@version[_peerdeps]`) into name + version. */
function parseNpmKey(key: string): NpmPackage {
  const base = key.split("_")[0];
  const at = base.lastIndexOf("@");
  return { key, name: base.slice(0, at), version: base.slice(at + 1) };
}

function dedupe(packages: readonly NpmPackage[]): NpmPackage[] {
  const seen = new Map<string, NpmPackage>();
  for (const pkg of packages) {
    seen.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function main(): Promise<number> {
  const lock = JSON.parse(await Deno.readTextFile("deno.lock")) as LockFile;
  const jsr = Object.keys(lock.jsr ?? {}).sort();
  const npm = dedupe(Object.keys(lock.npm ?? {}).map(parseNpmKey));

  console.log(`# SBOM (deno.lock)\nJSR packages: ${jsr.length}`);
  for (const id of jsr) console.log(`  jsr  ${id}`);
  console.log(`npm packages: ${npm.length}`);
  for (const pkg of npm) console.log(`  npm  ${pkg.name}@${pkg.version}`);

  let response: Response;
  try {
    response = await fetch(OSV_QUERYBATCH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: npm.map((pkg) => ({
          package: { ecosystem: "npm", name: pkg.name },
          version: pkg.version,
        })),
      }),
    });
  } catch (error) {
    // Don't fail the build on an OSV outage; report and pass.
    console.warn(`\n⚠ OSV unreachable, skipping advisory check: ${error}`);
    return 0;
  }

  if (!response.ok) {
    console.warn(`\n⚠ OSV returned HTTP ${response.status}; skipping.`);
    return 0;
  }

  const { results = [] } = await response.json() as {
    results?: { vulns?: { id: string }[] }[];
  };

  const findings = npm
    .map((pkg, index) => ({ pkg, vulns: results[index]?.vulns ?? [] }))
    .filter((entry) => entry.vulns.length > 0);

  console.log(
    `\n# Advisories\nOSV checked ${npm.length} npm packages (JSR not covered by OSV).`,
  );
  if (findings.length === 0) {
    console.log("No known npm advisories. ✓");
    return 0;
  }

  console.error(`\n✗ ${findings.length} package(s) with advisories:`);
  for (const { pkg, vulns } of findings) {
    const ids = vulns.map((vuln) => vuln.id).join(", ");
    console.error(
      `  ${pkg.name}@${pkg.version} — ${ids} (https://osv.dev/${vulns[0].id})`,
    );
  }
  return 1;
}

if (import.meta.main) {
  Deno.exit(await main());
}
