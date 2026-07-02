import { MigrationError, type MigrationErrorCode } from "@sisal/migrate";

export function toMysqlMigrationError(
  error: unknown,
  message: string,
  options: {
    readonly code?: MigrationErrorCode;
    readonly sql?: string;
    readonly status?: number;
  } = {},
): MigrationError {
  if (error instanceof MigrationError) {
    return error;
  }

  return new MigrationError(message, {
    code: options.code ?? "MIGRATION_EXECUTE_FAILED",
    status: options.status ?? 500,
    details: options.sql === undefined ? undefined : { sql: options.sql },
    cause: error,
  });
}
