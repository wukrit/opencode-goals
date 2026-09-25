# opencode2-goals

![CI](https://github.com/wukrit/opencode2-goals/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue)

An [OpenCode](https://opencode.ai/v2/docs/) **v2** plugin that implements a
Codex-style goal loop: durable, session-scoped goal state; a `/goal` command
surface; the objective injected into every model call; event-driven
continuation on idle; an evidence-gated completion tool; stall suppression;
budget caps safe by default; and an unattended permission sandbox.

Design and trade-offs: [`docs/design.md`](docs/design.md).

## What it does

- `/goal set <objective> [--turns N] [--tokens N] [--unbounded]` starts and
  drives the loop. **Without flags a default cap of 10 turns / 100,000 tokens
  applies.** Pass explicit caps to override, or `--unbounded` (also
  `--no-cap`, `--unlimited`) to opt out of numeric limits entirely.
- `/goal view | pause | resume | clear | complete <evidence> | block <reason> | history`
  manages it. (`history` also answers to `log`.)
- `goal_set(objective, turns?, tokens?, unbounded?)` — model-callable set for
  the same loop. Refuses while a non-terminal goal is active (no clobbering
  the user's goal), honors the same cap defaults, and injects the first
  continuation like `/goal set` does.
- `goal_complete(evidence)` — model-callable. Evidence must be concrete,
  independently checkable, and grounded in the session's observed work
  (path / number / file / test-result anchor, ≥24 chars, and — when transcript
  is available — at least one substantive token overlapping recent messages).
  Weak claims are rejected and the goal stays `active`.
- `goal_block(reason)` — model-callable; reports a genuine blocker.
- `goal_clear(request)` — model-callable **only on explicit user instruction**.
  `request` must quote the user's own message, and the quote is grounded
  against non-assistant transcript text (assistant prose cannot unlock it;
  no transcript fails closed). The model's sanctioned exits remain
  `goal_complete` and `goal_block`.
- **Durable history**: every terminal goal (and any active goal superseded by
  a new `set`) is archived under `goal/<session>/archived/<goalID>`.
  `/goal history` and the read-only `goal_history()` tool render them newest
  first — outcome, turns, tokens, task counts, and evidence snippets survive
  across goal replacements.
- The objective is injected via `ctx.session.hook("context")` on every agent
  model call.
- Continuation is driven by terminal `session.execution.*` events (see why in
  the design doc), one continuation per idle boundary, scoped to the owning
  plugin instance by project.
- A continuation that makes no tool call stalls the goal; reaching a cap yields
  a distinct `budget_limited` outcome that is neither completion nor blocked.
- The permission sandbox (`permission.hook("evaluate")`) auto-allows in-scope
  path requests for sessions with an `active` goal and auto-denies out-of-scope
  ones with a message steering the model to `goal_block`. Configured `deny`
  rules are never widened (the platform does not invoke the hook for them;
  the plugin additionally guards `effect === "deny"`).

## Status outcomes

`active · paused · completed · blocked · budget_limited · stalled · cleared`

## Requirements

- OpenCode v2 (`@opencode/plugin` 2.x). Built and live-verified against
  **2.0.15** (a service restart during verification moved the host to 2.0.16).
- Bun, for tests and typecheck.

## Install (local, permanent)

This repo is shaped for a local directory install. Nothing is published to npm
(and the legacy name `opencode-goals` on npm is an unrelated package).

```sh
git clone https://github.com/wukrit/opencode2-goals.git ~/Projects/opencode2-goals
```

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    { "package": "/path/to/opencode2-goals", "options": {} }
  ]
}
```

With options (all optional):

```jsonc
{
  "package": "/path/to/opencode2-goals",
  "options": {
    "stallLimit": 1,
    "defaultCapTurns": 10,
    "defaultCapTokens": 100000
  }
}
```

Then reload locations:

```sh
opencode api post /api/location/reload
```

A local (directory) install cannot resolve `@opencode/plugin`, so the runtime
entry imports only local modules and declares the context shape structurally —
the same convention as `opencode-litellm-models`.

## Usage

```sh
# in a session:
/goal set Land the release --turns 8
/goal view
/goal task add Write migration
/goal task 1 doing
/goal task done 1
/goal complete tests: 42/42 pass at commit abc123, output in build/log.txt
/goal block Waiting on credentials for the staging cluster
/goal pause
/goal resume
/goal clear
/goal history
```

The model can maintain the same breakdown with `goal_add_task(title)` and
`goal_update_task(ref, status)` — the widget stays in sync.

Unattended goals: rely on the default cap, keep work inside the session
working directory, and let the permission sandbox deny the rest. If a goal
genuinely needs no numeric limit, pass `--unbounded` explicitly.

## Live progress widget (sidebar)

The server exposes `goals.get({ sessionID })` and emits `goals.updated` on
every write (see `src/rpc.ts`). The TUI entry (`src/tui.tsx`, `./tui` export)
renders a live sidebar block in three sections — objective; a counter grid
(`Status:`, `Turns:`, `Tokens:`, `Tasks:` sharing one label column) with a
task-progress bar; and the task list — updating via the RPC event, no
polling. Colored accents collapse to base text on light themes so the widget
stays legible in both modes.

Load both entries: the server plugin as usual, plus the CLI plugin:

```jsonc
// opencode.jsonc (server)
{ "plugins": [{ "package": "/path/to/opencode2-goals" }] }
```

```jsonc
// cli.json (TUI) — local directory form, verified on 2.0.16
{ "plugins": [{ "package": "/path/to/opencode2-goals" }] }
```

Do not use `{ "plugins": ["opencode2-goals"] }`: this package is not
published to npm, so the bare name cannot resolve. (The legacy name
`opencode-goals` on npm belongs to an unrelated package and fails to load —
`jsxDEV` export error; observed on 2.0.16.) The CLI resolves a
local directory to its top-level `tui.tsx` (same layout as
`<global-config>/plugins/<name>/tui.ts` discovery), so this repo keeps a
top-level `tui.tsx` shim re-exporting `src/tui.tsx` (still exposed as `./tui`
for the publish shape). Server plugins exposing `./tui` did not auto-load in
the observed TUI (12 builtin plugins only); the explicit `cli.json` directory
entry loads `goals-tui` cleanly (`plugins=13`).

## Safe configuration

- Keep each loaded location on a distinct project (the default). The plugin
  scopes continuation and permission decisions to the session's owning project;
  two locations sharing one project id would both act, and `ctx.storage` has
  no compare-and-set to arbitrate them.
- Run a single server process against the plugin DB. Two servers sharing one
  `opencode.db` race on last-write-wins storage.
- Treat evidence as a heuristic gate, not proof. A second-model or shell-check
  evaluator is out of scope; see `src/evidence.ts` and the design doc.

## Development

```sh
bun install
bun run typecheck
bun test
```

## Layout

```
index.ts            # loader entry: { id, setup } + goals RPC
tui.tsx             # top-level TUI shim (re-exports src/tui.tsx for cli.json dir resolution)
src/
  controller.ts     # the goal loop (commands, tools, hooks, events, permission sandbox, goal archive)
  state.ts          # durable goal record + tasks + pure transitions + archive keys
  command.ts        # /goal parsing (caps, --unbounded, tasks, history) + status formatting
  rpc.ts            # goals.get / goals.updated for the widget (import-free)
  tui.tsx           # sidebar progress widget (./tui export)
  evidence.ts       # completion-evidence gate + user-request gate for goal_clear
  permission.ts     # path sandbox (decidePermission, fail-closed containment)
  options.ts        # plugin options (stallLimit, defaultCapTurns/Tokens)
  types.ts          # structural slice of the plugin context
test/
  harness.ts        # mocked context + deterministic event bus (+ permission hook)
  goal-loop.test.ts # integration tests through the real setup()
docs/
  design.md         # production design and open-question answers
```

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Sukrit Walia
