import { describe, expect, test } from "bun:test"
import { MockContext } from "./harness"

const SID = "ses_test_tasks_1"

describe("goal tasks + widget bridge", () => {
  test("tasks start empty and survive reload", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    expect(ctx.goal(SID)?.tasks).toEqual([])

    const reloaded = new MockContext({}, ctx.store)
    await reloaded.start()
    expect(reloaded.goal(SID)?.tasks).toEqual([])
  })

  test("old records without tasks normalize to []", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    const raw = ctx.store.get(`goal/${SID}`) as Record<string, unknown>
    delete raw.tasks
    ctx.store.set(`goal/${SID}`, raw)

    await ctx.runGoal(SID, "view")
    // View must not crash and the record normalizes on next load.
    expect(ctx.notices.length).toBeGreaterThan(0)
    const goal = ctx.goal(SID)
    expect(Array.isArray(goal?.tasks)).toBe(true)
  })

  test("/goal task add + update by number", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    await ctx.runGoal(SID, "task add Write tests")
    await ctx.runGoal(SID, "task add Update docs")
    expect(ctx.goal(SID)?.tasks).toHaveLength(2)

    await ctx.runGoal(SID, "task 1 doing")
    expect(ctx.goal(SID)?.tasks[0]?.status).toBe("doing")
    await ctx.runGoal(SID, "task done 2")
    expect(ctx.goal(SID)?.tasks[1]?.status).toBe("done")

    await ctx.runGoal(SID, "view")
    const last = ctx.notices[ctx.notices.length - 1]?.text ?? ""
    expect(last).toContain("1/2 done")
    expect(last).toContain("Write tests")
  })

  test("model tools add and update tasks", async () => {
    const ctx = new MockContext()
    await ctx.start()
    await ctx.runGoal(SID, "set ship it")
    const added = await ctx.callTool(SID, "goal_add_task", { title: "Wire widget" })
    expect(added.content).toContain("added")
    const id = ctx.goal(SID)?.tasks[0]?.id ?? ""
    expect(id.length).toBeGreaterThan(0)

    const updated = await ctx.callTool(SID, "goal_update_task", { ref: "1", status: "doing" })
    expect(updated.content).toContain("doing")
    expect(ctx.goal(SID)?.tasks[0]?.status).toBe("doing")

    const bad = await ctx.callTool(SID, "goal_update_task", { ref: "99", status: "done" })
    expect(bad.content).toContain("no such task")
  })

  test("every save emits an RPC updated event and get returns a snapshot", async () => {
    const ctx = new MockContext()
    await ctx.start()
    expect(ctx.rpcHandlers?.get).toBeDefined()
    await ctx.runGoal(SID, "set ship it")
    await ctx.runGoal(SID, "task add First")
    const updates = ctx.rpcEvents.filter((e) => e.event === "updated")
    expect(updates.length).toBeGreaterThanOrEqual(2)

    const get = ctx.rpcHandlers?.["get"]
    expect(get).toBeDefined()
    const result = (await get!({ sessionID: SID } as never, {} as never)) as {
      goal?: { objective?: string; tasks?: unknown[] }
    }
    expect(result.goal?.objective).toBe("ship it")
    expect(result.goal?.tasks).toHaveLength(1)
  })

  test("snapshot omits unset optionals so host output validation passes", async () => {
    const { toSnapshot } = await import("../src/rpc")
    const { createGoal } = await import("../src/state")
    const goal = createGoal({ sessionID: SID, objective: "ship it" })
    const snapshot = toSnapshot(goal) as Record<string, unknown>
    // The live host rejects `undefined` for string fields (observed L20:
    // `rpc.invalid_output` at ["goal"]["evidence"]). Unset optionals must be
    // absent, not present-with-undefined.
    expect("evidence" in snapshot).toBe(false)
    expect("blocker" in snapshot).toBe(false)
    expect("outcome" in snapshot).toBe(false)
    // JSON round-trip (what the host validates) keeps required fields + tasks.
    const roundTripped = JSON.parse(JSON.stringify({ goal: snapshot })) as {
      goal: { sessionID: string; objective: string; status: string; tasks: unknown[] }
    }
    expect(roundTripped.goal.sessionID).toBe(SID)
    expect(roundTripped.goal.tasks).toEqual([])
  })
})
