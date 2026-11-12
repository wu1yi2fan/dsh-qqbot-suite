/**
 * qqbot-suite/history — 群聊上下文环形缓冲。
 *
 * 为什么不用官方 `@tencent-connect/dsh-qqbot` 的 historyBuffer：
 *
 *   1. 它**回答完一条就把整个群的缓冲清空**（`dist/transport/inbound.js:48`
 *      的 `clearGroupHistory()`，CHANGELOG 0.5.3「群聊回复后自动清理历史上下文」），
 *      于是下一轮能看到的只有「它上次说话之后群里又说的话」，经常只剩一两条，
 *      遇到「前面有人找你」这种指代就无从判断；
 *   2. 它只在**真 @** 时才拼进 prompt（`buildAgentBody()` 要求 `wasMentioned`），
 *      唤醒词、语义放行这两类消息一条历史都带不上；
 *   3. 缓冲是进程内的 `MemoryHistoryStore`，插件重载 / 进程重启即清零。
 *
 * 这里改成「套件自己记账」：每条群消息（含被闸门拦下的）都进环形缓冲，
 * 回答完只推进状态、**不清空**，注入窗口按条数 + 字数裁剪，可选落盘跨重启回填。
 *
 * 纯函数为主，方便 `dev/tests/test.mjs` 直接测；文件 IO 失败一律吞掉，不能拖累消息处理。
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { imageNoteOf, withImageNote } from './images.js'
// 可改写的提示词原文：与设置页共用同一份常量（设置页看到的原文就是这里用的句子）。
import { PROMPT_TEXT as T } from './prompts.js'

/** 每个群保留的原始条数（注入窗口比这个小得多，留余量是为了「往前翻」）。 */
export const RING_LIMIT = 200
/** 落盘文件的上限，超了轮转成 `.1`（和调试日志一致的做法）。 */
export const HISTORY_LOG_MAX_BYTES = 2 * 1024 * 1024
/** 单条消息进 prompt 时最多留多少字，避免一条长文吃掉整个窗口。 */
export const ENTRY_MAX_CHARS = 120

/** 归一化空白：历史里换行会把块结构撑乱。 */
function flat(value, max = ENTRY_MAX_CHARS) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 本地时间 HH:MM（历史里给人看的是钟点，不是时间戳）。 */
export function clockOf(at) {
  const date = new Date(Number.isFinite(at) ? at : Date.now())
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** 按条数 + 字数取窗口：从新往旧拿，超了就从旧的丢；至少保留最新一条。 */
export function pickWindow(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : []
  // `window` 是套件配置里的字段名，`limit` 是内部/测试用的名字：两个都认，
  // 否则配置里的「注入条数」会被静默忽略（一直用 20 条）。
  const rawLimit = Number.isFinite(options.window) ? options.window : options.limit
  const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 20
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(0, Math.floor(options.maxChars)) : 2000
  if (limit === 0 || list.length === 0) return []
  const picked = []
  let used = 0
  for (let i = list.length - 1; i >= 0 && picked.length < limit; i -= 1) {
    const entry = list[i]
    const cost = flat(entry?.text).length + 24
    if (picked.length > 0 && used + cost > maxChars) break
    picked.push(entry)
    used += cost
  }
  return picked.reverse()
}

/**
 * 渲染成 prompt 里的一段。刻意做成「一眼看出是记录」的块：
 * 首尾都有标记，末尾一句防注入提示（群消息进 prompt 本来就有这个风险）。
 *
 * @returns {string} 空字符串表示没内容可注入。
 */
export function renderHistoryBlock(entries, options = {}) {
  const picked = pickWindow(entries, options)
  if (picked.length === 0) return ''
  const markAnswered = options.markAnswered !== false
  const nameOf = typeof options.nameOf === 'function' ? options.nameOf : (entry) => entry?.name ?? ''
  const lines = picked.map((entry) => {
    const mark = markAnswered && entry?.answered === true ? '✓' : ' '
    const who = flat(nameOf(entry) || entry?.name || entry?.senderId || '某人', 24)
    const id = typeof entry?.senderId === 'string' ? entry.senderId.slice(0, 8) : ''
    const tag = entry?.bot === true || id === '' ? who : `${who}(${id})`
    return `${mark} ${clockOf(entry?.at)} ${tag}：${flat(entry?.text)}`
  })
  const title = markAnswered
    ? `[群聊记录（最近 ${picked.length} 条，旧 → 新；✓ = 你已经回应过）]`
    : `[群聊记录（最近 ${picked.length} 条，旧 → 新）]`
  return [
    '',
    title,
    ...lines,
    T['history.outro'],
  ].join('\n')
}

/**
 * 渲染成 SDK `buildAgentBody()` 认识的 history 条目形状
 * （`{ senderId, senderName, content, messageId, timestamp }`）。
 *
 * 现在只有一条注入路径：非 @ 的消息也走官方 `buildAgentBody()` 渲染，
 * 所以「✓ = 已回复」这个信息只能塞进 content 前缀（官方渲染器不认识额外字段）。
 * 语义判断那条路要传 `markAnswered: false`，否则判定输入里会多一个 ✓。
 */
export function toSdkEntries(entries, options = {}) {
  const markAnswered = options.markAnswered !== false
  return pickWindow(entries, options).map((entry) => {
    const body = flat(entry?.text)
    const mark = markAnswered && entry?.answered === true ? '✓ ' : ''
    return {
      senderId: typeof entry?.senderId === 'string' ? entry.senderId : '',
      senderName: entry?.name ?? '',
      content: `${mark}${body}`,
      messageId: typeof entry?.id === 'string' ? entry.id : '',
      timestamp: Number.isFinite(entry?.at) ? entry.at : Date.now(),
    }
  })
}

/**
 * 图片标签归 `images.js` 管（占位符 / OCR / 读图模型的产出都在那边）。
 * 这里只负责把标签拼进历史条目：
 *   - 放正文**前面**——进 prompt 时正文会被截到 120 字，放后面会被截没；
 *   - 纯图片消息因此也能进环（以前 `text` 为空直接返回 null）。
 */
export { imagePlaceholder, withImageNote } from './images.js'
/** 从 QQ 消息对象里抠出要记的字段。 */
export function entryFromMessage(message) {
  if (message === null || typeof message !== 'object') return null
  const raw = typeof message.content === 'string' ? message.content : ''
  const text = withImageNote(raw, imageNoteOf(message))
  if (text.trim() === '') return null
  return {
    id: typeof message.messageId === 'string' ? message.messageId : '',
    at: Date.parse(message.timestamp) || Date.now(),
    senderId: typeof message.senderId === 'string' ? message.senderId : '',
    name: typeof message.senderName === 'string' ? message.senderName : '',
    text,
    bot: false,
    answered: false,
  }
}

/** 机器人自己发出去的一条（从 send / sendText 补丁里记）。 */
export function botEntry(text, name, at = Date.now()) {
  const body = typeof text === 'string' ? text : ''
  if (body.trim() === '') return null
  // senderId 固定 'bot'：官方那段 `[Chat history begins]` 会渲染成 `[名字 (bot)]`，
  // 留空会变成 `[名字 ()]`。
  return { id: '', at, senderId: 'bot', name: typeof name === 'string' ? name : '', text: body, bot: true, answered: true }
}

/** 回读落盘文件时最多读多少字节：文件上限 2MB，只读尾部就够给设置页翻。 */
export const HISTORY_TAIL_MAX_BYTES = 384 * 1024

/**
 * 只读文件尾部并按行切开的通用工具：日志可能到 2MB，没必要整个读进内存。
 * 起点落在行中间（或多字节字符中间）时丢到第一个换行之后。
 * @returns {string[]} 空数组表示读不到（文件不存在 / 无权限）。
 */
export function readJsonlTail(file, maxBytes = HISTORY_TAIL_MAX_BYTES) {
  if (typeof file !== 'string' || file.trim() === '') return []
  const cap = Number.isFinite(maxBytes) ? Math.max(4096, Math.floor(maxBytes)) : HISTORY_TAIL_MAX_BYTES
  let body = ''
  try {
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      return []
    }
    if (size > cap) {
      const fd = openSync(file, 'r')
      try {
        const buffer = Buffer.alloc(cap)
        const read = readSync(fd, buffer, 0, cap, size - cap)
        body = buffer.subarray(0, read).toString('utf8')
      } finally {
        closeSync(fd)
      }
      const firstBreak = body.indexOf('\n')
      body = firstBreak === -1 ? '' : body.slice(firstBreak + 1)
    } else {
      body = readFileSync(file, 'utf8')
    }
  } catch {
    return []
  }
  return body.split(/\r?\n/).filter((line) => line.trim() !== '')
}

/**
 * 从落盘文件里读最近的记录（旧 → 新）。
 *
 * 为什么单独一个函数而不是复用 `restore()`：`restore()` 只在启动时把文件灌进
 * 内存环、而且有 200 条上限；设置页要的是「随时按需读一眼」，不能为了给页面
 * 翻记录把整个群的原文都常驻内存。这里只读文件尾部（默认 384KB），按
 * `limit` 截断，解析失败的行走跳过——文件正写到一半也不会崩。
 *
 * @returns {Array<{ id, at, group, senderId, name, text, bot, answered }>}
 */
export function readHistoryTail(file, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 300
  const lines = readJsonlTail(file, options.maxBytes)

  const parsed = []
  for (const line of lines) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row === null || typeof row !== 'object') continue
    const group = typeof row.g === 'string' ? row.g : ''
    const text = typeof row.t === 'string' ? row.t : ''
    if (group === '' || text.trim() === '') continue
    parsed.push({
      id: typeof row.id === 'string' ? row.id : '',
      at: Date.parse(row.ts) || 0,
      group,
      senderId: typeof row.s === 'string' ? row.s : '',
      name: typeof row.n === 'string' ? row.n : '',
      text,
      bot: row.b === true,
      answered: row.a === true,
    })
  }

  // 同一 messageId 只留最后一条（以后的「补记」行会覆盖旧行），再从新到旧截断。
  const seen = new Set()
  const deduped = []
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    const entry = parsed[i]
    const key = entry.id === '' ? `${entry.group}|${entry.at}|${entry.text}` : `${entry.group}|${entry.id}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(entry)
  }
  deduped.reverse()
  deduped.sort((a, b) => a.at - b.at)
  return deduped.length > limit ? deduped.slice(-limit) : deduped
}

/** FNV-1a：给聊天记录里的一条算稳定短 id，重启后仍然是同一个。 */
function fnv1a(value, seed) {
  let hash = seed >>> 0
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 稳定短 id：同样的输入永远得到同样的 18 位 id（两个不同种子的 32 位 FNV-1a 拼起来，
 * 样本攒到几千条也不会撞）。`prefix` 用来区分来源：`h` = 聊天记录、`l` = 语义日志。
 */
export function stableId(prefix, parts) {
  const basis = (Array.isArray(parts) ? parts : [])
    .map((value) => String(value ?? ''))
    .join('\u0001')
  return `${prefix}${fnv1a(basis, 0x811c9dc5)}${fnv1a(basis, 0x01000193)}`
}

/**
 * 聊天记录里一条消息的稳定 id。
 * 用它（而不是 messageId）当样本 id：messageId 有一百多字符，而且机器人自己的
 * 发言没有 id；这里按「群 + 消息 id + 时间 + 发送者 + 正文」算，重启、轮转都稳定。
 */
export function historyRowId(entry) {
  if (entry === null || typeof entry !== 'object') return ''
  return stableId('h', [entry.group, entry.id, entry.at, entry.senderId, entry.text])
}

/**
 * 每群一个环。`limit` 是保留条数；`file` 给了就顺带落盘，重启可回填。
 */
export class HistoryRing {
  constructor(options = {}) {
    this.limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : RING_LIMIT
    this.file = typeof options.file === 'string' && options.file.trim() !== '' ? options.file.trim() : ''
    this.groups = new Map()
  }

  /** 追加一条；同一 messageId 重复投递只记一次。 */
  push(groupId, entry) {
    if (typeof groupId !== 'string' || groupId === '') return false
    if (entry === null || typeof entry !== 'object') return false
    if (typeof entry.text !== 'string' || entry.text.trim() === '') return false
    let list = this.groups.get(groupId)
    if (list === undefined) {
      list = []
      this.groups.set(groupId, list)
    }
    if (entry.id !== '' && list.some((item) => item.id === entry.id)) return false
    // 机器人发言没有 messageId：同一句话 3 秒内只记一次（send / sendText 两条分支可能都触发）。
    const last = list[list.length - 1]
    if (
      entry.bot === true &&
      last !== undefined &&
      last.bot === true &&
      last.text === entry.text &&
      Math.abs(entry.at - last.at) < 3000
    ) {
      return false
    }
    list.push(entry)
    if (list.length > this.limit) list.splice(0, list.length - this.limit)
    this.persist(groupId, entry)
    return true
  }

  list(groupId) {
    const list = this.groups.get(groupId)
    return list === undefined ? [] : [...list]
  }

  /** 当前有记录的群 openid（冷场扫描要逐群看最后一条）。 */
  groupIds() {
    return [...this.groups.keys()]
  }

  /** 标记「这条已经交给 agent 了」，渲染时打 ✓。 */
  markAnswered(groupId, id) {
    if (typeof groupId !== 'string' || typeof id !== 'string' || id === '') return false
    const list = this.groups.get(groupId)
    if (list === undefined) return false
    let hit = false
    for (const entry of list) {
      if (entry.id === id && entry.answered !== true) {
        entry.answered = true
        hit = true
      }
    }
    return hit
  }

  clear(groupId) {
    this.groups.delete(groupId)
  }

  size() {
    return this.groups.size
  }

  /** 落盘一行。任何 IO 失败都吞掉——历史记账不能影响消息本身。 */
  persist(groupId, entry) {
    if (this.file === '') return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      let size = 0
      try {
        size = statSync(this.file).size
      } catch {
        size = 0
      }
      if (size >= HISTORY_LOG_MAX_BYTES) {
        try {
          rmSync(`${this.file}.1`, { force: true })
        } catch {
          // 删不掉旧备份就继续追加，最多多占一份
        }
        try {
          renameSync(this.file, `${this.file}.1`)
        } catch {
          // 改名失败就继续写当前文件
        }
      }
      appendFileSync(this.file, `${JSON.stringify({
        ts: new Date(entry.at).toISOString(),
        g: groupId,
        id: entry.id,
        s: entry.senderId,
        n: entry.name,
        t: flat(entry.text, 300),
        b: entry.bot === true,
        a: entry.answered === true,
      })}\n`, 'utf8')
    } catch {
      // 落盘失败不影响内存里的历史
    }
  }

  /**
   * 从落盘文件回填（启动时调用一次）。只在缓冲还空的时候填，避免覆盖本次
   * 进程里已经收到的新消息。返回回填了多少条。
   */
  restore() {
    if (this.file === '' || !existsSync(this.file)) return 0
    if (this.groups.size > 0) return 0
    let text
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return 0
    }
    let restored = 0
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const groupId = typeof row?.g === 'string' ? row.g : ''
      if (groupId === '') continue
      let list = this.groups.get(groupId)
      if (list === undefined) {
        list = []
        this.groups.set(groupId, list)
      }
      if (row.id !== '' && list.some((item) => item.id === row.id)) continue
      list.push({
        id: typeof row.id === 'string' ? row.id : '',
        at: Date.parse(row.ts) || Date.now(),
        senderId: typeof row.s === 'string' ? row.s : '',
        name: typeof row.n === 'string' ? row.n : '',
        text: typeof row.t === 'string' ? row.t : '',
        bot: row.b === true,
        answered: row.a === true,
      })
      restored += 1
    }
    for (const [groupId, list] of [...this.groups]) {
      if (list.length > this.limit) list.splice(0, list.length - this.limit)
      if (list.length === 0) this.groups.delete(groupId)
    }
    return restored
  }
}
