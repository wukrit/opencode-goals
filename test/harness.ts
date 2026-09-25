/**
 * Test harness: a mocked OpenCode plugin context plus a deterministic event bus.
 *
 * The plugin is driven through its real `setup()`; tests register a controller
 * exactly as OpenCode would, then invoke the captured command/tool/hook
 * definitions and push events. `emit()` resolves only after the consumer has
 * finished handling the pushed event (the async iterator is pulled again), so
 * assertions never race the loop.
 */

import plugin from "../index"
import type { GoalRecord } from "../src/state"
import type {
  CommandInvocation,
  PluginContext,
  PluginEvent,
  SessionContextHookEvent,
  SessionMessage,
  ToolContext,
  ToolDefinition,
} from "../src/types"

type Deferred = { promise: Promise<void>; resolve: () => void }

type CommandAdd = (def: { name: string; execute: (i: CommandInvocation) => Promise<void> }) => void
type CommandEditorLike = { add: CommandAdd }
type ToolEditorLike = { add: (def: ToolDefinition) => void }

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

export class EventBus {
  private queue: Array<{ event: PluginEvent; done: Deferred }> = []
  private waiter: (() => void) | null = null
  private last: Deferred | null = null

  push(event: PluginEvent): Promise<void> {
    const done = deferred()
    this.queue.push({ event, done })
    this.waiter?.()
    this.waiter = null
    return done.promise
  }

  subscribe(): AsyncIterable<PluginEvent> {
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const item = await self.dequeue()
          yield item
          // The for-await body has now completed; mark the item consumed.
          self.resolveLast()
        }
      },
    }
  }

  private resolveLast(): void {
    this.last?.resolve()
    this.last = null
  }

  private async dequeue(): Promise<PluginEvent> {
    this.resolveLast()
    while (this.queue.length === 0) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
    const next = this.queue.shift()!
    this.last = next.done
    return next.event
  }
}

export class MockContext {
  options: Record<string, unknown>
  readonly projectID: string
  location: { directory: string; project: { id: string } }
  private readonly sessionProjects: Map<string, string>

  readonly store: Map<string, unknown>
  readonly bus = new EventBus()

  readonly prompts: Array<{ sessionID: string; text: string; metadata?: Record<string, unknown>; delivery?: string }> = []
  readonly notices: Array<{ sessionID: string; text: string; metadata?: Record<string, unknown> }> = []

  private readonly commandDefs = new Map<string, (input: CommandInvocation) => Promise<void>>()
  private readonly toolDefs = new Map<string, ToolDefinition>()
  private contextHook: ((event: SessionContextHookEvent) => Promise<void> | void) | null = null
  private messages = new Map<string, SessionMessage[]>()

  storage = {
    get: async (key: string): Promise<unknown> => this.store.get(key),
    set: async (key: string, value: unknown): Promise<void> => {
      this.store.set(key, JSON.parse(JSON.stringify(value)))
    },
    remove: async (key: string): Promise<void> => {
      this.store.delete(key)
    },
    scan: async (options: { prefix: string; limit?: number }) => {
      const entries = [...this.store.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .map(([key, value]) => ({ key, value }))
      return { entries }
    },
  }

  event = {
    subscribe: (): AsyncIterable<PluginEvent> => this.bus.subscribe(),
  }

  session = {
    hook: async (
      _name: "context",
      callback: (event: SessionContextHookEvent) => Promise<void> | void,
    ): Promise<{ dispose(): Promise<void> }> => {
      this.contextHook = callback
      return { dispose: async () => {} }
    },
    prompt: async (input: { sessionID: string; text: string; metadata?: Record<string, unknown>; delivery?: string }): Promise<unknown> => {
      this.prompts.push({ ...input })
      return { id: `msg_plug_${this.prompts.length}` }
    },
    synthetic: async (input: { sessionID: string; text: string; metadata?: Record<string, unknown> }): Promise<unknown> => {
      this.notices.push({ ...input })
      return { id: `msg_notice_${this.notices.length}` }
    },
    context: async (input: { sessionID: string }): Promise<readonly SessionMessage[]> => {
      return this.messages.get(input.sessionID) ?? []
    },
    get: async (input: { sessionID: string }): Promise<{ projectID: string; location: { directory: string } }> => ({
      projectID: this.sessionProjects.get(input.sessionID) ?? this.projectID,
      location: { directory: this.sessionDirectory.get(input.sessionID) ?? this.location.directory },
    }),
  }

  permission: {
    hook: (name: string, callback: (event: Record<string, unknown>) => Promise<void> | void) => Promise<{ dispose(): Promise<void> }>
  } = {
    hook: async (name: string, callback: (event: Record<string, unknown>) => Promise<void> | void) => {
      if (name === "evaluate") this.permissionHook = callback as MockContext["permissionHook"]
      return { dispose: async () => {} }
    },
  }

  permissionHook: ((event: {
    sessionID: string
    action: string
    resources: string[]
    effect: "allow" | "ask" | "deny"
    message?: string
  }) => Promise<void> | void) | null = null

  rpcHandlers: Record<string, (input: never, context: never) => Promise<unknown>> | null = null
  readonly rpcEvents: Array<{ event: string; data: unknown }> = []

  rpc = {
    register: async (
      _definition: unknown,
      handlers: Record<string, (input: never, context: never) => Promise<unknown>>,
    ): Promise<{ events: { emit(event: string, data: unknown): Promise<void> } }> => {
      this.rpcHandlers = handlers
      return {
        events: {
          emit: async (event: string, data: unknown): Promise<void> => {
            this.rpcEvents.push({ event, data })
          },
        },
      }
    },
  }

  private readonly sessionDirectory = new Map<string, string>()

  command = {
    transform: async (callback: (editor: CommandEditorLike) => void): Promise<{ dispose(): Promise<void> }> => {
      const editor: CommandEditorLike = {
        add: (definition) => {
          this.commandDefs.set(definition.name, definition.execute)
        },
      }
      callback(editor)
      return { dispose: async () => {} }
    },
  }

  tool = {
    transform: async (callback: (editor: ToolEditorLike) => void): Promise<{ dispose(): Promise<void> }> => {
      const editor: ToolEditorLike = {
        add: (definition) => {
          this.toolDefs.set(definition.name, definition)
        },
      }
      callback(editor)
      return { dispose: async () => {} }
    },
  }

  constructor(
    options: Record<string, unknown> = {},
    store?: Map<string, unknown>,
    sessionProjects?: Map<string, string>,
  ) {
    this.options = options
    this.store = store ?? new Map()
    this.projectID = typeof options.projectID === "string" ? options.projectID : "test-project"
    this.location = { directory: "/tmp/goals-test", project: { id: this.projectID } }
    this.sessionProjects = sessionProjects ?? new Map()
  }

  setSessionDirectory(sessionID: string, directory: string): void {
    this.sessionDirectory.set(sessionID, directory)
  }

  async evaluatePermission(input: {
    sessionID: string
    action: string
    resources: string[]
    effect: "allow" | "ask" | "deny"
  }): Promise<{ effect: "allow" | "ask" | "deny"; message?: string }> {
    if (!this.permissionHook) throw new Error("permission hook was not registered")
    const event = { ...input }
    await this.permissionHook(event)
    return event
  }

  // ---- test API ---------------------------------------------------------

  async start(): Promise<() => void> {
    return plugin.setup(this as unknown as PluginContext)
  }

  async runGoal(sessionID: string, args: string): Promise<void> {
    const execute = this.commandDefs.get("goal")
    if (!execute) throw new Error("goal command was not registered")
    await execute({ sessionID, prompt: { text: args }, delivery: "steer" })
  }

  async callTool(sessionID: string, name: string, input: Record<string, unknown>): Promise<{ content?: string }> {
    const definition = this.toolDefs.get(name)
    if (!definition) throw new Error(`tool ${name} was not registered`)
    const context: ToolContext = { sessionID }
    return definition.execute(input, context)
  }

  async systemFor(sessionID: string): Promise<string> {
    if (!this.contextHook) throw new Error("context hook was not registered")
    const event = { sessionID, system: [] as Array<{ type: string; text: string }>, tools: {}, options: {} }
    await this.contextHook(event)
    return event.system.map((part) => part.text).join("\n")
  }

  setMessages(sessionID: string, messages: SessionMessage[]): void {
    this.messages.set(sessionID, messages)
  }

  goal(sessionID: string): GoalRecord | undefined {
    return this.store.get(`goal/${sessionID}`) as GoalRecord | undefined
  }

  emit(event: PluginEvent): Promise<void> {
    return this.bus.push(event)
  }

  promptsFor(sessionID: string): typeof this.prompts {
    return this.prompts.filter((p) => p.sessionID === sessionID)
  }
}

/** A continuation prompt as OpenCode would persist it (user message w/ metadata). */
export function userMessage(id: string, metadata?: Record<string, unknown>): SessionMessage {
  return { id, type: "user", text: "prompt", metadata }
}

export function assistantWithTool(id: string, name = "shell"): SessionMessage {
  return { id, type: "assistant", content: [{ type: "tool", name, executed: true }] }
}

export function assistantText(id: string, text: string): SessionMessage {
  return { id, type: "assistant", content: [{ type: "text", text }] }
}

export function idleMessage(id: string, outcome = "succeeded"): SessionMessage {
  return { id, type: "idle", outcome }
}
