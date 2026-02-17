# openpeon

An OpenCode plugin that plays Warcraft II peon voice lines when you interact with the AI agent.

## Sounds

- **User command**: Plays a random peon acknowledge sound ("Yes?", "What?", "Hmmm?", "What you want?")
- **Task complete**: Plays "Work complete!" when the agent finishes

## Installation

### From npm (when published)

Add to your `opencode.json`:

```json
{
  "plugin": ["openpeon"]
}
```

### From local files

Copy the plugin file and sounds folder to your OpenCode plugins directory:

```bash
cp -r index.js sounds ~/.config/opencode/plugins/openpeon/
```

Or for project-specific use:

```bash
cp -r index.js sounds .opencode/plugins/openpeon/
```

## Requirements

- macOS (uses `afplay` for audio playback)

## Credits

Sound files are from Warcraft II by Blizzard Entertainment.
