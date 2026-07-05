import type { SqlDialect } from "@sisal/orm";

/** SQL dialect name used by the MySQL/MariaDB ORM adapter. */
export const MYSQL_DIALECT: SqlDialect = "mysql";

/**
 * The `variant` value a MariaDB server carries in its
 * {@link https://jsr.io/@sisal/orm | `DialectIdentity`} — the axis that lets
 * version-gated capabilities (e.g. `INSERT … RETURNING` on MariaDB 10.5+)
 * light up through `dialectGuard`'s `unless` refinements.
 */
export const MARIADB_VARIANT = "mariadb";
