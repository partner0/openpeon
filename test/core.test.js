import { describe, expect, test } from "bun:test"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import {
  DEFAULT_CONFIG,
  computeAfplayVolume,
  getRandomSound,
  listPresets,
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
  test("returns DEFAULT_CONFIG when the file is missing", () => {
    expect(loadConfig(resolve(CONFIGS_DIR, "does-not-exist.json"))).toBe(DEFAULT_CONFIG)
  })

  test("returns DEFAULT_CONFIG on invalid JSON", () => {
    expect(loadConfig(resolve(CONFIGS_DIR, "broken.json"))).toBe(DEFAULT_CONFIG)
  })

  test("returns DEFAULT_CONFIG when mappings is missing", () => {
    expect(loadConfig(resolve(CONFIGS_DIR, "no-mappings.json"))).toBe(DEFAULT_CONFIG)
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

  test("returns null for a missing preset", () => {
    expect(loadPreset(PRESETS_DIR, "does-not-exist")).toBeNull()
  })

  test("returns null on invalid JSON", () => {
    expect(loadPreset(PRESETS_DIR, "broken")).toBeNull()
  })
})

describe("pickWeightedPreset", () => {
  // Weights: tier1 = 3, tier3 = 1, no-tier = 2 (default), broken = 2 (default)
  const names = ["tier1", "tier3", "no-tier"]

  test("returns null for an empty list", () => {
    expect(pickWeightedPreset(PRESETS_DIR, [], () => 0)).toBeNull()
  })

  test("a low roll lands in the first (tier 1, weight 3) bucket", () => {
    expect(pickWeightedPreset(PRESETS_DIR, names, () => 0)).toBe("tier1")
    expect(pickWeightedPreset(PRESETS_DIR, names, () => 0.49)).toBe("tier1")
  })

  test("a mid roll lands in the tier 3 (weight 1) bucket", () => {
    // total weight 6, roll 0.55 * 6 = 3.3 falls past tier1 (3) into tier3 (3..4)
    expect(pickWeightedPreset(PRESETS_DIR, names, () => 0.55)).toBe("tier3")
  })

  test("a high roll lands in the default-weight bucket", () => {
    // roll 0.9 * 6 = 5.4 falls past tier1+tier3 (4) into no-tier (4..6)
    expect(pickWeightedPreset(PRESETS_DIR, names, () => 0.9)).toBe("no-tier")
  })

  test("tier order follows weights, not list order", () => {
    // total weight 1 + 3 = 4, roll 0.4 * 4 = 1.6 skips tier3 (1) into tier1
    expect(pickWeightedPreset(PRESETS_DIR, ["tier3", "tier1"], () => 0.4)).toBe("tier1")
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

  test("returns an element of the list", () => {
    const sounds = ["a.wav", "b.wav", "c.wav"]
    expect(sounds).toContain(getRandomSound(sounds))
  })
})

describe("computeAfplayVolume", () => {
  test("volume 0 is mute", () => {
    expect(computeAfplayVolume(0, false)).toBe(0)
  })

  test("volume 10 is full afplay volume", () => {
    expect(computeAfplayVolume(10, false)).toBe(1)
  })

  test("the curve is exponential (perceptually linear)", () => {
    expect(computeAfplayVolume(5, false)).toBe(0.25)
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
