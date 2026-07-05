import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolve, dirname, join } from "path"
import { fileURLToPath } from "url"
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "fs"
import { tmpdir } from "os"
import {
  TOOL_NAME_MAP,
  deleteState,
  gcState,
  mapToolName,
  readState,
  resolveSessionConfig,
  sanitizeSessionId,
  statePath,
  touchState,
  translateHookEvent,
  writeState,
} from "../claude/hook.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLAUDE_FIXTURES_DIR = resolve(__dirname, "fixtures", "claude")

function loadFixture(name) {
  return JSON.parse(readFileSync(resolve(CLAUDE_FIXTURES_DIR, `${name}.json`), "utf8"))
}

describe("mapToolName", () => {
  test("maps known Claude tool names to OpenPeon tool names", () => {
    expect(mapToolName("Bash")).toBe("bash")
    expect(mapToolName("AskUserQuestion")).toBe("question")
    expect(mapToolName("WebFetch")).toBe("webfetch")
    expect(mapToolName("TodoWrite")).toBe("todowrite")
  })

  test("lowercases unknown tool names so future tools degrade gracefully", () => {
    expect(mapToolName("NotebookEdit")).toBe("notebookedit")
  })

  test("returns null for missing names", () => {
    expect(mapToolName(undefined)).toBeNull()
    expect(mapToolName("")).toBeNull()
  })

  test("covers every documented OpenPeon tool name", () => {
    const openPeonTools = Object.values(TOOL_NAME_MAP).sort()
    expect(openPeonTools).toEqual(
      ["bash", "edit", "glob", "grep", "question", "read", "skill", "task", "todowrite", "webfetch", "write"]
    )
  })
})

describe("translateHookEvent", () => {
  test("SessionStart (startup) becomes openpeon.startup", () => {
    expect(translateHookEvent(loadFixture("session-start"))).toEqual({
      kind: "event",
      eventType: "openpeon.startup",
      messageRole: null,
    })
  })

  test("SessionStart (compact) is state upkeep only", () => {
    expect(translateHookEvent(loadFixture("session-start-compact"))).toEqual({ kind: "state-only" })
  })

  test("UserPromptSubmit becomes message.updated with role user", () => {
    expect(translateHookEvent(loadFixture("user-prompt-submit"))).toEqual({
      kind: "event",
      eventType: "message.updated",
      messageRole: "user",
    })
  })

  test("Stop becomes session.idle", () => {
    expect(translateHookEvent(loadFixture("stop"))).toEqual({
      kind: "event",
      eventType: "session.idle",
      messageRole: null,
    })
  })

  test("PermissionRequest becomes permission.asked", () => {
    expect(translateHookEvent(loadFixture("permission-request"))).toEqual({
      kind: "event",
      eventType: "permission.asked",
      messageRole: null,
    })
  })

  test("PreToolUse becomes tool.before with the mapped tool name", () => {
    expect(translateHookEvent(loadFixture("pre-tool-use-bash"))).toEqual({
      kind: "tool",
      triggerType: "tool.before",
      tool: "bash",
    })
  })

  test("PostToolUse becomes tool.after with the mapped tool name", () => {
    expect(translateHookEvent(loadFixture("post-tool-use-edit"))).toEqual({
      kind: "tool",
      triggerType: "tool.after",
      tool: "edit",
    })
  })

  test("SessionEnd is cleanup", () => {
    expect(translateHookEvent(loadFixture("session-end"))).toEqual({ kind: "cleanup" })
  })

  test("unknown events and malformed payloads are ignored", () => {
    expect(translateHookEvent({ hook_event_name: "Notification" })).toBeNull()
    expect(translateHookEvent({})).toBeNull()
    expect(translateHookEvent(null)).toBeNull()
  })
})

describe("sanitizeSessionId", () => {
  test("keeps safe ids untouched", () => {
    expect(sanitizeSessionId("abc-123_XYZ")).toBe("abc-123_XYZ")
  })

  test("neutralizes path traversal attempts", () => {
    expect(sanitizeSessionId("../../etc/passwd")).toBe("______etc_passwd")
  })

  test("returns null for missing ids", () => {
    expect(sanitizeSessionId(null)).toBeNull()
    expect(sanitizeSessionId("")).toBeNull()
  })
})

describe("session state", () => {
  let root = null

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openpeon-hook-test-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("write, read, and delete a state file round-trip", () => {
    writeState(root, "session-a", { preset: "wc2-peon" })
    expect(readState(root, "session-a")).toEqual({ preset: "wc2-peon" })

    deleteState(root, "session-a")
    expect(readState(root, "session-a")).toBeNull()
    expect(existsSync(statePath(root, "session-a"))).toBe(false)
  })

  test("readState returns null for a missing or invalid session id", () => {
    expect(readState(root, "never-written")).toBeNull()
    expect(readState(root, null)).toBeNull()
  })

  test("gcState removes only files older than the max age", () => {
    writeState(root, "old-session", { preset: null })
    writeState(root, "fresh-session", { preset: null })

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(statePath(root, "old-session"), eightDaysAgo, eightDaysAgo)

    gcState(root)

    expect(readState(root, "old-session")).toBeNull()
    expect(readState(root, "fresh-session")).toEqual({ preset: null })
  })

  test("gcState tolerates a missing state directory", () => {
    expect(() => gcState(resolve(root, "nope"))).not.toThrow()
  })

  test("touchState refreshes the mtime so the session survives GC and stays newest", () => {
    writeState(root, "session-a", { preset: null })
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(statePath(root, "session-a"), eightDaysAgo, eightDaysAgo)

    touchState(root, "session-a")
    gcState(root)

    expect(readState(root, "session-a")).toEqual({ preset: null })
  })

  test("touchState tolerates a missing state file", () => {
    expect(() => touchState(root, "never-written")).not.toThrow()
    expect(() => touchState(root, null)).not.toThrow()
  })
})

describe("resolveSessionConfig", () => {
  let root = null

  const BASE_CONFIG = {
    volume: 3,
    randomPreset: true,
    mappings: [
      {
        name: "base-ack",
        triggers: [{ type: "event", event: "message.updated", role: "user" }],
        sounds: ["base.wav"],
      },
    ],
  }

  const PRESET = {
    tier: 1,
    volume: 0,
    mappings: [
      {
        name: "preset-ack",
        triggers: [{ type: "event", event: "message.updated", role: "user" }],
        sounds: ["preset.wav"],
      },
    ],
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openpeon-hook-test-"))
    writeFileSync(resolve(root, "openpeon.json"), JSON.stringify(BASE_CONFIG))
    mkdirSync(resolve(root, "presets"))
    writeFileSync(resolve(root, "presets", "only-preset.json"), JSON.stringify(PRESET))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("rolls and persists a preset on the first event when randomPreset is on", () => {
    const resolved = resolveSessionConfig(root, "session-a", () => 0)

    expect(resolved.preset).toBe("only-preset")
    expect(resolved.volume).toBe(0)
    expect(resolved.mappings[0].name).toBe("preset-ack")
    expect(readState(root, "session-a")).toEqual({ preset: "only-preset" })
  })

  test("later events reuse the persisted preset instead of re-rolling", () => {
    writeState(root, "session-a", { preset: "only-preset" })

    const resolved = resolveSessionConfig(root, "session-a", () => {
      throw new Error("must not re-roll")
    })

    expect(resolved.preset).toBe("only-preset")
    expect(resolved.volume).toBe(0)
  })

  test("keeps the base config when randomPreset is off, but still registers the session", () => {
    writeFileSync(resolve(root, "openpeon.json"), JSON.stringify({ ...BASE_CONFIG, randomPreset: false }))

    const resolved = resolveSessionConfig(root, "session-a", () => {
      throw new Error("must not roll when randomPreset is off")
    })

    expect(resolved.preset).toBeNull()
    expect(resolved.volume).toBe(3)
    expect(resolved.mappings[0].name).toBe("base-ack")
    // The state file must exist anyway: the openpeon skill discovers the
    // current session through it
    expect(readState(root, "session-a")).toEqual({ preset: null })
  })

  test("a state volume override beats the preset volume", () => {
    writeState(root, "session-a", { preset: "only-preset", volume: 7 })

    const resolved = resolveSessionConfig(root, "session-a", () => 0)

    expect(resolved.preset).toBe("only-preset")
    expect(resolved.mappings[0].name).toBe("preset-ack")
    expect(resolved.volume).toBe(7)
  })

  test("a state volume override beats the base volume when no preset is active", () => {
    writeState(root, "session-a", { preset: null, volume: 9 })

    const resolved = resolveSessionConfig(root, "session-a", () => 0)

    expect(resolved.preset).toBeNull()
    expect(resolved.volume).toBe(9)
  })

  test("a state volume of 0 mutes the session", () => {
    writeState(root, "session-a", { preset: null, volume: 0 })

    expect(resolveSessionConfig(root, "session-a", () => 0).volume).toBe(0)
  })

  test("state volume is clamped to 0-10", () => {
    writeState(root, "session-a", { preset: null, volume: 42 })
    expect(resolveSessionConfig(root, "session-a", () => 0).volume).toBe(10)

    writeState(root, "session-a", { preset: null, volume: -3 })
    expect(resolveSessionConfig(root, "session-a", () => 0).volume).toBe(0)
  })

  test("falls back to the base config when the persisted preset no longer exists", () => {
    writeState(root, "session-a", { preset: "deleted-preset" })

    const resolved = resolveSessionConfig(root, "session-a", () => 0)

    expect(resolved.preset).toBeNull()
    expect(resolved.volume).toBe(3)
    expect(resolved.mappings[0].name).toBe("base-ack")
  })

  test("separate sessions get separate state files", () => {
    resolveSessionConfig(root, "session-a", () => 0)
    resolveSessionConfig(root, "session-b", () => 0)

    expect(readState(root, "session-a")).toEqual({ preset: "only-preset" })
    expect(readState(root, "session-b")).toEqual({ preset: "only-preset" })
    expect(statePath(root, "session-a")).not.toBe(statePath(root, "session-b"))
  })
})
