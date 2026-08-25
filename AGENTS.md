# OpenPeon Plugin

An OpenCode plugin, Claude Code hook adapter, and pi extension that plays Blizzard RTS sounds in response to coding-session events.

## Overview

OpenPeon hooks into OpenCode events, Claude Code hook events, and pi extension events to play sound effects:
- **Acknowledge sounds** - Play when you send a message, execute a command, or reply to a permission prompt
- **Work complete sound** - Plays when the session goes idle (agent finished working)
- **Permission asked sound** - Plays when a permission prompt appears or the question tool is invoked

## Project Structure

```
openpeon/
  index.js              # OpenCode plugin (event glue + peon_* custom tools)
  lib/core.js           # Shared core: config, presets, tier weighting, trigger matching, volume curve, afplay
  claude/hook.js        # Claude Code hook adapter (stdin JSON in, sound out)
  pi/index.ts           # pi extension event glue and peon_* custom tools
  pi/events.ts          # pi event and tool-name translation
  pi/state.ts           # pi disk control state for the Herdr popup
  openpeon.json         # Config file mapping triggers to sounds
  package.json          # NPM package metadata
  sounds/               # Sound assets
    *.wav               # Root-level sounds (legacy peon sounds)
    wc2-horde/          # Full Warcraft II Horde sound library
    wc2-alliance/       # Full Warcraft II Alliance sound library
  skills/openpeon/      # Claude Code skill (session preset/volume control), deployed to ~/.claude/skills/
  tmux/                 # Herdr popup implementation plus legacy Claude tmux entry point
  test/                 # bun test suites + fixtures (Claude payloads, presets, configs)
  ui/                   # Config management UI
    server.js           # Bun server for the UI (also owns deployment)
    index.html          # Web interface
    presets/            # Saved preset configurations
  AGENTS.md             # This file (not deployed)
  README.md             # User-facing documentation
```

`lib/core.js` must stay dependency-free, with no agent SDK or Bun-only APIs. The Claude hook runs it under bun or node, and the pi extension imports it through pi's TypeScript loader.

## Config Format

The `openpeon.json` file defines mappings between triggers and sounds:

```json
{
  "volume": 5,
  "randomPreset": false,
  "mappings": [
    {
      "name": "mapping-name",
      "whisper": false,
      "triggers": [
        { "type": "event", "event": "session.idle" },
        { "type": "event", "event": "message.updated", "role": "user" },
        { "type": "tool.before", "tool": "question" }
      ],
      "sounds": ["sound1.wav", "wc2-horde/category-subcategory-name.wav"]
    }
  ]
}
```

### Volume

- `volume` (number, 0-10) - Default playback volume. Defaults to 5 if omitted. 0 is mute.
- Converted to afplay volume using an exponential curve for perceptually linear loudness.
- Precedence: mute prevails on whisper, whisper prevails on volume. At volume 0 the player is not spawned at all, even for whispered mappings.
- Can be changed at runtime via the `peon_set_volume` tool or the config UI.

### Random Preset

- `randomPreset` (boolean) - When `true`, a random preset is loaded at startup before the `openpeon.startup` event fires. Defaults to `false`.
- The preset's mappings and volume override the base config for the session.
- Selection is weighted by the preset's `tier` field (see below).
- Can be toggled via the config UI.

### Tier (Preset Weighting)

- `tier` (number, 1-3) - Optional field in preset JSON files that controls weighted random selection.
- Tier 1 = weight 3 (~50%), Tier 2 = weight 2 (~33%), Tier 3 = weight 1 (~17%).
- Presets without a `tier` field default to weight 2.
- Only affects random preset selection at startup when `randomPreset` is `true`.

### Trigger Types

- `event` - Shared lifecycle events with optional filters (e.g., `role: user` for `message.updated`)
- `tool.before` - Fires before a tool executes, filtered by tool name
- `tool.after` - Fires after a tool executes, filtered by tool name

### Available Events

- `session.idle` - Agent finished working
- `message.updated` - Message created/updated (filter by `role: user` for user messages)
- `tui.command.execute` - TUI command executed
- `command.executed` - CLI command executed
- `permission.asked` - Permission prompt shown
- `permission.replied` - User replied to permission prompt
- `openpeon.startup` - Synthetic event fired when the plugin loads (app startup)

### Available Tools (for tool.before/tool.after)

- `question`, `bash`, `read`, `write`, `edit`, `glob`, `grep`, `task`, `webfetch`, `todowrite`, `todoread`, `skill`

## Claude Code Support

`claude/hook.js` is wired into all seven hook events in `~/.claude/settings.json` (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `PermissionRequest`, `PreToolUse`, `PostToolUse`) with the same async command; the adapter dispatches on `hook_event_name`. Trigger translation: SessionStart (startup/resume/clear) > `openpeon.startup`, SessionStart (compact) > state upkeep only, UserPromptSubmit > `message.updated` role user, Stop > `session.idle`, PermissionRequest > `permission.asked`, Pre/PostToolUse > `tool.before`/`tool.after` with the tool name map in `TOOL_NAME_MAP` (unknown tools fall back to lowercase).

Per-session state: `~/.claude/openpeon/state/<session_id>.json` stores `{"preset": name | null, "volume": 0-10, "whisper": bool}` (volume and whisper keys optional; only an explicit `"whisper": false` disables mapping whisper flags for the session). The state file is created on the first event of EVERY session (preset rolled only when `randomPreset` is on), reused afterwards, deleted on SessionEnd; SessionStart GCs state files older than 7 days. Volume precedence: state volume (clamped 0-10) > preset volume > base config volume. Config is re-resolved from disk on every event, so a fresh deploy applies to running sessions immediately.

Agent SDK sessions are muted at the top of `main()`: when the inherited `CLAUDE_CODE_ENTRYPOINT` env var starts with `sdk` (`sdk-ts`/`sdk-py`; interactive/CLI runs get `cli`), the hook returns before doing anything, so SDK sessions play no sound and never create a state file (which would pollute the skill's newest-mtime session discovery).

The state file doubles as the per-session control surface for the `openpeon` skill (repo `skills/openpeon/SKILL.md`, deployed to `~/.claude/skills/openpeon/`): the skill finds the current session by newest mtime and merges `preset`/`volume` edits into it.

### Gotchas (hard-won, do not regress)

- The hook must NEVER write to stdout: on PermissionRequest, JSON on stdout can auto-approve/deny the permission dialog. Debug goes to `<root>/debug.log` behind `OPENPEON_DEBUG`.
- The hook must never call `process.exit()`: core `playSound` defers its detached afplay spawn through a `setTimeout(0)`, and an explicit exit cancels it. Always exit 0 by falling off the end.
- Hook command uses the absolute `"$HOME/.bun/bin/bun"` because the hook shell's PATH is not guaranteed. The adapter also runs under node (v22 verified).
- `OPENPEON_ROOT` env var overrides the install root; tests and silent E2E runs use temp roots with `volume: 0` (afplay runs, inaudible).
- Hook wiring changes in `settings.json` only apply to new Claude Code sessions; config/preset changes under `~/.claude/openpeon/` are live per event.
- Runtime sound control: prefer the `peon_*` custom tools when the session has them; the `openpeon` skill's file-editing protocol is the fallback for sessions without them.
- The hook touches the state file's mtime on every UserPromptSubmit. This is what makes "newest state file = current session" true for the skill's discovery heuristic, and it protects long-running sessions from the 7-day GC. Do not remove it.
- Sound assets must be 16-bit PCM (or mp3): `pw-play` pads the end of 8-bit unsigned wav streams with the wrong silence value, producing an audible click at the end of every sound on Linux (afplay is unaffected, so it only shows there). All u8 rips were converted once; convert any newly imported 8-bit files before adding them.

## pi support

`pi/index.ts` is a native extension. It translates `session_start`, `input`, `agent_settled`, `user_bash`, and tool execution events into the shared trigger vocabulary. Question tools emit both permission semantics and tool triggers, with one sound per mapping. `find` maps to `glob`, `subagent` maps to `task`, and question tool variants map to `question`.

The selected random or manual preset is stored in `openpeon-state` custom session entries, so `/reload` and resume do not roll again. Interactive sessions also expose a disk control file at `~/.pi/agent/openpeon/state/<session-id>.json` for Herdr. It stores preset, optional volume and whisper overrides, cwd, asset root, and session file. The extension re-reads it before sounds, touches it on input, preserves it across reload, and deletes it on other shutdowns. JSON and print sessions must stay fully muted and must not create state or register `peon_*` tools. TUI and RPC sessions remain enabled.

Package installs use `ui/presets/`; UI deployments copy presets to `<root>/presets/`. Keep the fallback in `pi/index.ts`. Do not combine `pi install .` with the UI pi deployment because pi deduplicates by resolved extension path, not package identity, and would load both copies.

## Herdr popup and tmux fallback (tmux/openpeon-popup.sh)

- Herdr `C-n` invokes `openpeon.popup`. The plugin action inspects the focused
  agent through `herdr agent list`, resolves the session, sizes the popup, and
  passes session id, asset root, and writable state root to the pane entrypoint. The manifest
  prefers the pi-deployed script and falls back to the Claude deployment; both
  script copies resolve Claude and pi. Re-run `herdr plugin link herdr` after
  manifest changes because Herdr caches linked action commands.
- Claude resolution maps focused cwd through `~/.claude/projects/<slug>/`
  transcripts intersected with live state files. Pi resolution matches focused
  cwd against `~/.pi/agent/openpeon/state/*.json`. Several sessions from one
  directory use the newest transcript or state mtime. The pi extension touches
  its state on every input, which makes the focused session win.
- The older tmux binding remains Claude-only. It resolves pane tty to the
  Claude process, reads cwd through `/proc` or `lsof -F n`, then uses the same
  Claude transcript intersection. Root `C-n` was the user's deliberate choice.
- Volume writes go to the state file AND the base `openpeon.json` (user
  decision: new sessions inherit until the next deploy overwrites it).
  Preset and whisper (`w` key) writes are state-only so `randomPreset` keeps
  rolling new sessions and whisper resets to on per session.
- Running OpenCode sessions are unreachable by design (in-memory config, no
  disk re-read); the popup shows an explanatory message for opencode panes.
- bash 3.2 + UTF-8 gotcha: `"$bar▓"` parses as a variable NAMED `bar▓`
  (unbound-variable error under `set -u`); always brace as `"${bar}▓"` when
  concatenating multibyte literals.
- Feedback sounds spawn `afplay` directly with the same `(v/10)^2` curve as
  `lib/core.js`; the previous feedback pid is killed first so arrow-key
  repeats do not stack sounds. Requires `jq` (the only bash/jq component in
  an otherwise JS repo).
- Tests (`test/tmux-popup.test.js`) cover Claude cwd resolution, pi state
  resolution, Herdr popup geometry and root passing, and TUI behavior. The
  tmux tty/ps/lsof half was verified live and has no headless harness.

## Deployment

The repo is the source of truth. Deployment produces three independent, self-contained installs:

| Target | Location |
|--------|----------|
| `opencode` | `~/.config/opencode/plugins/openpeon/` (+ loader `~/.config/opencode/plugins/openpeon.js`) |
| `claude` | `~/.claude/openpeon/` |
| `pi` | `~/.pi/agent/openpeon/` (+ loader `~/.pi/agent/extensions/openpeon.ts`) |

Preferred: `bun run ui`, pick OpenCode, Claude, pi, or all three, then Deploy Plugin. The API accepts `{"target": "opencode" | "claude" | "pi" | "all"}` at `http://localhost:3456/api/deploy`.

All targets copy `lib/`, `openpeon.json`, `sounds/`, and `ui/presets/` to `presets/`. OpenCode adds `index.js` and its loader. Claude adds `claude/` and `tmux/`, and installs `skills/openpeon/` to `~/.claude/skills/openpeon/`. Pi adds `pi/`, `tmux/`, and its loader. Neither Claude nor pi deployment may replace its live `state/` directory. Deployed configs drift by design between deploys.

Manual copy steps are in README.md. Restart OpenCode after deployment. Claude sessions read changes on their next event. Run `/reload` in pi.

## Config UI

Run the config management UI:

```bash
bun run ui/server.js
```

Open http://localhost:3456 to:
- Adjust default volume
- Add/remove/edit mappings
- Browse and preview sounds
- Save/load presets
- Export config to `openpeon.json`
- Deploy to OpenCode, Claude Code, pi, or all three

## Testing

```bash
bun test
```

Covers `lib/core.js`, `claude/hook.js`, Herdr and tmux popup behavior, pi event translation, and pi disk state. Claude payload fixtures live in `test/fixtures/claude/` and double as manual pipe-test inputs: `OPENPEON_ROOT=<root> bun claude/hook.js < test/fixtures/claude/stop.json`.

## Debug Mode

Enable debug logging:

```bash
OPENPEON_DEBUG=1 opencode
OPENPEON_DEBUG=1 claude
OPENPEON_DEBUG=1 pi
```

OpenCode logs to `~/.config/opencode/openpeon-debug.log`. Claude logs to `~/.claude/openpeon/debug.log`. UI-deployed pi logs to `~/.pi/agent/openpeon/debug.log`.

## Custom Tools

The OpenCode plugin and pi extension provide custom tools:

- `peon_list_presets` - List available sound presets
- `peon_switch_preset` - Switch to a different preset (takes `preset` argument)
- `peon_current_config` - Show current configuration and active mappings
- `peon_set_volume` - Set volume from 0 to 10

Example usage in chat:
```
Switch to the wc2-ogre-mage preset
```

The agent will use the `peon_switch_preset` tool to change the active sound configuration.

## Notes

- Audio playback uses `afplay` on macOS and `pw-play` on Linux
- Sounds can overlap (no single-flight guard)
- OpenPeon disables audio when no supported player exists
- Preset switching is live (no restart required)
