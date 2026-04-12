import { createElement, createTextNode, insert } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginModule, TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin/tui"

const CROFAI_URL = "https://crof.ai/usage_api/"
const PLUGIN_REPO = "https://github.com/Red44/crofai-opencode.git"
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000

interface UsageData {
  credits: number
  usable_requests: number | null
}

function getApiKey(): string | undefined {
  return process.env.CROFAI_API_KEY
}

async function fetchUsage(): Promise<UsageData | null> {
  const key = getApiKey()
  if (!key) return null
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

async function checkForUpdates(pluginDir: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "fetch", "origin", "main"], {
      cwd: pluginDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) return null

    const diffProc = Bun.spawn(["git", "diff", "--quiet", "HEAD", "origin/main"], {
      cwd: pluginDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const diffExit = await diffProc.exited
    // exit code 1 = differences exist, 0 = up to date
    if (diffExit === 1) {
      const pullProc = Bun.spawn(["git", "pull", "origin", "main"], {
        cwd: pluginDir,
        stdout: "pipe",
        stderr: "pipe",
      })
      await pullProc.exited
      return "updated"
    }
    return null
  } catch {
    return null
  }
}

function buildSidebar(
  api: TuiPluginApi,
  d: UsageData | null,
  err: boolean,
  noKey: boolean,
  updateStatus: string | null,
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

  if (noKey) {
    const warnText = createElement("text", { fg: t.warning })
    insert(warnText, createTextNode("Set CROFAI_API_KEY"))
    insert(root, warnText)
    const hintText = createElement("text", { fg: t.textMuted })
    insert(hintText, createTextNode("export CROFAI_API_KEY=..."))
    insert(root, hintText)
  } else if (err) {
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
  }

  if (updateStatus === "updated") {
    const updText = createElement("text", { fg: t.success })
    insert(updText, createTextNode("Plugin updated - restart to apply"))
    insert(root, updText)
  }

  return root
}

const tui: TuiPlugin = async (api) => {
  const [getData, setData] = createSignal<UsageData | null>(null)
  const [getErr, setErr] = createSignal(false)
  const [getUpdateStatus, setUpdateStatus] = createSignal<string | null>(null)

  const hasKey = !!getApiKey()

  const refresh = async () => {
    if (!hasKey) return
    const result = await fetchUsage()
    if (result) { setData(result); setErr(false) }
    else { setErr(true) }
  }

  await refresh()
  const interval = setInterval(refresh, 30000)

  // Auto-update check — async, never blocks startup
  const pluginDir = import.meta.dir
  if (pluginDir) {
    checkForUpdates(pluginDir).then((status) => {
      if (status) setUpdateStatus(status)
    })
    setInterval(() => {
      checkForUpdates(pluginDir).then((status) => {
        if (status) setUpdateStatus(status)
      })
    }, UPDATE_CHECK_INTERVAL)
  }

  api.lifecycle.onDispose(() => {
    clearInterval(interval)
  })

  const slot: TuiSlotPlugin = {
    order: 150,
    slots: {
      sidebar_content() {
        return buildSidebar(api, getData(), getErr(), !hasKey, getUpdateStatus())
      },
    },
  }
  api.slots.register(slot)
}

const plugin: TuiPluginModule & { id: string } = {
  id: "crofai-sidebar",
  tui,
}

export default plugin
