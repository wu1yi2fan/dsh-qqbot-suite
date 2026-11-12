/**
 * 人工标注样本库：人点过确认的语义判断记录，正反两类都收。
 *
 * - `should-reply`（旧名：漏判样本）：这条本该回、但判成了不回；
 * - `should-not-reply`：这条其实不该回、但放行给 agent 了（列表里标「已回」的那些）。
 *
 * 两类都要，因为「该回」和「不该回」是同一条边界的两侧：只有正样本会把判定推向
 * 「多接一句」，越调越吵；只有负样本又会退化成装死。落盘结构和来源完全一样，只多一个
 * `label` 字段，老样本没有这个字段时按 `should-reply` 读（2026-11-04 之前的都是漏判）。
 *
 * 为什么单独一个文件、而不是复用语义日志：
 * - 语义日志受 `debug` 开关控制、1MB 轮转、里面混着大量正常记录，不能当样本集；
 * - 这里只存人点过确认的，条数少、可读、可手改、可备份，以后要让模型改提示词，
 *   输入就是它；
 * - 每条带当时的 system + prompt，否则事后没人能复盘「当时群里在聊什么」。
 *
 * 存储：`<suiteHome>/profiles/<profile>/misses.json`（见 config.js: missesPathOf），
 * JSON 数组，按标记时间升序。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
/** 样本上限：超过就丢最旧的。500 条 ≈ 500KB，够攒很久了。 */
export const MISSES_LIMIT = 500
/** 这条该回（漏判）。 */
export const LABEL_REPLY = 'should-reply'
/** 这条不该回（误判放行）。 */
export const LABEL_SILENT = 'should-not-reply'
export const MISS_LABELS = [LABEL_REPLY, LABEL_SILENT]

/** 归一化 label：认不出的值一律按「该回」处理，老样本没有这个字段也是。 */
export function normalizeLabel(value) {
  return value === LABEL_SILENT ? LABEL_SILENT : LABEL_REPLY
}

/** 正负样本各多少条（设置页那行标签用）。 */
export function countLabels(list) {
  const items = Array.isArray(list) ? list : []
  let reply = 0
  for (const item of items) {
    if (normalizeLabel(item?.label) === LABEL_REPLY) reply += 1
  }
  return { total: items.length, shouldReply: reply, shouldNotReply: items.length - reply }
}

function text(value, max) {
  const body = typeof value === 'string' ? value.trim() : ''
  return body.length > max ? `${body.slice(0, max)}…` : body
}

/**
 * 把一条内存里的判断记录转成落盘格式。
 * 只保留复盘/优化需要的东西：谁的哪句话、当时喂进去的 system + prompt、模型当时怎么答的。
 * `id` 保留，用来在缓冲区里反查、取消标记。
 *
 * `source` 区分证据强度：
 * - `judge`：当时那次判断还在内存里，system/prompt/判定都是原样抄下来的；
 * - `log`：从语义日志里捞回来的历史判定，system/prompt 也是当时逐字的（没经过重建）；
 * - `history`：只剩聊天记录，prompt 是按上下文重建的（`reconstructed: true`），
 *   以后改提示词时别把重建样本当成「当时模型看到的输入」。
 *   `model` 为空 = 当时用的哪个模型也查不到了。
 */
export function toMiss(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const id = text(entry.id, 64)
  if (id === '') return undefined
  const source = entry.source === 'history' || entry.source === 'log' ? entry.source : 'judge'
  const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
  const model = typeof entry.model === 'string' ? entry.model.trim() : ''
  return {
    id,
    label: normalizeLabel(entry.label),
    markedAt: new Date().toISOString(),
    judgedAt: Number.isFinite(entry.at) ? new Date(entry.at).toISOString() : undefined,
    group: text(entry.group, 64),
    sender: text(entry.sender, 64),
    text: text(entry.text, 500),
    // 语义日志里的 model 已经是 `provider/model` 一整串，别拼成 `/xxx`。
    model: provider !== '' && model !== '' ? `${provider}/${model}` : model,
    verdictAtCapture: text(entry.verdict, 16),
    answer: text(entry.answer, 200),
    system: typeof entry.system === 'string' ? entry.system : '',
    prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
    source,
    reconstructed: source === 'history' && entry.reconstructed === true,
    note: '',
  }
}

/** 读样本库；文件不存在、不是数组、某条坏掉都不影响其余记录。 */
export function loadMisses(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => (item !== null && typeof item === 'object' && typeof item.id === 'string' ? item : undefined))
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 写样本库：截断到上限，先写临时文件再改名，避免写一半留下半个 JSON。 */
export function saveMisses(file, list) {
  const items = Array.isArray(list) ? list.slice(-MISSES_LIMIT) : []
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(items, null, 2), 'utf8')
  renameSync(temp, file)
  return items
}

/**
 * 按 id 幂等追加：同一条重复标记不会写出两份。
 * 同一条改了 label（该回 ⇄ 不回）算「改标」，就地替换那一条，不新增、也不留两份互相矛盾。
 */
export function addMiss(list, entry) {
  const items = Array.isArray(list) ? list : []
  const miss = toMiss(entry)
  if (miss === undefined) return { list: items, added: false, relabeled: false }
  const at = items.findIndex((item) => item.id === miss.id)
  if (at === -1) return { list: [...items, miss], added: true, relabeled: false }
  if (normalizeLabel(items[at]?.label) === miss.label) {
    return { list: items, added: false, relabeled: false }
  }
  const next = items.slice()
  next[at] = { ...items[at], label: miss.label, markedAt: miss.markedAt }
  return { list: next, added: false, relabeled: true }
}

/** 取消标记：按 id 删除。 */
export function removeMiss(list, id) {
  const items = Array.isArray(list) ? list : []
  const next = items.filter((item) => item.id !== id)
  return { list: next, removed: next.length !== items.length }
}
