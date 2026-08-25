import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, utimesSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  deletePiState,
  gcPiState,
  getPiStatePath,
  readPiState,
  sanitizePiSessionId,
  writePiState,
} from "../pi/state.ts"

describe("pi runtime state", () => {
  let root = null

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openpeon-pi-state-test-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("sanitizes session ids before building paths", () => {
    expect(sanitizePiSessionId("abc-123_XYZ")).toBe("abc-123_XYZ")
    expect(sanitizePiSessionId("../../bad")).toBe("______bad")
    expect(sanitizePiSessionId(null)).toBeNull()
  })

  test("writes and merges popup control state", () => {
    writePiState(root, "session-a", {
      preset: "wc2-peon",
      cwd: "/repo",
      root: "/assets",
    })
    writePiState(root, "session-a", { volume: 7, whisper: false })

    expect(readPiState(root, "session-a")).toEqual({
      preset: "wc2-peon",
      volume: 7,
      whisper: false,
      cwd: "/repo",
      root: "/assets",
    })
  })

  test("deletes state when a session ends", () => {
    writePiState(root, "session-a", { preset: null })
    deletePiState(root, "session-a")

    expect(readPiState(root, "session-a")).toBeNull()
  })

  test("removes stale state without touching active sessions", () => {
    let oldPath = null
    let oldDate = null

    writePiState(root, "old-session", { preset: null })
    writePiState(root, "active-session", { preset: null })
    oldPath = getPiStatePath(root, "old-session")
    oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(oldPath, oldDate, oldDate)

    gcPiState(root)

    expect(readPiState(root, "old-session")).toBeNull()
    expect(readPiState(root, "active-session")).toEqual({ preset: null })
  })
})
