import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolve, dirname, join } from "path"
import { fileURLToPath } from "url"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "fs"
import { spawnSync } from "child_process"
import { tmpdir } from "os"

// tmux/openpeon-popup.sh session resolution: the pure file-based half
// (resolve-cwd) maps a working directory to the live Claude session via
// ~/.claude/projects/<slug>/ transcripts intersected with state files.
// The tmux/ps/lsof half cannot run headless and is exercised manually.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, "..", "tmux", "openpeon-popup.sh")

let root = null
let projects = null

function runResolveCwd(cwd) {
  const result = spawnSync("/bin/bash", [SCRIPT, "resolve-cwd", cwd], {
    env: { ...process.env, OPENPEON_ROOT: root, OPENPEON_PROJECTS_DIR: projects },
    encoding: "utf8",
  })
  return result.stdout.trim().split("\t")
}

function addPresets(n) {
  mkdirSync(join(root, "presets"), { recursive: true })
  for (let i = 1; i <= n; i++) writeFileSync(join(root, "presets", `preset-${i}.json`), "{}")
}

function addSession(id, projectSlug, transcriptAgeMs = 0) {
  writeFileSync(join(root, "state", `${id}.json`), JSON.stringify({ preset: null }))
  const dir = join(projects, projectSlug)
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, `${id}.jsonl`)
  writeFileSync(transcript, "{}\n")
  const when = new Date(Date.now() - transcriptAgeMs)
  utimesSync(transcript, when, when)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openpeon-popup-root-"))
  projects = mkdtempSync(join(tmpdir(), "openpeon-popup-projects-"))
  mkdirSync(join(root, "state"), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(projects, { recursive: true, force: true })
})

describe("resolve-cwd", () => {
  test("resolves the unique live session for a directory", () => {
    addSession("aaa-111", "-Users-me-repo")
    const [status, id, count] = runResolveCwd("/Users/me/repo")
    expect(status).toBe("ok")
    expect(id).toBe("aaa-111")
    expect(count).toBe("1")
  })

  test("slugifies dots and underscores like the projects dir does", () => {
    addSession("bbb-222", "-Users-me-my-repo-v2-x")
    const [status, id] = runResolveCwd("/Users/me/my_repo.v2 x")
    expect(status).toBe("ok")
    expect(id).toBe("bbb-222")
  })

  test("picks the newest transcript when several live sessions share the directory", () => {
    addSession("old-session", "-Users-me-repo", 60_000)
    addSession("new-session", "-Users-me-repo", 0)
    const [status, id, count] = runResolveCwd("/Users/me/repo")
    expect(status).toBe("ok")
    expect(id).toBe("new-session")
    expect(count).toBe("2")
  })

  test("ignores live sessions from other directories", () => {
    addSession("here-1", "-Users-me-repo")
    addSession("elsewhere-1", "-Users-me-other")
    const [status, id, count] = runResolveCwd("/Users/me/repo")
    expect(status).toBe("ok")
    expect(id).toBe("here-1")
    expect(count).toBe("1")
  })

  test("errors when no live session matches the directory", () => {
    addSession("elsewhere-1", "-Users-me-other")
    const [status, message] = runResolveCwd("/Users/me/repo")
    expect(status).toBe("err")
    expect(message).toContain("could not match")
  })

  test("errors when there are no live sessions at all", () => {
    const [status] = runResolveCwd("/Users/me/repo")
    expect(status).toBe("err")
  })

  test("dead sessions (transcript without state file) do not count", () => {
    // Transcript exists but the state file was deleted on SessionEnd
    const dir = join(projects, "-Users-me-repo")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "dead-session.jsonl"), "{}\n")
    const [status] = runResolveCwd("/Users/me/repo")
    expect(status).toBe("err")
  })
})

describe("resolve-herdr", () => {
  // The herdr half of the resolution: focused agent kind + cwd from
  // `herdr agent list`, then the same resolve-cwd file intersection. A stub
  // herdr binary on PATH stands in for the real CLI.
  let bin = null

  function stubHerdr(agents) {
    const reply = JSON.stringify({ id: "cli:agent:list", result: { agents, type: "agent_list" } })
    const stub = join(bin, "herdr")
    writeFileSync(stub, `#!/bin/bash\nprintf '%s\\n' '${reply}'\n`)
    chmodSync(stub, 0o755)
  }

  function runResolveHerdr() {
    const result = spawnSync("/bin/bash", [SCRIPT, "resolve-herdr"], {
      env: {
        ...process.env,
        OPENPEON_ROOT: root,
        OPENPEON_PROJECTS_DIR: projects,
        PATH: `${bin}:${process.env.PATH}`,
      },
      encoding: "utf8",
    })
    return result.stdout.trim().split("\t")
  }

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "openpeon-popup-bin-"))
  })

  afterEach(() => {
    rmSync(bin, { recursive: true, force: true })
  })

  test("resolves the focused claude agent through its working directory", () => {
    addSession("herdr-1", "-Users-me-repo")
    stubHerdr([
      { agent: "claude", focused: false, cwd: "/Users/me/other", foreground_cwd: "/Users/me/other" },
      { agent: "claude", focused: true, cwd: "/Users/me/repo", foreground_cwd: "/Users/me/repo" },
    ])
    const [status, id, count] = runResolveHerdr()
    expect(status).toBe("ok")
    expect(id).toBe("herdr-1")
    expect(count).toBe("1")
  })

  test("points OpenCode at chat control", () => {
    stubHerdr([{ agent: "opencode", focused: true, cwd: "/Users/me/repo" }])
    const [status, message] = runResolveHerdr()
    expect(status).toBe("err")
    expect(message).toContain("peon_set_volume")
  })

  test("errors when no agent pane is focused", () => {
    stubHerdr([{ agent: "claude", focused: false, cwd: "/Users/me/repo" }])
    const [status, message] = runResolveHerdr()
    expect(status).toBe("err")
    expect(message).toContain("no Claude Code session")
  })

  test("errors on a focused non-claude agent", () => {
    stubHerdr([{ agent: "codex", focused: true, cwd: "/Users/me/repo" }])
    const [status, message] = runResolveHerdr()
    expect(status).toBe("err")
    expect(message).toContain("no Claude Code session")
  })
})

describe("popup-herdr", () => {
  // The plugin action computes the popup geometry (like run_popup does for
  // tmux) and execs `herdr plugin pane open`; the stub prints the call so the
  // geometry and env passing can be asserted.
  let bin = null

  function stubHerdr(agents) {
    const reply = JSON.stringify({ id: "cli:agent:list", result: { agents, type: "agent_list" } })
    const stub = join(bin, "herdr")
    writeFileSync(stub, `#!/bin/bash\nif [ "$1" = agent ]; then printf '%s\\n' '${reply}'; else echo "herdr $@"; fi\n`)
    chmodSync(stub, 0o755)
  }

  function runPopupHerdr() {
    const result = spawnSync("/bin/bash", [SCRIPT, "popup-herdr"], {
      env: {
        ...process.env,
        OPENPEON_ROOT: root,
        OPENPEON_PROJECTS_DIR: projects,
        PATH: `${bin}:${process.env.PATH}`,
      },
      encoding: "utf8",
    })
    return result.stdout.trim()
  }

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "openpeon-popup-bin-"))
  })

  afterEach(() => {
    rmSync(bin, { recursive: true, force: true })
  })

  test("opens the pane entrypoint sized to the preset list", () => {
    addSession("herdr-1", "-Users-me-repo")
    addPresets(6)
    stubHerdr([{ agent: "claude", focused: true, cwd: "/Users/me/repo", foreground_cwd: "/Users/me/repo" }])
    const call = runPopupHerdr()
    expect(call).toContain("plugin pane open")
    expect(call).toContain("--placement popup")
    expect(call).toContain("--width 48")
    expect(call).toContain("--height 12") // 6 presets + 6
    expect(call).toContain("OPENPEON_POPUP_SID=herdr-1")
  })

  test("opens an error pane sized to the message", () => {
    stubHerdr([{ agent: "claude", focused: false, cwd: "/Users/me/repo" }])
    const call = runPopupHerdr()
    // "no Claude Code session in the focused pane" is 42 chars: 46 wide, one
    // folded line plus the border
    expect(call).toContain("--width 46")
    expect(call).toContain("--height 3")
    expect(call).toContain("OPENPEON_POPUP_MSG=no Claude Code session in the focused pane")
  })

  test("pane body shows the message passed through the environment", () => {
    const result = spawnSync("/bin/bash", [SCRIPT, "popup-herdr-pane"], {
      env: { ...process.env, OPENPEON_POPUP_MSG: "some resolution error", TERM: "unknown-terminal", COLUMNS: "48" },
      input: "q",
      encoding: "utf8",
    })
    expect(result.stdout).toBe(" some resolution error")
  })
})

describe("tui list viewport", () => {
  // A terminal shorter than the popup clamps it, so the preset list draws
  // through a viewport of terminal-height minus the fixed lines and scrolls.
  // TERM is invalid so the script falls back to LINES for the height.
  function runTui(lines) {
    const result = spawnSync("/bin/bash", [SCRIPT, "tui", "sess-1"], {
      env: { ...process.env, OPENPEON_ROOT: root, TERM: "unknown-terminal", LINES: String(lines) },
      input: "q",
      encoding: "utf8",
    })
    return result.stdout.split("\n")
  }

  test("draws every list row when the terminal is tall enough", () => {
    addPresets(6)
    // volume + whisper + base row + 6 presets + help
    expect(runTui(30).length).toBe(10)
  })

  test("scrolls the list when the terminal is shorter than the rows", () => {
    addPresets(6)
    // 8 lines - 3 fixed = 5 visible rows of the 7 list rows
    expect(runTui(8).length).toBe(8)
  })

  test("follows the selection below the viewport", () => {
    addPresets(6)
    const result = spawnSync("/bin/bash", [SCRIPT, "tui", "sess-1"], {
      env: { ...process.env, OPENPEON_ROOT: root, TERM: "unknown-terminal", LINES: "8" },
      input: "jjjjjjq",
      encoding: "utf8",
    })
    const frames = result.stdout.split("\x1b[H\x1b[2J")
    const lastFrame = frames[frames.length - 1]
    expect(lastFrame).toContain("preset-6")
    expect(lastFrame).not.toContain("(base config)")
  })
})

describe("msg", () => {
  // The error popup has a 78-column width cap (76 interior); messages longer
  // than that must word-wrap onto extra rows instead of overwriting line 1.
  const LONG =
    "OpenCode holds its sound config in memory: ask in chat (peon_set_volume, peon_switch_preset)"

  function runMsg(width, text) {
    const result = spawnSync("/bin/bash", [SCRIPT, "msg", String(width), text], {
      input: "q",
      encoding: "utf8",
    })
    return result.stdout
  }

  test("word-wraps long messages within the popup interior width", () => {
    const lines = runMsg(74, LONG).split("\n")
    expect(lines.length).toBe(2)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(75)
    expect(lines.map((l) => l.trim()).join(" ")).toBe(LONG)
  })

  test("does not end with a newline (it would scroll a full popup)", () => {
    expect(runMsg(74, LONG).endsWith("\n")).toBe(false)
    expect(runMsg(74, "short message").endsWith("\n")).toBe(false)
  })

  test("short messages stay on one line", () => {
    const out = runMsg(74, "no Claude Code session in this window")
    expect(out).toBe(" no Claude Code session in this window")
  })
})
