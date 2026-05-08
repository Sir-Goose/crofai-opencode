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
const deepseekThinkingEfforts = ["high", "max"]
const deepseekDisabledThinkingEfforts = ["low", "medium", "xhigh"]

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

function modelSupportsReasoning(model) {
  return model.custom_reasoning === true || model.reasoning === true
}

function modelUsesDeepSeekThinking(model) {
  return modelSupportsReasoning(model) && model.id.toLowerCase().includes("deepseek-v4")
}

function modelSupportsVision(model) {
  const id = model.id.toLowerCase()
  return id.startsWith("kimi-") || id.startsWith("gemma-") || id.startsWith("qwen")
}

function toReasoningVariants(model) {
  if (!modelUsesDeepSeekThinking(model)) return undefined

  const variants = Object.fromEntries(
    deepseekThinkingEfforts.map((effort) => [effort, {
      reasoningEffort: effort,
      thinking: { type: "enabled" },
    }]),
  )
  for (const effort of deepseekDisabledThinkingEfforts) {
    variants[effort] = { disabled: true }
  }
  return variants
}

function mergeVariantConfig(generated, existing) {
  if (!isObject(generated)) return existing ?? generated
  if (!isObject(existing)) return generated

  const merged = { ...generated, ...existing }
  for (const [key, generatedVariant] of Object.entries(generated)) {
    const existingVariant = existing[key]
    if (isObject(generatedVariant) && isObject(existingVariant)) {
      merged[key] = { ...generatedVariant, ...existingVariant }
    }
  }
  return merged
}

function mergeModelConfig(generated, existing) {
  const merged = { ...generated, ...existing }
  if ("variants" in generated) {
    merged.variants = mergeVariantConfig(generated.variants, existing.variants)
  }
  return merged
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

async function fetchModels(url = modelsURL) {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch models from ${url}: ${res.status}`)
  }

  const data = await res.json()
  if (!Array.isArray(data.data)) {
    throw new Error(`Unexpected /v1/models response from ${url}`)
  }

  return data.data
}

function toModelConfig(model, prefix = "CrofAI") {
  const context = Number(model.context_length)
  const output = Number(model.max_completion_tokens)
  const reasoning = modelSupportsReasoning(model)
  const variants = toReasoningVariants(model)
  const deepseekThinking = modelUsesDeepSeekThinking(model)
  const vision = modelSupportsVision(model)

  return {
    name: model.id,
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

async function updateProviderConfig(config, providerName, modelsUrl, baseUrl, envVar) {
  let models
  try {
    models = await fetchModels(modelsUrl)
  } catch {
    console.log(`Could not fetch models for ${providerName} from ${modelsUrl}; skipping`)
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
    if (typeof existingName === "string" && existingName === `${providerName}: ${model.id}`) {
      merged.name = model.id
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

  await updateProviderConfig(config, "CrofAI", "https://crof.ai/v1/models", "https://crof.ai/v1", "CROFAI_API_KEY")
  await updateProviderConfig(config, "CrofAI-Beta", "https://beta.crof.ai/v1/models", "https://beta.crof.ai/v1", "CROFAI_API_KEY")
  await updateProviderConfig(config, "CrofAI-Test", "https://test.crof.ai/v1/models", "https://test.crof.ai/v1", "TEST_CROFAI_API_KEY")

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
