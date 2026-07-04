/**
 * Package-boundary pins for `@sisal/analytics` (v0.11 T1), enforcing the
 * dependency edges recorded in `docs/architecture.md`:
 *
 * - `@sisal/core`, `@sisal/orm`, `@sisal/migrate`, and `@sisal/etl` never
 *   import `@sisal/analytics`;
 * - `@sisal/analytics` imports only `@sisal/core`, std/node helpers, and its
 *   own relative modules — no adapters, drivers, ORM, migrate, or ETL runtime.
 *
 * Static source scan; no network, no imports of the checked packages.
 */
import { assertEquals } from "@std/assert";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

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

Deno.test("boundary: core/orm/migrate/etl never import @sisal/analytics", async () => {
  for (
    const packageDir of [
      "packages/core",
      "packages/orm",
      "packages/migrate",
      "packages/etl",
    ]
  ) {
    const imports = await collectImports(packageDir);
    assertEquals(
      offenders(
        imports,
        (specifier) => specifier.startsWith("@sisal/analytics"),
      ),
      [],
      `${packageDir} must not depend on @sisal/analytics`,
    );
  }
});

Deno.test("boundary: analytics imports only @sisal/core, std/node, and itself", async () => {
  const imports = await collectImports("packages/analytics");
  const allowed = [
    /^@sisal\/core($|\/)/,
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
    "analytics must not import adapters, drivers, ORM, migrate, or ETL runtime",
  );
});
