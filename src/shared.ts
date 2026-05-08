export interface ModelsApiModel {
  id: string
  context_length: number | string
  max_completion_tokens: number | string
  custom_reasoning?: boolean
  reasoning?: boolean
  speed?: number
}

export type ModelConfig = Record<string, unknown>

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

const DEEPSEEK_THINKING_EFFORTS = ["high", "max"] as const
const DEEPSEEK_DISABLED_THINKING_EFFORTS = ["low", "medium", "xhigh"] as const

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

export function formatModelName(id: string): string {
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

export function mergeModelConfig(generated: ModelConfig, existing: ModelConfig): ModelConfig {
  const merged = { ...generated, ...existing }
  if ("variants" in generated) {
    merged.variants = mergeVariantConfig(generated.variants, existing.variants)
  }
  return merged
}

export function toModelConfig(model: ModelsApiModel): ModelConfig {
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

export async function fetchModelsApi(baseURL?: string): Promise<ModelsApiModel[] | null> {
  const url = baseURL ? `${baseURL}/models` : "https://crof.ai/v1/models"
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
