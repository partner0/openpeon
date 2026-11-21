import { describe, expect, test } from "bun:test"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import {
  DEFAULT_CONFIG,
  computeAfplayVolume,
  getRandomSound,
  listPresets,
  listRandomPresets,
  loadConfig,
  loadPreset,
  matchesEventTrigger,
  matchesToolTrigger,
  pickWeightedPreset,
} from "../lib/core.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PRESETS_DIR = resolve(__dirname, "fixtures", "presets")
const CONFIGS_DIR = resolve(__dirname, "fixtures", "configs")

describe("loadConfig", () => {
  test.each([
    ["the file is missing", "does-not-exist.json"],
    ["the JSON is invalid", "broken.json"],
    ["mappings is missing", "no-mappings.json"],
  ])("returns DEFAULT_CONFIG when %s", (_case, file) => {
    expect(loadConfig(resolve(CONFIGS_DIR, file))).toBe(DEFAULT_CONFIG)
  })

  test("returns the parsed config when valid", () => {
    const config = loadConfig(resolve(CONFIGS_DIR, "valid.json"))
    expect(config.volume).toBe(7)
    expect(config.mappings).toHaveLength(1)
    expect(config.mappings[0].name).toBe("acknowledge")
  })
})

describe("listPresets", () => {
  test("returns json preset names without extension, ignoring other files", () => {
    const presets = listPresets(PRESETS_DIR).sort()
    expect(presets).toEqual(["broken", "no-tier", "tier1", "tier3"])
  })

  test("returns [] for a missing directory", () => {
    expect(listPresets(resolve(PRESETS_DIR, "nope"))).toEqual([])
  })
})

describe("loadPreset", () => {
  test("returns the parsed preset", () => {
    const preset = loadPreset(PRESETS_DIR, "tier1")
    expect(preset.tier).toBe(1)
    expect(preset.volume).toBe(4)
  })

  test.each([
    ["a missing preset", "does-not-exist"],
    ["invalid JSON", "broken"],
  ])("returns null for %s", (_case, name) => {
    expect(loadPreset(PRESETS_DIR, name)).toBeNull()
  })
})

describe("listRandomPresets", () => {
  test("keeps every preset when enabledGames is not an array", () => {
    expect(listRandomPresets(PRESETS_DIR, undefined).sort()).toEqual(["broken", "no-tier", "tier1", "tier3"])
  })

  test("keeps only presets whose name prefix is an enabled game", () => {
    expect(listRandomPresets(PRESETS_DIR, ["no", "tier1"]).sort()).toEqual(["no-tier", "tier1"])
  })

  test("returns no presets when no game is enabled", () => {
    expect(listRandomPresets(PRESETS_DIR, [])).toEqual([])
  })
})

describe("pickWeightedPreset", () => {
  // Weights: tier1 = 3, tier3 = 1, no-tier = 2 (default), broken = 2 (default)
  const names = ["tier1", "tier3", "no-tier"]

  test("returns null for an empty list", () => {
    expect(pickWeightedPreset(PRESETS_DIR, [], () => 0)).toBeNull()
  })

  // Total weight 6 for names: tier1 covers 0..3, tier3 3..4, no-tier 4..6.
  // The last row reorders the list: tier3 covers 0..1 of 4, tier1 1..4.
  test.each([
    [names, 0, "tier1"],
    [names, 0.49, "tier1"],
    [names, 0.55, "tier3"],
    [names, 0.9, "no-tier"],
    [["tier3", "tier1"], 0.4, "tier1"],
  ])("%p with roll %p lands on %p", (presetNames, roll, expected) => {
    expect(pickWeightedPreset(PRESETS_DIR, presetNames, () => roll)).toBe(expected)
  })

  test("an unreadable preset gets the default weight and the roll can still land on it", () => {
    expect(pickWeightedPreset(PRESETS_DIR, ["broken"], () => 0.999)).toBe("broken")
  })
})

describe("getRandomSound", () => {
  test("returns null for empty or non-array input", () => {
    expect(getRandomSound([])).toBeNull()
    expect(getRandomSound(undefined)).toBeNull()
    expect(getRandomSound("not-an-array")).toBeNull()
  })

  test("returns the only element of a single-item list", () => {
    expect(getRandomSound(["peon.wav"])).toBe("peon.wav")
  })
})

describe("computeAfplayVolume", () => {
  // (v/10)^2: 0 is mute, 10 is full volume, and the curve is perceptually linear.
  test.each([
    [0, 0],
    [5, 0.25],
    [10, 1],
  ])("volume %p plays at %p", (volume, expected) => {
    expect(computeAfplayVolume(volume, false)).toBe(expected)
  })

  test("whisper overrides the volume with the whisper level", () => {
    expect(computeAfplayVolume(10, true)).toBeCloseTo(0.01)
    expect(computeAfplayVolume(2, true)).toBeCloseTo(0.01)
  })

  test("mute wins over whisper", () => {
    expect(computeAfplayVolume(0, true)).toBe(0)
    expect(computeAfplayVolume(-1, true)).toBe(0)
  })
})

describe("matchesEventTrigger", () => {
  test("matches on event type", () => {
    expect(matchesEventTrigger({ type: "event", event: "session.idle" }, "session.idle", null)).toBe(true)
    expect(matchesEventTrigger({ type: "event", event: "session.idle" }, "message.updated", null)).toBe(false)
  })

  test("rejects non-event triggers", () => {
    expect(matchesEventTrigger({ type: "tool.before", tool: "bash" }, "session.idle", null)).toBe(false)
    expect(matchesEventTrigger(undefined, "session.idle", null)).toBe(false)
  })

  test("applies the role filter on message.updated", () => {
    const trigger = { type: "event", event: "message.updated", role: "user" }
    expect(matchesEventTrigger(trigger, "message.updated", "user")).toBe(true)
    expect(matchesEventTrigger(trigger, "message.updated", "assistant")).toBe(false)
    expect(matchesEventTrigger(trigger, "message.updated", null)).toBe(false)
  })

  test("message.updated without a role filter matches any role", () => {
    const trigger = { type: "event", event: "message.updated" }
    expect(matchesEventTrigger(trigger, "message.updated", "assistant")).toBe(true)
    expect(matchesEventTrigger(trigger, "message.updated", null)).toBe(true)
  })
})

describe("matchesToolTrigger", () => {
  test("matches on trigger type and tool name", () => {
    expect(matchesToolTrigger({ type: "tool.before", tool: "bash" }, "tool.before", "bash")).toBe(true)
    expect(matchesToolTrigger({ type: "tool.before", tool: "bash" }, "tool.after", "bash")).toBe(false)
    expect(matchesToolTrigger({ type: "tool.after", tool: "bash" }, "tool.after", "bash")).toBe(true)
    expect(matchesToolTrigger({ type: "tool.before", tool: "bash" }, "tool.before", "read")).toBe(false)
  })

  test("rejects malformed triggers", () => {
    expect(matchesToolTrigger(undefined, "tool.before", "bash")).toBe(false)
    expect(matchesToolTrigger({ type: "event", event: "session.idle" }, "tool.before", "bash")).toBe(false)
  })
})
