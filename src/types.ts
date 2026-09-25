/**
 * Structural types for the slice of the OpenCode v2 plugin context this spike
 * uses.
 *
 * These are declared structurally rather than imported from `@opencode/plugin`
 * for the same reason the litellm plugin does it: a local (directory) install
 * cannot resolve that module at runtime, and the real types are versioned with
 * the OpenCode release. Type-only imports are used in tests and for
 * documentation, never in the runtime entry.
 */

export type PluginEvent = {
  id?: string
  type?: string
  created?: number
  data?: Record<string, unknown>
  /** Durable events carry a per-aggregate sequence. */
  durable?: { aggregateID?: string; seq?: number; version?: number }
}

export type SessionMessageContent = {
  type?: string
  text?: string
  name?: string
  executed?: boolean
  state?: { status?: string }
}

export type SessionMessage = {
  id?: string
  type?: string
  text?: string
  metadata?: Record<string, unknown>
  content?: readonly SessionMessageContent[]
  finish?: string
  outcome?: string
}

export type SessionInfo = {
  id?: string
  projectID?: string
  location?: { directory?: string }
  tokens?: { input?: number; output?: number; reasoning?: number }
}

export type PromptInput = {
  sessionID: string
  text: string
  metadata?: Record<string, unknown>
  delivery?: "steer" | "queue"
  resume?: boolean
}

export type SyntheticInput = {
  sessionID: string
  text: string
  description?: string
  metadata?: Record<string, unknown>
}

export type SessionContextHookEvent = {
  readonly sessionID: string
  system: Array<{ type: string; text: string; [key: string]: unknown }>
  tools: Record<string, { description: string; input: unknown }>
  options: Record<string, unknown>
}

export type CommandInvocation = {
  readonly sessionID: string
  readonly prompt: { text?: string; [key: string]: unknown }
  readonly delivery: "steer" | "queue"
}

export type CommandEditor = {
  add(definition: {
    name: string
    description?: string
    execute: (input: CommandInvocation) => Promise<void>
  }): void
}

export type ToolResult = {
  content?: string
  metadata?: Record<string, unknown>
}

export type ToolContext = {
  readonly sessionID: string
  readonly agent?: string
  readonly messageID?: string
  readonly signal?: AbortSignal
  progress?: (update: Record<string, unknown>) => Promise<void>
}

export type ToolDefinition = {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

export type ToolEditor = {
  add(definition: ToolDefinition): void
}

export type Registration = {
  dispose(): Promise<void>
}

export type PermissionEvaluation = {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  readonly metadata?: Record<string, unknown>
  readonly source?: { type: string; messageID?: string; id?: string }
  effect: "allow" | "ask" | "deny"
  message?: string
}

export type PluginContext = {
  options?: Record<string, unknown>
  location?: { directory?: string; project?: { id?: string } }
  rpc?: {
    register(
      definition: unknown,
      handlers: Record<string, (input: never, context: never) => Promise<unknown>>,
    ): Promise<{ events: { emit(event: string, data: unknown): Promise<void> } }>
  }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
    scan?(options: { prefix: string; after?: string; limit?: number }): Promise<{
      entries: readonly { key: string; value: unknown }[]
      next?: string
    }>
  }
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<PluginEvent>
  }
  permission?: {
    hook(name: "evaluate", callback: (event: PermissionEvaluation) => Promise<void> | void): Promise<Registration>
  }
  session: {
    hook(
      name: "context",
      callback: (event: SessionContextHookEvent) => Promise<void> | void,
      options?: { providerID?: string },
    ): Promise<Registration>
    prompt(input: PromptInput): Promise<unknown>
    synthetic(input: SyntheticInput): Promise<unknown>
    context(input: { sessionID: string }): Promise<readonly SessionMessage[]>
    get(input: { sessionID: string }): Promise<SessionInfo | undefined>
    interrupt?(input: { sessionID: string; continue?: boolean }): Promise<unknown>
  }
  command: {
    transform(callback: (editor: CommandEditor) => void): Promise<Registration>
  }
  tool: {
    transform(callback: (editor: ToolEditor) => void): Promise<Registration>
  }
}
