import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SITE_BASE_URL = "https://gilvandovieira.github.io/sisal";
const REPOSITORY_URL = "https://github.com/gilvandovieira/sisal";
const TEXT_DECODER = new TextDecoder();

const rootDir = Deno.cwd();
const docsDir = join(rootDir, "docs");
const checkOnly = Deno.args.includes("--check");

const preferredDocOrder = new Map<string, number>([
  ["docs/api.md", 0],
  ["docs/migration-notes.md", 1],
  ["docs/drizzle-parity.md", 2],
  ["docs/pg-compatibility.md", 3],
  ["docs/neon-compatibility.md", 4],
  ["docs/sqlite-compatibility.md", 5],
  ["docs/libsql-compatibility.md", 6],
  ["docs/benchmarks.md", 7],
  ["docs/security.md", 8],
]);

interface DenoConfig {
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly workspace?: readonly string[];
  readonly exports?: unknown;
}

interface PackageInfo {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly path: string;
  readonly exports: readonly PackageExport[];
}

interface PackageExport {
  readonly name: string;
  readonly target: string;
}

interface SourceDoc {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
}

interface ExportModule {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly exportName: string;
  readonly target: string;
  readonly path: string;
}

interface DocJson {
  readonly nodes?: Record<string, DocNode>;
}

interface DocNode {
  readonly module_doc?: {
    readonly doc?: string;
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
  };
}

const rootConfig = await readJson<DenoConfig>(join(rootDir, "deno.json"));
const sourceDocs = await readSourceDocs();
const packages = await readPackages(rootConfig);
const exportModules = packages.flatMap((pkg) =>
  pkg.exports
    .filter((entry) => entry.target.endsWith(".ts"))
    .map((entry) => ({
      packageName: pkg.name,
      packageVersion: pkg.version,
      exportName: entry.name,
      target: entry.target,
      path: resolve(rootDir, pkg.path, entry.target),
    }))
);

const llms = buildLlmsTxt(sourceDocs, packages);
const full = await buildLlmsFullTxt(sourceDocs, packages, exportModules);

await writeOrCheck(join(docsDir, "llms.txt"), llms);
await writeOrCheck(join(docsDir, "llms-full.txt"), full);

async function readSourceDocs(): Promise<SourceDoc[]> {
  const paths = ["README.md", "CHANGELOG.md", ...await docsMarkdownPaths()];
  const docs: SourceDoc[] = [];

  for (const path of paths) {
    const content = await Deno.readTextFile(join(rootDir, path));
    const { body, frontMatter } = splitFrontMatter(content);
    const title = frontMatterTitle(frontMatter) ?? markdownTitle(body) ??
      titleFromPath(path);

    docs.push({
      path,
      title,
      description: firstParagraph(body) || title,
      url: urlForDoc(path),
    });
  }

  return docs;
}

async function docsMarkdownPaths(): Promise<string[]> {
  const paths: string[] = [];

  for await (const entry of Deno.readDir(docsDir)) {
    if (entry.isFile && entry.name.endsWith(".md")) {
      paths.push(`docs/${entry.name}`);
    }
  }

  return paths.sort((left, right) => {
    const leftRank = preferredDocOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = preferredDocOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });
}

async function readPackages(config: DenoConfig): Promise<PackageInfo[]> {
  const packages: PackageInfo[] = [];

  for (const workspaceMember of config.workspace ?? []) {
    if (!workspaceMember.replace(/^\.\//, "").startsWith("packages/")) {
      continue;
    }

    const packageDir = resolve(rootDir, workspaceMember);
    const packageConfigPath = join(packageDir, "deno.json");

    let packageConfig: DenoConfig;
    try {
      packageConfig = await readJson<DenoConfig>(packageConfigPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      throw error;
    }

    if (
      packageConfig.name === undefined ||
      !packageConfig.name.startsWith("@sisal/")
    ) {
      continue;
    }

    packages.push({
      name: packageConfig.name,
      version: packageConfig.version ?? "0.0.0",
      description: packageConfig.description ?? "",
      path: workspaceMember,
      exports: normalizeExports(packageConfig.exports),
    });
  }

  return packages;
}

function buildLlmsTxt(
  docs: readonly SourceDoc[],
  packages: readonly PackageInfo[],
): string {
  const version = workspaceVersion(packages);
  const primaryDocs = docs.filter((doc) => doc.path.startsWith("docs/"));
  const projectDocs = docs.filter((doc) => !doc.path.startsWith("docs/"));
  const lines: string[] = [
    "# Sisal",
    "",
    "> Sisal is a Deno-first, JSR-native database toolkit for typed schemas, safe SQL, query builders, migration planning, and small adapter packages.",
    "",
    `Workspace package version: ${version}. The core ORM is driverless; adapters for PostgreSQL, Neon, SQLite, libSQL/Turso, and MySQL/MariaDB live at explicit package boundaries.`,
    "",
    "Use `llms-full.txt` when you need a focused single-file package/API reference with links into the canonical documentation.",
    "",
    "## Primary Documentation",
    "",
    `- [Focused LLM Context](${SITE_BASE_URL}/llms-full.txt): Generated focused context from package manifests, exported API docs, and a canonical documentation map.`,
  ];

  for (const doc of primaryDocs) {
    lines.push(`- [${doc.title}](${doc.url}): ${doc.description}`);
  }

  lines.push("", "## Package APIs", "");
  for (const pkg of packages) {
    const exports = pkg.exports.map((entry) => entry.name).join(", ");
    lines.push(
      `- [${pkg.name}](https://jsr.io/${pkg.name}): ${
        sentence(pkg.description)
      } Exports: ${exports}.`,
    );
  }

  lines.push("", "## Project Context", "");
  for (const doc of projectDocs) {
    lines.push(`- [${doc.title}](${doc.url}): ${doc.description}`);
  }
  lines.push(
    `- [Repository](${REPOSITORY_URL}): Source code, issues, examples, workflows, and package directories.`,
  );

  return `${lines.join("\n")}\n`;
}

async function buildLlmsFullTxt(
  docs: readonly SourceDoc[],
  packages: readonly PackageInfo[],
  modules: readonly ExportModule[],
): Promise<string> {
  const lines: string[] = [
    "# Sisal Focused LLM Context",
    "",
    "> Generated by `deno task docs:llms` from package manifests, `deno doc --json` output for public exports, and a compact map of canonical documentation.",
    "",
    "## Compact Index",
    "",
    stripTrailingNewline(buildLlmsTxt(docs, packages)),
    "",
    "## Package Manifests",
    "",
  ];

  for (const pkg of packages) {
    lines.push(`### ${pkg.name} ${pkg.version}`, "");
    lines.push(`${sentence(pkg.description)}`, "");
    lines.push(`Package path: \`${pkg.path}\``, "");
    lines.push("Exports:");
    for (const entry of pkg.exports) {
      lines.push(`- \`${entry.name}\` -> \`${entry.target}\``);
    }
    lines.push("");
  }

  lines.push("## Public API Symbol Index", "");

  for (const module of modules) {
    const docJson = await denoDocJson(module.path);
    const node = docJson.nodes?.[pathToFileURL(module.path).href];

    if (node === undefined) {
      throw new Error(`Missing deno doc node for ${module.path}`);
    }

    lines.push(
      `### ${module.packageName} ${module.exportName} (${
        relative(rootDir, module.path)
      })`,
      "",
    );

    const moduleDoc = firstParagraph(node.module_doc?.doc ?? "");
    if (moduleDoc.length > 0) {
      lines.push(`${moduleDoc}`, "");
    }

    for (const symbol of [...(node.symbols ?? [])].sort(compareSymbols)) {
      const declaration = symbol.declarations?.[0];
      const kind = declaration?.kind ?? "symbol";
      const summary = firstParagraph(declaration?.jsDoc?.doc ?? "");
      lines.push(`- \`${symbol.name}\` (${kind}): ${summary || "Public API."}`);
    }
    lines.push("");
  }

  lines.push(
    "## Documentation Map",
    "",
    "Canonical documentation is linked instead of embedded verbatim so this file stays focused on package boundaries and public API discovery.",
    "",
  );

  for (const doc of docs) {
    lines.push(
      `- [${doc.title}](${doc.url}) (\`${doc.path}\`): ${doc.description}`,
    );
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

async function writeOrCheck(path: string, content: string): Promise<void> {
  if (!checkOnly) {
    await Deno.writeTextFile(path, content);
    console.log(`Wrote ${relative(rootDir, path)}`);
    return;
  }

  let existing = "";
  try {
    existing = await Deno.readTextFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  if (existing !== content) {
    console.error(`${relative(rootDir, path)} is out of date.`);
    console.error("Run `deno task docs:llms` and commit the result.");
    Deno.exit(1);
  }

  console.log(`${relative(rootDir, path)} is up to date.`);
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
    const stderr = TEXT_DECODER.decode(output.stderr).trim();
    throw new Error(`deno doc failed for ${path}\n${stderr}`);
  }

  return JSON.parse(TEXT_DECODER.decode(output.stdout)) as DocJson;
}

function normalizeExports(exportsField: unknown): PackageExport[] {
  if (typeof exportsField === "string") {
    return [{ name: ".", target: exportsField }];
  }

  if (!isRecord(exportsField)) {
    return [];
  }

  const exports: PackageExport[] = [];

  for (const [name, value] of Object.entries(exportsField)) {
    const target = resolveExportTarget(value);
    if (target !== undefined) {
      exports.push({ name, target });
    }
  }

  return exports.sort((left, right) => left.name.localeCompare(right.name));
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

function splitFrontMatter(
  content: string,
): { readonly body: string; readonly frontMatter?: string } {
  if (!content.startsWith("---\n")) {
    return { body: content };
  }

  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    return { body: content };
  }

  return {
    frontMatter: content.slice(4, end),
    body: content.slice(end + 5),
  };
}

function frontMatterTitle(frontMatter: string | undefined): string | undefined {
  const match = /^title:\s*(.+)$/m.exec(frontMatter ?? "");
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

function markdownTitle(content: string): string | undefined {
  for (const line of content.split("\n")) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (match !== null) {
      return cleanMarkdown(match[1]);
    }
  }
  return undefined;
}

function firstParagraph(content: string): string {
  const lines = content.split("\n");
  const paragraph: string[] = [];
  let inCodeFence = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) {
      continue;
    }

    if (paragraph.length > 0 && line.length === 0) {
      break;
    }

    if (paragraph.length === 0 && shouldSkipSummaryLine(line)) {
      continue;
    }

    if (line.length > 0) {
      paragraph.push(line);
    }
  }

  return truncate(cleanMarkdown(paragraph.join(" ")), 220);
}

function shouldSkipSummaryLine(line: string): boolean {
  return line.length === 0 ||
    line.startsWith("#") ||
    line.startsWith("|") ||
    line.startsWith("<") ||
    line.startsWith(">") ||
    line.startsWith("- ") ||
    line.startsWith("* ") ||
    line.startsWith("Pronunciation:") ||
    line.startsWith("```");
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sentence(value: string): string {
  const cleaned = cleanMarkdown(value);
  if (cleaned.endsWith(".")) {
    return cleaned;
  }
  return `${cleaned}.`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const prefix = value.slice(0, maxLength - 3);
  const boundary = prefix.lastIndexOf(" ");
  const truncated = boundary <= maxLength * 0.6
    ? prefix
    : prefix.slice(0, boundary);
  return `${truncated.trimEnd()}...`;
}

function titleFromPath(path: string): string {
  return basename(path, ".md")
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function urlForDoc(path: string): string {
  if (path === "README.md" || path === "CHANGELOG.md") {
    return `${REPOSITORY_URL}/blob/main/${path}`;
  }

  const page = basename(path, ".md");
  return `${SITE_BASE_URL}/${page}.html`;
}

function workspaceVersion(packages: readonly PackageInfo[]): string {
  const versions = new Set(packages.map((pkg) => pkg.version));
  if (versions.size === 1) {
    return packages[0]?.version ?? "unknown";
  }
  return [...versions].sort().join(", ");
}

function compareSymbols(left: DocSymbol, right: DocSymbol): number {
  return left.name.localeCompare(right.name);
}

function stripTrailingNewline(value: string): string {
  return value.replace(/\n$/u, "");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
