import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"

export interface PiRuntimeState {
  preset?: string | null
  volume?: number
  whisper?: boolean
  cwd?: string
  root?: string
  sessionFile?: string
}

const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function sanitizePiSessionId(sessionId: unknown): string | null {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return null
  }

  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function getPiStatePath(stateRoot: string, sessionId: unknown): string | null {
  let sanitizedId: string | null

  sanitizedId = sanitizePiSessionId(sessionId)
  return sanitizedId ? resolve(stateRoot, "state", `${sanitizedId}.json`) : null
}

export function readPiState(stateRoot: string, sessionId: unknown): PiRuntimeState | null {
  let statePath: string | null

  statePath = getPiStatePath(stateRoot, sessionId)
  if (!statePath || !existsSync(statePath)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as PiRuntimeState
  } catch {
    return null
  }
}

export function writePiState(
  stateRoot: string,
  sessionId: unknown,
  patch: PiRuntimeState,
): PiRuntimeState | null {
  let statePath: string | null
  let tempPath: string
  let state: PiRuntimeState

  statePath = getPiStatePath(stateRoot, sessionId)
  if (!statePath) {
    return null
  }

  state = { ...readPiState(stateRoot, sessionId), ...patch }
  tempPath = `${statePath}.${process.pid}.tmp`
  try {
    mkdirSync(resolve(stateRoot, "state"), { recursive: true })
    writeFileSync(tempPath, `${JSON.stringify(state)}\n`)
    renameSync(tempPath, statePath)
    return state
  } catch {
    try {
      unlinkSync(tempPath)
    } catch {}
    return null
  }
}

export function deletePiState(stateRoot: string, sessionId: unknown): void {
  let statePath: string | null

  statePath = getPiStatePath(stateRoot, sessionId)
  if (!statePath || !existsSync(statePath)) {
    return
  }

  try {
    unlinkSync(statePath)
  } catch {}
}

export function gcPiState(
  stateRoot: string,
  maxAgeMs: number = STATE_MAX_AGE_MS,
  now: number = Date.now(),
): void {
  let stateDirectory: string

  stateDirectory = resolve(stateRoot, "state")
  if (!existsSync(stateDirectory)) {
    return
  }

  try {
    for (const filename of readdirSync(stateDirectory)) {
      let statePath: string

      if (!filename.endsWith(".json")) {
        continue
      }

      statePath = resolve(stateDirectory, filename)
      try {
        if (now - statSync(statePath).mtimeMs > maxAgeMs) {
          unlinkSync(statePath)
        }
      } catch {}
    }
  } catch {}
}
