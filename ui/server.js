import { serve } from "bun"
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync, cpSync, rmSync } from "fs"
import { resolve, join, extname } from "path"
import { homedir } from "os"

const ROOT = resolve(import.meta.dir, "..")
const CONFIG_PATH = resolve(ROOT, "openpeon.json")
const SOUNDS_DIR = resolve(ROOT, "sounds")
const PRESETS_DIR = resolve(ROOT, "ui", "presets")
const UI_DIR = resolve(ROOT, "ui")
const DEPLOY_DIR = resolve(homedir(), ".config", "opencode", "plugins", "openpeon")
const DEPLOY_LOADER = resolve(homedir(), ".config", "opencode", "plugins", "openpeon.js")

if (!existsSync(PRESETS_DIR)) {
  mkdirSync(PRESETS_DIR, { recursive: true })
}

const TRIGGER_TYPES = ["event", "tool.before", "tool.after"]

const EVENT_VALUES = [
  // Command Events
  "command.executed",
  // File Events
  "file.edited",
  "file.watcher.updated",
  // Installation Events
  "installation.updated",
  // LSP Events
  "lsp.client.diagnostics",
  "lsp.updated",
  // Message Events
  "message.part.removed",
  "message.part.updated",
  "message.removed",
  "message.updated",
  // Permission Events
  "permission.asked",
  "permission.replied",
  // Server Events
  "server.connected",
  // Session Events
  "session.created",
  "session.compacted",
  "session.deleted",
  "session.diff",
  "session.error",
  "session.idle",
  "session.status",
  "session.updated",
  // Todo Events
  "todo.updated",
  // TUI Events
  "tui.prompt.append",
  "tui.command.execute",
  "tui.toast.show",
  // OpenPeon Events
  "openpeon.startup",
]

const TOOL_VALUES = [
  "question",
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "task",
  "webfetch",
  "todowrite",
  "todoread",
  "skill",
]

function getMimeType(filePath) {
  const ext = extname(filePath).toLowerCase()
  const types = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wav": "audio/wav",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  }
  return types[ext] || "application/octet-stream"
}

function listSoundDirectories() {
  if (!existsSync(SOUNDS_DIR)) {
    return []
  }

  const entries = readdirSync(SOUNDS_DIR, { withFileTypes: true })
  const dirs = ["."]
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(entry.name)
    }
  }
  return dirs.sort((a, b) => {
    if (a === ".") return -1
    if (b === ".") return 1
    return a.localeCompare(b)
  })
}

function listSoundsInDirectory(dirName) {
  const targetDir = dirName === "." ? SOUNDS_DIR : join(SOUNDS_DIR, dirName)
  if (!existsSync(targetDir)) {
    return []
  }

  const entries = readdirSync(targetDir)
  return entries.filter((name) => name.endsWith(".wav") || name.endsWith(".mp3")).sort()
}

function listPresets() {
  if (!existsSync(PRESETS_DIR)) {
    return []
  }

  const entries = readdirSync(PRESETS_DIR)
  return entries.filter((name) => name.endsWith(".json")).map((name) => name.replace(".json", "")).sort()
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return { volume: 5, mappings: [] }
  }

  try {
    const contents = readFileSync(CONFIG_PATH, "utf8")
    return JSON.parse(contents)
  } catch {
    return { volume: 5, mappings: [] }
  }
}

function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

function loadPreset(name) {
  const presetPath = join(PRESETS_DIR, `${name}.json`)
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

function savePreset(name, config) {
  const presetPath = join(PRESETS_DIR, `${name}.json`)
  writeFileSync(presetPath, JSON.stringify(config, null, 2))
}

function deployPlugin() {
  try {
    mkdirSync(DEPLOY_DIR, { recursive: true })

    cpSync(resolve(ROOT, "index.js"), resolve(DEPLOY_DIR, "index.js"))
    cpSync(CONFIG_PATH, resolve(DEPLOY_DIR, "openpeon.json"))

    const deployedSoundsDir = resolve(DEPLOY_DIR, "sounds")
    if (existsSync(deployedSoundsDir)) {
      rmSync(deployedSoundsDir, { recursive: true })
    }
    cpSync(SOUNDS_DIR, deployedSoundsDir, { recursive: true })

    const deployedPresetsDir = resolve(DEPLOY_DIR, "presets")
    if (existsSync(deployedPresetsDir)) {
      rmSync(deployedPresetsDir, { recursive: true })
    }
    if (existsSync(PRESETS_DIR)) {
      cpSync(PRESETS_DIR, deployedPresetsDir, { recursive: true })
    }

    const loaderContent = 'export { OpenPeonPlugin } from "./openpeon/index.js"\n'
    writeFileSync(DEPLOY_LOADER, loaderContent)

    return { success: true, path: DEPLOY_DIR }
  } catch (error) {
    return { success: false, error: error?.message ?? "Unknown error" }
  }
}

function handleApi(req) {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === "/api/meta" && req.method === "GET") {
    return Response.json({
      triggerTypes: TRIGGER_TYPES,
      eventValues: EVENT_VALUES,
      toolValues: TOOL_VALUES,
    })
  }

  if (path === "/api/config" && req.method === "GET") {
    return Response.json(loadConfig())
  }

  if (path === "/api/config" && req.method === "POST") {
    return req.json().then((body) => {
      saveConfig(body)
      return Response.json({ success: true })
    })
  }

  if (path === "/api/sounds/directories" && req.method === "GET") {
    return Response.json(listSoundDirectories())
  }

  if (path.startsWith("/api/sounds/list/") && req.method === "GET") {
    const dirName = decodeURIComponent(path.replace("/api/sounds/list/", ""))
    return Response.json(listSoundsInDirectory(dirName))
  }

  if (path.startsWith("/api/sounds/play/") && req.method === "GET") {
    const soundPath = decodeURIComponent(path.replace("/api/sounds/play/", ""))
    const fullPath = join(SOUNDS_DIR, soundPath)
    if (!existsSync(fullPath)) {
      return new Response("Not found", { status: 404 })
    }

    const file = readFileSync(fullPath)
    return new Response(file, {
      headers: { "Content-Type": "audio/wav" },
    })
  }

  if (path === "/api/presets" && req.method === "GET") {
    return Response.json(listPresets())
  }

  if (path.startsWith("/api/presets/") && req.method === "GET") {
    const name = decodeURIComponent(path.replace("/api/presets/", ""))
    const preset = loadPreset(name)
    if (!preset) {
      return new Response("Not found", { status: 404 })
    }
    return Response.json(preset)
  }

  if (path.startsWith("/api/presets/") && req.method === "POST") {
    const name = decodeURIComponent(path.replace("/api/presets/", ""))
    return req.json().then((body) => {
      savePreset(name, body)
      return Response.json({ success: true })
    })
  }

  if (path.startsWith("/api/presets/") && req.method === "DELETE") {
    const name = decodeURIComponent(path.replace("/api/presets/", ""))
    const presetPath = join(PRESETS_DIR, `${name}.json`)
    if (!existsSync(presetPath)) {
      return new Response("Not found", { status: 404 })
    }
    try {
      rmSync(presetPath)
      return Response.json({ success: true })
    } catch (error) {
      return Response.json({ success: false, error: error?.message ?? "Unknown error" })
    }
  }

  if (path === "/api/deploy" && req.method === "POST") {
    const result = deployPlugin()
    return Response.json(result)
  }

  return new Response("Not found", { status: 404 })
}

function handleStatic(req) {
  const url = new URL(req.url)
  let path = url.pathname

  if (path === "/") {
    path = "/index.html"
  }

  const filePath = join(UI_DIR, path)
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return new Response("Not found", { status: 404 })
  }

  const file = readFileSync(filePath)
  return new Response(file, {
    headers: { "Content-Type": getMimeType(filePath) },
  })
}

const server = serve({
  port: 3456,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.startsWith("/api/")) {
      return handleApi(req)
    }
    return handleStatic(req)
  },
})

console.log(`UI server running at http://localhost:${server.port}`)
