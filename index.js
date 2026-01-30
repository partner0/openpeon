import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { existsSync, appendFile } from "fs"
import { spawn } from "child_process"
import { homedir } from "os"

const __dirname = dirname(fileURLToPath(import.meta.url))

const ACKNOWLEDGE_SOUNDS = [
  "acknowledge1.wav",
  "acknowledge2.wav",
  "acknowledge3.wav",
  "acknowledge4.wav",
]

const WORK_COMPLETE_SOUND = "work-complete.wav"
const PERMISSION_ASKED_SOUND = "selected4.wav"

function getRandomAcknowledge() {
  const index = Math.floor(Math.random() * ACKNOWLEDGE_SOUNDS.length)
  return ACKNOWLEDGE_SOUNDS[index]
}

function getSoundPath(filename) {
  return resolve(__dirname, "sounds", filename)
}

export const PeonPlugin = async ({ client }) => {
  const debug = Boolean(process.env.OPENCODE_PEON_DEBUG)
  const debugLogPath = resolve(homedir(), ".config", "opencode", "peon-debug.log")

  const logDebug = (message, extra) => {
    if (!debug) {
      return
    }

    const line = `${new Date().toISOString()} ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`
    appendFile(debugLogPath, line, () => {})
  }
  logDebug("initialized")

  let lastUserCommandTime = 0
  const DEBOUNCE_MS = 500
  let audioDisabled = false
  let lastMessageId = null
  let lastPermissionAskedTime = 0
  const PERMISSION_DEBOUNCE_MS = 100

  const isDarwin = process.platform === "darwin"
  const afplayPath = Bun?.which?.("afplay") ?? "/usr/bin/afplay"

  if (!isDarwin) {
    audioDisabled = true
    logDebug("disabled", { reason: "non-macos" })
  } else if (!existsSync(afplayPath)) {
    audioDisabled = true
    logDebug("disabled", { reason: "afplay-missing", path: afplayPath })
  }

  const playSound = (soundFile) => {
    if (audioDisabled) {
      return
    }
    const soundPath = getSoundPath(soundFile)

    setTimeout(() => {
      try {
        const child = spawn(afplayPath, [soundPath], {
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

  const triggerPermissionAsked = (source) => {
    const now = Date.now()
    if (now - lastPermissionAskedTime < PERMISSION_DEBOUNCE_MS) {
      logDebug("permission-asked-skip", { source, reason: "debounced" })
      return
    }

    lastPermissionAskedTime = now
    logDebug("permission-asked", { source })
    playSound(PERMISSION_ASKED_SOUND)
  }

  const shouldTriggerPermissionFromText = (text) => {
    if (typeof text !== "string") {
      return false
    }

    const normalized = text.toLowerCase()
    return (
      normalized.includes("permission") ||
      normalized.includes("allow") ||
      normalized.includes("approve") ||
      normalized.includes("deny") ||
      normalized.includes("grant")
    )
  }

  const extractPromptText = (payload) => {
    if (!payload) {
      return null
    }

    return (
      payload.text ??
      payload.value ??
      payload.prompt ??
      payload.append ??
      payload.content ??
      null
    )
  }

  return {
    event: ({ event }) => {
      if (
        event.type === "message.updated" ||
        event.type === "tui.command.execute" ||
        event.type === "command.executed" ||
        event.type === "session.idle" ||
        event.type === "permission.asked" ||
        event.type === "permission.replied" ||
        event.type === "tui.prompt.append"
      ) {
        const info = event.properties?.info
        logDebug(`event ${event.type}`, {
          propertiesKeys: event.properties ? Object.keys(event.properties) : [],
          role: event.properties?.role ?? null,
          id: event.properties?.id ?? null,
          messageId: event.properties?.message_id ?? null,
          infoKeys: info ? Object.keys(info) : [],
          infoRole: info?.role ?? info?.author?.role ?? null,
          infoId: info?.id ?? null,
          infoContentType: typeof info?.content,
          infoContentLength: typeof info?.content === "string" ? info.content.length : null,
          promptTextType: typeof event.properties?.text,
          promptTextLength:
            typeof event.properties?.text === "string" ? event.properties.text.length : null,
        })
      }

      if (
        event.type === "tui.command.execute" ||
        event.type === "command.executed" ||
        event.type === "permission.replied"
      ) {
        const now = Date.now()
        if (now - lastUserCommandTime > DEBOUNCE_MS) {
          lastUserCommandTime = now
          const soundFile = getRandomAcknowledge()
          playSound(soundFile)
        }
      }

      if (event.type === "message.updated") {
        const info = event.properties?.info
        const infoRole = info?.role ?? info?.author?.role ?? null
        if (infoRole && infoRole !== "user") {
          return
        }

        const messageId = info?.id ?? null
        if (messageId && lastMessageId === messageId) {
          logDebug("message-skip", { reason: "duplicate", messageId })
          return
        }

        if (messageId) {
          lastMessageId = messageId
          const soundFile = getRandomAcknowledge()
          logDebug("message-play", { messageId, soundFile })
          playSound(soundFile)
        } else {
          logDebug("message-skip", { reason: "missing-id" })
        }
      }

      if (event.type === "session.idle") {
        playSound(WORK_COMPLETE_SOUND)
      }

      if (event.type === "permission.asked") {
        triggerPermissionAsked("event")
      }

      if (event.type === "tui.prompt.append") {
        const promptText = extractPromptText(event.properties)
        if (shouldTriggerPermissionFromText(promptText)) {
          triggerPermissionAsked("tui.prompt.append")
        }
      }
    },
    "permission.asked": () => {
      triggerPermissionAsked("hook")
    },
    "tui.prompt.append": (input) => {
      const promptText = extractPromptText(input)
      if (shouldTriggerPermissionFromText(promptText)) {
        triggerPermissionAsked("tui.prompt.append:hook")
      }
    },
    "tool.execute.before": async (input) => {
      logDebug("tool.execute.before", { tool: input?.tool ?? null })
      if (input.tool === "question") {
        triggerPermissionAsked("tool.question")
      }
    },
  }
}
