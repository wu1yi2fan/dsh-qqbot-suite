/**
 * qqbot-suite/idle — 冷场处理：补回被拦下的那条（A）或让 agent 自己找话（B）。
 *
 * 两个动作共用同一条触发条件，也就是用户定下的那条：
 *
 *   「群里最后一条不是 agent 说的，且已经安静超过阈值」
 *
 * 命中之后再分两种：
 *   - A（missed）：最后那条正好是被语义判定拦下的（`semantic-no`），把它按原样
 *     重新交给 agent —— 相当于「当时没回，过一会儿补回」；
 *   - B（chat）：否则就用一段场景说明唤醒它，说什么、说不说都让它自己定。
 *
 * 为什么阈值上限锁死在 30 分钟：dsh-qqbot 的 `IdleEvictor` 默认 30 分钟回收会话
 * （`sessionIdleTimeout`），回收后 record 被删、agent 被 dispose。触发时虽然会经
 * `getOrCreate` 重建（见 gate.js），但重建意味着一次 resume，没必要为「冷场」
 * 付出这个代价；30 分钟以内是热路径。
 *
 * 这个模块只做纯逻辑（判定、状态、拼正文），定时器和真正的 followup 在 gate.js：
 * 那边拿得到 agent，测试这边不启动宿主也能跑。
 */
import { clockOf, renderHistoryBlock } from './history.js'
// 可改写的提示词原文：与设置页共用同一份常量（设置页看到的原文就是这里用的句子）。
import { PROMPT_TEXT as T } from './prompts.js'

/** 冷场阈值（分钟）：用户要求锁死上限 30。 */
export const IDLE_MINUTES_MIN = 1
export const IDLE_MINUTES_MAX = 30
/** 每群每天最多主动说几次。 */
export const IDLE_DAILY_MIN = 1
export const IDLE_DAILY_MAX = 20
/** 活跃时段：24 表示到当天结束（0 点）；start > end 表示跨夜。 */
export const IDLE_HOUR_MIN = 0
export const IDLE_HOUR_MAX = 24
/**
 * 两次主动发言之间的最小间隔（分钟）：防止「说一句→又冷场→马上再说」的连环。
 * 默认 60 分钟，可配 1–240：调小等于允许它更频繁地开头，调大等于更克制。
 */
export const IDLE_COOLDOWN_MIN_MIN = 1
export const IDLE_COOLDOWN_MIN_MAX = 240
export const IDLE_COOLDOWN_DEFAULT_MIN = 60
/**
 * 主动说过一次之后，这么久还没人接话就当天收手。
 * 这条是防自嗨的主护栏：没人理的群，它越说越像自言自语。
 */
export const IDLE_SILENCE_MS = 30 * 60_000
/**
 * 超过这么久没动静就不算「冷场」了，算这个群今天没人。
 * 没有这条的话，重启后回填的历史群、或者一整天没人说话的群，都会在早上 9 点
 * 齐刷刷被搭话一遍——那不是防冷场，是定时广播。
 */
export const IDLE_STALE_MS = 3 * 60 * 60_000

/** 本地日期键（YYYY-MM-DD）：日上限和「当天静默」都按它算。 */
export function dayKey(at) {
  const date = new Date(Number.isFinite(at) ? at : Date.now())
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 小时是否落在活跃时段里。start === end 视为全天。 */
export function inActiveHours(hour, start, end) {
  if (!Number.isFinite(hour) || !Number.isFinite(start) || !Number.isFinite(end)) return true
  if (start === end) return true
  if (start < end) return hour >= start && hour < end
  // 跨夜：22 → 6
  return hour >= start || hour < end
}

/** 条目的稳定标识：人类消息一般有 messageId，没有就用时间戳兜底。 */
function keyOf(entry) {
  if (entry === null || typeof entry !== 'object') return ''
  if (typeof entry.id === 'string' && entry.id !== '') return entry.id
  return Number.isFinite(entry.at) ? `t${entry.at}` : ''
}

function newGroupState() {
  return {
    /** 最近一条被语义拦下、之后还没人接的消息（只存拼正文要用的字段） */
    pending: null,
    /** 上次触发时最后一条的 key，避免同一条消息反复触发 */
    lastHandled: '',
    /** 上次主动发言时间 */
    lastFireAt: 0,
    /** 日计数所属日期 + 次数 */
    day: '',
    count: 0,
    /** 主动发言后是否还在等有人接 */
    awaiting: false,
    awaitingAt: 0,
    /** 当天不再主动说话（日期键） */
    muted: '',
  }
}

/**
 * 每群的冷场状态。只活在内存里：重启后「今天说过几次」会清零，
 * 但阈值、冷却、防自嗨都还在，最坏结果是一天多重启几次时多插两句。
 */
export class IdleTracker {
  constructor() {
    this.groups = new Map()
  }

  stateOf(groupId) {
    if (typeof groupId !== 'string' || groupId === '') return newGroupState()
    let state = this.groups.get(groupId)
    if (state === undefined) {
      state = newGroupState()
      this.groups.set(groupId, state)
    }
    return state
  }

  /** 群里有人说话：之前那条被拦的就不再是「没人接」了。 */
  noteInbound(groupId) {
    const state = this.stateOf(groupId)
    state.pending = null
    state.awaiting = false
    state.awaitingAt = 0
  }

  /** 机器人自己说了话：同样让 pending 作废（它已经参与了这段对话）。 */
  noteBot(groupId) {
    const state = this.stateOf(groupId)
    state.pending = null
  }

  /**
   * 登记一条被语义判成「不回」的消息。
   * 只有 `semantic-no` 会走到这里：关键词模式下没匹配到的消息本来就该静默，
   * 补回它们等于把关键词模式悄悄变成「全部回复」。
   */
  noteMissed(groupId, entry) {
    if (entry === null || typeof entry !== 'object') return
    const state = this.stateOf(groupId)
    state.pending = {
      id: keyOf(entry),
      at: Number.isFinite(entry.at) ? entry.at : Date.now(),
      senderId: typeof entry.senderId === 'string' ? entry.senderId : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      text: typeof entry.text === 'string' ? entry.text : '',
    }
  }

  /** 触发成功：记下时间、计数、等待回应。 */
  noteFired(groupId, entry, now) {
    const state = this.stateOf(groupId)
    const day = dayKey(now)
    if (state.day !== day) {
      state.day = day
      state.count = 0
      if (state.muted !== day) state.muted = ''
    }
    state.count += 1
    state.lastFireAt = now
    state.lastHandled = keyOf(entry)
    state.pending = null
    state.awaiting = true
    state.awaitingAt = now
  }

  /** 没人接，当天收手。 */
  muteForDay(groupId, now) {
    const state = this.stateOf(groupId)
    state.muted = dayKey(now)
    state.awaiting = false
    state.awaitingAt = 0
  }

  /**
   * 这次没发出去（找不到会话、agent 正在跑、followup 抛错）。
   * 只把冷却时间往前推：不占当天的次数，也不标记「这条处理过了」，
   * 下次扫描还能再试一次——但别每 30 秒撞一次同样的墙。
   */
  noteFailed(groupId, now) {
    const state = this.stateOf(groupId)
    state.lastFireAt = now
  }

  reset() {
    this.groups.clear()
  }
}

/**
 * 判定这一刻该不该说话。纯函数：只读 state（不改），副作用由调用方按返回值处理。
 *
 * @returns {{ kind: 'missed'|'chat'|'none', entry?: object, reason: string, mute?: true }}
 *   `kind: 'missed'` = 补回被拦的那条；`'chat'` = 让 agent 自己找话；
 *   `'none'` 时 `reason` 说明为什么——调试日志里靠它定位「为什么没触发」。
 *   `since` 是本次进程的启动时间：早于它的消息只来自落盘回填，
 *   重启后不该对着昨天的记录搭话。
 */
export function decideIdle({ ring, state, config, now, since }) {
  const at = Number.isFinite(now) ? now : Date.now()
  const list = Array.isArray(ring) ? ring : []
  const conf = config !== null && typeof config === 'object' ? config : {}
  if (conf.enabled !== true) return { kind: 'none', reason: 'disabled' }

  const hour = new Date(at).getHours()
  if (!inActiveHours(hour, conf.hoursStart, conf.hoursEnd)) return { kind: 'none', reason: 'off-hours' }

  const last = list.length > 0 ? list[list.length - 1] : null
  if (last === null || typeof last !== 'object') return { kind: 'none', reason: 'empty' }
  // 用户定的判定：上一句是 agent 说的就不算冷场——它刚说完，正是等别人接的时候。
  if (last.bot === true) return { kind: 'none', reason: 'last-is-bot' }

  const st = state !== null && typeof state === 'object' ? state : newGroupState()
  const day = dayKey(at)
  if (st.muted === day) return { kind: 'none', reason: 'muted' }

  const today = st.day === day
  const used = today && Number.isFinite(st.count) ? st.count : 0
  const limit = Number.isFinite(conf.dailyLimit) ? conf.dailyLimit : 3
  if (used >= limit) return { kind: 'none', reason: 'daily-limit' }

  const lastFireAt = Number.isFinite(st.lastFireAt) ? st.lastFireAt : 0
  const cooldownMin = Number.isFinite(conf.cooldownMinutes) ? conf.cooldownMinutes : IDLE_COOLDOWN_DEFAULT_MIN
  if (lastFireAt > 0 && at - lastFireAt < cooldownMin * 60_000) return { kind: 'none', reason: 'cooldown' }

  const key = keyOf(last)
  if (key !== '' && st.lastHandled === key) return { kind: 'none', reason: 'already' }

  const minutes = Number.isFinite(conf.minutes) ? conf.minutes : 10
  const lastAt = Number.isFinite(last.at) ? last.at : at
  if (at - lastAt < minutes * 60_000) return { kind: 'none', reason: 'waiting' }
  // 启动前收到的消息只来自落盘回填。默认搭话（`catchUpOnStart`），因为那些消息
  // 是「当时真的有人说话、但没被回」——重启不该把它当成没发生过；
  // 关掉则只对本次进程收到的消息生效，重启即作废。
  const catchUp = Number.isFinite(since) && lastAt < since
  if (catchUp && conf.catchUpOnStart !== true) return { kind: 'none', reason: 'before-start' }
  // 太久没动静的不算冷场，算这个群今天没人（防重启后把死群挨个搭话）。
  if (at - lastAt > IDLE_STALE_MS) return { kind: 'none', reason: 'stale' }

  if (st.awaiting === true && at - (Number.isFinite(st.awaitingAt) ? st.awaitingAt : 0) > IDLE_SILENCE_MS) {
    return { kind: 'none', reason: 'gave-up', mute: true }
  }

  const pending = st.pending
  const pendingHit = pending !== null
    && typeof pending === 'object'
    && pending.id !== ''
    && pending.id === key
  // 重启后 `pending` 是空的（只在内存里），所以补回不能只认它：启动前那条如果
  // 至今 `answered` 还是 false，说明当时确实没回，按原样补回去才对。
  // 如果它曾经被放行并回复过，群里已经有一条 bot 发言排在它后面，
  // 上面 `last-is-bot` 就已经拦住了，走不到这里。
  const missedHit = pendingHit || (catchUp && last.answered !== true)
  if (conf.recallMissed !== false && missedHit) {
    return { kind: 'missed', entry: last, reason: pendingHit ? 'missed' : 'catch-up', catchUp }
  }

  return { kind: 'chat', entry: last, reason: 'idle', catchUp }
}

/** 历史块：和正常入站注入的是同一份渲染（见 history.js: renderHistoryBlock）。 */
export function historyBlockFor(ring, historyConfig) {
  const conf = historyConfig !== null && typeof historyConfig === 'object' ? historyConfig : {}
  if (conf.window === 0) return ''
  return renderHistoryBlock(ring, {
    window: conf.window,
    maxChars: conf.maxChars,
    markAnswered: conf.markAnswered !== false,
  })
}

/**
 * 方案 A 的正文：把被拦下的那条按官方入站格式重新交给 agent。
 *
 * `[昵称 (openid)] 正文` 这个前缀不能改：guard 靠它认群聊会话，看门狗也靠它配对。
 * 后面不加 `(@you)`——那条消息本来就没点名，补一个反而会误导它。
 *
 * `options.imageBlock`（2026-11-09 加）：那条消息自己的图片路径（`Image: <路径>`）。
 * 必须给：被拦下的图当时没进官方正文，补回时正文只剩历史环里的 `[图片×1]`，
 * agent 手里没有任何路径，只能猜——实测它猜的结果是一句「不接」直接发进群。
 * 位置在正文之后、那句提示之前：前缀和看门狗配对都不受影响。
 */
export function missedBody(entry, historyBlock = '', options = {}) {
  const name = typeof entry?.name === 'string' && entry.name !== '' ? entry.name : '某人'
  const senderId = typeof entry?.senderId === 'string' ? entry.senderId : ''
  const tag = senderId === '' ? `[${name}]` : `[${name} (${senderId})]`
  const body = typeof entry?.text === 'string' ? entry.text : ''
  const head = typeof historyBlock === 'string' && historyBlock !== '' ? historyBlock.trimEnd() : ''
  const imageBlock = typeof options?.imageBlock === 'string' ? options.imageBlock.trim() : ''
  return [
    ...(head === '' ? [] : [head]),
    `${tag} ${body}`,
    ...(imageBlock === '' ? [] : ['', imageBlock]),
    '',
    T['idle.missed'],
    T['idle.missed.placeholder'],
  ].join('\n')
}

/**
 * 模型有时不输出真正的空，而是输出一句「说明」：`[No response needed]`、`（沉默）`、
 * `（无需回复）`。官方链路只把「空输出」当成不说话（`if (!fullText.trim()) return`），
 * 这些不是空的，所以会原样发进群——2026-11-09 就真发过一条 `[No response needed]`。
 *
 * 只在**整条消息就是这个占位**时才算（超过 40 字一律放过），避免误杀正常回答。
 */
const NON_REPLY_PATTERNS = [
  /^no\s*response\s*(?:is\s*)?needed$/i,
  /^(?:无需|不需要|不用)(?:回复|回应|回答|回话)$/,
  /^(?:没有|无)(?:需要)?(?:回复|回应)的?(?:内容|消息|必要)?$/,
  /^(?:沉默|保持沉默|不说话|不回复|跳过)$/,
  /^$/,
  /^(?:…+|\.{3,}|。{1,3}|，|,)$/,
]

/** 整条正文是不是一句「不回复」的占位说明。 */
export function isNonReply(text) {
  if (typeof text !== 'string') return false
  const s = text.trim().replace(/^[*_`\s]+/, '').replace(/[*_`\s]+$/, '')
  if (s === '') return true
  if (s.length > 40) return false
  // 去掉一层包裹的括号/方括号再判断：`（沉默）` 和 `[No response needed]` 都要认。
  const inner = s.replace(/^[（(\[【]/, '').replace(/[）)\]】]$/, '').trim()
  return NON_REPLY_PATTERNS.some((re) => re.test(inner))
}

/**
 * 「它其实想沉默，但把决定写成了正文」——最典型就是单独两个字「不接」。
 *
 * 证据（2026-11-10 查会话存档）：turn 7 的推理原文是「我倾向不接。空输出。……
 * 但空输出需要什么都不说。直接结束。」，紧接着输出的正文就是「不接」；之后两轮
 * 推理为空、3 个 token，直接复读同一个词，最后在群里真发出去三条。
 *
 * 为什么**不**并进 `isNonReply`：这类词在真聊天里是正常回话（「这活你接不接」→
 * 「不接」），全局拦会误杀。只在冷场补回刚开过口、还没人接的那一轮里认（见
 * `gate.js: isIdleLabel`），平时一概不碰。
 */
const IDLE_LABEL_PATTERNS = [
  /^不(?:接|看|聊|回|说|答)(?:了|这张|这个|这图|这张图)?$/,
  /^(?:接|看)(?:不了|不住|不下去)(?:了)?$/,
  /^(?:跳过|略过|pass|skip)$/i,
  /^图(?:我)?(?:看|读)不了$/,
]

/** 整条正文是不是一句「决定不回」的标签。 */
export function isIdleSilence(text) {
  if (typeof text !== 'string') return false
  const s = text.trim().replace(/^[*_`\s]+/, '').replace(/[*_`|。.!！~～\s]+$/, '')
  // 真空输出由官方链路处理（`if (!fullText.trim()) return`），这里只认「有字但等于不说话」。
  if (s === '' || s.length > 10) return false
  const inner = s.replace(/^[（(\[【]/, '').replace(/[）)\]】]$/, '').trim()
  return IDLE_LABEL_PATTERNS.some((re) => re.test(inner))
}

/**
 * 方案 B 的正文：不是群友发言，也不是命令，而是一段「现在轮到你决定」的说明。
 *
 * 三条边界必须写清楚，否则会退化成助手腔或自嗨：
 *   1. 它只是群里的一个人，不是主持人；
 *   2. 说什么、说不说由它定（空输出 = 什么都不发，官方链路本来就这么处理）；
 *   3. 禁止输出「（沉默）」这类占位——它们会被当成正文真的发进群里。
 */
export function chatBody(options = {}) {
  const minutes = Number.isFinite(options.minutes) ? Math.max(1, Math.round(options.minutes)) : 0
  const entry = options.entry !== null && typeof options.entry === 'object' ? options.entry : {}
  const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : '某人'
  const text = String(entry.text ?? '').slice(0, 120)
  const historyBlock = typeof options.historyBlock === 'string' ? options.historyBlock : ''
  const when = minutes > 0 ? `群里已经安静了 ${minutes} 分钟` : '群里安静下来了'
  const tail = text === '' ? '' : `，最后一条是「${name}」在 ${clockOf(entry.at)} 说的：「${text}」`
  return [
    ...(historyBlock === '' ? [] : [historyBlock, '']),
    `（${when}${tail}。）`,
    '',
    T['idle.chat'],
    T['idle.chat.continue'],
    T['idle.chat.tone'],
    T['idle.chat.silent'],
    T['idle.chat.placeholder'],
  ].join('\n')
}

/**
 * 冷场那一轮追加的「先看图」例外段（2026-11-10 加）。
 *
 * 背景：群提示词第五节写着「别人发图不等于要你解说这张图。没人问你图里是什么、
 * 没人让你看，就别描述……」，模型把「没人让你看」读成「可以不看」。冷场补回恰恰
 * 常常是一张图、一个字都没有，它于是跳过读图，直接输出「不接」（19:02 那次：
 * 路径已经给了，`image-handoff from idle-recall` 有记录，它没读）。
 *
 * 为什么不直接改群提示词：那是用户自己写的、每轮由官方在同一处注入的静态段落
 * （`system-prompt/assemble`，order 90）。按句子去替换人家的原文，一旦对方改了措辞
 * 就静默失效；而且会把「正常聊天」也一起改掉——而这里要的只是**冷场那一轮**。
 *
 * 所以挂 order 91 紧跟其后，只在这一轮追加一段：位置更靠后、范围更具体。
 * 只松开「看不看」，不松「解不解说」——看完照样不逐项描述图里有什么。
 */
export const COLD_START_SECTION_NAME = 'qqbot:cold-start'
// 整段作为一条可改写项（原文见 prompts.js）。拆成多个字面量再 join 会让设置页
// 只能看到碎片、覆盖时还得逐句匹配，索性一段一条。
export const COLD_START_PROMPT = T['idle.coldstart']

/** 标记多久算这一轮（一轮跑不完也有超时兜底，agent 回到 idle 时会清）。 */
const COLD_START_TTL_MS = 10 * 60 * 1000
/** agent 对象 → 标记时间。用 WeakMap：会话被回收时自动消失，不需要清理。 */
const coldStartAgents = new WeakMap()

/** 记下「接下来这一轮是冷场触发的」（`fireIdle` 里 followup 之前调）。 */
export function markColdStart(agent, now = Date.now()) {
  if (agent === null || typeof agent !== 'object') return
  coldStartAgents.set(agent, now)
}

/** agent 这一轮跑完了（`agent/status === 'idle'`）就清掉标记，避免影响后面的正常回复。 */
export function clearColdStart(agent) {
  if (agent === null || typeof agent !== 'object') return
  coldStartAgents.delete(agent)
}

/** 当前这次 `system-prompt/assemble` 是不是冷场那一轮。 */
export function isColdStart(agent, now = Date.now()) {
  if (agent === null || typeof agent !== 'object') return false
  const at = coldStartAgents.get(agent)
  if (at === undefined) return false
  if (now - at > COLD_START_TTL_MS) {
    coldStartAgents.delete(agent)
    return false
  }
  return true
}

/**
 * 把例外段拼到这一轮的 system prompt 组装结果上。
 *
 * 纯函数形式是为了能被测试直接调（真实链路里由 index.js 的
 * `system-prompt/assemble` 监听器调用）。没打标记时**原样返回同一个对象**，
 * 普通回复的提示词一个字节都不动。
 *
 * @param {object} assembled `PromptPresentation`（有 sections 数组）
 * @param {object} agent `context.agent`
 * @param {number} [now] 便于测试时间
 * @param {Function} [copy] 提示词覆盖函数（`qqbotSuite.copy`）。不传就发内置原文——
 *   这一段同样在设置页「提示词改写」里，不接上的话就是「能看见、能填、但不生效」。
 */
export function coldStartAssembly(assembled, agent, now = Date.now(), copy = null) {
  if (!isColdStart(agent, now)) return assembled
  const text = typeof copy === 'function' ? copy(COLD_START_PROMPT) : COLD_START_PROMPT
  return {
    ...assembled,
    sections: [
      ...(Array.isArray(assembled?.sections) ? assembled.sections : []),
      { name: COLD_START_SECTION_NAME, order: 91, text },
    ],
  }
}
