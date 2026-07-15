# OpenPeon Plugin

An OpenCode plugin and Claude Code hook adapter that plays Warcraft II sounds in response to various events during your coding session.

## Overview

OpenPeon hooks into OpenCode events (long-lived in-process plugin) and Claude Code hook events (a fresh `claude/hook.js` process per event) to play sound effects:
- **Acknowledge sounds** - Play when you send a message, execute a command, or reply to a permission prompt
- **Work complete sound** - Plays when the session goes idle (agent finished working)
- **Permission asked sound** - Plays when a permission prompt appears or the question tool is invoked

## Project Structure

```
openpeon/
  index.js              # OpenCode plugin (event glue + peon_* custom tools)
  lib/core.js           # Shared core: config, presets, tier weighting, trigger matching, volume curve, afplay
  claude/hook.js        # Claude Code hook adapter (stdin JSON in, sound out)
  openpeon.json         # Config file mapping triggers to sounds
  package.json          # NPM package metadata
  sounds/               # Sound assets
    *.wav               # Root-level sounds (legacy peon sounds)
    wc2-horde/          # Full Warcraft II Horde sound library
    wc2-alliance/       # Full Warcraft II Alliance sound library
  skills/openpeon/      # Claude Code skill (session preset/volume control), deployed to ~/.claude/skills/
  tmux/                 # tmux popup (volume/preset control for the window's Claude session)
  test/                 # bun test suites + fixtures (Claude payloads, presets, configs)
  ui/                   # Config management UI
    server.js           # Bun server for the UI (also owns deployment)
    index.html          # Web interface
    presets/            # Saved preset configurations
  AGENTS.md             # This file (not deployed)
  README.md             # User-facing documentation
```

`lib/core.js` must stay dependency-free (no `@opencode-ai/plugin`, no Bun-only APIs): the Claude hook runs it under whatever runtime the hook command uses (bun or node).

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

- `event` - OpenCode events with optional filters (e.g., `role: user` for `message.updated`)
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

Per-session state: `~/.claude/openpeon/state/<session_id>.json` stores `{"preset": name | null, "volume": 0-10}` (volume key optional). The state file is created on the first event of EVERY session (preset rolled only when `randomPreset` is on), reused afterwards, deleted on SessionEnd; SessionStart GCs state files older than 7 days. Volume precedence: state volume (clamped 0-10) > preset volume > base config volume. Config is re-resolved from disk on every event, so a fresh deploy applies to running sessions immediately.

The state file doubles as the per-session control surface for the `openpeon` skill (repo `skills/openpeon/SKILL.md`, deployed to `~/.claude/skills/openpeon/`): the skill finds the current session by newest mtime and merges `preset`/`volume` edits into it.

### Gotchas (hard-won, do not regress)

- The hook must NEVER write to stdout: on PermissionRequest, JSON on stdout can auto-approve/deny the permission dialog. Debug goes to `<root>/debug.log` behind `OPENPEON_DEBUG`.
- The hook must never call `process.exit()`: core `playSound` defers its detached afplay spawn through a `setTimeout(0)`, and an explicit exit cancels it. Always exit 0 by falling off the end.
- Hook command uses the absolute `"$HOME/.bun/bin/bun"` because the hook shell's PATH is not guaranteed. The adapter also runs under node (v22 verified).
- `OPENPEON_ROOT` env var overrides the install root; tests and silent E2E runs use temp roots with `volume: 0` (afplay runs, inaudible).
- Hook wiring changes in `settings.json` only apply to new Claude Code sessions; config/preset changes under `~/.claude/openpeon/` are live per event.
- Runtime sound control: prefer the `peon_*` custom tools when the session has them; the `openpeon` skill's file-editing protocol is the fallback for sessions without them.
- The hook touches the state file's mtime on every UserPromptSubmit. This is what makes "newest state file = current session" true for the skill's discovery heuristic, and it protects long-running sessions from the 7-day GC. Do not remove it.

## tmux popup (tmux/openpeon-popup.sh)

- Root binding `C-n` (user's deliberate choice; it steals readline
  next-history inside tmux) runs `popup '#{client_name}' '#{pane_id}'`,
  which resolves the WINDOW's session, then opens the TUI in a top-right
  `display-popup` sized before opening (popups cannot resize).
- Window → session resolution chain: pane `#{pane_tty}` → the claude process
  on that tty (`ps -t`, skip `<defunct>`) → its cwd (`lsof -a -d cwd -F n`;
  the `-F n` form survives spaces in paths) → `~/.claude/projects/<slug>/`
  transcripts intersected with live state files. Slug rule:
  `[^A-Za-z0-9-]` → `-`. Several live sessions from one directory: newest
  transcript mtime wins, silently (no in-popup header; the popup title comes
  from `display-popup -T`, which needs tmux >= 3.3). The claude
  process holds NO open fd to its transcript and has no session id in its
  env; cwd intersection is the only reliable external mapping found.
- Volume writes go to the state file AND the base `openpeon.json` (user
  decision: new sessions inherit until the next deploy overwrites it).
  Preset writes are state-only so `randomPreset` keeps rolling new sessions.
- Running OpenCode sessions are unreachable by design (in-memory config, no
  disk re-read); the popup shows an explanatory message for opencode panes.
- bash 3.2 + UTF-8 gotcha: `"$bar▓"` parses as a variable NAMED `bar▓`
  (unbound-variable error under `set -u`); always brace as `"${bar}▓"` when
  concatenating multibyte literals.
- Feedback sounds spawn `afplay` directly with the same `(v/10)^2` curve as
  `lib/core.js`; the previous feedback pid is killed first so arrow-key
  repeats do not stack sounds. Requires `jq` (the only bash/jq component in
  an otherwise JS repo).
- Tests (`test/tmux-popup.test.js`) cover only the pure `resolve-cwd` half
  via `OPENPEON_ROOT`/`OPENPEON_PROJECTS_DIR` overrides; the tty/ps/lsof
  half was verified live and has no headless harness.

## Deployment

The repo is the source of truth. Deployment produces two independent, self-contained installs:

| Target | Location |
|--------|----------|
| `opencode` | `~/.config/opencode/plugins/openpeon/` (+ loader `~/.config/opencode/plugins/openpeon.js`) |
| `claude` | `~/.claude/openpeon/` |

Preferred: `bun run ui`, pick the target (OpenCode, Claude, or both), Deploy Plugin. Or POST `{"target": "opencode" | "claude" | "all"}` to `http://localhost:3456/api/deploy`.

Both targets copy `lib/`, `openpeon.json`, `sounds/`, and `ui/presets/` > `presets/`; opencode adds `index.js` + the loader, claude adds `claude/` and `tmux/` and installs `skills/openpeon/` to `~/.claude/skills/openpeon/`. The claude deploy must never touch `~/.claude/openpeon/state/` (live session presets and volume overrides). The two deployed configs drift between deploys by design; re-deploy the other target after UI changes if you want them in sync.

Manual copy steps for both targets are in README.md. Restart OpenCode after an opencode deploy; Claude sessions pick up a claude deploy on their next event.

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
- Deploy to OpenCode, Claude Code, or both

## Testing

```bash
bun test
```

Covers `lib/core.js` (weighted preset picking with injected random, config/preset fallbacks, trigger matching, volume curve) and `claude/hook.js` (event translation, tool name map, session id sanitization, state round-trip/GC, session config resolution). Claude payload fixtures live in `test/fixtures/claude/` and double as manual pipe-test inputs: `OPENPEON_ROOT=<root> bun claude/hook.js < test/fixtures/claude/stop.json`.

## Debug Mode

Enable debug logging:

```bash
OPENPEON_DEBUG=1 opencode
OPENPEON_DEBUG=1 claude
```

OpenCode logs to `~/.config/opencode/openpeon-debug.log`; the Claude hook logs to `~/.claude/openpeon/debug.log`.

## Custom Tools

The plugin provides custom tools that can be called from within OpenCode:

- `peon_list_presets` - List available sound presets
- `peon_switch_preset` - Switch to a different preset (takes `preset` argument)
- `peon_current_config` - Show current configuration and active mappings

Example usage in chat:
```
Switch to the wc2-ogre-mage preset
```

The agent will use the `peon_switch_preset` tool to change the active sound configuration.

## Notes

- Audio playback uses `afplay` (macOS only)
- Sounds can overlap (no single-flight guard)
- Plugin auto-disables on non-macOS or if `afplay` is missing
- Preset switching is live (no restart required)
