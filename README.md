# opencode-crofai-sidebar

CrofAI usage stats in the OpenCode sidebar. Shows requests/day and credits.

## Install

```bash
git clone https://github.com/Red44/crofai-opencode.git
cd crofai-opencode
bun install
```

`bun install` automatically registers the plugin in your global OpenCode `tui.json`.

## Update

```bash
git pull
bun install
```

Running `bun install` again keeps the entry up to date and avoids duplicate plugin entries.

## Requirements

- CrofAI must be configured as an OpenCode provider in your `opencode.json`
- The plugin reads the API key from the configured CrofAI provider automatically
- `CROFAI_API_KEY` can still be used as a fallback override

## Behavior

- Shows `Requests: XXX/day` and `Credits: $X.XXXX`
- Only appears for sessions actually using a CrofAI model
- Updates in real-time after every message
- Falls back to 30-second interval if no messages are sent

## License

MIT
