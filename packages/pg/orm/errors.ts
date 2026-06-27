import { OrmError, type OrmErrorCode } from "@sisal/orm";

export function toPgOrmError(
  error: unknown,
  message: string,
  options: {
    readonly code?: OrmErrorCode;
    readonly sql?: string;
    readonly status?: number;
  } = {},
): OrmError {
  if (error instanceof OrmError) {
    return error;
  }

  return new OrmError(message, {
    code: options.code ?? "ORM_EXECUTE_FAILED",
    status: options.status ?? 500,
    details: options.sql === undefined ? undefined : { sql: options.sql },
    cause: error,
  });
}
