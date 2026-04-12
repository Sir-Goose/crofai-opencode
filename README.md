# opencode-crofai-sidebar

CrofAI usage stats in the OpenCode sidebar. Shows requests/day and credits.

## Global install

Clone the repo into your global OpenCode plugins directory, then register it in your global `tui.json`.

### macOS / Linux

```bash
mkdir -p ~/.config/opencode/plugins
git clone https://github.com/Red44/crofai-opencode.git ~/.config/opencode/plugins/crofai-opencode
```

Create or update `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "./plugins/crofai-opencode/src/index.ts"
  ]
}
```

### Windows (PowerShell)

```powershell
New-Item -ItemType Directory -Force "$HOME/.config/opencode/plugins" | Out-Null
git clone https://github.com/Red44/crofai-opencode.git "$HOME/.config/opencode/plugins/crofai-opencode"
```

Create or update `$HOME/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "./plugins/crofai-opencode/src/index.ts"
  ]
}
```

## Update

```bash
git -C ~/.config/opencode/plugins/crofai-opencode pull
```

On Windows (PowerShell):

```powershell
git -C "$HOME/.config/opencode/plugins/crofai-opencode" pull
```

## Requirements

- CrofAI must be configured as an OpenCode provider in your `opencode.json`
- The plugin reads the API key from the configured CrofAI provider automatically
- `CROFAI_API_KEY` can still be used as a fallback override

## Behavior

- Shows `Requests: XXX/day` and `Credits: $X.XXXX`
- Only appears for sessions actually using a CrofAI model
- Refreshes every 30 seconds

## License

MIT
