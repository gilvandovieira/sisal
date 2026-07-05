/**
 * Builds Sisal's workspace packages into publishable npm artifacts under
 * `npm/<id>/`, using Deno's official [`dnt`](https://jsr.io/@deno/dnt).
 *
 * Deno/JSR stays the source of truth: this reads each package's `deno.json`
 * (version + `exports`) and transforms the Deno sources — rewriting `.ts`
 * specifiers and `jsr:`/`npm:` driver schemes, remapping the `@sisal/*` scope to
 * `@sisaljs/*`, and emitting ESM/CJS + `.d.ts` — so npm never has a hand-edited
 * manifest to drift. The package graph, sibling mappings, and derived
 * deps/peers all come from `tools/npm_manifest.ts`, the single source of truth
 * the drift gate (`deno task npm:check`) shares. See
 * `docs/npm-distribution-plan.md` (Phases 2–3).
 *
 * Usage:
 *   deno run -A tools/build_npm.ts core            # one package
 *   deno run -A tools/build_npm.ts core orm migrate # several
 *   deno run -A tools/build_npm.ts all              # every package, deps-first
 *
 * @module
 */

import { build, emptyDir } from "@deno/dnt";
import {
  entryPoints,
  NPM_SCOPE,
  type PackageDescriptor,
  PACKAGES,
  readDenoJson,
  type SiblingMapping,
  siblingMappings,
} from "./npm_manifest.ts";

/**
 * Hand-written `bin` shim contents keyed by their package-relative path (the
 * value side of a descriptor's `bin`). Written verbatim in `postBuild` — a
 * shebang can't survive dnt's transform (it injects imports above line 0), so
 * the Node executable is authored here with `#!/usr/bin/env node`. The shim
 * self-imports the package's built subpath export, so it is layout-independent.
 */
const BIN_SHIMS: Readonly<Record<string, string>> = {
  "./bin/sisal.mjs": `#!/usr/bin/env node
// The \`sisal\` migration CLI on Node — self-imports the built \`./cli\` export
// and runs it against process.argv; its exit code becomes the process exit code.
import { runSisalCli } from "@sisaljs/migrate/cli";

const code = await runSisalCli(process.argv.slice(2));
process.exit(code);
`,
};

async function buildPackage(pkg: PackageDescriptor): Promise<void> {
  const config = await readDenoJson(pkg.id);
  const version = config.version ?? "0.0.0";
  const outDir = `npm/${pkg.id}`;

  // Sibling `@sisal/*` imports → external `@sisaljs/*` npm deps (not inlined);
  // driver specifiers → optional peer deps. Only mappings whose specifier is in
  // this package's graph may be passed — dnt errors on an unused mapping.
  const { mappings: siblings, dependencies } = await siblingMappings(pkg);
  const mappings: Record<string, SiblingMapping> = { ...siblings };

  const peerDependencies: Record<string, string> = {};
  const peerDependenciesMeta: Record<string, { optional: true }> = {};
  for (const driver of pkg.drivers ?? []) {
    mappings[driver.specifier] = { name: driver.name, version: driver.version };
    peerDependencies[driver.name] = driver.version;
    peerDependenciesMeta[driver.name] = { optional: true };
  }
  for (const [name, version] of Object.entries(pkg.extraPeers ?? {})) {
    peerDependencies[name] = version;
    peerDependenciesMeta[name] = { optional: true };
  }

  console.log(`\n▸ building ${NPM_SCOPE}/${pkg.id}@${version} → ${outDir}`);
  await emptyDir(outDir);

  // dnt's Node-side type-check is opt-in (BUILD_NPM_TYPECHECK=1). It is not the
  // authoritative gate — `deno task check` already type-checks the whole
  // workspace, including the `Temporal` global (Deno's lib declares it; stock
  // TypeScript does not yet, so the Node tsc needs a Temporal types dep first —
  // tracked as a follow-up). Runtime on Node 24+ is unaffected: Temporal is a
  // native global there.
  const typeCheck = Deno.env.get("BUILD_NPM_TYPECHECK") === "1"
    ? "both" as const
    : false;
  const test = Deno.env.get("BUILD_NPM_TEST") === "1";

  // Sibling deps (`@sisaljs/*`) aren't published yet, so `npm install` can't
  // resolve them. Skip install unless type-check/test needs a populated
  // node_modules (that mode requires the siblings to be built + linked first).
  const skipNpmInstall = !(typeCheck || test);

  await build({
    entryPoints: entryPoints(pkg.id, config.exports),
    outDir,
    importMap: "deno.json",
    shims: { deno: "dev" },
    test,
    typeCheck,
    declaration: "separate",
    esModule: true,
    // ESM-only: the migration CLI (`./cli`) uses top-level await, which cannot
    // be emitted as CommonJS. Sisal is ESM-native (Deno) and targets Node 24+,
    // so an ESM-only distribution is the clean choice; CJS is deferred.
    scriptModule: false,
    skipNpmInstall,
    mappings,
    package: {
      name: `${NPM_SCOPE}/${pkg.id}`,
      version,
      description: config.description,
      license: "MIT",
      type: "module",
      engines: { node: ">=24" },
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      ...(Object.keys(peerDependencies).length > 0
        ? { peerDependencies, peerDependenciesMeta }
        : {}),
      ...(pkg.bin ? { bin: { ...pkg.bin } } : {}),
      repository: {
        type: "git",
        url: "git+https://github.com/gilvandovieira/sisal.git",
        directory: `packages/${pkg.id}`,
      },
    },
    async postBuild() {
      await Deno.copyFile(
        `packages/${pkg.id}/README.md`,
        `${outDir}/README.md`,
      ).catch(() => {});
      // Write each `bin` shim (with its shebang) and mark it executable.
      for (const relPath of Object.values(pkg.bin ?? {})) {
        const content = BIN_SHIMS[relPath];
        if (content === undefined) {
          throw new Error(`No bin shim registered for "${relPath}"`);
        }
        const filePath = `${outDir}/${relPath.replace(/^\.\//, "")}`;
        await Deno.mkdir(filePath.slice(0, filePath.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.writeTextFile(filePath, content);
        await Deno.chmod(filePath, 0o755);
      }
    },
  });

  console.log(`✔ ${NPM_SCOPE}/${pkg.id} built`);
}

function selectPackages(args: readonly string[]): PackageDescriptor[] {
  if (args.length === 0) {
    console.error(
      "Usage: deno run -A tools/build_npm.ts <package-id...|all>\n" +
        `Packages: ${PACKAGES.map((p) => p.id).join(", ")}`,
    );
    Deno.exit(1);
  }

  if (args.includes("all")) {
    return [...PACKAGES];
  }

  return args.map((id) => {
    const pkg = PACKAGES.find((candidate) => candidate.id === id);
    if (pkg === undefined) {
      console.error(`Unknown package: ${id}`);
      Deno.exit(1);
    }
    return pkg;
  });
}

const selected = selectPackages(Deno.args);
for (const pkg of selected) {
  await buildPackage(pkg);
}
console.log(`\nDone: built ${selected.length} package(s) under npm/.`);
