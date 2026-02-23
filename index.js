import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { existsSync, appendFile, readFileSync, readdirSync } from "fs"
import { spawn } from "child_process"
import { homedir } from "os"
import { tool } from "@opencode-ai/plugin"

const __dirname = dirname(fileURLToPath(import.meta.url))

const DEFAULT_CONFIG = {
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

function getSoundPath(filename) {
  return resolve(__dirname, "sounds", filename)
}

function getRandomSound(sounds) {
  if (!Array.isArray(sounds) || sounds.length === 0) {
    return null
  }

  const index = Math.floor(Math.random() * sounds.length)
  return sounds[index]
}

function loadConfig(configPath, logDebug) {
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

function listPresets(presetsDir) {
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

function loadPreset(presetsDir, presetName) {
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

export const OpenPeonPlugin = async ({ client }) => {
  const debug = Boolean(process.env.OPENPEON_DEBUG)
  const debugLogPath = resolve(homedir(), ".config", "opencode", "openpeon-debug.log")

  const logDebug = (message, extra) => {
    if (!debug) {
      return
    }

    const line = `${new Date().toISOString()} ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`
    appendFile(debugLogPath, line, () => {})
  }
  logDebug("initialized")

  let audioDisabled = false
  let lastMessageId = null
  let lastPermissionRequestId = null

  const isDarwin = process.platform === "darwin"
  const afplayPath = Bun?.which?.("afplay") ?? "/usr/bin/afplay"

  if (!isDarwin) {
    audioDisabled = true
    logDebug("disabled", { reason: "non-macos" })
  } else if (!existsSync(afplayPath)) {
    audioDisabled = true
    logDebug("disabled", { reason: "afplay-missing", path: afplayPath })
  }

  const WHISPER_VOLUME = 1

  const playSound = (soundFile, whisper) => {
    if (audioDisabled) {
      return
    }
    const soundPath = getSoundPath(soundFile)
    // Convert volume 1-10 to afplay volume 0-1 with exponential curve
    // This makes perceived loudness feel linear to human ears
    const effectiveVolume = whisper ? WHISPER_VOLUME : volume
    const normalized = effectiveVolume / 10
    const afplayVolume = Math.pow(normalized, 2)

    setTimeout(() => {
      try {
        const child = spawn(afplayPath, ["-v", String(afplayVolume), soundPath], {
          stdio: "ignore",
          detached: true,
        })

        child.on("error", (error) => {
          audioDisabled = true
          logDebug("afplay-error", { message: error.message })
        })

        child.unref()
      } catch (error) {
        audioDisabled = true
        logDebug("spawn-failed", { message: error?.message ?? "unknown" })
      }
    }, 0)
  }

  const configPath = resolve(__dirname, "openpeon.json")
  const presetsDir = resolve(__dirname, "presets")
  let config = loadConfig(configPath, logDebug)
  let mappings = Array.isArray(config.mappings) ? config.mappings : DEFAULT_CONFIG.mappings
  let volume = typeof config.volume === "number" ? config.volume : DEFAULT_CONFIG.volume
  let currentPreset = null

  if (config.randomPreset) {
    const presets = listPresets(presetsDir)
    if (presets.length > 0) {
      const picked = presets[Math.floor(Math.random() * presets.length)]
      const presetConfig = loadPreset(presetsDir, picked)
      if (presetConfig) {
        mappings = Array.isArray(presetConfig.mappings) ? presetConfig.mappings : mappings
        volume = typeof presetConfig.volume === "number" ? presetConfig.volume : volume
        currentPreset = picked
        logDebug("random-preset", { preset: picked })
      }
    }
  }

  const reloadMappings = (newConfig) => {
    config = newConfig
    mappings = Array.isArray(config.mappings) ? config.mappings : DEFAULT_CONFIG.mappings
    volume = typeof config.volume === "number" ? config.volume : DEFAULT_CONFIG.volume
  }

  const playMappingSound = (mapping, source) => {
    const soundFile = getRandomSound(mapping.sounds)
    if (!soundFile) {
      logDebug("mapping-skip", { name: mapping.name, reason: "no-sounds", source })
      return
    }

    logDebug("mapping-play", { name: mapping.name, soundFile, source, whisper: Boolean(mapping.whisper) })
    playSound(soundFile, Boolean(mapping.whisper))
  }

  const matchesEventTrigger = (trigger, eventType, messageRole) => {
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

  const fireEvent = (eventType) => {
    for (const mapping of mappings) {
      if (!mapping?.triggers || !mapping?.sounds) {
        continue
      }

      const matched = mapping.triggers.some((trigger) =>
        matchesEventTrigger(trigger, eventType, null)
      )

      if (matched) {
        playMappingSound(mapping, `event:${eventType}`)
      }
    }
  }

  fireEvent("openpeon.startup")

  return {
    event: ({ event }) => {
      const info = event.properties?.info
      const messageRole = info?.role ?? info?.author?.role ?? null
      const messageId = info?.id ?? null
      const permissionRequestId = event.type === "permission.asked" ? event.properties?.id : null

      logDebug(`event ${event.type}`, {
        propertiesKeys: event.properties ? Object.keys(event.properties) : [],
        messageRole,
        messageId,
        permissionRequestId,
      })

      if (event.type === "message.updated" && messageId) {
        if (lastMessageId === messageId) {
          logDebug("message-skip", { reason: "duplicate", messageId })
          return
        }
      }

      if (event.type === "permission.asked" && permissionRequestId) {
        if (lastPermissionRequestId === permissionRequestId) {
          logDebug("permission-asked-skip", { reason: "duplicate", permissionRequestId })
          return
        }
      }

      for (const mapping of mappings) {
        if (!mapping?.triggers || !mapping?.sounds) {
          continue
        }

        const matched = mapping.triggers.some((trigger) =>
          matchesEventTrigger(trigger, event.type, messageRole)
        )

        if (matched) {
          if (event.type === "message.updated" && messageId) {
            lastMessageId = messageId
          }

          if (event.type === "permission.asked" && permissionRequestId) {
            lastPermissionRequestId = permissionRequestId
          }

          playMappingSound(mapping, `event:${event.type}`)
        }
      }
    },
    "tool.execute.before": async (input) => {
      logDebug("tool.execute.before", { tool: input?.tool ?? null })
      const toolName = input?.tool ?? null
      for (const mapping of mappings) {
        if (!mapping?.triggers || !mapping?.sounds) {
          continue
        }

        const matched = mapping.triggers.some(
          (trigger) => trigger?.type === "tool.before" && trigger?.tool === toolName
        )

        if (matched) {
          playMappingSound(mapping, `tool.before:${toolName}`)
        }
      }
    },
    "tool.execute.after": async (input) => {
      logDebug("tool.execute.after", { tool: input?.tool ?? null })
      const toolName = input?.tool ?? null
      for (const mapping of mappings) {
        if (!mapping?.triggers || !mapping?.sounds) {
          continue
        }

        const matched = mapping.triggers.some(
          (trigger) => trigger?.type === "tool.after" && trigger?.tool === toolName
        )

        if (matched) {
          playMappingSound(mapping, `tool.after:${toolName}`)
        }
      }
    },
    tool: {
      peon_list_presets: tool({
        description: "List available OpenPeon sound presets",
        args: {},
        async execute() {
          const presets = listPresets(presetsDir)
          if (presets.length === 0) {
            return "No presets available. Create presets using the OpenPeon UI (bun run ui)."
          }

          const lines = ["Available presets:"]
          for (const preset of presets) {
            const marker = preset === currentPreset ? " (active)" : ""
            lines.push(`  - ${preset}${marker}`)
          }
          return lines.join("\n")
        },
      }),
      peon_switch_preset: tool({
        description: "Switch to a different OpenPeon sound preset. Use peon_list_presets to see available presets.",
        args: {
          preset: tool.schema.string().describe("Name of the preset to switch to"),
        },
        async execute(args) {
          const presetName = args.preset
          const presetConfig = loadPreset(presetsDir, presetName)

          if (!presetConfig) {
            const available = listPresets(presetsDir)
            return `Preset "${presetName}" not found. Available: ${available.join(", ") || "none"}`
          }

          reloadMappings(presetConfig)
          currentPreset = presetName
          logDebug("preset-switched", { preset: presetName })

          const mappingNames = mappings.map((m) => m.name).join(", ")
          return `Switched to preset "${presetName}". Active mappings: ${mappingNames}`
        },
      }),
      peon_current_config: tool({
        description: "Show the current OpenPeon sound configuration",
        args: {},
        async execute() {
          const lines = [`Current preset: ${currentPreset ?? "(default config)"}`]
          lines.push(`Volume: ${volume}/10`)
          lines.push(`Mappings (${mappings.length}):`)

          for (const mapping of mappings) {
            lines.push(`  ${mapping.name}:`)
            lines.push(`    triggers: ${mapping.triggers?.length ?? 0}`)
            lines.push(`    sounds: ${mapping.sounds?.length ?? 0}`)
          }

          return lines.join("\n")
        },
      }),
      peon_set_volume: tool({
        description: "Set the OpenPeon sound volume (1-10)",
        args: {
          level: tool.schema.number().describe("Volume level from 1 (quiet) to 10 (loud)"),
        },
        async execute(args) {
          const newVolume = Math.round(Math.max(1, Math.min(10, args.level)))
          volume = newVolume
          config.volume = newVolume

          // Save to config file
          try {
            const { writeFileSync } = await import("fs")
            writeFileSync(configPath, JSON.stringify(config, null, 2))
            logDebug("volume-set", { volume: newVolume, saved: true })
            return `Volume set to ${newVolume}/10 and saved to config.`
          } catch (error) {
            logDebug("volume-set", { volume: newVolume, saved: false, error: error?.message })
            return `Volume set to ${newVolume}/10 (not saved to config: ${error?.message}).`
          }
        },
      }),
    },
  }
}
