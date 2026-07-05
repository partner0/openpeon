import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
  appendFileSync,
} from "fs"
import {
  DEFAULT_CONFIG,
  getRandomSound,
  loadConfig,
  listPresets,
  loadPreset,
  pickWeightedPreset,
  matchesEventTrigger,
  matchesToolTrigger,
  playSound,
} from "../lib/core.js"

// Claude Code hook adapter. Claude Code spawns this script per hook event and
// pipes a JSON payload to stdin. It translates the payload into OpenPeon's
// trigger vocabulary, resolves config through the per-session state file, and
// plays the matching sound.
//
// Safety rules:
// - NEVER write to stdout: a PermissionRequest hook emitting JSON can
//   auto-approve or deny permission dialogs. Debug goes to <root>/debug.log.
// - Always exit 0, and never call process.exit(): playSound defers its spawn
//   through a timer, so an explicit exit would cut the sound off.

const __dirname = dirname(fileURLToPath(import.meta.url))

// Install root (~/.claude/openpeon once deployed): config, presets, sounds,
// state, and debug log all live under it. OPENPEON_ROOT overrides it for tests.
const ROOT = process.env.OPENPEON_ROOT || resolve(__dirname, "..")

const AFPLAY_PATH = "/usr/bin/afplay"
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export const TOOL_NAME_MAP = {
  Bash: "bash",
  Read: "read",
  Write: "write",
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "webfetch",
  TodoWrite: "todowrite",
  AskUserQuestion: "question",
  Task: "task",
  Skill: "skill",
}

export function mapToolName(toolName) {
  if (typeof toolName !== "string" || toolName.length === 0) {
    return null
  }

  return TOOL_NAME_MAP[toolName] ?? toolName.toLowerCase()
}

// Translate a Claude Code hook payload into an OpenPeon action:
//   { kind: "event", eventType, messageRole }  -> match event triggers
//   { kind: "tool", triggerType, tool }        -> match tool triggers
//   { kind: "state-only" }                     -> state upkeep, no sound
//   { kind: "cleanup" }                        -> delete session state
//   null                                       -> ignore
export function translateHookEvent(payload) {
  switch (payload?.hook_event_name) {
    case "SessionStart":
      // A compact restart is mid-session: keep the state fresh, no welcome sound
      return payload.source === "compact"
        ? { kind: "state-only" }
        : { kind: "event", eventType: "openpeon.startup", messageRole: null }
    case "UserPromptSubmit":
      return { kind: "event", eventType: "message.updated", messageRole: "user" }
    case "Stop":
      return { kind: "event", eventType: "session.idle", messageRole: null }
    case "PermissionRequest":
      return { kind: "event", eventType: "permission.asked", messageRole: null }
    case "PreToolUse":
      return { kind: "tool", triggerType: "tool.before", tool: mapToolName(payload.tool_name) }
    case "PostToolUse":
      return { kind: "tool", triggerType: "tool.after", tool: mapToolName(payload.tool_name) }
    case "SessionEnd":
      return { kind: "cleanup" }
    default:
      return null
  }
}

export function sanitizeSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return null
  }

  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function statePath(root, sessionId) {
  const sanitized = sanitizeSessionId(sessionId)
  if (!sanitized) {
    return null
  }

  return resolve(root, "state", `${sanitized}.json`)
}

export function readState(root, sessionId) {
  const path = statePath(root, sessionId)
  if (!path || !existsSync(path)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

export function writeState(root, sessionId, state) {
  const path = statePath(root, sessionId)
  if (!path) {
    return
  }

  try {
    mkdirSync(resolve(root, "state"), { recursive: true })
    writeFileSync(path, JSON.stringify(state))
  } catch {
    // State is best-effort: without it the base config still plays
  }
}

export function deleteState(root, sessionId) {
  const path = statePath(root, sessionId)
  if (!path || !existsSync(path)) {
    return
  }

  try {
    unlinkSync(path)
  } catch {}
}

export function gcState(root, maxAgeMs = STATE_MAX_AGE_MS, now = Date.now()) {
  const stateDir = resolve(root, "state")
  if (!existsSync(stateDir)) {
    return
  }

  try {
    for (const file of readdirSync(stateDir)) {
      if (!file.endsWith(".json")) {
        continue
      }

      const path = resolve(stateDir, file)
      try {
        if (now - statSync(path).mtimeMs > maxAgeMs) {
          unlinkSync(path)
        }
      } catch {}
    }
  } catch {}
}

// Resolve the effective config for a session: base openpeon.json, overlaid
// with the session's preset. Rolls (and persists) a weighted preset on the
// first event of a session when randomPreset is enabled.
export function resolveSessionConfig(root, sessionId, random = Math.random) {
  const config = loadConfig(resolve(root, "openpeon.json"))
  let mappings = Array.isArray(config.mappings) ? config.mappings : DEFAULT_CONFIG.mappings
  let volume = typeof config.volume === "number" ? config.volume : DEFAULT_CONFIG.volume

  let state = readState(root, sessionId)
  if (!state && config.randomPreset && sanitizeSessionId(sessionId)) {
    const presetsDir = resolve(root, "presets")
    const picked = pickWeightedPreset(presetsDir, listPresets(presetsDir), random)
    state = { preset: picked }
    writeState(root, sessionId, state)
  }

  let preset = null
  if (state?.preset) {
    const presetConfig = loadPreset(resolve(root, "presets"), state.preset)
    if (presetConfig) {
      mappings = Array.isArray(presetConfig.mappings) ? presetConfig.mappings : mappings
      volume = typeof presetConfig.volume === "number" ? presetConfig.volume : volume
      preset = state.preset
    }
  }

  return { mappings, volume, preset }
}

function logDebug(message, extra) {
  if (!process.env.OPENPEON_DEBUG) {
    return
  }

  const line = `${new Date().toISOString()} ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`
  try {
    appendFileSync(resolve(ROOT, "debug.log"), line)
  } catch {}
}

function readStdin() {
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

function main() {
  let payload = null
  try {
    payload = JSON.parse(readStdin())
  } catch (error) {
    logDebug("payload-parse-error", { message: error?.message ?? "unknown" })
    return
  }

  const action = translateHookEvent(payload)
  const sessionId = payload?.session_id ?? null
  logDebug("hook", {
    event: payload?.hook_event_name ?? null,
    source: payload?.source ?? null,
    tool: payload?.tool_name ?? null,
    sessionId,
    action: action?.kind ?? "ignored",
  })

  if (!action) {
    return
  }

  if (action.kind === "cleanup") {
    deleteState(ROOT, sessionId)
    return
  }

  if (payload.hook_event_name === "SessionStart") {
    gcState(ROOT)
  }

  const { mappings, volume, preset } = resolveSessionConfig(ROOT, sessionId)

  if (action.kind === "state-only") {
    return
  }

  if (process.platform !== "darwin" || !existsSync(AFPLAY_PATH)) {
    logDebug("audio-disabled", { platform: process.platform })
    return
  }

  for (const mapping of mappings) {
    if (!mapping?.triggers || !mapping?.sounds) {
      continue
    }

    const matched = mapping.triggers.some((trigger) =>
      action.kind === "event"
        ? matchesEventTrigger(trigger, action.eventType, action.messageRole)
        : matchesToolTrigger(trigger, action.triggerType, action.tool)
    )

    if (matched) {
      const soundFile = getRandomSound(mapping.sounds)
      if (!soundFile) {
        logDebug("mapping-skip", { name: mapping.name, reason: "no-sounds" })
        continue
      }

      logDebug("mapping-play", { name: mapping.name, soundFile, preset, volume, whisper: Boolean(mapping.whisper) })
      playSound(AFPLAY_PATH, resolve(ROOT, "sounds", soundFile), volume, Boolean(mapping.whisper), (error, reason) => {
        logDebug(reason, { message: error?.message ?? "unknown" })
      })
    }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    main()
  } catch (error) {
    logDebug("hook-error", { message: error?.message ?? "unknown" })
  }
}
