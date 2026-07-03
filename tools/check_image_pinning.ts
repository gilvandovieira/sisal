/**
 * Fails when a container image reference is not pinned to an immutable
 * `@sha256:` digest ([SEC-014](../docs/security.md#sec-014)).
 *
 * The workspace already SHA-pins GitHub Actions and digest-pins the `docker/`
 * images; this guard extends the same discipline to workflow **service
 * containers** (which Dependabot's `docker` ecosystem does not scan) and any
 * Compose file, so a mutable `mysql:8.4`-style tag cannot drift back in.
 *
 * Scans `.github/workflows/*.{yml,yaml}` and `docker/` plus any `compose*` file
 * for `image:` and `FROM` references. A reference is exempt when it is a build
 * variable (`${...}`), `scratch`, or a bare multi-stage build name (no registry
 * `:`/`/`/`.`).
 *
 * Run: `deno run --allow-read tools/check_image_pinning.ts`
 *
 * @module
 */

const IMAGE_LINE = /^\s*image:\s*["']?([^"'\s]+)/;
const FROM_LINE = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i;

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly ref: string;
}

function isExempt(ref: string): boolean {
  if (ref.includes("${") || ref === "scratch") return true;
  // A bare multi-stage build name (e.g. `FROM builder`) references a prior
  // stage, not a registry image — no registry separator to pin.
  return !ref.includes(":") && !ref.includes("/") && !ref.includes(".");
}

function scan(path: string, content: string): Offender[] {
  const offenders: Offender[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue; // skip comments
    const match = IMAGE_LINE.exec(line) ?? FROM_LINE.exec(line);
    if (match === null) continue;
    const ref = match[1];
    if (isExempt(ref) || ref.includes("@sha256:")) continue;
    offenders.push({ file: path, line: i + 1, ref });
  }
  return offenders;
}

async function collectFiles(): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(dir);
    } catch {
      return; // directory absent — nothing to scan
    }
    for await (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(path);
      } else if (matches(entry.name)) {
        files.push(path);
      }
    }
  };
  await walk(".github/workflows");
  await walk("docker");
  await walk("examples");
  return files;
}

function matches(name: string): boolean {
  return /\.(ya?ml)$/.test(name) || name === "Dockerfile" ||
    /^Dockerfile\./.test(name) || /compose/i.test(name);
}

const offenders: Offender[] = [];
for (const file of await collectFiles()) {
  offenders.push(...scan(file, await Deno.readTextFile(file)));
}

if (offenders.length > 0) {
  console.error("Unpinned container images (need an @sha256: digest):\n");
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ${o.ref}`);
  }
  console.error(
    "\nPin each to an immutable digest, e.g. `mysql:8.4@sha256:…` " +
      "(resolve with `docker buildx imagetools inspect <ref>`).",
  );
  Deno.exit(1);
}

console.log("All container image references are digest-pinned.");
