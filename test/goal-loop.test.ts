import { describe, expect, test } from "bun:test"
import {
  assistantText,
  assistantWithTool,
  MockContext,
  userMessage,
} from "./harness"
import type { PluginEvent } from "../src/types"

const SID = "ses_test_goal_1"

type TurnInput = {
  eventID: string
  inbox: "continuation" | "user" | "control"
  messages: ReturnType<typeof userMessage>[]
  outcome?: "succeeded" | "failed" | "interrupted"
}

function inboxItem(ctx: MockContext, sessionID: string, kind: TurnInput["inbox"]) {
  if (kind === "continuation") {
    const goalID = ctx.goal(sessionID)?.id
    return { type: "user", payload: { text: "continue", metadata: { goalContinuation: true, goalID } } }
  }
  if (kind === "control") {
    return { type: "synthetic", payload: { text: "notice", metadata: { goalControl: true } } }
  }
  return { type: "user", payload: { text: "hello", metadata: {} } }
}

async function emitTurn(ctx: MockContext, sessionID: string, input: TurnInput): Promise<void> {
  await ctx.emit({
    id: `evt_in_${input.eventID}`,
    type: "session.inbox.enqueued",
    data: { sessionID, inboxID: `msg_${input.eventID}`, item: inboxItem(ctx, sessionID, input.inbox) },
  } satisfies PluginEvent)
  await ctx.emit({ id: `evt_start_${input.eventID}`, type: "session.execution.started", data: { sessionID } })
  ctx.setMessages(sessionID, input.messages)
  const outcome = input.outcome ?? "succeeded"
  await ctx.emit({
    id: input.eventID,
    type: `session.execution.${outcome}`,
    data: { sessionID },
  } satisfies PluginEvent)
}

function continuationMessages(sessionID: string, ctx: MockContext, toolCall: boolean) {
  const goalID = ctx.goal(sessionID)?.id
  return [
    userMessage("msg_cont", { goalContinuation: true, goalID }),
    toolCall ? assistantWithTool("msg_tool") : assistantText("msg_text", "thinking…"),
  ]
}

describe("goal loop (driven through real setup())", () => {
  test("goal state survives a plugin reload (durable storage)", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship the release --turns 4")

    const before = ctx.goal(SID)
    expect(before?.status).toBe("active")
    expect(before?.objective).toBe("ship the release")
    expect(ctx.promptsFor(SID)).toHaveLength(1)

    // Reload: a fresh setup() over the same storage.
    const reloaded = new MockContext({}, ctx.store)
    await reloaded.start()
    const after = reloaded.goal(SID)
    expect(after?.id).toBe(before?.id)
    expect(after?.status).toBe("active")
    const system = await reloaded.systemFor(SID)
    expect(system).toContain("ship the release")
    await reloaded.systemFor(SID) // second call must still inject
    expect(system).toContain("ship the release")
  })

  test("exactly one continuation per idle boundary; duplicate event id is ignored", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set keep going")
    expect(ctx.promptsFor(SID)).toHaveLength(1) // kickoff continuation

    await emitTurn(ctx, SID, { eventID: "evt_turn_1", inbox: "continuation", messages: continuationMessages(SID, ctx, true) })
    expect(ctx.promptsFor(SID)).toHaveLength(2)

    // Same terminal event replayed.
    await ctx.emit({ id: "evt_turn_1", type: "session.execution.succeeded", data: { sessionID: SID } })
    expect(ctx.promptsFor(SID)).toHaveLength(2)

    // A second terminal for the same boundary (no execution.started between).
    await ctx.emit({ id: "evt_turn_1_dup", type: "session.execution.succeeded", data: { sessionID: SID } })
    expect(ctx.promptsFor(SID)).toHaveLength(2)
  })

  test("the plugin's own injected prompt does not re-trigger on enqueue or start", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set keep going")
    expect(ctx.promptsFor(SID)).toHaveLength(1)

    // Emitting the continuation's own inbox/start events must not, by itself, continue.
    await ctx.emit({
      id: "evt_own_in",
      type: "session.inbox.enqueued",
      data: { sessionID: SID, inboxID: "msg_own", item: inboxItem(ctx, SID, "continuation") },
    })
    await ctx.emit({ id: "evt_own_start", type: "session.execution.started", data: { sessionID: SID } })
    expect(ctx.promptsFor(SID)).toHaveLength(1)
  })

  test("stall suppression: a tool-less continuation marks the goal stalled", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set keep going")

    await emitTurn(ctx, SID, { eventID: "evt_stall_1", inbox: "continuation", messages: continuationMessages(SID, ctx, false) })
    expect(ctx.promptsFor(SID)).toHaveLength(1)
    expect(ctx.goal(SID)?.status).toBe("stalled")
    expect(ctx.goal(SID)?.outcome).toBe("stalled")

    // Resume restarts the loop.
    await ctx.runGoal(SID, "resume")
    expect(ctx.goal(SID)?.status).toBe("active")
    expect(ctx.promptsFor(SID)).toHaveLength(2)
  })

  test("a continuation that reports BLOCKED with no tool call becomes blocked", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set keep going")
    const goalID = ctx.goal(SID)?.id
    await emitTurn(ctx, SID, {
      eventID: "evt_block_1",
      inbox: "continuation",
      messages: [userMessage("msg_cont", { goalContinuation: true, goalID }), assistantText("msg_t", "BLOCKED: no credentials to proceed")],
    })
    expect(ctx.goal(SID)?.status).toBe("blocked")
    expect(ctx.goal(SID)?.blocker).toContain("no credentials")
    expect(ctx.promptsFor(SID)).toHaveLength(1)
  })

  test("completion is rejected without evidence, accepted with evidence", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set fix the bug")

    const rejected = await ctx.callTool(SID, "goal_complete", { evidence: "   " })
    expect(rejected.content).toContain("NOT completed")
    expect(ctx.goal(SID)?.status).toBe("active")
    expect(ctx.goal(SID)?.evidence).toBeUndefined()

    const accepted = await ctx.callTool(SID, "goal_complete", { evidence: "tests: 12/12 pass at commit abc123" })
    expect(accepted.content).toContain("completed")
    expect(ctx.goal(SID)?.status).toBe("completed")
    expect(ctx.goal(SID)?.outcome).toBe("completed")
    expect(ctx.goal(SID)?.evidence).toContain("12/12")

    // A completed goal no longer continues.
    await emitTurn(ctx, SID, { eventID: "evt_after_complete", inbox: "user", messages: [userMessage("msg_u")] })
    expect(ctx.promptsFor(SID)).toHaveLength(1)
  })

  test("completion via /goal complete requires checkable evidence", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set fix the bug")
    await ctx.runGoal(SID, "complete")
    expect(ctx.goal(SID)?.status).toBe("active")
    // Generic prose without an anchor is rejected even though it is non-empty.
    await ctx.runGoal(SID, "complete all tasks completed successfully")
    expect(ctx.goal(SID)?.status).toBe("active")
    await ctx.runGoal(SID, "complete tests: 12/12 pass at commit abc123, output in build/log.txt")
    expect(ctx.goal(SID)?.status).toBe("completed")
  })

  test("weak evidence cannot complete: short, generic, and ungrounded are rejected", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set fix the bug")
    // Too short.
    const short = await ctx.callTool(SID, "goal_complete", { evidence: "done" })
    expect(short.content).toContain("NOT completed")
    expect(ctx.goal(SID)?.status).toBe("active")
    // Long enough but no checkable anchor.
    const generic = await ctx.callTool(SID, "goal_complete", {
      evidence: "all tasks completed successfully and everything is fine",
    })
    expect(generic.content).toContain("NOT completed")
    expect(ctx.goal(SID)?.status).toBe("active")
    // Has an anchor but is not grounded in the transcript.
    ctx.setMessages(SID, [userMessage("msg_u"), assistantWithTool("msg_tool", "shell")])
    const ungrounded = await ctx.callTool(SID, "goal_complete", {
      evidence: "verified widget output in /tmp/unrelated-place/log.txt with 42 rows",
    })
    expect(ungrounded.content).toContain("NOT completed")
    expect(ungrounded.content).toContain("grounded")
    expect(ctx.goal(SID)?.status).toBe("active")
    // Grounded in the transcript: shares a token with observed work.
    ctx.setMessages(SID, [
      userMessage("msg_u"),
      { id: "m1", type: "assistant", content: [{ type: "text", text: "created phase1.txt with content one" }] },
    ])
    const grounded = await ctx.callTool(SID, "goal_complete", {
      evidence: "created phase1.txt containing one, verified with ls output showing phase1.txt",
    })
    expect(grounded.content).toContain("completed")
    expect(ctx.goal(SID)?.status).toBe("completed")
  })

  test("pause and clear halt continuation", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set keep going")
    expect(ctx.promptsFor(SID)).toHaveLength(1)

    await ctx.runGoal(SID, "pause")
    expect(ctx.goal(SID)?.status).toBe("paused")
    await emitTurn(ctx, SID, { eventID: "evt_paused", inbox: "user", messages: [userMessage("msg_u")] })
    expect(ctx.promptsFor(SID)).toHaveLength(1)

    await ctx.runGoal(SID, "resume")
    expect(ctx.goal(SID)?.status).toBe("active")
    expect(ctx.promptsFor(SID)).toHaveLength(2)

    await ctx.runGoal(SID, "clear")
    expect(ctx.goal(SID)?.status).toBe("cleared")
    await emitTurn(ctx, SID, { eventID: "evt_cleared", inbox: "user", messages: [userMessage("msg_u")] })
    expect(ctx.promptsFor(SID)).toHaveLength(2)
  })

  test("user interrupt never schedules a continuation", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set keep going")
    expect(ctx.promptsFor(SID)).toHaveLength(1)
    await emitTurn(ctx, SID, {
      eventID: "evt_interrupt",
      inbox: "user",
      messages: [userMessage("msg_u")],
      outcome: "interrupted",
    })
    expect(ctx.promptsFor(SID)).toHaveLength(1)
    expect(ctx.goal(SID)?.status).toBe("active")
  })

  test("cap reached reports budget_limited, not completion", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set keep going --turns 2")
    // kickoff counts as continuation #1
    expect(ctx.goal(SID)?.continuations).toBe(1)
    expect(ctx.promptsFor(SID)).toHaveLength(1)

    // continuation #2
    await emitTurn(ctx, SID, { eventID: "evt_cap_1", inbox: "continuation", messages: continuationMessages(SID, ctx, true) })
    expect(ctx.goal(SID)?.continuations).toBe(2)
    expect(ctx.promptsFor(SID)).toHaveLength(2)

    // reaching the cap stops substantive work with a distinct outcome
    await emitTurn(ctx, SID, { eventID: "evt_cap_2", inbox: "continuation", messages: continuationMessages(SID, ctx, true) })
    expect(ctx.promptsFor(SID)).toHaveLength(2)
    expect(ctx.goal(SID)?.status).toBe("budget_limited")
    expect(ctx.goal(SID)?.outcome).toBe("budget_limited")
    expect(ctx.goal(SID)?.outcome).not.toBe("completed")

    // budget_limited is resumable: resume continues.
    await ctx.runGoal(SID, "resume")
    expect(ctx.goal(SID)?.status).toBe("active")
    expect(ctx.promptsFor(SID)).toHaveLength(3)
  })

  test("a default cap applies when none is given", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set keep going")
    expect(ctx.goal(SID)?.cap.turns).toBe(10)
    expect(ctx.goal(SID)?.cap.tokens).toBe(100_000)
  })

  test("explicit caps override the defaults", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set keep going --turns 3 --tokens 500")
    expect(ctx.goal(SID)?.cap.turns).toBe(3)
    expect(ctx.goal(SID)?.cap.tokens).toBe(500)
  })

  test("unbounded requires an explicit opt-in and keeps continuing", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set keep going --unbounded")
    expect(ctx.goal(SID)?.cap.turns).toBeUndefined()
    expect(ctx.goal(SID)?.cap.tokens).toBeUndefined()
    for (let i = 0; i < 5; i++) {
      await emitTurn(ctx, SID, {
        eventID: `evt_free_${i}`,
        inbox: "continuation",
        messages: continuationMessages(SID, ctx, true),
      })
    }
    expect(ctx.goal(SID)?.status).toBe("active")
    expect(ctx.promptsFor(SID)).toHaveLength(6)
  })

  test("default turn cap stops the loop when reached", async () => {
    const ctx = new MockContext({ defaultCapTurns: 2, defaultCapTokens: 1_000_000 })
    await ctx.start()
    await ctx.runGoal(SID, "set keep going")
    expect(ctx.goal(SID)?.cap.turns).toBe(2)
    await emitTurn(ctx, SID, { eventID: "evt_defcap_1", inbox: "continuation", messages: continuationMessages(SID, ctx, true) })
    await emitTurn(ctx, SID, { eventID: "evt_defcap_2", inbox: "continuation", messages: continuationMessages(SID, ctx, true) })
    expect(ctx.goal(SID)?.status).toBe("budget_limited")
    expect(ctx.goal(SID)?.outcome).toBe("budget_limited")
  })

  test("token cap is honoured from session.usage.updated", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set keep going --tokens 100")
    await ctx.emit({
      id: "evt_usage",
      type: "session.usage.updated",
      data: { sessionID: SID, tokens: { input: 80, output: 40 } },
    })
    await emitTurn(ctx, SID, { eventID: "evt_tok", inbox: "continuation", messages: continuationMessages(SID, ctx, true) })
    expect(ctx.goal(SID)?.status).toBe("budget_limited")
    expect(ctx.goal(SID)?.outcome).toBe("budget_limited")
  })

  test("status notices do not trigger continuation", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set keep going")
    await ctx.runGoal(SID, "view")
    expect(ctx.notices.length).toBeGreaterThan(0)

    await emitTurn(ctx, SID, { eventID: "evt_control", inbox: "control", messages: [assistantText("msg_t", "notice")] })
    expect(ctx.promptsFor(SID)).toHaveLength(1)
    expect(ctx.goal(SID)?.status).toBe("active")
  })

  test("only the instance owning the session's project continues the loop", async () => {
    const store = new Map<string, unknown>()
    const projects = new Map<string, string>([[SID, "proj-a"]])
    const a = new MockContext({ projectID: "proj-a" }, store, projects)
    const b = new MockContext({ projectID: "proj-b" }, store, projects)
    await a.start()
    await b.start()
    await a.runGoal(SID, "set keep going")

    const messages = continuationMessages(SID, a, true)
    await emitTurn(a, SID, { eventID: "evt_scope_1", inbox: "continuation", messages })
    await emitTurn(b, SID, { eventID: "evt_scope_1", inbox: "continuation", messages })

    expect(a.promptsFor(SID)).toHaveLength(2)
    expect(b.promptsFor(SID)).toHaveLength(0)
  })

  test("objective is injected into every model call while active", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set land the change")
    const first = await ctx.systemFor(SID)
    const second = await ctx.systemFor(SID)
    expect(first).toContain("land the change")
    expect(second).toContain("land the change")
    expect(first).toContain("goal_complete")
  })

  test("permission sandbox allows in-scope paths and denies outside ones", async () => {
    const ctx = new MockContext()
    await ctx.start()
    ctx.setSessionDirectory(SID, "/tmp/goals-work")
    await ctx.runGoal(SID, "set keep going --unbounded")

    const inside = await ctx.evaluatePermission({
      sessionID: SID,
      action: "read",
      resources: ["/tmp/goals-work/phase1.txt"],
      effect: "ask",
    })
    expect(inside.effect).toBe("allow")

    const outside = await ctx.evaluatePermission({
      sessionID: SID,
      action: "external_directory",
      resources: ["/tmp/*"],
      effect: "ask",
    })
    expect(outside.effect).toBe("deny")
    expect(outside.message).toContain("outside the session working directory")
    expect(outside.message).toContain("goal_block")
  })

  test("permission sandbox never turns a hard deny into an allow", async () => {
    const ctx = new MockContext()
    await ctx.start()
    ctx.setSessionDirectory(SID, "/tmp/goals-work")
    await ctx.runGoal(SID, "set keep going --unbounded")

    const denied = await ctx.evaluatePermission({
      sessionID: SID,
      action: "read",
      resources: ["/tmp/goals-work/blocked-secret.txt"],
      effect: "deny",
    })
    expect(denied.effect).toBe("deny")
  })

  test("permission sandbox leaves non-goal sessions and non-path requests alone", async () => {
    const ctx = new MockContext()
    await ctx.start()
    ctx.setSessionDirectory(SID, "/tmp/goals-work")

    // No goal set: untouched even for an in-scope path.
    const noGoal = await ctx.evaluatePermission({
      sessionID: SID,
      action: "read",
      resources: ["/tmp/goals-work/a.txt"],
      effect: "ask",
    })
    expect(noGoal.effect).toBe("ask")

    await ctx.runGoal(SID, "set keep going --unbounded")
    // Non-path resources (shell command text, URLs) are out of remit.
    const shell = await ctx.evaluatePermission({
      sessionID: SID,
      action: "shell",
      resources: ["git status --short"],
      effect: "ask",
    })
    expect(shell.effect).toBe("ask")
  })

  test("permission sandbox is decided only by the owning instance", async () => {
    const store = new Map<string, unknown>()
    const projects = new Map<string, string>([[SID, "proj-a"]])
    const a = new MockContext({ projectID: "proj-a" }, store, projects)
    const b = new MockContext({ projectID: "proj-b" }, store, projects)
    await a.start()
    await b.start()
    a.setSessionDirectory(SID, "/tmp/goals-work")
    b.setSessionDirectory(SID, "/tmp/goals-work")
    await a.runGoal(SID, "set keep going --unbounded")

    const owner = await a.evaluatePermission({
      sessionID: SID,
      action: "read",
      resources: ["/tmp/goals-work/a.txt"],
      effect: "ask",
    })
    expect(owner.effect).toBe("allow")

    const nonOwner = await b.evaluatePermission({
      sessionID: SID,
      action: "read",
      resources: ["/tmp/goals-work/a.txt"],
      effect: "ask",
    })
    expect(nonOwner.effect).toBe("ask")
  })

  test("goal_set: model-callable set with cap defaults and no-clobber guard", async () => {
    const ctx = new MockContext()
    await ctx.start()

    const blank = await ctx.callTool(SID, "goal_set", { objective: "   " })
    expect(blank.content).toContain("NOT set")
    expect(ctx.goal(SID)).toBeUndefined()

    const set = await ctx.callTool(SID, "goal_set", { objective: "ship the widget", turns: 3 })
    expect(set.content).toContain("ship the widget")
    const goal = ctx.goal(SID)
    expect(goal?.status).toBe("active")
    expect(goal?.cap.turns).toBe(3)
    expect(goal?.cap.tokens).toBe(100000) // configured default
    expect(ctx.promptsFor(SID)).toHaveLength(1) // continuation injected

    // A live goal cannot be clobbered by the model.
    const clobber = await ctx.callTool(SID, "goal_set", { objective: "something else" })
    expect(clobber.content).toContain("NOT set")
    expect(ctx.goal(SID)?.objective).toBe("ship the widget")

    // Terminal (cleared) goals free the slot; unbounded skips cap defaults.
    await ctx.runGoal(SID, "clear")
    const again = await ctx.callTool(SID, "goal_set", { objective: "next thing", unbounded: true })
    expect(again.content).toContain("next thing")
    expect(ctx.goal(SID)?.cap).toEqual({})
  })

  test("goal_clear only clears on a user request grounded in the transcript", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set keep going")

    const bare = await ctx.callTool(SID, "goal_clear", { request: "   " })
    expect(bare.content).toContain("NOT cleared")
    expect(ctx.goal(SID)?.status).toBe("active")

    // Mentions no clearing verb.
    const off = await ctx.callTool(SID, "goal_clear", { request: "please continue the objective" })
    expect(off.content).toContain("NOT cleared")
    expect(ctx.goal(SID)?.status).toBe("active")

    // Clearing verb present but not the user's words.
    ctx.setMessages(SID, [{ id: "m1", type: "user", text: "can you summarize the report" }, assistantWithTool("m2")])
    const ungrounded = await ctx.callTool(SID, "goal_clear", { request: "clear the objective immediately" })
    expect(ungrounded.content).toContain("NOT cleared")
    expect(ctx.goal(SID)?.status).toBe("active")

    // Assistant-only mentions must not launder into a user request.
    ctx.setMessages(SID, [
      userMessage("m1"),
      { id: "m2", type: "assistant", content: [{ type: "text", text: "I will clear the goal right away" }] },
    ])
    const laundered = await ctx.callTool(SID, "goal_clear", { request: "clear the goal right away" })
    expect(laundered.content).toContain("NOT cleared")
    expect(ctx.goal(SID)?.status).toBe("active")

    // A grounded quote of the user's own message passes.
    ctx.setMessages(SID, [{ id: "m3", type: "user", text: "please clear the goal loop, we are done" }])
    const ok = await ctx.callTool(SID, "goal_clear", { request: "please clear the goal loop, we are done" })
    expect(ok.content).toContain("cleared")
    expect(ctx.goal(SID)?.status).toBe("cleared")
  })

  test("goal history archives terminal and superseded goals", async () => {
    const ctx = new MockContext()
    await ctx.start()

    // Goal A completes -> archived with its evidence.
    ctx.setMessages(SID, [
      userMessage("m0"),
      { id: "a1", type: "assistant", content: [{ type: "text", text: "created phase1.txt, verified output" }] },
    ])
    await ctx.runGoal(SID, "set ship A")
    const aID = ctx.goal(SID)!.id
    const done = await ctx.callTool(SID, "goal_complete", { evidence: "created phase1.txt and verified output in build" })
    expect(done.content).toContain("completed")

    // Goal B is superseded while still active -> archived too, so nothing is lost silently.
    await ctx.runGoal(SID, "set ship B")
    const bID = ctx.goal(SID)!.id
    await ctx.runGoal(SID, "set ship C")

    await ctx.runGoal(SID, "history")
    const notice = ctx.notices[ctx.notices.length - 1]?.text ?? ""
    expect(notice).toContain("Goal history")
    expect(notice).toContain(aID)
    expect(notice).toContain("completed")
    expect(notice).toContain(bID)
    expect(notice).toContain("active")
    expect(notice).toContain("2 archived")
    // The live goal (C) is not in the archive yet.
    expect(notice).not.toContain("ship C")

    // Same view through the read-only model tool.
    const tool = await ctx.callTool(SID, "goal_history", {})
    expect(tool.content).toContain(aID)
    expect(tool.content).toContain(bID)
  })

  test("complete/block guards report goal state before demanding evidence", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set finish A")
    ctx.setMessages(SID, [
      userMessage("m0"),
      { id: "a1", type: "assistant", content: [{ type: "text", text: "created phase1.txt, verified output" }] },
    ])
    const ok = await ctx.callTool(SID, "goal_complete", { evidence: "created phase1.txt and verified output in build" })
    expect(ok.content).toContain("completed")

    // Bare `/goal complete` on a terminal goal hits the state guard, not the evidence guard.
    await ctx.runGoal(SID, "complete")
    const notice = ctx.notices[ctx.notices.length - 1]?.text ?? ""
    expect(notice).toContain("completed, not active")
    expect(notice).not.toContain("evidence is required")

    // Same precedence through the tool surface.
    const late = await ctx.callTool(SID, "goal_complete", { evidence: "   " })
    expect(late.content).toContain("not active")
    const lateBlock = await ctx.callTool(SID, "goal_block", { reason: "" })
    expect(lateBlock.content).toContain("not active")

    // Cleared goals get the state wording too (record exists, status cleared).
    await ctx.runGoal(SID, "clear")
    const none = await ctx.callTool(SID, "goal_complete", { evidence: "" })
    expect(none.content).toContain("cleared, not active")

    // And a bare command on an ACTIVE goal still gets the helpful evidence prompt.
    await ctx.runGoal(SID, "set finish B")
    await ctx.runGoal(SID, "complete")
    expect(ctx.notices[ctx.notices.length - 1]?.text).toContain("evidence is required")
  })
})
