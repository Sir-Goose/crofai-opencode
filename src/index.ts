import { createElement, createTextNode, insert } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"

const CROFAI_URL = "https://crof.ai/usage_api/"

interface UsageData {
  credits: number
  usable_requests: number | null
}

function getCrofaiKey(api: TuiPluginApi): string | undefined {
  const fromEnv = process.env.CROFAI_API_KEY
  if (fromEnv) return fromEnv
  const provider = api.state.provider.find(p => p.name === "CrofAI")
  return provider?.key
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

function buildSidebar(api: TuiPluginApi, d: UsageData | null, err: boolean) {
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

  return root
}

const tui: TuiPlugin = async (api) => {
  const key = getCrofaiKey(api)
  if (!key) return

  const [getData, setData] = createSignal<UsageData | null>(null)
  const [getErr, setErr] = createSignal(false)

  const refresh = async () => {
    const result = await fetchUsage(key)
    if (result) { setData(result); setErr(false) }
    else { setErr(true) }
  }

  await refresh()
  const interval = setInterval(refresh, 30000)

  api.lifecycle.onDispose(() => {
    clearInterval(interval)
  })

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content() {
        return buildSidebar(api, getData(), getErr())
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "crofai-sidebar",
  tui,
}

export default plugin
