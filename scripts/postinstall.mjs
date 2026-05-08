import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isObject, formatModelName, mergeModelConfig, toModelConfig, fetchModelsApi } from "../src/shared.ts"

const home = os.homedir()
const configDir = path.join(home, ".config", "opencode")
const tuiConfigPath = path.join(configDir, "tui.json")
const opencodeConfigPath = path.join(configDir, "opencode.json")
const pluginPath = path.resolve(process.cwd(), "src", "index.ts")

const tuiSchema = "https://opencode.ai/tui.json"
const opencodeSchema = "https://opencode.ai/config.json"

const oldPluginPatterns = [
  /crofai-sidebar\.ts$/,
  /crofai-opencode[\\/]src[\\/]index\.ts$/,
]

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

async function updateProviderConfig(config, providerName, baseUrl, envVar) {
  const models = await fetchModelsApi(baseUrl)
  if (!models) {
    console.log(`Could not fetch models for ${providerName} from ${baseUrl}/models; skipping`)
    return
  }

  const existingProvider = isObject(config.provider[providerName]) ? config.provider[providerName] : {}
  const existingOptions = isObject(existingProvider.options) ? existingProvider.options : {}
  const existingModels = isObject(existingProvider.models) ? existingProvider.models : {}

  const apiKey = typeof existingOptions.apiKey === "string"
    ? existingOptions.apiKey
    : (process.env[envVar] || `{env:${envVar}}`)

  const providerModels = Object.fromEntries(models.map((model) => {
    const existingModel = isObject(existingModels[model.id]) ? existingModels[model.id] : {}
    const merged = mergeModelConfig(toModelConfig(model, providerName), existingModel)
    const existingName = existingModel?.name
    const formattedName = formatModelName(model.id)
    if (typeof existingName === "string" && (existingName === `${providerName}: ${model.id}` || existingName === model.id)) {
      merged.name = formattedName
    }
    return [model.id, merged]
  }))

  config.provider[providerName] = {
    ...existingProvider,
    name: providerName,
    npm: "@ai-sdk/openai-compatible",
    options: {
      ...existingOptions,
      apiKey,
      baseURL: baseUrl,
    },
    models: providerModels,
  }
}

async function updateOpencodeConfig() {
  const config = normalizeOpencodeConfig(readJson(opencodeConfigPath, { $schema: opencodeSchema, provider: {} }))

  await updateProviderConfig(config, "CrofAI", "https://crof.ai/v1", "CROFAI_API_KEY")
  await updateProviderConfig(config, "CrofAI-Beta", "https://beta.crof.ai/v1", "CROFAI_API_KEY")
  await updateProviderConfig(config, "CrofAI-Test", "https://test.crof.ai/v1", "TEST_CROFAI_API_KEY")

  writeJson(opencodeConfigPath, config)
  return config
}

async function main() {
  fs.mkdirSync(configDir, { recursive: true })
  updateTuiConfig()
  const config = await updateOpencodeConfig()

  const crofaiModels = isObject(config.provider.CrofAI) && isObject(config.provider.CrofAI.models)
    ? Object.keys(config.provider.CrofAI.models).length
    : 0
  const betaModels = isObject(config.provider["CrofAI-Beta"]) && isObject(config.provider["CrofAI-Beta"].models)
    ? Object.keys(config.provider["CrofAI-Beta"].models).length
    : 0
  const testModels = isObject(config.provider["CrofAI-Test"]) && isObject(config.provider["CrofAI-Test"].models)
    ? Object.keys(config.provider["CrofAI-Test"].models).length
    : 0

  console.log(`Registered CrofAI plugin in ${tuiConfigPath}`)
  console.log(`Configured CrofAI provider (${crofaiModels} models), CrofAI-Beta provider (${betaModels} models), and CrofAI-Test provider (${testModels} models) in ${opencodeConfigPath}`)

  const crofaiKey = isObject(config.provider.CrofAI) && isObject(config.provider.CrofAI.options)
    ? config.provider.CrofAI.options.apiKey
    : undefined
  if (typeof crofaiKey === "string" && crofaiKey.startsWith("{env:")) {
    console.log(`${crofaiKey.slice(1, -1)} not found; wrote placeholder to opencode.json`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
