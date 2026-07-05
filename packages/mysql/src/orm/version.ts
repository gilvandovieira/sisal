import { MARIADB_VARIANT } from "./dialect.ts";

/** Parsed `(variant, version)` half of a MySQL-family dialect identity. */
export interface MysqlServerIdentity {
  /** `"mariadb"` when the server self-identifies as MariaDB; else absent. */
  readonly variant?: string;
  /** The raw server version string (e.g. `"8.4.10"`, `"11.8.8-MariaDB"`). */
  readonly version: string;
}

/**
 * Parses a MySQL-family `select version()` string into the `variant`/`version`
 * half of a `DialectIdentity`. MariaDB self-identifies in the version string
 * (`"11.8.8-MariaDB-ubu2404"`); anything else is treated as base MySQL. The
 * raw string is kept as the version — `compareServerVersions` in `@sisal/orm`
 * compares by the leading dotted numeric prefix, so suffixes are harmless.
 */
export function parseMysqlServerVersion(raw: string): MysqlServerIdentity {
  const version = raw.trim();
  if (/mariadb/i.test(version)) {
    return { variant: MARIADB_VARIANT, version };
  }
  return { version };
}
