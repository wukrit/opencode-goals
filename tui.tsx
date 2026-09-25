/**
 * Top-level TUI entrypoint for local directory installs.
 *
 * The OpenCode 2.0.16 CLI resolves a local `cli.json` package directory to a
 * top-level `tui.tsx`/`tui.ts` file (the same layout as
 * `<global-config>/plugins/<name>/tui.ts` discovery). It does not resolve the
 * `package.json` `./tui` export to `src/tui.tsx` on its own, so a directory
 * entry without a top-level file is silently ignored (observed on 2.0.16). This
 * shim keeps the implementation in `src/tui.tsx` (still exposed as `./tui`
 * for the documented publish shape) while giving the CLI a file it discovers.
 */

export { default } from "./src/tui"
