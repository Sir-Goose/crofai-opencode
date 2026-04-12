# opencode-crofai-sidebar

CrofAI usage stats in the OpenCode sidebar. Shows requests/day and credits.

## Install

```bash
mkdir -p ~/.config/opencode/plugins && curl -sL https://raw.githubusercontent.com/Red44/crofai-opencode/main/src/index.ts -o ~/.config/opencode/plugins/crofai-sidebar.ts
```

That's it. OpenCode loads `.ts` files directly — no build, no `bun install`, no dependencies to manage.

Auto-updates via GitHub API. When a new version is published the plugin downloads it in the background and shows "Updated - restart to apply".

## Requirements

- The CrofAI provider must be configured in your `opencode.json` (with an `apiKey`). The plugin reads the key from there automatically.
- If you prefer env vars instead, set `CROFAI_API_KEY` in your shell.

## How it works

- Shows `Requests: XXX/day` and `Credits: $X.XXXX` in the sidebar
- Only appears when a CrofAI provider is configured (hidden otherwise)
- Refreshes every 30 seconds

## License

MIT
