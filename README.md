# opencode-crofai-sidebar

OpenCode TUI plugin that displays [CrofAI](https://crof.ai/) usage stats in the sidebar — requests remaining per day and credit balance.

## Prerequisites

- [OpenCode](https://opencode.ai/) >= 1.4.1
- [Bun](https://bun.sh/) runtime
- A CrofAI API key (get one at [crof.ai](https://crof.ai/))

## Installation

### Global (all projects)

```bash
mkdir -p ~/.config/opencode/plugins
git clone https://github.com/Red44/crofai-opencode.git ~/.config/opencode/plugins/crofai-opencode
cd ~/.config/opencode/plugins/crofai-opencode
bun install
```

Create `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "./plugins/crofai-opencode/src/index.ts"
  ]
}
```

### Per-project

```bash
mkdir -p .opencode/plugins
git clone https://github.com/Red44/crofai-opencode.git .opencode/plugins/crofai-opencode
cd .opencode/plugins/crofai-opencode
bun install
```

Create `.opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "./plugins/crofai-opencode/src/index.ts"
  ]
}
```

## Configuration

Set your CrofAI API key as an environment variable:

```bash
export CROFAI_API_KEY="nahcrof_yourkeyhere"
```

Add it to your shell profile (`~/.bashrc`, `~/.zshrc`) to persist.

Start OpenCode:

```bash
opencode
```

The sidebar will show a **CrofAI** section with your requests/day and credit balance.

## Auto-updates

On startup, the plugin runs `git fetch` in its own directory to check for new commits on `main`. If found, it pulls the changes and displays `Plugin updated - restart to apply` in the sidebar. This runs asynchronously and never blocks the UI.

Repeats every 24 hours while OpenCode is running.

## Sidebar states

| State | Display |
|---|---|
| API key set, data loaded | `CrofAI` + `Requests: XXX/day` + `Credits: $X.XXXX` |
| API key not set | `CrofAI` + `Set CROFAI_API_KEY` |
| Fetch failed | `CrofAI` + `Failed to fetch usage` |
| Loading | `CrofAI` + `Loading...` |
| Update pulled | `Plugin updated - restart to apply` |

Usage data refreshes every 30 seconds.

## Troubleshooting

**Plugin doesn't appear:**
- Verify the path in `tui.json` resolves: `ls ~/.config/opencode/plugins/crofai-opencode/src/index.ts`
- Ensure `bun install` was run in the plugin directory
- Restart OpenCode

**"Set CROFAI_API_KEY":**
- The environment variable is missing. Export it before starting OpenCode.

**"Failed to fetch usage":**
- Verify your API key at [crof.ai](https://crof.ai/)
- Check network connectivity

## Development

```bash
git clone https://github.com/Red44/crofai-opencode.git
cd crofai-opencode
bun install
```

The plugin source is `src/index.ts`. OpenCode loads `.ts` files directly via its Bun runtime — no build step needed for development.

## License

MIT
