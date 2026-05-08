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

const CROFAI_URL = "https://crof.ai/usage_api/"
const PRICING_URL = "https://crof.ai/pricing"
const MODELS_URL = "https://crof.ai/v1/models"
const MODEL_REFRESH_INTERVAL_MS = 30 * 60 * 1000
const MODEL_RELOAD_IDLE_MS = 1500
const MODEL_RELOAD_STARTUP_GRACE_MS = 3000
const CROFAI_FETCH_PATCH_KEY = Symbol.for("crofai.opencode.fetchPatch")

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
type FetchPatchState = {
  originalFetch: typeof fetch
  refs: number
}

const OPENCODE_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json")
const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json"
const DEEPSEEK_THINKING_EFFORTS = ["high", "max"] as const
const DEEPSEEK_DISABLED_THINKING_EFFORTS = ["low", "medium", "xhigh"] as const

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

async function fetchModelsApi(baseURL?: string): Promise<ModelsApiModel[] | null> {
  const url = baseURL ? `${baseURL}/models` : MODELS_URL
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data.data)) return null
    return data.data as ModelsApiModel[]
  } catch {
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

function modelSupportsVision(model: ModelsApiModel): boolean {
  const id = model.id.toLowerCase()
  return id.startsWith("kimi-") || id.startsWith("gemma-") || id.startsWith("qwen")
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

const ACRONYMS = new Set(["glm", "it"])
const BRAND_NAMES: Record<string, string> = {
  deepseek: "DeepSeek",
  minimax: "MiniMax",
}

function capitalizeWord(word: string): string {
  const lower = word.toLowerCase()
  if (ACRONYMS.has(lower)) return lower.toUpperCase()
  if (lower in BRAND_NAMES) return BRAND_NAMES[lower]
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function formatModelName(id: string): string {
  const parts = id.split("-")
  const result: string[] = []

  for (const part of parts) {
    if (/^\d+(\.\d+)?$/.test(part)) {
      result.push(part)
      continue
    }

    const tntMatch = part.match(/^([a-zA-Z]+)(\d[\d.]*)([a-zA-Z]+)$/)
    if (tntMatch) {
      result.push(`${capitalizeWord(tntMatch[1])}${tntMatch[2]}${tntMatch[3].toUpperCase()}`)
      continue
    }

    const tnMatch = part.match(/^([a-zA-Z]+)(\d[\d.]*)$/)
    if (tnMatch && tnMatch[1].length > 1) {
      result.push(`${capitalizeWord(tnMatch[1])} ${tnMatch[2]}`)
      continue
    }

    const ntMatch = part.match(/^(\d[\d.]*)([a-zA-Z]+)$/)
    if (ntMatch) {
      result.push(`${ntMatch[1]}${ntMatch[2].toUpperCase()}`)
      continue
    }

    result.push(capitalizeWord(part))
  }

  return result.join(" ")
}

function toInstalledModelConfig(model: ModelsApiModel, providerPrefix: string = "CrofAI"): ModelConfig {
  const context = Number(model.context_length)
  const output = Number(model.max_completion_tokens)
  const reasoning = modelSupportsReasoning(model)
  const variants = toReasoningVariants(model)
  const deepseekThinking = modelUsesDeepSeekThinking(model)
  const vision = modelSupportsVision(model)

  return {
    name: formatModelName(model.id),
    temperature: true,
    ...(reasoning ? { reasoning: true } : {}),
    ...(deepseekThinking ? { interleaved: { field: "reasoning_content" } } : {}),
    ...(vision ? { modalities: { input: ["text", "image"], output: ["text"] } } : {}),
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
      const merged = mergeModelConfig(toInstalledModelConfig(model, providerConfig.name), existingModel)
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

function getFetchUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  if (typeof Request !== "undefined" && input instanceof Request) return input.url
  if (isObject(input) && typeof input.url === "string") return input.url
  return undefined
}

function isCrofaiChatCompletionUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return CROFAI_ORIGINS.some(origin => url.origin === origin) && url.pathname === "/v1/chat/completions"
  } catch {
    return CROFAI_ORIGINS.some(origin => value.startsWith(`${origin}/v1/chat/completions`))
  }
}

function createCrofaiReasoningTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const needle = "\"reasoning_content\""
  const replacement = "\"reasoning_text\""
  const carryLength = needle.length - 1
  let carry = ""

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = carry + decoder.decode(chunk, { stream: true })
      const emitLength = Math.max(0, text.length - carryLength)
      const emit = text.slice(0, emitLength).replaceAll(needle, replacement)
      carry = text.slice(emitLength)
      if (emit) controller.enqueue(encoder.encode(emit))
    },
    flush(controller) {
      const tail = (carry + decoder.decode()).replaceAll(needle, replacement)
      if (tail) controller.enqueue(encoder.encode(tail))
    },
  })
}

function installCrofaiReasoningStreamPatch(): () => void {
  const globalWithPatch = globalThis as typeof globalThis & { [CROFAI_FETCH_PATCH_KEY]?: FetchPatchState }
  let state = globalWithPatch[CROFAI_FETCH_PATCH_KEY]

  if (!state) {
    state = {
      originalFetch: globalThis.fetch.bind(globalThis),
      refs: 0,
    }

    const patchedFetch: typeof fetch = async (input, init) => {
      const response = await state.originalFetch(input, init)
      const contentType = response.headers.get("content-type") ?? ""
      if (
        !response.body ||
        !isCrofaiChatCompletionUrl(getFetchUrl(input)) ||
        !contentType.toLowerCase().includes("text/event-stream")
      ) {
        return response
      }

      return new Response(response.body.pipeThrough(createCrofaiReasoningTransform()), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

    globalWithPatch[CROFAI_FETCH_PATCH_KEY] = state
    globalThis.fetch = patchedFetch
  }

  state.refs += 1
  return () => {
    const current = globalWithPatch[CROFAI_FETCH_PATCH_KEY]
    if (!current) return
    current.refs -= 1
    if (current.refs > 0) return
    globalThis.fetch = current.originalFetch
    delete globalWithPatch[CROFAI_FETCH_PATCH_KEY]
  }
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
    insert(childLine, createTextNode(formatNum(childTokens.total) + " tokens (sub)"))
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
  void autoUpdate()
  const uninstallReasoningStreamPatch = installCrofaiReasoningStreamPatch()

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

  const providers = getCrofaiProviders(api)
  const key = getCrofaiKey(api)
  if (providers.length === 0 || !key) {
    api.lifecycle.onDispose(() => {
      disposed = true
      uninstallReasoningStreamPatch()
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
      const sid = getCurrentSessionID()
      const sessionProvider = sid ? getSessionCrofaiProvider(api, sid, providers) : undefined
      const [result, pricingModels] = await Promise.all([fetchUsage(key, sessionProvider?.origin), fetchPricingModels()])
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
    uninstallReasoningStreamPatch()
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
        if (!isCrofaiSession(api, props.session_id, crofaiProviderIDs)) return null
        setCurrentSessionID(props.session_id)
        refreshChildTokens(props.session_id)
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
