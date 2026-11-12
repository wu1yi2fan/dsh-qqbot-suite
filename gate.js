/**
 * qqbot-suite/gate — 群聊消息闸门。
 *
 * 给 QQBot.prototype.emit 加一层判断：中间件链照常跑完（访问控制、去重、
 * 群历史、斜杠命令、附件下载都还在），只在「要不要把这条交给 agent」时拦一下。
 * 另外在 handleInboundMessage（中间件链之前）按白名单去掉别人消息行首的 `/`，
 * 让斜杠命令只对指定的人生效。
 *
 * 模式（由套件设置页切换）：
 *   - keywords：@、引用机器人、叫名字/唤醒词、斜杠命令才放行；
 *   - semantic：上述都没命中时，让模型结合群聊上下文判断这句是不是在跟机器人说；
 *   - all：群里每条消息都放行（不推荐）。
 *
 * 拿不准时 keywords 模式静默丢弃；semantic 模式在模型失败时也静默丢弃，
 * 避免机器人突然在群里刷屏。
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_CONFIG, IMAGE_MODES, REPLY_FORMATS, dshHomeOf } from './config.js'
import { HistoryRing, botEntry, entryFromMessage, toSdkEntries } from './history.js'
import {
  imageLabel,
  imagePlaceholder,
  isImageAttachment,
} from './images.js'
// 历史图片召回：索引写入 + 正文注入。为什么单独一个文件、为什么按磁盘快照对账，
// 见 images-recall.js 顶部；这里只负责在正确的时机调它。
import { appendRows, messageImageBlock, readIndex, recallBlockFor, rowsOfMessage } from './images-recall.js'
// 冷场处理：判定/状态/正文拼装都在 idle.js（纯逻辑，能单独测），这里只负责
// 「什么时候扫、扫到之后怎么把话送进 agent」。
import {
  COLD_START_PROMPT,
  COLD_START_SECTION_NAME,
  IdleTracker,
  chatBody,
  clearColdStart,
  coldStartAssembly,
  decideIdle,
  historyBlockFor,
  isColdStart,
  isIdleSilence,
  isNonReply,
  markColdStart,
  missedBody,
} from './idle.js'
// 造官方 user 消息（和套件本体共用 host.js 的锚点解析，不各写一份）。
import { setHostLlm, userMessageOf } from './host.js'

export const name = 'qqbot-suite-gate'
export const inject = ['qqbotSuite']

const RECENT_LIMIT = 12
const RECENT_TTL_MS = 30 * 60_000
const GLOBAL_KEY = Symbol.for('dsh.qqbotSuiteGate')
const ORIGINALS_KEY = Symbol.for('dsh.qqbotSuiteGateOriginals')

function createState() {
  return {
    recent: new Map(),
    names: new Set(),
    mode: 'keywords',
    /** 图片处置模式：ignore / placeholder / agent（见 config.js: IMAGE_MODES） */
    imageMode: 'placeholder',
    /** 历史图片召回（gapMinutes 判分批 / maxImages 单轮上限），只在 agent 模式生效 */
    imageRecall: { ...DEFAULT_CONFIG.image.recall },
    /** 媒体上限，同时也是索引条数上限（见 images-recall.js） */
    mediaMaxFiles: DEFAULT_CONFIG.media.maxFiles,
    debug: false,
    semantic: { ...DEFAULT_CONFIG.semantic },
    timeout: { ...DEFAULT_CONFIG.timeout },
    /** 出站回复用哪种消息类型（见 config.js: REPLY_FORMATS 与下面的 wantsMarkdown） */
    replyFormat: DEFAULT_CONFIG.reply.format,
    /** 多条消息合并（见「多条消息合并」那一段）：默认关，开了才在入站层攒消息 */
    merge: { ...DEFAULT_CONFIG.merge },
    /** 群 openid → 待合并队列（每队一个 FIFO，队头开窗口） */
    mergeQueue: new Map(),
    /** 群聊上下文配置（见 history.js 顶部：为什么不用官方 historyBuffer） */
    historyConfig: { ...DEFAULT_CONFIG.history },
    /** 每群最近 200 条群消息的环（含被闸门拦下的） */
    historyRing: new HistoryRing(),
    /** 允许原样使用 `/xxx` 的发送者 ID（空 = 不启用，所有人照旧） */
    slashAllow: new Set(),
    /** 群 openid → 正在计时的消息（放行后到首条回复/idle 之间） */
    watch: new Map(),
    /** 冷场配置（见 idle.js） */
    idle: { ...DEFAULT_CONFIG.idle },
    /** 每群的冷场状态：待补回的消息、日计数、冷却、等回应 */
    idleTracker: new IdleTracker(),
    /** 本次进程的启动时间：早于它的群消息只来自落盘回填，不拿来做主动发言 */
    startedAt: Date.now(),
    /** dsh-qqbot 的 SessionManager（见 installSessionCapture：patch getOrCreate 捕获） */
    sessionManager: null,
    /** 正在触发主动发言的群：30 秒扫一轮，别让同一群排队撞两次 */
    idleBusy: new Set(),
    /**
     * 群 openid → `原因:消息key`：同一条待补回的消息、同样的跳过原因只记一次日志。
     * 30 秒扫一轮，拿不到 manager 时会一直跳过，不去重的话日志每半分钟长一行。
     */
    idleSkipLogged: new Map(),
    botName: '',
    wakeWords: [],
    suite: undefined,
    judge: undefined,
    /** QQBot 实例（emit 里顺手记住）：设置页「群健康」借它的 client 发只读请求 */
    bot: null,
  }
}

/**
 * 重载时把上一份 state 里「攒出来的东西」接过来。
 *
 * Node 重新 import 这个模块会得到新的模块作用域，而顶层那句
 * `globalThis[GLOBAL_KEY] = state` 会把旧 state 直接顶掉（`apply()` 里那段
 * 「previous !== state 就继承」因此永远不成立）。所以继承必须发生在覆盖**之前**：
 * 环（每群 200 条）和 `recent`（机器人最近发言，引用匹配和判断提示词都要用）
 * 都只活在内存里，丢掉就等于「一重载就失忆」。
 */
export function adoptState(previous) {
  const next = createState()
  if (previous === null || typeof previous !== 'object') return next
  const ring = previous.historyRing
  if (ring !== null && typeof ring === 'object' && typeof ring.push === 'function' && typeof ring.list === 'function') {
    next.historyRing = ring
  }
  if (previous.recent instanceof Map) next.recent = previous.recent
  // 冷场状态跟着走：日计数、冷却、待补回的那条都只活在内存里，重载一次就清零
  // 等于「可以再主动说几句」，最坏情况在一天里多点重载会多插话。
  //
  // 判据用鸭子类型，**不能用 `instanceof IdleTracker`**：重载后 `IdleTracker` 已经是
  // 新模块作用域的类，旧实例是旧类的实例，`instanceof` 恒为 false——状态照样丢，
  // 而且丢得毫无提示（表现为重载后立刻又主动说一句，像冷却没生效）。
  const tracker = previous.idleTracker
  if (tracker !== null && typeof tracker === 'object'
    && typeof tracker.stateOf === 'function' && typeof tracker.noteFired === 'function') {
    next.idleTracker = tracker
  }
  // 启动时间也继承：它是「本次进程」的视角，不是「这个模块实例」的。
  if (Number.isFinite(previous.startedAt)) next.startedAt = previous.startedAt
  // 已经捕获到的会话管理器同样继承，重载后不必等群里来下一条消息。
  if (previous.sessionManager !== null && typeof previous.sessionManager === 'object') {
    next.sessionManager = previous.sessionManager
  }
  // 机器人实例也接过来：它属于进程，不属于某个模块实例。
  if (previous.bot !== null && typeof previous.bot === 'object') next.bot = previous.bot
  // 合并队列也接过来：窗口里那 0.x 秒的消息是真人刚打的，重载丢掉就是直接吞消息。
  // 队列里的计时器还指着上一份模块的投递闭包，而它调的 originalHandle 就是未经包装的
  // 官方实现，所以重载后照样能把这几条放出去。
  if (previous.mergeQueue instanceof Map) next.mergeQueue = previous.mergeQueue
  // 跳过日志的去重表同样接过来：重载不算「情况变了」，没必要把同一句再记一遍。
  if (previous.idleSkipLogged instanceof Map) next.idleSkipLogged = previous.idleSkipLogged
  return next
}

const state = adoptState(globalThis[GLOBAL_KEY])
globalThis[GLOBAL_KEY] = state

function active() {
  return globalThis[GLOBAL_KEY] ?? state
}

function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 归一化文本：去 markdown 符号、压空白、转小写，用于引用内容比对。 */
function norm(input) {
  return String(input ?? '')
    .replace(/[*_`~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 记一个名字；机器人自动名字额外去掉 bot / 机器人 / 助手后缀。 */
function addName(target, value, stripSuffix = false) {
  if (typeof value !== 'string') return
  const raw = value.trim()
  if (raw === '') return
  target.add(raw.toLowerCase())
  if (stripSuffix) {
    const short = raw.replace(/(bot|机器人|助手)$/i, '').trim()
    if (short.length >= 2) target.add(short.toLowerCase())
  }
}

function rebuildNames(target) {
  const names = new Set()
  // 手填的机器人名字按全名匹配，并顺带认不带后缀的短称（xxxBot → xxx）。
  if (target.botName !== '') addName(names, target.botName, true)
  for (const word of target.wakeWords) addName(names, word, false)
  target.names = names
}

function applyConfig(target, config) {
  target.mode = config?.mode ?? 'keywords'
  // 图片相关只认 `config.image` 一处；旧字段的迁移在 config.js: normalizeConfig 里做完。
  target.imageMode = IMAGE_MODES.includes(config?.image?.mode) ? config.image.mode : 'placeholder'
  const recall = config?.image?.recall !== null && typeof config?.image?.recall === 'object'
    ? config.image.recall
    : {}
  target.imageRecall = { ...DEFAULT_CONFIG.image.recall, ...recall }
  target.mediaMaxFiles = Number.isFinite(Number(config?.media?.maxFiles))
    ? Number(config.media.maxFiles)
    : DEFAULT_CONFIG.media.maxFiles
  target.debug = config?.debug === true
  target.botName = typeof config?.botName === 'string' ? config.botName.trim() : ''
  target.wakeWords = Array.isArray(config?.wakeWords) ? [...config.wakeWords] : []
  target.semantic = config?.semantic ?? target.semantic
  target.timeout = config?.timeout ?? target.timeout
  // 出站格式：只认三档之一，非法值退回 auto（纯文本优先的那档）。
  target.replyFormat = REPLY_FORMATS.includes(config?.reply?.format)
    ? config.reply.format
    : DEFAULT_CONFIG.reply.format
  target.merge = config?.merge !== null && typeof config?.merge === 'object'
    ? config.merge
    : { ...DEFAULT_CONFIG.merge }
  target.idle = config?.idle !== null && typeof config?.idle === 'object'
    ? { ...DEFAULT_CONFIG.idle, ...config.idle }
    : { ...DEFAULT_CONFIG.idle }
  // 关掉冷场时把每群状态一起清掉：日计数、冷却、待补回的消息都不该跨配置残留，
  // 否则「关了再开」会继承上次的计数，看起来像少了次数。
  if (target.idle.enabled !== true) target.idleTracker.reset()
  // 关掉合并时把窗口里还在等的那几条立刻放出去：配置是「现读」的，吞掉就没人知道少了什么。
  if (mergeConfig(target).enabled !== true) flushAllMerges(target)
  target.historyConfig = config?.history ?? { ...DEFAULT_CONFIG.history }
  target.slashAllow = new Set(
    Array.isArray(config?.slash?.allowIds) ? config.slash.allowIds.map((id) => String(id)) : [],
  )
  // 关掉超时中断时，把还在计时的消息一起撤掉，避免旧计时器到点后继续发提示。
  if (timeoutConfig(target).enabled !== true) clearAllWatches(target)
  rebuildNames(target)
}

// ── 群聊处理超时（看门狗） ──────────────────────────────────────────────
//
// 一条群消息放行后开始计时，下面任一情况停表：
//   - 机器人往这个群发出第一条消息（用户已经拿到东西了）；
//   - 该群的 agent 回到 idle（这一轮跑完了，哪怕没说话）。
// 到点还没停表：cancel 掉这一轮（同时清空该群排队消息），再回一句提示。
//
// gate 在 emit 这一层只拿得到群 openid，拿不到 agent，所以用
// `agent/inbox/inserted` 把两者对上：im-qqbot 交给 agent 的正文里带
// `[昵称 (senderId)]`，拿 senderId + 正文前缀和放行时登记的消息配对。
// 不用「群 openid 算 SHA-256 得 sessionId」那种做法——/new 或换模型重建
// 会话后 id 会变，那种匹配会静默失效。

/** 读取并补全超时配置。 */
function timeoutConfig(target) {
  const value = target.timeout
  const fallback = DEFAULT_CONFIG.timeout
  if (value === null || typeof value !== 'object') {
    return { enabled: fallback.enabled, ms: fallback.ms, message: fallback.message }
  }
  return {
    enabled: value.enabled !== false,
    ms: Number.isFinite(value.ms) && value.ms > 0 ? value.ms : fallback.ms,
    message: typeof value.message === 'string' && value.message.trim() !== ''
      ? value.message.trim()
      : fallback.message,
  }
}

/** 把 `{seconds}` 换成这次实际等待的秒数。 */
function timeoutText(target, ms) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return timeoutConfig(target).message.replace(/\{seconds\}/g, String(seconds)).slice(0, 600)
}

/** 停表：返回被撤掉的计时项。 */
function clearWatch(target, groupId) {
  const entry = target.watch.get(groupId)
  if (entry === undefined) return undefined
  target.watch.delete(groupId)
  if (entry.timer !== null && entry.timer !== undefined) clearTimeout(entry.timer)
  entry.timer = null
  return entry
}

function clearAllWatches(target) {
  for (const groupId of [...target.watch.keys()]) clearWatch(target, groupId)
}

/**
 * 放行一条群消息时登记计时。同一个群又来一条时重置计时（新一轮马上开始），
 * 并沿用上一次已经配上的 agent，避免短暂空窗期里找不到 agent。
 */
function startWatch(target, ctx) {
  const config = timeoutConfig(target)
  if (config.enabled !== true) return undefined
  const msg = ctx?.message
  if (msg === undefined || msg.kind !== 'group' || msg.senderIsBot === true) return undefined
  const groupId = typeof msg.groupOpenid === 'string' ? msg.groupOpenid : ''
  if (groupId === '') return undefined

  const previous = clearWatch(target, groupId)
  const entry = {
    groupId,
    at: Date.now(),
    ms: config.ms,
    senderId: typeof msg.senderId === 'string' ? msg.senderId : '',
    text: truncate(msg.content ?? '', 120),
    replyTarget: ctx?.replyTarget ?? { scope: 'group', targetId: groupId, msgId: msg.messageId },
    bot: ctx?.bot,
    agent: previous?.agent ?? null,
    timer: null,
  }
  entry.timer = setTimeout(() => expireWatch(target, groupId, entry), config.ms)
  entry.timer?.unref?.()
  target.watch.set(groupId, entry)
  return entry
}

/** 到点：agent 还在跑就中断 + 回提示；已经 idle / 没配上 agent 就只记日志。 */
function expireWatch(target, groupId, entry) {
  if (target.watch.get(groupId) !== entry) return
  target.watch.delete(groupId)
  entry.timer = null

  const agent = entry.agent
  if (agent === null || agent === undefined) {
    logTimeout(target, entry, 'timeout-unbound', false)
    return
  }
  if (agent.status !== 'running') {
    logTimeout(target, entry, 'timeout-idle', false)
    return
  }

  let cancelled = false
  try {
    // 默认行为会把该群排队等着的消息一起清掉，避免中断后立刻又跑下一条。
    agent.cancel({ kind: 'user' })
    cancelled = true
  } catch {
    cancelled = false
  }
  const text = timeoutText(target, entry.ms)
  void sendWatchHint(entry, text)
  logTimeout(target, entry, 'timeout-interrupt', cancelled, text)
}

/** 往群里回超时提示；发送失败不影响中断本身。 */
async function sendWatchHint(entry, text) {
  const bot = entry.bot
  if (bot === null || bot === undefined) return
  try {
    if (typeof bot.sendMarkdown === 'function') await bot.sendMarkdown(entry.replyTarget, text)
    else if (typeof bot.sendText === 'function') await bot.sendText(entry.replyTarget, text)
  } catch {
    // 提示发不出去不影响本轮已被取消
  }
}

/** 超时相关只写调试日志，不占用设置页「最近一次判断」。 */
function logTimeout(target, entry, reason, cancelled, text = '') {
  target.suite?.logDebug?.({
    reason,
    allow: true,
    mode: target.mode,
    group: truncate(entry.groupId, 32),
    sender: truncate(entry.senderId, 48),
    text: entry.text,
    waitedMs: Date.now() - entry.at,
    ...(cancelled === true ? { cancelled: true } : {}),
    ...(text === '' ? {} : { reply: truncate(text, 140) }),
  })
}

/** 从 UserMessage 里拼出纯文本，用来和登记的消息正文比对。 */
function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) {
    return typeof blocks === 'string' ? blocks : ''
  }
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * `agent/inbox/inserted`：一条入站消息刚进某个 agent 的 inbox。
 * 用正文里的 `(senderId)` + 正文前缀把「群」和「agent」配对。
 */
function bindWatchAgent(target, payload) {
  const agent = payload?.agent
  if (agent === null || typeof agent !== 'object') return
  const body = messageText(payload?.message)
  if (body === '') return
  const flatBody = body.replace(/\s+/g, '')
  const now = Date.now()
  let picked = null
  for (const entry of target.watch.values()) {
    if (entry.senderId === '') continue
    if (now - entry.at > Math.max(entry.ms * 3, 60_000)) continue
    if (!flatBody.includes(`(${entry.senderId.replace(/\s+/g, '')})`)) continue
    const flatText = entry.text.replace(/…$/, '').replace(/\s+/g, '')
    if (flatText !== '' && !flatBody.includes(flatText)) continue
    if (picked === null || entry.at > picked.at) picked = entry
  }
  if (picked === null) return
  picked.agent = agent
}

/** `agent/status`：这一轮跑完就停表，静默结束的轮次不会被误判成超时。 */
function noteAgentStatus(target, payload) {
  if (payload?.status !== 'idle') return
  const agent = payload?.agent
  if (agent === null || typeof agent !== 'object') return
  // 冷场那一轮的「先看图」例外只该管那一轮：跑完立刻摘掉，别影响后面的正常回复。
  clearColdStart(agent)
  for (const [groupId, entry] of [...target.watch]) {
    if (entry.agent === agent) clearWatch(target, groupId)
  }
}

/** 机器人往某个群发了消息：用户已经拿到回复，停表。 */
function noteGroupReply(target, scope, targetId) {
  if (scope !== 'group' || typeof targetId !== 'string' || targetId === '') return
  clearWatch(target, targetId)
}

// ── 群聊上下文 ────────────────────────────────────────────────────────
//
// 官方的 historyBuffer 回答完一条就清空、且只在真 @ 时才注入（见 history.js
// 顶部的三条理由），所以这里自己记账：每条群消息进环，注入时按窗口裁剪。
//
// 注入分两条路，是为了不破坏正文里的标记：
//   - 真 @：把窗口塞进 `ctx.state.history`，由官方 `buildAgentBody()` 渲染成
//     `[Chat history begins] … [Current message]`，`(@you)` 还留在当前这句上；
//   - 其余（唤醒词 / 语义放行 / 引用）：官方不拼，我们自己把记录块追加到正文末尾。
//     放末尾不会破坏 `[昵称 (openid)]` 前缀——guard 认群聊、看门狗配对都靠它。

/**
 * 记住一条群消息（含被闸门拦下的），供之后的注入使用。
 * @returns `{ groupId, entry }`，没记住（私聊 / bot 回声 / 重复投递）返回 null。
 */
function rememberGroupMessage(target, ctx, answered) {
  const msg = ctx?.message
  if (msg === null || typeof msg !== 'object' || msg.kind !== 'group') return null
  if (msg.senderIsBot === true) return null
  const groupId = typeof msg.groupOpenid === 'string' ? msg.groupOpenid : ''
  if (groupId === '') return null
  const entry = entryFromMessage(msg)
  if (entry === null) return null
  entry.answered = answered === true
  if (target.historyRing.push(groupId, entry) !== true) return null
  return { groupId, entry }
}

/**
 * 把这条消息里的图片记进索引。**被闸门拦下的也要记** —— 那正是要召回的那些。
 *
 * 只写有本地文件的图（`rowsOfMessage` 里过滤 `localPath` 为空的行）；
 * 条数由 `media.maxFiles` 收口：本地只留那么多图，索引也就只留那么多行。
 */
function rememberImageIndex(target, ctx) {
  if (target.imageMode !== 'agent') return
  const msg = ctx?.message
  if (msg === null || typeof msg !== 'object' || msg.kind !== 'group' || msg.senderIsBot === true) return
  const file = target.suite?.paths?.imageIndex ?? ''
  if (file === '') return
  const rows = rowsOfMessage(msg, ctx?.state?.downloadedFiles)
  if (rows.length === 0) {
    // agent 模式下图片还留在 attachments 里：有附件却没抽出路径，说明没拿到下载结果。
    // 这条日志是排查「功能装了但一直不生效」的唯一线索，别删。
    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      target.suite?.logDebug?.({
        reason: 'image-index-empty',
        allow: true,
        group: truncate(msg.groupOpenid ?? '', 32),
        attachments: msg.attachments.length,
      })
    }
    return
  }
  appendRows(file, rows, target.mediaMaxFiles)
}

/**
 * 「这一次到底交给了 agent 哪些图」的唯一观测点（2026-11-09 加）。
 *
 * 用户报障原话：「发送图片以后我不知道 agent 到底有没有读图」。之前整条链路上
 * 一行日志都没有，只能靠猜。这里只记**事实**（张数 + 本地路径），不做判断；
 * 「读没读」由 `guard.js` 的 `image-read` 那行回答，两行配对看就清楚了：
 *   - 有 `image-handoff` 没有 `image-read` → 图给了但没读（多半是判词/正文没让它觉得该读）；
 *   - 两个都没有 → 图根本没到它手上（模式不对、下载失败、索引被 prune 清了）。
 */
function logImageHandoff(target, from, groupId, messageId, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return
  target.suite?.logDebug?.({
    reason: 'image-handoff',
    allow: true,
    from,
    group: truncate(groupId ?? '', 32),
    messageId: truncate(messageId ?? '', 48),
    count: paths.length,
    paths: paths.slice(0, 6),
  })
}

/** 从注入块里数出 `Image: <路径>` 行（渲染格式由 images-recall.js 固定）。 */
function imagePathsOfBlock(block) {
  return String(block ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('Image: '))
    .map((line) => line.slice('Image: '.length).trim())
    .filter((path) => path !== '')
}

/**
 * 把历史图片路径补到正文末尾。
 *
 * 时机和 `applyImageText()` 一模一样：必须在 `startWatch()` 之后（看门狗按正文子串配对，
 * 后缀不影响匹配）、必须在 `shouldAnswer()` 之后（闸门判断读的是原文），并且**不改前缀**
 * （`guard.isGroupBody()` 靠 `[昵称 (openid)]` 认群聊会话）。
 *
 * 注意块里的 `Image: <路径>` 前缀不能改：`index.js: mediaRefsFromBody()` 只认这几种前缀，
 * 改了这些图就不受 pin 保护，可能在 agent 读之前被 prune 清掉。
 */
function applyRecallBlock(target, ctx) {
  if (target.imageMode !== 'agent') return
  const msg = ctx?.message
  if (msg === null || typeof msg !== 'object' || msg.kind !== 'group') return
  const file = target.suite?.paths?.imageIndex ?? ''
  if (file === '') return
  const block = recallBlockFor(file, {
    groupId: msg.groupOpenid,
    // 当前这条消息自己的图走官方正文里的 `Image: <路径>`，别再列一遍。
    excludeMessageId: msg.messageId,
    gapMinutes: target.imageRecall?.gapMinutes,
    maxImages: target.imageRecall?.maxImages,
  })
  if (block === '') return
  // 块标题和尾注也在设置页「提示词改写」里，覆盖后再拼。`Image: ` 行不受影响，
  // 前缀照旧，`mediaRefsFromBody()` 的 pin 逻辑不依赖这两句。
  const text = typeof target.suite?.copy === 'function' ? target.suite.copy(block) : block
  const content = typeof msg.content === 'string' ? msg.content : ''
  if (content.includes(text)) return
  msg.content = content.trim() === '' ? text : `${content.trimEnd()}\n\n${text}`
  logImageHandoff(target, 'recall', msg.groupOpenid, '', imagePathsOfBlock(text))
}

/**
 * 把「同一批里被让位的引用」补到正文末尾（内容由 `composeMergeBatch()` 挂上来）。
 *
 * 位置和 `applyRecallBlock()` 一样，必须在 `startWatch()` 和记环之后：
 * 看门狗按正文子串配对，前缀不能动；历史环只该记用户真说过的话。
 * 也只有 emit 层能改——`ctx.message.content` 才是真正交给 agent 的那份正文。
 */
function applyDroppedQuotes(msg) {
  if (msg === null || typeof msg !== 'object') return
  const block = typeof msg.suiteDroppedQuotes === 'string' ? msg.suiteDroppedQuotes.trim() : ''
  if (block === '') return
  const content = typeof msg.content === 'string' ? msg.content : ''
  if (content.includes(block)) return
  msg.content = content.trim() === '' ? block : `${content.trimEnd()}\n\n${block}`
}

/**
 * 当前这条消息自带的图（官方正文里的 `Image: <路径>` 行）——只记日志，不动正文。
 *
 * 官方 `attachmentProcessor` 在更上游就把路径写进正文了，这里再改一次只会打架；
 * 记一行的唯一目的就是让「给了图」这件事在日志里可见。
 */
function logCurrentImages(target, ctx) {
  if (target.imageMode !== 'agent') return
  const msg = ctx?.message
  if (msg === null || typeof msg !== 'object' || msg.kind !== 'group') return
  const paths = collectImages(msg, ctx?.state?.downloadedFiles)
    .map((image) => (typeof image?.localPath === 'string' ? image.localPath : ''))
    .filter((path) => path !== '')
  logImageHandoff(target, 'current', msg.groupOpenid, msg.messageId, paths)
}

/** 取出「当前消息之前」的窗口（不含当前这一条）。 */
function historyWindowOf(target, msg) {
  const cfg = target.historyConfig ?? DEFAULT_CONFIG.history
  if (cfg.window <= 0) return []
  const groupId = typeof msg?.groupOpenid === 'string' ? msg.groupOpenid : ''
  if (groupId === '') return []
  const currentId = typeof msg.messageId === 'string' ? msg.messageId : ''
  return target.historyRing
    .list(groupId)
    .filter((entry) => currentId === '' || entry.id !== currentId)
}

/** 判断之前先把窗口摆好：闸门的语义判断读的就是 `ctx.state.history`。 */
function primeGroupHistory(target, ctx) {
  const msg = ctx?.message
  if (msg === null || typeof msg !== 'object' || msg.kind !== 'group') return
  const entries = historyWindowOf(target, msg)
  if (entries.length === 0) return
  const cfg = target.historyConfig ?? DEFAULT_CONFIG.history
  // 判定输入里不要 ✓：那是给 agent 看的标记，塞进判断提示词只会干扰措辞。
  const sdk = toSdkEntries(entries, { ...cfg, markAnswered: false })
  if (sdk.length === 0) return
  if (ctx.state === null || typeof ctx.state !== 'object') ctx.state = {}
  ctx.state.history = sdk
}

/**
 * 放行之后：把群聊窗口交给官方 `buildAgentBody()` 渲染。
 *
 * 以前非 @ 的消息是自己拼一段记录块**追加到 `msg.content` 末尾**，于是正文有
 * 两种形状（@ 是 `[Chat history begins]…[Current message]`，非 @ 是「正文 +
 * 末尾记录块」），`guard.isGroupBody()`、看门狗配对、语义判断都得各认一套。
 * 现在统一成一条路：把窗口写进 `ctx.state.history`，再把 `wasMentioned` 置真，
 * 让官方渲染器拼出同样的 `[Chat history begins]…[Current message]`；正文一个字
 * 不改（`(@you)` 由官方补，它确实是在跟机器人说话）。
 *
 * 注：这只影响「要不要拼历史」的渲染分支，不放行任何原本被拦住的消息。
 */
function injectGroupHistory(target, ctx) {
  const msg = ctx?.message
  if (msg === null || typeof msg !== 'object' || msg.kind !== 'group') return
  if (msg.senderIsBot === true) return
  // 官方会在 wasMentioned 时自己拼，别拼两份。
  if (ctx.state?.mention?.wasMentioned === true) return
  if (msg.historyInjected === true) return
  const entries = historyWindowOf(target, msg)
  if (entries.length === 0) return
  const cfg = target.historyConfig ?? DEFAULT_CONFIG.history
  const sdk = toSdkEntries(entries, cfg)
  if (sdk.length === 0) return
  if (ctx.state === null || typeof ctx.state !== 'object') ctx.state = {}
  ctx.state.history = sdk
  // 官方 buildAgentBody() 的开关是 wasMentioned：置真才会拼历史、才补 `(@you)`。
  ctx.state.mention = { ...(ctx.state.mention ?? {}), wasMentioned: true }
  msg.historyInjected = true
}

/** 机器人自己的发言也算上下文（否则「它刚说过什么」是空白）。 */
function rememberBotText(target, scope, targetId, text) {
  if (scope !== 'group' || typeof targetId !== 'string' || targetId === '') return
  // 名字来自设置页手填的 botName（不自动读取，见 README「注意事项」）；没填就只标 (bot)。
  const entry = botEntry(text, target.botName)
  if (entry === null) return
  target.historyRing.push(targetId, entry)
}

/** 历史落盘路径跟着配置走；`persist` 关掉时清空路径（内存照常记账）。 */
function syncHistoryFile(target, suite) {
  const cfg = target.historyConfig ?? DEFAULT_CONFIG.history
  const file = cfg.persist === true ? (suite?.paths?.historyLog ?? '') : ''
  if (target.historyRing.file === file) return 0
  target.historyRing.file = file
  return file === '' ? 0 : target.historyRing.restore()
}

// ── 斜杠命令白名单 ────────────────────────────────────────────────────
//
// SDK 的 slash-command 中间件在闸门之前跑：群里任何人 @ 一下机器人再发
// `/new`、`/model`，命令就已经执行了，闸门拦不到。所以在 handleInboundMessage
// 这一层（中间件链之前、ctx 还没建）先看发送者：
//   - 名单里的 ID：原样放行，命令照常执行；
//   - 其他人：去掉行首的 `/`，让它变成普通文字——既不会命中中间件里的命令，
//     也不会被闸门当成「斜杠命令」直接放行。
//
// 只动行首的 `/`（`<@!xxx>` 标记之后的也算行首）：正文中间的 `/`（URL、路径、
// a/b）保持原样，避免把正常聊天改坏。名单为空 = 不启用。

const LEADING_MENTION = /^\s*(?:<@!?[^>]*>\s*)*/
const LEADING_SLASHES = /^\/+/

/** 拆出「行首的连续 /」；不以 / 开头返回 null。 */
function splitLeadingSlash(content) {
  const text = typeof content === 'string' ? content : ''
  if (text === '') return null
  const mention = LEADING_MENTION.exec(text)
  const head = mention === null ? '' : mention[0]
  const rest = text.slice(head.length)
  if (!rest.startsWith('/')) return null
  return { head, body: rest.replace(LEADING_SLASHES, '') }
}

/**
 * 按白名单决定这条消息要不要去掉行首的 `/`。
 * 不需要改动时返回原对象；改动时返回一份 content 改过的浅拷贝。
 */
function filterSlashMessage(target, message) {
  if (message === null || typeof message !== 'object') return message
  const allow = target.slashAllow
  if (!(allow instanceof Set) || allow.size === 0) return message
  if (message.senderIsBot === true) return message
  const senderId = typeof message.senderId === 'string' ? message.senderId : ''
  if (senderId !== '' && allow.has(senderId)) return message
  const split = splitLeadingSlash(message.content)
  if (split === null) return message

  const content = split.head + split.body
  // 给闸门的报告留个标记：这条消息行首的 / 被去掉了（debug 日志里能看到）。
  const filtered = { ...message, content, slashFiltered: true }
  const entry = {
    reason: 'slash-filtered',
    allow: true,
    mode: target.mode,
    sender: truncate(message.senderName ?? senderId, 48),
    senderId: truncate(senderId, 48),
  }
  if (message.kind === 'group') {
    entry.group = truncate(message.groupOpenid ?? '', 32)
    entry.text = truncate(message.content, 140)
    entry.filtered = truncate(content, 140)
  } else {
    // 私聊正文不写进调试日志（见 AGENTS.md §5.5），只留 ID 方便配白名单。
    entry.scope = String(message.kind ?? '')
  }
  target.suite?.logDebug?.(entry)
  return filtered
}

// ── 多条消息合并（同一个人连着发） ──────────────────────────────────────
//
// 位置：`handleInboundMessage`，中间件链之前，也在官方 `concurrencyGuard` 之前。
//
// 为什么只能在这里（2026-11-04 用真实实现跑过时序模拟）：
//   - 官方 merge 的 key 是「群」，只能接住「上一轮还在跑时到达的」消息；第一条
//     在 busy 变 true 之前就已经进下游了，永远进不了批次 → 最多把 N 次降到 2 次；
//   - 在 emit 层故意延迟也一样：延迟发生在「已经进了下游」之后，合并的还是别人；
//   - 把延迟放到 guard 之前（就是这里），锁是空闲的，后来的消息不会进 buffer，
//     所以必须自己攒——攒完放出去的是一条消息，官方 merge 根本不会参与。
//
// 结构：每个群一条 FIFO，队头开一个窗口（`merge.windowMs`）：
//   - 同一个人在窗口内又发一条 → 并进队尾那一批（通常是队头），窗口重新计时；
//   - 换人说话 → 排到队尾，等前面那批出去后才开始自己的窗口（保证顺序）；
//   - 只有行首 `/` 的斜杠命令绕过窗口（合并后正文不再以 `/` 开头，命令会被当成聊天）：
//     绕过之前先把本群队列全部放出去，顺序才不会反。
//   - 一批攒到 MERGE_MAX_MESSAGES 条就不再等窗口。
//
// 2026-11-09 用户定下的原则：**合并优先级最高**。@、唤醒词、引用一律进队列，
// 等窗口确认「没有新消息了」再一并放出去——之前它们会绕过窗口、并把同一人攒着的
// 那批一起挤出去（`flushMergeAll`），表现就是「连发两句被拆成两次回复」。
//
// 放出去的是一条普通 InboundMessage（正文换行拼接、附件取并集、messageId 保留第一条），
// 下游（斜杠过滤、摘图、闸门、群聊历史、看门狗、附件下载）都不用改。

const MERGE_MAX_MESSAGES = 5

/** 读取并补全合并配置（state 里可能只有半份）。 */
function mergeConfig(target) {
  const value = target.merge
  const fallback = DEFAULT_CONFIG.merge
  if (value === null || typeof value !== 'object') {
    return { enabled: fallback.enabled, windowMs: fallback.windowMs }
  }
  return {
    enabled: value.enabled === true,
    windowMs: Number.isFinite(value.windowMs) && value.windowMs > 0 ? value.windowMs : fallback.windowMs,
  }
}

/** 「同一个人」的判据：有 senderId 就按它，没有才退回昵称。 */
function senderKeyOf(message) {
  const id = typeof message?.senderId === 'string' ? message.senderId.trim() : ''
  if (id !== '') return id
  return `name:${String(message?.senderName ?? '').trim()}`
}

/**
 * 这条要不要绕过合并窗口（立刻进链）。
 *
 * 只有行首 `/` 的斜杠命令：合并之后正文不再以 `/` 开头，命令会被当成普通聊天，
 * 而且它必须赶在中间件链之前处理。其余一切群聊消息（包括 @、唤醒词、引用）
 * 都进队列——2026-11-09 用户定的：合并优先级最高，等窗口确认没有新消息再一起放。
 */
function shouldBypassMerge(target, message) {
  if (message === null || typeof message !== 'object') return true
  if (message.kind !== 'group') return true
  if (message.senderIsBot === true) return true
  const text = typeof message.content === 'string' ? message.content : ''
  return text.trim().startsWith('/')
}

/**
 * 被丢掉的引用块的标题 / 结尾提示（和图片块的写法一致：方括号 + 一句说明）。
 *
 * 结尾只说「这些是上下文」，**绝不写「图片看不到 / 本地没有文件」**：
 * 那是替 agent 提前下的结论，它看到这句就不去 `read_image` 了，直接当文件不存在
 * （2026-11-10 用户明确要求拿掉）。真查不到时它自己会说读不到，不需要预设前提。
 */
const DROPPED_QUOTES_TITLE = '[同一批里的其他引用]'
const DROPPED_QUOTES_HINT = '[这些是同一批并进来的更早几句各自引用的内容，只作上下文。]'

/** 正则字面量转义（文件名里可能有 `{`、`(`、`.` 这些）。 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 「引用里这个文件名」→「磁盘上那份文件的绝对路径」，找不到返回空串。
 *
 * 为什么要做这件事：官方下载器落盘的名字是 `uniqueFilename()` 生成的
 * `<原始名去扩展名>_<epoch>_<rand><ext>`（见 dsh-qqbot `transport/attachment.js`），
 * **原始名原样保留**。所以引用块里的 `[image: xxx.png]` 和图片索引里的
 * `xxx_1794297760385_d973aebf.png` 是同一张图——但让模型自己做这个字符串匹配不可靠
 * （还得先在那几张的列表里找到）。这里直接查索引，命中就写绝对路径，
 * 模型拿到的就是能直接 `read_image` 的路径。
 *
 * 三条约束：
 *   - 只查同一群（`g` 相同），跨群同名文件不能串；
 *   - 命名形状必须**完全**匹配 `_<epoch>_<rand><ext>`，不做前缀近似；
 *   - **只有唯一命中才算**。同名文件发过两次时宁可退回名字，也不要递错图
 *     （2026-11-10 那次「读错图」的教训）。
 */
function quotedImagePath(target, groupId, filename) {
  const file = target?.suite?.paths?.imageIndex ?? ''
  if (file === '' || typeof filename !== 'string' || filename === '') return ''
  const base = filename.replace(/\\/g, '/').replace(/^.*\//, '')
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  if (stem === '') return ''
  const pattern = new RegExp(`^${escapeRegExp(stem)}_\\d+_[0-9a-f]+${escapeRegExp(ext)}$`)
  const hits = readIndex(file).filter((row) => {
    if (groupId !== '' && row.g !== groupId) return false
    // 不再 `existsSync(row.p)` 探磁盘：那是官方缓存目录，不是本插件的地方。
    // 文件真被上游清掉了，`read_image` 自己会报错，比这里预判更准。
    return pattern.test(row.f)
  })
  return hits.length === 1 ? hits[0].p : ''
}

/**
 * 一个引用元素（`msgElements[0]`）→ 一行行文字。
 *
 * 标记格式照抄官方 `quote-ref` 的 `buildText()`（`[image: 名字]` / `[voice: 文字]` /
 * `[file: 名字]`）：模型在真正的引用块里见到的就是这套，两处不一致它会当成两种东西。
 * 例外是「能查到本地文件」的图片：写成 `- Image: <路径>`（官方正文也是这个格式），
 * `index.js: mediaRefsFromBody()` 认这个前缀，整轮都会 pin 住不被清掉。
 *
 * @param {object} element `msgElements[0]`
 * @param {(filename: string) => string} resolve 文件名 → 本地路径（无则空串）
 * @returns {string[]} 一行行文字（空数组 = 这个引用拿不到内容）
 */
function renderQuotedElement(element, resolve) {
  if (element === null || typeof element !== 'object') return []
  const lines = []
  const content = typeof element.content === 'string' ? element.content.trim() : ''
  if (content !== '') lines.push(content)
  for (const attachment of Array.isArray(element.attachments) ? element.attachments : []) {
    if (attachment === null || typeof attachment !== 'object') continue
    const type = typeof attachment.content_type === 'string' ? attachment.content_type.toLowerCase() : ''
    const filename = typeof attachment.filename === 'string' ? attachment.filename : ''
    if (type.startsWith('audio/')) {
      const asr = typeof attachment.asr_refer_text === 'string' ? attachment.asr_refer_text.trim() : ''
      lines.push(asr === '' ? '[voice]' : `[voice: ${asr}]`)
    } else if (type.startsWith('image/')) {
      const localPath = filename === '' ? '' : resolve(filename)
      if (localPath !== '') {
        lines.push(`- Image: ${localPath}`)
      } else {
        // 查不到本地文件就退回名字：不做任何「看不到」的断言，让它自己去试。
        lines.push(filename === '' ? '[image]' : `[image: ${filename}]`)
      }
    } else if (type.startsWith('video/')) {
      lines.push(filename === '' ? '[video]' : `[video: ${filename}]`)
    } else {
      lines.push(`[file: ${filename === '' ? 'untitled' : filename}]`)
    }
  }
  return lines
}

/**
 * 同一批里「让位」给最后一个引用的其他几条，把它们引用的内容渲染成一段正文。
 *
 * 一条 InboundMessage 在协议层只能挂**一个**引用（`refMsgIdx` + `msgElements` 成对），
 * 所以 `composeMergeBatch()` 取最后一条之后，其余几条的引用内容会整块消失
 * ——2026-11-10 16:40 那次就是「两条各引用一张图，模型只看到前一张」。
 * 这里把剩下的当普通文字补进正文：宁可是纯文本，也别让上下文凭空缺一块。
 *
 * 只补「被引用方」的内容，不补那几句自己的话——它们已经在合并后的正文里了。
 * 补不出内容（引用太旧、官方没推 `msg_elements`）就整条跳过：一句
 * 「某条引用了某条」没有信息量，只会占字数。
 *
 * @param {Array<object>} messages 整批（原顺序）
 * @param {object} keep 已经挂到合成消息上的那条引用（要跳过的）
 * @param {(filename: string) => string} [resolve] 文件名 → 本地路径（无则空串）
 * @returns {string} 空字符串 = 没有需要补的
 */
function droppedQuotesBlock(messages, keep, resolve) {
  const lookup = typeof resolve === 'function' ? resolve : () => ''
  const items = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message === keep || message === null || typeof message !== 'object') continue
    if (typeof message.refMsgIdx !== 'string' || message.refMsgIdx === '') continue
    const lines = renderQuotedElement(
      Array.isArray(message.msgElements) ? message.msgElements[0] : undefined,
      lookup,
    )
    if (lines.length === 0) continue
    const own = typeof message.content === 'string' ? message.content.trim().replace(/\s+/g, ' ') : ''
    // 锚点只是让模型知道「是并进来的哪一句在引用」，太长反而抢戏。
    items.push({ anchor: own === '' ? '（没有正文）' : truncate(own, 32), lines })
  }
  if (items.length === 0) return ''
  const out = [DROPPED_QUOTES_TITLE]
  for (const item of items) {
    out.push(`- 「${item.anchor}」这句引用的是：`)
    for (const line of item.lines) out.push(`  ${line}`)
  }
  out.push(DROPPED_QUOTES_HINT)
  return out.join('\n')
}

/**
 * 一批消息 → 一条 InboundMessage。单条原样返回（不复制对象，下游还认原来的引用）。
 *
 * 合并规则：正文按行拼（去掉空行），附件取并集（连着发两张图要都能下载/索引），
 * 时间戳取最后一条（落盘和回复都按「这段话说完了」算），其余字段沿用第一条
 * （messageId 用它，被动回复仍然有效）。
 *
 * @ 信号必须保留：2026-11-09 起 @ 也进合并队列（合并优先级最高），
 * 「mentions/rawEventType 不会出现」的旧假设已不成立。批内任何一条带 @
 * （rawEventType = GROUP_AT_MESSAGE_CREATE，或 mentions[].is_you）时，
 * 合成消息必须带上，否则官方 mentionGate 和套件的 mention 短路全部失效，
 * 掉进语义判断后模型看着裸 <@openid> 根本猜不出是自己被点了名
 * （2026-11-10 17:01 实测翻车：图片 + @ 合并 → 语义判 NO → 没回）。
 *
 * 引用（refMsgIdx + msgElements）也要一起搬，理由相同：11-09 起引用也进队列，
 * 而 `...first` 只留第一条的字段，引用消息不是批内第一条时，
 * 「回复机器人」短路（quote-bot）和引用正文/引用附件会一起消失。
 * 协议层一条消息只挂得了一个引用，所以批内有多个引用时取最后一条（后引用的
 * 那个才是正在问的对象），其余的交给 `droppedQuotesBlock()` 当普通文字补进正文。
 *
 * @param {{ messages: Array<object> }} batch 一批消息（原顺序）
 * @param {(filename: string) => string} [resolveQuotedImage] 引用里的文件名 → 本地路径
 */
function composeMergeBatch(batch, resolveQuotedImage) {
  const messages = batch.messages
  if (messages.length === 1) return messages[0]
  const first = messages[0]
  const last = messages[messages.length - 1]
  const parts = []
  for (const message of messages) {
    const text = typeof message.content === 'string' ? message.content.trim() : ''
    if (text !== '') parts.push(text)
  }
  const attachments = []
  for (const message of messages) {
    if (Array.isArray(message.attachments)) attachments.push(...message.attachments)
  }
  // rawEventType：批内任一条是 @ 事件（GROUP_AT_MESSAGE_CREATE）就按 @ 算——
  // QQ 只在用户真的 @ 了机器人时才派发这个事件；否则沿用第一条的原事件类型。
  const atHit = messages.some((message) => message.rawEventType === 'GROUP_AT_MESSAGE_CREATE')
  const firstEvent = typeof first.rawEventType === 'string' && first.rawEventType !== ''
    ? first.rawEventType
    : undefined
  const mentions = []
  for (const message of messages) {
    if (Array.isArray(message.mentions)) mentions.push(...message.mentions)
  }
  // 引用信号同理，而且必须「成对」搬：refMsgIdx 说引用的是哪条，
  // msgElements 里才是那条的正文预览和附件列表（官方 quote-ref 优先读它）。
  // 只搬一个等于没搬——拆开会出现「指向了引用、但拿不到引用内容」。
  // 取批内最后一条带引用的：同一批发多条时，以最后那句「我在回谁」为准。
  const quoteSource = [...messages].reverse().find((message) => {
    return typeof message.refMsgIdx === 'string' && message.refMsgIdx !== ''
  })
  const quote = quoteSource === undefined
    ? {}
    : {
      refMsgIdx: quoteSource.refMsgIdx,
      ...(Array.isArray(quoteSource.msgElements) ? { msgElements: quoteSource.msgElements } : {}),
    }
  const droppedQuotes = quoteSource === undefined
    ? ''
    : droppedQuotesBlock(messages, quoteSource, resolveQuotedImage)
  return {
    ...first,
    content: parts.join('\n'),
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(atHit ? { rawEventType: 'GROUP_AT_MESSAGE_CREATE' }
      : firstEvent === undefined ? {} : { rawEventType: firstEvent }),
    ...(mentions.length === 0 ? {} : { mentions }),
    ...quote,
    // 没抢到那唯一一个引用位的其他几条：内容留在这里，由 emit 层补到正文末尾。
    // 不能在 content 里直接拼——正文会被记进群聊历史环（只该记用户真说过的话）。
    ...(droppedQuotes === '' ? {} : { suiteDroppedQuotes: droppedQuotes }),
    timestamp: last.timestamp,
  }
}

/**
 * 一条消息真正进链：先做链前预处理（斜杠白名单 / 摘图），再交给官方实现。
 * 合并出来的消息也走这里，所以下游看到的东西跟原生一条没有区别。
 */
function deliverInbound(bot, originalHandle, target, message) {
  let next = message
  try {
    next = prepareInbound(target, message)
  } catch {
    next = message
  }
  return originalHandle.call(bot, next)
}

/** 一批出队并投递（只在队头调用）。放出去之后给新的队头重新开窗口。 */
function flushMergeHead(target, groupId) {
  const queue = target.mergeQueue.get(groupId)
  if (queue === undefined || queue.length === 0) {
    target.mergeQueue.delete(groupId)
    return undefined
  }
  const batch = queue.shift()
  if (batch.timer !== null) {
    clearTimeout(batch.timer)
    batch.timer = null
  }
  if (queue.length === 0) target.mergeQueue.delete(groupId)
  else startMergeTimer(target, groupId, queue[0])

  const message = composeMergeBatch(batch, (filename) => {
    return quotedImagePath(target, typeof batch.messages[0]?.groupOpenid === 'string' ? batch.messages[0].groupOpenid : '', filename)
  })
  if (batch.messages.length > 1) {
    try {
      // 只进 debug 日志（不看就不写）：排查「为什么它只回了一次」时能看到合了哪几条。
      // 这不是一条判定：合并只是把几条并成一条往下投，放不放行由后面的闸门记。
      // 以前这里写死 `allow: true`，有次排 @ 失效时把这条当成了「已放行」的证据，
      // 所以坚决不带 allow 字段。
      //
      // `quotes` = 这批里有几条带引用。合成消息只能留一个引用（取最后一条），
      // 所以 >1 就意味着有引用被丢了——2026-11-10 16:40 那次「读错图」正是这样：
      // 两条消息各引用一张图，只留了前一条的，模型读的是前一张。
      const quotes = batch.messages.filter((item) => {
        return typeof item.refMsgIdx === 'string' && item.refMsgIdx !== ''
      }).length
      target.suite?.logDebug?.({
        at: Date.now(),
        reason: 'merge-flush',
        mode: target.mode,
        count: batch.messages.length,
        ...(quotes === 0 ? {} : { quotes }),
        sender: truncate(message.senderName ?? message.senderId ?? '', 48),
        senderId: truncate(message.senderId ?? '', 48),
        group: truncate(message.groupOpenid ?? '', 32),
        text: truncate(message.content ?? '', 140),
      })
    } catch {
      // 记日志失败不影响投递
    }
  }
  try {
    deliverInbound(batch.bot, batch.handle, target, message)
  } catch {
    // 投递失败（官方实现对内部异常有自己的 catch）也不该卡住后面的队列
  }
  return batch
}

/** 队头窗口到期 / 攒够条数时由定时器调用；只认队头，避免把后面那批提前放出去。 */
function startMergeTimer(target, groupId, batch) {
  if (batch.timer !== null && batch.timer !== undefined) clearTimeout(batch.timer)
  const { windowMs } = mergeConfig(target)
  batch.timer = setTimeout(() => {
    batch.timer = null
    const queue = target.mergeQueue.get(groupId)
    if (queue === undefined || queue[0] !== batch) return
    flushMergeHead(target, groupId)
  }, windowMs)
}

/** 把某个群队列里的每一批按顺序立刻放出去（点名消息插队、关掉合并时用）。 */
function flushMergeAll(target, groupId) {
  let guardCount = 0
  while ((target.mergeQueue.get(groupId)?.length ?? 0) > 0 && guardCount < 200) {
    guardCount += 1
    flushMergeHead(target, groupId)
  }
  // 只清「真的空了」的条目：真撞上上限（200 批）时剩下的留在队列里等下一个窗口，
  // 绝不在这里把没投递的消息一起丢掉。
  if ((target.mergeQueue.get(groupId)?.length ?? 0) === 0) target.mergeQueue.delete(groupId)
}

/** 所有群都放干净（关掉合并、重载配置时用，绝不吞消息）。 */
function flushAllMerges(target) {
  for (const groupId of [...target.mergeQueue.keys()]) flushMergeAll(target, groupId)
}

/**
 * 聚合入口：决定这条要不要进窗口。
 *
 * 返回 true = 已经收下（调用方不要再投递）；false = 照原样立刻投递。
 * 关了合并、私聊、机器人回声、点名类消息都返回 false。
 */
function deferInbound(target, bot, handle, message) {
  if (mergeConfig(target).enabled !== true) return false
  if (message === null || typeof message !== 'object') return false
  const groupId = typeof message.groupOpenid === 'string' ? message.groupOpenid : ''
  if (shouldBypassMerge(target, message)) {
    // 先放干净的再处理它：否则这条会跑到前面几句之前，聊天顺序就反了。
    if (groupId !== '' && target.mergeQueue.has(groupId)) flushMergeAll(target, groupId)
    return false
  }
  if (groupId === '') return false

  let queue = target.mergeQueue.get(groupId)
  if (queue === undefined) {
    queue = []
    target.mergeQueue.set(groupId, queue)
  }

  const key = senderKeyOf(message)
  const messageId = typeof message.messageId === 'string' ? message.messageId : ''
  const tail = queue[queue.length - 1]
  // 同一个人接着发：并进队尾那一批。同一个 messageId 重复投递时直接丢掉，不拼两遍。
  if (tail !== undefined && tail.key === key && (messageId === '' || !tail.messages.some((item) => item.messageId === messageId))) {
    tail.messages.push(message)
    if (tail.messages.length >= MERGE_MAX_MESSAGES) {
      // 攒满了就不再等窗口。能立刻放的只有队头：后面那几批必须排队，否则顺序会乱。
      if (queue[0] === tail) flushMergeHead(target, groupId)
      return true
    }
    // 只有队头才有窗口：排在别人后面时，窗口从轮到自己那一刻才开始算。
    if (queue[0] === tail) startMergeTimer(target, groupId, tail)
    return true
  }

  const batch = { key, messages: [message], timer: null, bot, handle }
  queue.push(batch)
  if (queue.length === 1) startMergeTimer(target, groupId, batch)
  return true
}

/**
 * `handleInboundMessage` 里的统一预处理（中间件链之前，ctx 还没建）。
 *
 * 顺序有讲究：先按白名单处理斜杠（可能返回浅拷贝），再按图片策略摘图；
 * 两步都不改原对象，失败也各自降级，不能因为一步出错把整条消息丢掉。
 */
function prepareInbound(target, message) {
  let next = message
  try {
    next = filterSlashMessage(target, next)
  } catch {
    next = message
  }
  try {
    next = stripGroupImagesEarly(target, next)
  } catch {
    // 摘图失败就交给 emit 层的老路径处理
  }
  return next
}

/**
 * 「这类图片要不要先存下来」的开关。
 *
 * - `agent` 模式：一定要存——官方链路下载完会在正文写 `Image: <本地路径>`，agent 靠它读图；
 * - `placeholder` 模式：不存，连下载都省了。
 *
 * 这是「要不要留文件」，不是「模型能不能看图」——能力由模型和 read_image 自己判断。
 */
function keepsImageFiles(target) {
  return target.imageMode === 'agent'
}

/**
 * 群聊图片预过滤（中间件链之前，比官方 `attachmentProcessor` 早）。
 *
 * 只在这里摘 `placeholder` 的图：等 emit 再删时，图片已经落到
 * `~/.dsh-qqbot/media` 了，白下一份。
 *
 * `agent` 模式**什么都不做**——官方链路本来就会下载并写 `Image: <路径>`。
 * `ignore` 模式也不在这里拦：消息要照常进链（群历史缓冲、去重都还要记），
 * 由闸门在 emit 层整条拦下。
 */
function stripGroupImagesEarly(target, message) {
  if (message === null || typeof message !== 'object') return message
  // 模式 3：附件一个字都不动（官方要下载、正文要写 `Image: <路径>`）。
  // 只补一个计数给历史环用：群里别人发的图，后续消息的上下文里得有个「这里有过图」的痕迹，
  // 不然纯图片消息在 `entryFromMessage()` 里会因正文为空直接消失。
  if (target.imageMode === 'agent') {
    if (message.kind !== 'group' || message.senderIsBot === true) return message
    const present = (Array.isArray(message.attachments) ? message.attachments : []).filter(isImageAttachment)
    return present.length === 0 ? message : { ...message, suiteImagesPresent: present.length }
  }
  if (target.imageMode === 'ignore') return message
  if (message.kind !== 'group' || message.senderIsBot === true) return message
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  if (attachments.length === 0) return message
  const images = attachments.filter(isImageAttachment)
  if (images.length === 0) return message
  return {
    ...message,
    attachments: attachments.filter((item) => !isImageAttachment(item)),
    // 标记留在消息上（SDK 会 `{...raw, replyTarget}` 带进 ctx.message），闸门据此记账。
    suiteImagesStripped: images.length,
    // 原附件留一份：历史环要数张数（第三方读图要重新接入时，url 也从这里拿）。
    suiteImages: images,
  }
}

/**
 * 群聊图片策略（emit 层，链已经跑完）：
 *   - ignore：带图整条拦下（不读图——agent 完全收不到）；
 *   - agent：不干预，官方怎么写就怎么写；
 *   - placeholder：摘掉图片附件，只把文字交给 agent。
 * 返回 { blocked, stripped, remaining }。
 */
function applyGroupImagePolicy(target, message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : []
  const images = attachments.filter(isImageAttachment)
  // 链之前已经摘过（stripGroupImagesEarly）：附件里没有图了，但数量要照实报。
  const early = Number(message?.suiteImagesStripped) > 0 ? Number(message.suiteImagesStripped) : 0
  // 「不读图」优先于其它判断：带图片的整条拦，不是图片处置。
  if (target.imageMode === 'ignore' && (images.length > 0 || early > 0)) {
    return { blocked: true, stripped: 0, remaining: attachments.length }
  }
  // 模式 3：官方链路怎么给就怎么给，这里一个字都不改。
  if (target.imageMode === 'agent') {
    return { blocked: false, stripped: 0, remaining: attachments.length }
  }
  if (images.length === 0 && early === 0) {
    return { blocked: false, stripped: 0, remaining: attachments.length }
  }
  if (early > 0) {
    return { blocked: false, stripped: early, remaining: attachments.length }
  }
  message.attachments = attachments.filter((item) => !isImageAttachment(item))
  // 兜底摘图也要记数：占位符、debug 报告都读这个字段。
  message.suiteImagesStripped = images.length
  message.suiteImages = images
  return { blocked: false, stripped: images.length, remaining: message.attachments.length }
}

/**
 * 让配置里的方式处理这条消息的图片，返回要补进正文的文字。
 *
 * - `agent`：返回空串，什么都不补——图片原样交给 agent，官方正文里已有 `Image: <路径>`；
 * - `placeholder`：直接给占位符，不等待、不联网。
 *
 * 读图能力（模型是否声明 image 输入）不在这里判断，由模型和 read_image 自己决定。
 */
function resolveImageText(target, ctx) {
  const msg = ctx?.message
  if (msg === null || typeof msg !== 'object') return ''
  // 模式 1/3：ignore 没图可补；agent 完全不介入。占位符只认摘图记下的张数。
  if (target.imageMode === 'agent') return ''
  const stripped = Number(msg.suiteImagesStripped) > 0 ? Number(msg.suiteImagesStripped) : 0
  if (stripped === 0) return ''
  return imagePlaceholder(stripped)
}

/**
 * 把图片文字补进这条消息的正文，交给 agent 的那份才看得见。
 *
 * 时机有讲究：必须在 `shouldAnswer()` **之后**——闸门判断读的是原文
 * （纯图片拦截、斜杠命令、唤醒词都按原文算），提前改写会让纯图片消息
 * 变成「有文字」，从 `group-image-only` 漏成一条空回复。
 * 也要在 `startWatch()` 之后：看门狗按正文子串配对，后缀不影响匹配。
 */
function applyImageText(msg, text) {
  if (msg === null || typeof msg !== 'object') return
  const note = typeof text === 'string' ? text.trim() : ''
  if (note === '') return
  const content = typeof msg.content === 'string' ? msg.content : ''
  if (content.includes(note)) return
  msg.content = content.trim() === '' ? note : `${content.trimEnd()} ${note}`
}

/** 记录一条机器人发出的群消息正文。 */
function recordBotText(target, scope, targetId, text) {
  if (scope !== 'group' || typeof targetId !== 'string' || targetId === '') return
  if (typeof text !== 'string' || text.trim() === '') return
  if (!target.recent.has(targetId) && target.recent.size >= 500) {
    const oldest = target.recent.keys().next().value
    if (oldest !== undefined) target.recent.delete(oldest)
  }
  const list = target.recent.get(targetId) ?? []
  list.push({ text: norm(text), at: Date.now() })
  while (list.length > RECENT_LIMIT) list.shift()
  target.recent.set(targetId, list)
  // 同时进群聊上下文：它自己说过什么，是理解「前面有人找你」的前提。
  rememberBotText(target, scope, targetId, text)
  // 它插过话了：之前那条被语义拦下、还没人接的消息就不再是冷场。
  try {
    target.idleTracker.noteBot(targetId)
  } catch {
    // 记账失败不影响发送
  }
}

/** 吞掉一条「占位说明」（`[No response needed]` 之类）并留痕，否则日志里看不出它其实是想沉默。 */
function dropQuiet(target, scope, targetId, text, reason = 'quiet-drop') {
  try {
    target.suite?.logDebug?.({
      reason,
      allow: true,
      mode: target.mode,
      group: scope === 'group' && typeof targetId === 'string' ? targetId : '',
      text: typeof text === 'string' ? text.slice(0, 60) : '',
    })
  } catch {
    // 留痕失败不影响抑制
  }
  // 设置页要能看出「它确实想说，只是被拦下了」——死寂和主动放弃是两回事。
  if (scope === 'group' && typeof targetId === 'string') {
    noteIdleRecord(target, {
      at: Date.now(),
      group: targetId,
      kind: 'drop',
      ok: false,
      reason,
      text: typeof text === 'string' ? text.slice(0, 60) : '',
    })
  }
}

/**
 * 冷场补回后 agent 把「我决定不回」写成了正文（最典型就是两个字「不接」）。
 *
 * 只在**它刚主动开过口、还没人接**的那一轮里认这类词（`IdleTracker.awaiting`）：
 * 平时群里真有人说「这活你接不接」，它答「不接」是正常回话，不能拦。
 * `noteInbound()` 会在有人说话时把 awaiting 清掉，所以这个窗口天然是窄的。
 */
function isIdleLabel(target, scope, targetId, text) {
  if (scope !== 'group' || typeof targetId !== 'string') return false
  try {
    const state = target.idleTracker?.stateOf?.(targetId)
    if (state === null || state === undefined || state.awaiting !== true) return false
    return isIdleSilence(text)
  } catch {
    return false
  }
}

/**
 * 往「最近冷场触发」里加一条（内存，最多 20 条）。
 *
 * 和语义判定那份列表分开存：冷场是独立触发源，它的 `ok` 讲的是「有没有真说出去」，
 * 不是「该不该回」。混在一起会把 YES/NO 的漏判统计搞脏（见 index.js: RECENT_IDLE_LIMIT）。
 */
function noteIdleRecord(target, entry) {
  try {
    target.suite?.noteIdle?.(entry)
  } catch {
    // 记账失败不影响发送
  }
}

function recentTexts(target, groupId) {
  const list = target.recent.get(groupId)
  if (list === undefined) return []
  const now = Date.now()
  return list.filter((item) => now - item.at <= RECENT_TTL_MS).map((item) => item.text)
}

/** 被引用的正文是不是机器人最近说过的话。 */
function isReplyToBot(target, groupId, quoted) {
  const q = norm(quoted)
  if (q === '') return false
  const now = Date.now()
  for (const item of target.recent.get(groupId) ?? []) {
    if (now - item.at > RECENT_TTL_MS) continue
    if (item.text === q) return true
    if (q.length >= 8 && item.text.length >= 8 && (item.text.startsWith(q) || q.startsWith(item.text))) {
      return true
    }
  }
  return false
}

/** 文本里有没有叫机器人的名字/唤醒词。拉丁词按词边界匹配，中文按包含匹配。 */
function mentionsBotName(target, text) {
  const t = norm(text)
  if (t === '') return false
  for (const alias of target.names) {
    if (alias === '') continue
    if (/^[a-z0-9][a-z0-9 _-]*$/i.test(alias)) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(t)) return true
    } else if (t.includes(alias)) {
      return true
    }
  }
  return false
}

/** @ 判定：和 SDK mentionGate 同源，作为 state.mention 缺失时的兜底。 */
function wasMentioned(msg, appId) {
  if (msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE') return true
  if (Array.isArray(msg.mentions) && msg.mentions.some((item) => item?.is_you === true)) return true
  if (typeof appId === 'string' && appId !== '' && typeof msg.content === 'string') {
    const escaped = appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`<@!?${escaped}>`).test(msg.content)
  }
  return false
}

function report(target, ctx, allow, reason, images = '', error = '') {
  if (target.suite === undefined) return
  try {
    // 把判定原因挂回 ctx：emit 那一层要拿它区分「语义说不用回」（可以补回）
    // 和「关键词没匹配到」（本来就该静默，补回等于把模式改成全部回复）。
    if (ctx !== null && typeof ctx === 'object') ctx.suiteReason = reason
    const msg = ctx?.message ?? {}
    // 只为群聊里的真人消息记状态/日志：私聊和 bot 回声不污染调试文件。
    if (msg.kind !== 'group' || msg.senderIsBot === true) return
    const entry = {
      at: Date.now(),
      allow,
      reason,
      mode: target.mode,
      imageMode: target.imageMode,
      ...(images === '' ? {} : { images }),
      ...(error === '' ? {} : { error: truncate(error, 240) }),
      ...(msg.slashFiltered === true ? { slash: 'filtered' } : {}),
      sender: truncate(msg.senderName ?? msg.senderId ?? '', 48),
      // 配斜杠白名单时要用它：群成员 openid / 私聊 user_openid 都从这里看。
      senderId: truncate(msg.senderId ?? '', 48),
      group: truncate(msg.groupOpenid ?? '', 32),
      text: truncate(msg.content ?? '', 140),
    }
    target.suite.setGateStatus?.(entry)
    target.suite.logDebug?.(entry)
  } catch {
    // 状态展示 / 日志失败不影响判断
  }
}

/**
 * 这条消息要不要交给 agent。语义模式可能等待模型，所以返回 Promise。
 * 任何未预期异常都放行（fail open），避免凭空装死。
 */
async function shouldAnswer(target, ctx) {
  let allow = true
  let reason = 'error'
  let images = ''
  let errorText = ''

  try {
    const msg = ctx?.message
    if (msg === undefined) return true

    // 机器人自己的回声 / 其他 bot：永远不回。
    if (msg.senderIsBot === true) {
      allow = false
      reason = 'bot-echo'
      return false
    }
    if (msg.kind !== 'group') {
      allow = true
      reason = 'private'
      return true
    }

    const text = typeof msg.content === 'string' ? msg.content : ''

    // 群聊图片策略：默认 text-only，摘掉图片后再走后续判断。
    const image = applyGroupImagePolicy(target, msg)
    if (image.blocked) {
      allow = false
      reason = 'group-image'
      images = 'blocked'
      return false
    }
    if (image.stripped > 0) {
      images = `stripped:${image.stripped}`
      if (text.trim() === '' && image.remaining === 0) {
        allow = false
        reason = 'group-image-only'
        return false
      }
    }

    const mentioned = ctx.state?.mention?.wasMentioned
    if (mentioned === true || wasMentioned(msg, ctx.bot?.appId)) {
      allow = true
      reason = 'mention'
      return true
    }

    if (text.trim().startsWith('/')) {
      allow = true
      reason = 'slash-command'
      return true
    }

    const quoted = ctx.state?.quote?.text ?? msg.msgElements?.[0]?.content
    if (msg.refMsgIdx && quoted !== undefined && isReplyToBot(target, msg.groupOpenid ?? '', quoted)) {
      allow = true
      reason = 'quote-bot'
      return true
    }

    if (mentionsBotName(target, text)) {
      allow = true
      reason = 'wake-word'
      return true
    }

    if (target.mode === 'all') {
      allow = true
      reason = 'all'
      return true
    }

    if (target.mode === 'semantic' && typeof target.judge === 'function') {
      try {
        const verdict = await target.judge(ctx)
        allow = verdict === true
        reason = allow ? 'semantic-yes' : 'semantic-no'
        return allow
      } catch (error) {
        allow = false
        reason = 'semantic-error'
        errorText = error instanceof Error ? error.message : String(error)
        return false
      }
    }

    allow = false
    reason = 'no-match'
    return false
  } catch {
    allow = true
    reason = 'error-fail-open'
    return true
  } finally {
    report(target, ctx, allow, reason, images, errorText)
  }
}

/**
 * 当前 profile 目录（`DSH_PROFILE`，缺省 web）。退路专用：loader 锚定失败
 * （见 `loaderProfileDir`）时才用这个猜测，所以只认当前 profile——
 * 真找不到 SDK 时由调用方用 `allProfileDirs()` 兜底并打 warn。
 */
function currentProfileDirs() {
  const root = join(dshHomeOf(), 'profiles')
  const env = (process.env.DSH_PROFILE ?? '').trim()
  return [join(root, env !== '' ? env : 'web')]
}

/** 兜底候选：全部 profile 目录。只在当前 profile 找不到 SDK 时才用（调用方负责 warn）。 */
function allProfileDirs() {
  const root = join(dshHomeOf(), 'profiles')
  const dirs = []
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(root, entry.name))
    }
  } catch {
    // 没有 profiles 目录就返回空，让调用方按「找不到」处理
  }
  return dirs
}

// ── profile / 官方插件发现：先问 DSH loader，目录猜测只是退路 ──────────
//
// 上面两个目录函数本质是「按约定路径猜」：DSH_PROFILE 可以没设、可以设错，
// 猜错了才退回扫全部 profile——而那份兜底扫到的模块未必是进程当前实际加载的
// 那份。loader 才是权威：它知道这个进程加载的是哪个 profile、官方 QQ 插件
// 有没有配、有没有被禁。两个事实都来自公开 API：
//   - 根 EntryTree 的 ctx.baseUrl 锚在 <profile>/cordis.yml（dsh 的 profile-boot
//     专门写这个空文件就是给 loader 一个真实锚点，见 profile-boot 的注释），
//     dirname 就是 profile 目录；
//   - `ctx.loader.entries()` 按 id/name 找到官方插件条目（`im-qqbot` /
//     `@tencent-connect/dsh-qqbot`），`options.config` 就是合并后的生效配置，
//     不用再解析 cordis.patch.yml 的文本。
// loader 缺席（单测进程、宿主没装 loader）时全部退回旧扫描，行为不变。

/** 官方 QQ 插件的包名（loader 条目合并后的 `options.name`；条目 id 固定是 im-qqbot）。 */
const OFFICIAL_QQBOT_PACKAGE = '@tencent-connect/dsh-qqbot'

/**
 * 从 DSH loader 拿「当前进程实际加载的 profile 目录」。
 *
 * @returns 目录路径；loader 缺席 / baseUrl 不是文件 URL 时返回空串，
 *   调用方退回 `DSH_PROFILE` 猜测（旧路径）。
 */
function loaderProfileDir(ctx) {
  try {
    const loader = ctx?.loader ?? ctx?.get?.('loader')
    const base = loader?.ctx?.baseUrl ?? loader?.config?.baseUrl
    if (typeof base !== 'string' || base === '') return ''
    const url = new URL(base)
    if (url.protocol !== 'file:') return ''
    const dir = dirname(fileURLToPath(url))
    return dir === '' ? '' : dir
  } catch {
    return ''
  }
}

/**
 * 官方 QQ 插件在 loader 里的事实：有没有配、有没有被禁、`requireMention` 开没开。
 *
 * `requireMention` 只进调试日志：它开着时未 @ 的群消息在官方 mentionGate 就被
 * 拦下、根本到不了本闸门，是「semantic 模式怎么全都不回」的第一嫌疑。凭据类
 * 字段（appId/appSecret）不读也不记——本函数碰都不碰它们。
 *
 * @returns `{ found, disabled, requireMention }`；loader 缺席或结构不认识时
 *   返回 undefined（调用方按「不知道」处理，退回旧扫描，不改变行为）。
 */
function officialQqbotFacts(ctx) {
  try {
    const loader = ctx?.loader ?? ctx?.get?.('loader')
    if (loader === null || typeof loader !== 'object' || typeof loader.entries !== 'function') return undefined
    for (const entry of loader.entries()) {
      const options = entry?.options
      if (options === null || typeof options !== 'object') continue
      const name = typeof options.name === 'string' ? options.name : ''
      if (options.id !== 'im-qqbot' && name !== OFFICIAL_QQBOT_PACKAGE && !name.endsWith('/dsh-qqbot')) continue
      const config = options.config !== null && typeof options.config === 'object' ? options.config : {}
      return {
        found: true,
        disabled: entry.disabled === true,
        requireMention: typeof config.requireMention === 'boolean' ? config.requireMention : undefined,
      }
    }
    return { found: false, disabled: false, requireMention: undefined }
  } catch {
    return undefined
  }
}

/**
 * 补丁安装的定位计划（install / installSessionCapture 共用）。
 *
 * 主目录用 loader 锚定的 profile 目录（loader 缺席退回 DSH_PROFILE 猜测）。
 * `sweep` 控制主目录一无所获时是否退回「扫全部 profile」：loader 明确说官方
 * 插件没配（found=false）时关掉——别的 profile 里的副本不是这个进程会用到的
 * 模块，扫到也只是导入一份用不上的拷贝。官方插件**被禁用**（disabled）不关：
 * 补丁按模块实例幂等，照常打上，用户重新启用官方插件后同一实例直接带上补丁，
 * 不需要重载本插件。
 */
function scanPlan(ctx) {
  const facts = officialQqbotFacts(ctx)
  const loaderDir = loaderProfileDir(ctx)
  return {
    dirs: loaderDir !== '' ? [loaderDir] : currentProfileDirs(),
    sweep: !(facts !== undefined && facts.found === false),
    facts,
  }
}

function realpath(file) {
  try {
    return realpathSync.native(file)
  } catch {
    return file
  }
}

/** 找这些 profile 目录下所有 qqbot-nodejs 的入口文件（直接依赖 + pnpm store）。 */
function sdkEntrypoints(dirs) {
  const found = new Set()
  for (const dir of dirs) {
    const direct = join(dir, 'node_modules', '@tencent-connect', 'qqbot-nodejs', 'dist', 'index.js')
    if (existsSync(direct)) found.add(realpath(direct))

    const store = join(dir, 'node_modules', '.pnpm')
    try {
      for (const entry of readdirSync(store, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.includes('qqbot-nodejs')) continue
        const candidate = join(store, entry.name, 'node_modules', '@tencent-connect', 'qqbot-nodejs', 'dist', 'index.js')
        if (existsSync(candidate)) found.add(realpath(candidate))
      }
    } catch {
      // 没有 .pnpm（npm / hoisted 布局）就只靠直接依赖
    }
  }
  return [...found]
}

// ── 冷场处理：定时扫描 + 主动发言 ─────────────────────────────────────
//
// 「什么时候该说话」全在 idle.js（纯逻辑，能单独测）。这里只做三件事：
//   1. 每 30 秒扫一遍有记录的群；
//   2. 命中后拿到「这个群的会话」——用 dsh-qqbot 自己的 getOrCreate，
//      会话被 30 分钟回收了也能 resume 回来；
//   3. 把消息 followup 给 agent，剩下的（流式输出、被动/主动降级）全交给官方链路。
//
// 为什么不自己 resume 一个 agent：发送侧（outbound）靠 `manager.findBySessionId()`
// 找 record，找不到就静默丢弃。只有 manager 自己开出来的 record 才在它的 sessions
// 里，绕开它等于自己造一套会话——那正是「在已有链路旁边另造一套」，这里不这么做。

/** 扫描粒度：够快（30 秒内发现冷场），又不至于让空的 setInterval 太吵。 */
const IDLE_SCAN_MS = 30_000

/**
 * 这几类跳过是「这一轮不行」，不是「这条消息处理失败」，不该进冷却。
 *
 * - `agent-busy`：上一轮还在跑，等它跑完这 30 秒就会重试；
 * - `no-agent`：record 有但拿不到 agent（通常是刚被回收），下一轮 getOrCreate 会重建；
 * - （`no-session-manager` 在调用点直接短路，不走这里）
 */
const TRANSIENT_IDLE_SKIPS = new Set(['agent-busy', 'no-agent'])

/** dsh-qqbot 的会话模块入口（直接依赖 + pnpm store），用来 patch getOrCreate。 */
function sessionEntrypoints(dirs) {
  const found = new Set()
  for (const dir of dirs) {
    const direct = join(dir, 'node_modules', '@tencent-connect', 'dsh-qqbot', 'lib', 'session', 'index.js')
    if (existsSync(direct)) found.add(realpath(direct))

    const store = join(dir, 'node_modules', '.pnpm')
    try {
      for (const entry of readdirSync(store, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.includes('dsh-qqbot')) continue
        const candidate = join(
          store,
          entry.name,
          'node_modules',
          '@tencent-connect',
          'dsh-qqbot',
          'lib',
          'session',
          'index.js',
        )
        if (existsSync(candidate)) found.add(realpath(candidate))
      }
    } catch {
      // 没有 .pnpm（npm / hoisted 布局）就只靠直接依赖
    }
  }
  return [...found]
}

/**
 * 把官方会话模块 `config.cwd` 记进套件运行期。
 *
 * 这是「机器人工作区」唯一不需要读文件就能拿到的来源：官方
 * `resolveAgentCwd(this.config.cwd)` 用的就是它。拿不到就算了，
 * 调用方会退回读 patch（只在启动早期、还没会话时才会发生）。
 */
function noteWorkspaceOf(target, manager) {
  const cwd = manager?.config?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') target.suite?.noteBotWorkspace?.(cwd)
}

/**
 * patch `SessionManager.prototype.getOrCreate`，把实例记到 state 上。
 *
 * 不是「改它的行为」，只是在每次官方建/取会话时留一个引用：冷场触发时拿它
 * 重建被回收的 record（`getOrCreate` 自己会 resume，顺带更新 replyTarget 和
 * lastActivity——后者正好让会话不被立刻再回收一次）。
 *
 * @returns 打上补丁的模块入口数；0 表示 dsh-qqbot 结构变了，冷场功能会停用。
 */
async function patchSessionEntries(entries, logger) {
  let applied = 0
  for (const entry of entries) {
    try {
      const mod = await import(pathToFileURL(entry).href)
      const proto = mod?.SessionManager?.prototype
      if (proto === undefined || typeof proto.getOrCreate !== 'function') continue
      // off/on 重载换的是本模块实例，dsh-qqbot 的模块按 URL 缓存不会换，
      // 所以补丁还在；闭包里的 active() 每次都读全局 state，不用重打。
      if (proto.__dshSuiteSessionHook === true) {
        applied += 1
        continue
      }

      // ── 构造期捕获（主路径）────────────────────────────────────────
      // 构造函数最后一行会调 `this.registerScopePromptInjection()`
      // （dsh-qqbot/lib/session/session-manager.js:100），在这里拿 this 是唯一
      // 「进程一起来就有值」的时机。
      //
      // 只靠 getOrCreate 会漏掉最要命的那种情况：冷启动后群里每一条消息都被
      // 闸门判成不回，就没人走到 getOrCreate，manager 一直是 null，冷场判定
      // 明明命中（kind: 'missed'）也只能记一条 no-session-manager 然后跳过。
      // 2026-11-09 实际踩到：14:04 启动后所有消息都是 semantic-no，
      // 14:17 第一次触发就死在这里。
      if (proto.__dshSuiteSessionCtor !== true) {
        const construct = proto.registerScopePromptInjection
        if (typeof construct === 'function') {
          proto.registerScopePromptInjection = function registerScopePromptInjection(...args) {
            try {
              const target = active()
              target.sessionManager = this
              // 官方会话模块的 config 里就有工作区（`resolveAgentCwd(this.config.cwd)`），
              // 记下来之后 guard / 设置页都不用再去读宿主的 cordis.patch.yml。
              noteWorkspaceOf(target, this)
              // 这条日志是「冷场到底能不能工作」的分水岭：有它说明捕获时机对上了，
              // 没有它（只有 startup 里的 sessionCaptured:false）说明补丁打晚了。
              target.suite?.logDebug?.({ reason: 'session-captured', allow: true, text: 'SessionManager 已捕获' })
            } catch {
              // 存不下不影响会话正常注册
            }
            return construct.apply(this, args)
          }
          Object.defineProperty(proto, '__dshSuiteSessionCtor', { value: true, enumerable: false })
        }
      }

      // ── 兜底捕获 ────────────────────────────────────────────────
      // 构造期补丁打晚了（例如先起了 dsh-qqbot 再装插件）也还能救：
      // 下一条放行的消息走 getOrCreate 时顺手记一次。
      const original = proto.getOrCreate
      proto.getOrCreate = async function getOrCreate(...args) {
        const record = await original.apply(this, args)
        try {
          const target = active()
          target.sessionManager = this
          noteWorkspaceOf(target, this)
        } catch {
          // 存不下不影响这次会话
        }
        return record
      }
      Object.defineProperty(proto, '__dshSuiteSessionHook', { value: true, enumerable: false })
      applied += 1
    } catch (error) {
      logger?.warn?.(
        `[qqbot-suite] patch session manager ${entry} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return applied
}

/**
 * 装冷场用的会话捕获补丁：目录定位按 `scanPlan`（loader 锚定优先，env 猜测退路），
 * 一个都没打上、且计划允许兜底时才退回扫描全部 profile。
 */
async function installSessionCapture(ctx) {
  const logger = ctx?.logger ?? console
  const plan = scanPlan(ctx)
  let applied = await patchSessionEntries(sessionEntrypoints(plan.dirs), logger)
  if (applied === 0 && plan.sweep) {
    const fallback = sessionEntrypoints(allProfileDirs())
    if (fallback.length > 0) {
      logger?.warn?.('[qqbot-suite] 当前 profile 找不到 dsh-qqbot 会话模块，退回扫描全部 profile')
      applied += await patchSessionEntries(fallback, logger)
    }
  }
  return applied
}

/** 冷场相关的日志：只进调试文件，不占设置页的「最近一次判断」。 */
function logIdle(target, groupId, decision, reason, now, fired = false) {
  try {
    const entry = decision?.entry ?? {}
    target.suite?.logDebug?.({
      reason: fired === true ? 'idle-fire' : 'idle-skip',
      allow: true,
      mode: target.mode,
      group: truncate(groupId, 32),
      sender: truncate(entry.senderId ?? '', 48),
      text: truncate(entry.text ?? '', 140),
      idleMs: Number.isFinite(entry?.at) ? now - entry.at : 0,
      kind: decision?.kind ?? '',
      minutes: target.idle?.minutes,
      ...(fired === true ? {} : { skip: reason }),
    })
  } catch {
    // 日志失败不影响说话
  }
}

/**
 * 冷场补回时，那条消息自己的图片路径块。
 *
 * 只认 `image.mode = 'agent'`：另外两种模式图片根本没下载，索引里不会有行。
 * 查不到（索引被上限滚掉、文件已删）就返回空串——正文退回只有 `[图片×1]`，
 * 跟改动前一样，不会更糟。
 */
function idleImageBlock(target, groupId, entry) {
  if (target.imageMode !== 'agent') return ''
  const file = target.suite?.paths?.imageIndex ?? ''
  const messageId = typeof entry?.id === 'string' ? entry.id : ''
  if (file === '' || messageId === '') return ''
  const block = messageImageBlock(file, { groupId, messageId })
  logImageHandoff(target, 'idle-recall', groupId, messageId, imagePathsOfBlock(block))
  return block
}

/**
 * 真正把话送进 agent。
 * @returns `{ ok, reason }`：ok 为假时 reason 是跳过原因，会写进调试日志。
 */
async function fireIdle(target, manager, groupId, decision, ring, now) {
  const entry = decision.entry !== null && typeof decision.entry === 'object' ? decision.entry : {}
  const replyTarget = { scope: 'group', targetId: groupId }
  // 5 分钟内的消息走被动回复；超了由官方 reply-target 自动降级成主动推送
  // （2026-11-09 实测两个群都 200，见 .workbuddy/memory）。
  if (typeof entry.id === 'string' && entry.id !== '') replyTarget.msgId = entry.id

  const senderId = typeof entry.senderId === 'string' ? entry.senderId : ''
  const record = await manager.getOrCreate('group', groupId, senderId, replyTarget)
  const agent = record?.agent
  if (agent === null || agent === undefined || typeof agent.followup !== 'function') {
    return { ok: false, reason: 'no-agent' }
  }
  // 上一轮还在跑：这时候插一句会打断它（followup 会排队），而且正文还没决定说什么。
  if (agent.status === 'running') return { ok: false, reason: 'agent-busy' }

  const historyBlock = historyBlockFor(ring, target.historyConfig)
  // 补回时必须把那条自己的图一起给：被拦下的图没进过官方正文，只凭 `[图片×1]`
  // 它既看不到内容也没法 read_image，实测就输出一句「不接」直接发进群。
  const imageBlock = decision.kind === 'missed' ? idleImageBlock(target, groupId, entry) : ''
  const body = decision.kind === 'missed'
    ? missedBody(entry, historyBlock, { imageBlock })
    : chatBody({ minutes: target.idle.minutes, entry, historyBlock })
  // 设置页「Prompt 设置」的覆盖：historyBlock / imageBlock 都已拼进 body，一次替换全带走。
  const text = typeof target.suite?.copy === 'function' ? target.suite.copy(body) : body
  // 打标记要在 followup 之前：这一轮的 `system-prompt/assemble` 紧接着就会跑，
  // 标记到了才会追加「先看图」那段例外（见 index.js: watchColdStartPrompt）。
  markColdStart(agent)
  agent.followup(userMessageOf(text))
  return { ok: true, reason: decision.kind }
}

/**
 * 跳过类日志：同一条消息、同样的原因只记一次。
 *
 * 扫描是 30 秒一轮，`no-session-manager` 这类状态会持续存在，不去重的话
 * 日志会每半分钟长一行，真正有用的第一条反而被淹掉。
 */
function logIdleOnce(target, groupId, decision, reason, now) {
  const entry = decision?.entry ?? {}
  const key = `${reason}:${entry.id ?? ''}:${Number.isFinite(entry.at) ? entry.at : ''}`
  const logged = target.idleSkipLogged
  if (logged instanceof Map && logged.get(groupId) === key) return
  logged?.set?.(groupId, key)
  logIdle(target, groupId, decision, reason, now)
}

/** 扫一遍所有群。async 是因为 getOrCreate 可能要 resume；群之间互不阻塞。 */
async function scanIdle(target, logger) {
  if (target.idle?.enabled !== true) return
  const tracker = target.idleTracker
  const manager = target.sessionManager
  const now = Date.now()
  for (const groupId of target.historyRing.groupIds()) {
    if (target.idleBusy.has(groupId)) continue
    const ring = target.historyRing.list(groupId)
    const decision = decideIdle({
      ring,
      state: tracker.stateOf(groupId),
      config: target.idle,
      now,
      since: target.startedAt,
    })
    if (decision.kind === 'none') {
      if (decision.mute === true) tracker.muteForDay(groupId, now)
      // 冷却单独留一条（同一条消息只记一次）：以前它是静默返回，
      // 排查时只看到日志空白，会误判成「扫描器没跑」。
      else if (decision.reason === 'cooldown') {
        logIdleOnce(target, groupId, { kind: 'none', entry: ring[ring.length - 1] }, 'cooldown', now)
      }
      continue
    }
    // 没有会话管理器就拿不到 record，agent 说了也发不出去：宁可不说。
    //
    // 这里**不能** noteFailed：它会把 lastFireAt 设成现在，于是整个冷却窗口
    // （`idle.cooldownMinutes`，默认 60 分钟）都不再重试。manager 缺失是插件自己的状态问题
    // （捕获时机没到），不是「这条消息处理失败」，一次错过不该冻结一小时。
    if (manager === null || typeof manager.getOrCreate !== 'function') {
      logIdleOnce(target, groupId, decision, 'no-session-manager', now)
      continue
    }
    target.idleBusy.add(groupId)
    try {
      const result = await fireIdle(target, manager, groupId, decision, ring, now)
      if (result.ok === true) {
        tracker.noteFired(groupId, decision.entry, now)
        target.idleSkipLogged?.delete?.(groupId)
      } else if (!TRANSIENT_IDLE_SKIPS.has(result.reason)) {
        // 只有真出错的才进冷却；agent 正在跑、拿不到 agent 都是暂时的，
        // 下一轮（30 秒后）再看一眼就行。
        tracker.noteFailed(groupId, now)
      }
      if (result.ok === true) {
        logIdle(target, groupId, decision, result.reason, now, true)
        noteIdleRecord(target, {
          at: now,
          group: groupId,
          kind: decision.kind,
          ok: true,
          reason: result.reason,
          minutes: target.idle?.minutes,
          sender: typeof decision.entry?.senderId === 'string' ? decision.entry.senderId : '',
          name: typeof decision.entry?.name === 'string' ? decision.entry.name : '',
          text: typeof decision.entry?.text === 'string' ? decision.entry.text.slice(0, 80) : '',
        })
      } else logIdleOnce(target, groupId, decision, result.reason, now)
    } catch (error) {
      tracker.noteFailed(groupId, now)
      logIdleOnce(
        target,
        groupId,
        decision,
        error instanceof Error ? error.message : String(error),
        now,
      )
    } finally {
      target.idleBusy.delete(groupId)
    }
  }
}

/** 起扫描定时器，返回 dispose。`unref` 让它不拖住进程退出。 */
function startIdleScanner(target, logger) {
  const timer = setInterval(() => {
    void scanIdle(active(), logger)
  }, IDLE_SCAN_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

// ── 出站格式：这条回复发 markdown 还是纯文本（档位见 config.js: REPLY_FORMATS）──
//
// 为什么要有这一层：官方 dsh-qqbot 0.5.5 的回复固定走 `bot.sendMarkdown`
// （outbound.js:213），报文是 `{markdown, msg_type:2}`；旧版 QQ 客户端不认这个类型，
// 整条只显示「暂不支持该消息类型，请用手机QQ查看」。官方 SDK 的 `markdownSupport`
// 是构造期的全局布尔（QQBot.js:112），没法按条选，所以只能在出站这一层改写报文。
//
// 判错的代价不对称：判成 markdown 而客户端不认 → 这条消息直接看不见；判成纯文本 →
// 只是没有排版（代码块、表格的符号会露出来）。所以 auto 档只在「正文有明确的多行
// 结构」时才发 markdown，其余一律纯文本。

/** `msg_type:0` = 纯文本（官方只有 0/2/3/7 四种发送侧类型）。 */
const MSG_TYPE_TEXT = 0

/** 连续满足条件的最长行数。 */
function longestRun(lines, hit) {
  let best = 0
  let run = 0
  for (const line of lines) {
    if (hit(line)) {
      run += 1
      if (run > best) best = run
    } else {
      run = 0
    }
  }
  return best
}

/**
 * 正文里有没有「必须用 markdown 才说得清」的结构。
 *
 * 只认：代码块 / 表格 / 连续两条以上列表 / 标题 / 引用块。
 * 单行的 `**加粗**`、行内 `code` 不算——它们降级成纯文本只是多两个符号，
 * 反过来把一句闲聊判成 markdown，在旧客户端上就是整条看不见。
 */
function wantsMarkdown(text) {
  if (typeof text !== 'string' || text === '') return false
  if (text.includes('```')) return true
  const lines = text.split('\n')
  if (lines.some((line) => /^\s{0,3}#{1,6}\s+\S/.test(line))) return true
  if (lines.some((line) => /^\s{0,3}>\s+\S/.test(line))) return true
  // 表格：分隔行（|---|:--:|）或连续两行以 | 开头
  if (lines.some((line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))) return true
  if (longestRun(lines, (line) => /^\s*\|.*\|\s*$/.test(line)) >= 2) return true
  // 列表：连续两条以上才算，避免「- 什么」这种口语被当成列表
  if (longestRun(lines, (line) => /^\s{0,3}(?:[-*+]|\d+[.)])\s+\S/.test(line)) >= 2) return true
  return false
}

/**
 * markdown 报文 → 纯文本报文。
 *
 * 官方硬约束：传了 `markdown` 之后 `content` 必须为空（否则 400 / 40034011）；
 * 反过来不显式给 `msg_type` 时，SDK 见到 `markdown` 字段会自己推断成 2
 * （qqbot-nodejs/dist/protocol/api/messages.js:127）。所以两个字段必须一起换。
 */
function asPlainPayload(opts) {
  const content = typeof opts?.markdown?.content === 'string' ? opts.markdown.content : ''
  if (content.trim() === '') return opts
  const next = { ...opts }
  delete next.markdown
  next.msgType = MSG_TYPE_TEXT
  next.content = content
  return next
}

/**
 * 按当前档位决定这条报文要不要降级。
 * 带键盘的报文（问答卡、审批卡）永远保持 markdown —— 键盘是挂在 markdown 报文上的。
 */
function replyPayloadOf(target, opts, text) {
  const format = target?.replyFormat === 'markdown' || target?.replyFormat === 'text'
    ? target.replyFormat
    : 'auto'
  if (format === 'markdown') return opts
  if (opts?.keyboard !== undefined && opts?.keyboard !== null) return opts
  if (format === 'auto' && wantsMarkdown(text)) return opts
  return asPlainPayload(opts)
}

/** 把补丁前的原始方法放回 prototype，好让新模块实例重新包一层。 */
function restoreOriginals(proto) {
  const originals = proto[ORIGINALS_KEY]
  if (originals === null || typeof originals !== 'object') return
  for (const key of ['emit', 'send', 'sendText', 'handleInboundMessage']) {
    if (typeof originals[key] === 'function') proto[key] = originals[key]
  }
}

/** 给一个 QQBot 类打补丁。返回是否成功。 */
function patchClass(QQBot, logger) {
  const proto = QQBot?.prototype
  if (proto === undefined || typeof proto.emit !== 'function') return false

  // off/on 重载时 Node 会换一份新的模块实例，但 prototype 上的补丁留了下来。
  // 直接 return 会让旧闭包一直生效（改包装层也不生效），所以先把方法还原成
  // 最初的实现，再用当前代码重新包一层。
  if (proto.__dshQqbotSuiteGate === true) restoreOriginals(proto)

  const originalEmit = proto.emit
  proto.emit = function emit(event, ...args) {
    // 顺手记住实例：设置页「群健康」要借它的 tokenManager / apiClient 发只读请求，
    // 这样既不用读 AppSecret，也不用另开一条出站链路。ready 事件也会走这里。
    const current = active()
    if (current.bot !== this && current.suite?.noteBot !== undefined) {
      try {
        current.suite.noteBot(this)
        current.bot = this
      } catch {
        // 记不上不影响消息处理
      }
    }
    // 工作区不走文件：manager 实例上就有（重载后接过来的那份也算）。
    try {
      noteWorkspaceOf(current, current.sessionManager)
    } catch {
      // 同上
    }
    if (event !== 'message') return originalEmit.apply(this, [event, ...args])
    const ctx = args[0]
    // 先把窗口摆到 ctx.state.history：闸门的语义判断读的就是它（官方缓冲
    // 已经因为「回答后清空」缩水到一两条，甚至 0 条）。
    try {
      primeGroupHistory(current, ctx)
    } catch {
      // 摆不上历史不影响判断
    }
    return Promise.resolve(current.decide(ctx))
      .then(async (allow) => {
        // 图片文字要在记环之前算好：历史条目和当前正文共用同一份（见 images.js）。
        // 被拦下的消息不跑 reader（不白花 OCR/读图的钱），只留占位符。
        if (allow === true) {
          try {
            const imageText = await resolveImageText(current, ctx)
            if (imageText !== '') ctx.message.suiteImageText = imageText
          } catch {
            // reader 出问题就当没有，占位符会在记环时兜底
          }
        }
        try {
          // 索引要在丢消息之前写：被拦下的那条正是以后要召回的那张图。
          rememberImageIndex(current, ctx)
        } catch {
          // 记不上索引不影响消息本身，下次 @ 时顶多读不到这张
        }
        try {
          // 记环的同时把「冷场」要用的两件事一起处理：
          // 有人说话 → 之前待补回的那条作废；这条又被语义拦下 → 重新登记。
          const remembered = rememberGroupMessage(current, ctx, allow === true)
          if (remembered !== null) {
            current.idleTracker.noteInbound(remembered.groupId)
            if (allow === false && ctx?.suiteReason === 'semantic-no') {
              current.idleTracker.noteMissed(remembered.groupId, remembered.entry)
            }
          }
        } catch {
          // 记账失败不影响消息本身
        }
        if (allow === false) {
          const message = ctx?.message
          logger?.[current.debug ? 'info' : 'debug']?.(
            `[qqbot-suite] ignore group message (${message?.messageId ?? '?'}): not addressed`,
          )
          return undefined
        }
        // 放行后开始计时：超过 timeout.ms 还没回复就中断这一轮。
        // 必须在注入历史之前调用：看门狗拿原始正文跟 agent 收到的正文比对。
        try {
          startWatch(current, ctx)
        } catch {
          // 计时失败不影响消息本身
        }
        try {
          injectGroupHistory(current, ctx)
        } catch {
          // 注入失败就当这条没有历史
        }
        try {
          // 被摘掉的图片留个占位符（或 reader 产出的文字）：不然 agent 看到的就是
          // 一条「什么都没有」的消息。放在看门狗登记之后，正文前缀不受影响。
          applyImageText(ctx?.message, ctx?.message?.suiteImageText)
        } catch {
          // 补不上不影响这条消息本身
        }
        try {
          // 同一批里被让位的其他引用：协议层一条消息只挂一个引用，剩下的当普通文字补。
          applyDroppedQuotes(ctx?.message)
        } catch {
          // 补不上不影响这条消息本身
        }
        try {
          // 历史图片路径：同样只能追加在末尾（看门狗按正文子串配对，前缀不能动）。
          applyRecallBlock(current, ctx)
        } catch {
          // 注入失败就当这条没有历史图片
        }
        try {
          logCurrentImages(current, ctx)
        } catch {
          // 日志失败不影响这条消息
        }
        return originalEmit.apply(this, [event, ...args])
      })
      .catch((error) => {
        logger?.warn?.(`[qqbot-suite] gate failed open: ${error instanceof Error ? error.message : String(error)}`)
        try {
          rememberGroupMessage(current, ctx, false)
        } catch {
          // 同上
        }
        return originalEmit.apply(this, [event, ...args])
      })
  }

  const originalSend = proto.send
  if (typeof originalSend === 'function') {
    proto.send = function send(opts) {
      const text = opts?.markdown?.content ?? opts?.content
      const scope = opts?.target?.scope
      const targetId = opts?.target?.targetId
      // 冷场补回那一轮：agent 常常把「决定不回」写成正文发出来（「不接」）。
      // 它本意是沉默，只是把决策标签当成了话，这里按「不说话」处理。
      if (isIdleLabel(active(), scope, targetId, text)) {
        dropQuiet(active(), scope, targetId, text, 'idle-label-drop')
        return Promise.resolve(undefined)
      }
      // 「不说话」的正规表达是空输出；模型偶尔改用一句说明来代替，
      // 那会变成群里一条莫名其妙的消息（真发生过），这里直接吞掉。
      if (isNonReply(text)) {
        dropQuiet(active(), opts?.target?.scope, opts?.target?.targetId, text)
        return Promise.resolve(undefined)
      }
      try {
        recordBotText(active(), opts?.target?.scope, opts?.target?.targetId, text)
        noteGroupReply(active(), opts?.target?.scope, opts?.target?.targetId)
      } catch {
        // 记录失败不影响发送
      }
      // 出站格式：所有回复最终都从这一层过（`sendMarkdown` 内部也是调 `this.send`），
      // 所以降级只在这里做一次；改写失败就按原样发，不能因为排版判断吞掉消息。
      const target = active()
      let payload = opts
      try {
        payload = replyPayloadOf(target, opts, text)
      } catch {
        payload = opts
      }
      if (payload !== opts) {
        try {
          target?.suite?.logDebug?.({
            reason: 'reply-plain',
            allow: true,
            format: target?.replyFormat ?? 'auto',
            chars: typeof text === 'string' ? text.length : 0,
            text: truncate(text, 40),
          })
        } catch {
          // 日志失败不影响发送
        }
      }
      return originalSend.call(this, payload)
    }
  }

  const originalSendText = proto.sendText
  if (typeof originalSendText === 'function') {
    proto.sendText = function sendText(target, content) {
      if (isIdleLabel(active(), target?.scope, target?.targetId, content)) {
        dropQuiet(active(), target?.scope, target?.targetId, content, 'idle-label-drop')
        return Promise.resolve(undefined)
      }
      if (isNonReply(content)) {
        dropQuiet(active(), target?.scope, target?.targetId, content)
        return Promise.resolve(undefined)
      }
      try {
        recordBotText(active(), target?.scope, target?.targetId, content)
        noteGroupReply(active(), target?.scope, target?.targetId)
      } catch {
        // 同上
      }
      return originalSendText.call(this, target, content)
    }
  }

  // 链之前的预处理：斜杠白名单 + 群聊图片预过滤（+ 多条消息合并）。
  // 斜杠命令必须拦在中间件链之前，否则 slash-command 已经把命令执行了；
  // 图片则必须拦在 attachmentProcessor 之前，否则图已经下载到 media 目录了。
  // 合并同理：攒消息必须发生在所有中间件之前，放出去的才是一条干净的原生消息。
  const originalHandle = proto.handleInboundMessage
  if (typeof originalHandle === 'function') {
    proto.handleInboundMessage = function handleInboundMessage(raw) {
      const current = active()
      // 合并关着时 deferInbound 第一行就返回 false，这条路跟以前完全一致。
      try {
        if (deferInbound(current, this, originalHandle, raw) === true) return undefined
      } catch {
        // 聚合器自己出问题就退回原行为：这条照常立刻进链，不连累消息。
      }
      return deliverInbound(this, originalHandle, current, raw)
    }
    try {
      // 给 install() 的启动日志留个标记，确认这一层真的挂上了。
      Object.defineProperty(proto.handleInboundMessage, '__dshSlashHook', { value: true, enumerable: false })
    } catch {
      // 标不上不影响补丁本身
    }
  }

  try {
    const previous = proto[ORIGINALS_KEY] ?? {}
    proto[ORIGINALS_KEY] = {
      emit: previous.emit ?? originalEmit,
      send: previous.send ?? (typeof originalSend === 'function' ? originalSend : undefined),
      sendText: previous.sendText ?? (typeof originalSendText === 'function' ? originalSendText : undefined),
      handleInboundMessage: previous.handleInboundMessage
        ?? (typeof originalHandle === 'function' ? originalHandle : undefined),
    }
  } catch {
    // 存不下原始方法就退化成「重载后不刷新包装层」
  }

  if (proto.__dshQqbotSuiteGate !== true) {
    Object.defineProperty(proto, '__dshQqbotSuiteGate', { value: true, enumerable: false })
  }
  return true
}

/** 给一批入口文件打补丁，返回打上的实例数与斜杠钩子数。 */
async function patchSdkEntries(entries, logger) {
  let applied = 0
  let inboundHooks = 0
  for (const entry of entries) {
    try {
      const mod = await import(pathToFileURL(entry).href)
      if (patchClass(mod?.QQBot, logger)) applied += 1
      if (mod?.QQBot?.prototype?.handleInboundMessage?.__dshSlashHook === true) inboundHooks += 1
    } catch (error) {
      logger?.warn?.(`[qqbot-suite] patch ${entry} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { applied, inboundHooks }
}

/**
 * 给进程里的 qqbot-nodejs 实例打补丁。
 *
 * 目录定位按 `scanPlan`：loader 锚定的 profile 目录优先，`DSH_PROFILE` 猜测和
 * 「扫全部 profile」都只是退路（后者在 loader 明确说官方插件没配时直接不做）。
 * 官方插件被禁用时照常安装：补丁按模块实例幂等，重新启用官方插件后即生效。
 */
async function install(ctx) {
  const logger = ctx?.logger ?? console
  const plan = scanPlan(ctx)
  let { applied, inboundHooks } = await patchSdkEntries(sdkEntrypoints(plan.dirs), logger)
  if (applied === 0) {
    if (plan.sweep) {
      const fallback = sdkEntrypoints(allProfileDirs())
      if (fallback.length > 0) {
        logger?.warn?.('[qqbot-suite] 当前 profile 找不到 qqbot-nodejs，退回扫描全部 profile')
        const retried = await patchSdkEntries(fallback, logger)
        applied += retried.applied
        inboundHooks += retried.inboundHooks
      }
    } else {
      logger?.warn?.('[qqbot-suite] loader 里没有官方 QQ 插件条目，不扫描其它 profile')
    }
  }
  // 斜杠白名单挂在 handleInboundMessage 上；启动时记一条，方便确认补丁真的生效了。
  // official 是 loader 视角的事实：loaded = 条目在且没禁用；disabled = 条目在但被
  // 禁用（补丁照装，等官方插件回来）；missing = 没配；unknown = loader 缺席（走了
  // 旧扫描）。requireMention 开着时未 @ 的消息到不了闸门，一并记出来，排查
  // 「semantic 全不回」时省得猜。
  const official = plan.facts === undefined
    ? 'unknown'
    : plan.facts.found !== true ? 'missing' : plan.facts.disabled === true ? 'disabled' : 'loaded'
  active().suite?.logDebug?.({
    reason: 'gate-install',
    allow: true,
    sdk: applied,
    inboundHook: inboundHooks,
    official,
    ...(plan.facts?.requireMention === true ? { officialRequireMention: true } : {}),
  })
  if (plan.facts?.disabled === true) {
    logger?.warn?.('[qqbot-suite] 官方 QQ 插件当前被禁用：补丁照常安装，重新启用官方插件后即生效')
  }
  if (applied === 0) {
    logger?.warn?.('[qqbot-suite] 没有找到可用的 qqbot-nodejs，闸门未安装')
    return false
  }
  logger?.info?.(`[qqbot-suite] 群聊消息闸门已就绪（${applied} 个 SDK 实例）`)
  return true
}

/** 插件入口。 */
export async function apply(ctx) {
  const suite = ctx.qqbotSuite ?? ctx.get?.('qqbotSuite')
  if (suite === undefined) {
    ctx.logger?.warn?.('[qqbot-suite] qqbotSuite service unavailable, gate skipped')
    return
  }

  state.suite = suite
  state.judge = (messageCtx) => suite.judge(messageCtx)
  state.decide = (messageCtx) => shouldAnswer(active(), messageCtx)
  applyConfig(state, suite.current())
  // 兜底：如果这份 state 不是当前全局（多份模块实例并存），也把它的环接过来。
  // 主线继承在模块顶层 `adoptState()` 里做，因为那句赋值会先覆盖掉旧 state。
  const previous = globalThis[GLOBAL_KEY]
  if (previous !== null && typeof previous === 'object' && previous !== state) {
    const ring = previous.historyRing
    if (ring !== null && typeof ring === 'object' && typeof ring.push === 'function' && typeof ring.list === 'function') {
      state.historyRing = ring
    }
  }
  globalThis[GLOBAL_KEY] = state
  try {
    syncHistoryFile(state, suite)
  } catch {
    // 回填失败就用内存里的（空）
  }

  const mergeNow = mergeConfig(state)
  // 冷场要拿 dsh-qqbot 的会话管理器：patch 一次，之后每次官方建/取会话都会留下引用。
  let sessionHooks = 0
  try {
    sessionHooks = await installSessionCapture(ctx)
  } catch {
    // 拿不到就降级：冷场触发时会记 no-session-manager，不会硬发
  }
  // 重载把旧的 SessionManager 实例接过来了：立刻把它的 cwd 交给套件，
  // 设置页和 guard 不用等群里下一条消息。纯内存读，不碰任何文件。
  noteWorkspaceOf(active(), active().sessionManager)
  suite.logDebug?.({
    reason: 'startup',
    allow: true,
    mode: state.mode,
    imageMode: state.imageMode,
    imageRecall: state.imageRecall,
    // 合并配置：开着才写窗口，关着就是 false（翻日志一眼能看出「到底开没开」）。
    merge: mergeNow.enabled ? mergeNow.windowMs : false,
    // 冷场：开着才写分钟数。sessionManager 只表示补丁打上了；sessionCaptured
    // 才是「真的拿到了实例」——两个分开记，否则冷场停用时会看不出是哪一步断的。
    idle: state.idle.enabled ? state.idle.minutes : false,
    // 冷却也记出来：冷却期间 decideIdle 返回 cooldown 且**不写日志**，
    // 出问题时光看 idle-skip 会以为它没跑，实际是被自己的冷却挡住了。
    idleCooldown: state.idle.enabled ? state.idle.cooldownMinutes : false,
    idleRecall: state.idle.recallMissed,
    // 有几群带着冷场状态（日计数/冷却/待补回）。重载后大于 0 说明状态被正确继承了；
    // 恒为 0 就是继承断了——那时「冷却没生效」会被误当成配置问题。
    idleGroups: state.idleTracker?.groups?.size ?? 0,
    sessionManager: sessionHooks > 0,
    sessionCaptured: active().sessionManager !== null,
    // 工作区来源只有这一条（manager.config.cwd）。空串 = 还没捕获到，
    // 这时 guard 的 deny 会延后到第一次会话建立——翻日志能直接看出是哪种情况。
    botWorkspace: active().suite?.botWorkspace?.() ?? '',
    slashIds: state.slashAllow.size,
    text: 'qqbot-suite gate ready',
  })

  suite.setRecentProvider((groupId) => recentTexts(active(), groupId))

  // 超时看门狗靠这两个 agent 事件把「群」和「agent」配对 / 在轮末停表。
  // 它们是 agent 作用域派发的，根作用域监听器必须带 global 才收得到。
  try {
    ctx.on('agent/inbox/inserted', (payload) => bindWatchAgent(active(), payload), { global: true })
    ctx.on('agent/status', (payload) => noteAgentStatus(active(), payload), { global: true })
  } catch (error) {
    ctx.logger?.warn?.(`[qqbot-suite] timeout watchdog events unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    ctx.effect(() => suite.subscribe((config) => {
      applyConfig(active(), config)
      try {
        syncHistoryFile(active(), suite)
      } catch {
        // 改不了落盘路径就继续写旧位置
      }
    }), 'qqbot-suite:gate-config')
  } catch {
    // 没有 effect 能力时只应用启动时的配置
  }

  const logger = ctx.logger ?? console
  await install(ctx)

  // 冷场扫描：判定在 idle.js，这里每 30 秒看一遍有记录的群。
  try {
    ctx.effect(() => startIdleScanner(active(), logger), 'qqbot-suite:idle')
  } catch {
    // 没有 effect 能力时不主动说话（比留一个拆不掉的定时器好）
  }
}

// 测试专用导出：只在设置了 QQBOT_SUITE_DEV=1 的进程里注入（`node dev/tests/run.mjs`），
// 正常运行（dsh 加载本包）时是 undefined，不暴露任何内部状态。
export const __test = process.env.QQBOT_SUITE_DEV === '1'
  ? {
  state,
  shouldAnswer: (ctx) => shouldAnswer(active(), ctx),
  recordBotText: (scope, targetId, text) => recordBotText(active(), scope, targetId, text),
  addName: (value, stripSuffix = false) => addName(active().names, value, stripSuffix),
  applyConfig: (config) => applyConfig(active(), config),
  recentTexts: (groupId) => recentTexts(active(), groupId),
  // profile / 官方插件发现（loader 优先、env 猜测退路；三个都是纯函数，接假 ctx）
  loaderProfileDir: (ctx) => loaderProfileDir(ctx),
  officialQqbotFacts: (ctx) => officialQqbotFacts(ctx),
  scanPlan: (ctx) => scanPlan(ctx),
  // 斜杠命令白名单
  filterSlashMessage: (message) => filterSlashMessage(active(), message),
  splitLeadingSlash,
  norm,
  // 链之前的图片预过滤
  stripGroupImagesEarly: (message) => stripGroupImagesEarly(active(), message),
  prepareInbound: (message) => prepareInbound(active(), message),
  // 多条消息合并：配置 / 点名旁路 / 合成规则 / 队列长度 / 手动放干净
  mergeConfig: () => mergeConfig(active()),
  shouldBypassMerge: (message) => shouldBypassMerge(active(), message),
  composeMergeBatch,
  droppedQuotesBlock,
  quotedImagePath,
  applyDroppedQuotes,
  mergeQueueSize: (groupId = '') => {
    const queue = active().mergeQueue.get(groupId)
    return queue === undefined ? 0 : queue.reduce((sum, item) => sum + item.messages.length, 0)
  },
  flushMerges: () => flushAllMerges(active()),
  keepsImageFiles: () => keepsImageFiles(active()),
  applyGroupImagePolicy: (message) => applyGroupImagePolicy(active(), message),
  resolveImageText: (ctx) => resolveImageText(active(), ctx),
  applyImageText,
  // 历史图片召回（写入 + 注入）；两者都接 target，测试可以传假 target 指定索引文件
  rememberImageIndex,
  applyRecallBlock,
  idleImageBlock,
  // 超时看门狗
  startWatch: (ctx) => startWatch(active(), ctx),
  watchCount: () => active().watch.size,
  watchFor: (groupId) => active().watch.get(groupId),
  bindWatchAgent: (payload) => bindWatchAgent(active(), payload),
  noteAgentStatus: (payload) => noteAgentStatus(active(), payload),
  noteGroupReply: (scope, targetId) => noteGroupReply(active(), scope, targetId),
  expireWatch: (groupId) => {
    const entry = active().watch.get(groupId)
    if (entry !== undefined) expireWatch(active(), groupId, entry)
    return entry
  },
  // 群聊上下文（自己记账的那套）
  historyRing: () => active().historyRing,
  adoptState,
  resetHistory: () => {
    active().historyRing = new HistoryRing({ file: active().historyRing.file })
  },
  rememberGroupMessage: (ctx, answered) => rememberGroupMessage(active(), ctx, answered),
  rememberBotText: (groupId, text) => rememberBotText(active(), 'group', groupId, text),
  primeGroupHistory: (ctx) => primeGroupHistory(active(), ctx),
  injectGroupHistory: (ctx) => injectGroupHistory(active(), ctx),
  historyWindowOf: (msg) => historyWindowOf(active(), msg),
  timeoutText: (ms) => timeoutText(active(), ms),
  clearAllWatches: () => clearAllWatches(active()),
  // 出站格式：markdown 还是纯文本（档位 + 按正文判断 + 报文改写）
  replyPayloadOf: (opts, text, format = 'auto') => replyPayloadOf({ replyFormat: format }, opts, text),
  wantsMarkdown,
  setReplyFormat: (format) => {
    active().replyFormat = format
  },
  // 冷场处理（判定纯函数 + 每群状态 + 触发链路）
  idleTracker: () => active().idleTracker,
  decideIdle,
  chatBody,
  missedBody,
  // 冷场那一轮的「先看图」例外：标记 / 清理 / 判定 / 追加的正文
  markColdStart,
  clearColdStart,
  isColdStart,
  coldStartAssembly,
  COLD_START_PROMPT,
  COLD_START_SECTION_NAME,
  historyBlockFor,
  scanIdle: (logger) => scanIdle(active(), logger ?? console),
  fireIdle: (groupId, decision, ring) => fireIdle(
    active(),
    active().sessionManager,
    groupId,
    decision,
    ring ?? [],
    Date.now(),
  ),
  setIdleManager: (manager) => {
    active().sessionManager = manager ?? null
  },
  /** 冷场窗口内的「不接」判定（发送前兜底用，见 isIdleLabel）。 */
  isIdleLabel: (scope, targetId, text) => isIdleLabel(active(), scope, targetId, text),
  // 造官方 user 消息要宿主 llm：测试里注入假模块，省得依赖真实宿主安装。
  setHostLlm,
  userMessageOf,
  patchClass: (klass) => patchClass(klass),
  }
  : undefined
