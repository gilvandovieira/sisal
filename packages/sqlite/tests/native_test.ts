/**
 * Pins the runtime-native SQLite driver-selection contract (NPM-6) on **both**
 * runtimes. Under Deno, FFI is available, so `hasDenoFfi()` is true and the
 * adapter keeps choosing `@db/sqlite`; under Node (where the dnt-built suite
 * runs this same file), FFI is absent, so it is false and the adapter falls
 * back to the built-in `node:sqlite`. The assertion tracks the host runtime so
 * it documents — and enforces — the fork from either side.
 */
import { assertEquals } from "@std/assert";
import { hasDenoFfi } from "../src/native.ts";

/** True when running under Deno (FFI host); false under Node and friends. */
const isDenoRuntime =
  typeof (globalThis as { Deno?: { dlopen?: unknown } }).Deno?.dlopen ===
    "function";

Deno.test("native: FFI detection matches the host runtime", () => {
  assertEquals(hasDenoFfi(), isDenoRuntime);
});
