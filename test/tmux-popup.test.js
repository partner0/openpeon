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
