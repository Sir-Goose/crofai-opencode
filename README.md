# opencode-crofai-sidebar

OpenCode TUI plugin that displays [CrofAI](https://crof.ai/) usage stats in the sidebar — requests remaining per day and credit balance.

## Prerequisites

- [OpenCode](https://opencode.ai/) >= 1.4.1
- A CrofAI API key (get one at [crof.ai](https://crof.ai/))

## Installation

### Option 1: Clone into plugins directory (recommended)

```bash
mkdir -p ~/.config/opencode/plugins
git clone https://github.com/Red44/crofai-opencode.git ~/.config/opencode/plugins/crofai-opencode
cd ~/.config/opencode/plugins/crofai-opencode
bun install
bun run build
```

Then add to `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "./plugins/crofai-opencode/dist/tui.js"
  ]
}
```

### Option 2: Project-level

```bash
git clone https://github.com/Red44/crofai-opencode.git .opencode/plugins/crofai-opencode
cd .opencode/plugins/crofai-opencode
bun install
bun run build
```

Then in `.opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "./plugins/crofai-opencode/dist/tui.js"
  ]
}
```

## Configuration

### Set your API key

```bash
export CROFAI_API_KEY="nahcrof_yourkeyhere"
```

Add this to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) to persist it.

### Start OpenCode

```bash
opencode
```

You should see a **CrofAI** section in the sidebar showing your requests/day and credit balance.

## Auto-updates

The plugin checks for updates from GitHub on startup (async, non-blocking). If a new version is found it pulls the latest code and shows a notification in the sidebar. Restart OpenCode to apply the update.

Checks repeat every 24 hours while OpenCode is running.

## What it shows

| State | Display |
|---|---|
| API key set, data loaded | `CrofAI` + `Requests: XXX/day` + `Credits: $X.XXXX` |
| API key not set | `CrofAI` + `Set CROFAI_API_KEY` + `export CROFAI_API_KEY=...` |
| Fetch failed | `CrofAI` + `Failed to fetch usage` |
| Loading | `CrofAI` + `Loading...` |
| Update available | `Plugin updated - restart to apply` |

Data refreshes automatically every 30 seconds.

## Troubleshooting

**Plugin doesn't appear in sidebar:**
- Ensure the build output exists: `ls ~/.config/opencode/plugins/crofai-opencode/dist/tui.js`
- Ensure `tui.json` points to the correct path
- Restart OpenCode

**"Set CROFAI_API_KEY" shown:**
- The `CROFAI_API_KEY` environment variable is not set. Export it before starting OpenCode.

**"Failed to fetch usage" shown:**
- Check that your API key is valid at `https://crof.ai/`
- Verify network connectivity to `crof.ai`

## Development

```bash
git clone https://github.com/Red44/crofai-opencode.git
cd crofai-opencode
bun install
bun run build
```

## License

MIT
