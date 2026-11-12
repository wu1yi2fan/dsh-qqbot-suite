/**
 * qqbot-suite 的配置读写。
 *
 * 运行期设置放在 `<DSH_HOME>/qqbot-suite/profiles/<profile>/settings.json`：这是用户从设置页
 * 改的运行时偏好，
 * 和 Loader 的 patch 分开，避免设置页每次保存都去重写 profile 的 cordis.patch.yml。
 * 首次启动时如果还没有 JSON，直接把默认配置写一份。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  RECALL_GAP_MINUTES_MAX,
  RECALL_GAP_MINUTES_MIN,
  RECALL_MAX_IMAGES_MAX,
  RECALL_MAX_IMAGES_MIN,
} from './images-recall.js'
import {
  IDLE_COOLDOWN_MIN_MAX,
  IDLE_COOLDOWN_MIN_MIN,
  IDLE_DAILY_MAX,
  IDLE_DAILY_MIN,
  IDLE_HOUR_MAX,
  IDLE_MINUTES_MAX,
  IDLE_MINUTES_MIN,
} from './idle.js'
import { PROMPT_ITEMS, PROMPT_TEXT } from './prompts.js'

export const MODES = ['keywords', 'semantic', 'all']

/**
 * 设置页「提示词改写」的条目表：id / 展示名 / 分组 / 风险标记都在 `prompts.js`，
 * **原文也从那里取**（`PROMPT_TEXT`），不是在这里再抄一份。
 *
 * 这一点是 2026-11-10 改的：以前这里存着一份「原文副本」，运行时另外写一份字面量，
 * 两处只靠逐字一致维系。副本漂移后设置页照常显示、照常保存，但覆盖永远匹配不上
 * ——`image.hint` 就是这样失效了很久没人发现。现在两边引用同一常量，不存在漂移。
 *
 * 覆盖仍然是**精确子串替换**（不是重建整段提示词）：提示词照旧由各模块生成，
 * 只在发给模型之前把那几句换成用户填的文案。这样不会动到协议标记、YES/NO 输出要求
 * 和「推理必须简体中文」的硬约束。
 */
export const PROMPT_CATALOG = PROMPT_ITEMS.map((item) => ({
  ...item,
  source: PROMPT_TEXT[item.id],
}))

/** 单条覆盖文案的长度上限：防止把整份人设塞进设置页。 */
const PROMPT_OVERRIDE_MAX = 1000

/** 把任意提示词文本按当前覆盖表换一遍；没有覆盖就原样返回。 */
export function applyPromptOverrides(text, overrides) {
  if (typeof text !== 'string' || text === '') return text
  if (overrides === null || typeof overrides !== 'object') return text
  let out = text
  for (const item of PROMPT_CATALOG) {
    const replacement = overrides[item.id]
    if (typeof replacement !== 'string' || replacement === '') continue
    if (out.includes(item.source)) out = out.split(item.source).join(replacement)
  }
  return out
}

/** 只收 PROMPT_CATALOG 里登记过的 id，空串表示「用内置原文」。 */
function cleanPromptOverrides(input) {
  const out = {}
  for (const item of PROMPT_CATALOG) {
    const value = input[item.id]
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text === '') continue
    out[item.id] = text.length > PROMPT_OVERRIDE_MAX ? text.slice(0, PROMPT_OVERRIDE_MAX) : text
  }
  return out
}

/**
 * 图片处置模式。三选一，最终结果只由它决定：
 * - `ignore`：不读图——带图片的消息**整条不收**，agent 完全看不到图片（纯文字消息照常处理）；
 * - `placeholder`：摘图留占位符，agent 只看到 `[图片×N（已过滤，看不到内容）]` 的字样；
 * - `agent`：模型识别——插件不动图片，官方链路下载 + 写 `Image: <路径>`，agent 用 read_image 自己看。
 */
export const IMAGE_MODES = ['ignore', 'placeholder', 'agent']

/**
 * 群里「回复用什么消息类型发」的三档（见 gate.js: replyFormat / wantsMarkdown）。
 *
 * - `auto`（默认）：按正文判断——只有明确的多行结构（代码块 / 表格 / 多条列表 / 标题 / 引用）
 *   才发 markdown（`msg_type:2`），其余全发纯文本（`msg_type:0`）。
 *   为什么保守：旧版 PC QQ 不认 `msg_type:2`，整条只显示「暂不支持该消息类型」——判断错成
 *   markdown 的代价是这条消息直接看不见，判断错成纯文本只是没有排版，两者不对称。
 * - `markdown`：不判断，全部 markdown。这是官方 dsh-qqbot 的原始行为（同 0.5.5）。
 * - `text`：不判断，全部纯文本。给「客户端一律不认 markdown」的人用。
 *
 * 只作用于正常回复（`bot.send` 那条路）。报错兜底走的是 SDK 的 `errorHandler` →
 * `sendText`，本来就是纯文本，不受这个开关影响。
 */
export const REPLY_FORMATS = ['auto', 'markdown', 'text']

/**
 * 图片模式：只认 `image.mode` 一个字段，非法值退回默认。
 *
 * 旧写法（`groupImages` / `imageReader` / `image.reader` / `image.ignoreMessage`）
 * 已随旧版一起删除：不识别的键在 normalizeConfig 里自然丢弃。
 */
export function imageModeOf(image) {
  return IMAGE_MODES.includes(image?.mode) ? image.mode : DEFAULT_CONFIG.image.mode
}

/**
 * 语义判断用的思考档位。`auto` = 不显式传，跟模型的默认值走。
 *
 * 这里存的不是厂商字段：Harness 的 LLM 适配器负责把它翻译成各家协议
 * （`thinking.type` / `enable_thinking` / `reasoning_effort` / `output_config.effort`），
 * 插件只认这套归一化后的 id。各模型支持的档位不一样，传一个不支持的档位
 * 会在 `prepareCall` 阶段被拒（UNSUPPORTED_REASONING_EFFORT），
 * index.js 会退回 `auto` 再试一次。
 */
export const REASONING_EFFORTS = ['auto', 'off', 'low', 'high', 'max']

/** 单个日志文件的上限：1MB，超过就轮转，避免长期开着把盘写满。 */
export const LOG_MAX_BYTES = 1024 * 1024

/**
 * 单次语义判断超时的上限：30 分钟，纯业务取值（原来的硬锁是 30 秒）。
 *
 * 取这个数只是给设置页一个明确的边界，不再是我自己拍的「判断不该超过 X 秒」；
 * 它离 `setTimeout` 的硬边界（2^31-1 ms，超过 Node 会按 1ms 处理）还很远，
 * 所以实际生效的就是这个值本身。
 */
export const TIMEOUT_MAX_MS = 30 * 60 * 1000

/**
 * 所有数值字段的合法区间：**唯一出处**。
 *
 * `normalizeConfig` 按它钳制（读写配置文件时的兜底），`findOutOfRange` 按它报错
 * （设置页保存时拒绝越界输入）。设置页的输入框范围在前端另有一份（浏览器 bundle
 * 引不到这个模块），改动时要一起改：`client.js` 的 NUMERIC_FIELDS。
 */
export const LIMITS = {
  recallGapMinutes: [RECALL_GAP_MINUTES_MIN, RECALL_GAP_MINUTES_MAX],
  recallMaxImages: [RECALL_MAX_IMAGES_MIN, RECALL_MAX_IMAGES_MAX],
  semanticMaxHistory: [0, 30],
  semanticTimeoutMs: [1000, TIMEOUT_MAX_MS],
  semanticMaxChars: [1000, 20000],
  semanticMaxTokens: [16, 8192],
  semanticStaleMinutes: [1, 1440],
  mediaMaxFiles: [1, 5000],
  watchMs: [3000, 120000],
  historyWindow: [0, 50],
  historyMaxChars: [200, 8000],
  // 合并窗口上限放到 10 分钟：有人是「想到哪句补哪句」，7–30 秒的间隔也算同一段话。
  // 默认值仍是 800 毫秒，值越大每条没点名的消息在群里越慢，由用户自己权衡。
  mergeWindowMs: [200, 600000],
  // 冷场间隔：上限锁死 30 分钟（见 idle.js：超过它就要 resume 一个已被回收的会话）。
  idleMinutes: [IDLE_MINUTES_MIN, IDLE_MINUTES_MAX],
  // 两次主动发言的最小间隔：下限 1 分钟（测试用），上限 240 分钟（4 小时，够克制了）。
  idleCooldownMinutes: [IDLE_COOLDOWN_MIN_MIN, IDLE_COOLDOWN_MIN_MAX],
  idleDailyLimit: [IDLE_DAILY_MIN, IDLE_DAILY_MAX],
  // 活跃时段：起点 0–23，终点 0–24（24 = 到当天结束）。
  idleHourStart: [0, IDLE_HOUR_MAX - 1],
  idleHourEnd: [0, IDLE_HOUR_MAX],
}

/**
 * 保存请求里的数值字段：中文名 + 从请求里取值。报错时报第一个越界的，人一眼能对上。
 *
 * 顺序大体跟设置页一致，但**不要求每个字段都有输入框**：`semanticMaxChars`
 * 在设置页里就没有这一项，只能手改 `settings.json` 或直接调 API。它列在这里是为了
 * 让「越界就拒绝」覆盖 `LIMITS` 里登记的全部字段——漏登记的字段只会被
 * `normalizeConfig` 静默钳制，和别的字段表现不一致（改了 0 字却被当成 1000 字，页面上
 * 还看不出哪里错了）。
 */
const NUMERIC_FIELDS = [
  ['分批间隔（分钟）', 'recallGapMinutes', (c) => c?.image?.recall?.gapMinutes],
  ['单轮最多给几张', 'recallMaxImages', (c) => c?.image?.recall?.maxImages],
  ['参考最近消息条数', 'semanticMaxHistory', (c) => c?.semantic?.maxHistory],
  ['参考消息总字数', 'semanticMaxChars', (c) => c?.semantic?.maxChars],
  ['单次判断超时', 'semanticTimeoutMs', (c) => c?.semantic?.timeoutMs],
  ['单次输出上限', 'semanticMaxTokens', (c) => c?.semantic?.maxTokens],
  ['新话题间隔（分钟）', 'semanticStaleMinutes', (c) => c?.semantic?.staleMinutes],
  ['最多保留文件数', 'mediaMaxFiles', (c) => c?.media?.maxFiles],
  ['最多带多少条', 'historyWindow', (c) => c?.history?.window],
  ['最多带多少字', 'historyMaxChars', (c) => c?.history?.maxChars],
  ['超时阈值', 'watchMs', (c) => c?.timeout?.ms],
  ['合并窗口', 'mergeWindowMs', (c) => c?.merge?.windowMs],
  ['冷场间隔（分钟）', 'idleMinutes', (c) => c?.idle?.minutes],
  ['两次发言最小间隔（分钟）', 'idleCooldownMinutes', (c) => c?.idle?.cooldownMinutes],
  ['每天最多主动说几次', 'idleDailyLimit', (c) => c?.idle?.dailyLimit],
  ['活跃时段起始（点）', 'idleHourStart', (c) => c?.idle?.hoursStart],
  ['活跃时段结束（点）', 'idleHourEnd', (c) => c?.idle?.hoursEnd],
]

/**
 * 找第一个越界的数值字段。只检查**显式给了值**的字段（设置页保存是部分更新，
 * 没带的表示「不改」）；留空/非数字不在这里报，交给 `normalizeConfig` 兜底。
 *
 * 返回 `{ label, value, min, max }`，没有越界返回 `null`。
 */
export function findOutOfRange(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  for (const [label, key, read] of NUMERIC_FIELDS) {
    const raw = read(source)
    if (raw === undefined || raw === null || raw === '') continue
    const number = Number(raw)
    if (!Number.isFinite(number)) continue
    const [min, max] = LIMITS[key]
    if (number < min || number > max) return { label, value: number, min, max }
  }
  return null
}

/**
 * 群聊默认放行的工具。
 *
 * 群聊走的是白名单（不在清单里的一律拒绝），所以这份清单就是「群里的 agent 能干什么」。
 * `read_image` 不在这里：它跟着图片模式走（`image.mode = agent` 时自动追加），
 * 单独列出来会让「切模式」和「改清单」互相打脸。
 * 设置页可以整份替换；填成空 = 群里什么工具都不给。
 */
export const DEFAULT_GROUP_TOOLS = ['qqbot_bot_profile', 'web_search']

export const DEFAULT_CONFIG = {
  mode: 'keywords',
  wakeWords: [],
  // 机器人自己的名字（手动填，不自动读取）：唤醒匹配、语义判断提示词、
  // 群聊历史里机器人发言的标记都用它。留空 = 只靠 @、引用和唤醒词。
  botName: '',
  // qqbot_bot_profile 工具（agent 查「自己是谁」）的启停不在配置里：
  // 由插件页面控制 qqbot-suite-self 子插件的启用/停用（bundle patch 默认 disabled），
  // 停用时插件上下文销毁、工具注册自动注销，零凭据读取。
  // 斜杠命令白名单：只有这些发送者 ID 发来的「行首 /」会原样进入（能触发
  // /new、/model 等命令，也能走闸门的斜杠放行）；其他人的消息在进入中间件链
  // 之前先去掉行首的 /，变成普通文字。空数组 = 不启用（所有人照旧）。
  // 群聊里是群成员 openid，私聊是用户 openid，两套 ID 不一样。
  slash: {
    allowIds: [],
  },
  // 群聊图片的处置方式（唯一开关，见 gate.js）。三档：
  //   ignore       —— 不读图：带图片的消息整条不收，agent 完全看不到图（纯文字消息照常处理）；
  //   placeholder  —— 摘图留 [图片×N（已过滤，看不到内容）] 占位符，agent 看不到图但知道来过图；
  //   agent        —— 模型识别：官方链路照常下载并写 `Image: <路径>`，agent 自己读。
  image: {
    mode: 'placeholder',
    // 历史图片召回（只在 mode = 'agent' 时生效，见 images-recall.js）。
    // gapMinutes：相邻两张图的发送间隔 > 这个值就算两批；maxImages：单轮最多注入几张。
    recall: {
      gapMinutes: 1,
      maxImages: 4,
    },
  },
  debug: false,
  semantic: {
    // 判断用的模型：`provider/model`，空 = 跟随「设置 → 模型」里的默认模型。
    // 只在 Harness 读不到模型列表、或想用手动填写的模型时才有值（见 INDEX.md 6.5）。
    model: '',
    maxHistory: 12,
    timeoutMs: 8000,
    maxChars: 6000,
    // 默认关掉思考：判断「这句是不是在叫它」不需要推理，开着会先把 token 花在
    // 思维链上，预算小的时候正文会被整段挤掉（详见 AGENTS.md 6.5）。
    reasoningEffort: 'off',
    // 思考关掉后 256 够用；思考开着时这个值同时是「思考 + 正文」的总预算。
    maxTokens: 256,
    // 判定时「隔多久算换了一个话题」（分钟）。聊天记录每行带发送时间，间隔超过它
    // 就不再套用「紧跟着它说话的短反应算 YES」——那条规则本来就是给连续对话用的。
    staleMinutes: 30,
    // 丢弃 thinking：推理内容不落盘、不参与解析，只留长度做诊断。
    discardThinking: true,
  },
  // 媒体缓存上限：官方 dsh-qqbot 会把图片/视频/文件下载到 ~/.dsh-qqbot/media，
  // 但只按 ttlHours（默认 24 小时）过期，没有数量上限。这里补一个兜底，
  // 清理时保留最新的 maxFiles 个，只删更旧的。
  // 最少 1（没有「0 = 不限」这回事）：这个值同时是「历史图片能召回多少张」的天花板。
  // 0 / 负数按非法输入退回默认值（`intAtLeastOne`），不夹成 1——夹成 1 等于只留最新一张。
  media: {
    maxFiles: 100,
  },
  // 回复用哪种消息类型发（见 REPLY_FORMATS 的注释）。默认 auto。
  reply: {
    format: 'auto',
  },
  // 群聊「处理超时自动中断」：消息放行后开始计时，到首条回复或 agent 回到 idle 停表；
  // 还没停表就到点，则取消这一轮并在群里回一句 message。只对群聊生效。
  timeout: {
    enabled: true,
    ms: 15000,
    message: '⏱ 这条想太久了（超过 {seconds} 秒），先中断。拆小一点再问我一次？',
  },
  // 多条消息合并：同一个人在窗口内连着发的几句，合成一条再交给 agent。
  //
  // 默认关闭：开了以后群里所有「没点名的」消息都要多等一个窗口才进链。
  // 2026-11-09 用户定：合并优先级最高——@、唤醒词、引用同样进窗口，只有行首 `/`
  // 的斜杠命令绕过（合并后正文不以 `/` 开头，命令会被当成聊天）。
  // 只在闸门之前的入站层做（gate.js: deferInbound），合并出来的是一条普通消息，
  // 下游（斜杠过滤、摘图、语义判断、群聊历史、超时看门狗、附件下载）全都不用改。
  // 为什么不用官方 concurrencyGuard 的 merge：它只能接住「上一轮还在跑时到达的」消息，
  // 第一条永远进不了批次，最多把 N 次降到 2 次（窗口短时第二条会排到下一轮开头）。
  merge: {
    // 只有严格 true 才开启。
    enabled: false,
    // 窗口：同一个人在这段时间内再发一条，就并进同一条；换人说话则排队等。
    // 范围 200–600000，默认 800 —— 覆盖「打完一句又补一句」的常见间隔，延迟感知也小。
    windowMs: 800,
  },
  guard: {
    extras: [],
    deny: [],
    // 群聊放行清单，空数组 = 群里不给任何工具（read_image 另按图片模式追加）。
    allow: [...DEFAULT_GROUP_TOOLS],
  },
  // 冷场处理（见 idle.js）：
  //   - 群聊最后一条不是它自己说的、且安静超过 minutes 分钟 → 交给 agent 决定说不说；
  //   - 最后那条如果是被语义判成「不回」的（semantic-no），按原样补回（recallMissed）。
  // 分钟数上限锁死 30：dsh-qqbot 默认 30 分钟回收会话，超过就要 resume，不值当。
  idle: {
    // 默认关：这是个会主动说话的开关，得用户自己确认要。
    enabled: false,
    minutes: 10,
    // 两次主动发言的最小间隔：防止「说一句→又冷场→马上再说」的连环。
    cooldownMinutes: 60,
    // 每群每天最多主动说几次（含补回）。到点当天不再说话。
    dailyLimit: 3,
    // 活跃时段，左闭右开；start > end 表示跨夜，start === end 表示全天。
    hoursStart: 9,
    hoursEnd: 24,
    // 补回被语义拦下的那条（方案 A）。关掉只留「自己找话说」（方案 B）。
    recallMissed: true,
    // 重启后要不要把「启动前收到、当时没回」的消息补上。
    // 历史环是落盘的，重启会回填，默认就接着处理它们；关掉则重启即作废。
    catchUpOnStart: true,
  },
  // 群聊上下文：喂给 agent 的「最近若干条群消息」窗口。
  // 官方 dsh-qqbot 的 historyBuffer 回答完一条就把缓冲清空，且只在真 @ 时注入，
  // 所以套件自己记账（见 history.js）。`window: 0` = 关掉整块注入。
  history: {
    // 注入条数上限：太少接不上话（「前面有人找你」），太多白烧 token。
    window: 20,
    // 注入总字数上限，超了从更旧的丢。
    maxChars: 2000,
    // 落盘到 <logs>/qqbot-group-history.jsonl，重启后回填，避免「一重载就失忆」。
    persist: true,
    // 已交给 agent 的那几条打 ✓，让它知道哪句自己已经回应过。
    markAnswered: true,
  },
  // 设置页「Prompt 设置」折叠区填的覆盖文案；空对象 = 全用代码里的原文。
  promptOverrides: {},
}

/** 当前 profile 名（DSH_PROFILE，缺省 web）。 */
export function profileName() {
  const value = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE.trim() : ''
  return value === '' ? 'web' : value
}

/**
 * 宿主数据根：`$DSH_HOME`，缺省 `~/.dsh`。
 *
 * 规则跟官方 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()` 一致（环境变量优先，
 * `~` / `~/...` 展开成家目录）。那个包不能裸 import —— 本套件以 `link:` 挂在 profile 外，
 * 拿不到 profile 的 node_modules —— 所以这里复刻一份，语义保持同步。
 */
export function dshHomeOf() {
  const raw = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (raw === '') return join(homedir(), '.dsh')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return raw
}

/**
 * 套件自己的插件数据根：`<DSH_HOME>/qqbot-suite`。
 *
 * 宿主没有 per-plugin 目录的概念（`dsh-home-paths` 只有「所有用户数据在单一根下」），
 * 所以按官方 dsh-qqbot 的做法（它用 `~/.dsh-qqbot`）自定一个：能跟着 `DSH_HOME` 走，
 * 又不跟官方插件的 `~/.dsh-qqbot` 抢命名空间。配置里可用 `suiteHome` 覆盖（测试用）。
 */
export function suiteHomeOf(config = {}) {
  if (typeof config.suiteHome === 'string' && config.suiteHome.trim() !== '') return config.suiteHome.trim()
  return join(dshHomeOf(), 'qqbot-suite')
}

/** 当前 profile 的套件数据目录：`<suiteHome>/profiles/<profile>/`。 */
export function suiteProfileDirOf(config = {}) {
  return join(suiteHomeOf(config), 'profiles', profileName())
}

/** 当前 profile 目录（宿主的，只读；插件自己的数据不往这里写）。 */
export function profileDirOf(config = {}) {
  if (typeof config.profileDir === 'string' && config.profileDir.trim() !== '') return config.profileDir.trim()
  return join(dshHomeOf(), 'profiles', profileName())
}

/** 运行期设置文件：`<suiteHome>/profiles/<profile>/settings.json`。 */
export function settingsPathOf(config = {}) {
  if (typeof config.settingsPath === 'string' && config.settingsPath.trim() !== '') return config.settingsPath.trim()
  return join(suiteProfileDirOf(config), 'settings.json')
}

/** 人工确认的漏判样本：跟设置同目录，方便一起备份、手改。 */
export function missesPathOf(config = {}) {
  if (typeof config.missesPath === 'string' && config.missesPath.trim() !== '') return config.missesPath.trim()
  return join(suiteProfileDirOf(config), 'misses.json')
}

/**
 * 官方 dsh-qqbot 的媒体缓存目录。图片/视频/文件都下载到这里（`~/.dsh-qqbot/media`），
 * 本套件的数量上限清理也作用在这个目录。测试可用 `mediaDir` 覆盖。
 *
 * 这里**故意不认 `DSH_HOME`**：官方插件的 `PLUGIN_HOME` 就是写死的 `homedir()/.dsh-qqbot`，
 * 我们写头像的位置必须和它的 `qqbot_send_file` 白名单一致，跟着宿主跑会直接发不出去。
 */
export function mediaDirOf(config = {}) {
  if (typeof config.mediaDir === 'string' && config.mediaDir.trim() !== '') return config.mediaDir.trim()
  return join(homedir(), '.dsh-qqbot', 'media')
}

/** 该 profile 的 cordis.patch.yml。 */
export function patchPathOf(config = {}) {
  return join(profileDirOf(config), 'cordis.patch.yml')
}

/**
 * 日志目录：`<suiteHome>/profiles/<profile>/logs/`。
 *
 * 不再跟着「机器人工作区」（`im-qqbot.cwd`）走 —— 那个目录是 agent 的，插件往里写
 * 属于越界；官方自己也是把日志放 `$DSH_HOME/logs`。按 profile 分目录，是多 profile
 * 同时跑时两边不会往同一个文件里交错误。可以用 `logsDir` 覆盖。
 */
export function logsDirOf(config = {}) {
  if (typeof config.logsDir === 'string' && config.logsDir.trim() !== '') return config.logsDir.trim()
  return join(suiteProfileDirOf(config), 'logs')
}

/** 群聊闸门的调试日志（debug 开启时追加 JSON Lines）。 */
export function debugLogPathOf(config = {}) {
  if (typeof config.debugLogPath === 'string' && config.debugLogPath.trim() !== '') return config.debugLogPath.trim()
  return join(logsDirOf(config), 'debug.log')
}

/** 语义判断日志（每次调用模型都记录：提交的输入 + 模型原始返回）。 */
export function semanticLogPathOf(config = {}) {
  if (typeof config.semanticLogPath === 'string' && config.semanticLogPath.trim() !== '') {
    return config.semanticLogPath.trim()
  }
  return join(logsDirOf(config), 'semantic.log')
}

/**
 * 群聊历史落盘文件（只在 `history.persist` 开启时写）。
 * 和两个日志放一起：都是「本机排查用途的明文」，不往外传。
 */
export function historyLogPathOf(config = {}) {
  if (typeof config.historyLogPath === 'string' && config.historyLogPath.trim() !== '') {
    return config.historyLogPath.trim()
  }
  return join(logsDirOf(config), 'group-history.jsonl')
}

/**
 * 历史图片索引（`images-recall.js`）。和群聊历史放一起：都是本机排查/召回用的明文，
 * 不往外传。
 */
export function imageIndexPathOf(config = {}) {
  if (typeof config.imageIndexPath === 'string' && config.imageIndexPath.trim() !== '') {
    return config.imageIndexPath.trim()
  }
  return join(logsDirOf(config), 'image-index.jsonl')
}

/**
 * 冷场触发记录（`gate.js` 记账、`index.js` 落盘 + 启动回填）。和群聊历史放一起：
 * 都是本机排查/回显用途的明文，不往外传。追加 JSON Lines，每行一条触发记录，
 * 重启不清——设置页「最近的主动发言」不再一重载就归零。
 */
export function idleRecentPathOf(config = {}) {
  if (typeof config.idleRecentPath === 'string' && config.idleRecentPath.trim() !== '') {
    return config.idleRecentPath.trim()
  }
  return join(logsDirOf(config), 'idle-recent.jsonl')
}

export function cleanList(value, limit = 100) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const list = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    list.push(text)
    if (list.length >= limit) break
  }
  return list
}

/**
 * 发送者 ID 列表：只接受字符串/数字（数字是给 YAML 里没加引号的 ID 兜底），
 * 去空白、去重，最多 `limit` 个。ID 按字符串比较，不做大小写归一化。
 */
export function cleanIds(value, limit = 50) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const list = []
  for (const item of value) {
    if (typeof item !== 'string' && typeof item !== 'number') continue
    const id = String(item).trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    list.push(id)
    if (list.length >= limit) break
  }
  return list
}

/**
 * 语义判断指定的模型：`provider/model`，空串 = 跟随默认模型。
 *
 * 为什么要带 provider：Harness 的模型路由是「适配器（provider）+ 模型 id」两段，
 * 只给模型名没法确定走哪个适配器（同名模型可能被多家提供）。所以只接受带 `/` 的写法；
 * 用户在设置页手填了 `deepseek-flash` 这种半截的，这里直接当没填，回退默认模型，
 * 免得运行时才发现 NO_ADAPTER、群里静默不回复。
 */
export function cleanModelRef(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '' || text.length > 120 || /\s/.test(text)) return ''
  const slash = text.indexOf('/')
  if (slash <= 0 || slash === text.length - 1) return ''
  return text
}

function intIn(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/**
 * 下限硬锁 1 的整数：**0 / 负数一律退回默认值，不夹成 1**。
 *
 * 为什么不用 `intIn` 夹：媒体上限夹成 1 的后果是每分钟的清理把目录删到只剩最新一张
 * （历史图片召回随即失效），而不是「稍微多删几张」。所以这类「下限本身就是有效值」的
 * 字段，非法的小值走回退。`media.maxFiles` 是唯一用它的字段：
 * 0 既不是「不限」也不是「留一张」，它就是非法输入。
 */
function intAtLeastOne(value, fallback, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const rounded = Math.round(number)
  if (rounded < 1) return fallback
  return Math.min(max, rounded)
}

/** 非空短文本：空串/非字符串回退默认值，超长截断。 */
function textIn(value, fallback, max) {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (text === '') return fallback
  return text.length > max ? text.slice(0, max) : text
}

/** 把任意输入收敛成一份合法配置。 */
export function normalizeConfig(input = {}) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const semantic = source.semantic !== null && typeof source.semantic === 'object' ? source.semantic : {}
  const media = source.media !== null && typeof source.media === 'object' ? source.media : {}
  const guard = source.guard !== null && typeof source.guard === 'object' ? source.guard : {}
  const timeout = source.timeout !== null && typeof source.timeout === 'object' ? source.timeout : {}
  const reply = source.reply !== null && typeof source.reply === 'object' ? source.reply : {}
  const slash = source.slash !== null && typeof source.slash === 'object' ? source.slash : {}
  const history = source.history !== null && typeof source.history === 'object' ? source.history : {}
  const merge = source.merge !== null && typeof source.merge === 'object' ? source.merge : {}
  const idle = source.idle !== null && typeof source.idle === 'object' ? source.idle : {}
  const image = source.image !== null && typeof source.image === 'object' ? source.image : {}
  const recall = image.recall !== null && typeof image.recall === 'object' ? image.recall : {}
  const promptOverrides = source.promptOverrides !== null && typeof source.promptOverrides === 'object'
    ? source.promptOverrides
    : {}
  return {
    mode: MODES.includes(source.mode) ? source.mode : DEFAULT_CONFIG.mode,
    wakeWords: cleanList(source.wakeWords, 50),
    botName: textIn(source.botName, DEFAULT_CONFIG.botName, 64),
    // botProfile 已移除：启停改由插件页面控制（cordis.patch.yml 的 disabled）。
    // 旧配置文件里的 botProfile 键在这里自然丢弃（返回体是全新对象）。
    slash: {
      allowIds: cleanIds(slash.allowIds, 50),
    },
    image: {
      mode: imageModeOf(image),
      recall: {
        gapMinutes: intIn(
          recall.gapMinutes,
          DEFAULT_CONFIG.image.recall.gapMinutes,
          ...LIMITS.recallGapMinutes,
        ),
        maxImages: intIn(
          recall.maxImages,
          DEFAULT_CONFIG.image.recall.maxImages,
          ...LIMITS.recallMaxImages,
        ),
      },
    },
    debug: source.debug === true,
    semantic: {
      model: cleanModelRef(semantic.model),
      maxHistory: intIn(semantic.maxHistory, DEFAULT_CONFIG.semantic.maxHistory, ...LIMITS.semanticMaxHistory),
      timeoutMs: intIn(semantic.timeoutMs, DEFAULT_CONFIG.semantic.timeoutMs, ...LIMITS.semanticTimeoutMs),
      maxChars: intIn(semantic.maxChars, DEFAULT_CONFIG.semantic.maxChars, ...LIMITS.semanticMaxChars),
      reasoningEffort: REASONING_EFFORTS.includes(semantic.reasoningEffort)
        ? semantic.reasoningEffort
        : DEFAULT_CONFIG.semantic.reasoningEffort,
      maxTokens: intIn(semantic.maxTokens, DEFAULT_CONFIG.semantic.maxTokens, ...LIMITS.semanticMaxTokens),
      staleMinutes: intIn(
        semantic.staleMinutes,
        DEFAULT_CONFIG.semantic.staleMinutes,
        ...LIMITS.semanticStaleMinutes,
      ),
      discardThinking: semantic.discardThinking !== false,
    },
    media: {
      // 下限锁死 1：没有「0 = 不限」这回事，0 / 负数按非法输入处理、退回默认值。
      // 不要换成 intIn：那会把 0 夹成 1，等于「只留最新一张」，比拒绝更危险。
      // 上限同时决定索引条数（images-recall.js）。
      maxFiles: intAtLeastOne(media.maxFiles, DEFAULT_CONFIG.media.maxFiles, LIMITS.mediaMaxFiles[1]),
    },
    reply: {
      format: REPLY_FORMATS.includes(reply.format) ? reply.format : DEFAULT_CONFIG.reply.format,
    },
    timeout: {
      enabled: timeout.enabled !== false,
      ms: intIn(timeout.ms, DEFAULT_CONFIG.timeout.ms, ...LIMITS.watchMs),
      message: textIn(timeout.message, DEFAULT_CONFIG.timeout.message, 240),
    },
    merge: {
      // 默认关：只有设置页明确打开才生效（归一化时不做「有值就开」的推断）。
      enabled: merge.enabled === true,
      windowMs: intIn(merge.windowMs, DEFAULT_CONFIG.merge.windowMs, ...LIMITS.mergeWindowMs),
    },
    guard: {
      extras: cleanList(guard.extras, 35),
      deny: cleanList(guard.deny, 100),
      // 缺省（没这个键）用默认清单；显式空数组就是「群里什么工具都不给」。
      allow: cleanList(guard.allow ?? DEFAULT_CONFIG.guard.allow, 50),
    },
    idle: {
      // 默认关：只有设置页明确打开才生效。
      enabled: idle.enabled === true,
      minutes: intIn(idle.minutes, DEFAULT_CONFIG.idle.minutes, ...LIMITS.idleMinutes),
      cooldownMinutes: intIn(
        idle.cooldownMinutes,
        DEFAULT_CONFIG.idle.cooldownMinutes,
        ...LIMITS.idleCooldownMinutes,
      ),
      dailyLimit: intIn(idle.dailyLimit, DEFAULT_CONFIG.idle.dailyLimit, ...LIMITS.idleDailyLimit),
      hoursStart: intIn(idle.hoursStart, DEFAULT_CONFIG.idle.hoursStart, ...LIMITS.idleHourStart),
      hoursEnd: intIn(idle.hoursEnd, DEFAULT_CONFIG.idle.hoursEnd, ...LIMITS.idleHourEnd),
      recallMissed: idle.recallMissed !== false,
      catchUpOnStart: idle.catchUpOnStart !== false,
    },
    history: {
      window: intIn(history.window, DEFAULT_CONFIG.history.window, ...LIMITS.historyWindow),
      maxChars: intIn(history.maxChars, DEFAULT_CONFIG.history.maxChars, ...LIMITS.historyMaxChars),
      persist: history.persist !== false,
      markAnswered: history.markAnswered !== false,
    },
    promptOverrides: cleanPromptOverrides(promptOverrides),
  }
}

/** 读配置：JSON 优先；没有就把默认配置落盘；最后叠插件 config。 */
export function loadConfig(raw, paths) {
  const base = normalizeConfig(raw)
  let stored = null
  if (existsSync(paths.settings)) {
    try {
      stored = JSON.parse(readFileSync(paths.settings, 'utf8'))
    } catch {
      stored = null
    }
  }
  if (stored === null) {
    // 首次启动：把默认配置落盘，让设置页有东西可读；写失败不影响本次运行。
    try {
      writeConfig(paths.settings, base)
    } catch {
      stored = null
    }
  }
  return normalizeConfig({
    ...base,
    ...(stored !== null && typeof stored === 'object' ? stored : {}),
    slash: {
      ...base.slash,
      ...(stored?.slash !== null && typeof stored?.slash === 'object' ? stored.slash : {}),
    },
    semantic: {
      ...base.semantic,
      ...(stored?.semantic !== null && typeof stored?.semantic === 'object' ? stored.semantic : {}),
    },
    timeout: {
      ...base.timeout,
      ...(stored?.timeout !== null && typeof stored?.timeout === 'object' ? stored.timeout : {}),
    },
    reply: {
      ...base.reply,
      ...(stored?.reply !== null && typeof stored?.reply === 'object' ? stored.reply : {}),
    },
    merge: {
      ...base.merge,
      ...(stored?.merge !== null && typeof stored?.merge === 'object' ? stored.merge : {}),
    },
    media: {
      ...base.media,
      ...(stored?.media !== null && typeof stored?.media === 'object' ? stored.media : {}),
    },
    guard: {
      ...base.guard,
      ...(stored?.guard !== null && typeof stored?.guard === 'object' ? stored.guard : {}),
    },
    history: {
      ...base.history,
      ...(stored?.history !== null && typeof stored?.history === 'object' ? stored.history : {}),
    },
    promptOverrides: {
      ...base.promptOverrides,
      ...(stored?.promptOverrides !== null && typeof stored?.promptOverrides === 'object'
        ? stored.promptOverrides
        : {}),
    },
  })
}

/**
 * 原子写：同目录临时文件 + rename，中途崩溃不会留下半份文件。
 *
 * 这个仓库里有三个写者共享 profile（宿主设置流程、官方 dsh-qqbot、本套件），
 * 而 `cordis.patch.yml` 一旦被截断，整个 profile 都起不来——所以宁可多一次
 * rename，也不要 `writeFileSync` 直接覆盖。rename 在同一分区上是原子的；
 * Windows 上目标被别的进程占着时会抛 EPERM，重试一次再放弃（调用方拿得到错）。
 */
export function writeFileAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.suite-tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temp, text, 'utf8')
    try {
      renameSync(temp, file)
    } catch (error) {
      // 目标被占用时给一次重试的机会（杀毒 / 编辑器 / 宿主正在读）
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error
      renameSync(temp, file)
    }
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // 临时文件可能没建出来，或已经 rename 成功
    }
    throw error
  }
}

/** 写 JSON（先建目录；失败直接抛给设置页）。 */
export function writeConfig(file, config) {
  writeFileAtomic(file, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`)
}

/** 定位某个 `- id: xxx` 行在 patch 文本里的起止。 */
function findRowRange(lines, id) {
  const start = lines.findIndex((line) => new RegExp(`^- id: ${id}\\s*$`).test(line))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !/^- /.test(lines[end]) && !/^#/.test(lines[end])) end += 1
  return [start, end]
}

/**
 * 纯函数：把 patch 文本里的 im-qqbot.cwd 换成 `workspace`，其余行原样返回。
 * 找不到行/结构不认识时返回 null，由调用方决定怎么报错。
 */
function patchTextWithWorkspace(text, workspace) {
  const lines = text === '' ? [] : text.split(/\r?\n/)
  const range = findRowRange(lines, 'im-qqbot')
  if (range === null) return null
  const line = `    cwd: '${workspace.replace(/['"\r\n]/g, '')}'`

  for (let i = range[0]; i < range[1]; i += 1) {
    if (/^\s+cwd:/.test(lines[i])) {
      lines[i] = line
      return lines.join('\n')
    }
  }
  let anchor = -1
  for (const pattern of [/^\s{4}preset:/, /^\s{4}appId:/, /^\s{2}config:/]) {
    for (let i = range[0]; i < range[1]; i += 1) {
      if (pattern.test(lines[i])) {
        anchor = i
        break
      }
    }
    if (anchor >= 0) break
  }
  if (anchor < 0) throw new Error('im-qqbot 行结构不认识，拒绝写入 cwd')
  lines.splice(anchor + 1, 0, line)
  return lines.join('\n')
}

/**
 * 只改 im-qqbot 行的 cwd（没有就插在 preset/appId/config 之后），其余原样保留。
 *
 * 写入走「读 → 算 → 比对 → 原子写」：算完再读一次，文件在窗口内被别人改过就
 * 重算（最多 3 次），绝不拿旧快照覆盖别人的写入；3 次都撞车就放弃并报错，
 * 原文件保持不动。
 */
export function writeBotWorkspace(patchPath, workspace) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const before = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
    const next = patchTextWithWorkspace(before, workspace)
    if (next === null) throw new Error('profile patch 里找不到 im-qqbot 行')
    if (next === before) return
    const current = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
    if (current !== before) continue
    writeFileAtomic(patchPath, next)
    return
  }
  throw new Error('cordis.patch.yml 在写入窗口内被外部修改，已放弃本次写入（原文件保留）')
}

/** 机器人工作区 + 额外受管目录，忽略大小写去重。 */
export function managedWorkspaces(botWorkspace, extras) {
  const list = []
  for (const item of [botWorkspace, ...cleanList(extras, 40)]) {
    if (typeof item !== 'string' || item.trim() === '') continue
    if (list.some((existing) => existing.toLowerCase() === item.trim().toLowerCase())) continue
    list.push(item.trim())
  }
  return list
}
