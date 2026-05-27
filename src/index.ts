import { TextAttributes } from "@opentui/core"
import { createElement, createTextNode, insert } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { exec as execCb } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { isObject, formatModelName, mergeModelConfig, toModelConfig, fetchModelsApi } from "./shared"
import type { ModelsApiModel, ModelConfig } from "./shared"

const CROFAI_URL = "https://crof.ai/usage_api/"
const PRICING_URL = "https://crof.ai/pricing"
const MODEL_REFRESH_INTERVAL_MS = 30 * 60 * 1000
const MODEL_RELOAD_IDLE_MS = 1500
const MODEL_RELOAD_STARTUP_GRACE_MS = 3000
const PRICING_REFRESH_INTERVAL_MS = 30 * 60 * 1000
const SESSION_UPDATE_REFRESH_MIN_INTERVAL_MS = 8000
const BACKGROUND_STARTUP_GRACE_MS = 45000
const ENABLE_AUTO_UPDATE = true
const ENABLE_MODEL_REFRESH = true
const ENABLE_USAGE_REFRESH = true
const ENABLE_CHILD_TOKEN_REFRESH = true

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

const OPENCODE_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json")
const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json"

const CROFAI_ORIGINS = ["https://crof.ai", "https://beta.crof.ai", "https://test.crof.ai"] as const

interface CrofaiProviderConfig {
  name: string
  baseURL: string
  envVar: string
}

const CROFAI_PROVIDER_CONFIGS: CrofaiProviderConfig[] = [
  { name: "CrofAI", baseURL: "https://crof.ai/v1", envVar: "CROFAI_API_KEY" },
  { name: "CrofAI-Beta", baseURL: "https://beta.crof.ai/v1", envVar: "CROFAI_API_KEY" },
  { name: "CrofAI-Test", baseURL: "https://test.crof.ai/v1", envVar: "TEST_CROFAI_API_KEY" },
]

function isCrofaiBaseURL(baseURL: string): boolean {
  return CROFAI_ORIGINS.some(origin => baseURL.startsWith(origin))
}

function getCrofaiKey(api: TuiPluginApi): string | undefined {
  for (const p of api.state.provider) {
    if (typeof p.options?.baseURL !== "string" || !isCrofaiBaseURL(p.options.baseURL)) continue
    const fromConfig = p.options?.apiKey as string | undefined
    if (fromConfig) return fromConfig
    if (p.key) return p.key
  }
  return process.env.CROFAI_API_KEY || process.env.TEST_CROFAI_API_KEY
}

function getCrofaiProviders(api: TuiPluginApi): Array<{ name: string; id: string; baseURL: string; origin: string }> {
  return api.state.provider
    .filter(p => typeof p.options?.baseURL === "string" && isCrofaiBaseURL(p.options.baseURL))
    .map(p => ({
      name: p.name,
      id: p.id,
      baseURL: p.options!.baseURL as string,
      origin: new URL(p.options!.baseURL as string).origin,
    }))
}

function getSessionCrofaiProvider(
  api: TuiPluginApi,
  sessionID: string,
  providers: Array<{ name: string; id: string; baseURL: string; origin: string }>,
): { name: string; id: string; baseURL: string; origin: string } | undefined {
  const providerIDs = new Set(providers.map(p => p.id))
  const messages = api.state.session.messages(sessionID)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === "assistant" && providerIDs.has(message.providerID)) {
      return providers.find(p => p.id === message.providerID)
    }
    if (message.role === "user" && providerIDs.has(message.model.providerID)) {
      return providers.find(p => p.id === message.model.providerID)
    }
  }
  return undefined
}

function isCrofaiSession(api: TuiPluginApi, sessionID: string, providerIDs: Set<string>): boolean {
  const messages = api.state.session.messages(sessionID)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === "assistant") {
      return providerIDs.has(message.providerID)
    }
    if (message.role === "user") {
      return providerIDs.has(message.model.providerID)
    }
  }
  return false
}

function getSessionCrofaiModelID(api: TuiPluginApi, sessionID: string, providerIDs: Set<string>): string | undefined {
  const messages = api.state.session.messages(sessionID)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === "assistant" && providerIDs.has(message.providerID)) {
      return message.modelID
    }
    if (message.role === "user" && providerIDs.has(message.model.providerID)) {
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

async function fetchUsage(key: string, origin?: string): Promise<UsageData | null> {
  const url = origin ? `${origin}/usage_api/` : CROFAI_URL
  try {
    const res = await fetch(url, {
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

async function refreshGlobalOpencodeConfig(): Promise<{
  changed: boolean
  installedModelsByProvider: Record<string, Record<string, unknown>>
} | null> {
  const config = readOpencodeConfig()
  const before = stableStringify(config)
  const provider = isObject(config.provider) ? config.provider : {}
  let anyChanged = false
  const installedModelsByProvider: Record<string, Record<string, unknown>> = {}

  for (const providerConfig of CROFAI_PROVIDER_CONFIGS) {
    const models = await fetchModelsApi(providerConfig.baseURL)
    if (!models) {
      installedModelsByProvider[providerConfig.name] = {}
      continue
    }

    const existingProviderSection = isObject(provider[providerConfig.name]) ? provider[providerConfig.name] : {}
    const existingOptions = isObject(existingProviderSection.options) ? existingProviderSection.options : {}
    const existingModels = isObject(existingProviderSection.models) ? (existingProviderSection.models as Record<string, unknown>) : {}

    const mergedModels: Record<string, unknown> = {}
    for (const model of models) {
      const existingModel = isObject(existingModels[model.id]) ? (existingModels[model.id] as Record<string, unknown>) : {}
      const merged = mergeModelConfig(toModelConfig(model), existingModel)
      const existingName = existingModel?.name
      const formattedName = formatModelName(model.id)
      const oldPrefixedName = `${providerConfig.name}: ${model.id}`
      if (typeof existingName === "string" && (existingName === oldPrefixedName || existingName === model.id)) {
        (merged as Record<string, unknown>).name = formattedName
      }
      mergedModels[model.id] = merged
    }

    provider[providerConfig.name] = {
      ...existingProviderSection,
      name: providerConfig.name,
      npm: "@ai-sdk/openai-compatible",
      options: {
        ...existingOptions,
        ...(typeof existingOptions.apiKey === "string" ? {} : { apiKey: process.env[providerConfig.envVar] || `{env:${providerConfig.envVar}}` }),
        baseURL: providerConfig.baseURL,
      },
      models: mergedModels,
    }
    installedModelsByProvider[providerConfig.name] = mergedModels
    anyChanged = true
  }

  if (!anyChanged) return null

  const nextConfig = {
    ...config,
    $schema: typeof config.$schema === "string" ? config.$schema : OPENCODE_CONFIG_SCHEMA,
    provider,
  }

  fs.mkdirSync(path.dirname(OPENCODE_CONFIG_PATH), { recursive: true })
  const after = stableStringify(nextConfig)
  if (before === after) return { changed: false, installedModelsByProvider }
  fs.writeFileSync(OPENCODE_CONFIG_PATH, after)
  return { changed: true, installedModelsByProvider }
}

function liveProviderNeedsModelReload(api: TuiPluginApi, providerName: string, installedModels: Record<string, unknown>): boolean {
  const provider = api.state.provider.find((item) => item.name === providerName)
  if (!provider) return false
  const liveModels = isObject(provider.models) ? provider.models : {}

  for (const [modelID, installedModel] of Object.entries(installedModels)) {
    if (!isObject(installedModel)) continue
    const liveModel = liveModels[modelID]
    if (!isObject(liveModel)) continue

    const capabilities = isObject(liveModel.capabilities) ? liveModel.capabilities : {}
    if (installedModel.reasoning === true && capabilities.reasoning !== true) return true

    const installedModalities = isObject(installedModel.modalities) ? installedModel.modalities : undefined
    if (installedModalities) {
      const liveInput = isObject(capabilities.input) ? capabilities.input : {}
      if (liveInput.image !== true) return true
    }

    const installedVariants = isObject(installedModel.variants) ? installedModel.variants : undefined
    if (!installedVariants) continue

    const liveVariants = isObject(liveModel.variants) ? liveModel.variants : {}
    for (const [variantID, installedVariant] of Object.entries(installedVariants)) {
      if (isObject(installedVariant) && installedVariant.disabled === true) continue
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
  childTokens: SessionTokens | null,
  providerName: string = "CrofAI",
) {
  const t = api.theme.current

  const root = createElement("box")
  root.backgroundColor = t.backgroundPanel
  root.paddingTop = 0
  root.paddingBottom = 0
  root.paddingLeft = 0
  root.paddingRight = 0
  root.flexDirection = "column"
  root.gap = 0

  const title = createElement("text")
  title.fg = t.text
  title.attributes = TextAttributes.BOLD
  insert(title, createTextNode(providerName))
  insert(root, title)

  if (tokens && tokens.total > 0) {
    const tokenLine = createElement("text")
    tokenLine.fg = t.textMuted
    insert(tokenLine, createTextNode(formatNum(tokens.total) + " tokens"))
    insert(root, tokenLine)
  }
  if (childTokens && childTokens.total > 0) {
    const childLine = createElement("text")
    childLine.fg = t.textMuted
    insert(childLine, createTextNode(formatNum(childTokens.total) + " tokens (sub-agents)"))
    insert(root, childLine)
  }

  if (err) {
    const errText = createElement("text")
    errText.fg = t.error
    insert(errText, createTextNode("Failed to fetch usage"))
    insert(root, errText)
  } else if (!d) {
    const loadingText = createElement("text")
    loadingText.fg = t.textMuted
    insert(loadingText, createTextNode("Loading..."))
    insert(root, loadingText)
  } else {
    if (d.usable_requests !== null) {
      const reqLine = createElement("text")
      reqLine.fg = t.textMuted
      insert(reqLine, createTextNode(d.usable_requests + " requests remaining"))
      insert(root, reqLine)
    } else {
      const planText = createElement("text")
      planText.fg = t.textMuted
      insert(planText, createTextNode("Pay-per-token"))
      insert(root, planText)
    }
    if (tps !== null) {
      const tpsLine = createElement("text")
      tpsLine.fg = t.textMuted
      insert(tpsLine, createTextNode("~" + tps + " t/s"))
      insert(root, tpsLine)
    }
    const credFg = d.credits < 0 ? t.error : t.success
    const credLine = createElement("text")
    credLine.fg = credFg
    insert(credLine, createTextNode("$" + d.credits.toFixed(4) + " credits"))
    insert(root, credLine)
  }

  return root
}

const tui: TuiPlugin = async (api) => {
  const activeSessions = new Set<string>()
  const startedAt = Date.now()
  let pendingModelReload = false
  let modelReloadTimer: ReturnType<typeof setTimeout> | undefined
  let modelRefreshInFlight = false
  let disposed = false
  let backgroundReady = false
  let backgroundReadyTimer: ReturnType<typeof setTimeout> | undefined
  let autoUpdateTimer: ReturnType<typeof setTimeout> | undefined

  function hasActiveSession(): boolean {
    return activeSessions.size > 0
  }

  function scheduleAutoUpdate(delay: number = BACKGROUND_STARTUP_GRACE_MS): void {
    if (!ENABLE_AUTO_UPDATE || disposed) return
    if (autoUpdateTimer) clearTimeout(autoUpdateTimer)
    autoUpdateTimer = setTimeout(() => {
      autoUpdateTimer = undefined
      if (disposed) return
      if (hasActiveSession()) {
        scheduleAutoUpdate(10000)
        return
      }
      void autoUpdate()
    }, delay)
  }

  scheduleAutoUpdate()

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
      if (result) {
        let needsReload = result.changed
        for (const [providerName, installedModels] of Object.entries(result.installedModelsByProvider)) {
          if (liveProviderNeedsModelReload(api, providerName, installedModels)) {
            needsReload = true
          }
        }
        if (needsReload) {
          pendingModelReload = true
          scheduleModelReload()
        }
      }
    } finally {
      modelRefreshInFlight = false
    }
  }

  const modelRefreshInterval = ENABLE_MODEL_REFRESH
    ? setInterval(() => {
        if (!backgroundReady) return
        void refreshModels()
      }, MODEL_REFRESH_INTERVAL_MS)
    : undefined

  const sessionStatusUnsub = ENABLE_MODEL_REFRESH
    ? api.event.on("session.status", (event) => {
        if (event.properties.status.type === "idle") {
          activeSessions.delete(event.properties.sessionID)
        } else {
          activeSessions.add(event.properties.sessionID)
        }
        scheduleModelReload()
      })
    : () => {}

  const providers = getCrofaiProviders(api)
  const key = getCrofaiKey(api)
  if (providers.length === 0 || !key) {
    api.lifecycle.onDispose(() => {
      disposed = true
      clearInterval(modelRefreshInterval)
      clearModelReloadTimer()
      sessionStatusUnsub()
    })
    return
  }
  const crofaiProviderIDs = new Set(providers.map(p => p.id))

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
  const childTokenCooldown = new Map<string, number>()
  const CHILD_TOKEN_COOLDOWN_MS = SESSION_UPDATE_REFRESH_MIN_INTERVAL_MS
  const CHILD_TOKEN_COOLDOWN_MAX_SIZE = 50
  let lastSidebarTokenFetch = 0

  /**
   * Safely log a warning message, guarding against environments where
   * console may be closed or unavailable (sandboxed runtimes, test runners).
   * Falls back silently if logging is unavailable.
   * @param  {...any} args - Arguments to forward to console.warn
   */
  function safeWarn(...args: unknown[]): void {
    try {
      if (typeof console?.warn === 'function') {
        // Use console.warn.apply to forward all arguments as structured values
        console.warn(...args)
      }
    } catch {
      // Swallow logging failures — they must never propagate as rejections
    }
  }

  /**
   * Recursively refresh child tokens for the given session.
   * Errors are logged internally; this function never rejects.
   * @param {string} sessionID - The session ID to refresh tokens for.
   * @param {boolean} [force=false] - If true, bypass cooldown check.
   * @returns {Promise<void>} A promise that always resolves (never rejects).
   *   Callers should NOT add .catch() handlers — errors are self-contained.
   */
  async function refreshChildTokens(sessionID: string, force: boolean = false): Promise<void> {
    // Guard: Reject invalid session IDs early
    if (typeof sessionID !== 'string' || sessionID.length === 0) {
      safeWarn('[refreshChildTokens] invalid sessionID, skipping')
      return
    }

    if (!force) {
      // Cooldown check first — avoids TOCTOU race with in-flight completion
      const lastRefresh = childTokenCooldown.get(sessionID)
      if (lastRefresh && Date.now() - lastRefresh < CHILD_TOKEN_COOLDOWN_MS) return
      // In-flight check second
      if (childTokenRefreshInFlight.has(sessionID)) return
    }

    const seq = ++childTokenRefreshSeq
    childTokenRefreshInFlight.add(sessionID)
    if (!force) {
      childTokenCooldown.set(sessionID, Date.now())
      // Burst guard: evict oldest if map grows unexpectedly between pruning cycles
      if (childTokenCooldown.size > CHILD_TOKEN_COOLDOWN_MAX_SIZE * 2) {
        let oldestKey: string | null = null
        let oldestTs = Infinity
        for (const [k, v] of childTokenCooldown) {
          if (v < oldestTs) { oldestTs = v; oldestKey = k }
        }
        if (oldestKey !== null) childTokenCooldown.delete(oldestKey)
      }
    }

    try {
      const tokens = await collectChildTokens(api, sessionID)
      if (seq !== childTokenRefreshSeq || getCurrentSessionID() !== sessionID) return
      setChildTokens({ sessionID, tokens: tokens.total > 0 ? tokens : null })
    } catch (error) {
      // Don't block retries on transient failures
      if (!force) childTokenCooldown.delete(sessionID)
      // Log the error safely — never propagate as a rejection
      safeWarn('[refreshChildTokens] failed (session=' + sessionID + '):', error)
    } finally {
      // Defensive: use optional chaining in case the set was cleaned up
      // (e.g. in test environments or module teardown)
      childTokenRefreshInFlight?.delete(sessionID)
    }
  }

  let usageRefreshInFlight = false
  let usageRefreshQueued = false
  let lastPricingRefreshAt = 0

  const refresh = async () => {
    if (usageRefreshInFlight) {
      usageRefreshQueued = true
      return
    }
    usageRefreshInFlight = true
    try {
      const sid = getCurrentSessionID()
      const sessionProvider = sid ? getSessionCrofaiProvider(api, sid, providers) : providers[0]
      const now = Date.now()
      const shouldRefreshPricing =
        getPricingModels().length === 0 || now - lastPricingRefreshAt >= PRICING_REFRESH_INTERVAL_MS

      const usagePromise = fetchUsage(key, sessionProvider?.origin)
      const pricingPromise = shouldRefreshPricing ? fetchPricingModels() : Promise.resolve<PricingModel[] | null>(null)
      const [result, pricingModels] = await Promise.all([usagePromise, pricingPromise])
      if (result) {
        setData(result)
        setErr(false)
      } else {
        setErr(true)
      }
      if (pricingModels) {
        setPricingModels(pricingModels)
        lastPricingRefreshAt = now
      }
    } finally {
      usageRefreshInFlight = false
      if (usageRefreshQueued) {
        usageRefreshQueued = false
        void refresh()
      }
    }
  }

  if (ENABLE_USAGE_REFRESH) void refresh()
  const usageInterval = ENABLE_USAGE_REFRESH
    ? setInterval(() => {
        if (!backgroundReady) return
        void refresh()
        if (ENABLE_CHILD_TOKEN_REFRESH) {
          const sid = getCurrentSessionID()
          if (sid) // refreshChildTokens never rejects; errors are self-contained
 void refreshChildTokens(sid, false)
        }
        // Prune cooldown map: evict oldest entry if over limit
        if (childTokenCooldown.size > CHILD_TOKEN_COOLDOWN_MAX_SIZE) {
          let oldestKey: string | null = null
          let oldestTs = Infinity
          for (const [k, v] of childTokenCooldown) {
            if (v < oldestTs) { oldestTs = v; oldestKey = k }
          }
          if (oldestKey !== null) childTokenCooldown.delete(oldestKey)
        }
      }, 30000)
    : undefined

  let lastSessionUpdateRefreshAt = 0
  const onSessionUpdated = async () => {
    if (disposed) return
    const now = Date.now()
    // Only usage refresh is gated behind backgroundReady.
    // Child token refresh always runs (has its own cooldown via childTokenCooldown map).
    if (backgroundReady && now - lastSessionUpdateRefreshAt >= SESSION_UPDATE_REFRESH_MIN_INTERVAL_MS) {
      lastSessionUpdateRefreshAt = now
      if (ENABLE_USAGE_REFRESH) void refresh()
    }
    const sid = getCurrentSessionID()
    if (sid && ENABLE_CHILD_TOKEN_REFRESH) // refreshChildTokens never rejects; errors are self-contained
 void refreshChildTokens(sid, false)
  }

  const sessionUnsub =
    ENABLE_USAGE_REFRESH || ENABLE_CHILD_TOKEN_REFRESH ? api.event.on("session.updated.1", onSessionUpdated) : () => {}

  const sessionStatusRefreshUnsub =
    ENABLE_USAGE_REFRESH || ENABLE_CHILD_TOKEN_REFRESH
      ? api.event.on("session.status", (event) => {
          if (disposed) return
          if (event.properties.status?.type !== "idle") return
          const sid = getCurrentSessionID()
          if (!sid || sid !== event.properties.sessionID) return
          if (backgroundReady && ENABLE_USAGE_REFRESH) void refresh()
          if (ENABLE_CHILD_TOKEN_REFRESH) // refreshChildTokens never rejects; errors are self-contained
 void refreshChildTokens(sid, true)
        })
      : () => {}

  backgroundReadyTimer = setTimeout(() => {
    backgroundReadyTimer = undefined
    if (disposed) return
    backgroundReady = true
    lastSessionUpdateRefreshAt = Date.now() // reset so pre-grace events don't delay first post-grace usage refresh
    if (ENABLE_MODEL_REFRESH) void refreshModels()
    if (ENABLE_USAGE_REFRESH) void refresh()
    const sid = getCurrentSessionID()
    if (sid && ENABLE_CHILD_TOKEN_REFRESH) // refreshChildTokens never rejects; errors are self-contained
 void refreshChildTokens(sid, false)
  }, BACKGROUND_STARTUP_GRACE_MS)

  api.lifecycle.onDispose(() => {
    disposed = true
    if (modelRefreshInterval) clearInterval(modelRefreshInterval)
    clearModelReloadTimer()
    if (usageInterval) clearInterval(usageInterval)
    if (backgroundReadyTimer) clearTimeout(backgroundReadyTimer)
    if (autoUpdateTimer) clearTimeout(autoUpdateTimer)
    sessionStatusUnsub()
    sessionUnsub()
    sessionStatusRefreshUnsub()
    childTokenCooldown.clear()
  })

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        if (!isCrofaiSession(api, props.session_id, crofaiProviderIDs)) return null
        setCurrentSessionID(props.session_id)
        if (ENABLE_CHILD_TOKEN_REFRESH && props.session_id) {
          // Local retry debounce: prevent rapid-fire retries when the sidebar
          // re-renders repeatedly during a persistent network outage. Without
          // this, every re-render after a failure could fire a new call
          // before the in-flight set serialises.
          const now = Date.now()
          if (now - lastSidebarTokenFetch < CHILD_TOKEN_COOLDOWN_MS) {
            // skip — cooldown active
          } else {
            lastSidebarTokenFetch = now

            // Early-return: skip refresh when we already have fresh child tokens
            // for this session. The periodic 30s interval and session events
            // handle ongoing refreshes.
            if (getChildTokens()?.sessionID !== props.session_id) {
              // refreshChildTokens never rejects; errors are self-contained
              void refreshChildTokens(props.session_id)
            }
          }
        }
        const sessionProvider = getSessionCrofaiProvider(api, props.session_id, providers)
        const modelID = getSessionCrofaiModelID(api, props.session_id, crofaiProviderIDs)
        const tps = modelID ? (getPricingModels().find((model) => model.id === modelID)?.speed ?? null) : null
        const parentTokens = getSessionTokens(api, props.session_id)
        const childTokens = getChildTokens()
        return buildSidebar(
          api,
          getData(),
          getErr(),
          tps,
          parentTokens,
          childTokens?.sessionID === props.session_id ? childTokens.tokens : null,
          sessionProvider?.name ?? "CrofAI",
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "crofai-sidebar",
  tui,
}

export default plugin
