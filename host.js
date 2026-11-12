/**
 * 宿主 `@deepseek-ai/dsh-llm` 的取用与封装。
 *
 * 为什么单独一个文件：本插件用 link: 挂在 profile 外，裸导入 `@deepseek-ai/*`
 * 解析不到（profile 的 node_modules 里没有这个 scope）。套件本体（语义判断）
 * 和闸门（冷场补话要造一条 user 消息）都需要，所以放在这里共用一份：
 * 以宿主入口（`process.argv[1]` = dsh/lib/bin.js）为锚点同步 require 一次并缓存。
 * `DSH_HOST_ENTRY` 可显式指定锚点（测试或自定义启动方式用）。
 */
import { createRequire } from 'node:module'

/** 缓存的宿主 llm 模块命名空间；undefined = 还没解析，null = 解析失败。 */
let hostLlmModule

/**
 * 取宿主的 `@deepseek-ai/dsh-llm`（Node ≥22 支持同步 require ESM）。
 * @returns 模块命名空间（含 `BlockAssembler` / `createUserMessage`）。
 * @throws 解析不到时明确报错：判定链路宁可停，也不静默降级成猜形状。
 */
export function hostLlm() {
  if (hostLlmModule === undefined) {
    hostLlmModule = null
    for (const anchor of [process.env.DSH_HOST_ENTRY, process.argv[1], import.meta.url]) {
      if (typeof anchor !== 'string' || anchor === '') continue
      try {
        hostLlmModule = createRequire(anchor)('@deepseek-ai/dsh-llm')
        break
      } catch {
        // 换下一个锚点：环境变量 → 宿主入口 → 自身位置
      }
    }
  }
  if (hostLlmModule === null || typeof hostLlmModule.BlockAssembler !== 'function') {
    throw new Error(
      '宿主里找不到 @deepseek-ai/dsh-llm 的 BlockAssembler，无法解析流式返回；'
        + '这通常意味着宿主安装结构变了（本插件靠 process.argv[1] 定位宿主包）',
    )
  }
  return hostLlmModule
}

/** 建一个空的宿主装配器（`BlockAssembler` 是官方 agent loop 用的同一套算法）。 */
export function newAssembler() {
  const { BlockAssembler } = hostLlm()
  return new BlockAssembler()
}

/**
 * 注入宿主 llm 模块（测试/非常规启动方式用；正常路径靠 `process.argv[1]` 自己解析）。
 * @param module - `@deepseek-ai/dsh-llm` 命名空间，或 null 表示清空缓存。
 */
export function setHostLlm(module) {
  hostLlmModule = module ?? undefined
}

/**
 * 构造一条用户消息。官方 `createUserMessage` 返回的是**已深冻结**的消息，
 * 与「消息进 inbox 就被冻结」的约束一致；自己拼的对象没有这个保证。
 * @param text - 正文。
 * @returns 官方 user 消息。
 */
export function userMessageOf(text) {
  const { createUserMessage } = hostLlm()
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
