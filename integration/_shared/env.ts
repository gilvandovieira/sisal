/** Shared helpers for gated integration suites. */

/** Reads an env var without throwing outside Deno-capable runtimes. */
export function env(key: string): string | undefined {
  try {
    return (globalThis as {
      Deno?: { env: { get(k: string): string | undefined } };
    }).Deno?.env.get(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** True when an env var exactly matches the expected value. */
export function envEquals(key: string, value: string): boolean {
  return env(key) === value;
}
