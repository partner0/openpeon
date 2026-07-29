---
name: openpeon
description: Control OpenPeon sounds for the current Claude Code session. Use when the user asks to switch the sound preset, change or mute the sound volume, or list available presets (peon, ogre-mage, peasant, SCV, ...). If peon_* tools (peon_switch_preset, peon_set_volume, ...) are available in the session, prefer them over this skill.
---

# OpenPeon Session Control

## Prefer the peon_* tools when available

If the session exposes `peon_list_presets`, `peon_switch_preset`, `peon_current_config`, or `peon_set_volume`, use those tools and ignore the rest of this skill. The file-editing protocol below is for any situation where those tools don't exist.

OpenPeon plays Blizzard RTS sounds on Claude Code hook events. Everything lives under `~/.claude/openpeon/`:

- `openpeon.json` - base config (shared defaults, don't edit it for session-scoped requests)
- `presets/*.json` - available presets (optional `tier` and `volume` fields)
- `state/<session_id>.json` - per-session overrides: `{"preset": "<name>" | null, "volume": <0-10>, "whisper": <bool>}` (`"whisper": false` makes whispered working sounds play at full session volume)

The hook re-resolves config from disk on every event, so state edits apply on the very next sound, no restart. Volume precedence: state volume > preset volume > base volume. The state file is deleted when the session ends, so every override here is session-scoped by construction.

## Find the current session's state file

The state file is keyed by session id, which you don't know directly. Every session's file exists (created on its first event) and its mtime is refreshed on every user prompt, so the most recently modified file is the current session, the prompt that asked you to do this touched it moments ago:

```bash
ls -t ~/.claude/openpeon/state/*.json | head -1
```

If two or more files have mtimes within a few seconds of each other, another session received a prompt at nearly the same time: list the candidates with timestamps and ask the user which session to change instead of guessing.

## Operations

Always read the state file first and merge your change into the existing JSON, never overwrite it blindly (you'd wipe the other override).

### Switch preset

1. List presets: `ls ~/.claude/openpeon/presets/` and match the user's request to a name (strip `.json`).
2. If nothing matches, show the available names and stop.
3. Merge `"preset": "<name>"` into the state file.

### Set volume / mute

1. Merge `"volume": <n>` (0-10, 0 = mute) into the state file.
2. Whisper mappings intentionally stay at volume 1 whatever the override; a volume of 0 still mutes everything.

### Reset to defaults

- Base mappings instead of the preset: set `"preset": null`.
- Default volume: remove the `"volume"` key.
- Deleting the whole state file also works but re-rolls a random preset on the next event when `randomPreset` is on.

### List presets / current setup

- Presets: read `~/.claude/openpeon/presets/*.json`; report names and `tier` (1 = common, 3 = rare in the random roll).
- Current session: read the state file and report preset and volume override, falling back to `openpeon.json` values.

## Out of scope

Changing defaults for future sessions (base volume, mappings, new presets) is done in the openpeon repo UI (`bun run ui`) followed by a deploy, not by editing `~/.claude/openpeon/` files, which the next deploy would overwrite. Point the user there instead.
