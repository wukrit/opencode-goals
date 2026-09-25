/**
 * RPC surface for the live progress widget.
 *
 * Defined without importing `@opencode/plugin` so the server entry (local
 * directory install) stays import-free. The shape matches
 * `Rpc.PortableDefinition` and can be passed straight to `ctx.rpc.register`
 * on the server and `client.rpc(...)` in the TUI.
 */

import type { GoalRecord } from "./state"

export type GoalSnapshot = Pick<
  GoalRecord,
  "id" | "sessionID" | "objective" | "status" | "cap" | "used" | "stalls" | "continuations" | "tasks" | "evidence" | "blocker" | "outcome" | "updatedAt"
>

export function toSnapshot(goal: GoalRecord): GoalSnapshot {
  const snapshot: GoalSnapshot = {
    id: goal.id,
    sessionID: goal.sessionID,
    objective: goal.objective,
    status: goal.status,
    cap: goal.cap,
    used: goal.used,
    stalls: goal.stalls,
    continuations: goal.continuations,
    tasks: goal.tasks ?? [],
    updatedAt: goal.updatedAt,
  } as GoalSnapshot
  if (goal.evidence !== undefined) snapshot.evidence = goal.evidence
  if (goal.blocker !== undefined) snapshot.blocker = goal.blocker
  if (goal.outcome !== undefined) snapshot.outcome = goal.outcome
  return snapshot
}

const sessionIDSchema = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const snapshotSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sessionID: { type: "string" },
    objective: { type: "string" },
    status: { type: "string" },
    cap: { type: "object" },
    used: { type: "object" },
    stalls: { type: "number" },
    continuations: { type: "number" },
    tasks: { type: "array" },
    evidence: { type: "string" },
    blocker: { type: "string" },
    outcome: { type: "string" },
    updatedAt: { type: "number" },
  },
  required: ["sessionID", "objective", "status"],
  additionalProperties: true,
} as const

export const goalsRpc = {
  id: "goals",
  methods: {
    get: {
      input: sessionIDSchema,
      output: {
        type: "object",
        properties: { goal: snapshotSchema },
        additionalProperties: true,
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, goal: snapshotSchema },
        required: ["sessionID"],
        additionalProperties: true,
      },
    },
  },
} as const
