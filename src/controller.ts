/**
 * The goal loop controller.
 *
 * Wires the four OpenCode surfaces the design depends on — command, tool,
 * session `context` hook, and the event stream — onto one durable goal record
 * per session. All trigger and dedupe logic lives here; `index.ts` only calls
 * `start()`/`dispose()`.
 *
 * Continuation model
 * ------------------
 * - The reliable end-of-turn signal is a terminal `session.execution.*` event
 *   (`succeeded` | `failed` | `interrupted`); `session.idle` is not delivered
 *   to plugin subscribers in this platform build (observed across multiple
 *   runs).
 * - Exactly one continuation is injected per terminal event. Terminal events
 *   are deduped by event id, and any event that arrives while a continuation
 *   is still pending is ignored, so a replayed event or a second idle-style
 *   signal cannot double-fire.
 * - Continuations are attributed to the goal with prompt `metadata`
 *   (`goalContinuation` + `goalID`). That metadata is persisted on the user
 *   message, so attribution survives a reload and is visible when reading
 *   session history.
 * - User interrupt (`session.execution.interrupted`) never schedules a
 *   continuation. Pause/clear make the record non-active, which also stops it.
 */

import { formatGoal, formatGoalHistory, parseGoalCommand, resolveTaskRef, type GoalCommand } from "./command"
import { validateClearRequest, validateEvidence } from "./evidence"
import { resolveOptions, type Options } from "./options"
import { decidePermission } from "./permission"
import {
  archivedGoalKey,
  archivedPrefix,
  capSummary,
  createGoal,
  goalStorageKey,
  isCapReached,
  isTerminal,
  nextTaskID,
  normalizeGoal,
  type GoalCap,
  type GoalRecord,
  type GoalTaskStatus,
} from "./state"
import type {
  CommandInvocation,
  PermissionEvaluation,
  PluginContext,
  PluginEvent,
  SessionMessage,
  ToolContext,
} from "./types"

export const DEFAULT_CONTINUATION_PROMPT =
  "Continue working toward the active goal. Take the next concrete action using a tool. " +
  "End this turn by calling a tool: call goal_complete with concrete, independently checkable evidence when the " +
  "finish condition is met; call goal_block with a specific reason when you are genuinely stuck; otherwise use a " +
  "normal tool to make further progress. Do not reply with prose alone."

const BLOCKED_MARKER = /\bBLOCKED\b[:\-]?\s*(.*)/i

export class GoalController {
  private readonly ctx: PluginContext
  private readonly options: Options
  /** Called after every durable write so index.ts can emit an RPC event. */
  onChange: ((goal: GoalRecord) => void | Promise<void>) | undefined
  /** The inbox item that most recently started an execution, per session. */
  private readonly lastInbox = new Map<string, { inboxID?: string; type?: string; metadata?: Record<string, unknown> }>()
  /** Sessions with a continuation we injected but whose execution has not started yet. */
  private readonly continuationPending = new Set<string>()
  private readonly handledEventIDs = new Set<string>()
  /** Cache of whether a session belongs to this plugin instance's project. */
  private readonly ownership = new Map<string, boolean>()
  private disposed = false

  constructor(ctx: PluginContext, options?: Partial<Options>) {
    this.ctx = ctx
    this.options = { ...resolveOptions(ctx), ...options }
  }

  /** Register commands, tools, hooks, and the event subscription. */
  async start(): Promise<() => void> {
    await this.ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "Set, view, pause, resume, complete, block, or track tasks for the session goal loop",
        execute: async (input: CommandInvocation) => {
          await this.onCommand(input)
        },
      })
    })

    await this.ctx.tool.transform((editor) => {
      editor.add({
        name: "goal_set",
        description:
          "Set the active goal for this session and start the continuation loop. Use only when the user explicitly asks you to set a goal. Refuses while a non-terminal goal is active — finish it with goal_complete/goal_block first.",
        input: {
          type: "object",
          properties: {
            objective: { type: "string", description: "What must be true when the goal is done." },
            turns: { type: "number", description: "Optional continuation-turn cap (default: configured cap)." },
            tokens: { type: "number", description: "Optional token cap (default: configured cap)." },
            unbounded: { type: "boolean", description: "Opt out of caps entirely. Rarely right; prefer explicit caps." },
          },
          required: ["objective"],
          additionalProperties: false,
        },
        execute: async (input, context) => this.onGoalSet(input, context),
      })
      editor.add({
        name: "goal_complete",
        description:
          "Mark the active goal complete. Only call this when the goal's finish condition is verifiably met. Evidence must be concrete, independently checkable, and grounded in this session's observed work (file, test result, or command output, at least 24 chars).",
        input: {
          type: "object",
          properties: {
            evidence: {
              type: "string",
              description: "Concrete, independently checkable evidence that the goal is complete.",
            },
          },
          required: ["evidence"],
          additionalProperties: false,
        },
        execute: async (input, context) => this.onGoalComplete(input, context),
      })
      editor.add({
        name: "goal_block",
        description: "Report that the active goal is genuinely blocked and cannot proceed.",
        input: {
          type: "object",
          properties: {
            reason: { type: "string", description: "The specific blocker." },
          },
          required: ["reason"],
          additionalProperties: false,
        },
        execute: async (input, context) => this.onGoalBlock(input, context),
      })
      editor.add({
        name: "goal_clear",
        description:
          "Clear the session goal ONLY when the user has explicitly asked for it in this session. `request` must quote the user's own words; the quote is checked against the transcript and assistant text does not count. Never call on your own initiative — to exit a goal use goal_complete or goal_block.",
        input: {
          type: "object",
          properties: {
            request: { type: "string", description: "Verbatim quote of the user's message asking to clear the goal." },
          },
          required: ["request"],
          additionalProperties: false,
        },
        execute: async (input, context) => this.onGoalClear(input, context),
      })
      editor.add({
        name: "goal_history",
        description:
          "List archived outcomes of prior goals in this session (read-only). Consult before goal_set to avoid repeating finished work.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input: Record<string, unknown>, context: ToolContext) => {
          const history = await this.listHistory(context.sessionID)
          return { content: formatGoalHistory(history) }
        },
      })
      editor.add({
        name: "goal_add_task",
        description:
          "Add a task to the active goal's breakdown so the progress widget can track it. Keep titles short and concrete.",
        input: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short task title." },
          },
          required: ["title"],
          additionalProperties: false,
        },
        execute: async (input, context) => this.onGoalAddTask(input, context),
      })
      editor.add({
        name: "goal_update_task",
        description: "Update a task's status (todo, doing, done). Refer by 1-based number or task id.",
        input: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Task number (1-based) or id." },
            status: { type: "string", description: "todo, doing, or done." },
          },
          required: ["ref", "status"],
          additionalProperties: false,
        },
        execute: async (input, context) => this.onGoalUpdateTask(input, context),
      })
    })

    await this.ctx.session.hook("context", async (event) => {
      await this.injectObjective(event.sessionID, event)
    })

    // Unattended-goal permission sandbox: auto-allow in-scope path requests,
    // auto-deny out-of-scope ones. Never widens a deny. No-op when the
    // platform has no permission hook (older builds) or the session has no
    // active goal.
    try {
      await this.ctx.permission?.hook("evaluate", async (event) => {
        await this.onPermissionEvaluate(event)
      })
    } catch {
      // Permission hooks unavailable: unattended goals may still hang on
      // prompts; documented as a hazard, never a crash.
    }

    const abort = new AbortController()
    void (async () => {
      try {
        for await (const event of this.ctx.event.subscribe({ signal: abort.signal })) {
          if (this.disposed) break
          await this.onEvent(event)
        }
      } catch {
        // Stream closed or aborted: nothing to clean up.
      }
    })()

    return () => {
      this.disposed = true
      abort.abort()
    }
  }

  // ---- durable state ----------------------------------------------------

  private async load(sessionID: string): Promise<GoalRecord | undefined> {
    try {
      const value = await this.ctx.storage.get(goalStorageKey(sessionID))
      if (!value || typeof value !== "object") return undefined
      return normalizeGoal(value as GoalRecord)
    } catch {
      return undefined
    }
  }

  /** Best-effort append to the session's goal archive. */
  private async archive(goal: GoalRecord): Promise<void> {
    try {
      await this.ctx.storage.set(archivedGoalKey(goal.sessionID, goal.id), goal)
    } catch {
      // History is a bonus; never break the loop over an archive failure.
    }
  }

  /** Archived goals for a session, newest first. Empty when the host lacks scan. */
  private async listHistory(sessionID: string): Promise<GoalRecord[]> {
    if (!this.ctx.storage.scan) return []
    try {
      const page = await this.ctx.storage.scan({ prefix: archivedPrefix(sessionID), limit: 100 })
      const goals: GoalRecord[] = []
      for (const entry of page?.entries ?? []) {
        const value = entry.value as GoalRecord | undefined
        if (value && typeof value === "object" && typeof value.id === "string" && typeof value.status === "string") {
          goals.push(normalizeGoal(value))
        }
      }
      return goals.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    } catch {
      return []
    }
  }

  private async save(goal: GoalRecord): Promise<void> {
    goal.updatedAt = Date.now()
    if (!Array.isArray(goal.tasks)) goal.tasks = []
    try {
      await this.ctx.storage.set(goalStorageKey(goal.sessionID), goal)
    } catch {
      // Storage is the durability layer; a transient failure should not crash the loop.
    }
    // Durable history: archive every terminal snapshot. Re-archiving the same
    // goal id simply refreshes its record (latest outcome wins).
    if (isTerminal(goal.status)) {
      await this.archive(goal)
    }
    try {
      await this.onChange?.(goal)
    } catch {
      // RPC emit is best-effort; never break the loop.
    }
  }

  /** Read-only snapshot for the RPC / widget layer. */
  async snapshot(sessionID: string): Promise<GoalRecord | undefined> {
    return this.load(sessionID)
  }

  // ---- command surface --------------------------------------------------

  async onCommand(input: CommandInvocation): Promise<void> {
    const sessionID = input.sessionID
    const command = parseGoalCommand(input.prompt?.text ?? "")
    await this.executeCommand(sessionID, command)
  }

  private async executeCommand(sessionID: string, command: GoalCommand): Promise<void> {
    const goal = await this.load(sessionID)
    switch (command.kind) {
      case "view":
        await this.notify(sessionID, formatGoal(goal, sessionID))
        return
      case "set": {
        if (!command.objective) {
          await this.notify(sessionID, "Nothing to do: provide an objective, e.g. `/goal set <objective>`.")
          return
        }
        const cap = this.effectiveCap(command)
        // Superseded-but-never-terminal goals would otherwise be overwritten
        // without a trace; archive them so history stays honest.
        if (goal && !isTerminal(goal.status)) {
          await this.archive(goal)
        }
        const created = createGoal({ sessionID, objective: command.objective, cap })
        await this.save(created)
        await this.injectContinuation(created)
        return
      }
      case "history": {
        const history = await this.listHistory(sessionID)
        await this.notify(sessionID, formatGoalHistory(history))
        return
      }
      case "pause": {
        if (!goal) {
          await this.notify(sessionID, "No goal to pause.")
          return
        }
        goal.status = "paused"
        await this.save(goal)
        await this.notify(sessionID, `Goal ${goal.id} paused. Continuation is halted until /goal resume.`)
        return
      }
      case "resume": {
        if (!goal) {
          await this.notify(sessionID, "No goal to resume.")
          return
        }
        goal.status = "active"
        goal.stalls = 0
        goal.outcome = undefined
        goal.lastHandledEventID = undefined
        await this.save(goal)
        await this.notify(sessionID, `Goal ${goal.id} resumed.`)
        await this.injectContinuation(goal)
        return
      }
      case "clear": {
        if (!goal) {
          await this.notify(sessionID, "No goal to clear.")
          return
        }
        try {
          await this.ctx.storage.remove(goalStorageKey(sessionID))
        } catch {
          // Fall through to a cleared record if removal fails.
        }
        goal.status = "cleared"
        await this.save(goal)
        await this.notify(sessionID, `Goal ${goal.id} cleared. Continuation is halted.`)
        return
      }
      case "complete": {
        if (!goal) {
          await this.notify(sessionID, "No goal to complete.")
          return
        }
        if (goal.status !== "active") {
          await this.notify(sessionID, `Completion rejected: goal ${goal.id} is ${goal.status}, not active. /goal resume to continue it, or /goal set a new one.`)
          return
        }
        const evidence = command.evidence.trim()
        if (!evidence) {
          await this.notify(sessionID, "Completion rejected: evidence is required, e.g. `/goal complete tests: 42/42 pass in build/log.txt`.")
          return
        }
        const transcript = await this.transcriptForEvidence(sessionID)
        const rejection = validateEvidence(evidence, transcript)
        if (rejection) {
          await this.notify(sessionID, `Completion rejected: ${rejection}`)
          return
        }
        goal.status = "completed"
        goal.outcome = "completed"
        goal.evidence = evidence
        await this.save(goal)
        await this.notify(sessionID, `Goal ${goal.id} completed. Evidence: ${evidence}`)
        return
      }
      case "block": {
        if (!goal) {
          await this.notify(sessionID, "No goal to block.")
          return
        }
        if (goal.status !== "active") {
          await this.notify(sessionID, `Block rejected: goal ${goal.id} is ${goal.status}, not active.`)
          return
        }
        const reason = command.reason.trim()
        if (!reason) {
          await this.notify(sessionID, "Block rejected: a specific reason is required, e.g. `/goal block Waiting on staging credentials`.")
          return
        }
        goal.status = "blocked"
        goal.outcome = "blocked"
        goal.blocker = reason
        await this.save(goal)
        await this.notify(sessionID, `Goal ${goal.id} reported blocked: ${reason}`)
        return
      }
      case "taskAdd": {
        if (!goal || goal.status === "cleared") {
          await this.notify(sessionID, "No goal to add a task to.")
          return
        }
        const title = command.title.trim()
        if (!title) {
          await this.notify(sessionID, "Nothing to add: provide a title, e.g. `/goal task add Write tests`.")
          return
        }
        const task = this.addTask(goal, title)
        await this.save(goal)
        await this.notify(sessionID, `Task ${goal.tasks.length} added: ${task.title}`)
        return
      }
      case "taskUpdate": {
        if (!goal || goal.status === "cleared") {
          await this.notify(sessionID, "No goal to update.")
          return
        }
        const index = resolveTaskRef(goal.tasks, command.ref)
        if (index < 0) {
          await this.notify(sessionID, `No such task: ${command.ref || "(empty)"}. See /goal view for numbers.`)
          return
        }
        goal.tasks[index]!.status = command.status
        goal.tasks[index]!.updatedAt = Date.now()
        await this.save(goal)
        await this.notify(sessionID, `Task ${index + 1} marked ${command.status}: ${goal.tasks[index]!.title}`)
        return
      }
      case "taskList":
        await this.notify(sessionID, formatGoal(goal, sessionID))
        return
    }
  }

  // ---- model-callable tools --------------------------------------------

  async onGoalComplete(input: Record<string, unknown>, context: ToolContext): Promise<{ content: string }> {
    const goal = await this.load(context.sessionID)
    if (!goal) {
      return { content: "No goal to complete." }
    }
    if (goal.status !== "active") {
      return { content: `Goal NOT completed: ${goal.id} is ${goal.status}, not active. Nothing to finish — resume it or set a new goal.` }
    }
    const evidence = String(input?.evidence ?? "").trim()
    if (!evidence) {
      return {
        content:
          "Goal NOT completed: `evidence` is required and must describe something checkable. The goal remains active.",
      }
    }
    const transcript = await this.transcriptForEvidence(context.sessionID)
    const rejection = validateEvidence(evidence, transcript)
    if (rejection) return { content: rejection }
    goal.status = "completed"
    goal.outcome = "completed"
    goal.evidence = evidence
    await this.save(goal)
    return { content: `Goal ${goal.id} completed. Evidence recorded.` }
  }

  async onGoalSet(input: Record<string, unknown>, context: ToolContext): Promise<{ content: string }> {
    const objective = String(input?.objective ?? "").trim()
    if (!objective) return { content: "Goal NOT set: an `objective` is required." }
    const existing = await this.load(context.sessionID)
    if (existing && !isTerminal(existing.status)) {
      return {
        content: `Goal NOT set: ${existing.id} is still ${existing.status}. Finish it (goal_complete/goal_block) or ask the user to run /goal clear first.`,
      }
    }
    const turns = typeof input?.turns === "number" ? Math.max(1, Math.floor(input.turns)) : undefined
    const tokens = typeof input?.tokens === "number" ? Math.max(1, Math.floor(input.tokens)) : undefined
    const cap = this.effectiveCap({ kind: "set", objective, cap: { turns, tokens }, unbounded: input?.unbounded === true })
    const created = createGoal({ sessionID: context.sessionID, objective, cap })
    await this.save(created)
    await this.injectContinuation(created)
    return { content: `Goal ${created.id} set: ${created.objective} (cap: ${capSummary(created.cap)}).` }
  }

  async onGoalBlock(input: Record<string, unknown>, context: ToolContext): Promise<{ content: string }> {
    const goal = await this.load(context.sessionID)
    if (!goal) {
      return { content: "No goal to block." }
    }
    if (goal.status !== "active") {
      return { content: `Goal NOT blocked: ${goal.id} is ${goal.status}, not active.` }
    }
    const reason = String(input?.reason ?? "").trim()
    if (!reason) {
      return { content: "Goal NOT blocked: a specific `reason` is required. The goal remains active." }
    }
    goal.status = "blocked"
    goal.outcome = "blocked"
    goal.blocker = reason
    await this.save(goal)
    return { content: `Goal ${goal.id} marked blocked: ${reason}` }
  }

  async onGoalClear(input: Record<string, unknown>, context: ToolContext): Promise<{ content: string }> {
    const goal = await this.load(context.sessionID)
    if (!goal) return { content: "No goal to clear." }
    const transcript = await this.transcriptForEvidence(context.sessionID)
    const rejection = validateClearRequest(String(input?.request ?? ""), transcript)
    if (rejection) return { content: rejection }
    const request = String(input?.request ?? "").trim()
    await this.executeCommand(context.sessionID, { kind: "clear" })
    return { content: `Goal ${goal.id} cleared per user request: "${request}". Continuation is halted.` }
  }

  private addTask(goal: GoalRecord, title: string): { id: string; title: string } {
    const now = Date.now()
    const task = { id: nextTaskID(now), title: title.slice(0, 200), status: "todo" as GoalTaskStatus, createdAt: now, updatedAt: now }
    goal.tasks.push(task)
    return task
  }

  async onGoalAddTask(input: Record<string, unknown>, context: ToolContext): Promise<{ content: string }> {
    const title = String(input?.title ?? "").trim()
    if (!title) return { content: "Task NOT added: a `title` is required." }
    const goal = await this.load(context.sessionID)
    if (!goal || goal.status !== "active") return { content: "No active goal to add a task to." }
    if (goal.tasks.length >= 50) return { content: "Task NOT added: task limit (50) reached." }
    const task = this.addTask(goal, title)
    await this.save(goal)
    return { content: `Task ${goal.tasks.length} added (${task.id}): ${task.title}` }
  }

  async onGoalUpdateTask(input: Record<string, unknown>, context: ToolContext): Promise<{ content: string }> {
    const ref = String(input?.ref ?? input?.id ?? input?.taskId ?? "").trim()
    const rawStatus = String(input?.status ?? "").trim().toLowerCase()
    if (rawStatus !== "todo" && rawStatus !== "doing" && rawStatus !== "done") {
      return { content: "Task NOT updated: `status` must be todo, doing, or done." }
    }
    const goal = await this.load(context.sessionID)
    if (!goal || goal.status !== "active") return { content: "No active goal to update." }
    const index = resolveTaskRef(goal.tasks, ref)
    if (index < 0) return { content: `Task NOT updated: no such task ${ref || "(empty)"}.` }
    goal.tasks[index]!.status = rawStatus as GoalTaskStatus
    goal.tasks[index]!.updatedAt = Date.now()
    await this.save(goal)
    return { content: `Task ${index + 1} marked ${rawStatus}: ${goal.tasks[index]!.title}` }
  }

  // ---- context hook -----------------------------------------------------

  async injectObjective(sessionID: string, event: { system: Array<{ type: string; text: string }> }): Promise<void> {
    const goal = await this.load(sessionID)
    if (!goal) return
    if (goal.status !== "active" && goal.status !== "paused") return
    event.system.push({ type: "text", text: this.objectiveBlock(goal) })
  }

  private objectiveBlock(goal: GoalRecord): string {
    const capText = typeof goal.cap.turns === "number" ? ` / ${goal.cap.turns}` : " (unbounded — explicit opt-in)"
    const lines = [
      `[GOAL ${goal.id} — ${goal.status.toUpperCase()}]`,
      `Objective: ${goal.objective}`,
      `Continuation turns used: ${goal.used.turns}${capText}.`,
      "Work autonomously toward this objective. Prefer concrete actions over narration.",
      "Keep the task breakdown current: call goal_add_task(title) to plan, goal_update_task(ref, status) with todo/doing/done as work progresses.",
      "Prior goals in this session are archived: call goal_history() to review their outcomes before starting new work.",
      "Call goal_complete(evidence) only when the finish condition is verifiably met; the evidence must be concrete, independently checkable, and grounded in this session's observed work (file path, test result, or command output, at least 24 chars). Weak or generic evidence will be rejected and the goal will stay active.",
      "Call goal_block(reason) if you cannot proceed, including when a file or directory you need is outside the session working directory and access is denied.",
      "Stay inside the session working directory. Requests outside it are denied automatically.",
    ]
    return lines.join("\n")
  }

  // ---- caps ---------------------------------------------------------------

  private effectiveCap(command: Extract<GoalCommand, { kind: "set" }>): GoalCap {
    if (command.unbounded) return {}
    const cap: GoalCap = { ...command.cap }
    if (typeof cap.turns !== "number") cap.turns = this.options.defaultCapTurns
    if (typeof cap.tokens !== "number") cap.tokens = this.options.defaultCapTokens
    return cap
  }

  private async transcriptForEvidence(
    sessionID: string,
  ): Promise<readonly { text?: string; content?: readonly { text?: string }[] }[]> {
    try {
      return await this.ctx.session.context({ sessionID })
    } catch {
      return []
    }
  }

  // ---- permission sandbox ---------------------------------------------------

  async onPermissionEvaluate(event: PermissionEvaluation): Promise<void> {
    // Never widen a deny. The platform does not invoke this hook for
    // configured denies; this guard is defense-in-depth.
    if (event.effect === "deny") return
    const sessionID = event.sessionID
    if (!sessionID) return
    // Only the owning instance decides; otherwise N locations would each
    // rewrite the same evaluation.
    if (!(await this.ownsSession(sessionID))) return
    const goal = await this.load(sessionID)
    if (!goal || goal.status !== "active") return
    const directory = await this.sessionDirectory(sessionID)
    const decision = decidePermission(event.resources ?? [], directory, event.effect)
    if (decision.effect === "leave") return
    if (decision.effect === "allow") {
      event.effect = "allow"
      return
    }
    event.effect = "deny"
    event.message = decision.message
  }

  private async sessionDirectory(sessionID: string): Promise<string | undefined> {
    try {
      const info = await this.ctx.session.get({ sessionID })
      const dir = info?.location?.directory
      if (typeof dir === "string" && dir.length > 0) return dir
    } catch {
      // Fall through to the instance directory.
    }
    return this.ctx.location?.directory
  }

  // ---- event handling ---------------------------------------------------

  /**
   * Whether a session belongs to this plugin instance's project.
   *
   * Streams are global; plugin instances are per-location. Matching on project
   * keeps exactly one instance responsible for a session's goal loop.
   */
  private async ownsSession(sessionID: string): Promise<boolean> {
    const cached = this.ownership.get(sessionID)
    if (cached !== undefined) return cached
    let owned = true
    try {
      const info = await this.ctx.session.get({ sessionID })
      const ourProject = this.ctx.location?.project?.id
      const ourDirectory = this.ctx.location?.directory
      if (info && ourProject && info.projectID) {
        owned = info.projectID === ourProject
      } else if (info?.location?.directory && ourDirectory) {
        owned = info.location.directory === ourDirectory
      }
    } catch {
      // If ownership cannot be resolved, prefer acting over silently dropping.
      owned = true
    }
    this.ownership.set(sessionID, owned)
    return owned
  }

  async onEvent(event: PluginEvent): Promise<void> {
    const type = event.type
    if (!type) return
    const data = (event.data ?? {}) as Record<string, unknown>
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID) return
    // `setup()` runs once per loaded location, and every instance receives the
    // global event stream. Only act on sessions owned by this instance's
    // project, or every instance would inject the same continuation.
    if (!(await this.ownsSession(sessionID))) return

    if (type === "session.inbox.enqueued") {
      this.recordInbox(sessionID, data)
      return
    }
    if (type === "session.execution.started") {
      this.continuationPending.delete(sessionID)
      return
    }
    if (type === "session.usage.updated") {
      await this.recordUsage(sessionID, data)
      return
    }
    if (
      type === "session.execution.succeeded" ||
      type === "session.execution.failed" ||
      type === "session.execution.interrupted"
    ) {
      await this.onTerminal(sessionID, type, event.id)
    }
  }

  private recordInbox(sessionID: string, data: Record<string, unknown>): void {
    const item = data.item as { type?: string; payload?: { text?: string; metadata?: Record<string, unknown> } } | undefined
    this.lastInbox.set(sessionID, {
      inboxID: typeof data.inboxID === "string" ? data.inboxID : undefined,
      type: item?.type,
      metadata: item?.payload?.metadata,
    })
  }

  private async recordUsage(sessionID: string, data: Record<string, unknown>): Promise<void> {
    const tokens = data.tokens as { input?: number; output?: number; reasoning?: number } | undefined
    if (!tokens) return
    const total = (tokens.input ?? 0) + (tokens.output ?? 0)
    const goal = await this.load(sessionID)
    if (!goal || goal.status !== "active") return
    // `session.usage.updated` reports cumulative session totals, so assign.
    goal.used.tokens = total
    await this.save(goal)
  }

  private async onTerminal(sessionID: string, type: string, eventID: string | undefined): Promise<void> {
    const goal = await this.load(sessionID)
    if (!goal || goal.status !== "active") return

    if (eventID) {
      if (this.handledEventIDs.has(eventID) || goal.lastHandledEventID === eventID) return
      this.handledEventIDs.add(eventID)
      if (this.handledEventIDs.size > 200) {
        const first = this.handledEventIDs.values().next().value
        if (first) this.handledEventIDs.delete(first)
      }
    }

    // Any terminal event for an execution that started from a continuation we
    // already scheduled is a duplicate idle boundary; ignore it.
    if (this.continuationPending.has(sessionID)) {
      this.continuationPending.delete(sessionID)
      return
    }

    // A user interrupt must never schedule a continuation.
    if (type === "session.execution.interrupted") {
      goal.lastHandledEventID = eventID
      await this.save(goal)
      return
    }

    const trigger = this.lastInbox.get(sessionID)
    const isContinuation = trigger?.metadata?.goalContinuation === true && trigger.metadata.goalID === goal.id
    if (trigger?.metadata?.goalControl === true) {
      // A status/control notice we generated; never continue off it.
      goal.lastHandledEventID = eventID
      await this.save(goal)
      return
    }

    const madeToolCall = await this.executionMadeToolCall(sessionID)
    if (isContinuation && !madeToolCall) {
      goal.stalls += 1
      if (goal.stalls >= this.options.stallLimit) {
        const blocker = await this.lastAssistantBlock(goal, sessionID)
        goal.status = blocker ? "blocked" : "stalled"
        goal.outcome = blocker ? "blocked" : "stalled"
        if (blocker) goal.blocker = blocker
        goal.lastHandledEventID = eventID
        await this.save(goal)
        await this.notify(
          sessionID,
          blocker
            ? `Goal ${goal.id} blocked: ${blocker}`
            : `Goal ${goal.id} stalled: the last continuation made no tool call. /goal resume to retry.`,
        )
        return
      }
    } else if (madeToolCall) {
      goal.stalls = 0
    } else {
      // A user turn with no tool call still resets nothing but is not a stall.
      goal.stalls = 0
    }

    if (isCapReached(goal)) {
      goal.status = "budget_limited"
      goal.outcome = "budget_limited"
      goal.lastHandledEventID = eventID
      await this.save(goal)
      await this.notify(
        sessionID,
        `Goal ${goal.id} stopped at its budget cap (${capSummary(goal.cap)}). This is not completion. /goal resume to continue or /goal clear to remove.`,
      )
      return
    }

    goal.lastHandledEventID = eventID
    await this.save(goal)
    await this.injectContinuation(goal)
  }

  private async executionMadeToolCall(sessionID: string): Promise<boolean> {
    const tail = await this.executionTail(sessionID)
    for (const message of tail) {
      if (message.type !== "assistant") continue
      for (const part of message.content ?? []) {
        if (part.type === "tool") return true
      }
    }
    return false
  }

  private async lastAssistantBlock(goal: GoalRecord, sessionID: string): Promise<string | undefined> {
    void goal
    const tail = await this.executionTail(sessionID)
    let text = ""
    for (const message of tail) {
      if (message.type !== "assistant") continue
      for (const part of message.content ?? []) {
        if (part.type === "text" && part.text) text += `${part.text}\n`
      }
      if (message.text) text += `${message.text}\n`
    }
    const match = BLOCKED_MARKER.exec(text)
    return match?.[1]?.trim() || (match ? "model reported blocked" : undefined)
  }

  private async executionTail(sessionID: string): Promise<readonly SessionMessage[]> {
    let messages: readonly SessionMessage[] = []
    try {
      messages = await this.ctx.session.context({ sessionID })
    } catch {
      return []
    }
    let start = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const type = messages[i]?.type
      if (type === "user" || type === "synthetic") {
        start = i
        break
      }
    }
    return start >= 0 ? messages.slice(start + 1) : messages
  }

  // ---- continuation + notices ------------------------------------------

  private async injectContinuation(goal: GoalRecord): Promise<void> {
    if (goal.status !== "active") return
    goal.continuations += 1
    goal.used.turns += 1
    await this.save(goal)
    this.continuationPending.add(goal.sessionID)
    const text = this.options.continuationText ?? DEFAULT_CONTINUATION_PROMPT
    try {
      await this.ctx.session.prompt({
        sessionID: goal.sessionID,
        text,
        metadata: { goalContinuation: true, goalID: goal.id, goalTurn: goal.used.turns },
        delivery: "queue",
        resume: true,
      })
    } catch {
      this.continuationPending.delete(goal.sessionID)
    }
  }

  private async notify(sessionID: string, text: string): Promise<void> {
    try {
      await this.ctx.session.synthetic({
        sessionID,
        text,
        description: "goal",
        metadata: { goalControl: true },
      })
    } catch {
      // Notices are best-effort; never let one break the loop.
    }
  }
}
