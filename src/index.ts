import { createElement, createTextNode, insert } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { exec as execCb } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const CROFAI_URL = "https://crof.ai/usage_api/"
const PRICING_URL = "https://crof.ai/pricing"

const execAsync = promisify(execCb)

function findGitRepo(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function autoUpdate(): Promise<void> {
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url))
    const repoDir = findGitRepo(thisDir)
    if (!repoDir) return

    const { stdout } = await execAsync("git pull --ff-only", { cwd: repoDir })
    if (stdout.includes("Already up to date.")) return

    await execAsync("bun install", { cwd: repoDir })
  } catch {
    return
  }
}

interface UsageData {
  credits: number
  usable_requests: number | null
}

interface PricingModel {
  id: string
  speed?: number
}

interface ModelsApiModel {
  id: string
  context_length: number | string
  max_completion_tokens: number | string
  speed?: number
}

const OPENCODE_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json")
const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json"

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

function formatNum(n: number): string {
  if (n >= 1e12) return (n / 1e12).toFixed(1).replace(/\.0$/, "") + "T"
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B"
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K"
  return n.toString()
}

interface SessionTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
}

type SessionMessage = ReturnType<TuiPluginApi["state"]["session"]["messages"]>[number]

function getTokensFromMessages(messages: ReadonlyArray<SessionMessage>): SessionTokens {
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tokens) {
      input += msg.tokens.input || 0
      output += msg.tokens.output || 0
      reasoning += msg.tokens.reasoning || 0
      cacheRead += msg.tokens.cache?.read || 0
      cacheWrite += msg.tokens.cache?.write || 0
    }
  }

  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  }
}

function getSessionTokens(api: TuiPluginApi, sessionID: string): SessionTokens {
  return getTokensFromMessages(api.state.session.messages(sessionID))
}

function mergeTokens(a: SessionTokens, b: SessionTokens): SessionTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  }
}

function zeroTokens(): SessionTokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function getResponseData(value: unknown): unknown {
  if (isObject(value) && "data" in value) return value.data
  return value
}

async function callSessionEndpoint<T>(
  api: TuiPluginApi,
  method: "children" | "messages",
  sessionID: string,
): Promise<T[]> {
  const sessionClient = api.client.session as unknown as Record<typeof method, (parameters: unknown) => Promise<unknown>>

  try {
    const result = await sessionClient[method]({ sessionID })
    const data = getResponseData(result)
    if (Array.isArray(data)) return data as T[]
  } catch (_error) {
    // Older OpenCode SDKs used a generated client shape with path parameters.
  }

  const result = await sessionClient[method]({ path: { id: sessionID } })
  const data = getResponseData(result)
  return Array.isArray(data) ? data as T[] : []
}

async function getSessionTokensFromClient(api: TuiPluginApi, sessionID: string): Promise<SessionTokens> {
  const entries = await callSessionEndpoint<{ info?: SessionMessage } | SessionMessage>(api, "messages", sessionID)
  const messages = entries.map((entry) => isObject(entry) && "info" in entry ? entry.info : entry).filter(Boolean)
  return getTokensFromMessages(messages as SessionMessage[])
}

async function collectChildTokens(
  api: TuiPluginApi,
  sessionID: string,
  depth: number = 0,
  maxDepth: number = 5,
): Promise<SessionTokens> {
  if (depth >= maxDepth) return zeroTokens()
  try {
    const children = await callSessionEndpoint<{ id?: string }>(api, "children", sessionID)
    if (!children || children.length === 0) return zeroTokens()

    const acc = zeroTokens()
    for (const child of children) {
      if (!child.id) continue
      const parentTokens = await getSessionTokensFromClient(api, child.id)
      const childTokens = await collectChildTokens(api, child.id, depth + 1, maxDepth)
      acc.input += parentTokens.input + childTokens.input
      acc.output += parentTokens.output + childTokens.output
      acc.reasoning += parentTokens.reasoning + childTokens.reasoning
      acc.cacheRead += parentTokens.cacheRead + childTokens.cacheRead
      acc.cacheWrite += parentTokens.cacheWrite + childTokens.cacheWrite
    }
    acc.total = acc.input + acc.output + acc.reasoning + acc.cacheRead + acc.cacheWrite
    return acc
  } catch {
    return zeroTokens()
  }
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

async function fetchModelsApi(): Promise<ModelsApiModel[] | null> {
  try {
    const res = await fetch(`${CROFAI_URL.replace("/usage_api/", "/v1/models")}`)
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data.data)) return null
    return data.data as ModelsApiModel[]
  } catch (_error) {
    return null
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readOpencodeConfig(): Record<string, unknown> {
  if (!fs.existsSync(OPENCODE_CONFIG_PATH)) {
    return { $schema: OPENCODE_CONFIG_SCHEMA, provider: {} }
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(OPENCODE_CONFIG_PATH, "utf8"))
    if (!isObject(parsed)) return { $schema: OPENCODE_CONFIG_SCHEMA, provider: {} }
    return parsed
  } catch (_error) {
    return { $schema: OPENCODE_CONFIG_SCHEMA, provider: {} }
  }
}

function toInstalledModelConfig(model: ModelsApiModel) {
  const context = Number(model.context_length)
  const output = Number(model.max_completion_tokens)

  return {
    name: `CrofAI: ${model.id}`,
    limit: {
      context: Number.isFinite(context) ? context : 0,
      output: Number.isFinite(output) ? output : 0,
    },
  }
}

async function refreshGlobalOpencodeConfig(api: TuiPluginApi): Promise<void> {
  const models = await fetchModelsApi()
  if (!models) return

  const config = readOpencodeConfig()
  const provider = isObject(config.provider) ? config.provider : {}
  const existingCrofai = isObject(provider.CrofAI) ? provider.CrofAI : {}
  const existingOptions = isObject(existingCrofai.options) ? existingCrofai.options : {}

  const nextConfig = {
    ...config,
    $schema: typeof config.$schema === "string" ? config.$schema : OPENCODE_CONFIG_SCHEMA,
    provider: {
      ...provider,
      CrofAI: {
        ...existingCrofai,
        name: "CrofAI",
        npm: "@ai-sdk/openai-compatible",
        options: {
          ...existingOptions,
          ...(typeof existingOptions.apiKey === "string" ? {} : { apiKey: process.env.CROFAI_API_KEY || "{env:CROFAI_API_KEY}" }),
          baseURL: "https://crof.ai/v1",
        },
        models: Object.fromEntries(models.map((model) => [model.id, toInstalledModelConfig(model)])),
      },
    },
  }

  fs.mkdirSync(path.dirname(OPENCODE_CONFIG_PATH), { recursive: true })
  fs.writeFileSync(OPENCODE_CONFIG_PATH, JSON.stringify(nextConfig, null, 2) + "\n")

  try {
    await api.client.global.config.update({
      config: nextConfig,
    })
  } catch (_error) {
    // file update already succeeded; live runtime update is best-effort
  }
}

function buildSidebar(
  api: TuiPluginApi,
  d: UsageData | null,
  err: boolean,
  tps: number | null,
  tokens: SessionTokens | null,
) {
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

  if (tokens && tokens.total > 0) {
    const tokenLine = createElement("text", { fg: t.info })
    insert(tokenLine, createTextNode("Tokens: " + formatNum(tokens.total)))
    insert(root, tokenLine)
  }

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
    if (tps !== null) {
      const tpsLine = createElement("text", { fg: t.textMuted })
      insert(tpsLine, createTextNode("Speed: ~" + tps + " t/s"))
      insert(root, tpsLine)
    }
    const credFg = d.credits < 0 ? t.error : t.success
    const credLine = createElement("text", { fg: credFg })
    insert(credLine, createTextNode("Credits: $" + d.credits.toFixed(4)))
    insert(root, credLine)
  }

  return root
}

const tui: TuiPlugin = async (api) => {
  void refreshGlobalOpencodeConfig(api)
  void autoUpdate()

  const key = getCrofaiKey(api)
  const crofaiProviderID = getCrofaiProviderID(api)
  if (!key || !crofaiProviderID) return

  const [getData, setData] = createSignal<UsageData | null>(null)
  const [getErr, setErr] = createSignal(false)
  const [getPricingModels, setPricingModels] = createSignal<PricingModel[]>([])
  const [getChildTokens, setChildTokens] = createSignal<{
    sessionID: string
    tokens: SessionTokens | null
  } | null>(null)
  const [getCurrentSessionID, setCurrentSessionID] = createSignal<string | null>(null)
  let childTokenRefreshSeq = 0
  const childTokenRefreshInFlight = new Set<string>()

  async function refreshChildTokens(sessionID: string, force: boolean = false): Promise<void> {
    if (!force && childTokenRefreshInFlight.has(sessionID)) return
    if (!force && getChildTokens()?.sessionID === sessionID) return
    const seq = ++childTokenRefreshSeq
    childTokenRefreshInFlight.add(sessionID)
    try {
      const tokens = await collectChildTokens(api, sessionID)
      if (seq !== childTokenRefreshSeq || getCurrentSessionID() !== sessionID) return
      setChildTokens({ sessionID, tokens: tokens.total > 0 ? tokens : null })
    } finally {
      childTokenRefreshInFlight.delete(sessionID)
    }
  }

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
  const usageInterval = setInterval(() => {
    refresh()
    const sid = getCurrentSessionID()
    if (sid) refreshChildTokens(sid, true)
  }, 30000)

  const onMessageUpdated = async () => {
    refresh()
    const sid = getCurrentSessionID()
    if (sid) refreshChildTokens(sid, true)
  }

  const onSessionUpdated = async () => {
    refresh()
    const sid = getCurrentSessionID()
    if (sid) refreshChildTokens(sid, true)
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
        setCurrentSessionID(props.session_id)
        refreshChildTokens(props.session_id)
        const modelID = getSessionCrofaiModelID(api, props.session_id, crofaiProviderID)
        const tps = modelID ? (getPricingModels().find((model) => model.id === modelID)?.speed ?? null) : null
        const parentTokens = getSessionTokens(api, props.session_id)
        const childTokens = getChildTokens()
        const allTokens = childTokens?.sessionID === props.session_id && childTokens.tokens
          ? mergeTokens(parentTokens, childTokens.tokens)
          : parentTokens
        return buildSidebar(api, getData(), getErr(), tps, allTokens)
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "crofai-sidebar",
  tui,
}

export default plugin
