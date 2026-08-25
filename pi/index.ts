import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import {
  DEFAULT_CONFIG,
  getRandomSound,
  listPresets,
  loadConfig,
  loadPreset,
  matchesEventTrigger,
  matchesToolTrigger,
  pickWeightedPreset,
  playSound as playCoreSound,
} from "../lib/core.js"
import { shouldEnablePiSession, type PiSoundAction, translatePiEvent } from "./events.js"
import {
  deletePiState,
  gcPiState,
  type PiRuntimeState,
  readPiState,
  writePiState,
} from "./state.js"

interface OpenPeonTrigger {
  type: "event" | "tool.before" | "tool.after"
  event?: string
  role?: string
  tool?: string
}

interface OpenPeonMapping {
  name?: string
  whisper?: boolean
  triggers?: OpenPeonTrigger[]
  sounds?: string[]
}

interface OpenPeonConfig {
  volume?: number
  randomPreset?: boolean
  mappings?: OpenPeonMapping[]
  tier?: number
}

interface PiSessionState {
  preset: string | null
}

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.OPENPEON_ROOT || resolve(EXTENSION_DIR, "..")
const PI_STATE_ROOT = process.env.OPENPEON_PI_STATE_ROOT
  || process.env.OPENPEON_ROOT
  || resolve(homedir(), ".pi", "agent", "openpeon")
const CONFIG_PATH = resolve(ROOT, "openpeon.json")
const DEPLOYED_PRESETS_DIR = resolve(ROOT, "presets")
const PRESETS_DIR = existsSync(DEPLOYED_PRESETS_DIR)
  ? DEPLOYED_PRESETS_DIR
  : resolve(ROOT, "ui", "presets")
const SOUNDS_DIR = resolve(ROOT, "sounds")
const DEBUG_LOG_PATH = resolve(ROOT, "debug.log")
const PLAYER_PATH =
  process.platform === "darwin" ? "/usr/bin/afplay"
  : process.platform === "linux" ? "/usr/bin/pw-play"
  : null

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown"
}

function getConfig(value: unknown): OpenPeonConfig {
  return value as OpenPeonConfig
}

export default function openPeonExtension(pi: ExtensionAPI): void {
  let audioDisabled: boolean = !PLAYER_PATH || !existsSync(PLAYER_PATH)
  let baseConfig: OpenPeonConfig = getConfig(DEFAULT_CONFIG)
  let baseMappings: OpenPeonMapping[] = getConfig(DEFAULT_CONFIG).mappings ?? []
  let baseVolume: number = getConfig(DEFAULT_CONFIG).volume ?? 5
  let mappings: OpenPeonMapping[] = baseMappings
  let volume: number = baseVolume
  let currentPreset: string | null = null
  let sessionId: string | null = null
  let isWhisperEnabled: boolean = true
  let isSessionEnabled: boolean = false
  let areToolsRegistered: boolean = false

  function logDebug(message: string, extra?: Record<string, unknown>): void {
    let line: string

    if (!process.env.OPENPEON_DEBUG) {
      return
    }

    line = `${new Date().toISOString()} ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`
    try {
      appendFileSync(DEBUG_LOG_PATH, line)
    } catch {}
  }

  function playMappingSound(mapping: OpenPeonMapping, source: string): void {
    let soundFile: string | null

    if (audioDisabled || !PLAYER_PATH) {
      return
    }

    soundFile = getRandomSound(mapping.sounds)
    if (!soundFile) {
      logDebug("mapping-skip", { name: mapping.name ?? null, reason: "no-sounds", source })
      return
    }

    logDebug("mapping-play", {
      name: mapping.name ?? null,
      soundFile,
      source,
      whisper: isWhisperEnabled && Boolean(mapping.whisper),
      volume,
    })
    playCoreSound(
      PLAYER_PATH,
      resolve(SOUNDS_DIR, soundFile),
      volume,
      isWhisperEnabled && Boolean(mapping.whisper),
      (error: unknown, reason: string) => {
        audioDisabled = true
        logDebug(reason, { message: getErrorMessage(error) })
      },
    )
  }

  function matchesAction(mapping: OpenPeonMapping, action: PiSoundAction): boolean {
    return Boolean(mapping.triggers?.some((trigger) => {
      let matchesEvent: boolean
      let matchesTool: boolean

      matchesEvent = action.eventTypes.some((eventType) =>
        matchesEventTrigger(trigger, eventType, action.messageRole)
      )
      matchesTool = Boolean(
        action.toolTrigger
        && matchesToolTrigger(trigger, action.toolTrigger.type, action.toolTrigger.tool)
      )
      return matchesEvent || matchesTool
    }))
  }

  function fireAction(
    action: PiSoundAction | null,
    source: string,
    shouldPersistPreset: boolean = false,
  ): void {
    if (!isSessionEnabled || !action) {
      return
    }

    syncRuntimeState(shouldPersistPreset)
    for (const mapping of mappings) {
      if (matchesAction(mapping, action)) {
        playMappingSound(mapping, source)
      }
    }
  }

  function activatePreset(presetName: string): boolean {
    let presetConfig: OpenPeonConfig | null

    presetConfig = getConfig(loadPreset(PRESETS_DIR, presetName))
    if (!presetConfig) {
      return false
    }

    mappings = Array.isArray(presetConfig.mappings) ? presetConfig.mappings : baseMappings
    volume = typeof presetConfig.volume === "number" ? presetConfig.volume : baseVolume
    currentPreset = presetName
    logDebug("preset-switched", { preset: presetName })
    return true
  }

  function getSessionPreset(ctx: ExtensionContext): string | null | undefined {
    let savedPreset: string | null | undefined

    for (const entry of ctx.sessionManager.getBranch()) {
      let state: PiSessionState | undefined

      if (entry.type !== "custom" || entry.customType !== "openpeon-state") {
        continue
      }

      state = entry.data as PiSessionState | undefined
      if (state && (typeof state.preset === "string" || state.preset === null)) {
        savedPreset = state.preset
      }
    }

    return savedPreset
  }

  function loadActiveConfig(savedPreset: string | null | undefined): void {
    let loadedConfig: OpenPeonConfig
    let presetNames: string[]
    let pickedPreset: string | null

    loadedConfig = getConfig(loadConfig(CONFIG_PATH, logDebug))
    baseConfig = { ...loadedConfig }
    baseMappings = Array.isArray(loadedConfig.mappings)
      ? loadedConfig.mappings
      : getConfig(DEFAULT_CONFIG).mappings ?? []
    baseVolume = typeof loadedConfig.volume === "number"
      ? loadedConfig.volume
      : getConfig(DEFAULT_CONFIG).volume ?? 5
    mappings = baseMappings
    volume = baseVolume
    currentPreset = null

    if (savedPreset !== undefined) {
      if (savedPreset && !activatePreset(savedPreset)) {
        logDebug("preset-missing", { preset: savedPreset })
      }
      return
    }

    if (!loadedConfig.randomPreset) {
      return
    }

    presetNames = listPresets(PRESETS_DIR)
    pickedPreset = pickWeightedPreset(PRESETS_DIR, presetNames)
    if (pickedPreset && activatePreset(pickedPreset)) {
      logDebug("random-preset", { preset: pickedPreset })
    }
  }

  function syncRuntimeState(shouldPersistPreset: boolean): void {
    let state: PiRuntimeState | null
    let previousPreset: string | null
    let hasValidPreset: boolean

    state = readPiState(PI_STATE_ROOT, sessionId)
    if (!state) {
      return
    }

    previousPreset = currentPreset
    hasValidPreset = typeof state.preset === "string" || state.preset === null
    mappings = baseMappings
    volume = baseVolume
    currentPreset = null
    if (typeof state.preset === "string" && !activatePreset(state.preset)) {
      logDebug("preset-missing", { preset: state.preset })
    }
    if (typeof state.volume === "number") {
      volume = Math.max(0, Math.min(10, state.volume))
    }
    isWhisperEnabled = state.whisper !== false

    if (shouldPersistPreset && hasValidPreset && previousPreset !== currentPreset) {
      pi.appendEntry<PiSessionState>("openpeon-state", { preset: currentPreset })
    }
  }

  function writeCurrentState(patch: PiRuntimeState): void {
    if (!sessionId) {
      return
    }

    writePiState(PI_STATE_ROOT, sessionId, patch)
  }

  function switchPreset(presetName: string): string {
    let mappingNames: string
    let availablePresets: string[]

    if (!activatePreset(presetName)) {
      availablePresets = listPresets(PRESETS_DIR)
      return `Preset "${presetName}" not found. Available: ${availablePresets.join(", ") || "none"}`
    }

    pi.appendEntry<PiSessionState>("openpeon-state", { preset: presetName })
    writeCurrentState({ preset: presetName })
    mappingNames = mappings.map((mapping) => mapping.name ?? "unnamed").join(", ")
    return `Switched to preset "${presetName}". Active mappings: ${mappingNames}`
  }

  pi.on("session_start", (event, ctx) => {
    let savedPreset: string | null | undefined
    let diskState: PiRuntimeState | null
    let sessionFile: string | undefined

    isSessionEnabled = shouldEnablePiSession(ctx.mode)
    if (!isSessionEnabled) {
      logDebug("session-muted", { mode: ctx.mode })
      return
    }

    registerTools()
    sessionId = ctx.sessionManager.getSessionId()
    sessionFile = ctx.sessionManager.getSessionFile()
    gcPiState(PI_STATE_ROOT)
    diskState = readPiState(PI_STATE_ROOT, sessionId)
    savedPreset = diskState && (typeof diskState.preset === "string" || diskState.preset === null)
      ? diskState.preset
      : getSessionPreset(ctx)
    loadActiveConfig(savedPreset)
    if (savedPreset === undefined && baseConfig.randomPreset) {
      pi.appendEntry<PiSessionState>("openpeon-state", { preset: currentPreset })
    }
    writeCurrentState({
      preset: currentPreset,
      cwd: ctx.cwd,
      root: ROOT,
      ...(sessionFile ? { sessionFile } : {}),
    })
    fireAction(translatePiEvent("session_start", event), `session_start:${event.reason}`)
  })

  pi.on("input", (event, ctx) => {
    fireAction(translatePiEvent("input"), `input:${event.source}`, true)
    writeCurrentState({ preset: currentPreset, cwd: ctx.cwd, root: ROOT })
  })

  pi.on("agent_settled", () => {
    fireAction(translatePiEvent("agent_settled"), "agent_settled")
  })

  pi.on("user_bash", () => {
    fireAction(translatePiEvent("user_bash"), "user_bash")
  })

  pi.on("tool_execution_start", (event) => {
    fireAction(translatePiEvent("tool_execution_start", event), `tool.before:${event.toolName}`)
  })

  pi.on("tool_execution_end", (event) => {
    fireAction(translatePiEvent("tool_execution_end", event), `tool.after:${event.toolName}`)
  })

  pi.on("session_shutdown", (event) => {
    if (isSessionEnabled && event.reason !== "reload") {
      deletePiState(PI_STATE_ROOT, sessionId)
    }
  })

  function registerTools(): void {
    if (areToolsRegistered) {
      return
    }
    areToolsRegistered = true

    pi.registerTool({
      name: "peon_list_presets",
      label: "List OpenPeon Presets",
      description: "List available OpenPeon sound presets",
      parameters: Type.Object({}),
      async execute() {
        let presetNames: string[]
        let lines: string[]

        presetNames = listPresets(PRESETS_DIR)
        if (presetNames.length === 0) {
          return {
            content: [{ type: "text", text: "No presets available. Create presets using the OpenPeon UI (bun run ui)." }],
            details: {},
          }
        }

        lines = ["Available presets:"]
        for (const presetName of presetNames) {
          let presetConfig: OpenPeonConfig | null
          let activeLabel: string
          let tierLabel: string

          presetConfig = getConfig(loadPreset(PRESETS_DIR, presetName))
          activeLabel = presetName === currentPreset ? " (active)" : ""
          tierLabel = presetConfig?.tier ? ` [tier ${presetConfig.tier}]` : ""
          lines.push(`  - ${presetName}${tierLabel}${activeLabel}`)
        }

        return { content: [{ type: "text", text: lines.join("\n") }], details: {} }
      },
    })

    pi.registerTool({
      name: "peon_switch_preset",
      label: "Switch OpenPeon Preset",
      description: "Switch to a different OpenPeon sound preset. Use peon_list_presets to see available presets.",
      parameters: Type.Object({
        preset: Type.String({ description: "Name of the preset to switch to" }),
      }),
      async execute(_toolCallId, params) {
        return {
          content: [{ type: "text", text: switchPreset(params.preset) }],
          details: { preset: currentPreset },
        }
      },
    })

    pi.registerTool({
      name: "peon_current_config",
      label: "Show OpenPeon Config",
      description: "Show the current OpenPeon sound configuration",
      parameters: Type.Object({}),
      async execute() {
        let lines: string[]

        lines = [
          `Current preset: ${currentPreset ?? "(default config)"}`,
          `Volume: ${volume}/10`,
          `Mappings (${mappings.length}):`,
        ]
        for (const mapping of mappings) {
          lines.push(`  ${mapping.name ?? "unnamed"}:`)
          lines.push(`    triggers: ${mapping.triggers?.length ?? 0}`)
          lines.push(`    sounds: ${mapping.sounds?.length ?? 0}`)
        }

        return { content: [{ type: "text", text: lines.join("\n") }], details: {} }
      },
    })

    pi.registerTool({
      name: "peon_set_volume",
      label: "Set OpenPeon Volume",
      description: "Set the OpenPeon sound volume from 0 (mute) to 10 (loud)",
      parameters: Type.Object({
        level: Type.Number({ description: "Volume level from 0 to 10", minimum: 0, maximum: 10 }),
      }),
      async execute(_toolCallId, params) {
        let saved: boolean = true
        let saveError: string | null = null

        volume = Math.round(Math.max(0, Math.min(10, params.level)))
        baseVolume = volume
        baseConfig.volume = volume
        writeCurrentState({ volume })

        try {
          writeFileSync(CONFIG_PATH, `${JSON.stringify(baseConfig, null, 2)}\n`)
          logDebug("volume-set", { volume, saved: true })
        } catch (error) {
          saved = false
          saveError = getErrorMessage(error)
          logDebug("volume-set", { volume, saved: false, error: saveError })
        }

        return {
          content: [{
            type: "text",
            text: saved
              ? `Volume set to ${volume}/10 and saved to config.`
              : `Volume set to ${volume}/10 (not saved to config: ${saveError}).`,
          }],
          details: { volume, saved },
        }
      },
    })
  }

  logDebug("initialized", { player: PLAYER_PATH, audioDisabled })
}
