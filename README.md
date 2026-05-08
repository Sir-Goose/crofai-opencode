# opencode-crofai-sidebar

CrofAI usage stats in the OpenCode sidebar. Shows requests remaining, credits, model speed, and token consumption (including child/branch sessions).

Works with **CrofAI**, **CrofAI-Beta**, and **CrofAI-Test** providers — detected automatically by matching the provider's `baseURL`.

## Install

```bash
git clone https://github.com/Sir-Goose/crofai-opencode.git
cd crofai-opencode
bun install
```

`bun install` automatically registers the plugin in your global OpenCode `tui.json`.
It also configures both the **CrofAI** and **CrofAI-Beta** providers in `opencode.json` using their respective `/v1/models` APIs.
On plugin startup it refreshes models for all CrofAI providers in the background and applies newly fetched models when OpenCode is idle, so active responses keep streaming without interruption.

## Updating

On every OpenCode start the plugin runs `git pull --ff-only` in the background. If new commits are found it runs `bun install` automatically. No manual steps needed.

## Requirements

- OpenCode >= 1.4.1
- At least one CrofAI provider (CrofAI, CrofAI-Beta, or CrofAI-Test) must be configured in your `opencode.json`
- `bun install` auto-configures both **CrofAI** and **CrofAI-Beta** providers
- The plugin reads API keys from provider config; `CROFAI_API_KEY` and `TEST_CROFAI_API_KEY` env vars are fallbacks
- Existing provider config (`options.apiKey`, model overrides) is preserved via deep-merge

## Behavior

- Shows token count for the current session (`XXX tokens`) and child/branch sessions (`XXX tokens (sub-agents)`)
- Shows `XXX requests remaining` or `Pay-per-token` depending on your plan
- Shows credit balance (`$X.XXXX credits`) — red when negative, green when positive
- Shows current model speed as `~XX t/s` using data extracted from the CrofAI pricing page HTML
- Only appears for sessions that already have CrofAI (or CrofAI-Beta) message history
- Shows the provider name as the sidebar title, e.g. "CrofAI" or "CrofAI-Beta"
- Updates in real-time after every message
- Falls back to 30-second interval if no messages are sent
- Refreshes the model list from each CrofAI provider's `/v1/models` on startup and every 30 minutes, then applies changes when OpenCode is idle
- Auto-updates from git on every OpenCode start (non-blocking)

## License

MIT
