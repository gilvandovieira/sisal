import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODULE_DOC_MINIMUM = 1;
const JSDOC_MINIMUM = 1;
const MISSING_PER_PACKAGE_LIMIT = Deno.args.includes("--all")
  ? Number.POSITIVE_INFINITY
  : 50;

interface DenoConfig {
  readonly name?: string;
  readonly publish?: false | Record<string, unknown>;
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
  readonly def?: DocDef;
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

interface DocDef {
  readonly constructors?: readonly DocMember[];
  readonly methods?: readonly DocMember[];
  readonly properties?: readonly DocMember[];
  readonly accessors?: readonly DocMember[];
  readonly members?: readonly DocMember[];
  readonly tsType?: DocType;
}

interface DocType {
  readonly kind?: string;
  readonly value?: unknown;
}

interface DocMember {
  readonly name?: string;
  readonly accessibility?: string;
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
  readonly packageName: string;
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
    addJsDocEntry(
      jsDocEntries,
      exportModule.packageName,
      getSymbolKey(exportModule, symbol),
      getSymbolLabel(exportModule, symbol),
      declarations.some(hasJsDoc),
    );

    for (const declaration of declarations) {
      for (
        const memberEntry of getDeclarationMemberEntries(
          exportModule,
          symbol,
          declaration,
        )
      ) {
        addJsDocEntry(
          jsDocEntries,
          memberEntry.packageName,
          memberEntry.key,
          memberEntry.label,
          memberEntry.documented,
        );
      }
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
const missingJsDocsByPackage = groupEntriesByPackage(missingJsDocs);

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
  for (
    const [packageName, entries] of [...missingJsDocsByPackage.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
  ) {
    console.error(`\n${packageName}:`);

    for (const entry of entries.slice(0, MISSING_PER_PACKAGE_LIMIT)) {
      console.error(`  - ${entry.label}`);
    }

    if (entries.length > MISSING_PER_PACKAGE_LIMIT) {
      console.error(
        `  - ...and ${entries.length - MISSING_PER_PACKAGE_LIMIT} more`,
      );
    }
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

    if (
      packageConfig.publish === false || packageConfig.exports === undefined
    ) {
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

function getDeclarationMemberEntries(
  module: ExportModule,
  symbol: DocSymbol,
  declaration: DocDeclaration,
): JsDocEntryWithKey[] {
  const entries: JsDocEntryWithKey[] = [];

  for (
    const kind of [
      "constructors",
      "properties",
      "methods",
      "accessors",
    ] as const
  ) {
    for (const member of declaration.def?.[kind] ?? []) {
      if (!isDocumentableMember(member)) {
        continue;
      }

      const memberName = member.name ?? kind.slice(0, -1);
      entries.push(getMemberEntry(module, symbol, memberName, member));
    }
  }

  for (const member of declaration.def?.members ?? []) {
    if (!isDocumentableMember(member)) {
      continue;
    }

    entries.push(
      getMemberEntry(module, symbol, member.name ?? "member", member),
    );
  }

  if (declaration.kind === "typeAlias") {
    for (const member of getTypeLiteralMembers(declaration.def?.tsType)) {
      if (!isDocumentableMember(member)) {
        continue;
      }

      entries.push(
        getMemberEntry(module, symbol, member.name ?? "member", member),
      );
    }
  }

  return entries;
}

interface JsDocEntryWithKey extends JsDocEntry {
  readonly key: string;
}

function getMemberEntry(
  module: ExportModule,
  symbol: DocSymbol,
  memberName: string,
  member: DocMember,
): JsDocEntryWithKey {
  const memberLocationKey = member.location === undefined
    ? ""
    : `${member.location.filename}:${member.location.line}:${member.location.col}`;
  const key = `${symbol.name}.${memberName}:${
    memberLocationKey || formatModuleLabel(module)
  }`;

  return {
    key,
    packageName: module.packageName,
    label: `${symbol.name}.${memberName} (${
      formatMemberLocation(module, member)
    })`,
    documented: hasMemberJsDoc(member),
  };
}

function getTypeLiteralMembers(
  type: DocType | undefined,
): readonly DocMember[] {
  if (!isRecord(type) || type.kind !== "typeLiteral" || !isRecord(type.value)) {
    return [];
  }

  const members: DocMember[] = [];

  for (const key of ["properties", "methods"] as const) {
    const value = type.value[key];

    if (Array.isArray(value)) {
      members.push(...value.filter(isRecord) as DocMember[]);
    }
  }

  return members;
}

function isDocumentableMember(member: DocMember): boolean {
  return member.accessibility !== "private" &&
    member.accessibility !== "protected" &&
    member.location?.filename !== undefined;
}

function addJsDocEntry(
  entries: Map<string, JsDocEntry>,
  packageName: string,
  key: string,
  label: string,
  documented: boolean,
): void {
  const existing = entries.get(key);

  if (existing === undefined) {
    entries.set(key, { packageName, label, documented });
  } else {
    existing.documented = existing.documented || documented;
  }
}

function groupEntriesByPackage(
  entries: readonly JsDocEntry[],
): Map<string, JsDocEntry[]> {
  const grouped = new Map<string, JsDocEntry[]>();

  for (const entry of entries) {
    const packageEntries = grouped.get(entry.packageName);

    if (packageEntries === undefined) {
      grouped.set(entry.packageName, [entry]);
    } else {
      packageEntries.push(entry);
    }
  }

  return grouped;
}

function hasJsDoc(declaration: DocDeclaration): boolean {
  const jsDoc = declaration.jsDoc;

  if (jsDoc === undefined) {
    return false;
  }

  return (jsDoc.doc?.trim().length ?? 0) > 0 ||
    (jsDoc.tags?.length ?? 0) > 0;
}

function hasMemberJsDoc(member: DocMember): boolean {
  const jsDoc = member.jsDoc;

  if (jsDoc === undefined) {
    return false;
  }

  return (jsDoc.doc?.trim().length ?? 0) > 0 ||
    (jsDoc.tags?.length ?? 0) > 0;
}

function formatMemberLocation(module: ExportModule, member: DocMember): string {
  const location = member.location;

  if (location?.filename === undefined) {
    return formatModuleLabel(module);
  }

  return `${relative(rootDir, fileUrlToPath(location.filename))}:${
    location.line ?? 1
  }`;
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
