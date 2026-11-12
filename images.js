/**
 * qqbot-suite/images — 群聊图片的基础工具（判定、标签、文本收敛、信息收集）。
 *
 * 图片只有两条通道，别的代码不要自己拼：
 *
 *   1) **附件通道**（`image.mode: 'agent'`）：图片照常下载，`- Image: <路径>` 进正文，
 *      由 agent 自己的模型读图。这里不参与。
 *   2) **文本通道**（`image.mode: 'placeholder'`，默认）：图片在中间件链之前就被摘掉
 *      （连下载都省了），只留 `[图片×N（已过滤，看不到内容）]` 占位符。
 *
 * 第三方读图的 reader 接口（注册表 + 统一入口）已移出发布包，
 * 参考实现保存在私有侧 `dev/legacy/third-party-reader/`，需要时再接回来。
 */

/** 描述文本进正文前的上限（历史条目里一条最多也就 120 字，这里留足余量）。 */
export const IMAGE_TEXT_MAX_CHARS = 400

/** 图片附件的判定（`content_type` 以 image/ 开头，或就是 `image`）。 */
export function isImageAttachment(attachment) {
  const type = String(attachment?.content_type ?? attachment?.contentType ?? '').toLowerCase()
  return type.startsWith('image/') || type === 'image'
}

/**
 * 统一的一行图片标签。
 *
 * - 没有 detail：`[图片×2（已过滤，看不到内容）]`；
 * - 有 detail：`[图片×2] 图中文字：……`，detail 由调用方给。
 */
export function imagePlaceholder(count, detail = '') {
  const n = Number.isFinite(Number(count)) ? Math.floor(Number(count)) : 0
  if (n <= 0) return ''
  const body = squashImageText(detail)
  // 有描述时不写「看不到内容」（OCR / 读图已经给出内容了），只留标签。
  return body === ''
    ? `[图片${n === 1 ? '' : `×${n}`}（已过滤，看不到内容）]`
    : `${imageLabel(n)} ${body}`
}

/** 只出标签（图片还在、只是这次没摘）：`[图片×2]`。 */
export function imageLabel(count) {
  const n = Number.isFinite(Number(count)) ? Math.floor(Number(count)) : 0
  return n <= 0 ? '' : `[图片${n === 1 ? '' : `×${n}`}]`
}

/** 压成单行并截断：历史条目是「一行一条」，换行会把块结构撑乱。 */
export function squashImageText(value, max = IMAGE_TEXT_MAX_CHARS) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 这条消息该带的图片标签。
 *
 * 优先用 `suiteImageText`——那是闸门补写进正文的最终文本（占位符）；
 * 没有就走数量兜底（被拦下的消息不补正文，只留占位符）。
 */
export function imageNoteOf(message) {
  if (message === null || typeof message !== 'object') return ''
  const explicit = typeof message.suiteImageText === 'string' ? message.suiteImageText.trim() : ''
  if (explicit !== '') return explicit
  // 图还在消息里（agent 模式）：历史环里只标「这里有 N 张图」。
  // 不能写「已过滤」——agent 在当前消息里是真能看到这张图的，两边说法会打架。
  const present = Number(message.suiteImagesPresent) > 0 ? Math.floor(Number(message.suiteImagesPresent)) : 0
  if (present > 0) return imageLabel(present)
  return imagePlaceholder(message.suiteImagesStripped)
}

/**
 * 把标签拼进正文：空正文就是标签本身，否则标签在前（进 prompt 时正文会被截断，
 * 放后面会被截没），正文里已经有这个标签就不重复加。
 */
export function withImageNote(text, note) {
  const body = typeof text === 'string' ? text : ''
  const label = typeof note === 'string' ? note.trim() : ''
  if (label === '') return body
  if (body.includes(label)) return body
  return body.trim() === '' ? label : `${label} ${body.trimEnd()}`
}

/**
 * 把消息里的图片收敛成统一形状，读图实现只需要认这一个类型。
 *
 * 三个来源：
 *   - `suiteImages`：链前摘图时存下的原始附件（只有 url）；
 *   - `attachments`：没被摘过的图片（`allow`，或读图实现要本地文件时）；
 *   - `downloadedFiles`：官方 `attachmentProcessor` 的下载结果（`{ filename, localPath }`），
 *     按 filename 配上去 —— 这就是「不要自己再写一遍下载」的那份数据。
 */
export function collectImages(message, downloadedFiles = []) {
  if (message === null || typeof message !== 'object') return []
  const stored = Array.isArray(message.suiteImages) ? message.suiteImages : []
  const list = stored.length > 0
    ? stored
    : (Array.isArray(message.attachments) ? message.attachments : []).filter(isImageAttachment)
  const localOf = new Map()
  for (const item of Array.isArray(downloadedFiles) ? downloadedFiles : []) {
    const key = String(item?.filename ?? '')
    if (key !== '' && typeof item?.localPath === 'string') localOf.set(key, item.localPath)
  }
  return list.map((item, index) => {
    const name = String(item?.filename ?? item?.name ?? '')
    return {
      index,
      name,
      contentType: String(item?.content_type ?? item?.contentType ?? ''),
      url: String(item?.url ?? item?.source ?? ''),
      // 本地文件来自官方下载（上面那张表），不是这里下的。
      localPath: localOf.get(name) ?? String(item?.localPath ?? item?.path ?? ''),
      raw: item,
    }
  })
}
