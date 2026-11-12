/**
 * qqbot-suite/images-recall — 群聊历史图片索引与召回。
 *
 * 解决的问题：图片消息被闸门拦下（没投递给 agent）之后，用户再 @ 它「看看刚才那张图」，
 * agent 手里只有历史环里的一行 `[图片×1]`，没有路径，读不到。这里把「哪张图存在本地」
 * 记成一份索引，放行时按批次注入路径，agent 就能用 `read_image` 自己去读。
 *
 * 为什么单独一个文件、不塞进 history ring：
 *   - 环的正文会被 `flat(120 字)` 截断（history.js: ENTRY_MAX_CHARS），路径放进去会被截没；
 *   - 环是「给人看的聊天记录」，设置页也读它；索引是「给代码查的元数据」；
 *   - 两者生命周期不同：环按条数滚动，索引按磁盘快照重建。
 *
 * 三条硬约束（和用户逐轮确认过，别自行放宽）：
 *   1. **索引是 prune 时刻磁盘图片的快照，不是增量账本**。`reconcileIndex()` 按磁盘上还在的
 *      文件名裁剪，所以「本地实际保存几张图 = 几条索引」。不在 prune 时对账，上游
 *      `media-cleaner` 按 ttlHours 独立删文件（无钩子）会留下幽灵行。
 *   2. **只在 `image.mode === 'agent'` 有意义**。另外两种模式图片在链前就被摘掉、根本不下载，
 *      没有 localPath，写进去全是死行。
 *   3. **一张图一行**。同一条消息的多张图共用一个 `m`（messageId），不是一行存数组。
 *
 * 时间分组只有一个阈值（`gapMinutes`，用户可配）：相邻两张图的发送间隔 > 阈值就换批。
 * 两批之间可能夹着几十条文字消息，按约定不参与判定。
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { clockOf, stableId } from './history.js'
import { collectImages } from './images.js'
// 可改写的提示词原文：与设置页共用同一份常量（设置页看到的原文就是这里用的句子）。
import { PROMPT_TEXT as T } from './prompts.js'

/** 默认：相邻两张图间隔超过 1 分钟就算两批。 */
export const RECALL_GAP_MINUTES = 1
/** 默认：单轮最多注入 4 张（对齐 images.js 的 IMAGE_READER_MAX_IMAGES）。 */
export const RECALL_MAX_IMAGES = 4
/** 设置页用的取值范围（config.js 的校验必须和这里一致）。 */
export const RECALL_GAP_MINUTES_MIN = 1
export const RECALL_GAP_MINUTES_MAX = 60
export const RECALL_MAX_IMAGES_MIN = 1
export const RECALL_MAX_IMAGES_MAX = 20

/** 注入块的标题：和群聊记录块、占位符区分开，模型一眼知道这是更早的图。 */
export const RECALL_BLOCK_TITLE = T['recall.title']
/** 块尾提示：不写这句，模型容易把每张都 read_image 一遍。 */
export const RECALL_BLOCK_HINT = T['recall.hint']

/**
 * 一行索引的结构（键名压到最短，文件小一半）：
 *
 *   t  消息时间（ms，来自 message.timestamp）
 *   g  群 openid
 *   m  messageId（同一条消息的多张图共用）
 *   s  发送者 openid
 *   n  发送者昵称（渲染用）
 *   f  文件名（对账靠它，必须和 media 目录里的名字逐字一致）
 *   p  本地绝对路径（注入给 agent 的就是它）
 *
 * `f` **只能**取 `basename(localPath)`，不能取 `collectImages()` 返回的 `name`：
 * 那个 name 是 QQ 附件原始名（`att.filename`，官方下载器的 map 键），磁盘上落的是
 * `uniqueFilename()` 生成的 `HASH_epoch_rand.ext`，两者永远不等。曾经因为这里取了 name，
 * 每次 prune 对账都 `kept:0` 把索引全清掉，表现为「功能装了但一直召不回任何图」。
 */
export function validRow(row) {
  if (row === null || typeof row !== 'object') return false
  if (typeof row.g !== 'string' || row.g === '') return false
  if (typeof row.f !== 'string' || row.f === '') return false
  if (typeof row.p !== 'string' || row.p === '') return false
  return Number.isFinite(row.t)
}

/** 去重键：同一群里同一条消息的同一个文件只算一张图。 */
export function rowKey(row) {
  return stableId('i', [row?.g, row?.m, row?.f])
}

/**
 * 从一条 QQ 消息里抽出索引行。图片的原样数据交给 `images.js: collectImages()`
 * ——它已经把 `suiteImages` / `attachments` / `downloadedFiles` 三处来源收敛好了，
 * 这里不重复实现（写第二套抽取逻辑是上一版明确禁止的）。
 *
 * 没有 `localPath` 的图直接跳过：下载失败 = 磁盘上没有这个文件 = 没有可召回的图。
 *
 * @returns {Array<object>} 空数组表示这条消息没有可索引的图。
 */
export function rowsOfMessage(message, downloadedFiles = []) {
  if (message === null || typeof message !== 'object') return []
  const g = typeof message.groupOpenid === 'string' ? message.groupOpenid : ''
  if (g === '') return []
  const m = typeof message.messageId === 'string' ? message.messageId : ''
  const s = typeof message.senderId === 'string' ? message.senderId : ''
  const n = typeof message.senderName === 'string' ? message.senderName : ''
  const t = Date.parse(message.timestamp) || Date.now()
  const rows = []
  for (const image of collectImages(message, downloadedFiles)) {
    const p = typeof image?.localPath === 'string' ? image.localPath : ''
    if (p === '') continue
    // 必须用磁盘名，不能用 image.name（QQ 原始名，和磁盘名不是一回事，见文件头注释）。
    const f = basename(p)
    if (f === '') continue
    rows.push({ t, g, m, s, n, f, p })
  }
  return rows
}

/**
 * 合并去重并按时间升序；`limit` > 0 时只保留最新的 N 行。
 * 同一 key 出现两次时留时间更新的那份（重投 / 补写都靠这个覆盖）。
 */
export function mergeRows(existing, incoming, limit = 0) {
  const map = new Map()
  for (const row of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!validRow(row)) continue
    const key = rowKey(row)
    const previous = map.get(key)
    if (previous === undefined || row.t >= previous.t) map.set(key, row)
  }
  const rows = [...map.values()].sort((a, b) => a.t - b.t)
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0
  return cap > 0 && rows.length > cap ? rows.slice(-cap) : rows
}

/**
 * 按「相邻两张图的时间间隔」分批。间隔 **严格大于** 阈值才换批（等于归同批）。
 *
 * @returns {Array<{ start:number, end:number, rows:object[] }>} 旧 → 新。
 */
export function groupBatches(rows, gapMinutes = RECALL_GAP_MINUTES) {
  const minutes = Number(gapMinutes)
  const gapMs = (Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : RECALL_GAP_MINUTES) * 60_000
  const list = (Array.isArray(rows) ? rows : []).filter(validRow).sort((a, b) => a.t - b.t)
  const batches = []
  let current = null
  for (const row of list) {
    if (current === null || row.t - current.end > gapMs) {
      current = { start: row.t, end: row.t, rows: [row] }
      batches.push(current)
    } else {
      current.end = row.t
      current.rows.push(row)
    }
  }
  return batches
}

/**
 * 从最新的一批往前取，够 `maxImages` 张就停；批内按图截断（同一条消息 5 张可能只取到 4 张）。
 *
 * `options.exists(row)` 用来剔掉磁盘上已经不存在的行：**被判死的行不占配额**，
 * 否则 4 个配额可能全被幽灵行占掉，真正有效的图反而进不来。
 * （这不等于「替 agent 处理读不到」——只是别让必然失败的项挤走能用的项。）
 */
export function pickBatches(batches, maxImages = RECALL_MAX_IMAGES, options = {}) {
  const raw = Number(maxImages)
  const cap = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : RECALL_MAX_IMAGES
  const exists = typeof options.exists === 'function' ? options.exists : () => true
  const picked = []
  let used = 0
  for (let i = batches.length - 1; i >= 0 && used < cap; i -= 1) {
    const batch = batches[i]
    const rows = []
    for (let j = batch.rows.length - 1; j >= 0 && used < cap; j -= 1) {
      const row = batch.rows[j]
      if (!exists(row)) continue
      rows.unshift(row)
      used += 1
    }
    if (rows.length > 0) picked.unshift({ start: batch.start, end: batch.end, rows })
  }
  return picked
}

/**
 * 渲染成注入正文的块。前缀固定 `Image: ` —— `index.js: mediaRefsFromBody()` 只认
 * `Image|Video|File:` 开头的行，改了前缀这些图就不受 pin 保护，可能在 agent 读之前被清掉。
 *
 * @returns {string} 空字符串表示没有可注入的内容。
 */
export function renderBlock(batches) {
  if (!Array.isArray(batches) || batches.length === 0) return ''
  const lines = [RECALL_BLOCK_TITLE]
  batches.forEach((batch, index) => {
    const prefix = batches.length > 1 ? `批 ${index + 1} · ` : ''
    lines.push(`- ${prefix}${clockOf(batch.start)} · ${batch.rows.length} 张`)
    for (const row of batch.rows) lines.push(`  - Image: ${row.p}`)
  })
  lines.push(RECALL_BLOCK_HINT)
  return lines.join('\n')
}

/** 读索引文件（容忍半行、脏行、文件不存在）。返回去重后的升序行。 */
export function readIndex(file) {
  if (typeof file !== 'string' || file.trim() === '') return []
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line)
      if (validRow(row)) rows.push(row)
    } catch {
      // 写到一半的行 / 手工改坏的行走跳过，不影响其余
    }
  }
  return mergeRows(rows, [], 0)
}

/**
 * 整份重写（临时文件 + rename 原子替换）。
 *
 * 必须整份重写而不是追加：删除后要让索引和磁盘对齐，只能按「还在的文件」重新生成。
 * rename 在 Windows 上是替换语义，不会留下半个文件；失败就保留旧文件，下次再试。
 */
export function writeIndex(file, rows) {
  if (typeof file !== 'string' || file.trim() === '') return false
  const body = (Array.isArray(rows) ? rows : []).filter(validRow).map((row) => JSON.stringify(row)).join('\n')
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, body === '' ? '' : `${body}\n`, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 临时文件删不掉也不影响主文件
    }
    return false
  }
}

/**
 * 写入新收到的索引行：读 → 合并去重 → 按 `maxFiles` 截断 → 原子重写。
 * `limit` 用 media.maxFiles：索引条数和本地图片数都受同一个上限约束。
 *
 * @returns {number} 写完后的行数（失败返回 0）。
 */
export function appendRows(file, rows, limit = 0) {
  if (!Array.isArray(rows) || rows.length === 0) return 0
  const merged = mergeRows(readIndex(file), rows, limit)
  return writeIndex(file, merged) ? merged.length : 0
}

/** media 目录里当前所有普通文件的名字（对账用；不含子目录）。 */
export function mediaFileNames(dir) {
  const names = new Set()
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) names.add(entry.name)
    }
  } catch {
    // 目录不存在 / 没权限：返回空集合，调用方按「一个文件都没有」处理
  }
  return names
}

/**
 * 按磁盘现状对账：磁盘上已经不存在的文件，对应行删掉。
 *
 * 唯一的调用点是 `index.js: pruneMedia()` —— prune 之后立刻跑一次。上游
 * `media-cleaner.js` 按 ttlHours 独立删文件、没有任何钩子，只有这一处能兜住幽灵行。
 *
 * @returns {{ kept:number, removed:number, written:boolean }}
 */
export function reconcileIndex(file, liveNames) {
  const live = liveNames instanceof Set ? liveNames : new Set(Array.isArray(liveNames) ? liveNames : [])
  const before = readIndex(file)
  if (before.length === 0) return { kept: 0, removed: 0, written: false }
  const kept = before.filter((row) => live.has(row.f))
  if (kept.length === before.length) return { kept: kept.length, removed: 0, written: false }
  writeIndex(file, kept)
  return { kept: kept.length, removed: before.length - kept.length, written: true }
}

/**
 * 给某一条群消息生成召回块（空字符串 = 不注入）。
 *
 * @param {string} file 索引文件路径
 * @param {object} options
 * @param {string} options.groupId 只取这个群的图
 * @param {string} [options.excludeMessageId] 当前这条消息自己，别重复列（它的图走官方正文）
 * @param {number} [options.gapMinutes]
 * @param {number} [options.maxImages]
 * @param {Function} [options.exists] 默认「一律当存在」，测试可注入
 */
export function recallBlockFor(file, options = {}) {
  const groupId = typeof options.groupId === 'string' ? options.groupId : ''
  if (groupId === '') return ''
  const exclude = typeof options.excludeMessageId === 'string' ? options.excludeMessageId : ''
  const rows = readIndex(file).filter((row) => {
    if (row.g !== groupId) return false
    if (exclude !== '' && row.m === exclude) return false
    return true
  })
  if (rows.length === 0) return ''
  const batches = groupBatches(rows, options.gapMinutes)
  // 不探磁盘：索引里的路径属于官方缓存目录，文件在不在由 `read_image` 自己判定。
  const exists = typeof options.exists === 'function' ? options.exists : () => true
  return renderBlock(pickBatches(batches, options.maxImages, { exists }))
}

/** 补回正文里的标题：只说「这条消息里的」，不说「历史」，免得模型以为是更早的图。 */
export const MESSAGE_IMAGE_TITLE = '[这条消息里的图片]'
/** 多图时的块尾提示：不写这句，模型容易把每张都 read_image 一遍。 */
export const MESSAGE_IMAGE_HINT = '[要看哪张就 read_image，不必每张都读。]'
/**
 * 单图时的块尾提示（2026-11-10 加）。
 *
 * 补回的往往是一条「只有图、一个字都没有」的消息，正文里唯一的线索就是这个路径。
 * 原来单图也用多图那句「不必每张都读」，等于当场告诉它「可以不看」：实测它就没看，
 * 然后在群里回两个字「不接」——同一个坑踩了三次（11-09 11:45 / 12:31 / 11-10 11:56）。
 * 单图没有「哪张」可选，提示语必须写成「先看再说」。
 */
export const MESSAGE_IMAGE_HINT_ONE = '[这条消息没有别的文字，内容就是这张图：先 read_image 看清楚，再决定接不接。]'

/**
 * 某**一条**消息自己的图片路径块（空字符串 = 没有可给的行）。
 *
 * 唯一用途是冷场补回（`gate.js: fireIdle`）：官方入站正文里那句 `Image: <路径>` 只在
 * 消息**当时被放行**时才会有，被拦下再补回时正文只剩历史环里的 `[图片×1]` ——
 * agent 手里没有任何路径，只能猜，最后常输出一句「不接」。这里按 messageId 从索引
 * 把那条的图捞回来，格式与 `renderBlock()` 保持一致（`Image: ` 前缀受 pin 保护）。
 *
 * 不按时间窗取、不按批取：补回只能用**这一条**的图，掺进别的条会把上下文搞乱。
 */
export function messageImageBlock(file, options = {}) {
  const groupId = typeof options.groupId === 'string' ? options.groupId : ''
  const messageId = typeof options.messageId === 'string' ? options.messageId : ''
  if (groupId === '' || messageId === '') return ''
  const exists = typeof options.exists === 'function' ? options.exists : () => true
  const rows = readIndex(file).filter((row) => row.g === groupId && row.m === messageId && exists(row))
  if (rows.length === 0) return ''
  return [
    MESSAGE_IMAGE_TITLE,
    ...rows.map((row) => `Image: ${row.p}`),
    rows.length === 1 ? MESSAGE_IMAGE_HINT_ONE : MESSAGE_IMAGE_HINT,
  ].join('\n')
}
