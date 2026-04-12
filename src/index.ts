import { createElement, createTextNode, insert } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { readFileSync, writeFileSync } from "fs"

const CROFAI_URL = "https://crof.ai/usage_api/"
const COMMIT_URL = "https://api.github.com/repos/Red44/crofai-opencode/commits/main"
const FILE_URL = "https://raw.githubusercontent.com/Red44/crofai-opencode/main/src/index.ts"
const UPDATE_INTERVAL = 24 * 60 * 60 * 1000

interface UsageData {
  credits: number
  usable_requests: number | null
}

function getCrofaiKey(api: TuiPluginApi): string | undefined {
  const fromEnv = process.env.CROFAI_API_KEY
  if (fromEnv) return fromEnv
  const provider = api.state.provider.find(p => p.name === "CrofAI")
  if (!provider) return undefined
  return provider.key || (provider.options?.apiKey as string | undefined)
}

async function fetchUsage(key: string): Promise<UsageData | null> {
  try {
    const res = await fetch(CROFAI_URL, {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function buildSidebar(api: TuiPluginApi, d: UsageData | null, err: boolean, updated: boolean) {
  const t = api.theme.current

  const root = createElement("box", {
    border: true,
    borderColor: t.border,
    backgroundColor: t.backgroundPanel,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    flexDirection: "column",
    gap: 1,
  })

  const title = createElement("text", { fg: t.primary })
  insert(title, createTextNode("CrofAI"))
  insert(root, title)

  if (err) {
    const errText = createElement("text", { fg: t.error })
    insert(errText, createTextNode("Failed to fetch usage"))
    insert(root, errText)
  } else if (!d) {
    const loadingText = createElement("text", { fg: t.textMuted })
    insert(loadingText, createTextNode("Loading..."))
    insert(root, loadingText)
  } else {
    if (d.usable_requests !== null) {
      const reqLine = createElement("text", { fg: t.info })
      insert(reqLine, createTextNode("Requests: " + d.usable_requests + "/day"))
      insert(root, reqLine)
    } else {
      const planText = createElement("text", { fg: t.textMuted })
      insert(planText, createTextNode("Pay-per-token"))
      insert(root, planText)
    }
    const credFg = d.credits < 0 ? t.error : t.success
    const credLine = createElement("text", { fg: credFg })
    insert(credLine, createTextNode("Credits: $" + d.credits.toFixed(4)))
    insert(root, credLine)
  }

  if (updated) {
    const upd = createElement("text", { fg: t.success })
    insert(upd, createTextNode("Updated - restart to apply"))
    insert(root, upd)
  }

  return root
}

const tui: TuiPlugin = async (api) => {
  const key = getCrofaiKey(api)
  if (!key) return

  const [getData, setData] = createSignal<UsageData | null>(null)
  const [getErr, setErr] = createSignal(false)
  const [getUpdated, setUpdated] = createSignal(false)

  const refresh = async () => {
    const result = await fetchUsage(key)
    if (result) { setData(result); setErr(false) }
    else { setErr(true) }
  }

  await refresh()
  const usageInterval = setInterval(refresh, 30000)

  const checkUpdate = async () => {
    try {
      const ownPath = new URL(import.meta.url).pathname
      const shaPath = ownPath.replace(/\.ts$/, ".sha")
      const res = await fetch(COMMIT_URL, { headers: { "User-Agent": "opencode-crofai-sidebar" } })
      if (!res.ok) return
      const remoteSha: string = (await res.json()).sha
      let localSha = ""
      try { localSha = readFileSync(shaPath, "utf8").trim() } catch {}
      if (localSha === remoteSha) return
      const fileRes = await fetch(FILE_URL)
      if (!fileRes.ok) return
      writeFileSync(ownPath, await fileRes.text())
      writeFileSync(shaPath, remoteSha)
      setUpdated(true)
    } catch {}
  }

  checkUpdate()
  const updateInterval = setInterval(checkUpdate, UPDATE_INTERVAL)

  api.lifecycle.onDispose(() => {
    clearInterval(usageInterval)
    clearInterval(updateInterval)
  })

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content() {
        return buildSidebar(api, getData(), getErr(), getUpdated())
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "crofai-sidebar",
  tui,
}

export default plugin
