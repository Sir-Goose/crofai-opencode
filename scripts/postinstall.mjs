import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = os.homedir()
const configDir = path.join(home, ".config", "opencode")
const tuiConfigPath = path.join(configDir, "tui.json")
const opencodeConfigPath = path.join(configDir, "opencode.json")
const pluginPath = path.resolve(process.cwd(), "src", "index.ts")

const tuiSchema = "https://opencode.ai/tui.json"
const opencodeSchema = "https://opencode.ai/config.json"
const modelsURL = "https://crof.ai/v1/models"

const oldPluginPatterns = [
  /crofai-sidebar\.ts$/,
  /crofai-opencode[\\/]src[\\/]index\.ts$/,
]

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return fallback
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n")
}

function normalizeTuiConfig(raw) {
  if (!isObject(raw)) return { $schema: tuiSchema, plugin: [] }
  const plugin = Array.isArray(raw.plugin) ? raw.plugin.filter((item) => typeof item === "string") : []
  return {
    ...raw,
    $schema: typeof raw.$schema === "string" ? raw.$schema : tuiSchema,
    plugin,
  }
}

function normalizeOpencodeConfig(raw) {
  if (!isObject(raw)) return { $schema: opencodeSchema, provider: {} }
  const provider = isObject(raw.provider) ? raw.provider : {}
  return {
    ...raw,
    $schema: typeof raw.$schema === "string" ? raw.$schema : opencodeSchema,
    provider,
  }
}

function shouldReplacePlugin(entry) {
  return oldPluginPatterns.some((pattern) => pattern.test(entry))
}

function updateTuiConfig() {
  const config = normalizeTuiConfig(readJson(tuiConfigPath, { $schema: tuiSchema, plugin: [] }))
  const nextPlugins = []
  let inserted = false

  for (const entry of config.plugin) {
    if (entry === pluginPath) {
      nextPlugins.push(entry)
      inserted = true
      continue
    }

    if (shouldReplacePlugin(entry)) {
      if (!inserted) {
        nextPlugins.push(pluginPath)
        inserted = true
      }
      continue
    }

    nextPlugins.push(entry)
  }

  if (!inserted) nextPlugins.push(pluginPath)

  writeJson(tuiConfigPath, {
    ...config,
    $schema: tuiSchema,
    plugin: nextPlugins,
  })
}

async function fetchModels() {
  const res = await fetch(modelsURL)
  if (!res.ok) {
    throw new Error(`Failed to fetch CrofAI models: ${res.status}`)
  }

  const data = await res.json()
  if (!Array.isArray(data.data)) {
    throw new Error("Unexpected CrofAI /v1/models response")
  }

  return data.data
}

function toModelConfig(model) {
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

async function updateOpencodeConfig() {
  const config = normalizeOpencodeConfig(readJson(opencodeConfigPath, { $schema: opencodeSchema, provider: {} }))
  const models = await fetchModels()
  const existingProvider = isObject(config.provider.CrofAI) ? config.provider.CrofAI : {}
  const existingOptions = isObject(existingProvider.options) ? existingProvider.options : {}

  const apiKey = typeof existingOptions.apiKey === "string"
    ? existingOptions.apiKey
    : (process.env.CROFAI_API_KEY || "{env:CROFAI_API_KEY}")

  const providerModels = Object.fromEntries(models.map((model) => [model.id, toModelConfig(model)]))

  config.provider.CrofAI = {
    ...existingProvider,
    name: "CrofAI",
    npm: "@ai-sdk/openai-compatible",
    options: {
      ...existingOptions,
      apiKey,
      baseURL: "https://crof.ai/v1",
    },
    models: providerModels,
  }

  writeJson(opencodeConfigPath, config)

  return { modelCount: models.length, usedEnvFallback: apiKey === "{env:CROFAI_API_KEY}" }
}

async function main() {
  fs.mkdirSync(configDir, { recursive: true })
  updateTuiConfig()
  const result = await updateOpencodeConfig()

  console.log(`Registered CrofAI plugin in ${tuiConfigPath}`)
  console.log(`Configured CrofAI provider in ${opencodeConfigPath} with ${result.modelCount} models`)
  if (result.usedEnvFallback) {
    console.log("CROFAI_API_KEY not found; wrote {env:CROFAI_API_KEY} placeholder to opencode.json")
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
