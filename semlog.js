/**
 * 语义日志回读：从 `<logs>/qqbot-suite-semantic.log`（含轮转出来的 `.1`）里捞出
 * 历史判定，补上「聊天记录落盘」上线之前那段空档。
 *
 * 为什么需要它：`qqbot-group-history.jsonl` 只有落盘功能上线之后的消息；更早的群消息
 * 唯一还活着的记录就是语义日志——每条都带当时的 `system` + `prompt` + 模型原始回答，
 * 拿去当样本比按聊天记录重建保真得多（system/prompt 是逐字的，不是猜的）。
 *
 * 边界（别指望它做更多）：
 * - 只有开了「调试日志」且走语义判断的消息才有记录；被 @/唤醒词直接放行的没有；
 * - 日志自己 1MB 轮转，所以最多只能回读到「当前 + 一份 .1」；
 * - 只读，不写、不改日志。
 */
import { readJsonlTail, stableId } from './history.js'

/** 语义日志（含 `.1`）最多各读多少字节。日志轮转上限 1MB，这里留足余量。 */
export const SEMLOG_TAIL_MAX_BYTES = 1024 * 1024

/**
 * 语义日志里一条判定的稳定 id（前缀 `l`，跟聊天记录的 `h` 区分开）。
 * 日志没有 messageId，只能用「群 + 时间 + 发送者 + 正文」定位。
 */
export function semanticRowId(entry) {
  if (entry === null || typeof entry !== 'object') return ''
  return stableId('l', [entry.group, entry.at, entry.sender, entry.text])
}

function normalize(row) {
  if (row === null || typeof row !== 'object') return undefined
  const text = typeof row.text === 'string' ? row.text : ''
  const system = typeof row.system === 'string' ? row.system : ''
  const prompt = typeof row.prompt === 'string' ? row.prompt : ''
  // 没正文或没请求原文的记录，当样本没法复盘，直接丢。
  if (text.trim() === '' || (system === '' && prompt === '')) return undefined
  return {
    at: Date.parse(row.ts) || 0,
    group: typeof row.group === 'string' ? row.group : '',
    sender: typeof row.sender === 'string' ? row.sender : '',
    text,
    verdict: typeof row.verdict === 'string' ? row.verdict : 'unknown',
    answer: typeof row.answer === 'string' ? row.answer : '',
    model: typeof row.model === 'string' ? row.model : '',
    ms: Number.isFinite(row.ms) ? row.ms : 0,
    ok: row.ok !== false,
    // 旧构建没有这个字段，当作「当时用的是关思考的档位」。
    effort: typeof row.effort === 'string' ? row.effort : 'off',
    system,
    prompt,
    ctx: normalizeCtx(row.ctx),
  }
}

/**
 * 结构化上下文（拼 prompt 的原料）。老日志只有渲染好的 `prompt`，没有这一段——
 * 那时重放只能原文照发；新日志有它才能用**当前**模板重拼。
 * 认不出的字段直接丢，别让半截脏数据进到 `buildJudgePrompt()`。
 */
function normalizeCtx(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const history = (Array.isArray(raw.history) ? raw.history : [])
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      from: typeof item.from === 'string' ? item.from : '',
      text: typeof item.text === 'string' ? item.text : '',
    }))
  const botTexts = Array.isArray(raw.botTexts) ? raw.botTexts.filter((text) => typeof text === 'string') : []
  const ctx = {
    history,
    botTexts,
    quote: typeof raw.quote === 'string' ? raw.quote : '',
    sender: typeof raw.sender === 'string' ? raw.sender : '',
    text: typeof raw.text === 'string' ? raw.text : '',
  }
  const empty = history.length === 0 && botTexts.length === 0 && ctx.quote === '' && ctx.text === ''
  return empty ? undefined : ctx
}

/**
 * 读语义日志（旧 → 新）。先读 `.1`（更老）再读当前文件，按
 * 「群 + 时间 + 发送者 + 正文」去重，最后截到 `limit` 条。
 *
 * @returns {Array<{ at, group, sender, text, verdict, answer, model, ms, ok, effort, system, prompt, ctx }>}
 */
export function readSemanticLog(file, options = {}) {
  if (typeof file !== 'string' || file.trim() === '') return []
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 400
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : SEMLOG_TAIL_MAX_BYTES

  const rows = []
  // 顺序很重要：老的在前，新的在后，后面的同 key 记录会覆盖前面的。
  for (const source of [`${file}.1`, file]) {
    for (const line of readJsonlTail(source, maxBytes)) {
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const row = normalize(parsed)
      if (row !== undefined) rows.push(row)
    }
  }

  const seen = new Set()
  const deduped = []
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    const key = `${row.group}|${row.at}|${row.sender}|${row.text}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(row)
  }
  deduped.reverse()
  deduped.sort((a, b) => a.at - b.at)
  return deduped.length > limit ? deduped.slice(-limit) : deduped
}
