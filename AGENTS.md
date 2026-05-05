# crofai-opencode agent guide

## Build

```sh
bun build src/index.ts --outdir dist --target=bun --sourcemap \
  --external @opencode-ai/plugin \
  --external @opentui/core \
  --external @opentui/solid \
  --external solid-js
```

No lint, typecheck, test, or CI scripts exist. No test files. Run `bun build` to verify.

## Architecture

- **Single entrypoint**: `src/index.ts` (804 lines). Exports `{ id: "crofai-sidebar", tui }`.
- **Postinstall** (`scripts/postinstall.mjs`): runs on `bun install`, registers plugin in `~/.config/opencode/tui.json` and configures the CrofAI provider in `~/.config/opencode/opencode.json`.
- **No classes** — purely functional/imperative with Solid.js `createSignal` for reactivity.
- **External peer deps** (not bundled): `@opencode-ai/plugin`, `@opentui/core`, `@opentui/solid`, `solid-js`.

## Key behaviors an agent might miss

- **Auto-update** (`src/index.ts:34`): runs `git pull --ff-only && bun install` on startup. Don't be surprised if the repo changes behind you.
- **Multi-provider**: detects all CrofAI providers (CrofAI, CrofAI-Beta, CrofAI-Test) by matching `baseURL` against `CROFAI_ORIGINS` (`src/index.ts:78`). Session detection uses a `Set` of provider IDs, not a single ID.
- **Fetch monkey-patch** (`src/index.ts:516`): patches `globalThis.fetch` to intercept SSE chat completions from **all** CrofAI origins (`crof.ai`, `beta.crof.ai`, `test.crof.ai`) and rename `reasoning_content` → `reasoning_text`. Uses a `Symbol.for("crofai.opencode.fetchPatch")` refcount.
- **Model auto-config** (`src/index.ts:425`): fetches `/v1/models` from each known CrofAI provider, creates DeepSeek reasoning variants (high/max), deep-merges with existing `opencode.json` to preserve user overrides, triggers provider `dispose()` on changes.
- **SSE reasoning transform** (`src/index.ts:526`): `createCrofaiReasoningTransform()` returns a `TransformStream` that rewrites `"reasoning_content"` to `"reasoning_text"` in SSE data lines.
- **Config paths**: `~/.config/opencode/opencode.json` (provider models, API key) and `~/.config/opencode/tui.json` (plugin registration).
- **Token collection** (`src/index.ts:260`): recursively collects tokens from child/branch sessions up to max depth 5.
- **Pricing scrape** (`src/index.ts:303`): regex-parses HTML from `https://crof.ai/pricing` for model speed (tokens/sec). Fragile if pricing page structure changes.

## Conventions

- Plugin ID: `"crofai-sidebar"`, slot: `sidebar_content` at order 150.
- CrofAI providers detected dynamically by matching `baseURL` against known origins. Defined in `CROFAI_PROVIDER_CONFIGS` (`src/index.ts:86`).
- API key resolved from provider config first, then `CROFAI_API_KEY` or `TEST_CROFAI_API_KEY` env vars.
- `buildSidebar` accepts a `providerName` string to differentiate between CrofAI, CrofAI-Beta, etc. in the sidebar title.
- Config deep-merge preserves user overrides: `stableStringify` + `sortForJson` for deterministic JSON output.
