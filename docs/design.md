# Design: Codex-style Goals as an OpenCode V2 plugin

**Status:** production-ready · **Target:** OpenCode **2.0.16** (live-verified; earlier work on 2.0.15, the host moved during verification) · **Artifact:** production plugin in this repo (`opencode-goals@1.0.0`)

> **Note on evidence references:** throughout this doc, `[OBSERVED]` claims cite
> experiment IDs (L1–L21) and raw event captures (`raw/…`) from the author's
> private experiment log, recorded against real 2.0.15/2.0.16 hosts. That log
> contains machine-specific session data and is intentionally not shipped with
> the public repo; the claims it supports are reproducible with the steps in §7.

**Decision: feasible, with all three required mitigations implemented and live-verified.** An OpenCode V2 plugin
reproduces a Codex-style goal loop — durable session state, a `/goal`
command surface, objective injection into every model call, event-driven
continuation on idle, evidence-gated completion, and stall suppression:

1. **`session.idle` is not delivered** to plugin subscribers in 2.0.15. The
   plugin uses terminal `session.execution.*` events instead. *(observed)*
2. **`setup()` runs once per loaded location, and every instance sees the global
   event stream.** Owner-scoping (`session.projectID` vs
   `ctx.location.project.id`) keeps exactly one instance responsible; five
   production goals set across two locations each show `continuations == 1`
   with no duplication. *(observed; residual cross-instance race documented
   below)*
3. **Completion is gated beyond non-empty.** `goal_complete` requires a
   concrete anchor (≥24 chars), and — when transcript is available — grounding
   in observed work; weak claims are rejected live and the goal stays `active`.
   Genuine semantic verification remains out of scope by design. *(observed)*

Everything below separates **[OBSERVED]** (in the running 2.0.15 system),
**[INFERRED]** (from docs/types without direct observation), and **[UNKNOWN]**.

---

## 1. What was built

A directory-loadable plugin (`index.ts` → `src/`) mirroring
`opencode-litellm-models` conventions: structural context types, no
runtime import of `@opencode/plugin`, `bun test` + `tsc --noEmit`.

| Surface | API used | Purpose |
| --- | --- | --- |
| State | `ctx.storage.get/set/remove/scan` | Durable `goal/<sessionID>` record + `goal/<sessionID>/archived/<goalID>` history |
| Command | `ctx.command.transform` → `editor.add({name:"goal"})` | `/goal set\|view\|pause\|resume\|clear\|complete\|block\|history` (+ `task` subcommands) |
| Tools | `ctx.tool.transform` → `editor.add` | `goal_set(objective, turns?, tokens?, unbounded?)`, `goal_complete(evidence)` (required), `goal_block(reason)` (required), `goal_clear(request)` (transcript-grounded user quote required), `goal_add_task` / `goal_update_task`, read-only `goal_history` |
| Objective | `ctx.session.hook("context")` → `event.system.push(...)` | Inject the objective + rules into every agent-loop model call |
| Continuation | `ctx.session.prompt({sessionID,text,metadata,delivery:"queue",resume:true})` | Inject one continuation per idle boundary |
| Notices | `ctx.session.synthetic({sessionID,text,metadata})` | User-visible status (marked `goalControl`) |
| Trigger | `ctx.event.subscribe({signal})` | React to terminal `session.execution.*` |

The loop: `/goal set <objective>` writes the record and injects a kickoff
continuation. When the execution ends, the handler checks state, cap, stall,
and tool-use, then injects the next continuation. The loop ends when the model
calls `goal_complete` with evidence, reports `goal_block`/`BLOCKED:`, the cap is
reached (`budget_limited`), the goal stalls, or the user pauses/clears/interrupts.

## 2. Verification summary

- **Integration (`bun test`, 32 passing, `tsc --noEmit` clean).** Drives the
  real `setup()` through a mocked context + deterministic async event bus.
  Covers: reload survival; exactly one continuation per boundary; duplicate
  event id ignored; own-prompt does not re-trigger; stall suppression; BLOCKED
  detection; completion rejected without evidence / accepted with evidence;
  pause + clear halt; interrupt does not continue; turn cap → `budget_limited`;
  token cap; unbounded continuation; per-project instance scoping; objective
  injected on every call; task tracking + widget bridge; `goal_set` cap
  defaults and no-clobber guard; `goal_clear` request gating; durable history
  archiving.
- **Live (OpenCode 2.0.15, real service, spike loaded).** Three runs, covering
  all three terminal outcomes:
  - *Completion:* 3-file finish line; auto-continued across **three** idle
    boundaries with no further user input; model called `goal_complete` with the
    `ls` output as evidence; `/goal view` showed `Status: completed`,
    `Continuations: 4 · stalls: 0 · cap: 8 turns · used: 4 turns`.
  - *Cap:* never-finished goal with `--turns 2` stopped after exactly two
    continuations with `budget_limited` and “This is not completion.”
  - *Blocker:* impossible goal (missing source file) → model called
    `goal_block`; `/goal view` showed `Status: blocked` with the missing-file
    reason. The run first hung on an `external_directory` permission prompt
    until it was rejected — a real operational caveat (see §5).

Raw captures and the experiment log are maintained privately (see the note at
the top of this doc).

---

## 3. Open questions, answered

### Q1. Which event reliably marks end-of-turn, and does it distinguish user prompts from the plugin's own continuation prompts?

**Answer: terminal `session.execution.{succeeded,failed,interrupted}` marks
end-of-turn. Events do not distinguish prompt origin; attribution is via
persisted prompt `metadata`.**

**[OBSERVED]** A tool-using turn emits `session.step.started/ended` once per
model step (the first ended with `finish:"tool-calls"`, the last with
`finish:"stop"`) and exactly one terminal `session.execution.succeeded` at the
end of the drain. Therefore `session.step.ended` is *not* an idle boundary;
`session.execution.*` is. (`raw/tool-turn-taxonomy-events.ndjson`.)

**[OBSERVED]** `session.idle` and `session.status` were **never** delivered to
`/api/event` (`ctx.event.subscribe` uses the same public stream) across six
runs, including a targeted probe that waited 12 s after idle and attempted
`session.view`. The schema defines them as `ephemeral`; `session.execution.*`
is `durable`. (`raw/session-idle-probe-events.ndjson`;
`@opencode/schema@2.0.15` `session-status-event.d.ts`, `session-event.js`.)

**[OBSERVED]** Prompt `metadata` is persisted on the user message and echoed in
`session.inbox.enqueued` → `data.item.payload.metadata`, and is readable back
from `ctx.session.context()`. The plugin tags its continuations
`{goalContinuation:true, goalID, goalTurn}` and uses that to tell its own prompts
from the user's. A `goalControl` tag marks status notices. No event-level
`source` field is needed.

**Documented vs observed:** the V1→V2 migration guide example says
`if (event.type === "session.idle")`, and the schema names the event — but it
is not on the plugin-visible stream in this build. This is the first
docs-vs-reality gap.

### Q2. Does `session.prompt` inside the event handler deliver safely, and how is continuation attributed to the goal to detect loops?

**Answer: yes; attribute with prompt `metadata`, and only react to terminal
execution events.**

**[OBSERVED]** Continuations injected from the terminal-event handler started
new executions every time. The live completion run shows the causal chain:
`execution.succeeded` → `inbox.enqueued(goalContinuation, goalTurn:N)` →
`execution.started` → … → `execution.succeeded` → `goalTurn:N+1`, four times,
with no user input. `resume:true` + `delivery:"queue"` worked.

**[OBSERVED — the loop-safety mechanism]** Reentrancy/duplication is prevented by
four rules, all exercised by tests and the live run:

1. React **only** to terminal execution events. `inbox.enqueued` (including the
   plugin's own continuation) and `execution.started` never schedule work.
2. Dedupe terminal events by `event.id` (in-memory + `lastHandledEventID` on the
   durable record), so a replay cannot double-fire.
3. A per-session `continuationPending` set: a second terminal event for a
   boundary whose continuation has not yet started is ignored.
4. Per-project instance scoping (Q3) so N loaded locations don't each continue.

**[OBSERVED]** Attribution survives reload because it lives on the persisted
message and in `ctx.storage`.

### Q3. Is goal state truly thread-scoped and does it survive restart?

**Answer: durable and session-keyed, but *not* automatically instance-local —
scoping is the caller's responsibility.**

**[OBSERVED]** `ctx.storage` is durable and plugin-scoped; the spike keys it
`goal/<sessionID>`. State survived a simulated plugin reload (tests) and many
live turns; `/goal view` read back objective, status, counters, cap, and
evidence after the fact.

**[OBSERVED — hazard]** `setup()` runs **once per loaded location** (three
lines, one pid, three directories in `/tmp/opencode-goals-setup.log`), and all
instances share storage and the global event stream. Without scoping, all three
processed the same session and enqueued three continuations for one boundary
(`goalTurn:2 ×3`). **Fix:** resolve the session's `projectID` via
`ctx.session.get()` and only act when it matches `ctx.location.project.id`
(directory fallback). A two-instance regression test shares storage and asserts
the non-owner injects nothing.

**[OBSERVED]** Direct inspection of the service's SQLite store shows the record
persisted in the `kv` table as
`plugin:0067006f0061006c0073:goal/<sessionID>`
(`0067006f0061006c0073` = utf-16be `goals`), with objective, status, cap,
`used`, `stalls`, `continuations`, `lastHandledEventID`, `outcome`, and
`evidence`. The records outlived plugin unload, reload, and session deletion
(`raw/plugin-storage-records.json`). Because this is the service's persistent DB
(not an in-memory cache), a full restart re-reads it — **restart durability is
observed at the storage layer**, though the process itself was not restarted.

**[OBSERVED — counter corruption]** The pre-fix duplicate run shows writes are
last-write-wins: three duplicate prompts were sent for one boundary but
`continuations` recorded only `2`. So duplicate instances double the work *and*
corrupt the budget counter.

**[UNKNOWN / hazard remains]** If two loaded locations ever share a project id —
or two server processes handle one session — the in-memory dedupe cannot stop
cross-instance duplication without an atomic claim in storage (none exists:
`ctx.storage` has no compare-and-set).

### Q4. Can the objective be held in every model call, and can completion be gated on evidence?

**Answer: yes to both, with the caveat that evidence is only checked for
presence/shape, not verified semantically.**

**[OBSERVED]** `ctx.session.hook("context")` runs for the agent loop (including
tool-driven continuations) and the spike pushes a `system` text part on every
call; tests call it twice and assert the objective is present both times. The
live model acted on the objective each turn.

**[OBSERVED]** `goal_complete` has required `evidence`; empty/whitespace evidence
returns a rejection and leaves the goal `active` (test). The live run recorded
the real `ls` output as evidence and reported `Outcome: completed`.

**[OBSERVED — caveat]** With Code Mode enabled, the free model invoked
`goal_complete` *through* the `execute` tool, so the persisted assistant message
shows only `execute`. Evidence still lands on the goal record (verified via
`/goal view`); auditing *which* tool ran from the transcript alone is not
reliable in this configuration.

### Q5. Can lifecycle authority (pause/resume/clear, refusing model-initiated completion without evidence) be enforced?

**Answer: yes for the control plane; evidence is structural.**

**[OBSERVED]** `/goal pause` sets `paused` and a subsequent terminal event
schedules nothing; `/goal clear` removes/halts; `/goal resume` re-arms and
injects a continuation; `/goal view` reports state. `session.execution.interrupted`
(`reason:"user"`) never continues. Tests cover all of these; the live run
exercised set/view and interrupt. A live impossible goal stopped with
`Status: blocked` and the model-supplied reason (see §2).

**[ADDED post-spike]** `goal_clear` is now model-callable but gated: it only
executes on a quote of the user's own message, grounded against non-assistant
transcript text and failing closed when no transcript is available — the
"cleared without a trace" hole stays shut. `goal_set` is likewise model-callable
but refuses to clobber a non-terminal goal.

**[OBSERVED]** Model-initiated `goal_complete` without evidence is refused and
state is unchanged. But the gate is a non-empty-string check; a model can still
supply weak evidence. Genuine verification would need an evaluator (e.g. a
second model or a shell check) — out of scope here. **[UNKNOWN]** how reliably
models supply *good* evidence across model families.

### Q6. How does the cap transition state once reached, and can it resume or clear without being confused with completion?

**Answer: it becomes a distinct `budget_limited` status/outcome, not completion
and not blocked, and is resumable.**

**[OBSERVED]** On each terminal event the handler checks
`used.turns >= cap.turns` or `used.tokens >= cap.tokens`. When reached it sets
`status=budget_limited`, `outcome=budget_limited`, stops, and posts a distinct
notice. Live `--turns 2`: exactly two continuations, then `budget_limited`
(“This is not completion”). Tests assert `outcome !== "completed"` and that
`/goal resume` re-arms. Turn counts include the kickoff continuation; token
usage is read from cumulative `session.usage.updated`. With **no cap**, the loop
continued indefinitely in tests and (pre-fix) live until interrupted —
confirming "unset means no numeric limit" and that user interrupt/clear remain
the backstop.

---

## 4. Observed vs documented vs unknown

| Claim | Status | Evidence |
| --- | --- | --- |
| `session.execution.*` ends a turn | OBSERVED | tool-turn + live event logs |
| `session.idle` reaches plugin subscribers | OBSERVED **NO** | 12 s probe, 6 runs, ephemeral schema |
| Prompt `metadata` round-trips and persists | OBSERVED | context dump + inbox events |
| `session.prompt` from handler starts a turn | OBSERVED | live completion chain |
| `setup()` once per loaded location | OBSERVED | setup log, 3 entries |
| Naive subscribe → N× duplicate continuation | OBSERVED | `goalTurn:2 ×3` |
| Storage durable across plugin reload | OBSERVED (test + DB) | reload test; `kv` record |
| Storage durable across full service restart | OBSERVED (process restart) | same goal IDs/counters before/after `service restart`, L18 (`raw/restart-before.json`, `raw/restart-after.json`); host moved 2.0.15 → 2.0.16 during the restart |
| Blocker reported by a live goal | OBSERVED | live blocker run |
| Unattended loop handles permission prompts | OBSERVED (sandbox) | `permission.evaluate` invoked live: in-scope `.env` ask→allow, outside `external_directory` ask→deny with `goal_block` steer, configured deny stays deny (L14; `raw/permission-*.json`) |
| Non-path permission prompts | OBSERVED (limitation) | shell/URL/command resources left untouched by design; remain manual |
| Objective injectable every model call | OBSERVED | context hook + tests |
| Completion gated on evidence presence | OBSERVED | tests + live |
| Weak evidence cannot complete | OBSERVED | short/generic/ungrounded rejected live, goal stays `active`; grounded strong completes (L16; `raw/live-evidence-gating-records.json`) |
| Completion evidence semantically verified | NOT DONE (by design) | heuristic gate only; evaluator out of scope (`src/evidence.ts`) |
| Default cap applies when none is given | OBSERVED | `/goal set` with no flags records 10 turns / 100,000 tokens live (L15); `--unbounded` opts out |
| Cap produces distinct non-completion outcome | OBSERVED | live cap run + tests |
| Two locations sharing a project | UNKNOWN (limitation) | no atomic claim available; safe config = distinct projects + single server |

## 5. Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Multi-location duplicate continuation | **High** (observed, mitigated) | Scope to `ctx.location.project.id` for events and permission decisions; regression tests; 5 live goals show no duplication. Residual: shared project id or two server processes race on last-write-wins storage — use distinct projects + a single server. |
| Runaway loop with no cap | **High** (observed pre-fix, mitigated) | Default 10-turn / 100k-token cap when none is given; `--unbounded` is explicit opt-in; interrupt/clear backstop. |
| Model claims done in prose without calling the tool | Medium (observed) | Explicit continuation prompt (“end with a tool call”); stalls if no tool call; still model-dependent. |
| Weak/empty evidence accepted | Medium (mitigated) | Length + anchor + transcript-grounding gate (`src/evidence.ts`); live weak-rejection verified. Determined fabrication still possible without an evaluator. |
| `session.idle` assumed from docs | High | Use `session.execution.*`; treat idle as unavailable. |
| Notices cost a model turn | Low | `synthetic` invokes a turn (observed); mark `goalControl` so it never triggers continuation. |
| Unattended loop hangs on a permission prompt | **High** (observed, mitigated) | Permission sandbox: allow in-scope paths, deny out-of-scope with `goal_block` steer; configured denies never widened. Non-path resources remain manual by design. |

## 6. API gaps and requested changes (to make this production-grade)

1. **Emit a session-idle/lifecycle signal to plugin subscribers**, or state
   explicitly that `session.idle`/`session.status` are TUI-only. The migration
   guide currently implies plugins can use `session.idle`.
2. **Per-session/per-project event routing or an ownership API**, so a plugin
   loaded at N locations doesn't have to infer ownership from `session.get()`.
   Alternatively, expose which plugin instance owns a session.
3. **Atomic storage compare-and-set** (or a lock) for cross-instance
   coordination; today storage is last-write-wins.
4. **A first-class auto-continue / goal lifecycle hook** (Codex parity) would
   remove the need to infer turn boundaries from `session.execution.*` and to
   re-inject prompts.
5. **A way to post user-visible notices without a model turn** (`synthetic`
   currently triggers one).
6. **Stable tool identity through Code Mode** in the transcript so evidence
   audits can tell which tool actually ran.
7. **Permission integration for unattended loops** — RESOLVED with
   `permission.hook("evaluate")`: allow in-scope paths, deny out-of-scope with
   a `goal_block` steer, never widen configured denies (live-verified, L14).
   Remaining limitation: non-path resources (shell text, URLs) are left
   untouched by design.

None of these blocks production use; items 1–3 remain open platform requests.
Item 7 is closed by the sandbox above.

## 7. Reproduce

```sh
cd /path/to/opencode-goals
bun install
bun run typecheck
bun test
```

Live (permanent local install):

```jsonc
// ~/.config/opencode/opencode.jsonc  (plugins array)
{ "package": "/path/to/opencode-goals", "options": {} }
```

```jsonc
// ~/.config/opencode/cli.json (TUI widget, verified live)
{ "plugins": [{ "package": "/path/to/opencode-goals" }] }
```

```sh
opencode api post /api/location/reload
# then in a session: /goal set <objective> --turns 8
# status: /goal view
```

The bare `cli.json` form `{ "plugins": ["opencode-goals"] }` does not resolve
to this repo: on 2.0.16 it fetches an unrelated npm package and fails
(`jsxDEV` export error; `raw/l20-cli-bare-failure.log`). A local directory
entry requires a top-level `tui.tsx` (this repo keeps one as a shim over
`src/tui.tsx`); without it the entry is silently ignored (12 plugins, no
`goals-tui`), with it the TUI reads and sets up `goals-tui` (`plugins=13`;
`raw/l20-tui-load.log`). `POST /api/rpc/goals/get` returns the snapshot
including tasks (`raw/l20-rpc-get.json`); every durable write emits
`rpc.goals.updated` with the matching `sessionID` (`raw/l20-goals-updated-events.ndjson`).

The plugin was loaded this way for the live runs; the config was restored
byte-identical afterwards and throwaway probe sessions were deleted.

## 8. Experiment log

The full open-questions ledger (L1–L21, including the failing duplicate run,
the fix, the storage-backend dump, the live blocker/permission caveats, and the
production hardening: permission sandbox, default caps, evidence grounding,
multi-instance re-verification, full restart, publish shape, and the live-
verified widget/model-tool work) is kept as a private experiment log and is not
shipped with this repo. All questions raised while building the spike are
answered in §3; the deliberately remaining limitations are shared-project
instances (no atomic claim), heuristic-only evidence, and non-path permission
prompts (manual by design).
