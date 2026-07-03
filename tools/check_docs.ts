import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODULE_DOC_MINIMUM = 1;
const JSDOC_MINIMUM = 0.8;

interface DenoConfig {
  readonly name?: string;
  readonly workspace?: readonly string[];
  readonly exports?: unknown;
}

interface ExportModule {
  readonly packageName: string;
  readonly exportName: string;
  readonly path: string;
}

interface DocJson {
  readonly nodes?: Record<string, DocNode>;
}

interface DocNode {
  readonly module_doc?: {
    readonly doc?: string;
    readonly tags?: readonly { readonly kind?: string }[];
  };
  readonly symbols?: readonly DocSymbol[];
}

interface DocSymbol {
  readonly name: string;
  readonly declarations?: readonly DocDeclaration[];
}

interface DocDeclaration {
  readonly kind?: string;
  readonly jsDoc?: {
    readonly doc?: string;
    readonly tags?: readonly unknown[];
  };
  readonly location?: {
    readonly filename?: string;
    readonly line?: number;
    readonly col?: number;
  };
}

interface JsDocEntry {
  readonly label: string;
  documented: boolean;
}

const textDecoder = new TextDecoder();

const rootDir = Deno.cwd();
const rootConfig = await readJson<DenoConfig>(join(rootDir, "deno.json"));
const exportModules = await getExportModules(rootConfig);

if (exportModules.length === 0) {
  console.error("No package export modules found.");
  Deno.exit(1);
}

const moduleResults: {
  readonly module: ExportModule;
  readonly documented: boolean;
}[] = [];
const jsDocEntries = new Map<string, JsDocEntry>();

for (const exportModule of exportModules) {
  const docJson = await denoDocJson(exportModule.path);
  const node = docJson.nodes?.[pathToFileURL(exportModule.path).href];

  if (node === undefined) {
    throw new Error(`Missing deno doc node for ${exportModule.path}`);
  }

  const moduleDoc = node.module_doc;
  const hasModuleTag = moduleDoc?.tags?.some((tag) => tag.kind === "module") ??
    false;
  const hasModuleText = (moduleDoc?.doc?.trim() ?? "").length > 0;

  moduleResults.push({
    module: exportModule,
    documented: hasModuleTag && hasModuleText,
  });

  for (const symbol of node.symbols ?? []) {
    const declarations = symbol.declarations ?? [];
    const key = getSymbolKey(exportModule, symbol);
    const label = getSymbolLabel(exportModule, symbol);
    const documented = declarations.some(hasJsDoc);
    const existing = jsDocEntries.get(key);

    if (existing === undefined) {
      jsDocEntries.set(key, { label, documented });
    } else {
      existing.documented = existing.documented || documented;
    }
  }
}

const documentedModules = moduleResults.filter((result) => result.documented)
  .length;
const moduleCoverage = documentedModules / moduleResults.length;

const jsDocValues = [...jsDocEntries.values()];
const documentedJsDoc = jsDocValues.filter((entry) => entry.documented).length;
const jsDocCoverage = jsDocValues.length === 0
  ? 1
  : documentedJsDoc / jsDocValues.length;

console.log(
  `Module docs: ${documentedModules}/${moduleResults.length} (${
    formatPercent(moduleCoverage)
  })`,
);
console.log(
  `JSDoc coverage: ${documentedJsDoc}/${jsDocValues.length} (${
    formatPercent(jsDocCoverage)
  })`,
);

const missingModuleDocs = moduleResults.filter((result) => !result.documented);
const missingJsDocs = jsDocValues.filter((entry) => !entry.documented);

let failed = false;

if (moduleCoverage < MODULE_DOC_MINIMUM) {
  failed = true;
  console.error("\nMissing module docs:");
  for (const result of missingModuleDocs) {
    console.error(`  - ${formatModuleLabel(result.module)}`);
  }
}

if (jsDocCoverage < JSDOC_MINIMUM) {
  failed = true;
  console.error("\nMissing JSDoc entries:");
  for (const entry of missingJsDocs.slice(0, 50)) {
    console.error(`  - ${entry.label}`);
  }

  if (missingJsDocs.length > 50) {
    console.error(`  - ...and ${missingJsDocs.length - 50} more`);
  }
}

if (failed) {
  Deno.exit(1);
}

async function getExportModules(
  config: DenoConfig,
): Promise<ExportModule[]> {
  const modules: ExportModule[] = [];

  for (const workspaceMember of config.workspace ?? []) {
    const packageDir = resolve(rootDir, workspaceMember);
    const packageConfigPath = join(packageDir, "deno.json");

    try {
      await Deno.stat(packageConfigPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }

      throw error;
    }

    const packageConfig = await readJson<DenoConfig>(packageConfigPath);

    if (packageConfig.exports === undefined) {
      continue;
    }

    for (
      const [exportName, exportTarget] of normalizeExports(
        packageConfig.exports,
      )
    ) {
      if (!exportTarget.endsWith(".ts")) {
        continue;
      }

      modules.push({
        packageName: packageConfig.name ?? workspaceMember,
        exportName,
        path: resolve(packageDir, exportTarget),
      });
    }
  }

  return modules;
}

function normalizeExports(
  exportsField: unknown,
): [exportName: string, exportTarget: string][] {
  if (typeof exportsField === "string") {
    return [[".", exportsField]];
  }

  if (!isRecord(exportsField)) {
    return [];
  }

  const exports: [string, string][] = [];

  for (const [exportName, value] of Object.entries(exportsField)) {
    const exportTarget = resolveExportTarget(value);

    if (exportTarget !== undefined) {
      exports.push([exportName, exportTarget]);
    }
  }

  return exports;
}

function resolveExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const condition of ["deno", "import", "default"]) {
    const conditionedValue = value[condition];

    if (typeof conditionedValue === "string") {
      return conditionedValue;
    }
  }

  return undefined;
}

function getSymbolKey(module: ExportModule, symbol: DocSymbol): string {
  const declarations = symbol.declarations ?? [];
  const locationKey = declarations.map((declaration) => {
    const location = declaration.location;

    if (location === undefined) {
      return "";
    }

    return `${location.filename}:${location.line}:${location.col}`;
  }).join("|");

  return `${symbol.name}:${locationKey || formatModuleLabel(module)}`;
}

function getSymbolLabel(module: ExportModule, symbol: DocSymbol): string {
  const declaration = symbol.declarations?.[0];
  const location = declaration?.location;

  if (location?.filename === undefined) {
    return `${formatModuleLabel(module)} ${symbol.name}`;
  }

  return `${symbol.name} (${
    relative(rootDir, fileUrlToPath(location.filename))
  }:${location.line ?? 1})`;
}

function hasJsDoc(declaration: DocDeclaration): boolean {
  const jsDoc = declaration.jsDoc;

  if (jsDoc === undefined) {
    return false;
  }

  return (jsDoc.doc?.trim().length ?? 0) > 0 ||
    (jsDoc.tags?.length ?? 0) > 0;
}

function formatModuleLabel(module: ExportModule): string {
  return `${module.packageName} ${module.exportName} (${
    relative(rootDir, module.path)
  })`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function denoDocJson(path: string): Promise<DocJson> {
  const command = new Deno.Command("deno", {
    args: ["doc", "--json", "--frozen", path],
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();

  if (output.code !== 0) {
    const stderr = textDecoder.decode(output.stderr).trim();
    throw new Error(`deno doc failed for ${path}\n${stderr}`);
  }

  return JSON.parse(textDecoder.decode(output.stdout)) as DocJson;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileUrlToPath(url: string): string {
  return new URL(url).pathname;
}
