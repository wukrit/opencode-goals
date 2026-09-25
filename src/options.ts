import type { PluginContext } from "./types"

export type Options = {
  /** Consecutive tool-less continuation turns tolerated before the goal stalls. */
  stallLimit: number
  /** Extra text appended to the injected continuation prompt. */
  continuationText: string | undefined
  /** Default turn cap applied when `/goal set` gives no explicit cap. */
  defaultCapTurns: number
  /** Default token cap applied when `/goal set` gives no explicit cap. */
  defaultCapTokens: number
}

export const DEFAULT_OPTIONS: Options = {
  stallLimit: 1,
  continuationText: undefined,
  defaultCapTurns: 10,
  defaultCapTokens: 100_000,
}

export function resolveOptions(ctx: PluginContext): Options {
  const provided = (ctx.options ?? {}) as Partial<Options>
  const stallLimit = typeof provided.stallLimit === "number" && provided.stallLimit >= 0 ? provided.stallLimit : DEFAULT_OPTIONS.stallLimit
  const continuationText = typeof provided.continuationText === "string" ? provided.continuationText : undefined
  const defaultCapTurns =
    typeof provided.defaultCapTurns === "number" && provided.defaultCapTurns > 0
      ? Math.floor(provided.defaultCapTurns)
      : DEFAULT_OPTIONS.defaultCapTurns
  const defaultCapTokens =
    typeof provided.defaultCapTokens === "number" && provided.defaultCapTokens > 0
      ? Math.floor(provided.defaultCapTokens)
      : DEFAULT_OPTIONS.defaultCapTokens
  return { stallLimit, continuationText, defaultCapTurns, defaultCapTokens }
}
