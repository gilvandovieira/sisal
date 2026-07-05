/**
 * Runs Sisal's network-free unit suite under **Node** from the Deno sources,
 * proving the packages behave identically on both runtimes (plan NPM-15/16).
 *
 * The idiomatic `Deno.test` + `@std/assert` tests run on Node unchanged: `dnt`
 * transforms each `*_test.ts` (rewriting `.ts` specifiers and `jsr:`/`@std`
 * imports) and its dev **Deno shim** supplies `Deno.test` and the `Deno.*` fs
 * API, so no source codemod is needed. Two adjustments make it work:
 *
 * - Tests are scoped per package via `rootTestDir` (dnt would otherwise glob the
 *   whole repo, including the Docker-gated `integration/` suites).
 * - Siblings are **inlined** (no `@sisaljs/*` mapping) so cross-package tests
 *   resolve locally without the sibling packages being published first.
 * - dnt emits a **CommonJS** `test_runner.js`. The throwaway test package
 *   deliberately omits `"type": "module"` at its root, so Node runs that runner
 *   as CommonJS and it dynamically imports the ESM tests under `esm/` (which
 *   carry their own `{"type":"module"}` marker). The publishable build stays
 *   ESM-only; only this test scaffold is CJS-rooted.
 *
 * Output goes to `npm-test/<id>/` (separate from the publishable `npm/<id>/`).
 *
 * Usage:
 *   deno run -A tools/test_npm.ts core           # one package
 *   deno run -A tools/test_npm.ts core orm        # several
 *   deno run -A tools/test_npm.ts all             # every package
 *
 * The Deno-side authoritative run remains `deno task test`. `tools/lint` tests
 * are intentionally excluded here — they exercise Deno's lint-plugin API, which
 * has no Node equivalent.
 *
 * @module
 */

import { build, emptyDir } from "@deno/dnt";
import {
  entryPoints,
  type PackageDescriptor,
  PACKAGES,
  readDenoJson,
} from "./npm_manifest.ts";

async function testPackage(pkg: PackageDescriptor): Promise<void> {
  const config = await readDenoJson(pkg.id);
  const outDir = `npm-test/${pkg.id}`;

  console.log(`\n▸ node-testing ${pkg.id} → ${outDir}`);
  await emptyDir(outDir);

  await build({
    entryPoints: entryPoints(pkg.id, config.exports),
    outDir,
    importMap: "deno.json",
    // "dev": the Deno shim (Deno.test, fs, etc.) is a devDependency used by the
    // transformed tests only; shipped code keeps its real globalThis.Deno guards.
    // The custom Temporal shim gives the Node test run a `Temporal` global (via
    // the spec polyfill) — Sisal is Temporal-native, and Node < 25 has no native
    // Temporal. Shipped code still guards `typeof Temporal` so it degrades
    // gracefully where the global is absent; this only affects the test build.
    shims: {
      deno: "dev",
      custom: [{
        package: { name: "@js-temporal/polyfill", version: "^0.5.1" },
        globalNames: [{ name: "Temporal", exportName: "Temporal" }],
      }],
    },
    test: true,
    // Discover only this package's tests — dnt defaults to globbing the whole
    // CWD, which would drag in the network/FFI-gated integration/ suites.
    rootTestDir: `packages/${pkg.id}`,
    // Node runtime parity is the target, not types (stock tsc lacks Temporal;
    // `deno task check` is the authoritative type gate). Declarations add no
    // value to a throwaway test build.
    typeCheck: false,
    declaration: false,
    esModule: true,
    scriptModule: false,
    // No sibling mappings: inline `@sisal/*` deps so cross-package tests resolve
    // against local source instead of unpublished `@sisaljs/*`. dnt handles
    // `npm:` driver specifiers natively (rewrite + dep); the Deno-only computed
    // specifiers (@db/postgres, @db/sqlite, @neon, mariadb) stay opaque and are
    // never pulled in — adapter unit tests inject fakes and never open a driver.
    //
    // Note the absence of `type: "module"`: it makes Node treat dnt's CommonJS
    // `test_runner.js` as CJS (so it runs), while the transformed tests under
    // `esm/` stay ESM via dnt's own `esm/package.json` marker.
    package: {
      name: `@sisaljs-test/${pkg.id}`,
      version: config.version ?? "0.0.0",
      private: true,
    },
  });

  console.log(`✔ ${pkg.id} unit suite passed under Node`);
}

function selectPackages(args: readonly string[]): PackageDescriptor[] {
  if (args.length === 0) {
    console.error(
      "Usage: deno run -A tools/test_npm.ts <package-id...|all>\n" +
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
  await testPackage(pkg);
}
console.log(`\nDone: ran ${selected.length} package suite(s) under Node.`);
