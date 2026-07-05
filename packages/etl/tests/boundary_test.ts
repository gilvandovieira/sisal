/**
 * Package-boundary pins for `@sisal/etl` (v0.10 T11), enforcing the
 * dependency edges recorded in `docs/architecture.md`:
 *
 * - `@sisal/orm` (and `@sisal/core`, and `@sisal/migrate`) never import
 *   `@sisal/etl` — the OLTP core stays clean of the analytical surface;
 * - `@sisal/etl` never imports an adapter, a database driver, or
 *   `@sisal/migrate` — it reaches only `@sisal/core` (job model + SQL
 *   compilation) and `@sisal/orm` (the checkpoint/lock runtime substrate),
 *   and executes through whatever `Database` the caller injects;
 * - the ETL runtime edge stays out of the compile tier: only `runner.ts`
 *   (and tests) may import `@sisal/orm`.
 *
 * Static source scan; no network, no imports of the checked packages.
 */
import { assertEquals } from "@std/assert";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

// This static scan walks the Deno source tree (`packages/*`); under the
// dnt-built Node suite that tree isn't present, so it runs under Deno only. The
// same boundary is independently enforced by the `tools/lint` package-boundary
// plugin. Detect real Deno via FFI — dnt's Node test shim fakes `Deno.version`
// but not `Deno.dlopen`.
const isRealDeno =
  typeof (globalThis as { Deno?: { dlopen?: unknown } }).Deno?.dlopen ===
    "function";

interface FileImports {
  readonly file: string;
  readonly specifiers: readonly string[];
}

async function collectTsFiles(dir: string, out: string[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      await collectTsFiles(path, out);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      out.push(path);
    }
  }
}

const IMPORT_SPECIFIER =
  /(?:^|\s)(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm;

async function collectImports(packageDir: string): Promise<FileImports[]> {
  const files: string[] = [];
  await collectTsFiles(join(repoRoot, packageDir), files);
  files.sort();
  const results: FileImports[] = [];
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    const specifiers: string[] = [];
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
    results.push({ file: relative(repoRoot, file), specifiers });
  }
  return results;
}

function offenders(
  imports: readonly FileImports[],
  isForbidden: (specifier: string, file: string) => boolean,
): string[] {
  return imports.flatMap(({ file, specifiers }) =>
    specifiers.filter((specifier) => isForbidden(specifier, file))
      .map((specifier) => `${file} -> ${specifier}`)
  );
}

Deno.test("boundary: orm/core/migrate never import @sisal/etl", async () => {
  if (!isRealDeno) return; // Deno source-tree scan; see above
  for (
    const packageDir of ["packages/core", "packages/orm", "packages/migrate"]
  ) {
    const imports = await collectImports(packageDir);
    assertEquals(
      offenders(imports, (specifier) => specifier.startsWith("@sisal/etl")),
      [],
      `${packageDir} must not depend on @sisal/etl`,
    );
  }
});

Deno.test("boundary: etl imports only @sisal/core, @sisal/orm, std, and itself", async () => {
  if (!isRealDeno) return; // Deno source-tree scan; see above
  const imports = await collectImports("packages/etl");
  const allowed = [
    /^@sisal\/core($|\/)/,
    /^@sisal\/orm($|\/)/,
    /^@std\//,
    /^node:/,
    /^\.\.?\//,
  ];
  assertEquals(
    offenders(
      imports,
      (specifier) => !allowed.some((pattern) => pattern.test(specifier)),
    ),
    [],
    "etl must not import adapters, drivers, or @sisal/migrate",
  );
});

Deno.test("boundary: only the runner tier takes the @sisal/orm edge", async () => {
  if (!isRealDeno) return; // Deno source-tree scan; see above
  const imports = await collectImports("packages/etl");
  assertEquals(
    offenders(
      imports,
      (specifier, file) =>
        /^@sisal\/orm($|\/)/.test(specifier) &&
        file !== "packages/etl/src/runner.ts" &&
        !file.endsWith("_test.ts"),
    ),
    [],
    "job/window/rollup/mod must stay @sisal/core-only",
  );
});
