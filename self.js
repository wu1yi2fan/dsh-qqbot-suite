/**
 * qqbot-suite/self — 把「QQ 机器人自己是谁」暴露成一个 agent 工具。
 *
 * 约束：
 *   - 启停由插件页面控制（bundle patch 里 qqbot-suite-self 默认 disabled）：
 *     停用 = 插件上下文销毁，tools.register 的 effect 随之注销工具，零凭据读取；
 *   - 只调 `/users/@me` 一个只读接口，名字和头像地址都是它的字段；
 *   - 头像只返回 URL，**不下载、不写任何目录**（以前会存进 ~/.dsh-qqbot/media 再发文件，
 *     现已取消：那既要写官方插件的目录，也绕不开群里的工具白名单）；
 *   - 优先借运行中的机器人实例：凭据和 token 都在它内存里，本插件不读任何文件；
 *   - 实例还没起来时，才退回 QQBOT_APPID / QQBOT_SECRET 或当前 profile 的 patch
 *     （不扫别的 profile，也不下载任何东西）；
 *   - 失败就抛错，让模型回答「查不到」，不编名字。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomeOf } from './config.js'

export const name = 'qqbot-suite-self'
export const inject = ['tools', 'qqbotSuite']

const TOOL_NAME = 'qqbot_bot_profile'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API_BASE = (process.env.QQBOT_BASE_URL ?? 'https://api.bot.qq.com').replace(/\/+$/, '')
const USER_AGENT = 'dsh-qqbot-suite/1.0.0'
const TOKEN_SAFETY_MS = 120_000
const ME_TTL_MS = 10 * 60_000
const HTTP_TIMEOUT_MS = 15_000

const DESCRIPTION = [
  "Read this QQ bot's own account profile: display name, bot id, avatar URL and share link.",
  'Use it when the user asks what your name or avatar is, or asks for your avatar link.',
  'The avatar is returned as a URL only — nothing is downloaded and no local file is created.',
  'Never guess or invent your own name: call this instead. Results are cached for 10 minutes.',
].join(' ')

/** 缓存：access_token */
let tokenCache
/** 缓存：/users/@me 结果 */
let meCache

function preferredProfilePatch() {
  const env = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim() !== ''
    ? process.env.DSH_PROFILE.trim()
    : 'web'
  return join(dshHomeOf(), 'profiles', env, 'cordis.patch.yml')
}

/**
 * 从 profile 的 cordis.patch.yml 里抠出 im-qqbot 那一段的 appId / appSecret。
 * 只认紧跟在 `- id: im-qqbot` 之后、下一条目出现之前的那几行。
 */
function parsePatchFile(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*-\s*id:\s*['"]?im-qqbot['"]?\s*$/.test(line))
  if (start < 0) return undefined

  let appId
  let secret
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*-\s*id:/.test(line)) break
    const idMatch = /^\s*appId:\s*['"]?([^'"\s#]+)['"]?/.exec(line)
    if (idMatch) appId = idMatch[1]
    const secretMatch = /^\s*appSecret:\s*['"]?([^'"\s#]+)['"]?/.exec(line)
    if (secretMatch) secret = secretMatch[1]
  }
  if (appId === undefined || secret === undefined) return undefined
  return { appId, secret }
}

/** 找凭据：环境变量 > 显式路径 > 当前 profile 的 patch。 */
function resolveCredentials(configPath) {
  const envAppId = typeof process.env.QQBOT_APPID === 'string' ? process.env.QQBOT_APPID.trim() : ''
  const envSecret = typeof process.env.QQBOT_SECRET === 'string' ? process.env.QQBOT_SECRET.trim() : ''
  if (envAppId !== '' && envSecret !== '') return { appId: envAppId, secret: envSecret, source: 'env' }

  // 只读当前 profile：别的 profile 里的 appSecret 不属于本插件该碰的东西，
  // 「挨个 profile 试」还会拿 A 的凭据去查 B 的机器人。
  const candidates = []
  if (typeof configPath === 'string' && configPath !== '') candidates.push(configPath)
  candidates.push(preferredProfilePatch())

  const seen = new Set()
  for (const file of candidates) {
    if (seen.has(file)) continue
    seen.add(file)
    const creds = parsePatchFile(file)
    if (creds !== undefined) return { ...creds, source: file }
  }

  throw new Error(
    '找不到 QQ 机器人凭据：设置 QQBOT_APPID / QQBOT_SECRET，'
      + '或在当前 profile 的 cordis.patch.yml 里配置 im-qqbot 的 appId / appSecret',
  )
}

/** 取 access_token（带内存缓存，提前 2 分钟过期）。 */
async function getToken(creds) {
  const now = Date.now()
  if (tokenCache !== undefined && tokenCache.appId === creds.appId && now < tokenCache.expiresAt) {
    return tokenCache.token
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ appId: creds.appId, clientSecret: creds.secret }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`获取 access_token 失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
  }
  const payload = await response.json()
  if (typeof payload?.access_token !== 'string' || payload.access_token === '') {
    throw new Error('获取 access_token 失败：响应里没有 access_token')
  }
  const ttlMs = (Number(payload.expires_in) > 0 ? Number(payload.expires_in) : 7200) * 1000
  tokenCache = {
    appId: creds.appId,
    token: payload.access_token,
    expiresAt: now + Math.max(ttlMs - TOKEN_SAFETY_MS, 60_000),
  }
  return tokenCache.token
}

/**
 * 通道一：借运行中的机器人实例。
 *
 * `QQBot` 实例内存里已经有 creds 和 tokenManager（官方自己换的 token 也在里面），
 * 用它调 `/users/@me` 就不必本插件再读一次 profile 里的 appSecret——
 * 这是唯一「不读文件、不落凭据」的路径。
 */
function channelFromBot(suite) {
  const bot = typeof suite?.bot === 'function' ? suite.bot() : null
  if (bot === null || typeof bot !== 'object') return undefined
  const creds = typeof bot.getCredentials === 'function' ? bot.getCredentials() : bot.creds
  if (typeof creds?.appId !== 'string' || creds.appId === '') return undefined
  if (typeof creds?.clientSecret !== 'string' || creds.clientSecret === '') return undefined
  if (typeof bot.tokenManager?.getAccessToken !== 'function') return undefined
  if (typeof bot.apiClient?.request !== 'function') return undefined
  return {
    appId: creds.appId,
    source: 'bot',
    get: async () => {
      const token = await bot.tokenManager.getAccessToken(creds.appId, creds.clientSecret)
      return bot.apiClient.request(token, 'GET', '/users/@me')
    },
  }
}

/** 通道二：自己换 token。只在实例还没起来时用（刚启动、机器人还没处理过消息）。 */
function channelFromConfig(configPath) {
  const creds = resolveCredentials(configPath)
  return {
    appId: creds.appId,
    source: creds.source,
    get: async () => {
      const token = await getToken(creds)
      const response = await fetch(`${API_BASE}/users/@me`, {
        headers: { Authorization: `QQBot ${token}`, 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (!response.ok) {
        tokenCache = undefined
        throw new Error(`获取机器人资料失败：/users/@me 返回 HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
      }
      return response.json()
    },
  }
}

/** 取机器人资料（带 10 分钟缓存，按 appId 分）。 */
async function fetchMe(channel) {
  if (meCache !== undefined && meCache.appId === channel.appId && Date.now() - meCache.at < ME_TTL_MS) {
    return meCache.data
  }
  const data = await channel.get()
  if (typeof data?.username !== 'string' || data.username === '') {
    const code = data?.err_code ?? data?.code
    throw new Error(code === undefined ? '/users/@me 返回体缺少 username' : `/users/@me 返回错误码 ${code}`)
  }
  meCache = { appId: channel.appId, data, at: Date.now() }
  return data
}

/**
 * 读机器人自己的资料。导出只为脱离 dsh 单测；套件内只有本文件的工具执行在用。
 * @param {{ suite?: object, configPath?: string }} [options]
 */
export async function getBotProfile(options = {}) {
  const channel = channelFromBot(options.suite) ?? channelFromConfig(options.configPath)
  const me = await fetchMe(channel)

  return {
    name: me.username,
    appId: channel.appId,
    botId: typeof me.id === 'string' ? me.id : '',
    shareUrl: typeof me.share_url === 'string' ? me.share_url : '',
    // 平台返回的就是一条公开的 qlogo 链接（http + s=0 缩略图）。原样给，不改写、不下载：
    // 想看图让调用方自己打开，插件的职责到这里为止。
    avatarUrl: typeof me.avatar === 'string' ? me.avatar : '',
  }
}

/** 注册 qqbot_bot_profile 工具；重名（旧 bundle 还占着）时抛错由调用方择机重试。 */
function registerTool(ctx, suite) {
  ctx.tools.register({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          appId: { type: 'string' },
          botId: { type: 'string' },
          shareUrl: { type: 'string' },
          avatarUrl: { type: 'string' },
        },
        required: ['name', 'appId', 'botId'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value.avatarUrl === 'string' && value.avatarUrl !== ''
          ? `名字：${value.name}；头像：${value.avatarUrl}`
          : `名字：${value.name}`,
      }],
    },
    async execute() {
      return getBotProfile({ suite })
    },
  })
}

/**
 * 活着的插件上下文计数：apply +1，dispose -1。
 * 套件设置页的「自动获取」接口用它判断插件页开关是否打开——
 * 只有插件启用时才允许读凭据，语义与「所有用凭据的功能都归 bot_profile」一致。
 */
let liveContexts = 0
export function isSelfActive() {
  return liveContexts > 0
}

/**
 * 注册工具。启停完全交给插件页面：插件启用 → apply 注册；停用 → 上下文销毁，
 * tools.register 返回的 disposer 自动注销工具（宿主用 layers.effect 实现）。
 */
export function apply(ctx) {
  const logger = ctx.logger ?? console
  // 运行中的机器人实例挂在套件服务上；拿到它就完全不碰凭据文件。
  const suite = ctx.qqbotSuite ?? (typeof ctx.get === 'function' ? ctx.get('qqbotSuite') : undefined)
  liveContexts += 1

  try {
    registerTool(ctx, suite)
    logger.info?.('[qqbot-suite] qqbot_bot_profile registered')
  } catch (error) {
    // 注册失败就让模型查不到「自己是谁」，不重试：同名工具只可能来自旧 bundle 残留，已不再兼容
    logger.warn?.(`[qqbot-suite] qqbot_bot_profile registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    ctx.effect(() => () => {
      liveContexts -= 1
    }, 'qqbot-suite:self-tool')
  } catch {
    // 没有 effect 能力时没有 dispose 回调，计数也就没机会减回去
    liveContexts -= 1
  }
}
