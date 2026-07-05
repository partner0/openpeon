import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { existsSync, appendFile } from "fs"
import { homedir } from "os"
import { tool } from "@opencode-ai/plugin"
import {
  DEFAULT_CONFIG,
  getRandomSound,
  loadConfig,
  listPresets,
  loadPreset,
  pickWeightedPreset,
  matchesEventTrigger,
  matchesToolTrigger,
  playSound as corePlaySound,
} from "./lib/core.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

function getSoundPath(filename) {
  return resolve(__dirname, "sounds", filename)
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

  const playSound = (soundFile, whisper) => {
    if (audioDisabled) {
      return
    }

    corePlaySound(afplayPath, getSoundPath(soundFile), volume, whisper, (error, reason) => {
      audioDisabled = true
      logDebug(reason, { message: error?.message ?? "unknown" })
    })
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
      const picked = pickWeightedPreset(presetsDir, presets)
      const presetConfig = picked ? loadPreset(presetsDir, picked) : null
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

        const matched = mapping.triggers.some((trigger) =>
          matchesToolTrigger(trigger, "tool.before", toolName)
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

        const matched = mapping.triggers.some((trigger) =>
          matchesToolTrigger(trigger, "tool.after", toolName)
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
            const presetConfig = loadPreset(presetsDir, preset)
            const tierLabel = presetConfig?.tier ? ` [tier ${presetConfig.tier}]` : ""
            lines.push(`  - ${preset}${tierLabel}${marker}`)
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
        description: "Set the OpenPeon sound volume (0-10)",
        args: {
          level: tool.schema.number().describe("Volume level from 0 (mute) to 10 (loud)"),
        },
        async execute(args) {
          const newVolume = Math.round(Math.max(0, Math.min(10, args.level)))
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
