/**
 * The single source of truth for Sisal's npm package graph: the workspace
 * descriptor table plus the pure functions that derive each package's npm
 * manifest **intent** from its `deno.json`.
 *
 * Deno/JSR stays authoritative — this module never edits a manifest by hand. It
 * is shared by two consumers so they can never diverge:
 *
 * - `tools/build_npm.ts` feeds the descriptors + derived deps/peers into `dnt`,
 *   which emits the real `npm/<id>/package.json`.
 * - `tools/generate_npm_manifests.ts` serializes {@link buildManifest} for every
 *   package into the committed `docs/npm-manifests.json` and re-derives it under
 *   `--check` to fail on drift (versions, exports, dep graph).
 *
 * @module
 */

/** npm scope Sisal publishes under (JSR keeps `@sisal/*`; see the plan). */
export const NPM_SCOPE = "@sisaljs";

/** Version peer/dep range for a workspace sibling package. */
function siblingRange(version: string | undefined): string {
  return `^${version ?? "0.0.0"}`;
}

/**
 * A cross-runtime driver an adapter lazily imports: the source specifier as it
 * appears in the Deno code, remapped to its npm package. dnt validates that the
 * specifier is actually present in the package's graph, so each entry must
 * correspond to a real import in that adapter.
 *
 * Deno-only guarded drivers (`@db/postgres`, `@db/sqlite`) are **not** listed
 * here — they are imported through an opaque specifier the code guards behind a
 * runtime check, so dnt never pulls their Deno-specific sources into the Node
 * build.
 */
export interface DriverMapping {
  /** Specifier as imported in the Deno source (bare or `npm:`-prefixed). */
  readonly specifier: string;
  /** npm package it maps to. */
  readonly name: string;
  /** Version range for the optional `peerDependency`. */
  readonly version: string;
}

/**
 * A publishable workspace package: its directory id, the sibling packages it
 * imports (mapped to `@sisaljs/*` npm deps), and the driver mappings its
 * adapter lazily imports (mapped to optional peer deps). Entry points and
 * version come from `deno.json`.
 */
export interface PackageDescriptor {
  /** Directory id under `packages/` and `npm/`. */
  readonly id: string;
  /** Sibling package ids imported at runtime → regular `dependencies`. */
  readonly deps: readonly string[];
  /** Cross-runtime driver specifiers → optional `peerDependencies`. */
  readonly drivers?: readonly DriverMapping[];
  /**
   * Optional peer deps for drivers imported through a **computed** specifier
   * (opaque to dnt, so they get no mapping): name → version range. Declared as
   * optional peers so consumers who use that driver install it themselves.
   */
  readonly extraPeers?: Readonly<Record<string, string>>;
  /**
   * npm `bin` entries: command name → package-relative shim path (e.g.
   * `{ sisal: "./bin/sisal.mjs" }`). `tools/build_npm.ts` writes the shim file
   * (it can't come from Deno source — dnt mangles the `#!` shebang).
   */
  readonly bin?: Readonly<Record<string, string>>;
}

/**
 * The workspace packages in dependency order (a package's deps precede it), so
 * `all` builds — and a later publish loops — bottom-up. Mirrors the JSR graph.
 */
export const PACKAGES: readonly PackageDescriptor[] = [
  { id: "core", deps: [] },
  { id: "orm", deps: ["core"] },
  { id: "migrate", deps: ["core"], bin: { sisal: "./bin/sisal.mjs" } },
  {
    id: "pg",
    deps: ["orm", "migrate"],
    drivers: [
      { specifier: "npm:postgres@^3.4.7", name: "postgres", version: "^3.4.7" },
    ],
  },
  {
    id: "neon",
    deps: ["orm", "pg"],
    // Neon's driver is imported via a computed, runtime-aware specifier
    // (Deno → `@neon/serverless`, Node → `@neondatabase/serverless`), invisible
    // to dnt — declared as an optional peer without a mapping.
    extraPeers: { "@neondatabase/serverless": "^1.0.0" },
  },
  // sqlite's Node driver is the built-in `node:sqlite` — no peer dep; its
  // Deno `@db/sqlite` path is opaque-imported and guarded at runtime.
  { id: "sqlite", deps: ["orm", "migrate"] },
  {
    id: "libsql",
    deps: ["orm", "migrate", "sqlite"],
    drivers: [
      {
        specifier: "npm:@libsql/client@^0.17.4",
        name: "@libsql/client",
        version: "^0.17.4",
      },
    ],
  },
  {
    id: "mysql",
    deps: ["orm", "migrate"],
    drivers: [
      {
        specifier: "npm:mysql2@^3.22.5/promise",
        name: "mysql2",
        version: "^3.22.5",
      },
    ],
    // mariadb is imported via a computed specifier (LGPL soft dep), invisible
    // to dnt — declared as an optional peer without a mapping.
    extraPeers: { mariadb: "^3.5.3" },
  },
  { id: "etl", deps: ["core", "orm"] },
  { id: "analytics", deps: ["core", "orm"] },
];

/** The subset of `deno.json` this tooling reads. */
export interface DenoJson {
  readonly version?: string;
  readonly description?: string;
  readonly exports?: Record<string, string> | string;
}

/** Reads and parses `packages/<id>/deno.json`. */
export async function readDenoJson(id: string): Promise<DenoJson> {
  return JSON.parse(
    await Deno.readTextFile(`packages/${id}/deno.json`),
  ) as DenoJson;
}

/** Normalizes a `deno.json` `exports` (string or map) to a subpath → file map. */
export function normalizeExports(
  exports: DenoJson["exports"],
): Record<string, string> {
  return typeof exports === "string" ? { ".": exports } : exports ?? {};
}

/**
 * Collects the `@sisal/<pkg>[/<subpath>]` specifiers a package's shipped source
 * actually imports. Sibling mappings must match a specifier present in the
 * graph — dnt errors on an unused mapping — so this drives which sibling export
 * files get mapped.
 */
export async function usedSisalSpecifiers(id: string): Promise<Set<string>> {
  const found = new Set<string>();
  const pattern = /from\s+"(@sisal\/[a-z]+(?:\/[a-z-]+)?)"/g;

  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(path);
      } else if (
        entry.name.endsWith(".ts") && !entry.name.endsWith("_test.ts")
      ) {
        const source = await Deno.readTextFile(path);
        for (const match of source.matchAll(pattern)) {
          found.add(match[1]);
        }
      }
    }
  }

  await walk(`packages/${id}`);
  return found;
}

/** A dnt sibling mapping: an `@sisaljs/*` npm dep an export file resolves to. */
export interface SiblingMapping {
  readonly name: string;
  readonly version: string;
  readonly subPath?: string;
}

/**
 * Builds dnt `mappings` (keyed by each dep's resolved export file) plus the
 * `dependencies` for a package's sibling `@sisal/*` imports, remapped to the
 * `@sisaljs/*` npm scope. Only the subpaths the package actually imports are
 * mapped.
 *
 * Also enforces the descriptor invariant the drift gate depends on: every
 * `@sisal/<pkg>` a package imports must be declared in its {@link
 * PackageDescriptor.deps}. An import without a matching `dep` would silently
 * drop a dependency from the generated manifest — a broken npm package — so it
 * throws instead.
 */
export async function siblingMappings(pkg: PackageDescriptor): Promise<{
  mappings: Record<string, SiblingMapping>;
  dependencies: Record<string, string>;
}> {
  const used = await usedSisalSpecifiers(pkg.id);

  const declared = new Set(pkg.deps);
  for (const specifier of used) {
    const depId = specifier.slice("@sisal/".length).split("/")[0];
    // A self-import (`@sisal/<self>/<subpath>`) resolves to a local export file
    // and is inlined by dnt — it's not an external dependency, so skip it.
    if (depId === pkg.id) {
      continue;
    }
    if (!declared.has(depId)) {
      throw new Error(
        `${pkg.id} imports "${specifier}" but "${depId}" is not in its ` +
          `descriptor deps — add it to PACKAGES in tools/npm_manifest.ts so ` +
          `the generated manifest declares @sisaljs/${depId} as a dependency.`,
      );
    }
  }

  const mappings: Record<string, SiblingMapping> = {};
  const dependencies: Record<string, string> = {};

  for (const dep of pkg.deps) {
    const depConfig = await readDenoJson(dep);
    const npmName = `${NPM_SCOPE}/${dep}`;
    let depUsed = false;

    for (
      const [key, file] of Object.entries(normalizeExports(depConfig.exports))
    ) {
      const version = siblingRange(depConfig.version);
      const specifier = key === "."
        ? `@sisal/${dep}`
        : `@sisal/${dep}${key.slice(1)}`;
      if (!used.has(specifier)) {
        continue;
      }
      depUsed = true;
      const filePath = `packages/${dep}/${file.replace(/^\.\//, "")}`;
      mappings[filePath] = key === "."
        ? { name: npmName, version }
        : { name: npmName, version, subPath: key.slice(2) };
    }

    if (depUsed) {
      dependencies[npmName] = siblingRange(depConfig.version);
    }
  }

  return { mappings, dependencies };
}

/** dnt entry points for a package, derived from its `deno.json` `exports`. */
export function entryPoints(id: string, exports: DenoJson["exports"]) {
  return Object.entries(normalizeExports(exports)).map(([name, path]) => ({
    name,
    path: `packages/${id}/${path.replace(/^\.\//, "")}`,
  }));
}

/** Returns a copy of `record` with its keys sorted, for stable serialization. */
function sortByKey<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * The committed **intent** of a package's generated `package.json`: the
 * drift-sensitive surface (name, version, module type, engines, the exported
 * subpaths, and the dependency/peer graph) derived purely from `deno.json` and
 * the descriptor table. dnt renders the full manifest from the same inputs; this
 * is the slice the drift gate freezes so a `deno.json` change that would alter
 * the npm surface can't land without a matching manifest regeneration.
 */
export interface NpmManifest {
  readonly name: string;
  readonly version: string;
  readonly type: "module";
  readonly engines: { readonly node: string };
  /** Exported subpath keys (`.`, `./orm`, …), sorted; mirrors `deno.json`. */
  readonly exports: readonly string[];
  /** npm `bin` commands → shim path, when the package ships an executable. */
  readonly bin?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { readonly optional: true }>;
}

/** Derives a package's {@link NpmManifest} from its `deno.json` + descriptor. */
export async function buildManifest(
  pkg: PackageDescriptor,
): Promise<NpmManifest> {
  const config = await readDenoJson(pkg.id);
  const { dependencies } = await siblingMappings(pkg);

  const peerDependencies: Record<string, string> = {};
  const peerDependenciesMeta: Record<string, { optional: true }> = {};
  for (const driver of pkg.drivers ?? []) {
    peerDependencies[driver.name] = driver.version;
    peerDependenciesMeta[driver.name] = { optional: true };
  }
  for (const [name, version] of Object.entries(pkg.extraPeers ?? {})) {
    peerDependencies[name] = version;
    peerDependenciesMeta[name] = { optional: true };
  }

  const exports = Object.keys(normalizeExports(config.exports)).sort();

  return {
    name: `${NPM_SCOPE}/${pkg.id}`,
    version: config.version ?? "0.0.0",
    type: "module",
    engines: { node: ">=24" },
    exports,
    ...(pkg.bin ? { bin: sortByKey({ ...pkg.bin }) } : {}),
    ...(Object.keys(dependencies).length > 0
      ? { dependencies: sortByKey(dependencies) }
      : {}),
    ...(Object.keys(peerDependencies).length > 0
      ? {
        peerDependencies: sortByKey(peerDependencies),
        peerDependenciesMeta: sortByKey(peerDependenciesMeta),
      }
      : {}),
  };
}
