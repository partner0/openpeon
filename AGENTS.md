# OpenPeon Plugin

An OpenCode plugin that plays Warcraft II sounds in response to various events during your coding session.

## Overview

This plugin hooks into OpenCode events and tool executions to play sound effects:
- **Acknowledge sounds** - Play when you send a message, execute a command, or reply to a permission prompt
- **Work complete sound** - Plays when the session goes idle (agent finished working)
- **Permission asked sound** - Plays when a permission prompt appears or the question tool is invoked

## Project Structure

```
openpeon/
  index.js              # Main plugin code
  openpeon.json         # Config file mapping triggers to sounds
  package.json          # NPM package metadata
  sounds/               # Sound assets
    *.wav               # Root-level sounds (legacy peon sounds)
    wc2-horde/          # Full Warcraft II Horde sound library
    wc2-alliance/       # Full Warcraft II Alliance sound library
  ui/                   # Config management UI
    server.js           # Bun server for the UI
    index.html          # Web interface
    presets/            # Saved preset configurations
  AGENTS.md             # This file (not deployed)
  README.md             # User-facing documentation
```

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

- `volume` (number, 1-10) - Default playback volume. Defaults to 5 if omitted.
- Converted to afplay volume using an exponential curve for perceptually linear loudness.
- Can be changed at runtime via the `peon_set_volume` tool or the config UI.

### Random Preset

- `randomPreset` (boolean) - When `true`, a random preset is loaded at startup before the `openpeon.startup` event fires. Defaults to `false`.
- The preset's mappings and volume override the base config for the session.
- Can be toggled via the config UI.

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

## Deployment

Deploy to global OpenCode plugins directory:

```bash
# Copy plugin code
cp index.js ~/.config/opencode/plugins/openpeon/index.js

# Copy config
cp openpeon.json ~/.config/opencode/plugins/openpeon/openpeon.json

# Copy sounds (replace existing)
rm -rf ~/.config/opencode/plugins/openpeon/sounds
cp -R sounds ~/.config/opencode/plugins/openpeon/sounds
```

Create the loader file at `~/.config/opencode/plugins/openpeon.js`:

```javascript
export { OpenPeonPlugin } from "./openpeon/index.js"
```

Restart OpenCode after deployment.

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

## Debug Mode

Enable debug logging:

```bash
OPENPEON_DEBUG=1 opencode
```

Logs are written to `~/.config/opencode/openpeon-debug.log`.

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
