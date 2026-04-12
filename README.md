# opencode-crofai-sidebar

CrofAI usage stats in the OpenCode sidebar. Shows requests/day and credits.

## Install

```bash
git clone https://github.com/Red44/crofai-opencode.git
cd crofai-opencode
bun install
```

`bun install` automatically registers the plugin in your global OpenCode `tui.json`.
It also configures the global OpenCode `opencode.json` CrofAI provider automatically using the live `https://crof.ai/v1/models` API.
On plugin startup it also performs a best-effort live refresh of the running OpenCode config, so newly fetched CrofAI models can apply without a restart.

## Update

```bash
git pull
bun install
```

Running `bun install` again keeps the entry up to date and avoids duplicate plugin entries.
It also refreshes the CrofAI model list in `opencode.json` while preserving an existing CrofAI API key if one is already configured.

## Requirements

- CrofAI must be configured as an OpenCode provider in your `opencode.json`
- `bun install` auto-configures the CrofAI provider in `opencode.json`
- The plugin reads the API key from the configured CrofAI provider automatically
- `CROFAI_API_KEY` can still be used as a fallback override
- Existing `provider.CrofAI.options.apiKey` values are preserved and never overwritten

## Behavior

- Shows `Requests: XXX/day` and `Credits: $X.XXXX`
- Shows current model speed as `~XX t/s` using data extracted from the CrofAI pricing page HTML
- Only appears for sessions that already have CrofAI message history
- Updates in real-time after every message
- Falls back to 30-second interval if no messages are sent
- Refreshes the CrofAI model list from `/v1/models` and pushes a best-effort live config update on plugin startup

## License

MIT
