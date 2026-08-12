import { resolve } from "path"
import { existsSync, readFileSync, readdirSync } from "fs"
import { spawn } from "child_process"

// Shared core for the OpenCode plugin (index.js) and the Claude Code hook
// adapter (claude/hook.js). Must stay dependency-free (no @opencode-ai/plugin,
// no Bun-only APIs) so it runs under both bun and node.

export const DEFAULT_CONFIG = {
  volume: 5,
  mappings: [
    {
      name: "acknowledge",
      triggers: [
        { type: "event", event: "tui.command.execute" },
        { type: "event", event: "command.executed" },
        { type: "event", event: "permission.replied" },
        { type: "event", event: "message.updated", role: "user" },
      ],
      sounds: [
        "acknowledge1.wav",
        "acknowledge2.wav",
        "acknowledge3.wav",
        "acknowledge4.wav",
      ],
    },
    {
      name: "work-complete",
      triggers: [{ type: "event", event: "session.idle" }],
      sounds: ["work-complete.wav"],
    },
    {
      name: "permission-asked",
      triggers: [
        { type: "event", event: "permission.asked" },
        { type: "tool.before", tool: "question" },
      ],
      sounds: ["selected4.wav"],
    },
  ],
}

export function getRandomSound(sounds) {
  if (!Array.isArray(sounds) || sounds.length === 0) {
    return null
  }

  const index = Math.floor(Math.random() * sounds.length)
  return sounds[index]
}

export function loadConfig(configPath, logDebug = () => {}) {
  if (!existsSync(configPath)) {
    logDebug("config-missing", { path: configPath })
    return DEFAULT_CONFIG
  }

  try {
    const contents = readFileSync(configPath, "utf8")
    const parsed = JSON.parse(contents)
    if (!parsed || !Array.isArray(parsed.mappings)) {
      logDebug("config-invalid", { reason: "missing-mappings" })
      return DEFAULT_CONFIG
    }

    return parsed
  } catch (error) {
    logDebug("config-error", { message: error?.message ?? "unknown" })
    return DEFAULT_CONFIG
  }
}

export function listPresets(presetsDir) {
  if (!existsSync(presetsDir)) {
    return []
  }

  try {
    const files = readdirSync(presetsDir)
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""))
  } catch {
    return []
  }
}

export function loadPreset(presetsDir, presetName) {
  const presetPath = resolve(presetsDir, `${presetName}.json`)
  if (!existsSync(presetPath)) {
    return null
  }

  try {
    const contents = readFileSync(presetPath, "utf8")
    return JSON.parse(contents)
  } catch {
    return null
  }
}

// Tier weights: tier 1 = 3, tier 2 = 2, tier 3 = 1 (~50%, ~33%, ~17%)
export const TIER_WEIGHTS = { 1: 3, 2: 2, 3: 1 }
export const DEFAULT_TIER_WEIGHT = 2

export function pickWeightedPreset(presetsDir, presetNames, random = Math.random) {
  if (presetNames.length === 0) {
    return null
  }

  const weighted = presetNames.map((name) => {
    const config = loadPreset(presetsDir, name)
    const tier = config?.tier
    const weight = typeof tier === "number" && TIER_WEIGHTS[tier] != null ? TIER_WEIGHTS[tier] : DEFAULT_TIER_WEIGHT
    return { name, weight }
  })

  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0)
  let roll = random() * totalWeight

  for (const entry of weighted) {
    roll -= entry.weight
    if (roll <= 0) {
      return entry.name
    }
  }

  return weighted[weighted.length - 1].name
}

export const WHISPER_VOLUME = 1

export function computeAfplayVolume(volume, whisper) {
  // Precedence: mute > whisper > volume. A muted session (volume <= 0) stays
  // silent even for whispered mappings.
  if (!(volume > 0)) {
    return 0
  }

  // Convert volume 0-10 to afplay volume 0-1 with exponential curve
  // This makes perceived loudness feel linear to human ears
  const effectiveVolume = whisper ? WHISPER_VOLUME : volume
  const normalized = effectiveVolume / 10
  return Math.pow(normalized, 2)
}

export function playSound(playerPath, soundPath, volume, whisper, onError) {
  const playerVolume = computeAfplayVolume(volume, whisper)
  if (playerVolume <= 0) {
    return
  }

  // afplay (macOS) and pw-play (Linux/PipeWire) both take linear 0-1 volume,
  // they just spell the flag differently.
  const volumeFlag = playerPath.endsWith("pw-play") ? "--volume" : "-v"

  setTimeout(() => {
    try {
      const child = spawn(playerPath, [volumeFlag, String(playerVolume), soundPath], {
        stdio: "ignore",
        detached: true,
      })

      child.on("error", (error) => onError?.(error, "afplay-error"))

      child.unref()
    } catch (error) {
      onError?.(error, "spawn-failed")
    }
  }, 0)
}

export function matchesEventTrigger(trigger, eventType, messageRole) {
  if (trigger?.type !== "event") {
    return false
  }

  if (trigger.event !== eventType) {
    return false
  }

  if (eventType === "message.updated" && trigger.role) {
    return trigger.role === messageRole
  }

  return true
}

export function matchesToolTrigger(trigger, triggerType, toolName) {
  return trigger?.type === triggerType && trigger?.tool === toolName
}
