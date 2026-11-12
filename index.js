/**
 * qqbot-suite — 一个 bundle 里的 QQ 机器人插件集合。
 *
 * 这个入口是「套件本体」：持有运行期设置、给子插件提供 `qqbotSuite` 服务，
 * 并在 Harness 设置里注册 `settings.section`。子插件分别是：
 *   - ./gate   群聊唤醒/语义过滤（补 QQBot.emit）
 *   - ./guard  工作区工具防护
 *   - ./self   qqbot_bot_profile 工具
 *
 * 设置存放：`<DSH_HOME>/qqbot-suite/profiles/<profile>/settings.json`（首次启动写一份默认配置），
 * patch 里的 config 只作为首次启动的默认值。设置页保存后子插件通过 subscribe 立即换规则。
 *
 * 注意：`client.js` 是宿主在启动时扫描一次的客户端 bundle（client-modules 按
 * 包名缓存扫描结果）。改了 client.js 只刷新页面不会生效，必须重启 dsh web，
 * 否则设置页可能整个消失——宿主图里没有这个包，浏览器就注册不了 settings.section。
 */
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  DEFAULT_CONFIG,
  PROMPT_CATALOG,
  applyPromptOverrides,
  LOG_MAX_BYTES,
  cleanModelRef,
  debugLogPathOf,
  findOutOfRange,
  historyLogPathOf,
  idleRecentPathOf,
  imageIndexPathOf,
  loadConfig,
  logsDirOf,
  managedWorkspaces,
  mediaDirOf,
  missesPathOf,
  normalizeConfig,
  patchPathOf,
  profileDirOf,
  semanticLogPathOf,
  settingsPathOf,
  writeBotWorkspace,
  writeFileAtomic,
  writeConfig,
} from './config.js'
import { historyRowId, readHistoryTail, readJsonlTail } from './history.js'
// 可改写的提示词原文：与设置页共用同一份常量，页面显示的就是这里用的那句。
import { PROMPT_GROUPS, PROMPT_TEXT as T } from './prompts.js'
// 历史图片索引：prune 之后按磁盘现状对账（上游 media-cleaner 按 ttlHours 独立删，没有钩子，
// 只有这一处能兜住幽灵行）。写入在 gate.js，那边只管追加。
import { mediaFileNames, readIndex, reconcileIndex } from './images-recall.js'
// 图片只由 image.mode 决定（见 config.js: IMAGE_MODES）：placeholder 摘图留占位符，
// agent 原样交给官方链路（下载 + `Image: <路径>`）由模型自己读。
import { imageNoteOf, withImageNote } from './images.js'
import {
  addMiss,
  countLabels,
  LABEL_REPLY,
  loadMisses,
  normalizeLabel,
  removeMiss,
  saveMisses,
} from './misses.js'
import { readSemanticLog, semanticRowId } from './semlog.js'
// 宿主 llm 的取用与封装（语义判断、冷场补话都要造官方的 user 消息），
// 单独一个文件是因为 gate.js 也要用，不能各写一份。
import { newAssembler, setHostLlm, userMessageOf } from './host.js'
// 冷场那一轮的「先看图」例外段（标记由 gate.js 的 fireIdle 打，这里只负责拼进系统提示词）。
import { coldStartAssembly } from './idle.js'
// 群聊放行清单的唯一算法在 guard.js：设置页要显示「实际生效的清单」，
// 不能在前端或这里再拼一遍（否则改了一边就会对不上）。
import { groupAllowedTools } from './guard.js'
// 「机器人名字」自动获取复用 self.js 的取资料函数：同一条凭据链路、同一份缓存。
// 门槛用 isSelfActive()（self 子插件是否启用，插件页面控制），不再读配置开关。
import { getBotProfile, isSelfActive } from './self.js'

export const name = 'qqbot-suite'

const STATE_PATH = '/api/qqbot-suite/state'
const CONFIG_PATH = '/api/qqbot-suite/config'
const MODELS_PATH = '/api/qqbot-suite/models'
const REPLAY_PATH = '/api/qqbot-suite/semantic/replay'
const MARK_PATH = '/api/qqbot-suite/semantic/mark'
// 设置页「机器人名字 → 自动获取」：bot_profile 开着才允许读凭据调 /users/@me。
const BOT_NAME_PATH = '/api/qqbot-suite/bot-name'
// 设置页「群健康」：借机器实例自己的 client 发只读请求，不碰 AppSecret。
const HEALTH_PATH = '/api/qqbot-suite/health'
/** 群健康手动刷新的最小间隔（两个接口都是 30 QPM，一分钟一次留足余量）。 */
const HEALTH_MIN_INTERVAL_MS = 60_000
/** 最多查几个群：历史里最近出现过的前 N 个。 */
const HEALTH_GROUP_LIMIT = 5

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function safeGet(ctx, service) {
  try {
    return ctx.get(service)
  } catch {
    return undefined
  }
}

function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 追加一行 JSONL；文件已经到 `maxBytes`（默认 1MB）就先轮转再写：
 * 当前文件改名成 `<file>.1`（覆盖上一份），新日志从空文件开始。
 * 先判断再写，保证「刚写的那条」一定落在当前文件里；用改名而不是截断，
 * 避免把某一行 JSON 从中间劈开。
 */
function appendJsonl(file, entry, maxBytes = LOG_MAX_BYTES) {
  mkdirSync(dirname(file), { recursive: true })
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    size = 0
  }
  if (size >= maxBytes) {
    try {
      rmSync(`${file}.1`, { force: true })
    } catch {
      // 删不掉旧备份就继续，最多多占一份
    }
    try {
      renameSync(file, `${file}.1`)
    } catch {
      // 改名失败（文件被占用等）就继续往当前文件追加，下次再试
    }
  }
  appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8')
}

// ── 媒体缓存数量上限 ────────────────────────────────────────────────
// 官方 dsh-qqbot 在中间件里把图片/视频/文件下载到 ~/.dsh-qqbot/media，
// 只按 media.ttlHours 过期，不收数量上限。这里补一个兜底清理：
// 保留最新的 maxFiles 个文件（不含本插件自己的头像），更旧的删掉。

/** 清理间隔：1 分钟。一次 readdir + stat 的开销远小于一条群消息的处理。 */
const MEDIA_PRUNE_INTERVAL_MS = 60 * 1000
/** 保护期：刚下载的文件 5 分钟内不删，避免 agent / qqbot_send_file 正在用时被清掉。 */
const MEDIA_PRUNE_GRACE_MS = 5 * 60 * 1000
/**
 * 本插件曾经写进 media 目录的文件前缀（头像）。
 * 现在已经不往那里写了（avatar 只返回 URL），保留这条是为了让历史缓存里的旧头像
 * 不被数量清理顺手删掉——等 prune 本身取消时一起删。
 */
const MEDIA_PINNED_PREFIX = 'qqbot-self-avatar.'
/** 媒体引用的最长保留时间：agent 一直不 idle（或事件丢了）也不能永远钉着。 */
const MEDIA_REF_TTL_MS = 30 * 60 * 1000
/** 单个 agent 最多记多少条引用，防止长会话把集合撑大。 */
const MEDIA_REF_LIMIT = 40

// ── 媒体引用追踪 ──────────────────────────────────────────────────────
//
// 官方按 TTL（默认 24h）清、套件按数量兜底；数量策略最怕删掉「agent 正在看的图」。
// 入站正文里本来就有 `- Image: <路径>` 这样的行（官方 buildDynamicCtx 生成），
// 从里面把 media 目录下的文件名记下来，agent 回到 idle 再放开删除。
// 这样「按数量」只在真正没人用的时候生效，不必为了安全把上限调得很大。

/** agent id → { at, names:Set<string> } */
const mediaRefs = new Map()

/**
 * 从 agent 正文里抠出引用到的媒体文件名（只认 media 目录下的）。
 * 认不出就返回空集合，不影响调用方。
 */
export function mediaRefsFromBody(text, dir) {
  const names = new Set()
  if (typeof text !== 'string' || text === '') return names
  const root = String(dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  if (root === '') return names
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*-\s*(?:Image|Video|File):\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    const full = match[1].replace(/\\/g, '/')
    if (!full.toLowerCase().startsWith(`${root}/`)) continue
    const base = full.slice(full.lastIndexOf('/') + 1)
    if (base !== '') names.add(base)
  }
  return names
}

/** 记下某个 agent 这轮引用到的媒体（同 agent 多轮累积，超上限丢最旧的）。 */
export function rememberMediaRefs(agentId, names, now = Date.now()) {
  if (typeof agentId !== 'string' || agentId === '' || !(names instanceof Set) || names.size === 0) return 0
  const previous = mediaRefs.get(agentId)
  const merged = new Set(previous?.names ?? [])
  for (const name of names) {
    merged.delete(name) // 重新插入，让它排到末尾（丢最旧的才是对的）
    merged.add(name)
  }
  while (merged.size > MEDIA_REF_LIMIT) {
    const oldest = merged.values().next().value
    if (oldest === undefined) break
    merged.delete(oldest)
  }
  mediaRefs.set(agentId, { at: now, names: merged })
  return merged.size
}

/** agent 这一轮跑完了：放开它的媒体引用。 */
export function releaseMediaRefs(agentId) {
  if (typeof agentId !== 'string' || agentId === '') return
  mediaRefs.delete(agentId)
}

/** 当前仍被引用的文件名集合（顺带清掉过期条目）。 */
export function pinnedMediaNames(now = Date.now()) {
  const pinned = new Set()
  for (const [agentId, entry] of mediaRefs) {
    if (now - entry.at > MEDIA_REF_TTL_MS) {
      mediaRefs.delete(agentId)
      continue
    }
    for (const name of entry.names) pinned.add(name)
  }
  return pinned
}

/** 清空引用表（测试用）。 */
export function resetMediaRefs() {
  mediaRefs.clear()
}

/** 从 agent 消息里取纯文本（只看文本块，和闸门/守卫同一套口径）。 */
function textOfMessage(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : ''
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 订阅入站 / 状态事件，维护「哪个 agent 正在用哪些媒体文件」。
 * 这两个事件是 agent 作用域的，根作用域监听要带 global。
 */
function watchMediaRefs(ctx, suite) {
  const dir = suite.paths?.mediaDir ?? ''
  try {
    ctx.on('agent/inbox/inserted', (payload) => {
      try {
        rememberMediaRefs(payload?.agent?.id, mediaRefsFromBody(textOfMessage(payload?.message), dir))
      } catch {
        // 记不上就退回「只按数量和宽限期」的旧行为
      }
    }, { global: true })
    ctx.on('agent/status', (payload) => {
      try {
        if (payload?.status === 'idle') releaseMediaRefs(payload?.agent?.id)
      } catch {
        // 同上
      }
    }, { global: true })
  } catch (error) {
    ctx.logger?.warn?.(`[qqbot-suite] media refs unavailable, prune falls back to count only: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 冷场那一轮追加「先看图」例外段。
 *
 * 官方 `im-qqbot` 就是在同一个 waterfall 里注入群提示词的
 * （`session-manager.js: registerScopePromptInjection()`，`order: 90`），
 * 这里挂 `order: 91` 紧跟其后：**只追加、不改用户写的原文**，也不会影响普通回复
 * ——`fireIdle` 没打标记时原样返回。
 *
 * 判据是 `context.agent`（官方也是这么认会话的），不看 scope：
 * 注册在根 ctx 才能收到所有 agent 的 assemble。
 */
function watchColdStartPrompt(ctx, suite) {
  try {
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = await next()
      try {
        // 例外段本身也在设置页可改（「冷场 · 这一轮先看图」），这里把覆盖函数递进去。
        const merged = coldStartAssembly(assembled, context?.agent, Date.now(),
          typeof suite?.copy === 'function' ? (text) => suite.copy(text) : null)
        if (merged !== assembled) suite.logDebug?.({ reason: 'cold-start-prompt', allow: true })
        return merged
      } catch {
        // 拼不上就退回原样：宁可这一轮按旧行为走，也别把系统提示词弄坏
        return assembled
      }
    })
  } catch (error) {
    ctx.logger?.warn?.(`[qqbot-suite] cold-start prompt unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 按数量清理媒体缓存：保留 mtime 最新的 `maxFiles` 个，其余删除。
 *
 * - `maxFiles < 1` 直接跳过：配置层已保证 ≥1（没有「0 = 不限」），这里只防御非法入参，
 *   不能改成「0 = 全删」。
 * - 只处理目录下的普通文件；子目录、符号链接不动。
 * - `graceMs` 内的新文件跳过，宁可暂时超过上限，也不删正在用的图。
 * - 任何单个文件的 stat/删除失败都不影响其它文件。
 *
 * @returns {{ scanned: number, removed: number, kept: number, skipped: number }}
 */
export function pruneMediaDir(dir, maxFiles, options = {}) {
  const limit = Number(maxFiles)
  if (!Number.isFinite(limit) || limit <= 0) return { scanned: 0, removed: 0, kept: 0, skipped: 0 }

  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { scanned: 0, removed: 0, kept: 0, skipped: 0 }
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : MEDIA_PRUNE_GRACE_MS
  // 被 agent 正在引用的文件不参与「按数量保留」的排序，也不计入上限：
  // 它们在磁盘上多待一会儿没关系，被删掉才会出事。
  const pinned = options.pinned instanceof Set ? options.pinned : new Set()
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(MEDIA_PINNED_PREFIX) || pinned.has(entry.name)) continue
    try {
      files.push({ name: entry.name, mtimeMs: statSync(join(dir, entry.name)).mtimeMs })
    } catch {
      // 并发删除 / 文件被占用：跳过这一个
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const kept = Math.min(files.length, Math.floor(limit))
  let removed = 0
  let skipped = 0
  for (let i = kept; i < files.length; i += 1) {
    if (now - files[i].mtimeMs < graceMs) {
      skipped += 1
      continue
    }
    try {
      rmSync(join(dir, files[i].name), { force: true })
      removed += 1
    } catch {
      skipped += 1
    }
  }
  return { scanned: files.length, removed, kept, skipped }
}

/** 统计媒体缓存现状（设置页展示用）；统计口径和清理一致。 */
export function mediaSummary(dir, maxFiles, options = {}) {
  const pinned = options.pinned instanceof Set ? options.pinned : new Set()
  const empty = { dir, files: 0, bytes: 0, maxFiles, pinned: 0 }
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return empty
  }
  let files = 0
  let bytes = 0
  let pinnedCount = 0
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(MEDIA_PINNED_PREFIX)) continue
    if (pinned.has(entry.name)) {
      pinnedCount += 1
      continue
    }
    files += 1
    try {
      bytes += statSync(join(dir, entry.name)).size
    } catch {
      // 文件刚被删：不影响计数以外的逻辑
    }
  }
  return { dir, files, bytes, maxFiles, pinned: pinnedCount }
}

/** 当前默认模型路由；没有就返回 undefined。 */
function defaultSelection(ctx) {
  const service = safeGet(ctx, 'agentDefaultModel')
  if (service === undefined || typeof service.currentSelection !== 'function') return undefined
  try {
    const selection = service.currentSelection()
    if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return undefined
    if (selection.provider === '' || selection.model === '') return undefined
    return selection
  } catch {
    return undefined
  }
}

/**
 * 把 `semantic.model`（`provider/model`）拆成 harness 的调用路由。
 * 校验交给 `config.js:cleanModelRef()`，两边规则一致，别在这里另写一套。
 */
export function parseModelRef(value) {
  const text = cleanModelRef(value)
  if (text === '') return undefined
  const slash = text.indexOf('/')
  const provider = text.slice(0, slash)
  const model = text.slice(slash + 1)
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/**
 * 这次判断到底用哪个模型：设置页手动指定的优先，没指定才跟随默认模型。
 * 「指定了」的判定跟写配置时同一套规则——半截的 `deepseek-flash` 会被 cleanModelRef
 * 丢掉，于是自动回落到默认模型，而不是让每条群消息都撞 NO_ADAPTER。
 */
function judgeSelection(ctx, config) {
  return parseModelRef(config?.semantic?.model) ?? defaultSelection(ctx)
}

/** 列模型时给每个 provider 的等待上限：pi-ai 这类要探端点的，慢起来会卡住设置页。 */
const MODEL_LIST_TIMEOUT_MS = 6000

/** 给一个 promise 套超时；成功/失败都会把定时器清掉，不留下悬着的 timer。 */
function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 按 Harness 自己的做法（`dsh-api-session-controller:buildModelCatalog()`）列一遍
 * 当前可用的 provider/model：`llm.listProviders()` + 每个 provider 的 `listModels()`。
 *
 * 这里只读目录，不做 `resolveModelInfo`（那是为了拿思考档位，设置页不需要）。
 * 单个 provider 抛错不影响别的——账号没登录、Key 没配时 `listModels` 会返回空
 * 或直接报错，那种情况下页面就退回「手动填写 provider/model」。
 */
async function listModelCatalog(ctx) {
  const llm = safeGet(ctx, 'llm')
  if (llm === undefined || typeof llm.listProviders !== 'function') {
    return { models: [], failures: [], error: 'LLM 服务不可用' }
  }
  let providers
  try {
    providers = llm.listProviders()
  } catch (error) {
    return {
      models: [],
      failures: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const models = []
  const failures = []
  for (const provider of Array.isArray(providers) ? providers : []) {
    const id = typeof provider?.id === 'string' ? provider.id : ''
    if (id === '') continue
    try {
      const list = await withTimeout(llm.listModels(id), MODEL_LIST_TIMEOUT_MS, '列出模型超时')
      for (const model of Array.isArray(list) ? list : []) {
        if (typeof model?.id !== 'string' || model.id === '') continue
        models.push({
          provider: id,
          // `provider/model`：直接就是配置里存的那串，页面不用再拼。
          value: `${id}/${model.id}`,
          id: model.id,
          name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
          providerName: typeof provider?.name === 'string' && provider.name !== '' ? provider.name : id,
        })
      }
    } catch (error) {
      failures.push({ provider: id, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { models, failures }
}

function latestBotTexts(recent) {
  if (!Array.isArray(recent)) return []
  return recent.slice(-6).map((item) => (typeof item === 'string' ? item : item?.text)).filter(Boolean)
}

/** 模型不支持所选思考档位时的兜底预算：留出思考空间，正文还能挤出来。 */
const EFFORT_FALLBACK_MAX_TOKENS = 1024
/** 正文被 max-tokens 截断后重试的预算下限 / 上限。 */
const RETRY_MIN_MAX_TOKENS = 1024
const RETRY_MAX_TOKENS_CAP = 4096

// ── 语义调试（重放）────────────────────────────────────────────────
// 定位：正常判定仍然 `reasoningEffort: 'off'`，热路径不为思考付延迟；
// 想看模型的思考过程时，用设置页的「重放」把一次真实判断原样再发一次
// （最近一次走内存环，聊天记录里的任意一条走 `replayTarget(id)`）。
// 重放只写内存里的结果、不落日志、不计入 semanticCalls/Failures。

/** 内存里保留的最近判断条数：设置页要能翻着标「这条该回」，5 条不够用。 */
const RECENT_JUDGE_LIMIT = 30
/**
 * 内存里保留的最近冷场触发条数。
 *
 * 冷场是**独立触发源**，不经过语义判定（见 dev/AGENTS.md §6.14），所以它不能混进
 * `recentJudges`——那份列表是「这条该不该回」的样本，掺进来就把 YES/NO 统计搞脏了。
 * 这里单独一列，只在冷场设置里显示成「冷场主动发言」。
 */
const RECENT_IDLE_LIMIT = 20
/**
 * 冷场记录落盘文件的大小上限：超过就裁掉旧行，只留最近 `RECENT_IDLE_LIMIT` 条。
 * 触发频率受冷却 + 日限额压着（默认一小时最多一次），64KB 足够攒几个月才裁一次。
 */
const IDLE_RECENT_TRIM_BYTES = 64 * 1024
/** 连续失败多少次算「判定链路已降级」（设置页据此亮红灯）。 */
const JUDGE_DEGRADE_THRESHOLD = 3
// ── 漏判标记 ───────────────────────────────────────────────────────
// 列表数据源是**聊天记录落盘文件**（`<logs>/qqbot-group-history.jsonl`），
// 不是内存里的判断环：文件里有全量群消息、重启还在；内存环只负责重放（最近一次）。
// 内存里的判断记录只用来「加料」——能给这条消息配上当时的 system/prompt 和判定结果。

/** 设置页最多列多少行。记录本身在文件/日志里，翻得比这更早也还在，只是不一次全塞给页面。 */
const MISS_ROW_LIMIT = 80
/** 从聊天记录文件里最多回读多少条（含机器人发言），给「重建上下文」用。 */
const MISS_HISTORY_SCAN = 400
/** 从语义日志里最多回读多少条判定（补聊天记录落盘之前的那段）。 */
const MISS_LOG_SCAN = 400
/** 把内存里的判断和聊天记录里的消息认成同一条的时间容差。 */
const MISS_MATCH_MS = 5 * 60 * 1000

/**
 * 在内存的判断记录里找「就是这一条消息」的那次判断。
 * 先按正文 + 时间窗认，正文对上后再挑发送者也对得上的那条（同一句话可能好几个人说）。
 */
export function findJudgeFor(entry, judges) {
  if (entry === null || typeof entry !== 'object') return undefined
  const list = Array.isArray(judges) ? judges : []
  const sender = entry.name || entry.senderId || ''
  const hits = list.filter((judge) => (
    judge !== null
    && typeof judge === 'object'
    && judge.text === entry.text
    && Math.abs((judge.at ?? 0) - (entry.at ?? 0)) <= MISS_MATCH_MS
  ))
  if (hits.length === 0) return undefined
  return hits.find((judge) => judge.sender === sender) ?? hits[hits.length - 1]
}
/** 重放默认思考档位：能看出判断依据，又不像 max 那样慢。 */
const REPLAY_DEFAULT_EFFORT = 'high'
/**
 * 页面可选的思考档位。
 *
 * `off` 必须在里面：判定热路径用的就是 off，而有些模型（mimo、GLM 一类）的
 * off 只是「不发送 reasoning 参数」，服务端照样思考。只有能用同一个档位重放，
 * 才验证得了「线上到底有没有在思考」；把 off 挡在外面等于把要查的现象藏起来。
 */
const REPLAY_EFFORTS = ['off', 'low', 'high', 'max']
/** 重放的输出预算（思考 + 正文），比正常判定的 256 宽松得多。 */
const REPLAY_MAX_TOKENS = 4096
const REPLAY_MAX_TOKENS_CAP = 8192
/** 重放超时下限：思考本身就慢，不能沿用判定那个 8 秒。 */
const REPLAY_MIN_TIMEOUT_MS = 30000
/** 返回给页面的思考文本上限，防止模型话痨把响应撑爆。 */
const REPLAY_REASONING_LIMIT = 20000
/**
 * 判断记录里保留的结构化上下文条数。存得比默认 `maxHistory`（12）多一点，
 * 这样把窗口调大以后，重放还能按新窗口重拼，而不是只剩当时那几条。
 */
const JUDGE_CTX_HISTORY_LIMIT = 30

/** 解析模型正文：YES/是/对 → yes，NO/不/否 → no，其余 unknown。 */
function parseVerdict(text) {
  const value = String(text ?? '').trim().toLowerCase()
  if (/^(yes|y|是|对|yes\.)/.test(value)) return 'yes'
  if (/^(no|n|不|否|no\.)/.test(value)) return 'no'
  return 'unknown'
}

// ── 宿主 LLM 流式协议：交给官方 BlockAssembler ────────────────────────
//
// `call.stream()` 产出的是官方 `StreamChunk`（block-start / text-delta /
// reasoning-delta / tool-call-delta / block-end / usage / finish），官方 agent
// loop 就是用 `@deepseek-ai/dsh-llm` 的 `BlockAssembler` 把它拼成 ContentBlock 的。
// 这里直接用同一套实现，不再对每个 chunk 猜形状——以前认 4 种正文 + 3 种思考 +
// 2 种结束形状，其中六支是死分支（chunk 本来就来自官方流，形态有保证），
// 而且 `tool-call-delta` / `usage` 被直接丢掉。
//
// 取模块（`newAssembler` / `userMessageOf` / `setHostLlm`）在 ./host.js：
// gate.js 的冷场补话也要造官方的 user 消息，两边共用同一份锚点解析。

/** 把 assembler 当前状态写进 out。
 * 未闭合的未知块会让 `blocks()` 抛错，这时退回 `interruptedBlocks()`（官方给
 * 中断流用的安全前缀），至少把已经流出来的正文/思考留住。
 * @param assembler - 已经喂过 chunk 的 `BlockAssembler`。
 * @param out - `{ text, reasoning, finish, usage }` 结果载体。
 */
function fillCollected(assembler, out) {
  let blocks
  try {
    blocks = assembler.blocks()
  } catch {
    blocks = assembler.interruptedBlocks()
  }
  const textOf = (type) => blocks
    .filter((block) => block?.type === type && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  out.text = textOf('text')
  out.reasoning = textOf('reasoning')
  out.finish = assembler.finish
  out.usage = assembler.usage
}

/**
 * 收一条流：正文 / 思考 / finish / 用量。
 * @param stream - `call.stream()` 的异步迭代器。
 * @param out - 结果载体；流中途出错也会填上已收到的部分，日志才看得出说到哪。
 */
async function collectStream(stream, out) {
  const assembler = newAssembler()
  try {
    for await (const chunk of stream) assembler.push(chunk)
  } finally {
    fillCollected(assembler, out)
  }
}

/**
 * 从「最近判断」列表里挑一条可重放的记录。
 * 列表按时间升序（新的在末尾），`index: 0` = 最新一条。
 * 只认真的产出了正文、且不是 error 的记录——失败的请求重放没有比较价值。
 */
export function pickJudge(list, index = 0) {
  if (!Array.isArray(list) || list.length === 0) return undefined
  const usable = list.filter((item) => (
    item !== null
    && typeof item === 'object'
    && item.ok === true
    && item.verdict !== 'error'
    && typeof item.system === 'string'
    && typeof item.prompt === 'string'
    && item.prompt !== ''
  ))
  const at = Number.isFinite(index) ? Math.trunc(index) : 0
  if (at < 0 || at >= usable.length) return undefined
  return usable[usable.length - 1 - at]
}

/** 判断错误是不是「这个模型不支持这个思考档位」（Harness 的 UNSUPPORTED_REASONING_EFFORT）。 */
function isUnsupportedEffort(error) {
  if (error === null || error === undefined) return false
  const code = typeof error.code === 'string' ? error.code : ''
  if (code === 'UNSUPPORTED_REASONING_EFFORT') return true
  const text = error instanceof Error ? error.message : String(error)
  return /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort/i.test(text)
}

/**
 * 语义判断的 system。抽出来给「从聊天记录重建样本」复用——
 * 两处各写一份必然会漂移，而重建出来的样本只有跟当时同一份提示词才有比较价值。
 *
 * 思考语言只能靠提示词约束：Harness 的 `LlmCallConfig` 里没有语言开关，各家协议也没有
 * 对应参数（`reasoningEffort` 只控制开关和强度）。2026-11-04 排查到的现象是「写了要中文，
 * 实际仍整段英文」，两个原因叠在一起：
 *   1. 语言要求夹在一堆判定规则中间，权重太低；
 *   2. 结尾「只输出 YES/NO」是英文，模型顺手把整段推理也切回英文。
 * 现在的结构：身份 → 【思考语言：硬要求】（并给出中文三步思考的骨架，用具体的中文句式
 * 抢占推理 token）→ 判定规则 → 时间间隔 → 输出格式（最后再提一次中文）。
 * `strictLanguage` 是语言兜底重试用的加强版（见 `reasoningLanguage()`），只有检测到
 * 推理是英文时才会用一次，不要拿它当默认。
 *
 * 提示词只管「这句是不是在跟它说」，不管回复风格。图片那句话是**按模式分档**的
 * （2026-11-09 用户要求「先走 A」）：`image.mode = 'agent'` 时图片真的会到 agent 手上、
 * 它能自己 read_image，所以判词不能再说「你看不到内容」——旧文案会让图片消息几乎必判 NO，
 * agent 连跑都跑不到，图当然一次都没读。另外两种模式下图片确实看不到，照旧要求别因为带图就 YES。
 */
export function buildJudgeSystem(suite, config, options = {}) {
  const wakeWords = Array.isArray(config?.wakeWords) ? config.wakeWords : []
  const names = wakeWords.length > 0 ? wakeWords.join('、') : '（未配置额外唤醒词）'
  // 名字来自设置页手填（不自动读取，见 README「注意事项」）；没填就不写这一行。
  const botName = typeof config?.botName === 'string' ? config.botName.trim() : ''
  const staleMinutes = staleMinutesOf(config)
  const strict = options !== null && typeof options === 'object' && options.strictLanguage === true
  const system = [
    T['judge.role'],
    ...(botName !== '' ? [`机器人自己在群里的名字：${botName}。`] : []),
    `人类给它的称呼/唤醒词：${names}。`,
    '',
    '【思考语言：硬要求】',
    '你的推理（thinking）必须全程使用简体中文——即使群里说的是英文、即使最终答案要写 YES/NO。',
    '不要用英文打草稿，也不要先用英文想再翻译过来；消息里出现英文单词、链接、代码也照样用中文推理。',
    '按这三步用中文想（这三步只写在思考里，不要写进最终回答）：第一，最后一条是谁在跟谁说话；第二，有没有在叫它、问它、接它的话；第三，结论是 YES 还是 NO。',
    ...strict
      ? ['注意：上一次的推理用了英文，违反了上面的要求。这一次推理必须整段是简体中文，一个英文句子都不要写。']
      : [],
    '',
    '【判断对象】',
    T['judge.objective'],
    '',
    '【怎么判】',
    T['judge.yes.named'],
    T['judge.yes.short'],
    T['judge.yes.waiting'],
    T['judge.rules'],
    `- 只有这条看不出跟机器人有任何关联时才判 NO。${staleMinutes} 分钟内它刚说过话、这条像是在接它，就别因为“不确定是不是在叫它”一律压成 NO——那是过去最常见的漏判（间隔很远的按下一条处理）。`,
    '',
    '【时间间隔】',
    T['judge.time.legend'],
    `- 间隔不超过 ${staleMinutes} 分钟：算同一段对话，「紧跟着它说话的短反应」那条规则照常生效；`,
    `- 间隔超过 ${staleMinutes} 分钟：视为换了一个话题，之前“紧跟它说话”的信号作废。只有这条明确点名、明确回应它（或明确接着它刚才的话题）才判 YES，否则判 NO。`,
    '',
    '【材料说明】',
    T['judge.material.inject'],
    T['judge.material.bot'],
    ...(judgeSeesImages(config)
      ? [
        T['judge.image.visible'],
      ]
      : [T['judge.image.hidden']]),
    '',
    '只输出一个词：YES 或 NO。不要解释，不要标点，不要输出其他内容。（结论写英文的 YES/NO，推理仍然只用中文）',
  ].join('\n')
  // 覆盖只换 PROMPT_CATALOG 登记过的句子；判词结构、YES/NO 输出与中文推理硬要求不动。
  return typeof suite?.copy === 'function' ? suite.copy(system) : system
}

/** 判定用的「换话题间隔」：配置值，单位分钟；坏值退回 30。 */
function staleMinutesOf(config) {
  const raw = Number(config?.semantic?.staleMinutes)
  return Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : 30
}

/**
 * 判词该不该按「图片能读」来说。
 *
 * 只有 `image.mode = 'agent'` 为真：另外两种模式下图片在链前就被摘掉，agent 手里确实
 * 只有一个占位符，说「你能看到」会诱导它编内容。这里只读运行期配置，不判断模型能力——
 * `read_image` 自己会按模型路由拒绝，跟判词无关。
 */
function judgeSeesImages(config) {
  return config?.image?.mode === 'agent'
}

/**
 * 「机器人这句话是不是已经在群聊记录里了」的比对键。
 *
 * 不能拿原文直接比：`gate.js: recordBotText()` 存进 `target.recent` 的是 `norm()` 过的文本
 * （小写、去 markdown、压空白），群聊记录里却是原文；历史条目渲染时还会再过一遍 `flat()`。
 * 一旦有大小写、换行或标点差异就对不上，同一句机器人发言在 prompt 里出现两遍，等于把
 * 「我刚说过话」的信号翻倍（2026-11-04 报障：图片消息被当成「紧跟机器人的短反应」判 YES）。
 * 只用于比对，不拿去喂模型。
 */
function judgeKey(value) {
  return String(value ?? '')
    .replace(/[*_`~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 200)
}

/**
 * 聊条记录里一条的发送时间（毫秒）。三种形状都认：
 * 套件自己的环（`at`）、SDK 的 history 条目（`timestamp`）、落盘回读（`at`）。
 * 认不出返回 0 —— 调用方据此决定「要不要写时间」，绝不编一个当前时间冒充。
 */
function entryAtOf(entry) {
  if (entry === null || typeof entry !== 'object') return 0
  for (const raw of [entry.at, entry.timestamp, entry.time]) {
    if (Number.isFinite(raw) && raw > 0) return raw
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Date.parse(raw)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return 0
}

/** 提示词里的时间戳：`11-04 14:05`。跨天也能分清，不像 HH:MM 那样歧义。 */
function stampOf(at) {
  if (!Number.isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 间隔的人话：「4 小时 53 分」「3 天 2 小时」。 */
export function gapText(ms) {
  const total = Math.max(0, Math.round(Number.isFinite(ms) ? ms / 60000 : 0))
  if (total < 1) return '不到 1 分钟'
  if (total < 60) return `${total} 分钟`
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours < 24) return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分`
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest === 0 ? `${days} 天` : `${days} 天 ${rest} 小时`
}

/**
 * 语义判断的 user 正文（群聊上下文 + 当前消息），按字数从尾部裁剪。
 * `history` 两种形状都认：SDK 的 `{ senderName, content, timestamp }` 和聊天记录文件回读的
 * `{ name, text, at }`，重建样本时走的是后者。
 *
 * **每条记录都带发送时间**（2026-11-04 加）：不带时间时，三个小时前的一句「它刚说完话」
 * 和刚刚说完的一句在提示词里长得一模一样，`semantic` 就会把隔了很久的新话题当成接话，
 * 表现为「很久以前问过一句，现在群里随便说点什么它都回」。间隔超过
 * `semantic.staleMinutes` 时额外标一句，判定规则里也按这个阈值分档（见 `buildJudgeSystem`）。
 */
export function buildJudgePrompt(input = {}) {
  const history = Array.isArray(input.history) ? input.history : []
  const botTexts = Array.isArray(input.botTexts) ? input.botTexts : []
  const maxHistory = Number.isFinite(input.maxHistory) ? Math.max(1, Math.floor(input.maxHistory)) : 12
  const maxChars = Number.isFinite(input.maxChars) ? Math.max(200, Math.floor(input.maxChars)) : 6000
  const sender = truncate(input.sender ?? '某人', 32)
  const currentText = truncate(input.text ?? '', 1200)
  const quote = truncate(input.quote ?? '', 500)
  const staleMs = Math.max(1, staleMinutesOf({ semantic: { staleMinutes: input.staleMinutes } })) * 60000

  /** 一行记录：`[11-04 14:05 | 距上一条 4 小时 53 分] [谁] 内容`。 */
  const lineOf = (who, what, at, gapMs) => {
    const stamp = stampOf(at)
    if (stamp === '') return `[${who}] ${what}`
    const mark = gapMs > 0 && gapMs >= staleMs
      ? ` | 距上一条 ${gapText(gapMs)}（超过 ${Math.round(staleMs / 60000)} 分钟，算新话题）`
      : ''
    return `[${stamp}${mark}] [${who}] ${what}`
  }

  const lines = []
  const picked = history.length > 0 ? history.slice(-maxHistory) : []
  let lastAt = 0
  if (picked.length > 0) {
    lines.push('【群聊最近消息（旧 → 新；方括号里是发送时间）】')
    for (const entry of picked) {
      const base = truncate(entry?.senderName ?? entry?.name ?? entry?.senderId ?? '某人', 32)
      // 机器人自己的发言要标出来：判定「这句是不是在接它的话」时，哪句是它说的区别很大。
      // 群历史环里机器人的 senderId 固定是 'bot'（见 history.js: botEntry）。
      const who = entry?.bot === true || entry?.senderId === 'bot' ? `${base} (bot)` : base
      const what = truncate(entry?.content ?? entry?.text ?? '', 300)
      const at = entryAtOf(entry)
      if (what !== '') lines.push(lineOf(who, what, at, at > 0 && lastAt > 0 ? at - lastAt : 0))
      if (at > 0) lastAt = at
    }
    lines.push('')
  } else {
    // 没有群聊记录时明说一句：不然下面「机器人说过的话」容易被当成整段上下文，
    // 事后翻样本也看不出「这次上下文是残的」。
    lines.push('【群聊最近消息（旧 → 新）】')
    lines.push('（这次没拿到群聊记录）')
    lines.push('')
  }
  // 机器人自己的发言本来就在群聊记录里（用它的名字当发信人），再单列一遍等于同一句话
  // 出现两次：白占 token，还会强化「我刚说过话」的错觉，让它接着自己的话往下说。
  // 所以按原文去重：只补群聊记录里没有的那些（重建样本时机器人发言是被单独拆出来的，
  // 那种情况仍然要补，否则上下文会比当时残一块）。
  const shownInHistory = new Set(picked.map((entry) => judgeKey(entry?.content ?? entry?.text ?? '')))
  const extraBotTexts = botTexts
    .slice(-6)
    .filter((text) => !shownInHistory.has(judgeKey(text)))
  if (extraBotTexts.length > 0) {
    // 这几句没有时间（来源是 `recentTexts()` 的纯文本），说明一句，免得被当成「刚刚说的」。
    lines.push('【机器人最近在群里说过】（时间见上面的群聊记录，这里不重复）')
    for (const text of extraBotTexts) lines.push(`[机器人] ${truncate(text, 300)}`)
    lines.push('')
  }
  if (quote !== '') {
    lines.push('【当前消息引用的内容】')
    lines.push(quote)
    lines.push('')
  }
  lines.push('【当前消息】')
  const currentAt = entryAtOf({ at: input.at })
  lines.push(lineOf(
    sender,
    currentText === '' ? '（空消息 / 只有附件）' : currentText,
    currentAt,
    currentAt > 0 && lastAt > 0 ? currentAt - lastAt : 0,
  ))

  const context = lines.join('\n')
  // 超长从**头部**裁：越靠后的越是判断依据（最近几句 + 当前这句）。
  return context.length > maxChars ? context.slice(context.length - maxChars) : context
}

/**
 * 推理文本的语言：`chinese` / `english` / `unknown`。
 *
 * 提示词只能「请」模型用中文，实际不听话时没有硬开关可拨（见 `buildJudgeSystem` 的注释）。
 * 所以这里做一个只看得到、改不了模型的最小兜底：检测出英文推理时，用加强版 system
 * 重试一次。用「中日韩字符占比」判断，不看单词表——中文推理里夹英文变量名、链接是常态，
 * 按占比判才不会误伤。
 *
 * 太短、字母级字符不到 8 个的一律 `unknown`（`嗯`、`YES` 这种没法算比例）；中文推理里
 * 夹英文变量名、链接是常态，所以先看「拉丁字母够不够多」，再算比例。
 */
export function reasoningLanguage(value) {
  const text = typeof value === 'string' ? value : ''
  if (text.trim() === '') return 'unknown'
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length
  const latin = (text.match(/[A-Za-z]/g) ?? []).length
  if (cjk + latin < 8) return 'unknown'
  if (latin < 8) return 'chinese'
  return cjk / (cjk + latin) >= 0.15 ? 'chinese' : 'english'
}

/**
 * 「这条消息按**现在**的提示词会怎么判」——重放和样本重建的统一入口。
 *
 * 为什么不能直接用记录里的 system/prompt 重发：日志里存的是**渲染后的文本**，
 * 改一次 `buildJudgeSystem()` / `buildJudgePrompt()`，旧记录就永远停在改动之前，
 * 重放看着像没生效（2026-11-01 的报障）。所以：
 * - system 永远按当前模板现拼（它只依赖唤醒词和机器人名，没有逐条数据可丢）；
 * - prompt 优先用记录里的结构化 `ctx` 按当前模板重拼（quote / 机器人发言都在）；
 * - 老日志没有 `ctx`，只能原文照发，返回值里标 `promptSource: 'recorded'`，
 *   页面据此说明「这条的上下文是旧版渲染结果」。
 *
 * 判断模型/路由不在这里改：重放仍优先用「当时那次」的 provider/model。
 */
export function renderJudgeInput(suite, config, record) {
  const system = buildJudgeSystem(suite, config)
  const ctx = record?.ctx
  const recorded = typeof record?.prompt === 'string' ? record.prompt : ''
  if (ctx === null || typeof ctx !== 'object') {
    return { system, prompt: recorded, promptSource: 'recorded' }
  }
  const history = Array.isArray(ctx.history) ? ctx.history : []
  return {
    system,
    prompt: buildJudgePrompt({
      history: history.map((item) => ({ name: item?.from ?? '', text: item?.text ?? '', at: item?.at })),
      botTexts: Array.isArray(ctx.botTexts) ? ctx.botTexts : [],
      quote: typeof ctx.quote === 'string' ? ctx.quote : '',
      sender: typeof ctx.sender === 'string' ? ctx.sender : record?.sender,
      text: typeof ctx.text === 'string' ? ctx.text : record?.text,
      // 老记录没有 `at`：这时不写时间，别拿当前时间冒充当时的时间。
      at: Number.isFinite(ctx.at) ? ctx.at : undefined,
      maxHistory: config?.semantic?.maxHistory,
      maxChars: config?.semantic?.maxChars,
      staleMinutes: config?.semantic?.staleMinutes,
    }),
    promptSource: 'current',
  }
}

/**
 * 让模型结合群聊上下文判断「这句是不是在跟机器人说话」。
 * 只在 semantic 模式、且 @/引用/唤醒词都没命中时调用。
 */
async function judgeWithModel(ctx, suite, messageCtx) {
  const config = suite.current()
  const semantic = config.semantic
  const llm = safeGet(ctx, 'llm')
  if (llm === undefined || typeof llm.prepareCall !== 'function') {
    throw new Error('LLM 服务不可用')
  }
  const selection = judgeSelection(ctx, config)
  if (selection === undefined) {
    throw new Error('没有可用的判断模型；请先在 设置 → 模型 里选择默认模型，或在语义判断里手动指定 provider/model')
  }

  const message = messageCtx?.message ?? {}
  const history = Array.isArray(messageCtx?.state?.history) ? messageCtx.state.history : []
  const quote = typeof messageCtx?.state?.quote?.text === 'string' ? messageCtx.state.quote.text : ''
  const botTexts = latestBotTexts(suite.recentTexts(message.groupOpenid ?? ''))
  const sender = typeof message.senderName === 'string' && message.senderName !== ''
    ? message.senderName
    : truncate(message.senderId ?? '某人', 32)
  const currentText = truncate(withImageNote(message.content ?? '', imageNoteOf(message)), 1200)
  // 当前消息自己的时间：判定提示词要拿它和上一条比间隔。消息没带时间就按现在算
  // （这是唯一合理的兜底，否则新消息跟几小时前的记录之间就没有间隔可言）。
  const currentAt = entryAtOf({ at: message.timestamp }) || Date.now()

  // 存**结构化**上下文而不是只存渲染好的文本：重放时要能按当前模板重拼
  // （见 `renderJudgeInput()`）。字段名沿用日志里那一份，别混。
  const judgeCtx = {
    // `at` 是每条消息的发送时间：没有它，重放和真实判定都没法区分「刚说完」和「几小时前」。
    history: history.slice(-JUDGE_CTX_HISTORY_LIMIT).map((item) => ({
      from: truncate(item?.senderName ?? item?.name ?? item?.senderId ?? '某人', 32),
      text: truncate(item?.content ?? item?.text ?? '', 300),
      at: entryAtOf(item),
    })),
    botTexts: botTexts.slice(-6).map((text) => truncate(text, 300)),
    quote: truncate(quote, 500),
    sender,
    text: currentText,
    at: currentAt,
  }

  const clipped = buildJudgePrompt({
    history: judgeCtx.history.map((item) => ({ name: item.from, text: item.text, at: item.at })),
    botTexts: judgeCtx.botTexts,
    quote: judgeCtx.quote,
    sender,
    text: currentText,
    at: currentAt,
    maxHistory: semantic.maxHistory,
    maxChars: semantic.maxChars,
    staleMinutes: semantic.staleMinutes,
  })
  let system = buildJudgeSystem(suite, config)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('semantic judge timeout')), semantic.timeoutMs)
  const onAbort = () => controller.abort(messageCtx?.signal?.reason)
  if (messageCtx?.signal !== undefined) {
    if (messageCtx.signal.aborted) controller.abort(messageCtx.signal.reason)
    else messageCtx.signal.addEventListener('abort', onAbort, { once: true })
  }

  // 语义判断日志的固定字段：一次判断对应一条记录，成功和失败都写。
  const startedAt = Date.now()
  let answer = ''
  let reasoning = ''
  let finish
  // 实际用到的思考档位 / 预算：可能因为模型不支持或正文被截断而变过，落盘方便复盘。
  const effort = semantic.reasoningEffort === 'auto' ? undefined : semantic.reasoningEffort
  let effortUsed = effort
  let maxTokensUsed = semantic.maxTokens
  let retried = ''
  const logBase = {
    group: truncate(message.groupOpenid ?? '', 32),
    sender,
    text: truncate(currentText, 300),
    model: `${selection.provider}/${selection.model}`,
    historyShown: history.length > 0 ? Math.min(history.length, Math.max(1, semantic.maxHistory)) : 0,
    // 结构化上下文跟 prompt 一起存：prompt 是「当时怎么渲染的」，ctx 是原料。
    // 只有原料能用后来的模板重拼，光有渲染结果改完提示词就再也对不上了。
    ctx: judgeCtx,
  }

  /**
   * 留一份请求给设置页「重放」用：不看 `debug`，也不落盘。
   * 存 system/prompt（当时的原文）+ ctx（重放按当前模板重拼用），最多 30 条。
   */
  const note = (verdict, ok, extra = {}) => {
    try {
      suite.noteJudge?.({
        id: randomUUID().slice(0, 12),
        at: startedAt,
        group: logBase.group,
        sender,
        text: logBase.text,
        provider: selection.provider,
        model: selection.model,
        system,
        prompt: clipped,
        ctx: judgeCtx,
        answer,
        verdict,
        ok,
        ms: Date.now() - startedAt,
        ...extra,
      })
    } catch {
      // 记录失败不影响判定
    }
  }

  /** 一次调用的结果诊断字段：档位、预算、截断原因、思考长度、思考语言。 */
  const diagnostics = () => ({
    effort: effortUsed ?? 'default',
    maxTokens: maxTokensUsed,
    ...finish?.kind === undefined ? {} : { finish: finish.kind },
    ...retried === '' ? {} : { retried },
    reasoningChars: reasoning.length,
    // 思考语言：`english` 说明这次没按提示词用中文（已经重试过一次就还会带
    // `retried: 'reasoning-language'`）。排查「强调中文却还是英文」先看这个字段。
    ...reasoningLanguage(reasoning) === 'unknown' ? {} : { reasoningLang: reasoningLanguage(reasoning) },
    ...semantic.discardThinking === false && reasoning !== ''
      ? { reasoning: truncate(reasoning, 400) }
      : {},
  })

  /** 把这次重试原因并进 `retried`（可能已经有 `max-tokens` 之类）。 */
  const addRetried = (reason) => {
    retried = retried === '' ? reason : `${retried}+${reason}`
  }

  /**
   * 跑一次模型调用，把正文/推理/finish 写进外层变量。
   * 模型报错（含超时中止）直接抛，交给外层记 ok:false。
   */
  const runOnce = async (callConfig) => {
    answer = ''
    reasoning = ''
    finish = undefined
    const call = await llm.prepareCall(callConfig, controller.signal)
    if (call === null || typeof call !== 'object' || typeof call.stream !== 'function') {
      throw new Error(
        '宿主 LLM 调用缺少 stream()，无法做语义判断；'
          + '这通常意味着宿主 API 形态变了（参考官方 dsh-qqbot 的 host/adapter.js）',
      )
    }
    const messages = [userMessageOf(clipped)]
    const out = { text: '', reasoning: '', finish: undefined }
    try {
      await collectStream(
        call.stream({ ...call.config, system, messages, signal: controller.signal }),
        out,
      )
    } finally {
      // 中途抛错也要把已经收到的部分留在外层变量里，失败日志才解释得清。
      answer = out.text
      reasoning = out.reasoning
      finish = out.finish
    }
    if (finish?.kind === 'error') throw new Error(finish.failure?.message ?? '语义判断模型调用失败')
    if (finish?.kind === 'aborted') throw new Error('semantic judge aborted')
  }

  const callConfigOf = () => ({
    provider: selection.provider,
    model: selection.model,
    maxTokens: maxTokensUsed,
    ...effortUsed === undefined ? {} : { reasoningEffort: effortUsed },
  })

  try {
    try {
      await runOnce(callConfigOf())
    } catch (error) {
      // 模型不支持这个档位（强制思考的 GLM-5.3、只能思考的 MiniMax M2.x 等）：
      // 退回「不指定」，同时把预算抬高，让思考有地方花、正文还能挤出来。
      if (effortUsed === undefined || !isUnsupportedEffort(error)) throw error
      effortUsed = undefined
      retried = 'effort-unsupported'
      maxTokensUsed = Math.max(maxTokensUsed, EFFORT_FALLBACK_MAX_TOKENS)
      await runOnce(callConfigOf())
    }
    // 思考语言兜底：提示词已经写了「必须用中文」，但模型不一定听（见 `buildJudgeSystem`）。
    // 检测到整段英文推理时，用加强版 system 重试一次；只重试一次，避免把热路径拖成两次调用。
    // 档位 `off`（默认）时压根没有推理，这里不会触发，生产环境没有额外开销。
    if (reasoningLanguage(reasoning) === 'english') {
      system = buildJudgeSystem(suite, config, { strictLanguage: true })
      addRetried('reasoning-language')
      await runOnce(callConfigOf())
    }
    // 正文一个字都没有、finish 又是 max-tokens：思考把预算吃光了。
    // 加长重试一次，也就是「允许它思考，但把思考丢掉、只要结论」那条路。
    if (answer.trim() === '' && finish?.kind === 'max-tokens') {
      const bigger = Math.min(RETRY_MAX_TOKENS_CAP, Math.max(RETRY_MIN_MAX_TOKENS, maxTokensUsed * 4))
      if (bigger > maxTokensUsed) {
        maxTokensUsed = bigger
        addRetried('max-tokens')
        await runOnce(callConfigOf())
      }
    }
    const decision = parseVerdict(answer)
    // 走到这里说明整条链路（prepareCall + stream + finish）都通了，正文空不空另说。
    try {
      suite.noteJudgeHealth?.(true)
    } catch {
      // 健康度只是观测，失败不影响判定
    }
    // 提交给模型的完整输入（system + 上下文）和模型原始返回都落盘，方便复盘「为什么不回」。
    // 正文为空记 ok:false：这说明这次判断其实没有产出，不能算「模型答了 NO」。
    suite.logSemantic?.({
      ...logBase,
      ok: answer.trim() !== '',
      system,
      prompt: clipped,
      answer,
      verdict: decision,
      ...answer.trim() === ''
        ? { error: `模型没有输出正文（finish=${finish?.kind ?? 'none'}，思考 ${reasoning.length} 字）` }
        : {},
      ...diagnostics(),
      ms: Date.now() - startedAt,
    })
    note(decision, answer.trim() !== '')
    if (decision === 'yes') return true
    if (decision === 'no') return false
    // 模型没按格式回答时宁可静默。
    return false
  } catch (error) {
    try {
      suite.noteJudgeHealth?.(false, error instanceof Error ? error.message : String(error))
    } catch {
      // 同上
    }
    suite.logSemantic?.({
      ...logBase,
      ok: false,
      system,
      prompt: clipped,
      answer,
      verdict: 'error',
      error: truncate(error instanceof Error ? error.message : String(error), 300),
      ...diagnostics(),
      ms: Date.now() - startedAt,
    })
    note('error', false)
    throw error
  } finally {
    clearTimeout(timeout)
    if (messageCtx?.signal !== undefined) messageCtx.signal.removeEventListener('abort', onAbort)
  }
}

/** 这次重放是不是「点了聊天记录里的某一行」发起的。 */
function wantsRow(options) {
  return typeof options?.id === 'string' && options.id.trim() !== ''
}

/**
 * 挑一条要重放的记录。两个入口，prompt 的来源不同但用途一样：
 * - 不带 `id`：内存里最近一次正常判断（`index: 0` = 最新）；
 * - 带 `id`：设置页聊天记录里点的那一行，由 `suite.replayTarget()` 按
 *   「内存判断 > 语义日志原文 > 按聊天记录重建」找一份带 system/prompt 的记录。
 */
function pickReplayTarget(suite, options = {}) {
  if (!wantsRow(options)) return pickJudge(suite.recentJudges(), options.index)
  return typeof suite.replayTarget === 'function' ? suite.replayTarget(options.id.trim()) : undefined
}

/**
 * 重放一条语义判断：同一条消息、同一个模型，但**提示词用当前模板重拼**，
 * 并把思考打开、预算放宽，用来回答「照现在的提示词，它会怎么想」。
 *
 * 与 `judgeWithModel` 的区别（改这里时别混）：
 * - 不写任何日志、不动 `semanticCalls/Failures`，也不影响真实判定；
 * - 思考默认 `high`，正文随思考一起返回给设置页；
 * - 超时下限 30 秒，因为思考比判定慢得多。
 */
async function replayJudge(ctx, suite, options = {}) {
  const llm = safeGet(ctx, 'llm')
  if (llm === undefined || typeof llm.prepareCall !== 'function') {
    throw new Error('LLM 服务不可用')
  }
  const target = pickReplayTarget(suite, options)
  if (target === undefined) {
    throw new Error(wantsRow(options)
      ? '这条消息已经不在聊天记录或语义日志里了（被轮转或清空过），换一条再试。'
      : '还没有可重放的判断：先在群里发一条不叫它的消息，等它判断过一次再来。')
  }
  const config = suite.current()
  // 关键：system 永远用当前模板，prompt 优先按 ctx 重拼。
  // 直接用记录里的 system 会让「改完提示词再重放」永远看不到改动（旧版就是这么错的）。
  const input = renderJudgeInput(suite, config, target)
  const recordedSystem = typeof target.system === 'string' ? target.system : ''
  const recorded = typeof target.provider === 'string' && target.provider !== ''
    && typeof target.model === 'string' && target.model !== ''
    ? { provider: target.provider, model: target.model }
    : undefined
  // 重放优先用「当时那次」的路由（默认模型后来换了也不影响比较）；
  // 日志里没记路由时退回当前配置：手动指定的模型 > 默认模型。
  const selection = recorded ?? judgeSelection(ctx, config)
  if (selection === undefined) {
    throw new Error('没有可用的判断模型；请先在 设置 → 模型 里选择一个默认模型')
  }

  const effort = REPLAY_EFFORTS.includes(options.effort) ? options.effort : REPLAY_DEFAULT_EFFORT
  const timeoutMs = Math.max(REPLAY_MIN_TIMEOUT_MS, config.semantic.timeoutMs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('replay timeout')), timeoutMs)
  const startedAt = Date.now()

  let answer = ''
  let reasoning = ''
  let finish
  let effortUsed = effort
  let maxTokens = REPLAY_MAX_TOKENS
  let retried = ''
  // 重放也可能被语言兜底重试一次（换成加强版 system），所以不能直接闭包 input.system。
  let system = input.system
  const messages = [userMessageOf(input.prompt)]

  const runOnce = async () => {
    answer = ''
    reasoning = ''
    finish = undefined
    const callConfig = {
      provider: selection.provider,
      model: selection.model,
      maxTokens,
      ...effortUsed === undefined ? {} : { reasoningEffort: effortUsed },
    }
    const call = await llm.prepareCall(callConfig, controller.signal)
    if (call === null || typeof call !== 'object' || typeof call.stream !== 'function') {
      throw new Error('宿主 LLM 调用缺少 stream()，无法重放；这通常意味着宿主 API 形态变了')
    }
    const out = { text: '', reasoning: '', finish: undefined }
    try {
      await collectStream(
        call.stream({ ...call.config, system, messages, signal: controller.signal }),
        out,
      )
    } finally {
      answer = out.text
      reasoning = out.reasoning
      finish = out.finish
    }
    if (finish?.kind === 'error') throw new Error(finish.failure?.message ?? '重放调用失败')
    if (finish?.kind === 'aborted') throw new Error('重放被中止')
  }

  try {
    try {
      await runOnce()
    } catch (error) {
      // 模型不认这个档位（强制思考的型号）：退回「跟随模型默认」，思考通常仍然开着。
      if (!isUnsupportedEffort(error)) throw error
      effortUsed = undefined
      retried = 'effort-unsupported'
      maxTokens = Math.max(maxTokens, EFFORT_FALLBACK_MAX_TOKENS)
      await runOnce()
    }
    // 语言兜底：重放的用途之一就是看「它到底用中文还是英文在想」，所以这条同样生效。
    // 档位 `off` 时没有推理，不会触发。
    if (reasoningLanguage(reasoning) === 'english') {
      system = buildJudgeSystem(suite, config, { strictLanguage: true })
      retried = retried === '' ? 'reasoning-language' : `${retried}+reasoning-language`
      await runOnce()
    }
    // 思考把预算吃光、正文没吐出来：翻倍再来一次，别让页面只看到一段思考。
    if (answer.trim() === '' && finish?.kind === 'max-tokens') {
      const bigger = Math.min(REPLAY_MAX_TOKENS_CAP, maxTokens * 2)
      if (bigger > maxTokens) {
        maxTokens = bigger
        retried = retried === '' ? 'max-tokens' : `${retried}+max-tokens`
        await runOnce()
      }
    }
  } finally {
    clearTimeout(timer)
  }

  const verdict = answer.trim() === '' ? 'unknown' : parseVerdict(answer)
  return {
    at: new Date().toISOString(),
    requested: {
      id: target.id ?? '',
      at: new Date(target.at).toISOString(),
      group: target.group,
      sender: target.sender,
      text: target.text,
      verdict: target.verdict,
      ok: target.ok,
      // judge = 当时那次判断的原文（内存）；log = 语义日志里的原文；
      // history = 只剩聊天记录，prompt 是按当前模板重建的，不是当时逐字节的输入。
      source: target.source ?? 'judge',
      reconstructed: target.reconstructed === true,
      // 这次实际发出去的输入是哪来的：current = 按 ctx + 当前模板重拼；
      // recorded = 老日志没有 ctx，只能原文照发（改模板不会反映到上下文里）。
      promptSource: input.promptSource,
      // system 跟当时那次不一样 = 提示词模板改过，页面要明说这次用的是新版。
      systemUpdated: recordedSystem !== '' && recordedSystem !== system,
    },
    model: `${selection.provider}/${selection.model}`,
    effort: effortUsed ?? 'default',
    maxTokens,
    timeoutMs,
    ...retried === '' ? {} : { retried },
    ms: Date.now() - startedAt,
    finish: finish?.kind ?? 'none',
    answer,
    verdict,
    reasoningChars: reasoning.length,
    reasoning: reasoning.length > REPLAY_REASONING_LIMIT
      ? `${reasoning.slice(0, REPLAY_REASONING_LIMIT)}…`
      : reasoning,
    // 这次推理是中文还是英文：页面直接标出来，不用靠人眼读整段。
    reasoningLang: reasoningLanguage(reasoning),
    system,
    prompt: input.prompt,
  }
}

/**
 * 日志路径：全部落在 `<suiteHome>/profiles/<profile>/logs/`，跟机器人工作区无关，
 * 所以只在启动时算一次（以前工作区变了要重算）。
 */
function applyLogPaths(paths, rawConfig) {
  paths.logsDir = logsDirOf(rawConfig ?? {})
  paths.debugLog = debugLogPathOf(rawConfig ?? {})
  paths.semanticLog = semanticLogPathOf(rawConfig ?? {})
  paths.historyLog = historyLogPathOf(rawConfig ?? {})
  paths.imageIndex = imageIndexPathOf(rawConfig ?? {})
  paths.idleRecent = idleRecentPathOf(rawConfig ?? {})
}

/**
 * 读落盘的冷场触发记录（旧 → 新）：启动 / 重载时回填内存环。
 * 复用 `readJsonlTail`（history.js 的通用尾部读取）：坏行跳过，读到写一半也不会崩。
 */
function loadIdleRecentFile(file) {
  const lines = readJsonlTail(file, IDLE_RECENT_TRIM_BYTES)
  const parsed = []
  for (const line of lines) {
    try {
      const row = JSON.parse(line)
      if (row !== null && typeof row === 'object') parsed.push(row)
    } catch {
      // 坏行跳过：文件正被并发追加 / 上次进程中断都可能留半行
    }
  }
  return parsed.length > RECENT_IDLE_LIMIT ? parsed.slice(-RECENT_IDLE_LIMIT) : parsed
}

/**
 * 追加一条冷场触发记录；文件超过上限先裁旧行再追加。
 * 记账失败不影响发送——落盘永远只是「尽力而为」。
 */
function appendIdleRecord(file, entry) {
  if (typeof file !== 'string' || file === '') return
  try {
    mkdirSync(dirname(file), { recursive: true })
    let oversized = false
    try {
      oversized = statSync(file).size > IDLE_RECENT_TRIM_BYTES
    } catch {
      // 文件还没生成：直接追加即可
    }
    if (oversized) {
      const keep = loadIdleRecentFile(file)
      writeFileAtomic(file, keep.map((row) => JSON.stringify(row)).join('\n') + (keep.length > 0 ? '\n' : ''))
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch {
    // 落盘失败不影响内存里的记账，页面顶多缺这一条
  }
}

/** 创建套件服务对象（不依赖 cordis 的 Service 类，方便本地 bundle 直接跑）。 */
function createSuite(ctx, rawConfig) {
  const profileDir = profileDirOf(rawConfig ?? {})
  const paths = {
    // 宿主 profile 目录：只读（凭据、patch、SDK 都在这），插件自己的数据不往里写。
    profileDir,
    settings: settingsPathOf(rawConfig ?? {}),
    patch: patchPathOf(rawConfig ?? {}),
    mediaDir: mediaDirOf(rawConfig ?? {}),
    misses: missesPathOf(rawConfig ?? {}),
    logsDir: '',
    debugLog: '',
    semanticLog: '',
    historyLog: '',
    imageIndex: '',
    idleRecent: '',
  }
  let config = loadConfig(rawConfig ?? {}, paths)
  applyLogPaths(paths, rawConfig)
  const listeners = new Set()
  const runtime = {
    lastDecision: null,
    semanticCalls: 0,
    semanticFailures: 0,
    // 判定链路健康度：连续失败到阈值就在设置页报「已降级」，别让故障只留在日志里。
    judgeHealth: { failures: 0, total: 0, lastError: '', lastAt: 0, okAt: 0 },
    // 最近几次语义判断的原始请求（内存，不落盘）：给设置页「重放」和「标该回」用。
    recentJudges: [],
    // 最近几次冷场触发（内存，不落盘）。和 recentJudges 分开：那一份是 YES/NO 样本。
    idleRecent: [],
    // 上次建会话时 deny 到底挂上了几个（guard.js 回写）：名字写错时页面要能看见。
    denyResult: null,
    // 机器实例（gate.js 在 emit 里捕获）：群健康借它自己的 client 发只读请求。
    bot: null,
    // 机器人工作区（gate.js 从官方 SessionManager.config.cwd 捕获）。
    // 有值就不再读 profile 的 cordis.patch.yml——那是宿主的配置，只该在保存时写。
    botWorkspace: '',
    // 群健康缓存：at = 成功时间，attemptAt = 上次尝试（含失败），用于节流。
    groupHealth: { at: 0, attemptAt: 0, error: '', groups: [] },
  }

  // 冷场记录落盘回填：重载 / 重启后设置页还能看到之前的触发，不再一换实例就归零。
  // 文件是追加序（旧 → 新），内存环是 unshift 序（下标 0 = 最新），所以反转一下。
  try {
    runtime.idleRecent = loadIdleRecentFile(paths.idleRecent).reverse()
  } catch {
    // 回填失败就用空列表：不影响机器人，只是页面少看一段历史
  }

  /** 判定链路健康度的快照（status 与 snapshot 共用，避免两处口径不一致）。 */
  const readJudgeHealth = () => {
    const health = runtime.judgeHealth
    return {
      degraded: health.failures >= JUDGE_DEGRADE_THRESHOLD,
      failures: health.failures,
      total: health.total,
      lastError: health.lastError,
      lastAt: health.lastAt,
      okAt: health.okAt,
    }
  }
  // 人工标注的样本。启动时读一次，之后只在内存里增删、每次落盘。
  // 用 Map 而不是 Set：同一条消息只能有一个标签（该回 / 不回），改标就地替换。
  let misses = loadMisses(paths.misses)
  const markedLabels = new Map(misses.map((item) => [item.id, normalizeLabel(item.label)]))
  /** 一行的标注状态：`marked` 给旧页面用，`markedLabel` 区分「该回 / 不回」。 */
  const markOf = (id) => {
    const label = markedLabels.get(id)
    return label === undefined ? { marked: false, markedLabel: '' } : { marked: true, markedLabel: label }
  }
  let recentProvider = () => []
  /** 重放同一时间只跑一个：连点两下会并发打模型，没有意义。 */
  let replaying = false

  /**
   * 聊天记录文件的解析缓存：设置页会定时拉快照，文件没变就不重读。
   * 缓存键里带路径，切换工作区时自然失效。
   */
  let historyCache = { path: '', size: -1, mtimeMs: -1, entries: [] }
  const historyEntries = () => {
    const file = paths.historyLog
    if (file === '') return []
    try {
      const info = statSync(file)
      if (
        historyCache.path === file
        && historyCache.size === info.size
        && historyCache.mtimeMs === info.mtimeMs
      ) {
        return historyCache.entries
      }
      const entries = readHistoryTail(file, { limit: MISS_HISTORY_SCAN })
      historyCache = { path: file, size: info.size, mtimeMs: info.mtimeMs, entries }
      return entries
    } catch {
      // 文件还没生成（或刚被轮转走）：按空列表处理，页面显示「还没记录」。
      return []
    }
  }

  /**
   * 图片索引的解析缓存：面板要按 messageId 回答「这行 `[图片]` 到底是哪张图」。
   * 键跟 `historyCache` 一样按文件指纹走，prune 对账重写后会自然失效。
   */
  let imageIndexCache = { key: '', byMessage: new Map() }
  const imageRowsByMessage = () => {
    const file = paths.imageIndex
    if (file === '') return new Map()
    let key = file
    try {
      const info = statSync(file)
      key += `|${info.size}|${info.mtimeMs}`
    } catch {
      key += '|-'
    }
    if (imageIndexCache.key === key) return imageIndexCache.byMessage
    const byMessage = new Map()
    for (const row of readIndex(file)) {
      if (typeof row.m !== 'string' || row.m === '') continue
      const list = byMessage.get(row.m)
      if (list === undefined) byMessage.set(row.m, [row])
      else list.push(row)
    }
    imageIndexCache = { key, byMessage }
    return byMessage
  }

  /**
   * 图片行补上「是哪张图」：聊天记录里只有 `[图片]`，索引里有 `messageId → 磁盘名 / 路径`
   * （两者同一个 messageId，见 images-recall.js 的行格式）。
   * 只能尽力而为：索引按磁盘快照对账，图被 media-cleaner 清掉之后就查不到了。
   */
  const withImageRef = (row, entry) => {
    if (typeof row?.text !== 'string' || !row.text.startsWith('[图片')) return row
    const id = typeof entry?.id === 'string' ? entry.id : ''
    if (id === '') return row
    const rows = imageRowsByMessage().get(id)
    if (rows === undefined || rows.length === 0) return row
    return { ...row, image: { file: rows[0].f, path: rows[0].p, count: rows.length } }
  }

  /** 一条聊天记录 → 设置页的那一行；能配上内存里的判断就顺带带上判定结果。 */
  const missRowOf = (entry) => {
    const id = historyRowId(entry)
    const judge = findJudgeFor(entry, runtime.recentJudges)
    if (judge === undefined) {
      // 内存里没有那次判断，但语义日志里可能有：借它的判定结果和模型名来显示，
      // id 仍用聊天记录算的那个（标记状态按这个 key 走）。
      const logged = semlogMatch(entry)
      if (logged !== undefined) {
        return { ...logRowOf(logged), id, at: entry.at, ...markOf(id) }
      }
    }
    return {
      id,
      at: entry.at,
      group: entry.group,
      sender: entry.name || entry.senderId || '某人',
      text: entry.text,
      verdict: typeof judge?.verdict === 'string' ? judge.verdict : 'unknown',
      ok: judge?.ok === true,
      ms: Number.isFinite(judge?.ms) ? judge.ms : 0,
      model: judge !== undefined ? `${judge.provider}/${judge.model}` : '',
      // judge = 当时那次判断还在内存里，能带上完整 system/prompt；
      // history = 只剩聊天记录，标样本时用当前模板重建。
      source: judge === undefined ? 'history' : 'judge',
      ...markOf(id),
    }
  }

  /**
   * 语义日志的解析缓存：聊天记录文件是 20:11 才上线的，之前的判定只能从这里补。
   * 缓存键带上 `.1`，轮转发生时自然失效。
   */
  let semlogCache = { key: '', entries: [] }
  const semlogEntries = () => {
    const file = paths.semanticLog
    if (file === '') return []
    let key = file
    for (const target of [file, `${file}.1`]) {
      try {
        const info = statSync(target)
        key += `|${info.size}|${info.mtimeMs}`
      } catch {
        key += '|-'
      }
    }
    if (semlogCache.key === key) return semlogCache.entries
    const entries = readSemanticLog(file, { limit: MISS_LOG_SCAN })
    semlogCache = { key, entries }
    return entries
  }

  /** 聊天记录里的一条，是否就是语义日志里的这一条（正文 + 发送者 + 时间窗）。 */
  const sameMessage = (row, item) => row.text === item.text
    && row.sender === item.sender
    && Math.abs((row.at ?? 0) - (item.at ?? 0)) <= MISS_MATCH_MS

  /** 语义日志里的一条 → 列表行。它带着当时的原始 system/prompt，保真度最高。 */
  const logRowOf = (item) => {
    const id = semanticRowId(item)
    return {
      id,
      at: item.at,
      group: item.group,
      sender: item.sender || '某人',
      text: item.text,
      verdict: item.verdict,
      ok: item.ok === true,
      ms: item.ms,
      model: item.model,
      source: 'log',
      ...markOf(id),
    }
  }

  /** 语义日志里的一条 → 落盘样本的原料（system/prompt 原样抄，不重建）。 */
  const logRecordOf = (item, id) => {
    const slash = typeof item.model === 'string' ? item.model.indexOf('/') : -1
    return {
      id,
      at: item.at,
      group: item.group,
      sender: item.sender || '某人',
      text: item.text,
      provider: slash > 0 ? item.model.slice(0, slash) : '',
      model: slash > 0 ? item.model.slice(slash + 1) : item.model,
      system: item.system,
      prompt: item.prompt,
      // 有结构化上下文才能按当前模板重拼（老日志没有这个字段）。
      ctx: item.ctx,
      answer: item.answer,
      verdict: item.verdict || 'unknown',
      ok: item.ok === true,
      ms: item.ms,
      source: 'log',
      reconstructed: false,
    }
  }

  /** 聊天记录里这条消息在语义日志里的那次判定（有就返回，没有返回 undefined）。 */
  const semlogMatch = (entry) => {
    const row = {
      text: entry.text,
      sender: entry.name || entry.senderId || '某人',
      at: entry.at,
    }
    return semlogEntries().find((item) => sameMessage(row, item))
  }

  /**
   * 机器人自己发的一条 → 列表里的上下文行（`bot: true`，不可标记）。
   * 没有它，「这句是在接谁的话」在页面上完全看不出来。
   */
  const botRowOf = (entry) => ({
    id: historyRowId(entry),
    at: entry.at,
    group: entry.group,
    sender: entry.name || '机器人',
    text: entry.text,
    bot: true,
  })

  /**
   * 「该回却没回」的候选 + 时间线上下文，新的在前。三个来源合并：
   *   1. 聊天记录文件里的群消息（落盘上线之后的），无论放没放行；
   *   2. 语义日志里早于落盘、判成 no/unknown 的判定（否则 10-30 那批永远看不到）；
   *   3. 机器人自己的发言，`bot: true`、不可标记，纯当上下文。
   *
   * 放行过的（`answered: true`）**不再丢弃**：排查「它凭什么回这句」时，被回的那句原文
   * 恰恰是最要紧的一条，丢掉就只剩机器人自说自话（2026-11-04 报障）。页面把它们标成
   * 「已回」，也不给「该回」按钮——已经回了，本来就不算漏判。
   *
   * 同一条消息两边都有时只保留聊天记录那行——它的时间戳是消息本身的，
   * 标样本时会再去日志里找原文（见 markJudge），保真度不吃亏。
   */
  const missRows = () => {
    const rows = []
    for (const entry of historyEntries()) {
      if (entry.bot === true) {
        rows.push(botRowOf(entry))
        continue
      }
      rows.push({ ...withImageRef(missRowOf(entry), entry), answered: entry.answered === true })
    }
    for (const item of semlogEntries()) {
      if (item.verdict === 'yes') continue
      if (rows.some((row) => sameMessage(row, item))) continue
      rows.push(logRowOf(item))
    }
    rows.sort((a, b) => a.at - b.at)
    // 候选按最近 MISS_ROW_LIMIT 条截断，机器人发言不占这个名额：
    // 先定位候选的时间截断点，再把这一点之后的上下文（含机器人）一起带出来。
    const candidates = rows.filter((row) => row.bot !== true)
    const cutoff = candidates.length > MISS_ROW_LIMIT
      ? candidates[candidates.length - MISS_ROW_LIMIT].at
      : Number.NEGATIVE_INFINITY
    const kept = rows.filter((row) => row.at >= cutoff)
    // 兜底：上下文特别密时别把页面撑爆（人+机器人各 80 条已经很够看）。
    return kept.slice(-(MISS_ROW_LIMIT * 2)).reverse()
  }

  /**
   * 给「只在聊天记录里、内存里已经没有判断」的那条重建一份样本：
   * system 用当前模板，prompt 用文件里这条之前的上下文重新拼。
   * 它不是当时逐字节的输入（引用内容补不回来），所以样本里明确标 `source: 'history'`，
   * 以后改提示词时能按来源过滤，别把重建样本当成原始证据。
   */
  const rebuildFromHistory = (entry) => {
    const before = historyEntries().filter((item) => (
      item.group === entry.group
      && item.at < entry.at
      && !(item.id !== '' && item.id === entry.id)
    ))
    const sender = entry.name || entry.senderId || '某人'
    return {
      id: historyRowId(entry),
      at: entry.at,
      group: entry.group,
      sender,
      text: entry.text,
      provider: '',
      model: '',
      system: buildJudgeSystem(suite, config),
      prompt: buildJudgePrompt({
        history: before.filter((item) => item.bot !== true),
        botTexts: before.filter((item) => item.bot === true).map((item) => item.text),
        quote: '',
        sender,
        text: entry.text,
        at: entry.at,
        maxHistory: config.semantic.maxHistory,
        maxChars: config.semantic.maxChars,
        staleMinutes: config.semantic.staleMinutes,
      }),
      answer: '',
      verdict: 'unknown',
      ok: false,
      source: 'history',
      reconstructed: true,
    }
  }

  /**
   * 按列表行的 id 取一条带 system/prompt 的记录（标记样本和「重放这一条」共用）。
   * 优先级：内存里那次判断 > 语义日志里的原文 > 按聊天记录重建。
   * 找不到返回 undefined——调用方自己决定报什么错。
   */
  const recordById = (id) => {
    if (typeof id !== 'string' || id === '') return undefined
    const entry = historyEntries().find((item) => item.bot !== true && historyRowId(item) === id)
    if (entry !== undefined) {
      const judge = findJudgeFor(entry, runtime.recentJudges)
      const logged = semlogMatch(entry)
      const base = judge ?? (logged === undefined ? rebuildFromHistory(entry) : logRecordOf(logged, id))
      // id 一律用聊天记录算出来的那个：判断记录自带的是另一次随机 id，
      // 用它落盘/回查会导致「按列表 id 找不到」。
      return { ...base, id }
    }
    const logged = semlogEntries().find((item) => semanticRowId(item) === id)
    return logged === undefined ? undefined : logRecordOf(logged, id)
  }

  /**
   * 群健康：只查历史里最近出现过的几个群，借机器人实例自己的 token / client。
   *
   * 为什么不自己读凭据：profile 里的 appSecret 不该被本插件再读一遍（越界清单第 8 项），
   * 而 `QQBot` 实例内存里已经有 creds 和 tokenManager，直接复用既不新增出站链路，
   * 也不落任何凭据——这也是唯一不需要 AppSecret 就能查群状态的路径。
   */
  const recentGroupIds = () => {
    const ids = []
    const entries = historyEntries()
    for (let i = entries.length - 1; i >= 0 && ids.length < HEALTH_GROUP_LIMIT; i -= 1) {
      const id = typeof entries[i]?.group === 'string' ? entries[i].group : ''
      if (id !== '' && !ids.includes(id)) ids.push(id)
    }
    return ids
  }

  const fetchGroupHealth = async () => {
    const bot = runtime.bot
    if (bot === null) throw new Error('还没拿到机器人实例：等机器人在线并处理过一条消息后再刷新')
    const creds = typeof bot.getCredentials === 'function' ? bot.getCredentials() : bot.creds
    if (typeof creds?.appId !== 'string' || typeof creds?.clientSecret !== 'string') {
      throw new Error('机器人实例上没有可用凭据')
    }
    if (typeof bot.tokenManager?.getAccessToken !== 'function' || typeof bot.apiClient?.request !== 'function') {
      throw new Error('机器人实例不支持直接调接口（SDK 版本不匹配）')
    }
    const token = await bot.tokenManager.getAccessToken(creds.appId, creds.clientSecret)
    const get = (path) => bot.apiClient.request(token, 'GET', path)
    const groups = []
    for (const id of recentGroupIds()) {
      const row = { id, name: '', members: 0, recv: '', proactive: false, role: '', joinedAt: '', error: '' }
      try {
        const state = await get(`/v2/groups/${id}/bot_state`)
        row.recv = typeof state?.recv_msg_setting === 'string' ? state.recv_msg_setting : ''
        row.proactive = state?.allow_proactive_msg === true
        row.role = typeof state?.member_role === 'string' ? state.member_role : ''
        row.joinedAt = typeof state?.joined_at === 'string' ? state.joined_at : ''
      } catch (error) {
        row.error = error instanceof Error ? error.message : String(error)
      }
      try {
        const info = await get(`/v2/groups/${id}/info`)
        row.name = typeof info?.group_name === 'string' ? info.group_name : ''
        row.members = Number.isFinite(info?.group_member_num) ? info.group_member_num : 0
      } catch (error) {
        if (row.error === '') row.error = error instanceof Error ? error.message : String(error)
      }
      groups.push(row)
    }
    return groups
  }

  /** 群健康快照：附带「跟当前配置对不上」的标记，页面不用自己比。 */
  const healthStatus = () => {
    const health = runtime.groupHealth
    return {
      at: health.at,
      error: health.error,
      nextAllowedAt: health.attemptAt === 0 ? 0 : health.attemptAt + HEALTH_MIN_INTERVAL_MS,
      groups: health.groups.map((row) => ({
        ...row,
        warnings: [
          ...(config.mode === 'semantic' && row.recv !== '' && row.recv !== 'all' ? ['recv_not_all'] : []),
          ...(config.idle.enabled === true && row.error === '' && row.proactive === false ? ['proactive_off'] : []),
        ],
      })),
    }
  }

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener(config)
      } catch {
        // 一个订阅者出错不影响其它子插件
      }
    }
  }

  const suite = {
    paths,
    current: () => config,
    /**
     * 提示词覆盖：设置页「Prompt 设置」折叠区填的句子在这里统一替换。
     * gate / guard 都 inject 了 qqbotSuite，直接用它，不另开配置通道。
     */
    copy(text) {
      return applyPromptOverrides(text, config.promptOverrides)
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    status() {
      return {
        lastDecision: runtime.lastDecision,
        semanticCalls: runtime.semanticCalls,
        semanticFailures: runtime.semanticFailures,
        semanticHealth: readJudgeHealth(),
      }
    },
    setGateStatus(patch) {
      if (patch !== null && typeof patch === 'object') runtime.lastDecision = patch
    },
    /**
     * 记住机器人实例（gate.js 在 emit 里捕获）。
     * 只用来借它的校验过的 client 发只读请求，不读不存任何凭据。
     */
    noteBot(bot) {
      if (bot !== null && typeof bot === 'object') runtime.bot = bot
    },
    /**
     * 记住机器人工作区（gate.js 从官方 `SessionManager.config.cwd` 捕获）。
     *
     * 有了它，读「机器人工作区」就不用去解析宿主的 `cordis.patch.yml`：
     * 那个文件只在用户改设置时写，其余时间不该被插件反查。
     */
    noteBotWorkspace(cwd) {
      if (typeof cwd === 'string' && cwd.trim() !== '') runtime.botWorkspace = cwd.trim()
    },
    /** 当前机器人实例（没有就是 null）。self 借它的凭据与 client 调 `/users/@me`。 */
    bot() {
      return runtime.bot
    },
    /** 运行期观测到的机器人工作区；还没观测到时返回空串（调用方自己决定兜底）。 */
    botWorkspace() {
      return runtime.botWorkspace
    },
    /** guard.js 回写「这次建会话时 deny 到底挂上了几个」。 */
    noteDenyResult(result) {
      if (result === null || typeof result !== 'object') return
      runtime.denyResult = result
    },
    /** 群健康缓存（设置页进页面时直接读，不发请求）。 */
    health() {
      return healthStatus()
    },
    /**
     * 刷新群健康。手动触发，两次之间至少间隔 `HEALTH_MIN_INTERVAL_MS`。
     * 节流在这里做而不是只在按钮上做：页面可以刷新、可以多开，接口必须自己防。
     */
    async refreshHealth() {
      const now = Date.now()
      const wait = runtime.groupHealth.attemptAt + HEALTH_MIN_INTERVAL_MS - now
      if (wait > 0) return { throttled: true, retryAfterMs: wait, health: healthStatus() }
      runtime.groupHealth.attemptAt = now
      try {
        const groups = await fetchGroupHealth()
        runtime.groupHealth = { at: Date.now(), attemptAt: now, error: '', groups }
      } catch (error) {
        // 失败不动 `at`：页面要能区分「上次成功是什么时候」和「这次为什么没成」。
        runtime.groupHealth = {
          ...runtime.groupHealth,
          attemptAt: now,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      return { throttled: false, retryAfterMs: 0, health: healthStatus() }
    },
    /**
     * 记下这次判断的请求（system + prompt + 模型），只留在内存里。
     * 设置页「重放」靠它，所以**不要**挂到 `debug` 开关下面——关着日志也得能重放。
     */
    noteJudge(entry) {
      if (entry === null || typeof entry !== 'object') return
      runtime.recentJudges.push(entry)
      if (runtime.recentJudges.length > RECENT_JUDGE_LIMIT) {
        runtime.recentJudges.splice(0, runtime.recentJudges.length - RECENT_JUDGE_LIMIT)
      }
    },
    /**
     * 记一次判定链路的结果。连续失败到阈值，设置页显示「已降级」——
     * 语义判定失败是静默丢弃（群里表现为「不回复」），不亮出来根本查不到。
     */
    noteJudgeHealth(ok, error) {
      const health = runtime.judgeHealth
      const now = Date.now()
      if (ok === true) {
        health.failures = 0
        health.okAt = now
        return
      }
      health.failures += 1
      health.total += 1
      health.lastError = truncate(error instanceof Error ? error.message : String(error ?? ''), 200)
      health.lastAt = now
    },
    judgeHealth() {
      return readJudgeHealth()
    },
    recentJudges() {
      return runtime.recentJudges.slice()
    },
    /**
     * 记一次冷场触发（gate.js 调用）。
     *
     * 和 `noteJudge` 并列但**不共用列表**：冷场不经过语义判定，它的 ok/reason 讲的是
     * 「有没有真的说出去」，不是「该不该回」。混进 YES/NO 统计会让漏判标注彻底失真。
     */
    noteIdle(entry) {
      if (entry === null || typeof entry !== 'object') return
      runtime.idleRecent.unshift(entry)
      if (runtime.idleRecent.length > RECENT_IDLE_LIMIT) {
        runtime.idleRecent.splice(RECENT_IDLE_LIMIT)
      }
      // 同步落盘：重载 / 重启后由启动回填接上，页面不再「一重载就清空」。
      appendIdleRecord(paths.idleRecent, entry)
    },
    /** 漏判样本现状：条数、样本文件、列表来源（聊天记录文件）。 */
    missStatus() {
      const persist = config.history.persist === true
      return {
        count: misses.length,
        // 正负样本各多少：页面上「已存 N 条」旁边要能看出两类都攒到没有。
        ...countLabels(misses),
        path: paths.misses,
        limit: MISS_ROW_LIMIT,
        historyPath: paths.historyLog,
        // 落盘上线之前的判定只能从语义日志补，页面要把这个来源也说清楚。
        logPath: paths.semanticLog,
        // 列表读的是聊天记录文件：落盘关了就没有列表可点，页面要能说清原因。
        persist,
      }
    },
    /**
     * 人工标注一条判断 → 把带上下文的记录落盘。
     *
     * `label`：`should-reply`（该回却没回 = 漏判）或 `should-not-reply`（回了但其实不该回）。
     * 两类都收：只有正样本会把判定越调越"积极"，只有负样本又会退化成装死。
     * 同一条可以改标（该回 ⇄ 不回），就地替换那一条；`marked === false` 取消标注。
     *
     * 标记时记录从**聊天记录文件**里按 id 找（重启、翻得更早都还在），
     * 内存里还留着当时的判断就带上原始 system/prompt，否则按聊天记录重建一份。
     * 取消标记只按 id 从样本库删，不回查来源——源记录被轮转掉也要能取消。
     * 只写本地样本文件：不动判定、不写日志、不计入任何计数。
     */
    markJudge(id, marked = true, label = LABEL_REPLY) {
      if (typeof id !== 'string' || id === '') {
        const error = new Error('缺少记录 id')
        error.code = 'JUDGE_INVALID'
        throw error
      }
      // 取消标记只按样本库里的 id 删，不再回查来源：语义日志轮转、聊天记录被清过之后，
      // 源记录已经不在了，样本库里那条还得能删掉——否则会留下永远取消不掉的记录。
      if (marked === false) {
        const before = misses
        misses = removeMiss(misses, id).list
        try {
          saveMisses(paths.misses, misses)
        } catch (error) {
          // 写盘失败别把内存和文件写成两个世界：退回改动前再抛。
          misses = before
          throw error
        }
        markedLabels.delete(id)
        return { marked: false, markedLabel: '', ...suite.missStatus() }
      }

      const record = recordById(id)
      if (record === undefined) {
        const error = new Error('这条记录已经不在聊天记录或语义日志里了（被轮转或清空过）。')
        error.code = 'JUDGE_GONE'
        throw error
      }
      const wanted = normalizeLabel(label)
      const before = misses
      misses = addMiss(misses, { ...record, id, label: wanted }).list
      try {
        saveMisses(paths.misses, misses)
      } catch (error) {
        // 写盘失败别把内存和文件写成两个世界：退回改动前再抛。
        misses = before
        throw error
      }
      markedLabels.set(id, wanted)
      return { marked: true, markedLabel: wanted, ...suite.missStatus() }
    },
    /**
     * 给「重放聊天记录里的这一条」找一份带 system + prompt 的记录。
     * 和标记样本共用 `recordById()`，所以两条路径看到的输入一致：
     * 内存里那次判断 > 语义日志里的原文 > 按聊天记录重建。
     * 重建的那种带 `source: 'history'`，页面要提醒「不是当时逐字节的输入」。
     * 找不到返回 undefined，由 `replayJudge()` 抛一句人能看懂的话。
     */
    replayTarget(id) {
      if (typeof id !== 'string' || id.trim() === '') return undefined
      const record = recordById(id.trim())
      if (record === undefined) return undefined
      if (typeof record.prompt !== 'string' || record.prompt.trim() === '') return undefined
      // 老日志可能只记了 prompt：这种记录没有当时的 system，页面上标成「重建」。
      // system/prompt 具体用哪一份由 `replayJudge()` 里的 `renderJudgeInput()` 决定。
      const hasSystem = typeof record.system === 'string' && record.system !== ''
      return {
        ...record,
        source: record.source ?? 'judge',
        reconstructed: record.reconstructed === true || !hasSystem,
      }
    },
    /** 重放最近一次正常判断：原样重发、保留 thinking。不写日志、不计数。 */
    async replay(options = {}) {
      if (replaying) {
        const error = new Error('上一次重放还没结束，等它跑完再点。')
        error.code = 'REPLAY_BUSY'
        throw error
      }
      replaying = true
      try {
        return await replayJudge(ctx, suite, options)
      } finally {
        replaying = false
      }
    },
    /**
     * debug 开启时把每条判断追加到日志文件（默认在插件数据目录的 `logs/` 下）。
     * 用 JSON Lines 而不是依赖宿主 logger，方便直接 grep / 用编辑器看。
     * 单个文件超过 1MB 轮转一次，旧文件留作 `.1`。
     */
    logDebug(entry) {
      if (config.debug !== true || entry === null || typeof entry !== 'object') return
      try {
        appendJsonl(paths.debugLog, entry)
      } catch {
        // 日志失败不影响消息判断
      }
    },
    /**
     * 语义判断日志：跟「调试日志」开关走，开启时每次调用模型记一条
     * （system + 上下文 + 模型原始返回 + 判定结果），同样 1MB 轮转。
     */
    logSemantic(entry) {
      if (config.debug !== true || entry === null || typeof entry !== 'object') return
      try {
        appendJsonl(paths.semanticLog, entry)
      } catch {
        // 同上
      }
    },
    setRecentProvider(fn) {
      recentProvider = typeof fn === 'function' ? fn : () => []
    },
    /**
     * 按数量清理官方插件的媒体缓存（`~/.dsh-qqbot/media`）。
     * 保留最新的 `media.maxFiles` 个（最少 1，没有「不限」）；结果顺带写一条 debug 日志。
     *
     * 清理之后**必须对一次索引**：本地删了哪些图，索引里就得没有哪些行。
     * 这是 `images-recall.js` 唯一的对账入口——上游 `media-cleaner` 按 ttlHours
     * 独立删文件、不经过这里，也只能在下一轮 prune 时被顺手清掉。
     */
    pruneMedia(options = {}) {
      const pinned = options.pinned instanceof Set ? options.pinned : pinnedMediaNames()
      const result = pruneMediaDir(paths.mediaDir, config.media.maxFiles, { ...options, pinned })
      try {
        // 用目录里的真实文件列表对账（不能拿 result 里的：它已排除 pinned / 宽限期文件，
        // 那些文件还活着，对应行不该删）。
        const fixed = reconcileIndex(paths.imageIndex, mediaFileNames(paths.mediaDir))
        if (fixed.written) {
          suite.logDebug({ reason: 'image-index-reconciled', ...fixed })
        }
      } catch {
        // 对账失败不影响清理本身；下一轮再试
      }
      if (result.removed > 0) {
        try {
          suite.logDebug({
            reason: 'media-pruned',
            ...result,
            maxFiles: config.media.maxFiles,
            ...(pinned.size > 0 ? { pinned: pinned.size } : {}),
          })
        } catch {
          // 日志失败不影响清理
        }
      }
      return result
    },
    /** 媒体缓存现状：目录、文件数、总字节、上限；顺带报索引行数（应 ≤ 图片数）。 */
    mediaStatus() {
      const pinned = pinnedMediaNames()
      const summary = mediaSummary(paths.mediaDir, config.media.maxFiles, { pinned })
      let indexRows = 0
      try {
        indexRows = readIndex(paths.imageIndex).length
      } catch {
        // 读不到就当 0
      }
      return { ...summary, indexRows }
    },
    recentTexts(groupId) {
      try {
        return recentProvider(groupId)
      } catch {
        return []
      }
    },
    async save(patch = {}) {
      const input = patch !== null && typeof patch === 'object' ? patch : {}
      // 越界的数字不收敛，直接拒绝：设置页要的是「请重新输入」，不是悄悄改成上下限。
      // 字段清单见 config.js: NUMERIC_FIELDS（含设置页没有输入框、只能手改的那几个）。
      const bad = findOutOfRange(input)
      if (bad !== null) {
        const error = new RangeError(`「${bad.label}」超出范围 ${bad.min}–${bad.max}，请重新输入。`)
        error.code = 'OUT_OF_RANGE'
        error.field = bad.label
        throw error
      }
      const next = normalizeConfig({
        ...config,
        mode: input.mode ?? config.mode,
        // 唤醒匹配、判定提示词、群历史里的 bot 标记都读 botName：
        // 这里漏一个字段，设置页「随便怎么叫我」填完保存就静默回退成旧值。
        botName: input.botName ?? config.botName,
        wakeWords: input.wakeWords ?? config.wakeWords,
        slash: {
          ...config.slash,
          ...(input.slash !== null && typeof input.slash === 'object' ? input.slash : {}),
        },
        image: {
          ...config.image,
          ...(input.image !== null && typeof input.image === 'object' ? input.image : {}),
        },
        debug: input.debug ?? config.debug,
        semantic: {
          ...config.semantic,
          ...(input.semantic !== null && typeof input.semantic === 'object' ? input.semantic : {}),
        },
        timeout: {
          ...config.timeout,
          ...(input.timeout !== null && typeof input.timeout === 'object' ? input.timeout : {}),
        },
        reply: {
          ...config.reply,
          ...(input.reply !== null && typeof input.reply === 'object' ? input.reply : {}),
        },
        merge: {
          ...config.merge,
          ...(input.merge !== null && typeof input.merge === 'object' ? input.merge : {}),
        },
        media: {
          ...config.media,
          ...(input.media !== null && typeof input.media === 'object' ? input.media : {}),
        },
        guard: {
          ...config.guard,
          ...(input.guard !== null && typeof input.guard === 'object' ? input.guard : {}),
        },
        history: {
          ...config.history,
          ...(input.history !== null && typeof input.history === 'object' ? input.history : {}),
        },
        idle: {
          ...config.idle,
          ...(input.idle !== null && typeof input.idle === 'object' ? input.idle : {}),
        },
        // 提示词覆盖**整份替换**，不逐键合并：设置页「恢复默认 / 全部恢复默认」就是
        // 把键删掉后把整份映射发上来的，合并会把刚删掉的键又粘回去，重置永远不生效。
        // 不带这个键（其它调用方发部分 patch）时保持现有覆盖不动。
        ...(input.promptOverrides !== null && typeof input.promptOverrides === 'object'
          ? { promptOverrides: input.promptOverrides }
          : {}),
      })

      const workspace = typeof input.workspace === 'string' ? input.workspace.trim() : ''
      if (workspace !== '') {
        mkdirSync(workspace, { recursive: true })
        // 只写不比：`writeBotWorkspace` 自己会先读后算，内容没变直接 no-op，
        // 省掉保存前那一趟「为了比而读宿主配置」。
        writeBotWorkspace(paths.patch, workspace)
        // 刚写的值就是最新值，顺手更新运行期缓存，免得页面还显示旧工作区。
        runtime.botWorkspace = workspace
      }

      writeConfig(paths.settings, next)
      config = next
      // 日志路径不跟工作区走，保存时不用重算。
      // 上限调小后立即生效，不用等下一个清理周期（顺带对一次索引）。
      try {
        suite.pruneMedia()
      } catch {
        // 清理失败不影响保存
      }
      notify()
      return suite.snapshot()
    },
    snapshot() {
      // 工作区只认运行期观测值（gate 从官方会话模块拿到的 cwd）。机器人还没建过会话时是空串，
      // 页面就显示空——不读宿主 patch 兜底：那份配置归宿主和官方插件所有。
      const workspace = runtime.botWorkspace
      const managed = managedWorkspaces(workspace, config.guard.extras)
      const fallback = defaultSelection(ctx)
      // 实际生效的路由：手动指定优先。页面靠 modelSource 决定显示「跟随默认」还是「手动指定」。
      const configured = parseModelRef(config.semantic.model)
      const selection = configured ?? fallback
      const llm = safeGet(ctx, 'llm')
      return {
        mode: config.mode,
        // 手填的机器人名字：页面「怎么叫它」输入框的回显来源，也是判定提示词里
        // 「机器人自己在群里的名字」那句的来源。不下发的话刷新就是空框。
        botName: config.botName,
        wakeWords: [...config.wakeWords],
        slash: {
          allowIds: [...config.slash.allowIds],
          // 空名单 = 不启用：所有人都照旧。
          enabled: config.slash.allowIds.length > 0,
        },
        image: { ...config.image },
        // 回复用哪种消息类型（auto / text / markdown），设置页「群聊」页签用。
        reply: { ...config.reply },
        debug: config.debug,
        semantic: { ...config.semantic },
        timeout: { ...config.timeout },
        merge: { ...config.merge },
        history: { ...config.history },
        idle: { ...config.idle },
        // 「提示词改写」的已覆盖项：页面靠它回显「已覆盖 N 项」和每条当前的文案。
        // 不下发的话，刷新后页面永远是「已覆盖 0 项」，看着像刚保存就丢了。
        promptOverrides: { ...config.promptOverrides },
        guard: {
          workspace,
          // 工作区没配时，im-qqbot 自己回落到进程 cwd（见 dsh-qqbot 的
          // `dist/config.d.ts`：cwd 缺省回落到进程 cwd）。设置页拿它当输入框
          // 的占位示例，不在前端写死一条本机路径。反斜杠换成 / 只为显示一致。
          defaultWorkspace: process.cwd().replace(/\\/g, '/'),
          extras: [...config.guard.extras],
          deny: [...config.guard.deny],
          // 群聊放行清单（用户配的）+ 实际生效清单（自动追加 read_image）。
          allow: [...config.guard.allow],
          groupTools: [...groupAllowedTools(config.image.mode, config.guard.allow)],
          // 上次建会话时 deny 挂上了哪些、哪几个没成（名字写错时唯一看得见的地方）。
          denyResult: runtime.denyResult,
          managed,
          enabled: managed.length > 0 && config.guard.deny.length > 0,
        },
        lastDecision: runtime.lastDecision,
        semanticCalls: runtime.semanticCalls,
        semanticFailures: runtime.semanticFailures,
        semanticHealth: readJudgeHealth(),
        // 设置页冷场区块用：只放摘要，正文已截断。刻意不放 semanticRecent 里，
        // 那一份是「该不该回」的样本，冷场不经过语义判定。
        idleRecent: runtime.idleRecent.slice(),
        // 设置页「语义调试」用：只要摘要，正文和提示词跟着重放的响应走。
        semanticRecent: runtime.recentJudges
          .map((item) => ({
            id: item.id,
            at: item.at,
            group: item.group,
            sender: item.sender,
            text: item.text,
            verdict: item.verdict,
            ok: item.ok,
            ms: item.ms,
            ...markOf(item.id),
            model: `${item.provider}/${item.model}`,
          }))
          .reverse(),
        semanticMisses: {
          ...suite.missStatus(),
          rows: missRows(),
        },
        replayBusy: replaying,
        // 能力标记：页面用它判断后端是不是「认 id 的那版」。
        // 页面（client.js）和后端（index.js）分开生效，只有页面刷新、后端没重载时会出现
        // 「有按钮但点了没用」——这个字段让页面能提前禁用而不是等报错。
        replayById: true,
        media: suite.mediaStatus(),
        // 群健康：缓存值。页面进站直接显示，要新数据点「刷新」（后端一分钟一次）。
        health: healthStatus(),
        model: selection === undefined ? null : `${selection.provider}/${selection.model}`,
        // custom = 设置页手动指定；default = 跟随「设置 → 模型」；null = 没有可用模型。
        modelSource: selection === undefined ? null : (configured === undefined ? 'default' : 'custom'),
        defaultModel: fallback === undefined ? null : `${fallback.provider}/${fallback.model}`,
        semanticReady: selection !== undefined && llm !== undefined && typeof llm.prepareCall === 'function',
        settingsPath: paths.settings,
        patchPath: paths.patch,
        logsDir: paths.logsDir,
        debugLogPath: paths.debugLog,
        semanticLogPath: paths.semanticLog,
        historyLogPath: paths.historyLog,
        imageIndexPath: paths.imageIndex,
        defaults: DEFAULT_CONFIG,
      }
    },
    async judge(messageCtx) {
      runtime.semanticCalls += 1
      try {
        return await judgeWithModel(ctx, suite, messageCtx)
      } catch (error) {
        runtime.semanticFailures += 1
        throw error
      }
    },
  }
  return suite
}

/**
 * 保存前后差了什么：哪些项必须 `/new` 才生效、是否还有别的改动。
 *
 * 只有三项是「建会话那一刻读一次」的：
 *   - 机器人工作区：agent 的 cwd 在创建时定下，旧会话 resume 不重读；
 *   - 额外受管目录：决定哪些 agent 被挂防护，也在创建时判定；
 *   - 禁用的全局工具：走 `agent.ctx.tools.restrict`，同样只在 `agent/created` 挂一次。
 * 其余设置（模式、唤醒词、语义、超时、消息合并、上下文、媒体、斜杠名单、调试）都是每次判断现读。
 *
 * `media.files/bytes` 会随清理变化，不算改动，只比 `maxFiles`。
 */
export function describeSave(before, after) {
  const differs = (a, b) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)
  const needsNewSession = []
  if (differs(before?.guard?.workspace, after?.guard?.workspace)) needsNewSession.push('机器人工作区')
  if (differs(before?.guard?.extras, after?.guard?.extras)) needsNewSession.push('额外受管目录')
  if (differs(before?.guard?.deny, after?.guard?.deny)) needsNewSession.push('禁用的全局工具')

  const others = (state) => JSON.stringify({
    mode: state?.mode,
    botName: state?.botName,
    wakeWords: state?.wakeWords,
    slash: state?.slash?.allowIds,
    image: state?.image,
    reply: state?.reply,
    debug: state?.debug,
    semantic: state?.semantic,
    timeout: state?.timeout,
    merge: state?.merge,
    history: state?.history,
    idle: state?.idle,
    // guard.allow 每次工具调用都现读，属「立即生效」那一组；deny/extras 已在上面按 * 处理。
    guardAllow: state?.guard?.allow,
    mediaMaxFiles: state?.media?.maxFiles,
    promptOverrides: state?.promptOverrides,
  })
  return { needsNewSession, otherChanged: others(before) !== others(after) }
}

/** 保存结果里的提示文案：说清「哪些要 /new」「其余立即生效」，没有改动就直说。 */
export function saveNote(report) {
  const needsNewSession = Array.isArray(report?.needsNewSession) ? report.needsNewSession : []
  const otherChanged = report?.otherChanged === true
  if (needsNewSession.length === 0) {
    return otherChanged ? '已保存，已立即生效：下一条群消息就按新规则判断。' : '已保存，这次没有改动。'
  }
  const names = needsNewSession.join('、')
  return otherChanged
    ? `已保存。${names}要发 /new 重开会话才生效（旧会话保持原样）；其他改动已立即生效。`
    : `已保存。${names}要发 /new 重开会话才生效，旧会话保持原样。`
}

function installRoutes(ctx, suite) {
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection
    if (connection?.fetch?.register === undefined) {
      ctx.logger?.warn?.('[qqbot-suite] connection.fetch unavailable, settings routes skipped')
      return
    }

    connectionCtx.effect(() => connection.fetch.register({
      path: STATE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => json({
        ok: true,
        // promptGroups 只是下拉里的分组顺序与标题；条目本身带 group 字段。
        state: {
          ...suite.snapshot(),
          selfActive: isSelfActive(),
          promptCatalog: PROMPT_CATALOG,
          promptGroups: PROMPT_GROUPS,
        },
      }),
    }), 'qqbot-suite: state route')

    // 判断模型的下拉候选：读 Harness 已配置的 provider/model（`llm.listProviders` +
    // `listModels`）。读不到就返回空列表 + 失败原因，页面据此退回手动填写。
    // 只读目录，不写任何配置。
    connectionCtx.effect(() => connection.fetch.register({
      path: MODELS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const catalog = await listModelCatalog(ctx)
          return json({
            ok: true,
            ...catalog,
            default: (() => {
              const selection = defaultSelection(ctx)
              return selection === undefined ? null : `${selection.provider}/${selection.model}`
            })(),
          })
        } catch (error) {
          return json({
            ok: true,
            models: [],
            failures: [],
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }), 'qqbot-suite: models route')

    connectionCtx.effect(() => connection.fetch.register({
      path: CONFIG_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, error: { code: 'invalid-body', message: '需要一个 JSON 请求体。' } }, 400)
        }
        try {
          const before = suite.snapshot()
          const state = await suite.save(body)
          const report = describeSave(before, state)
          return json({
            ok: true,
            state,
            note: saveNote(report),
            needsNewSession: report.needsNewSession,
          })
        } catch (error) {
          // 越界是「输入有问题」，不是服务端故障：400 + 明确文案，页面直接显示让他重填。
          const outOfRange = error?.code === 'OUT_OF_RANGE'
          return json({
            ok: false,
            error: {
              code: outOfRange ? 'out-of-range' : 'write-failed',
              message: error instanceof Error ? error.message : String(error),
            },
          }, outOfRange ? 400 : 500)
        }
      },
    }), 'qqbot-suite: config route')

    // 设置页「机器人名字 → 自动获取」：self 子插件（插件页面启停）处于启用状态
    // 才允许读凭据调 /users/@me，只返回名字——不下载头像、不写任何配置。
    // 插件停用时按钮根本不出现在页面上，接口在这里再拦一道，
    // 保证凭据读取永远发生在插件启用之后。
    connectionCtx.effect(() => connection.fetch.register({
      path: BOT_NAME_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        if (!isSelfActive()) {
          return json({
            ok: false,
            error: {
              code: 'profile-disabled',
              message: 'qqbot-suite-self 插件未启用：到「插件」页面启用它（qqbot_bot_profile 工具），再回到这里点「自动获取」。',
            },
          }, 400)
        }
        try {
          const profile = await getBotProfile({ suite })
          return json({ ok: true, name: profile.name })
        } catch (error) {
          return json({
            ok: false,
            error: {
              code: 'fetch-failed',
              message: error instanceof Error ? error.message : String(error),
            },
          }, 500)
        }
      },
    }), 'qqbot-suite: bot-name route')

    // 群健康刷新：只读 `bot_state` / `info` 两个官方接口，不写任何东西。
    // 节流在 suite.refreshHealth 里做（接口自己防，不靠按钮）。
    connectionCtx.effect(() => connection.fetch.register({
      path: HEALTH_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const result = await suite.refreshHealth()
        if (result.throttled === true) {
          return json({
            ok: false,
            retryAfterMs: result.retryAfterMs,
            health: result.health,
            error: {
              code: 'too-frequent',
              message: `刷新太快了，${Math.ceil(result.retryAfterMs / 1000)} 秒后再试`,
            },
          }, 429)
        }
        return json({ ok: true, health: result.health })
      },
    }), 'qqbot-suite: health route')

    // 语义调试：把最近一次真实判断原样重发一次，保留 thinking。
    // 只返回结果，不落日志、不动计数、不影响真实判定。
    connectionCtx.effect(() => connection.fetch.register({
      path: REPLAY_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {}
        try {
          body = await request.json()
        } catch {
          body = {}
        }
        try {
          const replay = await suite.replay({
            index: Number.isFinite(body?.index) ? body.index : 0,
            effort: body?.effort,
            // 聊天记录里点「重放」时带行 id；不带就走「最近一次判断」。
            id: typeof body?.id === 'string' && body.id !== '' ? body.id : undefined,
          })
          return json({ ok: true, replay })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (error?.code === 'REPLAY_BUSY') {
            return json({ ok: false, error: { code: 'replay-busy', message } }, 409)
          }
          // 没有可重放记录 / 没有模型：属于使用条件不满足，不算服务端故障。
          const unusable = /还没有可重放|已经不在聊天记录|没有可用|LLM 服务不可用/.test(message)
          return json({
            ok: false,
            error: { code: unusable ? 'replay-unavailable' : 'replay-failed', message },
          }, unusable ? 400 : 500)
        }
      },
    }), 'qqbot-suite: replay route')

    // 人工标注「该回 / 不回」：把那条判断（含当时的 system + prompt）落盘成样本。
    // 只写样本文件，不影响判定、不写日志。
    connectionCtx.effect(() => connection.fetch.register({
      path: MARK_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          body = {}
        }
        try {
          return json({
            ok: true,
            ...suite.markJudge(body?.id, body?.marked !== false, body?.label),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const unusable = error?.code === 'JUDGE_GONE' || error?.code === 'JUDGE_INVALID'
          return json({
            ok: false,
            error: { code: unusable ? 'mark-unavailable' : 'mark-failed', message },
          }, unusable ? 400 : 500)
        }
      },
    }), 'qqbot-suite: mark route')
  })
}

/**
 * 媒体缓存数量兜底：启动时清一次，之后每分钟清一次。
 * 官方插件的 TTL 清理是每小时一次、只按时间；这里按数量补一道，
 * 用 `ctx.effect` 挂定时器，插件卸载时自动停。
 */
function startMediaPruner(ctx, suite) {
  const run = () => {
    try {
      suite.pruneMedia()
    } catch {
      // 清理失败不影响消息处理，下一轮再试
    }
  }
  run()
  try {
    ctx.effect(() => {
      const timer = setInterval(run, MEDIA_PRUNE_INTERVAL_MS)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'qqbot-suite: media prune')
  } catch (error) {
    ctx.logger?.warn?.(`[qqbot-suite] media prune timer failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 套件入口：提供 qqbotSuite 服务，子插件通过 inject 取。 */
export function apply(ctx, config = {}) {
  const suite = createSuite(ctx, config)
  try {
    ctx.provide('qqbotSuite', suite)
  } catch (error) {
    ctx.logger?.warn?.(`[qqbot-suite] provide failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  // 图片走两条路（见 config.js: IMAGE_MODES）：placeholder / agent。
  installRoutes(ctx, suite)
  startMediaPruner(ctx, suite)
  watchMediaRefs(ctx, suite)
  watchColdStartPrompt(ctx, suite)
  ctx.logger?.info?.(`[qqbot-suite] settings: ${suite.paths.settings}`)
  // 启动时把「这一轮到底带了什么配置」记一条：重载后配置没换是常见坑
  // （模块重跑了但服务实例还是旧的），有这条一眼能看出来。
  suite.logDebug?.({
    reason: 'suite-ready',
    allow: true,
    imageMode: suite.current()?.image?.mode,
    settings: suite.paths.settings,
  })
}

// 测试专用导出：只在设置了 QQBOT_SUITE_DEV=1 的进程里注入（`node dev/tests/run.mjs`），
// 正常运行（dsh 加载本包）时是 undefined。
export const __test = process.env.QQBOT_SUITE_DEV === '1'
  ? {
  createSuite,
  describeSave,
  saveNote,
  judgeWithModel,
  pruneMediaDir,
  mediaSummary,
  pickJudge,
  parseVerdict,
  replayJudge,
  buildJudgePrompt,
  buildJudgeSystem,
  renderJudgeInput,
  reasoningLanguage,
  gapText,
  parseModelRef,
  listModelCatalog,
  findJudgeFor,
  // 媒体引用追踪（数量清理的 pin）
  mediaRefsFromBody,
  rememberMediaRefs,
  releaseMediaRefs,
  pinnedMediaNames,
  resetMediaRefs,
  // 冷场那一轮的系统提示词例外（接线本身也测：没标记时原样返回）
  watchColdStartPrompt,
  // 宿主 LLM 调用：官方 BlockAssembler 收流 + createUserMessage 造消息
  collectStream,
  userMessageOf,
  newAssembler,
  fillCollected,
  setHostLlm,
  }
  : undefined
