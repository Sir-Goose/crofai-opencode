# opencode-crofai-sidebar

OpenCode TUI plugin that displays [CrofAI](https://crof.ai/) usage stats in the sidebar — requests remaining per day and credit balance.

## Prerequisites

- [OpenCode](https://opencode.ai/) >= 1.4.1
- A CrofAI API key (get one at [crof.ai](https://crof.ai/))

## Installation

### Option 1: npm

```bash
npm install opencode-crofai-sidebar
```

### Option 2: OpenCode plugin install

```bash
opencode plugin install opencode-crofai-sidebar
```

### Option 3: From source

```bash
git clone https://github.com/sst/opencode-crofai-sidebar.git
cd opencode-crofai-sidebar
npm install
npm run build
npm link
# Then in your project: npm link opencode-crofai-sidebar
```

## Configuration

### 1. Set your API key

```bash
export CROFAI_API_KEY="nahcrof_yourkeyhere"
```

Add this to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) to persist it.

### 2. Register the plugin in `tui.json`

Create or edit `.opencode/tui.json` in your project root (or `~/.config/opencode/tui.json` for global use):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "opencode-crofai-sidebar/tui"
  ]
}
```

The `"opencode-crofai-sidebar/tui"` path resolves to the `exports["./tui"]` entrypoint defined in the package.

### 3. Start OpenCode

```bash
opencode
```

You should see a **CrofAI** section in the sidebar showing your requests/day and credit balance.

## What it shows

| State | Display |
|---|---|
| API key set, data loaded | `CrofAI` + `Requests: XXX/day` + `Credits: $X.XXXX` |
| API key not set | `CrofAI` + `Set CROFAI_API_KEY` + `export CROFAI_API_KEY=...` |
| Fetch failed | `CrofAI` + `Failed to fetch usage` |
| Loading | `CrofAI` + `Loading...` |

Data refreshes automatically every 30 seconds.

## Troubleshooting

**Plugin doesn't appear in sidebar:**
- Ensure the package is installed: `ls node_modules/opencode-crofai-sidebar`
- Ensure `tui.json` references `"opencode-crofai-sidebar/tui"` (not a file path)
- Restart OpenCode

**"Set CROFAI_API_KEY" shown:**
- The `CROFAI_API_KEY` environment variable is not set. Export it before starting OpenCode.

**"Failed to fetch usage" shown:**
- Check that your API key is valid at `https://crof.ai/`
- Verify network connectivity to `crof.ai`

## Development

```bash
git clone https://github.com/sst/opencode-crofai-sidebar.git
cd opencode-crofai-sidebar
npm install
npm run build
```

## License

MIT
