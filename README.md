# opencode-crofai-sidebar

CrofAI usage stats in the OpenCode sidebar. Shows requests/day and credits.

## Install

```bash
git clone https://github.com/Red44/crofai-opencode.git
cd crofai-opencode
bun install
```

Then add this to your global `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/absolute/path/to/crofai-opencode/src/index.ts"
  ]
}
```

## Update

```bash
git pull
bun install
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
