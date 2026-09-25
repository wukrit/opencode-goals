/**
 * Evidence gating for `goal_complete` and request gating for `goal_clear`.
 *
 * The spike accepted any non-empty string. Production requires evidence that is
 * at least plausibly checkable without a human in the loop. This module keeps
 * the check structural (no model call, no filesystem access) but meaningful:
 *
 * 1. Minimum length, so "done" can never complete a goal.
 * 2. A concrete anchor (path, number, file extension, or checkability keyword),
 *    so generic prose like "all tasks completed successfully" is rejected.
 * 3. Transcript grounding when history is available: at least one substantive
 *    token from the evidence must appear in recent session messages, so evidence
 *    cannot be invented out of thin air.
 *
 * This is a heuristic gate, not semantic verification. A determined model can
 * still fabricate plausible evidence; genuine verification would need an
 * evaluator (second model or shell check) and is documented as out of scope.
 * The gate's job is to force the model to produce specific, grounded evidence
 * and to give the loop a principled way to reject weak claims.
 */

export const MIN_EVIDENCE_LENGTH = 24

/** Quoted user requests can be shorter than evidence but must still be specific. */
export const MIN_CLEAR_REQUEST_LENGTH = 12

const ANCHOR_KEYWORDS = new Set([
  "file",
  "files",
  "test",
  "tests",
  "pass",
  "passed",
  "fail",
  "output",
  "verified",
  "verify",
  "created",
  "exists",
  "contains",
  "commit",
  "log",
  "result",
  "results",
  "content",
  "contents",
  "phase",
  "artifact",
  "artifacts",
  "checked",
  "measured",
  "ls",
  "diff",
  "suite",
])

function hasConcreteAnchor(evidence: string): boolean {
  // Absolute or relative path, file extension, or any digit (counts, hashes, sizes).
  if (evidence.includes("/")) return true
  if (/\d/.test(evidence)) return true
  if (/\.\w{2,}/.test(evidence)) return true
  const words = evidence.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return words.some((w) => ANCHOR_KEYWORDS.has(w))
}

const GROUNDING_STOPWORDS = new Set([
  "with",
  "from",
  "that",
  "this",
  "have",
  "will",
  "your",
  "about",
  "into",
  "over",
  "after",
  "before",
  "under",
  "while",
  "where",
  "which",
  "when",
  "what",
  "then",
  "them",
  "they",
  "their",
])

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length >= 6 && !GROUNDING_STOPWORDS.has(t))
}

function transcriptText(messages: readonly { text?: string; content?: readonly { text?: string }[] }[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.text) parts.push(m.text)
    for (const c of m.content ?? []) {
      if (c.text) parts.push(c.text)
    }
  }
  return parts.join("\n").toLowerCase()
}

/**
 * Validate completion evidence.
 *
 * @param evidence raw evidence string from the tool/command call.
 * @param transcript recent session messages for grounding, if available.
 * @returns a rejection reason when the evidence is too weak, else undefined.
 */
export function validateEvidence(
  evidence: string,
  transcript?: readonly { text?: string; content?: readonly { text?: string }[] }[],
): string | undefined {
  const trimmed = (evidence ?? "").trim()
  if (!trimmed) {
    return "Goal NOT completed: `evidence` is required and must describe something checkable. The goal remains active."
  }
  if (trimmed.length < MIN_EVIDENCE_LENGTH) {
    return (
      `Goal NOT completed: evidence is too weak (${trimmed.length} chars, minimum ${MIN_EVIDENCE_LENGTH}). ` +
      "Describe a concrete, independently checkable artifact (file, test result, command output). The goal remains active."
    )
  }
  if (!hasConcreteAnchor(trimmed)) {
    return (
      "Goal NOT completed: evidence has no checkable anchor (path, number, file, test result, or command output). " +
      "Describe something a reviewer could independently verify. The goal remains active."
    )
  }
  if (transcript && transcript.length > 0) {
    const haystack = transcriptText(transcript)
    if (haystack.trim().length > 0) {
      const hayTokens = new Set(tokens(haystack))
      const evTokens = tokens(trimmed)
      const grounded = evTokens.some((t) => hayTokens.has(t))
      if (!grounded) {
        return (
          "Goal NOT completed: evidence is not grounded in this session's observed work " +
          "(no substantive token overlaps recent messages). Cite a file, test, or output from the actual transcript. " +
          "The goal remains active."
        )
      }
    }
  }
  return undefined
}

// ---- goal_clear request gating ---------------------------------------------

const CLEAR_MENTION = /\b(clear|remove|delete|reset|abort|discard|stop|cancel)\b/

/**
 * Text from non-assistant messages only. Excluding assistant text prevents a
 * model from laundering its own wording into a "user request". Messages
 * without a recognizable type are included (fail-toward-grounding, never
 * toward trust of assistant prose).
 */
function requesterText(messages: readonly { type?: string; text?: string; content?: readonly { text?: string }[] }[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.type === "assistant") continue
    if (m.text) parts.push(m.text)
    for (const c of m.content ?? []) {
      if (c.text) parts.push(c.text)
    }
  }
  return parts.join("\n").toLowerCase()
}

/**
 * Validate the quoted user request gating `goal_clear`.
 *
 * Clearing is the one goal operation with no artifact to point at, so the
 * substitute is proof of user intent: a quote that (1) mentions clearing,
 * (2) meets a small minimum length, and (3) is grounded in non-assistant
 * session messages. With no transcript available the gate fails closed —
 * an unverifiable destructive action does not run.
 *
 * @returns a rejection reason when the request is not acceptably the user's,
 * else undefined.
 */
export function validateClearRequest(
  request: string,
  transcript?: readonly { type?: string; text?: string; content?: readonly { text?: string }[] }[],
): string | undefined {
  const trimmed = (request ?? "").trim()
  if (!trimmed) {
    return (
      "Goal NOT cleared: `request` must quote the user's explicit instruction to clear the goal. " +
      "The model must never clear a goal on its own initiative — use goal_complete or goal_block instead. " +
      "The goal remains active."
    )
  }
  if (trimmed.length < MIN_CLEAR_REQUEST_LENGTH) {
    return (
      `Goal NOT cleared: request is too short (${trimmed.length} chars, minimum ${MIN_CLEAR_REQUEST_LENGTH}). ` +
      "Quote the user's message verbatim. The goal remains active."
    )
  }
  if (!CLEAR_MENTION.test(trimmed.toLowerCase())) {
    return (
      "Goal NOT cleared: the quoted request does not mention clearing/removing/resetting the goal. " +
      "The goal remains active."
    )
  }
  if (!transcript || transcript.length === 0) {
    return (
      "Goal NOT cleared: no transcript is available to ground the quoted user request, so the destructive " +
      "action fails closed. Ask the user to run /goal clear directly. The goal remains active."
    )
  }
  const haystack = requesterText(transcript)
  const hayTokens = new Set(tokens(haystack))
  const reqTokens = tokens(trimmed)
  const grounded = reqTokens.length > 0 && reqTokens.some((t) => hayTokens.has(t))
  if (!grounded) {
    return (
      "Goal NOT cleared: the quoted request is not grounded in the user's own messages in this session " +
      "(assistant text does not count). Quote what the user actually said. The goal remains active."
    )
  }
  return undefined
}
