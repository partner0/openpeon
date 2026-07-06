import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolve, dirname, join } from "path"
import { fileURLToPath } from "url"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "fs"
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
