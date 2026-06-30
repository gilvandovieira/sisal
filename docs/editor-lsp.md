---
title: Editor LSP Setup
---

# Editor LSP Setup

Sisal is a Deno workspace, so editors should attach TypeScript files to
`deno lsp`, not to a plain Node/TypeScript language server. A generic LSP client
is fine as long as the server process is Deno's language server.

The important distinction:

- **Generic LSP client:** works when it launches `deno lsp`.
- **Generic TypeScript server:** does not understand Deno workspace package
  names, JSR specifiers, or the package `deno.json` export maps by itself.

Open the repository root, not an individual package directory. The root
`deno.json` declares the workspace, while each package `deno.json` declares its
JSR package name and exports.

## Verified Probe

The local probe used Deno 2.9.0 from the repository root.

Positive check with `deno lsp --quiet`:

- `textDocument/definition` on `examples/basic-postgres/mod.ts:22` for
  `generatePostgresUpStatements` resolved to `packages/pg/migrate/ddl.ts`.
- `textDocument/hover` on the `migration` variable returned
  `const migration: PostgresUpStatements`.

Control check with `typescript-language-server` 5.1.3:

- `@sisal/orm` and `@sisal/pg/ddl` produced TS2307 unresolved-module
  diagnostics.
- Hover on the same `migration` variable returned `any`.
- Definition could only jump to the import statement in the same file.

That result is expected. Deno resolves the workspace through `deno.json`;
TypeScript's Node-oriented server needs npm-shaped metadata that Sisal does not
publish today.

## VS Code

Install the official Deno extension (`denoland.vscode-deno`) and keep this
workspace setting:

```json
{
  "deno.enable": true,
  "deno.config": "./deno.json",
  "deno.lint": true
}
```

This repository checks those settings in at `.vscode/settings.json` so VS Code
uses the workspace root config automatically.

## Generic LSP Clients

Use `deno lsp` as the language server command:

```json
{
  "command": "deno",
  "args": ["lsp"],
  "initializationOptions": {
    "enable": true,
    "lint": true,
    "config": "/absolute/path/to/sisal/deno.json"
  }
}
```

Some clients treat `config` as relative to the editor process instead of the
workspace root. Use an absolute path if local imports resolve in the terminal
but not in the editor.

Attach the server to TypeScript and JavaScript files:

- `typescript`
- `typescriptreact`
- `javascript`
- `javascriptreact`

Avoid running `tsserver`, `typescript-language-server`, or `vtsls` on the same
Sisal files unless the client can disable their diagnostics for this workspace.
Running both usually produces duplicate or misleading diagnostics, and the plain
TypeScript server currently reports Sisal workspace imports as missing.

## Neovim Example

With `nvim-lspconfig`, configure `denols` from the repository root:

```lua
require("lspconfig").denols.setup({
  root_dir = require("lspconfig.util").root_pattern("deno.json"),
  init_options = {
    enable = true,
    lint = true,
    config = vim.fn.getcwd() .. "/deno.json",
  },
})
```

If the same editor also starts `tsserver`, disable it for this workspace or make
the Deno root detector win whenever `deno.json` is present.

## Future npm Support Signal

The LSP probe draws a useful line for a possible npm deployment strategy:

- Deno and JSR users can rely on the existing `deno.json` workspace, package
  names, and exports.
- npm and ordinary TypeScript-server users will need generated npm artifacts:
  `package.json` export maps, declaration files, `types` entries, and import
  specifiers that Node/TypeScript can resolve.
- Workspace development for npm should likely generate a staging tree or
  `tsconfig` path aliases so `@sisal/*` resolves before packages are published.
- The dependency boundary still matters: `@sisal/orm` should remain driverless,
  with runtime-specific npm dependencies kept in adapter packages or benchmark
  code.

This does not require changing the source layout today. It records what future
npm support must reproduce for editors that only speak the ordinary TypeScript
package model.
