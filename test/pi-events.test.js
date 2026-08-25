import { describe, expect, test } from "bun:test"
import { mapPiToolName, shouldEnablePiSession, translatePiEvent } from "../pi/events.ts"

describe("shouldEnablePiSession", () => {
  test("enables interactive sessions and mutes headless child sessions", () => {
    expect(shouldEnablePiSession("tui")).toBe(true)
    expect(shouldEnablePiSession("rpc")).toBe(true)
    expect(shouldEnablePiSession("json")).toBe(false)
    expect(shouldEnablePiSession("print")).toBe(false)
  })
})

describe("mapPiToolName", () => {
  test("maps pi tools to the existing OpenPeon trigger vocabulary", () => {
    expect(mapPiToolName("ask_user_question")).toBe("question")
    expect(mapPiToolName("AskUserQuestion")).toBe("question")
    expect(mapPiToolName("find")).toBe("glob")
    expect(mapPiToolName("subagent")).toBe("task")
  })

  test("lowercases unknown tool names", () => {
    expect(mapPiToolName("CustomTool")).toBe("customtool")
  })

  test("rejects missing tool names", () => {
    expect(mapPiToolName(undefined)).toBeNull()
    expect(mapPiToolName(42)).toBeNull()
    expect(mapPiToolName("")).toBeNull()
  })
})

describe("translatePiEvent", () => {
  test("maps session startup but ignores extension reload", () => {
    expect(translatePiEvent("session_start", { reason: "startup" })).toEqual({
      eventTypes: ["openpeon.startup"],
      messageRole: null,
    })
    expect(translatePiEvent("session_start", { reason: "reload" })).toBeNull()
  })

  test("maps user input and settled agents", () => {
    expect(translatePiEvent("input")).toEqual({
      eventTypes: ["message.updated"],
      messageRole: "user",
    })
    expect(translatePiEvent("agent_settled")).toEqual({
      eventTypes: ["session.idle"],
      messageRole: null,
    })
  })

  test("maps user shell commands to both command event names", () => {
    expect(translatePiEvent("user_bash")).toEqual({
      eventTypes: ["command.executed", "tui.command.execute"],
      messageRole: null,
    })
  })

  test("maps tool lifecycle events", () => {
    expect(translatePiEvent("tool_execution_start", { toolName: "bash" })).toEqual({
      eventTypes: [],
      toolTrigger: { type: "tool.before", tool: "bash" },
      messageRole: null,
    })
    expect(translatePiEvent("tool_execution_end", { toolName: "edit" })).toEqual({
      eventTypes: [],
      toolTrigger: { type: "tool.after", tool: "edit" },
      messageRole: null,
    })
  })

  test("maps question tools to permission events and tool triggers", () => {
    expect(translatePiEvent("tool_execution_start", { toolName: "ask_user_question" })).toEqual({
      eventTypes: ["permission.asked"],
      toolTrigger: { type: "tool.before", tool: "question" },
      messageRole: null,
    })
    expect(translatePiEvent("tool_execution_end", { toolName: "ask_user_question" })).toEqual({
      eventTypes: ["permission.replied"],
      toolTrigger: { type: "tool.after", tool: "question" },
      messageRole: null,
    })
  })

  test("ignores unknown events and missing tool names", () => {
    expect(translatePiEvent("unknown")).toBeNull()
    expect(translatePiEvent("tool_execution_start", {})).toBeNull()
  })
})
