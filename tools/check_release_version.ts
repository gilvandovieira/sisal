interface RootConfig {
  readonly workspace?: readonly string[];
}

interface PackageConfig {
  readonly name?: string;
  readonly version?: string;
}

const expectedVersion = Deno.args[0];

if (expectedVersion === undefined || expectedVersion.length === 0) {
  console.error("Usage: check_release_version.ts <version>");
  Deno.exit(1);
}

const root = await readJson<RootConfig>("deno.json");
let failed = false;

for (const member of root.workspace ?? []) {
  const path = normalizePath(member);

  if (!path.startsWith("packages/")) {
    continue;
  }

  const configPath = `${path}/deno.json`;
  const config = await readJson<PackageConfig>(configPath);

  if (config.version !== expectedVersion) {
    console.error(
      `${
        config.name ?? path
      } is ${config.version}, expected ${expectedVersion}`,
    );
    failed = true;
  }
}

const expectedAdapterVersion =
  `const DEFAULT_ADAPTER_VERSION = "^${expectedVersion}";`;
const migrateCli = await Deno.readTextFile("packages/migrate/src/cli.ts");

if (!migrateCli.includes(expectedAdapterVersion)) {
  console.error(
    "packages/migrate/src/cli.ts DEFAULT_ADAPTER_VERSION must match " +
      `^${expectedVersion}`,
  );
  failed = true;
}

if (failed) {
  Deno.exit(1);
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
