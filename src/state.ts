/**
 * Goal state: the durable, session-scoped record, the archive keys that give
 * goals a history, and the pure transitions that operate on them. Kept free
 * of plugin-context dependencies so the state machine can be reasoned about
 * (and unit tested) in isolation.
 */

export type GoalStatus =
  | "active"
  | "paused"
  | "completed"
  | "blocked"
  | "budget_limited"
  | "stalled"
  | "cleared"

/** Why a goal stopped. `budget_limited` is deliberately not `completed`. */
export type GoalOutcome = "completed" | "budget_limited" | "blocked" | "stalled"

export type GoalCap = {
  /** Maximum number of continuation turns. Unset = no numeric limit. */
  turns?: number
  /** Maximum tokens (input + output) observed across the session. Unset = no limit. */
  tokens?: number
}

export type GoalTaskStatus = "todo" | "doing" | "done"

export type GoalTask = {
  id: string
  title: string
  status: GoalTaskStatus
  createdAt: number
  updatedAt: number
}

export type GoalRecord = {
  /** Durable schema marker, so a reload can migrate old records. */
  version: 1
  /** Stable short id, referenced by tool calls and prompt metadata. */
  id: string
  sessionID: string
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  cap: GoalCap
  used: { turns: number; tokens: number }
  /** Consecutive continuation turns that made no tool call. */
  stalls: number
  /** Continuation prompts injected for this goal. */
  continuations: number
  /** Ordered task breakdown for the progress widget. Empty = untracked. */
  tasks: GoalTask[]
  evidence?: string
  blocker?: string
  outcome?: GoalOutcome
  /** Last terminal event id acted on, so a replayed event cannot double-fire. */
  lastHandledEventID?: string
}

export const GOAL_STORAGE_PREFIX = "goal/"

export function goalStorageKey(sessionID: string): string {
  return `${GOAL_STORAGE_PREFIX}${sessionID}`
}

/** Append-only history: every terminal (or superseded) goal is archived here. */
export function archivedPrefix(sessionID: string): string {
  return `${goalStorageKey(sessionID)}/archived/`
}

export function archivedGoalKey(sessionID: string, goalID: string): string {
  return `${archivedPrefix(sessionID)}${goalID}`
}

export function isTerminal(status: GoalStatus): boolean {
  return (
    status === "completed" ||
    status === "blocked" ||
    status === "budget_limited" ||
    status === "stalled" ||
    status === "cleared"
  )
}

export function isCapReached(goal: GoalRecord): boolean {
  const { turns, tokens } = goal.cap
  if (typeof turns === "number" && goal.used.turns >= turns) return true
  if (typeof tokens === "number" && goal.used.tokens >= tokens) return true
  return false
}

export function capSummary(cap: GoalCap): string {
  const parts: string[] = []
  if (typeof cap.turns === "number") parts.push(`${cap.turns} turns`)
  if (typeof cap.tokens === "number") parts.push(`${cap.tokens} tokens`)
  return parts.length ? parts.join(", ") : "none"
}

let counter = 0
export function nextGoalID(now: number = Date.now()): string {
  counter = (counter + 1) % 1_000_000
  return `g_${now.toString(36)}_${counter.toString(36)}`
}

export type NewGoalInput = {
  sessionID: string
  objective: string
  cap?: GoalCap
}

export function createGoal(input: NewGoalInput, now: number = Date.now()): GoalRecord {
  return {
    version: 1,
    id: nextGoalID(now),
    sessionID: input.sessionID,
    objective: input.objective,
    status: "active",
    createdAt: now,
    updatedAt: now,
    cap: input.cap ?? {},
    used: { turns: 0, tokens: 0 },
    stalls: 0,
    continuations: 0,
    tasks: [],
  }
}

/** Fill defaults for records written before task tracking existed. */
export function normalizeGoal(goal: GoalRecord): GoalRecord {
  if (!Array.isArray((goal as { tasks?: unknown }).tasks)) {
    goal.tasks = []
  }
  return goal
}

let taskCounter = 0
export function nextTaskID(now: number = Date.now()): string {
  taskCounter = (taskCounter + 1) % 1_000_000
  return `t_${now.toString(36)}_${taskCounter.toString(36)}`
}

export function taskCounts(tasks: readonly GoalTask[]): { total: number; done: number; doing: number; todo: number } {
  let done = 0
  let doing = 0
  for (const t of tasks) {
    if (t.status === "done") done++
    else if (t.status === "doing") doing++
  }
  return { total: tasks.length, done, doing, todo: tasks.length - done - doing }
}
