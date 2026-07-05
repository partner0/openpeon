# OpenPeon

An [OpenCode](https://opencode.ai) plugin and [Claude Code](https://claude.com/claude-code) hook that plays Blizzard RTS sound effects during your coding sessions.

Hear "Work complete!" when the agent finishes, peon acknowledgements when you send a message, and building sounds as tools run in the background.

## Sound Libraries

Includes sounds from multiple Blizzard RTS games:

- **Warcraft II** - Horde and Alliance units, buildings, and UI sounds
- **Warcraft III** - Peasant voice lines
- **StarCraft: Brood War** - Terran, Protoss, and Zerg units
- **StarCraft 2** - Terran, Protoss, and Zerg units

## Presets

Four presets are included out of the box:

| Preset | Theme |
|--------|-------|
| `wc2-peon` | Warcraft II Peon |
| `wc2-ogre-mage` | Warcraft II Ogre Mage |
| `wc3-peasant` | Warcraft III Peasant |
| `scbw-scv` | StarCraft: Brood War SCV |

Switch presets live from within OpenCode:

```
Switch to the wc2-ogre-mage preset
```

The agent uses the `peon_switch_preset` tool, no restart required.

Set `"randomPreset": true` in `openpeon.json` to load a random preset each session. On Claude Code, the preset is rolled once per session and remembered for its whole lifetime (the `peon_*` tools are OpenCode-only for now).

## Installation

### Requirements

- macOS (uses `afplay` for audio playback)
- [Bun](https://bun.sh) (for the config UI)

### Deploy with the UI (recommended)

```bash
bun run ui
```

Open http://localhost:3456, pick a target (OpenCode, Claude, or both), and click Deploy Plugin. Each target gets its own fully self-contained install; neither references the other.

### Manual deploy to OpenCode

```bash
# Create plugin directory
mkdir -p ~/.config/opencode/plugins/openpeon

# Copy plugin code, config, sounds, and presets
cp index.js ~/.config/opencode/plugins/openpeon/
cp -R lib ~/.config/opencode/plugins/openpeon/
cp openpeon.json ~/.config/opencode/plugins/openpeon/
cp -R sounds ~/.config/opencode/plugins/openpeon/
cp -R ui/presets ~/.config/opencode/plugins/openpeon/presets
```

Create the loader file at `~/.config/opencode/plugins/openpeon.js`:

```javascript
export { OpenPeonPlugin } from "./openpeon/index.js"
```

Restart OpenCode after deployment.

### Manual deploy to Claude Code

```bash
# Create install directory
mkdir -p ~/.claude/openpeon

# Copy hook adapter, shared core, config, sounds, and presets
cp -R claude ~/.claude/openpeon/
cp -R lib ~/.claude/openpeon/
cp openpeon.json ~/.claude/openpeon/
cp -R sounds ~/.claude/openpeon/
cp -R ui/presets ~/.claude/openpeon/presets
```

Then wire the hook into `~/.claude/settings.json`. Append the same entry to each of the seven events (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `PermissionRequest`, `PreToolUse`, `PostToolUse`), merging with any hooks you already have:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "async": true,
            "command": "\"$HOME/.bun/bin/bun\" \"$HOME/.claude/openpeon/claude/hook.js\""
          }
        ]
      }
    ]
  }
}
```

Hook changes apply to new Claude Code sessions; config and preset changes under `~/.claude/openpeon/` are picked up live on the next event.

## Config UI

A web-based UI for managing your sound configuration:

![Config UI](ui/screenshot-v2.png)

```bash
bun run ui
```

Open http://localhost:3456 to:

- Adjust volume (1-10)
- Toggle random preset on startup
- Add, remove, and edit mappings (triggers and sounds)
- Toggle whisper mode per mapping
- Browse and preview all available sounds
- Save and load presets
- Deploy to OpenCode, Claude Code, or both

## Configuration

The `openpeon.json` file maps triggers to sounds:

```json
{
  "volume": 3,
  "randomPreset": false,
  "mappings": [
    {
      "name": "acknowledge",
      "whisper": false,
      "triggers": [
        { "type": "event", "event": "message.updated", "role": "user" }
      ],
      "sounds": ["wc2-horde/peon-acknowledge-1.wav"]
    }
  ]
}
```

### Volume

`volume` (1-10) controls playback loudness. Uses an exponential curve for perceptually linear volume. Default is 5. Change at runtime via the `peon_set_volume` tool or the config UI.

### Whisper

Per-mapping `whisper` flag. When `true`, the mapping always plays at volume 1 regardless of the global volume setting. Useful for subtle background sounds on frequent triggers like tool executions.

### Trigger Types

| Type | Description |
|------|-------------|
| `event` | OpenCode lifecycle events, with optional filters |
| `tool.before` | Fires before a tool executes |
| `tool.after` | Fires after a tool executes |

### Events

| Event | Description |
|-------|-------------|
| `openpeon.startup` | Plugin loaded (app startup) |
| `session.idle` | Agent finished working |
| `message.updated` | Message created/updated (filter with `"role": "user"`) |
| `permission.asked` | Permission prompt shown |
| `permission.replied` | User replied to permission prompt |
| `tui.command.execute` | TUI command executed |
| `command.executed` | CLI command executed |

### Tools (for tool.before/tool.after)

`question`, `bash`, `read`, `write`, `edit`, `glob`, `grep`, `task`, `webfetch`, `todowrite`, `todoread`, `skill`

## Claude Code Support

Claude Code has no plugin process: for each hook event it spawns `claude/hook.js`, which reads the event payload from stdin, translates it into OpenPeon's trigger vocabulary, and plays the matching sound through the same shared core, config, presets, and sounds as the OpenCode plugin.

| Claude Code hook | OpenPeon trigger |
|------------------|------------------|
| `SessionStart` | `openpeon.startup` |
| `UserPromptSubmit` | `message.updated` with role `user` |
| `Stop` | `session.idle` |
| `PermissionRequest` | `permission.asked` |
| `PreToolUse` / `PostToolUse` | `tool.before` / `tool.after` |

Tool names are mapped (`Bash` > `bash`, `AskUserQuestion` > `question`, `WebFetch` > `webfetch`, ...); unknown tools fall back to their lowercased name. With `randomPreset` on, the preset rolled for a session is stored in `~/.claude/openpeon/state/<session_id>.json`, reused for every event of that session, and deleted when the session ends.

## Custom Tools

The plugin registers tools usable from within OpenCode chat:

| Tool | Description |
|------|-------------|
| `peon_list_presets` | List available sound presets |
| `peon_switch_preset` | Switch to a different preset |
| `peon_current_config` | Show current config and active mappings |
| `peon_set_volume` | Set volume (1-10) |

## Debug Mode

```bash
OPENPEON_DEBUG=1 opencode
OPENPEON_DEBUG=1 claude
```

OpenCode logs to `~/.config/opencode/openpeon-debug.log`; the Claude Code hook logs to `~/.claude/openpeon/debug.log`.

## Notes

- Audio playback uses `afplay` (macOS only), plugin auto-disables on other platforms
- Sounds can overlap (no single-flight guard)
- Preset switching is live, no restart required

## Credits

Sound files are from Warcraft II, Warcraft III, StarCraft: Brood War, and StarCraft 2 by Blizzard Entertainment.
