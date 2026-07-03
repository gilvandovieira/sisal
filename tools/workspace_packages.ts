interface DenoConfig {
  readonly name?: string;
  readonly workspace?: readonly string[];
  readonly exports?: unknown;
  readonly publish?: false | {
    readonly exclude?: readonly string[];
  };
}

interface WorkspacePackage {
  readonly name: string;
  readonly path: string;
  readonly entrypoints: readonly string[];
}

const command = Deno.args[0] ?? "matrix";
const packages = await discoverPackages();

switch (command) {
  case "matrix":
    console.log(JSON.stringify({
      include: packages.map((pkg) => ({
        package: pkg.name,
        path: pkg.path,
      })),
    }));
    break;
  case "paths":
    console.log(packages.map((pkg) => pkg.path).join("\n"));
    break;
  case "entrypoints": {
    const packagePath = normalizePath(Deno.args[1] ?? "");
    const pkg = packages.find((candidate) => candidate.path === packagePath);

    if (pkg === undefined) {
      console.error(`Unknown workspace package path: ${packagePath}`);
      Deno.exit(1);
    }

    console.log(pkg.entrypoints.join("\n"));
    break;
  }
  case "check-entrypoints": {
    // Everything the root `deno task check` type-checks: each workspace
    // package's export entrypoints plus the examples, benchmarks, and perf
    // probes that live outside the workspace packages. Discovered instead of
    // hard-coded so new packages/examples/probes cannot silently drift out
    // of the check.
    const entrypoints = [
      ...packages.flatMap((pkg) => pkg.entrypoints),
      ...await rootEntrypoints(),
    ];
    console.log(entrypoints.join("\n"));
    break;
  }
  default:
    console.error(
      "Usage: deno run --allow-read tools/workspace_packages.ts " +
        "[matrix|paths|entrypoints <package-path>|check-entrypoints]",
    );
    Deno.exit(1);
}

async function discoverPackages(): Promise<WorkspacePackage[]> {
  const rootConfig = await readJson<DenoConfig>("deno.json");
  const packages: WorkspacePackage[] = [];

  for (const member of rootConfig.workspace ?? []) {
    const packagePath = normalizePath(member);

    if (!packagePath.startsWith("packages/")) {
      continue;
    }

    const configPath = `${packagePath}/deno.json`;
    const config = await readJson<DenoConfig>(configPath);

    if (config.exports === undefined || isPublishDisabled(config)) {
      continue;
    }

    packages.push({
      name: config.name ?? packagePath,
      path: packagePath,
      entrypoints: exportEntrypoints(packagePath, config.exports),
    });
  }

  return packages;
}

function exportEntrypoints(
  packagePath: string,
  exportsField: unknown,
): string[] {
  const entrypoints: string[] = [];

  for (const target of exportTargets(exportsField)) {
    if (!target.endsWith(".ts")) {
      continue;
    }

    entrypoints.push(`${packagePath}/${normalizePath(target)}`);
  }

  return [...new Set(entrypoints)].sort();
}

function exportTargets(exportsField: unknown): string[] {
  if (typeof exportsField === "string") {
    return [exportsField];
  }

  if (!isRecord(exportsField)) {
    return [];
  }

  const targets: string[] = [];

  for (const value of Object.values(exportsField)) {
    const target = resolveExportTarget(value);

    if (target !== undefined) {
      targets.push(target);
    }
  }

  return targets;
}

function resolveExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const defaultTarget = value.default;
  if (typeof defaultTarget === "string") {
    return defaultTarget;
  }

  const importTarget = value.import;
  if (typeof importTarget === "string") {
    return importTarget;
  }

  return undefined;
}

function isPublishDisabled(config: DenoConfig): boolean {
  if (config.publish === false) {
    return true;
  }

  return config.publish?.exclude?.includes("**/*") ?? false;
}

// Entrypoints outside the workspace packages: every example's mod.ts, the
// benchmark suite, and the perf probes (their *_test.ts files belong to the
// test task, not the check task).
async function rootEntrypoints(): Promise<string[]> {
  const entrypoints: string[] = [];

  for await (const example of Deno.readDir("examples")) {
    if (!example.isDirectory) {
      continue;
    }

    const modPath = `examples/${example.name}/mod.ts`;
    if (await isFile(modPath)) {
      entrypoints.push(modPath);
    }
  }

  if (await isFile("benchmarks/mod.ts")) {
    entrypoints.push("benchmarks/mod.ts");
  }

  for await (const probe of Deno.readDir("perf")) {
    if (
      probe.isFile && probe.name.endsWith(".ts") &&
      !probe.name.endsWith("_test.ts")
    ) {
      entrypoints.push(`perf/${probe.name}`);
    }
  }

  return entrypoints.sort();
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .replace(/^\//, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
