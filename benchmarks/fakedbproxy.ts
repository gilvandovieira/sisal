/**
 * Benchmark-only fake database proxy.
 *
 * The proxy implements the small async shapes Sisal adapters already accept:
 * ORM drivers, migration drivers, and raw SQL executors. It lets benchmark
 * scenarios vary result size, async latency, transaction support, and failures
 * without connecting to a real database.
 *
 * @module
 */

import type { MigrationDriver, MigrationTransaction } from "@sisal/migrate";
import type {
  OrmDriver,
  OrmQueryResult,
  OrmTransaction,
  SqlQuery,
} from "@sisal/orm";

export type FakeDbOperation = "query" | "execute" | "transaction" | "close";

export interface FakeDbRequest {
  readonly operation: "query" | "execute";
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly callNumber: number;
  readonly transactionDepth: number;
}

export interface FakeDbCall {
  readonly operation: FakeDbOperation;
  readonly callNumber: number;
  readonly transactionDepth: number;
  readonly params: readonly unknown[];
  readonly sql?: string;
  readonly rowCount?: number;
  readonly durationMs?: number;
  readonly failed?: boolean;
}

export interface FakeDbProxyStats {
  readonly calls: number;
  readonly queries: number;
  readonly executes: number;
  readonly transactions: number;
  readonly closes: number;
  readonly rowsReturned: number;
  readonly paramsObserved: number;
  readonly failures: number;
}

export type FakeDbRow = Record<string, unknown>;

export type FakeDbRowsFactory = (
  request: FakeDbRequest,
) => number | readonly FakeDbRow[];

export type FakeDbRows =
  | number
  | readonly FakeDbRow[]
  | FakeDbRowsFactory;

export interface FakeDbLatencyOptions {
  readonly queryMs?: number;
  readonly executeMs?: number;
  readonly transactionMs?: number;
  readonly closeMs?: number;
  readonly microtasks?: number;
}

export type FakeDbLatency = number | FakeDbLatencyOptions;

export interface FakeDbFailureRule {
  readonly operation?: FakeDbOperation | readonly FakeDbOperation[];
  readonly onCall?: number;
  readonly every?: number;
  readonly sqlIncludes?: string;
  readonly message?: string;
  readonly error?: unknown;
  readonly makeError?: (call: FakeDbCall) => unknown;
}

export interface FakeDbProxyOptions {
  readonly rows?: FakeDbRows;
  readonly rowCount?: number | ((request: FakeDbRequest) => number);
  readonly latency?: FakeDbLatency;
  readonly supportsTransactions?: boolean;
  readonly cloneRows?: boolean;
  readonly failures?: FakeDbFailureRule | readonly FakeDbFailureRule[];
}

export interface FakeDbQueryResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number;
}

export interface FakeSqlExecutor {
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<FakeDbQueryResult<Row>>;

  transaction?<T>(fn: (tx: FakeSqlExecutor) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export interface FakeDbProxy {
  readonly calls: readonly FakeDbCall[];
  readonly stats: FakeDbProxyStats;

  reset(): void;
  asOrmDriver(): OrmDriver;
  asMigrationDriver(): MigrationDriver;
  asSqlExecutor(): FakeSqlExecutor;
}

interface MutableFakeDbCall {
  operation: FakeDbOperation;
  callNumber: number;
  transactionDepth: number;
  params: readonly unknown[];
  sql?: string;
  rowCount?: number;
  durationMs?: number;
  failed?: boolean;
}

interface MutableFakeDbProxyStats {
  calls: number;
  queries: number;
  executes: number;
  transactions: number;
  closes: number;
  rowsReturned: number;
  paramsObserved: number;
  failures: number;
}

/** Creates a reusable fake database proxy for benchmark scenarios. */
export function createFakeDbProxy(
  options: FakeDbProxyOptions = {},
): FakeDbProxy {
  return new SisalFakeDbProxy(options);
}

class SisalFakeDbProxy implements FakeDbProxy {
  readonly #options: FakeDbProxyOptions;
  #calls: MutableFakeDbCall[] = [];
  #nextCallNumber = 0;
  #transactionDepth = 0;
  #stats: MutableFakeDbProxyStats = emptyStats();

  constructor(options: FakeDbProxyOptions) {
    this.#options = options;
  }

  get calls(): readonly FakeDbCall[] {
    return this.#calls.map(cloneCall);
  }

  get stats(): FakeDbProxyStats {
    return { ...this.#stats };
  }

  reset(): void {
    this.#calls = [];
    this.#nextCallNumber = 0;
    this.#transactionDepth = 0;
    this.#stats = emptyStats();
  }

  asOrmDriver(): OrmDriver {
    const driver: OrmDriver = {
      query: <T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> => {
        return this.#runRows<T>("query", query.text, query.params);
      },

      execute: (query: SqlQuery): Promise<OrmQueryResult> => {
        return this.#runRows("execute", query.text, query.params);
      },

      close: (): Promise<void> => this.#close(),
    };

    if (this.#supportsTransactions()) {
      driver.transaction = <T>(
        fn: (tx: OrmTransaction) => Promise<T>,
      ): Promise<T> => {
        return this.#transaction(() => fn(driver));
      };
    }

    return driver;
  }

  asMigrationDriver(): MigrationDriver {
    const driver: MigrationDriver = {
      execute: async (sql: string): Promise<void> => {
        await this.#runRows("execute", sql, []);
      },

      close: (): Promise<void> => this.#close(),
    };

    if (this.#supportsTransactions()) {
      driver.transaction = <T>(
        fn: (tx: MigrationTransaction) => Promise<T>,
      ): Promise<T> => {
        return this.#transaction(() => fn({ driver }));
      };
    }

    return driver;
  }

  asSqlExecutor(): FakeSqlExecutor {
    const executor: FakeSqlExecutor = {
      execute: <Row = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<FakeDbQueryResult<Row>> => {
        return this.#runRows<Row>("execute", sql, params);
      },

      close: (): Promise<void> => this.#close(),
    };

    if (this.#supportsTransactions()) {
      executor.transaction = <T>(
        fn: (tx: FakeSqlExecutor) => Promise<T>,
      ): Promise<T> => {
        return this.#transaction(() => fn(executor));
      };
    }

    return executor;
  }

  async #runRows<Row>(
    operation: "query" | "execute",
    sql: string,
    params: readonly unknown[],
  ): Promise<FakeDbQueryResult<Row>> {
    const call = this.#startCall(operation, sql, params);
    const startedAt = performance.now();

    try {
      await this.#simulateLatency(operation);
      this.#throwIfFailure(call);

      const request: FakeDbRequest = {
        operation,
        sql,
        params: call.params,
        callNumber: call.callNumber,
        transactionDepth: call.transactionDepth,
      };
      const rows = this.#createRows<Row>(request);
      const rowCount = this.#resolveRowCount(request, rows.length);

      call.rowCount = rowCount;
      this.#stats.rowsReturned += rows.length;
      return { rows, rowCount };
    } catch (error) {
      this.#markFailed(call);
      throw error;
    } finally {
      call.durationMs = elapsedMs(startedAt);
    }
  }

  async #transaction<T>(fn: () => Promise<T>): Promise<T> {
    const call = this.#startCall("transaction", undefined, []);
    const startedAt = performance.now();

    try {
      await this.#simulateLatency("transaction");
      this.#throwIfFailure(call);

      this.#transactionDepth += 1;
      try {
        return await fn();
      } finally {
        this.#transactionDepth -= 1;
      }
    } catch (error) {
      this.#markFailed(call);
      throw error;
    } finally {
      call.durationMs = elapsedMs(startedAt);
    }
  }

  async #close(): Promise<void> {
    const call = this.#startCall("close", undefined, []);
    const startedAt = performance.now();

    try {
      await this.#simulateLatency("close");
      this.#throwIfFailure(call);
    } catch (error) {
      this.#markFailed(call);
      throw error;
    } finally {
      call.durationMs = elapsedMs(startedAt);
    }
  }

  #startCall(
    operation: FakeDbOperation,
    sql: string | undefined,
    params: readonly unknown[],
  ): MutableFakeDbCall {
    const call: MutableFakeDbCall = {
      operation,
      callNumber: ++this.#nextCallNumber,
      transactionDepth: this.#transactionDepth,
      params: [...params],
      ...(sql === undefined ? {} : { sql }),
    };

    this.#calls.push(call);
    this.#stats.calls += 1;
    this.#stats.paramsObserved += params.length;

    switch (operation) {
      case "query":
        this.#stats.queries += 1;
        break;
      case "execute":
        this.#stats.executes += 1;
        break;
      case "transaction":
        this.#stats.transactions += 1;
        break;
      case "close":
        this.#stats.closes += 1;
        break;
    }

    return call;
  }

  #createRows<Row>(request: FakeDbRequest): Row[] {
    const source = typeof this.#options.rows === "function"
      ? this.#options.rows(request)
      : this.#options.rows ?? 0;

    if (typeof source === "number") {
      return Array.from(
        { length: normalizeRowCount(source) },
        (_, index) => generatedRow(request, index) as Row,
      );
    }

    const rows = this.#options.cloneRows
      ? source.map((row) => ({ ...row }))
      : [...source];

    return rows as Row[];
  }

  #resolveRowCount(request: FakeDbRequest, fallback: number): number {
    if (typeof this.#options.rowCount === "number") {
      return normalizeRowCount(this.#options.rowCount);
    }

    if (typeof this.#options.rowCount === "function") {
      return normalizeRowCount(this.#options.rowCount(request));
    }

    return fallback;
  }

  async #simulateLatency(operation: FakeDbOperation): Promise<void> {
    const latency = this.#options.latency;
    if (latency === undefined) {
      return;
    }

    const microtasks = typeof latency === "number"
      ? 0
      : normalizeRowCount(latency.microtasks ?? 0);

    for (let index = 0; index < microtasks; index += 1) {
      await Promise.resolve();
    }

    const ms = operationLatencyMs(latency, operation);
    if (ms <= 0) {
      return;
    }

    await delay(ms);
  }

  #throwIfFailure(call: MutableFakeDbCall): void {
    const rule = findFailureRule(this.#options.failures, call);
    if (rule === undefined) {
      return;
    }

    throw makeFailure(rule, cloneCall(call));
  }

  #markFailed(call: MutableFakeDbCall): void {
    if (call.failed === true) {
      return;
    }

    call.failed = true;
    this.#stats.failures += 1;
  }

  #supportsTransactions(): boolean {
    return this.#options.supportsTransactions ?? true;
  }
}

function emptyStats(): MutableFakeDbProxyStats {
  return {
    calls: 0,
    queries: 0,
    executes: 0,
    transactions: 0,
    closes: 0,
    rowsReturned: 0,
    paramsObserved: 0,
    failures: 0,
  };
}

function cloneCall(call: MutableFakeDbCall): FakeDbCall {
  return {
    operation: call.operation,
    callNumber: call.callNumber,
    transactionDepth: call.transactionDepth,
    params: [...call.params],
    ...(call.sql === undefined ? {} : { sql: call.sql }),
    ...(call.rowCount === undefined ? {} : { rowCount: call.rowCount }),
    ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
    ...(call.failed === undefined ? {} : { failed: call.failed }),
  };
}

function generatedRow(request: FakeDbRequest, index: number): FakeDbRow {
  return {
    id: `${request.callNumber}:${index}`,
    value: index,
    sqlLength: request.sql.length,
    paramCount: request.params.length,
  };
}

function normalizeRowCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.trunc(value);
}

function operationLatencyMs(
  latency: FakeDbLatency,
  operation: FakeDbOperation,
): number {
  if (typeof latency === "number") {
    return Math.max(0, latency);
  }

  switch (operation) {
    case "query":
      return Math.max(0, latency.queryMs ?? 0);
    case "execute":
      return Math.max(0, latency.executeMs ?? 0);
    case "transaction":
      return Math.max(0, latency.transactionMs ?? 0);
    case "close":
      return Math.max(0, latency.closeMs ?? 0);
  }
}

function findFailureRule(
  rules: FakeDbProxyOptions["failures"],
  call: MutableFakeDbCall,
): FakeDbFailureRule | undefined {
  const list = Array.isArray(rules)
    ? rules
    : rules === undefined
    ? []
    : [rules];
  return list.find((rule) => matchesFailureRule(rule, call));
}

function matchesFailureRule(
  rule: FakeDbFailureRule,
  call: MutableFakeDbCall,
): boolean {
  if (!operationMatches(rule.operation, call.operation)) {
    return false;
  }

  if (
    rule.sqlIncludes !== undefined &&
    (call.sql === undefined || !call.sql.includes(rule.sqlIncludes))
  ) {
    return false;
  }

  if (rule.onCall !== undefined && rule.onCall !== call.callNumber) {
    return false;
  }

  if (
    rule.every !== undefined &&
    (rule.every <= 0 || call.callNumber % Math.trunc(rule.every) !== 0)
  ) {
    return false;
  }

  return rule.onCall !== undefined ||
    rule.every !== undefined ||
    rule.sqlIncludes !== undefined ||
    rule.operation !== undefined;
}

function operationMatches(
  expected: FakeDbFailureRule["operation"],
  actual: FakeDbOperation,
): boolean {
  if (expected === undefined) {
    return true;
  }

  return Array.isArray(expected)
    ? expected.includes(actual)
    : expected === actual;
}

function makeFailure(rule: FakeDbFailureRule, call: FakeDbCall): unknown {
  if (rule.makeError !== undefined) {
    return rule.makeError(call);
  }

  if (rule.error !== undefined) {
    return rule.error;
  }

  return new Error(
    rule.message ??
      `Fake DB ${call.operation} failed at call ${call.callNumber}`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedMs(startedAt: number): number {
  return performance.now() - startedAt;
}
