/**
 * Build the TUI widget to plain JS.
 *
 * Why: the OpenCode host's Solid/JSX transform explicitly skips files under
 * `node_modules` (see issue #3). A pure npm install therefore never gets our
 * .tsx compiled with the OpenTUI Solid runtime and falls back to React JSX.
 * Shipping a pre-compiled module (bare specifiers preserved) lets the host's
 * runtime-module layer (`nodeModulesRuntimeSpecifiers`) resolve them.
 *
 * Usage: bun scripts/build-tui.ts
 */
import { join } from "node:path"
import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "src", "tui.tsx")],
  target: "bun",
  format: "esm",
  external: [
    "@opentui/solid",
    "@opentui/solid/components",
    "@opentui/solid/jsx-runtime",
    "@opentui/solid/jsx-dev-runtime",
    "@opentui/core",
    "solid-js",
    "solid-js/store",
    "@opencode/plugin/tui",
  ],
  plugins: [solidPlugin],
  outdir: join(import.meta.dir, "..", "dist"),
  naming: "tui.js",
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log("built dist/tui.js")
