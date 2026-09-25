/**
 * opencode-goals — durable, session-scoped goal loop for OpenCode v2.
 *
 *  - `/goal set|view|pause|resume|clear|complete|block|history` command surface
 *    (default 10-turn / 100k-token cap unless `--unbounded` is given;
 *    explicit `--turns N` / `--tokens N` override the defaults).
 *  - the objective injected into every agent-loop model call through the
 *    `session.hook("context")` hook.
 *  - event-driven continuation on terminal `session.execution.*` events.
 *  - `goal_set` (model-callable set; refuses to clobber a non-terminal goal),
 *    `goal_complete` (concrete, grounded evidence required), `goal_block`,
 *    `goal_clear` (only on a transcript-grounded quote of an explicit
 *    user request), `goal_add_task`/`goal_update_task`, and read-only
 *    `goal_history` model-callable tools.
 *  - durable history: terminal and superseded goals are archived under
 *    `goal/<session>/archived/<goalID>`, surfaced via `/goal history`.
 *  - stall suppression when a continuation turn makes no tool call.
 *  - unattended permission sandbox via `permission.hook("evaluate")`:
 *    in-scope path requests are allowed, out-of-scope ones are denied with a
 *    steer toward `goal_block`; configured denies are never widened.
 *
 * The runtime entry intentionally imports nothing but local modules, mirroring
 * `opencode-litellm-models`: a local (directory) install cannot resolve
 * `@opencode/plugin`, and the loader only needs a default export with `id` and
 * `setup`. Type-only imports are used for development.
 */

import { GoalController } from "./src/controller"
import { goalsRpc, toSnapshot } from "./src/rpc"
import type { PluginContext } from "./src/types"

export default {
  id: "goals",

  async setup(ctx: PluginContext): Promise<() => void> {
    // Diagnostics: set GOALS_DEBUG=1 to record every setup() invocation
    // (the plugin is instantiated once per loaded location; see docs/design.md).
    if (process.env.GOALS_DEBUG === "1") {
      try {
        const fs = await import("node:fs")
        fs.appendFileSync(
          "/tmp/opencode-goals-setup.log",
          `${new Date().toISOString()} dir=${ctx.location?.directory ?? "?"} pid=${process.pid}\n`,
        )
      } catch {
        // Never let logging break the plugin.
      }
    }
    const controller = new GoalController(ctx)
    // Live widget bridge: expose `goals.get` and emit `goals.updated` on
    // every durable write. Best-effort — the loop never depends on it.
    try {
      const rpc = ctx.rpc
      if (rpc) {
        const registration = await rpc.register(goalsRpc, {
          get: async (input: unknown) => {
            const sessionID = (input as { sessionID?: string })?.sessionID ?? ""
            const goal = sessionID ? await controller.snapshot(sessionID) : undefined
            return goal ? { goal: toSnapshot(goal) } : {}
          },
        } as never)
        controller.onChange = async (goal) => {
          try {
            await registration.events.emit("updated", { sessionID: goal.sessionID, goal: toSnapshot(goal) })
          } catch {
            // Widget subscribers are optional.
          }
        }
      }
    } catch {
      // Older hosts without ctx.rpc: the /goal view path still works.
    }
    return controller.start()
  },
}
