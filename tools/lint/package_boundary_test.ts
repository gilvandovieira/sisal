/**
 * Workspace package-boundary pins for the v0.11 release shape.
 *
 * This complements the package-local ETL/analytics boundary tests with the
 * whole layered graph: core stays driverless, ORM/migrate stay below preview
 * layers, adapters only depend downward, and examples import public package
 * surfaces instead of reaching through private files.
 */
import { assertEquals } from "@std/assert";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const packageDirs = [
  "packages/core",
  "packages/orm",
  "packages/migrate",
  "packages/etl",
  "packages/analytics",
  "packages/pg",
  "packages/neon",
  "packages/sqlite",
  "packages/libsql",
  "packages/mysql",
] as const;

const productionPolicy: Record<string, readonly RegExp[]> = {
  "packages/core": [],
  "packages/orm": [/^@sisal\/core($|\/)/],
  "packages/migrate": [
    /^@sisal\/core($|\/)/,
    /^@sisal\/migrate($|\/)/,
  ],
  "packages/etl": [
    /^@sisal\/core($|\/)/,
    /^@sisal\/orm($|\/)/,
    /^@sisal\/etl($|\/)/,
  ],
  "packages/analytics": [
    /^@sisal\/core($|\/)/,
    /^@sisal\/analytics($|\/)/,
  ],
  "packages/pg": [
    /^@sisal\/core($|\/)/,
    /^@sisal\/orm($|\/)/,
    /^@sisal\/migrate($|\/)/,
    /^@sisal\/pg($|\/)/,
  ],
  "packages/neon": [
    /^@sisal\/core($|\/)/,
    /^@sisal\/orm($|\/)/,
    /^@sisal\/migrate($|\/)/,
    /^@sisal\/pg($|\/)/,
    /^@sisal\/neon($|\/)/,
  ],
  "packages/sqlite": [
    /^@sisal\/core($|\/)/,
    /^@sisal\/orm($|\/)/,
    /^@sisal\/migrate($|\/)/,
    /^@sisal\/sqlite($|\/)/,
  ],
  "packages/libsql": [
    /^@sisal\/core($|\/)/,
    /^@sisal\/orm($|\/)/,
    /^@sisal\/migrate($|\/)/,
    /^@sisal\/sqlite($|\/)/,
    /^@sisal\/libsql($|\/)/,
  ],
  "packages/mysql": [
    /^@sisal\/core($|\/)/,
    /^@sisal\/orm($|\/)/,
    /^@sisal\/migrate($|\/)/,
    /^@sisal\/mysql($|\/)/,
  ],
};

interface FileImports {
  readonly file: string;
  readonly specifiers: readonly string[];
}

async function collectTsFiles(
  dir: string,
  out: string[],
  includeTests = true,
): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      await collectTsFiles(path, out, includeTests);
    } else if (
      entry.isFile &&
      entry.name.endsWith(".ts") &&
      (includeTests || !entry.name.endsWith("_test.ts"))
    ) {
      out.push(path);
    }
  }
}

const importSpecifier =
  /(?:^|\s)(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm;

async function collectImports(
  dir: string,
  includeTests = true,
): Promise<FileImports[]> {
  const files: string[] = [];
  await collectTsFiles(join(repoRoot, dir), files, includeTests);
  files.sort();
  const results: FileImports[] = [];
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    const specifiers: string[] = [];
    for (const match of source.matchAll(importSpecifier)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
    results.push({ file: relative(repoRoot, file), specifiers });
  }
  return results;
}

function sisalOffenders(
  imports: readonly FileImports[],
  isAllowed: (specifier: string) => boolean,
): string[] {
  return imports.flatMap(({ file, specifiers }) =>
    specifiers
      .filter((specifier) =>
        specifier.startsWith("@sisal/") && !isAllowed(specifier)
      )
      .map((specifier) => `${file} -> ${specifier}`)
  );
}

async function publicPackageSpecifiers(): Promise<Set<string>> {
  const specifiers = new Set<string>();
  for (const packageDir of packageDirs) {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(repoRoot, packageDir, "deno.json")),
    ) as {
      readonly name: string;
      readonly exports: string | Record<string, string>;
    };
    if (typeof manifest.exports === "string") {
      specifiers.add(manifest.name);
      continue;
    }
    for (const key of Object.keys(manifest.exports)) {
      if (key === ".") {
        specifiers.add(manifest.name);
      } else if (key !== "./unstable-internal") {
        specifiers.add(`${manifest.name}/${key.slice(2)}`);
      }
    }
  }
  return specifiers;
}

Deno.test("boundary: production packages follow the layered workspace graph", async () => {
  for (const packageDir of packageDirs) {
    const imports = await collectImports(packageDir, false);
    const allowed = productionPolicy[packageDir];
    assertEquals(
      sisalOffenders(
        imports,
        (specifier) => allowed.some((pattern) => pattern.test(specifier)),
      ),
      [],
      `${packageDir} has an unexpected @sisal/* production dependency`,
    );
  }
});

Deno.test("boundary: examples import only public Sisal package surfaces", async () => {
  const publicSpecifiers = await publicPackageSpecifiers();
  const imports = await collectImports("examples");
  assertEquals(
    sisalOffenders(imports, (specifier) => publicSpecifiers.has(specifier)),
    [],
    "examples must not import private package files or unstable internals",
  );
});
