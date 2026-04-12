import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = os.homedir()
const configDir = path.join(home, ".config", "opencode")
const configPath = path.join(configDir, "tui.json")
const pluginPath = path.resolve(process.cwd(), "src", "index.ts")

const schema = "https://opencode.ai/tui.json"
const oldPatterns = [
  /crofai-sidebar\.ts$/,
  /crofai-opencode[\\/]src[\\/]index\.ts$/,
]

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function normalizeConfig(raw) {
  if (!isObject(raw)) return { $schema: schema, plugin: [] }
  const plugin = Array.isArray(raw.plugin) ? raw.plugin.filter((item) => typeof item === "string") : []
  return {
    $schema: typeof raw.$schema === "string" ? raw.$schema : schema,
    ...raw,
    plugin,
  }
}

function shouldReplace(entry) {
  return oldPatterns.some((pattern) => pattern.test(entry))
}

fs.mkdirSync(configDir, { recursive: true })

let config = { $schema: schema, plugin: [] }
if (fs.existsSync(configPath)) {
  try {
    config = normalizeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")))
  } catch {
    config = { $schema: schema, plugin: [] }
  }
}

const nextPlugins = []
let inserted = false

for (const entry of config.plugin) {
  if (entry === pluginPath) {
    nextPlugins.push(entry)
    inserted = true
    continue
  }

  if (shouldReplace(entry)) {
    if (!inserted) {
      nextPlugins.push(pluginPath)
      inserted = true
    }
    continue
  }

  nextPlugins.push(entry)
}

if (!inserted) nextPlugins.push(pluginPath)

const nextConfig = {
  ...config,
  $schema: schema,
  plugin: nextPlugins,
}

fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2) + "\n")
console.log(`Registered CrofAI plugin in ${configPath}`)
