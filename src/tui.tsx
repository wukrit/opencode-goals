/* @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { goalsRpc, type GoalSnapshot } from "./rpc"

/** TextAttributes.BOLD (1 << 0) from @opentui/core; inlined so the local
 *  install stays resolvable without deep-importing the renderer package. */
const BOLD = 1

/** Compact token count: 27780 -> "27.8k", 950 -> "950". */
function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  const k = n / 1000
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`
}

function progressBar(percent: number, width = 12): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`
}

function GoalWidget(props: { sessionID: string }) {
  const context = usePlugin()
  const [snapshot, setSnapshot] = createSignal<GoalSnapshot | undefined>(undefined)

  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID) {
      setSnapshot(undefined)
      return
    }
    let cancelled = false
    const goals = context.client.rpc(goalsRpc as never) as unknown as {
      get(input: { sessionID: string }): Promise<{ goal?: GoalSnapshot }>
      events: {
        on(name: "updated", handler: (event: { data: { sessionID?: string; goal?: GoalSnapshot } }) => void): () => void
      }
    }
    void goals
      .get({ sessionID })
      .then((result) => {
        if (!cancelled) setSnapshot(result?.goal)
      })
      .catch(() => {
        if (!cancelled) setSnapshot(undefined)
      })
    const off = (() => {
      try {
        return goals.events.on("updated", (event) => {
          if (cancelled) return
          if (event?.data?.sessionID === sessionID && event?.data?.goal) {
            setSnapshot(event.data.goal)
          }
        })
      } catch {
        return () => {}
      }
    })()
    onCleanup(() => {
      cancelled = true
      try {
        off()
      } catch {
        // Unsubscribe is best-effort.
      }
    })
  })

  return (
    <Show when={snapshot()}>
      {(goal) => {
        const tasks = () => goal().tasks ?? []
        const done = () => tasks().filter((t) => t.status === "done").length
        const doing = () => tasks().filter((t) => t.status === "doing").length
        const turnsCap = () => (typeof goal().cap?.turns === "number" ? (goal().cap.turns as number) : undefined)
        const tokensCap = () => (typeof goal().cap?.tokens === "number" ? (goal().cap.tokens as number) : undefined)
        // All counters share one shape: padded label + left-aligned "X / Y"
        // (cap omitted when uncapped), so values start in the same column.
        const counterRows = () => {
          const rows: Array<[string, string]> = []
          const tCap = turnsCap()
          if (tCap !== undefined) rows.push(["Turns", `${goal().used.turns} / ${tCap}`])
          const used = formatTokens(goal().used.tokens ?? 0)
          const tCap2 = tokensCap()
          rows.push(["Tokens", tCap2 !== undefined ? `${used} / ${formatTokens(tCap2)}` : used])
          rows.push(["Tasks", `${done()} / ${tasks().length}`])
          return rows.map(([label, value]) => `${`${label}:`.padEnd(8)}${value}`)
        }
        // The bar tracks task progress, not the turn budget (the budget is a
        // plain counter below). A completed goal always reads as full.
        const taskPct = () => {
          if (goal().status === "completed") return 100
          const n = tasks().length
          return n ? Math.min(100, (done() / n) * 100) : 0
        }
        // Several themes' accent/success/warning inks are too low-contrast on
        // light backgrounds. Keep colored accents in dark mode; in light mode
        // fall back to base text (the status words themselves carry the signal).
        const ink = (color: string) =>
          context.themeMode === "light" ? context.theme.text.base : color
        const statusColor = () => {
          switch (goal().status) {
            case "active":
              return context.theme.text.success
            case "paused":
              return context.theme.text.warning
            case "completed":
              return context.theme.text.accent
            case "blocked":
            case "stalled":
            case "budget_limited":
              return context.theme.text.error
            default:
              return context.theme.text.muted
          }
        }
        return (
          // No horizontal padding: the sidebar slot already aligns items, and
          // extra paddingLeft made this widget sit deeper than its siblings.
          <box flexDirection="column" gap={0} paddingTop={1}>
            <text fg={ink(context.theme.text.accent)} attributes={BOLD}>
              Goal:
            </text>
            <text fg={context.theme.text.base} wrapMode="word">
              {goal().objective}
            </text>
            {/* Section 2: budget + status + progress, set off from the
                objective above and the task list below. */}
            <box flexDirection="column" gap={0} marginTop={1}>
              <box flexDirection="row">
                <text fg={context.theme.text.base}>{"Status:".padEnd(8)}</text>
                <text fg={ink(statusColor())}>{goal().status}</text>
              </box>
              <For each={counterRows()}>
                {(line) => <text fg={context.theme.text.base}>{line}</text>}
              </For>
              <Show when={tasks().length > 0}>
                <text fg={ink(context.theme.text.success)}>
                  {progressBar(taskPct())} {Math.round(taskPct())}%
                </text>
              </Show>
            </box>
            <Show when={tasks().length > 0}>
              <box flexDirection="column" marginTop={1}>
                <For each={tasks().slice(0, 6)}>
                  {(task, i) => (
                    // Done tasks keep base text; ✔ carries the signal.
                    <text fg={task.status === "doing" ? ink(context.theme.text.warning) : context.theme.text.base} wrapMode="word">
                      {task.status === "done" ? "✔" : task.status === "doing" ? "›" : "·"} {i() + 1}. {task.title}
                    </text>
                  )}
                </For>
                <Show when={tasks().length > 6}>
                  <text fg={context.theme.text.muted}>+{tasks().length - 6} more · /goal view</text>
                </Show>
                <Show when={doing() === 0 && done() < tasks().length}>
                  <text fg={context.theme.text.muted}>/goal task &lt;n&gt; doing|done</text>
                </Show>
              </box>
            </Show>
            <Show when={tasks().length === 0}>
              <text fg={context.theme.text.muted}>/goal task add &lt;title&gt; to track work</text>
            </Show>
          </box>
        )
      }}
    </Show>
  )
}

export default Plugin.define({
  id: "goals-tui",
  setup(context) {
    const dispose = context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        const sessionID = (input as { sessionID?: string }).sessionID ?? ""
        if (!sessionID) return null as never
        return <GoalWidget sessionID={sessionID} />
      },
    })
    return () => {
      try {
        dispose()
      } catch {
        // Slot cleanup is best-effort.
      }
    }
  },
})
