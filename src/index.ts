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
const MODELS_URL = "https://crof.ai/v1/models"
const MODEL_REFRESH_INTERVAL_MS = 30 * 60 * 1000
const MODEL_RELOAD_IDLE_MS = 1500
const MODEL_RELOAD_STARTUP_GRACE_MS = 3000

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
  custom_reasoning?: boolean
  reasoning?: boolean
  speed?: number
}

type ModelConfig = Record<string, unknown>

const OPENCODE_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json")
const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json"
const DEEPSEEK_THINKING_EFFORTS = ["high", "max"] as const
const DEEPSEEK_DISABLED_THINKING_EFFORTS = ["low", "medium", "xhigh"] as const

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
    const res = await fetch(MODELS_URL)
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

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForJson(value), null, 2) + "\n"
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForJson)
  if (!isObject(value)) return value

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForJson(value[key])]),
  )
}

function modelSupportsReasoning(model: ModelsApiModel): boolean {
  return model.custom_reasoning === true || model.reasoning === true
}

function modelUsesDeepSeekThinking(model: ModelsApiModel): boolean {
  return modelSupportsReasoning(model) && model.id.toLowerCase().includes("deepseek-v4")
}

function toReasoningVariants(model: ModelsApiModel): Record<string, unknown> | undefined {
  if (!modelUsesDeepSeekThinking(model)) return undefined

  const variants = Object.fromEntries(
    DEEPSEEK_THINKING_EFFORTS.map((effort) => [effort, {
      reasoningEffort: effort,
      thinking: { type: "enabled" },
    }]),
  )
  for (const effort of DEEPSEEK_DISABLED_THINKING_EFFORTS) {
    variants[effort] = { disabled: true }
  }
  return variants
}

function toInstalledModelConfig(model: ModelsApiModel): ModelConfig {
  const context = Number(model.context_length)
  const output = Number(model.max_completion_tokens)
  const reasoning = modelSupportsReasoning(model)
  const variants = toReasoningVariants(model)

  return {
    name: `CrofAI: ${model.id}`,
    ...(reasoning ? { reasoning: true } : {}),
    ...(variants ? { variants } : {}),
    limit: {
      context: Number.isFinite(context) ? context : 0,
      output: Number.isFinite(output) ? output : 0,
    },
  }
}

function mergeVariantConfig(generated: unknown, existing: unknown): unknown {
  if (!isObject(generated)) return existing ?? generated
  if (!isObject(existing)) return generated

  const merged: Record<string, unknown> = { ...generated, ...existing }
  for (const [key, generatedVariant] of Object.entries(generated)) {
    const existingVariant = existing[key]
    if (isObject(generatedVariant) && isObject(existingVariant)) {
      merged[key] = { ...generatedVariant, ...existingVariant }
    }
  }
  return merged
}

function mergeModelConfig(generated: ModelConfig, existing: ModelConfig): ModelConfig {
  const merged = { ...generated, ...existing }
  if ("variants" in generated) {
    merged.variants = mergeVariantConfig(generated.variants, existing.variants)
  }
  return merged
}

interface ModelRefreshResult {
  changed: boolean
  models: ModelsApiModel[]
  installedModels: Record<string, unknown>
}

async function refreshGlobalOpencodeConfig(): Promise<ModelRefreshResult | null> {
  const models = await fetchModelsApi()
  if (!models) return null

  const config = readOpencodeConfig()
  const provider = isObject(config.provider) ? config.provider : {}
  const existingCrofai = isObject(provider.CrofAI) ? provider.CrofAI : {}
  const existingOptions = isObject(existingCrofai.options) ? existingCrofai.options : {}

  const existingCrofaiModels = isObject(existingCrofai.models) ? (existingCrofai.models as Record<string, unknown>) : {}
  const mergedModels: Record<string, unknown> = {}
  for (const model of models) {
    const existingModel = isObject(existingCrofaiModels[model.id]) ? (existingCrofaiModels[model.id] as Record<string, unknown>) : {}
    mergedModels[model.id] = mergeModelConfig(toInstalledModelConfig(model), existingModel)
  }

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
        models: mergedModels,
      },
    },
  }

  fs.mkdirSync(path.dirname(OPENCODE_CONFIG_PATH), { recursive: true })
  const before = stableStringify(config)
  const after = stableStringify(nextConfig)
  if (before === after) return { changed: false, models, installedModels: mergedModels }
  fs.writeFileSync(OPENCODE_CONFIG_PATH, after)
  return { changed: true, models, installedModels: mergedModels }
}

function liveProviderNeedsModelReload(api: TuiPluginApi, installedModels: Record<string, unknown>): boolean {
  const provider = api.state.provider.find((item) => item.name === "CrofAI")
  if (!provider) return false
  const liveModels = isObject(provider.models) ? provider.models : {}

  for (const [modelID, installedModel] of Object.entries(installedModels)) {
    if (!isObject(installedModel)) continue
    const liveModel = liveModels[modelID]
    if (!isObject(liveModel)) continue
    if (!liveModel) continue

    const capabilities = isObject(liveModel.capabilities) ? liveModel.capabilities : {}
    if (installedModel.reasoning === true && capabilities.reasoning !== true) return true

    const installedVariants = isObject(installedModel.variants) ? installedModel.variants : undefined
    if (!installedVariants) continue

    const liveVariants = isObject(liveModel.variants) ? liveModel.variants : {}
    for (const variantID of Object.keys(installedVariants)) {
      if (!(variantID in liveVariants)) return true
    }
  }

  return false
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
  void autoUpdate()

  const activeSessions = new Set<string>()
  const startedAt = Date.now()
  let pendingModelReload = false
  let modelReloadTimer: ReturnType<typeof setTimeout> | undefined
  let modelRefreshInFlight = false
  let disposed = false

  function hasActiveSession(): boolean {
    return activeSessions.size > 0
  }

  function clearModelReloadTimer(): void {
    if (!modelReloadTimer) return
    clearTimeout(modelReloadTimer)
    modelReloadTimer = undefined
  }

  function scheduleModelReload(): void {
    if (!pendingModelReload || disposed) return
    clearModelReloadTimer()

    const startupDelay = Math.max(0, MODEL_RELOAD_STARTUP_GRACE_MS - (Date.now() - startedAt))
    const delay = Math.max(MODEL_RELOAD_IDLE_MS, startupDelay)
    modelReloadTimer = setTimeout(() => {
      modelReloadTimer = undefined
      if (disposed || !pendingModelReload) return
      if (hasActiveSession()) {
        scheduleModelReload()
        return
      }

      pendingModelReload = false
      void api.client.global.dispose().catch(() => {
        pendingModelReload = true
        scheduleModelReload()
      })
    }, delay)
  }

  async function refreshModels(): Promise<void> {
    if (modelRefreshInFlight || disposed) return
    modelRefreshInFlight = true
    try {
      const result = await refreshGlobalOpencodeConfig()
      if (result && (result.changed || liveProviderNeedsModelReload(api, result.installedModels))) {
        pendingModelReload = true
        scheduleModelReload()
      }
    } finally {
      modelRefreshInFlight = false
    }
  }

  void refreshModels()
  const modelRefreshInterval = setInterval(() => {
    void refreshModels()
  }, MODEL_REFRESH_INTERVAL_MS)

  const sessionStatusUnsub = api.event.on("session.status", (event) => {
    if (event.properties.status.type === "idle") {
      activeSessions.delete(event.properties.sessionID)
    } else {
      activeSessions.add(event.properties.sessionID)
    }
    scheduleModelReload()
  })

  const key = getCrofaiKey(api)
  const crofaiProviderID = getCrofaiProviderID(api)
  if (!key || !crofaiProviderID) {
    api.lifecycle.onDispose(() => {
      disposed = true
      clearInterval(modelRefreshInterval)
      clearModelReloadTimer()
      sessionStatusUnsub()
    })
    return
  }

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

  let usageRefreshInFlight = false
  let usageRefreshQueued = false

  const refresh = async () => {
    if (usageRefreshInFlight) {
      usageRefreshQueued = true
      return
    }
    usageRefreshInFlight = true
    try {
      const [result, pricingModels] = await Promise.all([fetchUsage(key), fetchPricingModels()])
      if (result) {
        setData(result)
        setErr(false)
      } else {
        setErr(true)
      }
      if (pricingModels) setPricingModels(pricingModels)
    } finally {
      usageRefreshInFlight = false
      if (usageRefreshQueued) {
        usageRefreshQueued = false
        void refresh()
      }
    }
  }

  void refresh()
  const usageInterval = setInterval(() => {
    void refresh()
    const sid = getCurrentSessionID()
    if (sid) refreshChildTokens(sid, true)
  }, 30000)

  const onSessionUpdated = async () => {
    void refresh()
    const sid = getCurrentSessionID()
    if (sid) refreshChildTokens(sid, true)
  }

  const sessionUnsub = api.event.on("session.updated.1", onSessionUpdated)

  api.lifecycle.onDispose(() => {
    disposed = true
    clearInterval(modelRefreshInterval)
    clearModelReloadTimer()
    clearInterval(usageInterval)
    sessionStatusUnsub()
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
