import { createElement, createTextNode, insert } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginModule, TuiPluginApi, EventMessageUpdated, EventSessionUpdated } from "@opencode-ai/plugin/tui"

const CROFAI_URL = "https://crof.ai/usage_api/"
const PRICING_URL = "https://crof.ai/pricing"

interface UsageData {
  credits: number
  usable_requests: number | null
}

interface PricingModel {
  id: string
  speed?: number
}

function getCrofaiKey(api: TuiPluginApi): string | undefined {
  const provider = api.state.provider.find(p => p.name === "CrofAI")
  const fromConfig = provider?.options?.apiKey as string | undefined
  if (fromConfig) return fromConfig
  if (provider?.key) return provider.key
  return process.env.CROFAI_API_KEY
}

function getCrofaiProviderID(api: TuiPluginApi): string | undefined {
  return api.state.provider.find(p => p.name === "CrofAI")?.id
}

function isCrofaiSession(api: TuiPluginApi, sessionID: string, crofaiProviderID: string): boolean {
  const messages = api.state.session.messages(sessionID)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === "assistant") {
      return message.providerID === crofaiProviderID
    }
    if (message.role === "user") {
      return message.model.providerID === crofaiProviderID
    }
  }
  return false
}

function getSessionCrofaiModelID(api: TuiPluginApi, sessionID: string, crofaiProviderID: string): string | undefined {
  const messages = api.state.session.messages(sessionID)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === "assistant" && message.providerID === crofaiProviderID) {
      return message.modelID
    }
    if (message.role === "user" && message.model.providerID === crofaiProviderID) {
      return message.model.modelID
    }
  }
  return undefined
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

async function fetchPricingModels(): Promise<PricingModel[] | null> {
  try {
    const res = await fetch(PRICING_URL)
    if (!res.ok) return null
    const html = await res.text()
    const match = html.match(/const allModels = (\[[\s\S]*?\]);/)
    if (!match) return null
    return JSON.parse(match[1]) as PricingModel[]
  } catch {
    return null
  }
}

function buildSidebar(api: TuiPluginApi, d: UsageData | null, err: boolean, tps: number | null) {
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
    if (tps !== null) {
      const tpsLine = createElement("text", { fg: t.textMuted })
      insert(tpsLine, createTextNode("Speed: ~" + tps + " t/s"))
      insert(root, tpsLine)
    }
  }

  return root
}

const tui: TuiPlugin = async (api) => {
  const key = getCrofaiKey(api)
  const crofaiProviderID = getCrofaiProviderID(api)
  if (!key || !crofaiProviderID) return

  const [getData, setData] = createSignal<UsageData | null>(null)
  const [getErr, setErr] = createSignal(false)
  const [getPricingModels, setPricingModels] = createSignal<PricingModel[]>([])

  const refresh = async () => {
    const [result, pricingModels] = await Promise.all([fetchUsage(key), fetchPricingModels()])
    if (result) {
      setData(result)
      setErr(false)
    } else {
      setErr(true)
    }
    if (pricingModels) setPricingModels(pricingModels)
  }

  await refresh()
  const usageInterval = setInterval(refresh, 30000)

  api.lifecycle.onDispose(() => {
    clearInterval(usageInterval)
  })

  const onMessageUpdated = async (event: EventMessageUpdated) => {
    refresh()
  }

  const onSessionUpdated = async (event: EventSessionUpdated) => {
    refresh()
  }

  const eventUnsub = api.event.on("message.updated.1", onMessageUpdated)
  const sessionUnsub = api.event.on("session.updated.1", onSessionUpdated)

  api.lifecycle.onDispose(() => {
    clearInterval(usageInterval)
    eventUnsub()
    sessionUnsub()
  })

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        if (!isCrofaiSession(api, props.session_id, crofaiProviderID)) return null
        const modelID = getSessionCrofaiModelID(api, props.session_id, crofaiProviderID)
        const tps = modelID ? (getPricingModels().find((model) => model.id === modelID)?.speed ?? null) : null
        return buildSidebar(api, getData(), getErr(), tps)
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "crofai-sidebar",
  tui,
}

export default plugin
