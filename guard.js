/**
 * qqbot-suite/guard — 给「某个工作区里的 agent」上工具闸门。
 *
 * 监听 `agent/created`：如果 agent 的 `session.header.cwd` 命中
 * 「机器人工作区 + 额外受管目录」，就对这个 agent 逐个
 * `agent.ctx.tools.restrict({ deny: [...] })`。
 *
 * 三条已知边界：
 *   - restrict 只能约束全局工具，preset 里的 scope-local 工具管不到；
 *   - 已有会话 resume 时 cwd 不会变，换工作区后要 /new；
 *   - 这是「看不见 + 调不到」，不是内核沙箱。
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { managedWorkspaces, DEFAULT_GROUP_TOOLS } from './config.js'
// 可改写的提示词原文：与设置页共用同一份常量（设置页看到的原文就是这里用的句子）。
import { PROMPT_TEXT as T } from './prompts.js'

export const name = 'qqbot-suite-guard'
export const inject = ['qqbotSuite', 'tools']

// ── 群聊工具白名单 ────────────────────────────────────────────────────
//
// 群里的边界是「只说话」：可以自己上网查一句，不能照着别人给的链接去读页面。
// 这两条在工具层这么切：web_search 留着，web_fetch 禁掉——别人丢链接想让它看，
// 唯一的出口就是 web_fetch。其余动作工具（命令、文件、发图发文件）一并挡掉。
//
// 判定「这是不是群聊会话」不能靠 cwd：群聊和私聊共用同一个机器人工作区。
// 靠 im-qqbot 自己写的正文前缀——`transport/inbound.js:buildUserMessage()` 在
// isGroup 时固定加 `[昵称 (openid)]`，私聊不加；`agent/inbox/inserted` 每次投递
// 都带这段正文，所以会话一开口就能认出来，不用猜 senderId 配对。
//
// 只标记群聊 agent：私聊和 GUI 会话完全不受影响。

// 群聊放行清单的默认值住 config.js（设置页要拿它做默认展示），这里只认配置。
const FALLBACK_GROUP_TOOLS = DEFAULT_GROUP_TOOLS
/**
 * 模式 2（`image.mode = 'agent'`）额外放行的读图工具。
 *
 * 它在 `@deepseek-ai/dsh-tool-fs` 里注册，名字固定。只在 agent 模式放行：
 * 另外两种模式下图片根本不会到 agent 手上，放开只会多一条能读本地任意图片的路径。
 * 不判断模型是否支持看图——read_image 自己会按模型路由拒绝。
 */
const GROUP_IMAGE_TOOL = 'read_image'
const GROUP_DENY_REASON = T['guard.deny']

/**
 * 模式 2 为了 `read_image` 挂了 `@deepseek-ai/dsh-tool-fs`，这个包同时带来 `read` / `write` / `edit`。
 *
 * 它们在 preset 里是 scope-local 工具，`tools.restrict()` 管不到（和 §6.6 里 web_search 一样），
 * 所以只能在 pre-execute 层挡。不加这一层，模式 2 会顺带把「读写本机文件」送给每一个 QQ 会话
 * （包括私聊）——那不是这个需求要的东西。
 */
const QQ_FS_DENIED_TOOLS = new Set(['read', 'write', 'edit'])
const QQ_FS_DENY_REASON = '这里只聊天，不读写文件。'
/** 所有 QQ 会话（群 + 私聊）的 agent。 */
const QQ_AGENTS_KEY = Symbol.for('dsh.qqbotSuiteQqAgents')

function qqAgents() {
  return (globalThis[QQ_AGENTS_KEY] ??= new WeakSet())
}

/** 把一个 agent 标成 QQ 会话（cwd 命中机器人工作区）。 */
export function markQqAgent(agent) {
  if (agent === null || typeof agent !== 'object') return false
  qqAgents().add(agent)
  return true
}

/** 文件读写工具对 QQ 会话一律拒绝；其余工具交给群聊白名单判断。 */
export function qqFsDenyReason(agent, toolName) {
  if (agent === null || typeof agent !== 'object') return undefined
  if (!qqAgents().has(agent)) return undefined
  if (typeof toolName !== 'string' || toolName === '') return undefined
  return QQ_FS_DENIED_TOOLS.has(toolName) ? QQ_FS_DENY_REASON : undefined
}
/** 群聊正文前缀 `[昵称 (openid)]`；私聊正文没有这一段。 */
const GROUP_SENDER_TAG = /^\[[^\]\n]{1,64} \([^)\n]{1,80}\)\]/
const GROUP_AGENTS_KEY = Symbol.for('dsh.qqbotSuiteGroupAgents')

/** 群聊 agent 集合（WeakSet：会话回收后自动释放）。 */
function groupAgents() {
  return (globalThis[GROUP_AGENTS_KEY] ??= new WeakSet())
}

function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : ''
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 这条入站正文是不是群聊的（带发送者标签）。 */
export function isGroupBody(message) {
  const text = messageText(message)
  if (text === '') return false
  // 带群历史时正文是 `[Chat history…][Current message]` + 当前这条，只看当前这条。
  const marker = '[Current message]'
  const body = text.includes(marker) ? text.slice(text.lastIndexOf(marker) + marker.length) : text
  return GROUP_SENDER_TAG.test(body.replace(/^\s+/, ''))
}

/** 把 agent 标成群聊会话。 */
export function markGroupAgent(agent) {
  if (agent === null || typeof agent !== 'object') return false
  groupAgents().add(agent)
  return true
}

/**
 * 群聊白名单（设置页的 `guard.allow` + 图片模式）。
 *
 * 不传 `allow` 时用 `DEFAULT_GROUP_TOOLS`（测试和旧调用方用）；显式传空数组
 * 就是「群里什么工具都不给」，不再退回默认——否则用户清空清单永远清不干净。
 * 模式只影响是否追加 `read_image`：其余工具一律拒绝，所以 agent 模式不会因为
 * 「能读图」顺带拿到读写文件的能力。
 */
export function groupAllowedTools(imageMode, allow) {
  const list = Array.isArray(allow) ? allow : FALLBACK_GROUP_TOOLS
  const allowed = new Set(list)
  if (imageMode === 'agent') allowed.add(GROUP_IMAGE_TOOL)
  return allowed
}

/**
 * 群聊 agent 的工具白名单判断：返回拒绝理由，或 undefined（放行）。
 * 非群聊 agent 一律放行——判定只看「这个 agent 是不是在群里说过话」。
 */
export function groupDenyReason(agent, toolName, imageMode = 'placeholder', allow) {
  if (agent === null || typeof agent !== 'object') return undefined
  if (!groupAgents().has(agent)) return undefined
  if (typeof toolName !== 'string' || toolName === '') return undefined
  if (groupAllowedTools(imageMode, allow).has(toolName)) return undefined
  return GROUP_DENY_REASON
}

/**
 * 记一行「agent 真的调了 read_image」。
 *
 * 这是回答用户那句「发送图片以后我不知道 agent 到底有没有读图」的唯一证据——
 * 有了它，配合 `gate.js` 的 `image-handoff`（给了哪些图），
 * 「给了没读」和「根本没给」就能一眼分开，不用再猜。
 * 只记事实，不改变任何放行结果；`read_image` 自己还会按模型路由再拒一次。
 */
function logImageRead(suite, exec) {
  try {
    const args = exec?.arguments
    const filePath = args !== null && typeof args === 'object' && typeof args.file_path === 'string'
      ? args.file_path
      : ''
    suite.logDebug?.({
      reason: 'image-read',
      allow: true,
      agent: typeof exec?.agent?.id === 'string' ? exec.agent.id : '',
      path: filePath,
    })
  } catch {
    // 日志失败不影响调用
  }
}

function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a === '' || b === '') return false
  return canonical(a).toLowerCase() === canonical(b).toLowerCase()
}

/** 插件入口。 */
export function apply(ctx) {
  const suite = ctx.qqbotSuite ?? ctx.get('qqbotSuite')
  if (suite === undefined) {
    ctx.logger?.warn?.('[qqbot-suite] qqbotSuite service unavailable, guard skipped')
    return
  }

  const log = (level, message) => {
    const logger = ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  }

  const snapshot = () => {
    const config = suite.current()
    // 工作区只用 gate 从官方会话模块拿到的那份（`sessionManager.config.cwd`）。
    // 机器人还没建过会话时这里是空串——**不读宿主 patch 兜底**：那份配置归宿主和官方插件，
    // 插件不该为了「早点知道路径」去翻别人的文件。没有它时受影响只有两条：
    // 设置页显示为空、`guard.deny` 等第一次会话建立后才挂上（见 AGENTS.md §6.7）。
    const workspace = typeof suite.botWorkspace === 'function' ? suite.botWorkspace() : ''
    const extras = Array.isArray(config.guard?.extras) ? config.guard.extras : []
    const deny = Array.isArray(config.guard?.deny) ? config.guard.deny : []
    const imageMode = typeof config.image?.mode === 'string' ? config.image.mode : 'placeholder'
    // 没配过（undefined）才退回默认清单；配了空数组就是真的一个都不放。
    const allow = Array.isArray(config.guard?.allow) ? config.guard.allow : FALLBACK_GROUP_TOOLS
    return {
      workspace,
      botWorkspace: workspace,
      extras,
      deny,
      allow,
      managed: managedWorkspaces(workspace, extras),
      imageMode,
      groupTools: [...groupAllowedTools(imageMode, allow)],
    }
  }

  // 只打一行诊断：以前这里还会往受管目录写 `.qqbot-guard.json` 标记，
  // 那个文件没有任何代码读取（纯排查用），已取消——受管目录不该被本插件写。
  const boot = snapshot()
  if (boot.managed.length === 0) {
    // 没有额外受管目录时，工作区只能等机器人报告；deny 非空就是「还没生效」而不是「已关闭」。
    const pending = boot.deny.length > 0 && boot.workspace === ''
    log('info', pending
      ? '[qqbot-suite] guard pending: 还没从机器人拿到工作区，deny 要等第一次会话建立后才挂上'
      : '[qqbot-suite] guard idle: 没有机器人工作区，也没有额外受管目录')
  } else if (boot.deny.length === 0) log('info', '[qqbot-suite] guard idle: empty deny list')
  else log('info', `[qqbot-suite] guard armed on ${boot.managed.join(', ')}: ${boot.deny.join(', ')}`)

  // 认群聊会话：正文带 `[昵称 (openid)]` 前缀的就是群。
  try {
    ctx.on('agent/inbox/inserted', (payload) => {
      if (!isGroupBody(payload?.message)) return
      if (markGroupAgent(payload?.agent)) log('info', `[qqbot-suite] agent ${payload.agent?.id ?? '?'} marked as group session`)
    }, { global: true })
  } catch (error) {
    log('warn', `[qqbot-suite] inbox events unavailable, group tool lock inactive: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 群聊工具白名单：白名单之外的调用在 pre-execute 层直接拒绝。
  // 不用 tools.restrict：它只认「继承来的全局工具」，preset 注册的 web_search /
  // web_fetch 传进去会抛 unknown global tool（见 AGENTS.md §6.6）。
  try {
    const tools = ctx.tools ?? ctx.get('tools')
    if (tools !== undefined && typeof tools.guard === 'function') {
      ctx.effect(() => tools.guard((exec) => {
        // 先挡文件读写：tool-fs 是 scope-local，restrict 管不到（群和私聊都要挡）。
        const fsDenied = qqFsDenyReason(exec?.agent, exec?.name)
        if (fsDenied !== undefined) return fsDenied
        // 群聊白名单每次调用都读当前配置：设置页切模式、改清单后立刻生效，不用重建会话。
        const now = suite.current()
        const mode = now?.image?.mode ?? 'placeholder'
        // undefined 交给 groupDenyReason 退默认；空数组是「真的什么都不放」。
        const allow = Array.isArray(now?.guard?.allow) ? now.guard.allow : undefined
        const reason = groupDenyReason(exec?.agent, exec?.name, mode, allow)
        // 拒绝语也走设置页的提示词覆盖（复用 qqbotSuite.copy，不另开配置通道）。
        const denied = reason === undefined
          ? undefined
          : (typeof suite.copy === 'function' ? suite.copy(reason) : reason)
        // 只记群聊 agent 的读图调用：这个 guard 是全局的，GUI/私聊会话也会过，
        // 不筛就把「我在编辑器里看了张图」也记进机器人的日志了。
        if (denied === undefined && exec?.name === GROUP_IMAGE_TOOL && groupAgents().has(exec?.agent)) {
          logImageRead(suite, exec)
        }
        return denied
      }), 'qqbot-suite:group-tools')
    } else {
      log('warn', '[qqbot-suite] tools.guard unavailable, group tool lock skipped')
    }
  } catch (error) {
    log('warn', `[qqbot-suite] group tool lock failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  /**
   * 把 QQ 会话挂进同名工作区。
   *
   * GUI 侧栏靠 `workspace.json` 里每个 workspace 的 sessionIds 显式列表；QQ bot
   * 走 `ctx.agents.create` 绕开了 GUI 建会话接口，所以 cwd 正确但不在任何
   * 工作区下面。这里在 agent 创建/恢复时补一次挂载。
   */
  const attachToWorkspace = async (agent, cwd) => {
    if (typeof cwd !== 'string' || cwd === '') return
    let registry
    try {
      registry = ctx.get('workspaceRegistry')
    } catch {
      return
    }
    if (registry === undefined || typeof registry.resolveByPath !== 'function') return
    const workspace = await registry.resolveByPath(cwd)
    if (workspace === undefined) return
    if (workspace.sessionIds?.includes(agent.session.id) === true) return
    await workspace.attachSession(agent.session.id)
    log('info', `[qqbot-suite] agent ${agent.id} attached to workspace ${workspace.path}`)
  }

  ctx.on('agent/created', async ({ agent }) => {
    const now = snapshot()
    const cwd = agent?.session?.header?.cwd

    // 先认「这是 QQ 会话」：群和私聊的 cwd 都是机器人工作区。
    // 标记要在下面那些 early return 之前做——文件读写拦截不依赖 deny 配置。
    try {
      if (typeof cwd === 'string' && now.managed.some((workspace) => samePath(cwd, workspace))) {
        markQqAgent(agent)
      }
    } catch {
      // 路径不能解析就跳过：群聊白名单那条路仍然有效
    }

    try {
      await attachToWorkspace(agent, cwd)
    } catch (error) {
      // 会话头可能还没落盘，attach 会校验失败；等下次 resume 再补，不打断创建。
      log('warn', `[qqbot-suite] workspace attach skipped: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (now.deny.length === 0 || now.managed.length === 0) return
    try {
      if (!now.managed.some((workspace) => samePath(cwd, workspace))) return
      const tools = agent?.ctx?.tools
      if (tools === undefined || typeof tools.restrict !== 'function') {
        log('warn', `[qqbot-suite] agent ${agent?.id ?? '?'}: agent.ctx.tools unavailable, skip`)
        try {
          suite.noteDenyResult?.({
            at: Date.now(),
            agentId: agent?.id ?? '',
            applied: [],
            failed: now.deny.map((tool) => ({ tool, message: 'agent.ctx.tools 不可用' })),
          })
        } catch {
          // 同上：只是少了提示
        }
        return
      }
      const applied = []
      const failed = []
      for (const tool of now.deny) {
        try {
          tools.restrict({ deny: [tool] })
          applied.push(tool)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failed.push({ tool, message })
          log('warn', `[qqbot-suite] cannot deny "${tool}": ${message}`)
        }
      }
      // 回写给设置页：名字写错 / 写成 scope-local 工具时 restrict 会抛错，
      // 以前只进 console warn，页面上看着像「已生效」。
      try {
        suite.noteDenyResult?.({ at: Date.now(), agentId: agent.id, applied, failed })
      } catch {
        // 旧服务对象没有这个方法就算了，不影响拦截
      }
      log('info', `[qqbot-suite] agent ${agent.id} @ ${cwd} restricted: ${applied.join(', ') || '(none)'}`)
    } catch (error) {
      log('warn', `[qqbot-suite] agent guard failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

// 测试专用导出：只在设置了 QQBOT_SUITE_DEV=1 的进程里注入（`node dev/tests/run.mjs`），
// 正常运行（dsh 加载本包）时是 undefined。
export const __test = process.env.QQBOT_SUITE_DEV === '1'
  ? {
  isGroupBody,
  markGroupAgent,
  markQqAgent,
  groupDenyReason,
  qqFsDenyReason,
  groupAllowedTools,
  groupAgents: () => groupAgents(),
  qqAgents: () => qqAgents(),
  DEFAULT_GROUP_TOOLS,
  GROUP_IMAGE_TOOL,
  GROUP_DENY_REASON,
  QQ_FS_DENIED_TOOLS,
  QQ_FS_DENY_REASON,
  }
  : undefined
