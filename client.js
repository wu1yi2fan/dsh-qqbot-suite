/**
 * qqbot-suite 浏览器半边：在 Harness 设置里加一个「QQ 机器人套件」栏目。
 *
 * 一页管三件事：
 *   - 群聊唤醒：关键词模式 / 语义判断 / 全部放行，外加自定义唤醒词；
 *   - 工作区与工具防护：机器人 cwd、额外受管目录、禁用的全局工具；
 *   - 运行状态：自动识别的机器人名字、语义模型、最近一次判断。
 *
 * 视觉跟 Harness 自己的设置页对齐（2026-11）：
 *   - 优先用 Harness 内置的 UI 原语（Switch / SegmentedControl / Tag / 图标）；
 *     它们由前端 bundle 注册在模块表里，可以 require 到，缺了就退回本地实现；
 *   - 版式照抄 Harness 设置行的尺寸：行高 padding 16px 0、.5px 分隔线、
 *     14px/22px 标题 + 12px/18px 描述、右侧 36px 高的胶囊控件。
 *
 * 宿主路由：GET /api/qqbot-suite/state、POST /api/qqbot-suite/config。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qqbot-suite',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    // Harness 的内置 UI 原语。它在浏览器模块表里（不是 npm 依赖），
    // 所以只能 try 一次：拿不到就用本地等价物，页面绝不能因为这里挂掉。
    const ui = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives') ?? null
      } catch {
        return null
      }
    })()

    const STATE_PATH = '/api/qqbot-suite/state'
    const CONFIG_PATH = '/api/qqbot-suite/config'
    const MODELS_PATH = '/api/qqbot-suite/models'
    const REPLAY_PATH = '/api/qqbot-suite/semantic/replay'
    const MARK_PATH = '/api/qqbot-suite/semantic/mark'
    // 「机器人名字」的自动获取：只在 bot_profile 开启时可用（服务端也会再校验一次）。
    const BOT_NAME_PATH = '/api/qqbot-suite/bot-name'
    // 群健康刷新：手动触发，服务端自己一分钟限一次（429 + retryAfterMs）。
    const HEALTH_PATH = '/api/qqbot-suite/health'

    /** 下拉里「手动填写」的哨兵值：不会和真实的 `provider/model` 撞。 */
    const MODEL_MANUAL = '__manual__'

    /**
     * 重放对象是从哪儿找到的（决定「当时判成什么」有多可信）。
     * 注意这**不是**「发出去的提示词是哪一版」——system 永远用当前模板，
     * 上下文能不能重拼看 `replayResult.requested.promptSource`。
     */
    const REPLAY_SOURCES = {
      judge: '内存里最近那次判断（模型取当时那次的）',
      log: '语义日志里的那次判断（模型取当时的）',
      history: '只剩聊天记录，上下文按聊天记录重建',
    }

    /**
     * 这次重放实际发出去的输入是哪一版：
     * current = 用记录里的结构化上下文 + 当前模板重拼；
     * recorded = 老日志没有结构化上下文，上下文只能原文照发。
     */
    const REPLAY_PROMPT_SOURCES = {
      current: 'system + 上下文都按当前模板重拼',
      recorded: '上下文用当时存下的原文（老日志没有结构化上下文，改模板不会重排）',
    }

    /**
     * 所有尺寸/颜色都对齐 Harness 自己的设置页（ui-theme 的 AppearanceRow /
     * FontSizeRow、locale 的 LanguageRow）：分隔线 .5px、行内边距 16px 0、
     * 控件高 36px、描述 12px。token 缺失时用浅色主题的字面值兜底。
     */
    const CSS = `
.qs-root {
  display: flex; flex-direction: column; max-width: 820px;
  padding: 4px 0 40px; color: var(--dsw-alias-label-primary, #0f1115);
  font-size: 14px; line-height: 22px;
}
.qs-head { display: flex; flex-direction: column; gap: 4px; padding-bottom: 4px; }
.qs-head h2 { margin: 0; font-size: 18px; font-weight: 500; line-height: 26px; letter-spacing: .1px; }
.qs-head p { margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; }

/* 分组名：跟 Harness 的「外观」一样，是一行的开始，不带额外装饰。 */
.qs-sec {
  padding: 26px 0 2px; font-size: 14px; font-weight: 400; line-height: 22px;
  color: var(--dsw-alias-label-primary, #0f1115);
}
/* 页签下面紧跟的第一个分组名，不用再空出 26px（页签自己有一段留白）。 */
.qs-tabs + .qs-panel > .qs-sec { padding-top: 8px; }
.qs-sec-hint { color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; }

.qs-row {
  display: flex; align-items: center; gap: 8px; padding: 16px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08));
}
.qs-rowtext { display: flex; flex-direction: column; flex: 1; gap: 4px; min-width: 0; padding-right: 48px; }
.qs-row-stack { flex-direction: column; align-items: stretch; gap: 10px; }
.qs-row-stack .qs-rowtext { padding-right: 0; }
.qs-title { color: var(--dsw-alias-label-primary, #0f1115); font-size: 14px; font-weight: 400; line-height: 22px; }
.qs-desc { color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; font-weight: 400; line-height: 18px; }
.qs-ctrl { display: inline-flex; align-items: center; gap: 8px; flex: none; }
.qs-note { margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; }
/* 保存条吸底：页签切来切去，保存按钮必须一直在手边。 */
.qs-foot {
  position: sticky; bottom: 0; z-index: 2;
  padding: 14px 0 4px;
  border-top: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08));
  background: var(--dsw-alias-bg-layer-2, #fff);
}

/* 大区页签：官方 SegmentedTabs 原样铺满内容列（它自己就是等分 grid）。 */
.qs-tabs { padding: 12px 0 2px; }

/* 三段选择：照抄 AppearanceRow 的 themeCube（圆角、内边距、选中态完全一致）。 */
.qs-cubes { display: flex; flex-wrap: wrap; align-items: stretch; gap: 8px; }
.qs-cube {
  box-sizing: border-box; flex: 180px; display: flex; flex-direction: column;
  justify-content: center; align-items: center; gap: 4px; padding: 26px 32px;
  border: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.15));
  border-radius: var(--dsw-radius-xl, 12px); background: none; color: inherit;
  font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;
}
.qs-cube:hover:not(.qs-cube-on) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.qs-cube-on {
  background: var(--dsw-alias-bg-module-platform, #f5f6f7);
  border-color: var(--dsw-static-neutral-bluish-400, #c9ced8);
}
.qs-cube-icon { display: inline-flex; }

/* 单选/数值：Harness 的 selector 胶囊（36px 高、bg-module-platform、圆角 md）。 */
.qs-select-wrap { position: relative; display: inline-flex; align-items: center; }
.qs-select {
  box-sizing: border-box; height: 36px; max-width: 100%; padding: 0 36px 0 14px;
  border: none; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-module-platform, #f5f6f7);
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;
  appearance: none; -webkit-appearance: none; outline: none;
}
.qs-select:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.qs-select:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: -2px;
}
.qs-chevron {
  position: absolute; right: 12px; pointer-events: none;
  color: var(--dsw-alias-label-tertiary, #81858c); display: inline-flex;
}
.qs-numwrap { display: inline-flex; align-items: center; gap: 8px; }
/* 数字字段外框：越界时下方多一行红字，不额外加描边（跟其余控件保持扁平）。 */
.qs-numfield { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.qs-field-err {
  color: var(--dsw-alias-state-error-primary, #b42318);
  font-size: 12px; line-height: 16px; white-space: nowrap;
}
.qs-num-bad { color: var(--dsw-alias-state-error-primary, #b42318); }
.qs-num {
  box-sizing: border-box; width: 84px; height: 36px; padding: 0 6px;
  border: none; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-module-platform, #f5f6f7);
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit; font-size: 14px; line-height: 22px; text-align: center;
  font-variant-numeric: tabular-nums; outline: none; -moz-appearance: textfield;
}
.qs-num::-webkit-outer-spin-button, .qs-num::-webkit-inner-spin-button {
  -webkit-appearance: none; margin: 0;
}
.qs-num:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.qs-num:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: -2px;
}
.qs-unit { color: var(--dsw-alias-label-secondary, #61666b); font-size: 14px; line-height: 22px; }

.qs-input {
  box-sizing: border-box; width: 100%; min-width: 240px; height: 36px; padding: 0 12px;
  border: none; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-module-platform, #f5f6f7);
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit; font-size: 14px; line-height: 22px; outline: none;
}
.qs-input:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.qs-input:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: -2px;
}
.qs-input-inline { min-width: 260px; width: auto; }

/* 多行：Harness 的独立字段样式（.5px 描边 + 圆角 md），不叠胶囊底色。 */
.qs-textarea {
  box-sizing: border-box; width: 100%; min-height: 84px; padding: 8px 12px;
  border: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.15));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit; font-size: 13px; line-height: 20px; resize: vertical; outline: none;
}
.qs-textarea::placeholder, .qs-input::placeholder { color: var(--dsw-alias-label-caption, #9aa0a6); }
.qs-textarea:focus-visible {
  border-color: transparent;
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: -2px;
}
.qs-textarea-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }

.qs-status {
  display: grid; grid-template-columns: 108px minmax(0, 1fr); gap: 6px 16px;
  align-items: start; padding: 10px 0;
}
@media (max-width: 640px) { .qs-status { grid-template-columns: 1fr; gap: 2px 0; } }
.qs-status-key { color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; padding-top: 1px; }
.qs-status-val { min-width: 0; overflow-wrap: anywhere; font-size: 13px; line-height: 20px; }
.qs-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary, #61666b); }

.qs-msg { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); }
.qs-msg-error { color: var(--dsw-alias-state-error-primary, #b42318); }
.qs-msg-ok { color: var(--dsw-alias-state-success-primary, #16794c); }
.qs-msg-warn { color: var(--dsw-alias-state-warn-primary, #9a6700); }
.qs-warn {
  margin: 0; padding: 9px 11px; border-radius: var(--dsw-radius-md, 8px);
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-state-warn-primary, #8a5a00);
  background: var(--dsw-alias-bg-module-platform, rgba(154,103,0,.08));
}
.qs-star {
  margin-left: 3px; font-weight: 700; cursor: help;
  color: var(--dsw-alias-state-warn-primary, #9a6700);
}

/* 行标题后面的「?」：悬停/聚焦弹出官方 Tooltip；拿不到原语时退回原生 title。
   扁平：没有底色和描边，只靠颜色变化表示可点。 */
.qs-hint {
  display: inline-flex; align-items: center; justify-content: center;
  box-sizing: border-box; width: 16px; height: 16px; margin-left: 4px; padding: 0;
  border: none; background: none; vertical-align: -2px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font: inherit; font-size: 12px; line-height: 16px; cursor: help;
}
.qs-hint:hover, .qs-hint:focus-visible { color: var(--dsw-alias-label-primary, #0f1115); }
.qs-hint:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: 1px; border-radius: var(--dsw-radius-sm, 4px);
}

/* 语义调试 / 漏判标记 */
.qs-block { display: flex; flex-direction: column; gap: 10px; padding: 16px 0; border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
.qs-block-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.qs-reasoning {
  margin: 0; padding: 10px 12px; max-height: 320px; overflow: auto;
  border: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.15));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-secondary, #61666b);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere;
}
.qs-details summary {
  cursor: pointer; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #81858c); list-style: none;
}
.qs-details summary::-webkit-details-marker { display: none; }
.qs-details summary::before { content: '▸ '; }
.qs-details[open] summary::before { content: '▾ '; }
.qs-misses {
  display: flex; flex-direction: column; max-height: 280px; overflow-y: auto;
  border-top: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08));
}
.qs-miss-row {
  display: flex; align-items: center; gap: 10px; padding: 7px 2px;
  border-bottom: .5px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06));
}
.qs-miss-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
/* 机器人的回复只当上下文：底色区分、正文降一档，不给标记按钮。 */
.qs-miss-bot { background: var(--dsw-alias-bg-module-platform, rgba(0,0,0,.03)); }
.qs-miss-bot .qs-miss-text { color: var(--dsw-alias-label-tertiary, #81858c); }
/* 已经回过的消息：留着当「它在回哪句」的线索，但不给标记按钮（不是漏判）。 */
.qs-miss-answered .qs-miss-text { color: var(--dsw-alias-label-secondary, #61666b); }
.qs-miss-file {
  flex: none; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; color: var(--dsw-alias-label-caption, #9aa0a6); cursor: help;
}
.qs-miss-time {
  flex: none; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; color: var(--dsw-alias-label-tertiary, #81858c); font-variant-numeric: tabular-nums;
}
.qs-miss-sender {
  flex: none; max-width: 88px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; color: var(--dsw-alias-label-tertiary, #81858c);
}
.qs-miss-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.qs-miss-note { flex: none; font-size: 11px; color: var(--dsw-alias-label-caption, #9aa0a6); cursor: help; }
.qs-mini {
  flex: none; height: 26px; padding: 0 10px; border-radius: var(--dsw-radius-sm, 6px);
  border: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.15));
  background: none; color: var(--dsw-alias-label-secondary, #61666b);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.qs-mini:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05));
  color: var(--dsw-alias-label-primary, #0f1115);
}
.qs-mini[data-on="true"] {
  color: var(--dsw-alias-brand-primary, #0f1115);
  border-color: var(--dsw-alias-brand-primary, #0f1115);
}
.qs-mini:disabled { opacity: .5; cursor: default; }
.qs-empty { padding: 18px; text-align: center; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 13px; }

/* 兜底控件：只在拿不到 Harness 原语时出现。 */
.qs-switch {
  box-sizing: border-box; position: relative; flex: none; width: 36px; height: 20px;
  padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3, #d4d7dc);
  cursor: pointer;
}
.qs-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary, #0f1115); }
.qs-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #fff); transition: transform .15s ease;
}
.qs-switch[aria-checked="true"] .qs-switch-thumb { transform: translate(16px); }

/* 折叠块：默认收起的可选子系统与诊断区（冷场、语义诊断、提示词改写、运行状态）。
   收起时只占一行，summary 自带状态徽标；展开后才渲染行。 */
.qs-collapse {
  margin: 10px 0 4px; border: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.15));
  border-radius: var(--dsw-radius-md, 8px);
}
.qs-collapse > summary {
  cursor: pointer; padding: 12px 16px; display: flex; align-items: center;
  justify-content: space-between; gap: 12px; list-style: none;
}
.qs-collapse > summary::-webkit-details-marker { display: none; }
.qs-collapse > summary::after { content: '▾'; font-size: 12px; opacity: .55; }
.qs-collapse[open] > summary::after { content: '▴'; }
.qs-collapse > summary .qs-desc { font-size: 12px; }
/* summary 左边：标题 + 一行补充（重放/标注/日志开关这类），窄屏时标题先不被压缩。 */
.qs-collapse-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1; flex-wrap: wrap; }
.qs-collapse-body { padding: 0 16px 8px; border-top: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.12)); }
.qs-collapse-body > .qs-row:first-child { border-top: none; }
/* 折叠块里的小节名（运行状态内部分「模型与判断 / 生效配置 / 路径」）。 */
.qs-subsec { padding: 14px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); }

/* 三张模式卡下面的逐条说明：不占卡内空间，又能横向比较。 */
.qs-modes-desc { display: flex; flex-direction: column; gap: 2px; }
.qs-mode-name { color: var(--dsw-alias-label-secondary, #61666b); }
/* 起止时间同一行：两个数字框 + 一字线。 */
.qs-hours { display: inline-flex; align-items: flex-start; gap: 8px; }
.qs-prompt-body { padding: 8px 0 4px; }
.qs-prompt-item { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; border-bottom: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.08)); }
.qs-prompt-item:last-of-type { border-bottom: none; }
.qs-prompt-label { flex: 0 0 170px; font-size: 13px; }
.qs-prompt-text { flex: 1; font-size: 12px; opacity: .72; word-break: break-all; }
.qs-prompt-editor { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.qs-prompt-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
/* 「谨慎」提醒：只在选中带 caution 的条目时出现，不占常显高度。 */
.qs-caution { color: var(--dsw-alias-state-warn-primary, #8a5a00); }
/* 「去哪改」指路：两条不在这里生效的东西，给出去处，免得在白填的地方反复试。 */
.qs-guide { display: flex; flex-direction: column; gap: 6px; margin: 0 0 12px; padding: 10px 12px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.qs-guide-row { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; line-height: 18px; }
.qs-guide-key { flex: none; min-width: 108px; font-weight: 600; color: var(--dsw-alias-label-primary, #0f1115); }
.qs-guide-val { flex: 1; min-width: 220px; color: var(--dsw-alias-label-secondary, #61666b); }
`

    const MODES = [
      {
        value: 'keywords',
        name: '关键词 / @ / 引用',
        short: '关键词',
        desc: '只在这条消息 @ 了机器人、引用了机器人的话、或叫到名字/唤醒词时才回。最省 token。',
        icon: 'IconPinOutlineRegular',
      },
      {
        value: 'semantic',
        name: '语义判断',
        short: '语义',
        desc: '上面都没命中时，让模型结合群聊上下文判断是不是在跟机器人说话。适合不引用、直接接话的群。',
        icon: 'IconThinkOutlineRegular',
      },
      {
        value: 'all',
        name: '全部放行',
        short: '全放行',
        desc: '群里每条消息都交给 agent。只建议在测试或小群使用。',
        icon: 'IconSendOutlineRegular',
      },
    ]

    /**
     * 大区页签：**固定四个**，不随回复模式增减。
     *
     * 分法按用户要回答的四问，不按代码模块：
     *   回复与节奏 —— 它什么时候说话（叫它什么 / 模式 / 连发 / 冷场 / 超时）
     *   消息与上下文 —— 它看到什么、发出去什么样（图片 / 缓存 / 群聊上下文 / 回复类型）
     *   语义判断 —— 它怎么判断（模型 / 预算 / 判断用上下文 / 诊断）
     *   权限与运行 —— 谁能指挥它、它在哪跑（斜杠名单 / 工作区 / 提示词 / 状态）
     *
     * 语义判断以前只在语义模式下出现，切走要弹确认、还会把没保存的参数一起丢掉；
     * 改成常驻后那套「丢弃确认」整段删掉了，见 requestMode。
     */
    const TABS = [
      { value: 'rhythm', label: '回复与节奏' },
      { value: 'contents', label: '消息与上下文' },
      { value: 'semantic', label: '语义判断' },
      { value: 'runtime', label: '权限与运行' },
    ]

    const IMAGE_MODES = [
      { value: 'ignore', label: '不读图（完全不收图片）' },
      { value: 'placeholder', label: '只留占位符' },
      { value: 'agent', label: '模型识别（agent 用 read_image 看图）' },
    ]
    const IMAGE_MODE_LABELS = {
      ignore: '不读图',
      placeholder: '只留占位符',
      agent: '模型识别',
    }

    // 回复的消息类型（后端 config.js: REPLY_FORMATS）。auto 是「按正文判断」。
    const REPLY_FORMAT_OPTIONS = [
      { value: 'auto', label: '自动（有结构才用 markdown）' },
      { value: 'text', label: '一律纯文本（旧客户端最稳）' },
      { value: 'markdown', label: '一律 markdown' },
    ]

    const EFFORTS = [
      { value: 'off', label: '关闭思考（推荐）' },
      { value: 'low', label: '低' },
      { value: 'high', label: '高' },
      { value: 'max', label: '最高' },
      { value: 'auto', label: '跟随模型默认' },
    ]

    const toList = (text) => String(text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')

    /** 列表里的时间戳：一律「月-日 时:分」，跨天看也不会错位。 */
    function fmtAt(at) {
      if (!Number.isFinite(at) || at <= 0) return '—'
      const date = new Date(at)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function decisionLabel(decision) {
      if (decision === null || decision === undefined) return '暂无'
      const reasons = {
        mention: '@ 了机器人',
        'quote-bot': '引用机器人',
        'wake-word': '叫到名字/唤醒词',
        'slash-command': '斜杠命令',
        private: '私聊',
        all: '全部放行',
        'semantic-yes': '语义判断：在叫它',
        'semantic-no': '语义判断：没叫它',
        'semantic-error': '语义判断失败',
        'group-image': '群聊图片拦截',
        'group-image-only': '纯图片消息',
        'bot-echo': '机器人自己的回声',
        'no-match': '没叫它',
      }
      const label = reasons[decision.reason] ?? String(decision.reason ?? '未知').replace(/^semantic-error:.*/, '语义判断失败')
      const action = decision.allow === true ? '放行' : '忽略'
      const when = typeof decision.at === 'number' ? new Date(decision.at).toLocaleTimeString() : ''
      const text = decision.text ? ` · ${decision.text}` : ''
      const images = decision.images === 'blocked'
        ? ' · 图片拦截'
        : typeof decision.images === 'string' && decision.images.startsWith('stripped:')
          ? ` · 图片已丢弃(${decision.images.slice('stripped:'.length)})`
          : ''
      const error = typeof decision.error === 'string' && decision.error !== ''
        ? ` · ${decision.error.slice(0, 120)}`
        : ''
      const slash = decision.slash === 'filtered' ? ' · 已去掉行首 /' : ''
      return `${label} → ${action}${images}${slash}${text}${error}${when ? `（${when}）` : ''}`
    }

    function verdictLabel(value) {
      const labels = { yes: '在叫它', no: '没叫它', unknown: '没按格式', error: '调用失败' }
      return labels[value] ?? String(value ?? '未知')
    }

    /**
     * 一条「冷场主动发言」的说明。
     *
     * 这条链路**不经过语义判定**（见 dev/AGENTS.md §6.14），所以这里说的
     * `ok` 是「有没有真的发到群里」，跟「该不该回」是两件事，别和上周的判定混着看。
     */
    function idleRowLabel(item) {
      const kind = item?.kind === 'missed'
        ? '补回被拦下的那条'
        : item?.kind === 'chat'
          ? '自己找话'
          : item?.kind === 'drop'
            ? '占位符被拦下'
            : '主动发言'
      const outcome = item?.ok === true ? '已发出' : `没发出去（${item?.reason ?? '未知'}）`
      const who = typeof item?.name === 'string' && item.name !== ''
        ? item.name
        : (typeof item?.sender === 'string' ? item.sender : '')
      const text = typeof item?.text === 'string' && item.text !== '' ? `「${item.text}」` : ''
      return `${kind} · ${outcome}${who === '' ? '' : ` · ${who}`}${text === '' ? '' : ` ${text}`}`
    }

    // ── 内置原语 + 兜底 ───────────────────────────────────────────────
    // Harness 的 Switch / Tag 签名：<Switch checked onChange(label) label />、
    // <Tag tone="neutral" />；图标组件吃 { size, className }。
    function Icon(name, size) {
      const component = ui?.[name]
      if (component === undefined || component === null) return null
      return h(component, { size: size ?? 16 })
    }

    function Chevron() {
      const component = Icon('IconChevronDownOutlineRegular', 16)
      return h('span', { className: 'qs-chevron', 'aria-hidden': 'true' }, component)
    }

    function Toggle(props) {
      if (typeof ui?.Switch === 'function') {
        return h(ui.Switch, {
          checked: props.checked === true,
          onChange: (next) => props.onChange(next),
          label: props.label ?? '',
          title: props.title,
        })
      }
      // 兜底：和内置 Switch 同样的几何（36×20、thumb 16）与 aria 语义。
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked === true,
        'aria-label': props.label ?? '',
        title: props.title,
        className: 'qs-switch',
        onClick: () => props.onChange(props.checked !== true),
      }, h('span', { className: 'qs-switch-thumb', 'aria-hidden': 'true' }))
    }

    function Tag(props) {
      if (typeof ui?.Tag === 'function') {
        return h(ui.Tag, { tone: props.tone ?? 'neutral' }, props.children)
      }
      return h('span', { className: 'qs-msg' }, props.children)
    }

    function Segmented(props) {
      if (typeof ui?.SegmentedControl === 'function') {
        return h(ui.SegmentedControl, {
          id: props.id,
          value: props.value,
          options: props.options,
          onChange: props.onChange,
          label: props.label,
        })
      }
      return h(Select, {
        id: props.id,
        value: props.value,
        options: props.options,
        onChange: props.onChange,
        ariaLabel: props.label,
      })
    }

    /**
     * 大区页签。官方 SegmentedTabs 自带 role=tablist、方向键/Home/End 切换、
     * 滑动指示块；格子数是按 items.length 算的，所以条数可以跟着模式变。
     * 拿不到原语就退回下拉，绝不让页面挂掉。
     */
    function Tabs(props) {
      const body = typeof ui?.SegmentedTabs === 'function'
        ? h(ui.SegmentedTabs, {
            items: props.items,
            value: props.value,
            onChange: props.onChange,
            label: props.label,
          })
        : h(Select, {
            value: props.value,
            options: props.items.map((item) => ({ value: item.value, label: item.label })),
            onChange: props.onChange,
            ariaLabel: props.label,
          })
      return h('div', { className: 'qs-tabs' }, body)
    }

    // ── 版式零件 ─────────────────────────────────────────────────────

    /** 设置行：左边标题 + 描述，右边控件。stacked 时控件/内容占满下一行。 */
    function Row(props) {
      const title = Array.isArray(props.title) ? props.title : [props.title]
      const desc = props.desc === undefined || props.desc === null
        ? null
        : (Array.isArray(props.desc) ? props.desc : [props.desc])
      return h('div', { className: `qs-row${props.stacked ? ' qs-row-stack' : ''}` },
        h('div', { className: 'qs-rowtext' },
          h('span', { className: 'qs-title' },
            ...title,
            props.star ? h(Star) : null,
            props.hint ? h(Hint, { text: props.hint, label: props.hintLabel ?? (typeof title[0] === 'string' ? `${title[0]}：详细说明` : '详细说明') }) : null
          ),
          desc === null ? null : h('span', { className: 'qs-desc' }, ...desc)
        ),
        props.control ? h('div', { className: 'qs-ctrl' }, props.control) : null,
        props.children ?? null
      )
    }

    /** 带星号的项：只在建会话时读一次，改完要 /new 重开会话才生效。 */
    function Star() {
      return h('span', { className: 'qs-star', title: '改完要发 /new 重开会话才生效（旧会话保持原样）' }, '*')
    }

    /**
     * 行标题后面的「?」：详细说明走 Harness 内置的 Tooltip（悬停 / 键盘聚焦弹出，
     * 点一下还能钉住慢慢读——说明都比较长）。拿不到原语就退回原生 title，
     * 保证说明永远读得到，页面也不会因为缺组件白屏。
     */
    function Hint(props) {
      const text = props.text ?? ''
      const icon = Icon('IconInfoOutlineRegular', 14)
      const glyph = icon ?? '?'
      if (typeof ui?.Tooltip === 'function') {
        return h(ui.Tooltip, {
          label: text,
          side: 'top',
          maxWidth: 340,
          // 设置页在一个可滚动容器里，气泡挂到 body 上才不会被裁掉。
          portal: true,
          // 信息按钮：点一下钉住气泡，Esc / 再点一下 / 点别处关闭。
          openOnClick: true,
        }, h('button', {
          type: 'button',
          className: 'qs-hint',
          'aria-label': props.label ?? '详细说明',
        }, glyph))
      }
      return h('button', {
        type: 'button',
        className: 'qs-hint',
        title: text,
        'aria-label': props.label ?? '详细说明',
      }, glyph)
    }

    /** 分组标题：对应 Harness 设置页里的「外观」那一行。 */
    function GroupTitle(props) {
      return h('div', { className: 'qs-sec' },
        props.title,
        props.hint ? h('div', { className: 'qs-sec-hint' }, props.hint) : null
      )
    }

    /**
     * 折叠块：给「默认关的可选功能」和「只读诊断区」用。
     *
     * 原生 details，收起时只占一行；summary 右边带一个状态徽标（已开启 / 已覆盖 N 项 /
     * 正常），不展开也知道里面什么状态。只在内容长且不需要常看的地方用，
     * 别拿它当分组的替代——分组名才是扫读的主干。
     */
    function Collapse(props) {
      return h('details', { className: 'qs-collapse', open: props.open === true ? true : undefined },
        h('summary', null,
          h('span', { className: 'qs-collapse-title' },
            h('span', { className: 'qs-title' }, props.title),
            props.note ? h('span', { className: 'qs-desc' }, props.note) : null
          ),
          props.badge ? h(Tag, { tone: props.tone ?? 'neutral' }, props.badge) : null
        ),
        h('div', { className: 'qs-collapse-body' }, props.children)
      )
    }

    /** 保存按钮：内置 Button 有就用它，否则退回本地样式按钮。 */
    function ActionButton(props) {
      if (typeof ui?.Button === 'function') {
        return h(ui.Button, {
          variant: props.variant ?? 'primary',
          size: props.size,
          disabled: props.disabled === true,
          onClick: props.onClick,
        }, props.children)
      }
      return h('button', {
        type: 'button',
        className: 'qs-mini',
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, props.children)
    }

    function Select(props) {
      return h('span', { className: 'qs-select-wrap' },
        h('select', {
          id: props.id,
          className: 'qs-select',
          value: props.value,
          'aria-label': props.ariaLabel,
          onChange: (event) => props.onChange(event.target.value),
        }, ...props.options.map((item) => h('option', { key: item.value, value: item.value }, item.label))),
        Chevron()
      )
    }

    function NumberField(props) {
      // 越界就地提示，不等到保存：输入框里的数字变红 + 下方一行「超出 min–max」。
      // 留空或非数字不在这里判（保存时按默认值兜底），只提示真的越界的值。
      const text = props.value === null || props.value === undefined ? '' : String(props.value).trim()
      const number = Number(text)
      const invalid = text !== '' && Number.isFinite(number) && (number < props.min || number > props.max)
      return h('span', { className: 'qs-numfield' },
        h('span', { className: 'qs-numwrap' },
          h('input', {
            id: props.id,
            className: `qs-num${invalid ? ' qs-num-bad' : ''}`,
            type: 'number',
            min: props.min,
            max: props.max,
            step: props.step,
            value: props.value,
            'aria-invalid': invalid ? 'true' : undefined,
            onChange: (event) => props.onChange(event.target.value),
          }),
          props.unit ? h('span', { className: 'qs-unit' }, props.unit) : null
        ),
        invalid ? h('span', { className: 'qs-field-err' }, `超出 ${props.min}–${props.max}，请重新输入`) : null
      )
    }

    function ModeCube(props) {
      const selected = props.value === props.current
      const icon = Icon(props.icon, 20)
      return h('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': selected,
        'aria-label': props.label,
        className: `qs-cube${selected ? ' qs-cube-on' : ''}`,
        title: props.desc,
        onClick: () => props.onSelect(props.value),
      },
        icon === null ? null : h('span', { className: 'qs-cube-icon', 'aria-hidden': 'true' }, icon),
        h('span', null, props.name)
      )
    }

    function SettingsSection() {
      const [state, setState] = react.useState(null)
      const [mode, setMode] = react.useState('keywords')
      const [botName, setBotName] = react.useState('')
      // self 子插件（qqbot_bot_profile）是否启用——插件页面控制，设置页只读不动它。
      const [selfActive, setSelfActive] = react.useState(false)
      const [botNameFetchBusy, setBotNameFetchBusy] = react.useState(false)
      // 「自动获取」的就地提示：拿到名字 / 失败原因都显示在这一行下面，不占用底部保存条。
      const [botNameNote, setBotNameNote] = react.useState(null)
      // 群健康：缓存值 + 刷新中 + 就地提示（限流 / 失败原因）。
      const [health, setHealth] = react.useState(null)
      const [healthBusy, setHealthBusy] = react.useState(false)
      const [healthNote, setHealthNote] = react.useState(null)
      // 「最近的主动发言」手动刷新：只换那一列，不动表单。
      const [idleRefreshBusy, setIdleRefreshBusy] = react.useState(false)
      const [wakeWords, setWakeWords] = react.useState('')
      const [slashIds, setSlashIds] = react.useState('')
      const [imageMode, setImageMode] = react.useState('placeholder')
      // 回复消息类型：auto = 按正文判断（默认），text / markdown = 不判断。
      const [replyFormat, setReplyFormat] = react.useState('auto')
      const [debug, setDebug] = react.useState(false)
      const [maxHistory, setMaxHistory] = react.useState('12')
      // 判定时「隔多久算换了话题」（分钟）：聊天记录带时间，间隔超过它就不再套用
      // 「紧跟着它说话的短反应算 YES」。默认 30，跟后端 DEFAULT_CONFIG 一致。
      const [staleMinutes, setStaleMinutes] = react.useState('30')
      const [maxFiles, setMaxFiles] = react.useState('100')
      // 历史图片召回：相邻间隔超过多少分钟算两批、单轮最多给 agent 几张。
      const [recallGap, setRecallGap] = react.useState('1')
      const [recallMax, setRecallMax] = react.useState('4')
      const [histWindow, setHistWindow] = react.useState('20')
      const [histChars, setHistChars] = react.useState('2000')
      const [histPersist, setHistPersist] = react.useState(true)
      const [histMark, setHistMark] = react.useState(true)
      // 多条消息合并：开着才显示窗口时长（毫秒）。默认关，跟后端 DEFAULT_CONFIG 一致。
      const [mergeOn, setMergeOn] = react.useState(false)
      const [mergeMs, setMergeMs] = react.useState('800')
      // 冷场主动发言：群里安静超过 idleMinutes 分钟、且最后一条不是它说的，才触发。
      // 分钟数上限锁死 30（后端 LIMITS.idleMinutes），超过就要 resume 被回收的会话。
      const [idleOn, setIdleOn] = react.useState(false)
      const [idleMinutes, setIdleMinutes] = react.useState('10')
      // 两次主动发言的最小间隔（分钟），默认 60。调小 = 允许更频繁开头。
      const [idleCooldown, setIdleCooldown] = react.useState('60')
      const [idleDaily, setIdleDaily] = react.useState('3')
      const [idleHourStart, setIdleHourStart] = react.useState('9')
      const [idleHourEnd, setIdleHourEnd] = react.useState('24')
      const [idleMissed, setIdleMissed] = react.useState(true)
      const [idleCatchUp, setIdleCatchUp] = react.useState(true)
      const [timeoutMs, setTimeoutMs] = react.useState('8000')
      // 判断模型：'' = 跟随默认模型，'provider/model' = 指定，MODEL_MANUAL = 用手填的那串。
      const [modelPick, setModelPick] = react.useState('')
      const [modelText, setModelText] = react.useState('')
      const [catalog, setCatalog] = react.useState([])
      const [catalogError, setCatalogError] = react.useState('')
      const [catalogLoading, setCatalogLoading] = react.useState(true)
      const [effort, setEffort] = react.useState('off')
      const [maxTokens, setMaxTokens] = react.useState('256')
      const [discardThinking, setDiscardThinking] = react.useState(true)
      const [replayEffort, setReplayEffort] = react.useState('high')
      const [replayBusy, setReplayBusy] = react.useState(false)
      // 正在重放的那一行（空 = 最近一次判断）。只用来给按钮显示「重放中…」。
      const [replayRow, setReplayRow] = react.useState('')
      const [replayResult, setReplayResult] = react.useState(null)
      const [replayError, setReplayError] = react.useState('')
      // 从列表里点的那一条，结果区在它上面很远的地方：出结果后滚过去看一眼。
      const replayResultRef = react.useRef(null)
      react.useEffect(() => {
        if (replayResult === null || replayResult === undefined) return
        replayResultRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
      }, [replayResult])
      const [markBusy, setMarkBusy] = react.useState('')
      const [markError, setMarkError] = react.useState('')
      const [watchEnabled, setWatchEnabled] = react.useState(true)
      const [watchSeconds, setWatchSeconds] = react.useState('15')
      const [watchMessage, setWatchMessage] = react.useState('')
      const [workspace, setWorkspace] = react.useState('')
      const [extras, setExtras] = react.useState('')
      const [deny, setDeny] = react.useState('')
      // 群聊放行清单（白名单）：跟上面的黑名单成对，群里不在清单里的工具一律拒。
      const [allow, setAllow] = react.useState('')
      // Prompt 设置（默认折叠）：覆盖表 + 可选句子目录都由 /state 下发。
      const [promptCatalog, setPromptCatalog] = react.useState([])
      // 下拉里的分组顺序与标题；条目自带 group 字段，两边都缺时退回平铺。
      const [promptGroups, setPromptGroups] = react.useState([])
      const [promptOverrides, setPromptOverrides] = react.useState({})
      const [promptPick, setPromptPick] = react.useState('')
      const [promptDraft, setPromptDraft] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [message, setMessage] = react.useState('')
      const [failed, setFailed] = react.useState(false)
      // 这次保存有没有动到「要 /new 才生效」的项：只影响提示颜色，不参与保存。
      const [needNew, setNeedNew] = react.useState(false)
      // 大区页签：固定四格，只在会话内记用户选了哪一格（不落盘）。
      const [viewRaw, setViewRaw] = react.useState(TABS[0].value)

      const applyState = (next) => {
        if (next === null || next === undefined) return
        setState(next)
        setMode(next.mode ?? 'keywords')
        setBotName(next.botName ?? '')
        setSelfActive(next.selfActive === true)
        setWakeWords((next.wakeWords ?? []).join('\n'))
        setSlashIds((next.slash?.allowIds ?? []).join('\n'))
        setImageMode(next.image?.mode ?? 'placeholder')
        setDebug(next.debug === true)
        setMaxHistory(String(next.semantic?.maxHistory ?? 12))
        setStaleMinutes(String(next.semantic?.staleMinutes ?? 30))
        setMaxFiles(String(next.media?.maxFiles ?? 100))
        setRecallGap(String(next.image?.recall?.gapMinutes ?? 1))
        setRecallMax(String(next.image?.recall?.maxImages ?? 4))
        setHistWindow(String(next.history?.window ?? 20))
        setHistChars(String(next.history?.maxChars ?? 2000))
        setHistPersist(next.history?.persist !== false)
        setHistMark(next.history?.markAnswered !== false)
        setMergeOn(next.merge?.enabled === true)
        setMergeMs(String(next.merge?.windowMs ?? 800))
        setIdleOn(next.idle?.enabled === true)
        setIdleMinutes(String(next.idle?.minutes ?? 10))
        setIdleCooldown(String(next.idle?.cooldownMinutes ?? 60))
        setIdleDaily(String(next.idle?.dailyLimit ?? 3))
        setIdleHourStart(String(next.idle?.hoursStart ?? 9))
        setIdleHourEnd(String(next.idle?.hoursEnd ?? 24))
        setIdleMissed(next.idle?.recallMissed !== false)
        setIdleCatchUp(next.idle?.catchUpOnStart !== false)
        setReplyFormat(next.reply?.format ?? 'auto')
        setTimeoutMs(String(next.semantic?.timeoutMs ?? 8000))
        setModelPick(typeof next.semantic?.model === 'string' ? next.semantic.model : '')
        setModelText(typeof next.semantic?.model === 'string' ? next.semantic.model : '')
        setEffort(next.semantic?.reasoningEffort ?? 'off')
        setMaxTokens(String(next.semantic?.maxTokens ?? 256))
        setDiscardThinking(next.semantic?.discardThinking !== false)
        setWatchEnabled(next.timeout?.enabled !== false)
        setWatchSeconds(String(Math.round((next.timeout?.ms ?? 15000) / 1000)))
        setWatchMessage(typeof next.timeout?.message === 'string' ? next.timeout.message : '')
        setWorkspace(next.guard?.workspace ?? '')
        setExtras((next.guard?.extras ?? []).join('\n'))
        setDeny((next.guard?.deny ?? []).join('\n'))
        setAllow((next.guard?.allow ?? []).join('\n'))
        // 群健康是缓存值，保存/刷新后跟着重绘。
        setHealth(next.health ?? null)
        setPromptCatalog(Array.isArray(next.promptCatalog) ? next.promptCatalog : [])
        setPromptGroups(Array.isArray(next.promptGroups) ? next.promptGroups : [])
        setPromptOverrides(next.promptOverrides !== null && typeof next.promptOverrides === 'object'
          ? next.promptOverrides
          : {})
      }

      /**
       * 换回复模式：直接切，不再拦一道。
       *
       * 以前语义参数会随模式消失（那一格页签是条件渲染的），所以切走前要把没保存的
       * 语义参数问一句「要不要丢」。现在语义判断是常驻页签、参数一直在页面上，
       * 切模式只影响它生不生效，不影响值还在不在——确认条和「丢弃」这套一并删掉。
       */
      const requestMode = (next) => {
        if (next === mode) return
        setMode(next)
      }

      /** 切页签。 */
      const changeView = (next) => {
        setViewRaw(next)
      }

      react.useEffect(() => {
        let alive = true
        fetch(STATE_PATH, { credentials: 'same-origin', cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((data) => {
            if (!alive) return
            if (data?.ok !== true) throw new Error(data?.error?.message ?? '返回体不带 ok')
            applyState(data.state)
          })
          .catch((error) => {
            if (!alive) return
            setFailed(true)
            setMessage(`读不到当前配置：${error instanceof Error ? error.message : String(error)}`)
          })
        return () => { alive = false }
      }, [])

      // 「自动获取」机器人名字：走 bot_profile 同一条凭据链路，服务端会先校验开关
      // 已保存开启。拿到名字只填进输入框，不自动保存——和手填一样，等用户点保存。
      const fetchBotName = async () => {
        setBotNameFetchBusy(true)
        setBotNameNote(null)
        try {
          const response = await fetch(BOT_NAME_PATH, { credentials: 'same-origin', cache: 'no-store' })
          const data = await response.json().catch(() => null)
          if (data?.ok === true && typeof data?.name === 'string' && data.name.trim() !== '') {
            const fetched = data.name.trim().slice(0, 64)
            setBotName(fetched)
            setBotNameNote({ kind: 'ok', text: `已获取「${fetched}」并填入，点下方「保存设置」后生效。` })
          } else {
            setBotNameNote({
              kind: 'error',
              text: data?.error?.message ?? `获取失败：HTTP ${response.status}`,
            })
          }
        } catch (error) {
          setBotNameNote({
            kind: 'error',
            text: `获取失败：${error instanceof Error ? error.message : String(error)}`,
          })
        } finally {
          setBotNameFetchBusy(false)
        }
      }

      // 群健康刷新：读各群 bot_state / info，只读、不改任何东西。
      // 节流在服务端（一分钟一次），这里只负责把 429 的原因说清楚。
      const refreshHealth = async () => {
        setHealthBusy(true)
        setHealthNote(null)
        try {
          const response = await fetch(HEALTH_PATH, { credentials: 'same-origin', cache: 'no-store' })
          const data = await response.json().catch(() => null)
          if (data?.health !== undefined && data.health !== null) setHealth(data.health)
          if (response.ok && data?.ok === true) {
            setHealthNote({ kind: 'ok', text: '已刷新' })
          } else if (response.status === 429) {
            const secs = Math.max(1, Math.ceil((data?.retryAfterMs ?? 60000) / 1000))
            setHealthNote({
              kind: 'warn',
              text: `${data?.error?.message ?? '刷新太快'}（${secs} 秒后可以再刷）`,
            })
          } else {
            setHealthNote({ kind: 'error', text: data?.error?.message ?? `刷新失败（HTTP ${response.status}）` })
          }
        } catch (error) {
          setHealthNote({ kind: 'error', text: `刷新失败：${error instanceof Error ? error.message : String(error)}` })
        } finally {
          setHealthBusy(false)
        }
      }

      // 「最近的主动发言」手动刷新：重拉 state 但**只替换冷场那一列**。
      // 故意不走 applyState——那会把没保存的表单改动全部冲掉（打开页面查一次、
      // 之后手动刷新，是这条列表的既定节奏，不加自动轮询）。
      const refreshIdle = async () => {
        setIdleRefreshBusy(true)
        try {
          const response = await fetch(STATE_PATH, { credentials: 'same-origin', cache: 'no-store' })
          const data = await response.json().catch(() => null)
          if (data?.ok === true && Array.isArray(data.state?.idleRecent)) {
            const next = data.state.idleRecent
            setState((prev) => (prev === null ? prev : { ...prev, idleRecent: next }))
          }
        } catch {
          // 刷新失败保持原样：辅助信息，不值得为它弹错
        } finally {
          setIdleRefreshBusy(false)
        }
      }

      // 判断模型的下拉候选：直接读 Harness 已配置的 provider/model。
      // 读不到（账号没登录、适配器不提供目录、超时）就让页面退回手动填写，
      // 不阻塞设置页其余部分——列表为空时照样能保存手填的值。
      react.useEffect(() => {
        let alive = true
        fetch(MODELS_PATH, { credentials: 'same-origin', cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((data) => {
            if (!alive) return
            const list = Array.isArray(data?.models) ? data.models : []
            setCatalog(list.filter((item) => typeof item?.value === 'string' && item.value !== ''))
            setCatalogError(
              typeof data?.error === 'string' && data.error !== ''
                ? data.error
                : Array.isArray(data?.failures) && data.failures.length > 0
                  ? data.failures.map((item) => `${item.provider}: ${item.message}`).join('；')
                  : ''
            )
          })
          .catch((error) => {
            if (!alive) return
            setCatalog([])
            setCatalogError(error instanceof Error ? error.message : String(error))
          })
          .finally(() => {
            if (alive) setCatalogLoading(false)
          })
        return () => { alive = false }
      }, [])

      // 输入框留空或填了非数字时退回 15 秒，不要悄悄变成下限 3 秒
      const watchMs = () => {
        const seconds = Number(watchSeconds)
        return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 15000
      }

      // 输入框留空时退回默认 100；下限是 1（没有「0 = 不限」这种写法）。
      const maxFilesValue = () => {
        const text = String(maxFiles).trim()
        if (text === '') return 100
        const number = Number(text)
        return Number.isFinite(number) ? number : 100
      }

      // 留空时退回默认值：窗口清空一下就变成 0（= 关掉注入）太容易误伤
      const numberOf = (value, fallback) => {
        const text = String(value).trim()
        if (text === '') return fallback
        const number = Number(text)
        return Number.isFinite(number) ? number : fallback
      }

      // 判断模型：目录里有就用下拉，否则退回手填。
      // 保存值不在目录里（模型下线、目录读不到）时也走手填，别让下拉悄悄显示成第一项。
      const catalogValues = catalog.map((item) => item.value)
      // 保存着一个目录里没有的模型（写错、模型下线）：不拦着保存，但要说一句——
      // 判断调用会 NO_ADAPTER，表现是「群里怎么都不回」。
      const modelUnlisted = !catalogLoading
        && catalog.length > 0
        && modelPick !== ''
        && modelPick !== MODEL_MANUAL
        && !catalogValues.includes(modelPick)
      const showManual = !catalogLoading && (
        catalog.length === 0
        || modelPick === MODEL_MANUAL
        || modelUnlisted
      )
      // 存进配置的那串 `provider/model`；空串 = 跟随默认模型。
      const modelRef = () => {
        if (modelPick === MODEL_MANUAL) return modelText.trim()
        if (modelPick === '') return catalog.length === 0 ? modelText.trim() : ''
        return modelPick
      }

      // 数值字段的合法区间，覆盖设置页上的每个数字输入框（浏览器 bundle 引不到
      // config.js 的 LIMITS，只能在前端留一份）。保存前先查一遍：越界就停下并提示，
      // 不发请求，也不让后端静默钳制。
      // 注意不是「和 LIMITS 一一对应」：LIMITS 里还有 `semanticMaxChars` 这种没有输入框、
      // 只能手改 settings.json / 调 API 的字段，它们由后端 findOutOfRange 兜住
      // （见 config.js: NUMERIC_FIELDS）。
      // 每项最后那个值是「这个输入框在哪个页签」：保存条是吸底的，可以在别的页签点保存，
      // 报错时必须先切回它所在的页签，否则用户只看到一句找不到地方的提示。
      // 页签名跟 TABS 的 value 一一对应（rhythm / contents / semantic / runtime），
      // 改动 TABS 或搬动任何一个字段时，这里必须一起改。
      const firstOutOfRange = () => {
        const fields = [
          ['qs-recall-gap', '分批间隔（分钟）', recallGap, 1, 60, 'contents'],
          ['qs-recall-max', '单轮最多给几张', recallMax, 1, 20, 'contents'],
          ['qs-merge-ms', '合并窗口', mergeMs, 200, 600000, 'rhythm'],
          ['qs-max-history', '参考最近消息条数', maxHistory, 0, 30, 'semantic'],
          ['qs-stale-minutes', '新话题间隔（分钟）', staleMinutes, 1, 1440, 'semantic'],
          ['qs-timeout', '单次判断超时', timeoutMs, 1000, 1800000, 'semantic'],
          ['qs-max-tokens', '单次输出上限', maxTokens, 16, 8192, 'semantic'],
          ['qs-media-max', '最多保留文件数', maxFiles, 1, 5000, 'contents'],
          ['qs-hist-window', '最多带多少条', histWindow, 0, 50, 'contents'],
          ['qs-hist-chars', '最多带多少字', histChars, 200, 8000, 'contents'],
          ['qs-watch-seconds', '超时阈值', watchSeconds, 3, 120, 'rhythm'],
          ['qs-idle-minutes', '冷场间隔（分钟）', idleMinutes, 1, 30, 'rhythm'],
          ['qs-idle-cooldown', '两次发言最小间隔（分钟）', idleCooldown, 1, 240, 'rhythm'],
          ['qs-idle-daily', '每天最多主动说几次', idleDaily, 1, 20, 'rhythm'],
          ['qs-idle-from', '活跃时段起始（点）', idleHourStart, 0, 23, 'rhythm'],
          ['qs-idle-to', '活跃时段结束（点）', idleHourEnd, 0, 24, 'rhythm'],
        ]
        for (const [id, label, value, min, max, pane] of fields) {
          const text = String(value ?? '').trim()
          if (text === '') continue
          const number = Number(text)
          if (!Number.isFinite(number)) continue
          if (number < min || number > max) return { id, label, min, max, pane }
        }
        return null
      }

      const save = async () => {
        const bad = firstOutOfRange()
        if (bad !== null) {
          setNeedNew(false)
          setFailed(true)
          setMessage(`「${bad.label}」超出范围 ${bad.min}–${bad.max}，请重新输入。`)
          // 那个输入框可能在另一个页签里：先切过去，等这一帧渲染出来再滚+聚焦。
          if (bad.pane !== view) setViewRaw(bad.pane)
          const reveal = () => {
            if (typeof document === 'undefined') return
            const field = document.getElementById(bad.id)
            if (field === null || field === undefined) return
            field.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
            field.focus?.()
          }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal)
          else reveal()
          return
        }
        setBusy(true)
        setMessage('')
        setFailed(false)
        setNeedNew(false)
        try {
          const response = await fetch(CONFIG_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode,
              botName: botName.trim(),
              wakeWords: toList(wakeWords),
              slash: {
                allowIds: toList(slashIds),
              },
              image: {
                mode: imageMode,
                recall: {
                  gapMinutes: numberOf(recallGap, 1),
                  maxImages: numberOf(recallMax, 4),
                },
              },
              reply: {
                format: replyFormat,
              },
              debug,
              semantic: {
                model: modelRef(),
                maxHistory: Number(maxHistory),
                staleMinutes: numberOf(staleMinutes, 30),
                timeoutMs: Number(timeoutMs),
                reasoningEffort: effort,
                maxTokens: Number(maxTokens),
                discardThinking,
              },
              timeout: {
                enabled: watchEnabled,
                ms: watchMs(),
                message: watchMessage.trim(),
              },
              merge: {
                enabled: mergeOn,
                // 留空退回 800：窗口清空就变成 0 会让消息永远不出队。
                windowMs: numberOf(mergeMs, 800),
              },
              idle: {
                enabled: idleOn,
                // 留空按默认值算；越界在 firstOutOfRange 就拦下了，这里只做兜底。
                minutes: numberOf(idleMinutes, 10),
                cooldownMinutes: numberOf(idleCooldown, 60),
                dailyLimit: numberOf(idleDaily, 3),
                hoursStart: numberOf(idleHourStart, 9),
                hoursEnd: numberOf(idleHourEnd, 24),
                recallMissed: idleMissed,
                catchUpOnStart: idleCatchUp,
              },
              guard: {
                extras: toList(extras),
                deny: toList(deny),
                allow: toList(allow),
              },
              promptOverrides,
              media: {
                maxFiles: maxFilesValue(),
              },
              history: {
                window: numberOf(histWindow, 20),
                maxChars: numberOf(histChars, 2000),
                persist: histPersist,
                markAnswered: histMark,
              },
              workspace: workspace.trim(),
            }),
          })
          const data = await response.json().catch(() => null)
          if (response.ok && data?.ok === true) {
            applyState(data.state)
            setPendingMode('')
            setFailed(false)
            setNeedNew(Array.isArray(data.needsNewSession) && data.needsNewSession.length > 0)
            setMessage(data.note ?? '已保存')
          } else {
            setFailed(true)
            setMessage(data?.error?.message ?? `保存失败（HTTP ${response.status}）`)
          }
        } catch (error) {
          setFailed(true)
          setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      // 语义调试：把一条真实判断原样重发，保留 thinking。
      // `id` 为空 = 最近一次判断；带 id = 聊天记录列表里点的那一行。
      // 不保存配置，所以不需要先点「保存」；也不写日志、不影响真实判定。
      const replay = async (id) => {
        const rowId = typeof id === 'string' ? id : ''
        setReplayBusy(true)
        setReplayRow(rowId)
        setReplayError('')
        try {
          const response = await fetch(REPLAY_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(rowId === ''
              ? { index: 0, effort: replayEffort }
              : { id: rowId, effort: replayEffort }),
          })
          const data = await response.json().catch(() => null)
          if (response.ok && data?.ok === true) {
            const out = data.replay ?? null
            setReplayResult(out)
            // 后端要是旧版本，会忽略 id、去重放「最近一次」——结果里的 requested.id 就对不上。
            // 不静默：否则人会以为自己在看这一条的思考。
            setReplayError(
              rowId !== '' && out?.requested?.id !== rowId
                ? '注意：后端还是旧版本，这次重放的是「最近一次判断」而不是你点的那条。重载插件后再试。'
                : ''
            )
          } else {
            setReplayResult(null)
            const reason = data?.error?.message ?? `重放失败（HTTP ${response.status}）`
            setReplayError(
              rowId !== '' && /还没有可重放/.test(reason)
                ? '后端还是旧版本（不认「重放这一条」）：先重载插件，再回来点一次。'
                : reason
            )
          }
        } catch (error) {
          setReplayResult(null)
          setReplayError(`重放失败：${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setReplayBusy(false)
          setReplayRow('')
        }
      }

      // 标注一条：`label` = should-reply（该回）或 should-not-reply（不回），都是同一份样本库。
      // `marked: false` 取消标注；同一条换标签是「改标」，后端会就地替换。
      const markMiss = async (id, marked, label) => {
        setMarkBusy(id)
        setMarkError('')
        try {
          const response = await fetch(MARK_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, marked, label }),
          })
          const data = await response.json().catch(() => null)
          if (response.ok && data?.ok === true) {
            setState((prev) => {
              if (prev === null) return prev
              const on = data.marked === true
              const nextLabel = on ? (data.markedLabel ?? label ?? '') : ''
              const patch = (item) => (item.id === id ? { ...item, marked: on, markedLabel: nextLabel } : item)
              return {
                ...prev,
                semanticRecent: (prev.semanticRecent ?? []).map(patch),
                semanticMisses: {
                  ...(prev.semanticMisses ?? {}),
                  count: data.count,
                  total: data.total,
                  shouldReply: data.shouldReply,
                  shouldNotReply: data.shouldNotReply,
                  rows: (prev.semanticMisses?.rows ?? []).map(patch),
                },
              }
            })
          } else {
            setMarkError(data?.error?.message ?? `标记失败（HTTP ${response.status}）`)
          }
        } catch (error) {
          setMarkError(`标记失败：${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setMarkBusy('')
        }
      }

      if (state === null) {
        return h('div', { className: 'qs-root' },
          h('style', null, CSS),
          h('div', { className: 'qs-empty' }, '正在读取 QQ 机器人套件设置…')
        )
      }

      const semanticSelected = mode === 'semantic'
      // 页签固定四个，但仍然要兜一层：viewRaw 可能是旧版本存下的值（rules / 已删掉的
      // 页签名），直接交给 SegmentedTabs 会算不出下标（findIndex 返回 -1），
      // 滑块滑出轨道、所有页签都变成未选中。认不出来的就落回第一页。
      const view = TABS.some((item) => item.value === viewRaw) ? viewRaw : TABS[0].value
      const ready = state.semanticReady === true
      // 后端是不是「认 id、能重放某一行的那版」；不是就禁用按钮，别让人点了白等一次模型调用。
      const replayById = state.replayById === true
      const guard = state.guard ?? {}
      // deny 的「到底挂上了没有」：guard.js 在建会话时回写，名字写错只有这里看得见。
      const denyResult = guard.denyResult ?? null
      const denyApplied = Array.isArray(denyResult?.applied) ? denyResult.applied : []
      const denyFailed = Array.isArray(denyResult?.failed) ? denyResult.failed : []
      // 群健康：后端缓存 + 官方字段的中文说法。
      const healthGroups = Array.isArray(health?.groups) ? health.groups : []
      const recvLabel = (value) => (value === 'all'
        ? '全部消息'
        : value === 'only_mention'
          ? '仅 @'
          : value === 'mention_and_context'
            ? '@ 及上下文'
            : (value === '' ? '未知' : value))
      const healthWarn = (code) => (code === 'recv_not_all'
        ? '平台只推 @ 相关消息：语义模式在这个群对非 @ 消息不生效'
        : code === 'proactive_off'
          ? '平台未允许主动消息：冷场 / 补回发不出去'
          : code)
      const recentJudges = Array.isArray(state.semanticRecent) ? state.semanticRecent : []
      // 冷场触发单独一列：它不经过语义判定，不能和上面那份 YES/NO 列表混在一起。
      const idleRecent = Array.isArray(state.idleRecent) ? state.idleRecent : []
      const lastJudge = recentJudges[0]
      // 只有「没放行」的判断才可能是漏判：yes 的那次已经回复过了。
      // 列表来自聊天记录文件（不是内存），重启、翻得更早都还在。
      const missRows = Array.isArray(state.semanticMisses?.rows) ? state.semanticMisses.rows : []
      const missPersist = state.semanticMisses?.persist !== false
      const missRowCount = state.semanticMisses?.count ?? 0
      // 正负样本分开数：只看总数看不出「两类都攒到没有」。
      const missReplyCount = state.semanticMisses?.shouldReply ?? missRowCount
      const missSilentCount = state.semanticMisses?.shouldNotReply ?? 0
      const missPath = state.semanticMisses?.path ?? ''
      const missHistoryPath = state.semanticMisses?.historyPath ?? ''
      const missLogPath = state.semanticMisses?.logPath ?? ''
      const missFromLog = missRows.some((item) => item.source === 'log')
      const modeDesc = MODES.find((item) => item.value === mode)?.desc ?? ''

      const messageClass = message === ''
        ? 'qs-msg'
        : `qs-msg ${failed ? 'qs-msg-error' : needNew ? 'qs-msg-warn' : 'qs-msg-ok'}`

      const savebar = h('div', { className: 'qs-foot' },
        h('div', { className: 'qs-row', style: { borderBottom: 'none', paddingBottom: 0 } },
          h('div', { className: 'qs-rowtext' },
            h('span', { className: messageClass }, message !== ''
              ? message
              : '保存后立即生效；带 * 的项要发 /new 重开会话才生效。')
          ),
          h('div', { className: 'qs-ctrl' },
            h(ActionButton, { variant: 'primary', disabled: busy, onClick: save },
              busy ? '保存中…' : '保存设置')
          )
        )
      )

      /**
       * Prompt 设置：原生 details 默认折叠，收起时只占一行，设置页不会被拉长。
       * 展开后默认也只有一个下拉 + 一个输入框；已经覆盖的句子才逐条列出。
       */
      const covered = promptCatalog.filter((item) =>
        typeof promptOverrides[item.id] === 'string' && promptOverrides[item.id] !== '')
      const catalogById = (id) => promptCatalog.find((item) => item.id === id)
      /** 当前真正生效的文案：有覆盖用覆盖值，没有就用内置原文。 */
      const promptCurrentOf = (id) => {
        const item = catalogById(id)
        if (!item) return ''
        const override = promptOverrides[id]
        return typeof override === 'string' && override !== '' ? override : item.source
      }
      /** 恢复默认：去掉覆盖，并把输入框还原成内置原文。 */
      const promptResetOne = (id) => {
        const next = { ...promptOverrides }
        delete next[id]
        setPromptOverrides(next)
        if (promptPick === id) setPromptDraft(catalogById(id)?.source ?? '')
      }
      const promptPicked = catalogById(promptPick)
      /**
       * 下拉按分组渲染（语义判断 / 冷场与补回 / 记录与图片 / 工具权限）。
       * 条目已经有 20 多条，平铺一列很难找；服务端没下发分组时退回平铺。
       */
      const promptOptions = () => {
        if (promptGroups.length === 0) {
          return promptCatalog.map((item) => h('option', { key: item.id, value: item.id }, item.label))
        }
        const nodes = []
        for (const group of promptGroups) {
          const items = promptCatalog.filter((item) => item.group === group.id)
          if (items.length === 0) continue
          nodes.push(h('optgroup', { key: group.id, label: group.label },
            ...items.map((item) => h('option', { key: item.id, value: item.id }, item.label))
          ))
        }
        return nodes
      }
      const promptSection = h(Collapse, {
        title: '提示词改写',
        note: `已覆盖 ${covered.length} 项 · 点开配置`,
      },
        h('div', { className: 'qs-prompt-body' },
          h('p', { className: 'qs-desc', style: { display: 'block', margin: '12px 0' } },
            '选中一条后显示的是它**当前生效**的原文——设置页读的就是运行时真正发出去的那句，不是另存的一份副本。可直接改写；「恢复默认」回到内置原文。改完记得点底部「保存设置」。',
            '这里只收整句文案；协议标记（YES/NO 输出、思考语言硬要求、图片占位符 `[图片×N]`）不在其中。',
            '标了「谨慎」的句子在挡具体事故（防注入、占位符发进群、图片判定的档位），改之前先看清它原本在挡什么。'),
          h('div', { className: 'qs-guide' },
            h('div', { className: 'qs-guide-row' },
              h('span', { className: 'qs-guide-key' }, '群聊 / 私聊提示词'),
              h('span', { className: 'qs-guide-val' },
                '去官方插件设置：设置 → QQ 机器人绑定 → 个性化提示词，改「群聊额外 system prompt」和「私聊额外 system prompt」。下面这些条目管的是套件自己的判断与上下文，管不到那两栏。')),
            h('div', { className: 'qs-guide-row' },
              h('span', { className: 'qs-guide-key' }, '助手性格（人设）'),
              h('span', { className: 'qs-guide-val' },
                '用 dsh 自带的「创造模式」创建 Agent 预设来写，这里改不了它说话的样子。'))),
          ...covered.map((item) => h('div', { className: 'qs-prompt-item', key: item.id },
            h('span', { className: 'qs-prompt-label' }, item.label),
            h('span', { className: 'qs-prompt-text' }, promptOverrides[item.id]),
            h(ActionButton, {
              variant: 'outline', size: 'sm',
              onClick: () => promptResetOne(item.id),
            }, '恢复默认')
          )),
          h('div', { className: 'qs-prompt-editor' },
            h('select', {
              className: 'qs-input',
              value: promptPick,
              'aria-label': '选择要改写的提示词',
              onChange: (event) => {
                const id = event.target.value
                setPromptPick(id)
                setPromptDraft(id === '' ? '' : promptCurrentOf(id))
              },
            },
              h('option', { value: '' }, '选择要改写的提示词…'),
              ...promptOptions()
            ),
            h('textarea', {
              className: 'qs-textarea',
              value: promptDraft,
              spellCheck: false,
              placeholder: '选中上面的提示词后，这里会显示当前生效的文案',
              onChange: (event) => setPromptDraft(event.target.value),
            }),
            ...(promptPicked?.caution === true
              ? [h('p', { className: 'qs-desc qs-caution', style: { display: 'block', margin: '8px 0 0' } },
                '谨慎改：这句在挡具体事故（防注入、占位符发进群、图片判定的档位），改错会直接表现为「该拦的没拦」。')]
              : []),
            h('div', { className: 'qs-prompt-actions' },
              h(ActionButton, {
                variant: 'primary', size: 'sm', disabled: promptPick === '',
                onClick: () => {
                  const item = catalogById(promptPick)
                  if (!item) return
                  const text = promptDraft.trim()
                  const next = { ...promptOverrides }
                  // 空串或跟内置原文相同都不写覆盖，配置里不留冗余项。
                  if (text === '' || text === item.source.trim()) delete next[promptPick]
                  else next[promptPick] = text
                  setPromptOverrides(next)
                  setPromptDraft(typeof next[promptPick] === 'string' ? next[promptPick] : item.source)
                },
              }, '暂存这一条'),
              h(ActionButton, {
                variant: 'outline', size: 'sm', disabled: promptPick === '',
                onClick: () => promptResetOne(promptPick),
              }, '恢复默认'),
              ...(covered.length > 0
                ? [h(ActionButton, {
                  variant: 'outline', size: 'sm',
                  onClick: () => {
                    setPromptOverrides({})
                    setPromptPick('')
                    setPromptDraft('')
                  },
                }, '全部恢复默认')]
                : []),
              h('span', { className: 'qs-desc' }, '暂存后别忘了点底部「保存设置」')
            )
          )
        )
      )

      return h('div', { className: 'qs-root' },
        h('style', null, CSS),
        h('header', { className: 'qs-head' },
          h('h2', null, 'QQ 机器人套件'),
          h('p', null, '一个页面管：它什么时候说话、看到什么、怎么判断、能在哪跑。')
        ),

        // 大区切换：固定四格，不再随回复模式增减（语义参数常驻，切模式只是不生效）。
        h(Tabs, {
          items: TABS,
          value: view,
          onChange: changeView,
          label: '设置分区',
        }),

        // 四个页签的内容都挂在这个 tabpanel 里：SegmentedTabs 会带 aria-controls，
        // 得有个对应的可读区域，否则无障碍引用是悬空的。
        h('div', {
          className: 'qs-panel',
          role: 'tabpanel',
          'aria-label': TABS.find((item) => item.value === view)?.label ?? '',
        },

        // ══════════════════════════════════════════════════════════════
        // 页签 1 · 回复与节奏：它什么时候说话
        // ══════════════════════════════════════════════════════════════
        view === 'rhythm' ? h(react.Fragment, null,

        // ── 怎么叫它：名字和唤醒词是同一件事，别被模式卡隔开 ──
        h(GroupTitle, { title: '怎么叫它' }),
        // qqbot_bot_profile 的启停在「插件」页面控制（qqbot-suite-self 子插件，
        // 默认停用），设置页不放开关、也不显示状态：插件启用时下面这行
        // 自然多出「自动获取」按钮，停用时只有输入框。
        h(Row, {
          stacked: true,
          title: '机器人名字',
          desc: '群聊里有人按名字叫它（含去掉 Bot/机器人/助手 后缀的短称）、语义判断提示词、'
            + '群聊历史里它自己发言的标记，都用这个名字。留空 = 只靠 @、引用和下面的唤醒词。',
          children: h('span', { style: { display: 'block' } },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h('input', {
                id: 'qs-bot-name',
                className: 'qs-input',
                type: 'text',
                value: botName,
                placeholder: '例如：小助手',
                maxLength: 64,
                style: { width: 'auto', flexGrow: 1, minWidth: 0 },
                onChange: (event) => setBotName(event.target.value),
              }),
              selfActive ? h('button', {
                type: 'button',
                className: 'qs-mini',
                disabled: botNameFetchBusy,
                onClick: fetchBotName,
              }, botNameFetchBusy ? '获取中…' : '自动获取') : null,
            ),
            h('span', {
              className: 'qs-desc',
              style: { display: 'block', marginTop: '4px' },
            }, selfActive
              ? '点上面的「自动获取」可从 QQ 拉当前名字（不碰头像），拿到的名字不会自动保存。'
              : '想自动获取名字：到「插件」页面启用 qqbot-suite-self（qqbot_bot_profile 工具），回到这里就会出现「自动获取」按钮。'
            ),
            botNameNote === null ? null : h('span', {
              className: botNameNote.kind === 'error' ? 'qs-field-err' : 'qs-desc',
              style: { display: 'block', marginTop: '4px' },
            }, botNameNote.text),
          ),
        }),

        h(Row, {
          stacked: true,
          title: '自定义唤醒词',
          desc: '每行一个，适合只在人设里出现的其他称呼；机器人自己的名字填在上面，不用重复。',
          children: h('textarea', {
            id: 'qs-wake-words',
            className: 'qs-textarea',
            value: wakeWords,
            spellCheck: false,
            placeholder: '输入其他唤醒词，每行一个',
            onChange: (event) => setWakeWords(event.target.value),
          }),
        }),

        // ── 回复模式：三种触发策略，卡下面逐条说明，切换前就能横向比较 ──
        h(GroupTitle, { title: '回复模式' }),
        h('div', { className: 'qs-row qs-row-stack' },
          h('div', { className: 'qs-cubes', role: 'radiogroup', 'aria-label': '群聊回复模式' },
            ...MODES.map((item) => h(ModeCube, {
              key: item.value,
              value: item.value,
              name: item.short,
              label: item.name,
              desc: item.desc,
              icon: item.icon,
              current: mode,
              onSelect: requestMode,
            }))
          ),
          h('div', { className: 'qs-modes-desc' },
            ...MODES.map((item) => h('p', { className: 'qs-note', key: item.value },
              h('span', { className: 'qs-mode-name' }, item.name), '：', item.desc
            ))
          ),
          h('p', { className: 'qs-note' },
            '私聊永远回复；@、引用机器人和斜杠命令在三种模式下都放行。'
          )
        ),

        // ── 连发合并 ──
        h(GroupTitle, { title: '连发合并' }),
        h(Row, {
          title: '合并多条消息',
          hint: [
            '把同一个人在短时间内连着发的几句，合成一条再交给 agent，只判断、只回复一次。',
            '',
            '开启后：',
            '· 同一个人在一个窗口内接着发，会并进同一条；',
            '· 换人说话则排在后面等，聊天顺序不变；',
            '· @、唤醒词、引用、斜杠命令不等窗口——先把攒着的几句一起放出去，再立刻处理这条；',
            '· 同一个人最多合并 5 条，攒满就提前放行。',
            '',
            '代价：群里「没点名」的消息会多等一个窗口，首字慢一点。所以默认关闭。',
            '关掉后行为和以前完全一致，没有任何延迟。',
          ].join('\n'),
          desc: '同一个人连着打几句时，合成一条再交给 agent，避免一段话被回两次。默认关闭。',
          control: h(Toggle, {
            checked: mergeOn,
            onChange: setMergeOn,
            label: '合并多条消息',
            title: mergeOn ? '已开启' : '已关闭',
          }),
        }),

        mergeOn ? h(Row, {
          title: '合并窗口时间',
          hint: [
            '窗口时长：同一个人在这段时间内再发一条，就算同一段话，并进同一条。',
            '',
            '· 200–500 毫秒：几乎感觉不到延迟，但「想一下再补一句」可能合不上；',
            '· 800 毫秒（默认）：覆盖大多数「打完一句又补一句」的间隔；',
            '· 5–30 秒：边想边补、分几段发的都能合上；代价是每条没点名的消息都要等这么久；',
            '· 最长 600000 毫秒（10 分钟）：只适合「一句话拆成十条慢慢发」的场景，群里会长时间没反应。',
            '',
            '只对「没点名」的消息生效（@、引用、叫名字、斜杠命令照旧立刻处理）。',
            '排队时每批依次计时，最坏情况是等前面几批的窗口之和。',
          ].join('\n'),
          desc: '同一个人在这个间隔内再发一条，就并进同一条；换人说话则排队等。',
          control: h(NumberField, {
            id: 'qs-merge-ms',
            value: mergeMs,
            min: 200,
            max: 600000,
            step: 100,
            onChange: setMergeMs,
            unit: '毫秒',
          }),
        }) : null,

        // ── 处理超时自动中断 ──
        h(GroupTitle, { title: '超时中断' }),
        h(Row, {
          title: '超时中断',
          desc: '只对群聊生效。中断会连同这个群里排队等着的消息一起取消，会话历史保留。',
          control: h(Toggle, { checked: watchEnabled, onChange: setWatchEnabled, label: '超时中断' }),
        }),
        h(Row, {
          title: '超时阈值',
          desc: '保存后对新的群消息生效；正在跑的那轮不受影响。',
          control: h(NumberField, {
            id: 'qs-watch-seconds',
            value: watchSeconds,
            min: 3,
            max: 120,
            step: 1,
            onChange: setWatchSeconds,
            unit: '秒',
          }),
        }),
        h(Row, {
          stacked: true,
          title: '超时提示文案',
          desc: '可以用 {seconds} 占位，会换成实际阈值；留空就用默认文案。',
          children: h('input', {
            id: 'qs-watch-message',
            className: 'qs-input',
            type: 'text',
            value: watchMessage,
            spellCheck: false,
            placeholder: '⏱ 这条想太久了（超过 {seconds} 秒），先中断。拆小一点再问我一次？',
            onChange: (event) => setWatchMessage(event.target.value),
          }),
        }),

        // ── 冷场主动发言：默认关，整组收进折叠块，收起来只占一行 ──
        // 顺序：开关 → 触发（间隔）→ 频率（最小间隔 / 每天上限 / 活跃时段）→ 行为（补回）→ 记录。
        h(Collapse, {
          title: '冷场主动发言',
          badge: idleOn ? '已开启' : '已关闭',
        },
          h(Row, {
            title: '冷场主动发言',
            hint: [
              '触发条件只有一个：群里最后一条不是它自己说的，而且已经安静超过下面的分钟数。',
              '它刚说完话的时候不算冷场——那正是等别人接的时候。',
              '',
              '命中之后分两种：',
              '· 最后那条正好是被语义判成「不回」的 → 按原样补回，相当于「当时没回，过一会儿补上」；',
              '· 否则 → 告诉它群里安静了多久，说什么、说不说都让它自己决定。',
              '',
              '它可以选择什么都不说（空的输出不会被发出去），所以这个功能不会硬凑话。',
              '开关默认关闭；开着也只在活跃时段、当天次数没超时才动作。',
            ].join('\n'),
            desc: '群聊安静一段时间、最后一句不是它说的，就让 agent 自己决定要不要接一句。默认关闭。',
            control: h(Toggle, { checked: idleOn, onChange: setIdleOn, label: '冷场主动发言' }),
          }),

          idleOn ? h(Row, {
            title: '冷场间隔',
            hint: [
              '群里安静多久之后可以主动开口。上限锁在 30 分钟：',
              '官方 dsh-qqbot 的会话闲置 30 分钟就会回收，超过这个点再说话要先把会话 resume 回来——',
              '能做，但不值得为「冷场」付这个代价。',
              '',
              '量级参考（按群里的实际消息密度）：10 分钟大约每天 3–5 次，30 分钟大约 1–2 次。',
              '觉得吵就调大间隔，或者把「每天最多」调小。',
            ].join('\n'),
            desc: '安静超过这个分钟数就算冷场。1–30 分钟，上限锁死。',
            control: h(NumberField, {
              id: 'qs-idle-minutes',
              value: idleMinutes,
              min: 1,
              max: 30,
              step: 1,
              onChange: setIdleMinutes,
              unit: '分钟',
            }),
          }) : null,

          idleOn ? h(Row, {
            title: '两次发言最小间隔',
            hint: [
              '它主动说完一次之后，这么久之内不会再说第二次——哪怕群里又冷场了。',
              '这条挡的是「说一句→没人接→马上再说」的连环，和上面的冷场间隔是两回事：',
              '冷场间隔决定「安静多久算冷场」，这条决定「说完之后闭嘴多久」。',
              '',
              '默认 60 分钟。调小 = 更活跃，调大到 240 = 一天最多几次。',
              '注意它和「每天最多」是叠着生效的：真正频率取两者里更严的那个。',
            ].join('\n'),
            desc: '主动说完一次后至少隔多久才允许下一次。1–240 分钟，默认 60。',
            control: h(NumberField, {
              id: 'qs-idle-cooldown',
              value: idleCooldown,
              min: 1,
              max: 240,
              step: 1,
              onChange: setIdleCooldown,
              unit: '分钟',
            }),
          }) : null,

          idleOn ? h(Row, {
            title: '每天最多主动说几次',
            desc: '每群单独算。到点当天不再开口。另外主动说过之后如果半小时没人接，也当天收手——'
              + '没人理还继续说，那就成自言自语了。',
            control: h(NumberField, {
              id: 'qs-idle-daily',
              value: idleDaily,
              min: 1,
              max: 20,
              step: 1,
              onChange: setIdleDaily,
              unit: '次',
            }),
          }) : null,

          // 起止时间合成一行：本来就是同一个区间，拆两行只是把「跨夜 / 全天」的规则讲了两遍。
          idleOn ? h(Row, {
            title: '活跃时段',
            desc: '左闭右开，填小时；起点大于终点表示跨夜（例如 22 到 6）。结束填 24 表示到当天结束，'
              + '起止填一样 = 全天不限。',
            control: h('span', { className: 'qs-hours' },
              h(NumberField, {
                id: 'qs-idle-from',
                value: idleHourStart,
                min: 0,
                max: 23,
                step: 1,
                onChange: setIdleHourStart,
              }),
              h('span', { className: 'qs-unit' }, '—'),
              h(NumberField, {
                id: 'qs-idle-to',
                value: idleHourEnd,
                min: 0,
                max: 24,
                step: 1,
                onChange: setIdleHourEnd,
              }),
              h('span', { className: 'qs-unit' }, '点')
            ),
          }) : null,

          idleOn ? h(Row, {
            title: '补回被拦下的那条',
            desc: idleMissed
              ? '最后一条是被语义判定「不用回」的话时，安静够久就按原样补回去让它看一眼。'
              : '只让它自己找话；被语义判成「不回」的那条不再补回。',
            control: h(Toggle, { checked: idleMissed, onChange: setIdleMissed, label: '补回被拦下的那条' }),
          }) : null,

          idleOn ? h(Row, {
            title: '重启后补回之前的消息',
            hint: [
              '群聊历史是落盘的，重启会回填。开着的情况下，重启前最后那条「有人说话、但没回」的消息',
              '只要还没超过活跃时段和「3 小时内」的限度，就会被当成冷场补一次。',
              '',
              '关掉的话，只有本次启动之后收到的消息才会触发——重启期间的空档直接作废。',
              '平台不保留离线消息，所以无论开关如何，机器人在线时没收到的东西都补不回来。',
            ].join('\n'),
            desc: idleCatchUp
              ? '重启后也处理启动前收到、当时没回的消息。'
              : '只处理本次启动之后收到的消息，重启前的记录不再补。',
            control: h(Toggle, { checked: idleCatchUp, onChange: setIdleCatchUp, label: '重启后补回之前的消息' }),
          }) : null,

          // 冷场是独立触发源，不经过语义判定（否则「补回被拦下的那条」会自己把自己否掉）。
          // 所以它的记录单独一列：混进「该不该回」的统计会污染漏判样本。
          idleOn ? h(Row, {
            stacked: true,
            title: '最近的主动发言',
            hint: [
              '这里只记「防冷场」触发的动作，不含普通回复。',
              '它不经过语义判定——要补回的那条本来就是语义判成「不用回」的，再过一遍永远是否决。',
              '',
              '「没发出去」一般是这几种：agent 觉得不用说话（空输出）、模型输出了「（沉默）」这类占位符被拦下、',
              '或者这一轮 agent 忙不过来。只保留最近 20 条；记录落盘在 logs/ 下，重启 / 重载都在。',
            ].join('\n'),
            desc: '冷场触发不经过语义判断，所以单独记在这里，不计入「该不该回」的统计。',
            children: [
              h('div', {
                key: 'bar',
                style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' },
              },
                h('button', {
                  type: 'button',
                  className: 'qs-mini',
                  disabled: idleRefreshBusy,
                  onClick: refreshIdle,
                }, idleRefreshBusy ? '刷新中…' : '刷新'),
              ),
              h('div', { className: 'qs-status', key: 'list' },
              ...(idleRecent.length === 0
                ? [h('span', { className: 'qs-status-val', key: 'none' }, '还没有主动说过话。')]
                : idleRecent.slice(0, 8).flatMap((item, index) => [
                  h('span', { className: 'qs-status-key', key: `k${index}` },
                    Number.isFinite(item?.at) ? new Date(item.at).toLocaleTimeString() : `#${index + 1}`
                  ),
                  h('span', { className: 'qs-status-val', key: `v${index}` }, idleRowLabel(item)),
                ]))
              ),
            ],
          }) : null,
        ),

        ) : null,

        // ══════════════════════════════════════════════════════════════
        // 页签 2 · 消息与上下文：它看到什么、发出去什么样
        // ══════════════════════════════════════════════════════════════
        view === 'contents' ? h(react.Fragment, null,

        // ── 群聊图片 ──
        h(GroupTitle, { title: '群聊图片' }),
        h(Row, {
          title: '群聊图片',
          desc: imageMode === 'ignore'
            ? '带图片的消息整条不收：agent 完全看不到图片，纯图消息也不回复；只有文字的消息照常处理。'
            : imageMode === 'placeholder'
              ? '摘掉图片，正文留 [图片×N（已过滤，看不到内容）] 占位符；agent 看不到图，但知道来过图。'
              : '插件不碰图片：官方链路照常下载，正文里带本地路径，agent 用 read_image 自己看。',
          control: h(Select, {
            id: 'qs-image-mode',
            value: imageMode,
            options: IMAGE_MODES,
            onChange: setImageMode,
            ariaLabel: '群聊图片',
          }),
        }),

        // 只在「交给 agent 自己读图」时有意义：另外两种模式图片根本不下载，没有路径可召回。
        imageMode === 'agent' ? h(Row, {
          title: '分批间隔',
          desc: '相邻两张图片的发送间隔超过这个值，就算两批。被拦下的图也照样记；之后有人让你看「刚才那张」，按批把路径补给你。',
          control: h(NumberField, {
            id: 'qs-recall-gap',
            value: recallGap,
            min: 1,
            max: 60,
            step: 1,
            onChange: setRecallGap,
            unit: '分钟',
          }),
        }) : null,
        imageMode === 'agent' ? h(Row, {
          title: '单轮最多给几张',
          desc: '一次最多把几张历史图片的路径交给 agent（从最新一批往前取）。给多了会诱导它每张都读一遍，白花 token。',
          control: h(NumberField, {
            id: 'qs-recall-max',
            value: recallMax,
            min: 1,
            max: 20,
            step: 1,
            onChange: setRecallMax,
            unit: '张',
          }),
        }) : null,

        // ── 媒体缓存（跟着图片走：文件留多久直接决定历史图片能召回几张） ──
        h(GroupTitle, { title: '媒体缓存' }),
        h(Row, {
          title: '最多保留文件数',
          hint: [
            '保存后立即清一次，之后每分钟检查。只删更旧的文件，刚下载 5 分钟内的不动，',
            '避免 agent 正在看图时被清掉。机器人自己的头像不计数也不删。',
            '',
            '这个数同时决定「历史图片最多能召回几张」——至少 1，没有「不限」。',
          ].join('\n'),
          desc: '按数量兜底：超过这个数就从更旧的开始删。',
          control: h(NumberField, {
            id: 'qs-media-max',
            value: maxFiles,
            min: 1,
            max: 5000,
            step: 10,
            onChange: setMaxFiles,
            unit: '个',
          }),
        }),
        h('div', { className: 'qs-row' },
          h('div', { className: 'qs-rowtext' },
            h('span', { className: 'qs-title' }, '当前缓存'),
            h('span', { className: 'qs-desc' },
              `${state.media?.files ?? 0} 个`
              + (typeof state.media?.bytes === 'number' && state.media.bytes > 0
                ? `，约 ${(state.media.bytes / 1024 / 1024).toFixed(1)} MB`
                : ''),
              ' · ',
              h('span', { className: 'qs-mono' }, state.media?.dir ?? '')
            )
          )
        ),

        // ── 群聊上下文 ──
        h(GroupTitle, {
          title: '群聊上下文',
          hint: '喂给 agent 的最近群消息。只影响它接话时看到什么，不影响语义判断用的记录。',
        }),
        h(Row, {
          title: '最多带多少条',
          desc: '0 = 不注入（回到官方行为）。',
          control: h(NumberField, {
            id: 'qs-hist-window',
            value: histWindow,
            min: 0,
            max: 50,
            step: 1,
            onChange: setHistWindow,
            unit: '条',
          }),
        }),
        h(Row, {
          title: '最多带多少字',
          desc: '超了从更旧的丢，越新越优先。',
          control: h(NumberField, {
            id: 'qs-hist-chars',
            value: histChars,
            min: 200,
            max: 8000,
            step: 100,
            onChange: setHistChars,
            unit: '字',
          }),
        }),
        h(Row, {
          title: '落盘保存',
          desc: '关掉的话，插件一重载、进程一重启，攒下的群消息就没了（内存里每群最多留 200 条）。',
          control: h(Toggle, { checked: histPersist, onChange: setHistPersist, label: '落盘保存' }),
        }),
        h(Row, {
          title: '标出已经回应过的',
          desc: '在记录块里给已经交给它的那几条打 ✓，省得它把旧话说第二遍。',
          control: h(Toggle, { checked: histMark, onChange: setHistMark, label: '标出已经回应过的' }),
        }),
        h('div', { className: 'qs-row' },
          h('div', { className: 'qs-rowtext' },
            h('span', { className: 'qs-title' }, '落盘文件'),
            h('span', { className: 'qs-desc qs-mono' }, state.historyLogPath ?? '')
          )
        ),

        // ── 回复消息类型（发出去长什么样，不是什么时候回） ──
        h(GroupTitle, { title: '回复消息类型' }),
        h(Row, {
          title: '回复消息类型',
          hint: [
            '决定回复用哪种 QQ 消息类型发。markdown 消息（msg_type=2）在旧版 PC QQ 上只显示',
            '「暂不支持该消息类型，请用手机QQ查看」，纯文本（msg_type=0）任何版本都能看。',
            '',
            '· 自动（默认）：只有代码块、表格、连续两条以上列表、标题、引用才发 markdown，',
            '  其余都是纯文本——判错方向的代价不对称，宁可少排版也别让消息直接看不见；',
            '· 一律纯文本：全部消息都不排版，旧客户端最稳；',
            '· 一律 markdown：官方原行为，排版最完整，旧客户端可能只看到一行提示。',
            '',
            '只影响正常回复。报错兜底（SDK 的 errorHandler）本来就是纯文本，不受这里影响。',
          ].join('\n'),
          desc: '自动档只在正文明确有结构时才发 markdown，避免旧客户端整条看不见。',
          control: h(Select, {
            id: 'qs-reply-format',
            value: replyFormat,
            options: REPLY_FORMAT_OPTIONS,
            onChange: setReplyFormat,
            ariaLabel: '回复消息类型',
          }),
        }),

        ) : null,

        // ══════════════════════════════════════════════════════════════
        // 页签 3 · 语义判断：它怎么判断（常驻，不再随模式消失）
        // ══════════════════════════════════════════════════════════════
        view === 'semantic' ? h(react.Fragment, null,

        // 常驻之后必须说清「现在生不生效」，否则改了半天不生效还以为是 bug。
        semanticSelected ? null : h('p', { className: 'qs-warn' },
          `当前回复模式是「${MODES.find((item) => item.value === mode)?.name ?? mode}」，`
          + '这一页的参数只在切到「语义判断」后生效；改完保存不会丢，切回来就继续用。'
        ),

        // 没有可用模型是「整页参数都白搭」的前提，放在最前面，而不是页尾。
        ready ? null : h('p', { className: 'qs-warn' },
          '语义模式需要一个可用的判断模型：先在「设置 → 模型」选一个默认模型，'
          + '或在下面「判断模型」里手动填写 provider/model。'
        ),

        // ── 判断模型 ──
        h(GroupTitle, { title: '判断模型' }),
        h(Row, {
          title: '判断模型',
          desc: ready
            ? (state.modelSource === 'custom'
                ? ['手动指定：', h('span', { className: 'qs-mono' }, state.model ?? ''),
                    state.defaultModel ? `（默认模型：${state.defaultModel}）` : '']
                : ['跟随默认模型：', h('span', { className: 'qs-mono' }, state.model ?? '')])
            : '当前没有可用的模型；语义判断会静默不回复。',
          control: catalog.length > 0
            ? h(Select, {
                id: 'qs-semantic-model',
                value: showManual ? MODEL_MANUAL : modelPick,
                options: [
                  { value: '', label: state.defaultModel ? `跟随默认模型（${state.defaultModel}）` : '跟随默认模型' },
                  ...catalog.map((item) => ({
                    value: item.value,
                    label: `${item.name} · ${item.providerName}`,
                  })),
                  { value: MODEL_MANUAL, label: '手动填写…' },
                ],
                onChange: (next) => {
                  if (next === MODEL_MANUAL) {
                    // 切到手填时把原值带过去：改一半、改一个字符比从空白重打省事。
                    if (modelText === '') setModelText(modelPick === MODEL_MANUAL ? '' : modelPick)
                    setModelPick(MODEL_MANUAL)
                    return
                  }
                  setModelPick(next)
                  setModelText(next)
                },
                ariaLabel: '判断模型',
              })
            : h(Tag, { tone: catalogLoading ? 'neutral' : 'warning' },
                catalogLoading ? '读取中…' : '手动填写'),
        }),
        showManual ? h(Row, {
          stacked: true,
          title: '模型标识',
          desc: [
            '按 provider/model 填写（例如 deepseek-account/deepseek-flash）；留空 = 跟随默认模型。',
            catalogError !== '' ? `读不到模型列表：${catalogError}` : '',
            modelUnlisted ? '这个模型不在当前可用的列表里，调用会失败（群里会静默不回复）；确认 provider 和模型 id 没写错。' : '',
          ],
          children: h('input', {
            id: 'qs-semantic-model-ref',
            className: 'qs-input',
            value: modelText,
            spellCheck: false,
            placeholder: 'deepseek-account/deepseek-flash',
            onChange: (event) => setModelText(event.target.value),
          }),
        }) : null,

        // ── 判断预算：思考档位 / 输出上限 / 超时是一族，连续排 ──
        h(GroupTitle, { title: '判断预算' }),
        h(Row, {
          title: '思考程度',
          desc: effort === 'off'
            ? '模型强制思考（GLM-5.3、MiniMax M2.x 等）时会自动退回「跟随默认」，并抬高预算重试一次。'
            : '思考内容也算进 max-token；正文被截断会自动加长重试一次，日志里能看到实际档位。',
          control: h(Select, {
            id: 'qs-effort',
            value: effort,
            options: EFFORTS,
            onChange: setEffort,
            ariaLabel: '思考程度',
          }),
        }),
        h(Row, {
          title: '单次输出上限',
          desc: '这是「思考 + 正文」的总预算。',
          control: h(NumberField, {
            id: 'qs-max-tokens',
            value: maxTokens,
            min: 16,
            max: 8192,
            step: 16,
            onChange: setMaxTokens,
            unit: 'token',
          }),
        }),
        h(Row, {
          title: '单次判断超时',
          desc: '超时按「不是在叫它」处理，避免卡住群消息。毫秒，最少 1000，最多 1800000（30 分钟）。',
          control: h(NumberField, {
            id: 'qs-timeout',
            value: timeoutMs,
            min: 1000,
            max: 1800000,
            step: 500,
            onChange: setTimeoutMs,
            unit: 'ms',
          }),
        }),

        // ── 判断上下文 ──
        h(GroupTitle, {
          title: '判断上下文',
          hint: '只影响判断模型看到的记录，和「消息与上下文」里喂给 agent 的那份是两回事。',
        }),
        h(Row, {
          title: '参考最近消息条数',
          desc: '只影响语义判断时喂给模型的群聊历史。',
          control: h(NumberField, {
            id: 'qs-max-history',
            value: maxHistory,
            min: 0,
            max: 30,
            onChange: setMaxHistory,
            unit: '条',
          }),
        }),
        h(Row, {
          title: '新话题间隔',
          desc: '判定时聊天记录带发送时间：跟上一段间隔超过这个分钟数就算换了话题，'
            + '「紧跟着它说话的短反应算在叫它」那条规则不再生效，只有明确点名/回应才判「回」。',
          control: h(NumberField, {
            id: 'qs-stale-minutes',
            value: staleMinutes,
            min: 1,
            max: 1440,
            onChange: setStaleMinutes,
            unit: '分钟',
          }),
        }),

        // ── 语义诊断：调试用，收起只占一行 ──
        h(Collapse, {
          title: '语义诊断',
          note: '重放 / 标注 / 丢弃 thinking',
          badge: lastJudge ? verdictLabel(lastJudge.verdict) : '暂无记录',
        },
          h(Row, {
            title: '丢弃 thinking',
            desc: discardThinking
              ? '推理内容不写进语义日志、也不参与判断，只记长度。'
              : '推理内容最多 400 字写进语义日志，方便调提示词；判断仍然只看正文。',
            control: h(Toggle, {
              checked: discardThinking,
              onChange: setDiscardThinking,
              label: '丢弃 thinking',
              title: discardThinking ? '丢弃' : '写入日志',
            }),
          }),

          // ── 语义调试：重放某一次判断，保留 thinking ──
          h('div', { className: 'qs-block' },
            h('div', { className: 'qs-block-head' },
              h('div', { className: 'qs-rowtext' },
                h('span', { className: 'qs-title' }, '语义调试：重放判断'),
                h('span', { className: 'qs-desc' },
                  lastJudge
                    ? `最近一次：${new Date(lastJudge.at).toLocaleTimeString()} · ${lastJudge.sender ?? '某人'} · `
                      + `${lastJudge.text || '（空消息）'} → ${verdictLabel(lastJudge.verdict)} · ${lastJudge.ms ?? '?'}ms`
                    : '还没有判断记录。语义模式下，群里发一条不叫它的消息，被判断过一次之后就能重放。'
                )
              ),
              h('div', { className: 'qs-ctrl' },
                h(Segmented, {
                  id: 'qs-replay-effort',
                  value: replayEffort,
                  label: '重放时的思考档位',
                  onChange: setReplayEffort,
                  options: [
                    { value: 'off', label: '关闭' },
                    { value: 'low', label: '低' },
                    { value: 'high', label: '高' },
                    { value: 'max', label: '最高' },
                  ],
                }),
                h(ActionButton, {
                  variant: 'outline',
                  size: 'sm',
                  disabled: replayBusy || !ready || lastJudge === undefined,
                  onClick: () => replay(''),
                }, replayBusy && replayRow === '' ? '重放中…' : '重放这次判断')
              )
            ),
            h('p', { className: 'qs-note' },
              '拿这条消息的上下文，用当前提示词再判一次（改完提示词立刻能在这里看到效果），'
              + '这次保留思考。不写日志、不影响真实判定，也不占语义调用计数。'
              + '想重放更早的某一条，直接在下面的聊天记录里点每行的「重放」。'
            ),
            ready ? null : h('p', { className: 'qs-warn' }, '当前没有可用的判断模型，重放会失败。'),
            replayError ? h('p', { className: 'qs-warn' }, replayError) : null,
            replayResult === null || replayResult === undefined
              ? null
              : h('div', {
                  className: 'qs-block',
                  ref: replayResultRef,
                  style: { borderBottom: 'none', paddingBottom: 0 },
                },
                  h('div', { className: 'qs-status' },
                    h('span', { className: 'qs-status-key' }, '重放对象'),
                    h('span', { className: 'qs-status-val' },
                      `${new Date(replayResult.requested.at).toLocaleString()} · `
                      + `${replayResult.requested.sender || '某人'} · `
                      + `${replayResult.requested.text || '（空消息）'}`
                      + `　当时判 ${verdictLabel(replayResult.requested.verdict)}`
                    ),
                    h('span', { className: 'qs-status-key' }, '重放结论'),
                    h('span', { className: 'qs-status-val' },
                      `${verdictLabel(replayResult.verdict)}（模型原始返回：${replayResult.answer || '空'}）`
                    ),
                    h('span', { className: 'qs-status-key' }, '档位 / 预算'),
                    h('span', { className: 'qs-status-val qs-mono' },
                      `${replayResult.effort} / ${replayResult.maxTokens} tokens`
                      + ` · finish=${replayResult.finish}`
                      + (replayResult.retried ? ` · 重试：${replayResult.retried}` : '')
                    ),
                    h('span', { className: 'qs-status-key' }, '耗时 / 思考'),
                    h('span', { className: 'qs-status-val' },
                      `${replayResult.ms}ms · 思考 ${replayResult.reasoningChars} 字`
                      // 语言检测：提示词要求「必须用中文思考」，这里直接给出这次到底是不是中文，
                      // 不用人眼读完整段推理。
                      + (replayResult.reasoningLang === 'chinese'
                        ? ' · 中文'
                        : replayResult.reasoningLang === 'english'
                          ? ' · 英文（已按加强提示词重试仍为英文，考虑换模型）'
                          : '')
                    ),
                    h('span', { className: 'qs-status-key' }, '重放对象'),
                    h('span', { className: 'qs-status-val' },
                      REPLAY_SOURCES[replayResult.requested.source] ?? REPLAY_SOURCES.judge
                    ),
                    h('span', { className: 'qs-status-key' }, '这次发的提示词'),
                    h('span', { className: 'qs-status-val' },
                      REPLAY_PROMPT_SOURCES[replayResult.requested.promptSource] ?? REPLAY_PROMPT_SOURCES.current
                    )
                  ),
                  replayResult.requested.systemUpdated === true
                    ? h('p', { className: 'qs-note' },
                        'system 已按当前模板重发：这条当时用的是旧版提示词，所以重放结果和「当时判的」不可直接对比。'
                      )
                    : null,
                  replayResult.requested.reconstructed === true
                    ? h('p', { className: 'qs-warn' },
                        '这一条当时没留下完整输入，system + 上下文是按当前模板和聊天记录重建的；'
                        + '能看出模型怎么想，但别把它当成当时逐字节的输入。'
                      )
                    : null,
                  h('div', { className: 'qs-rowtext' },
                    h('span', { className: 'qs-title' }, '思考过程'),
                    h('pre', { className: 'qs-reasoning' },
                      replayResult.reasoning || '（这次没有返回思考内容：模型没输出 reasoning，或该档位对它相当于关闭思考）'
                    )
                  ),
                  h('details', { className: 'qs-details' },
                    h('summary', null, '看这次提交给模型的 system + 上下文'),
                    h('pre', { className: 'qs-reasoning' },
                      `【system】\n${replayResult.system}\n\n【prompt】\n${replayResult.prompt}`
                    )
                  )
                )
          ),

          // ── 聊天记录：挑一条重放 / 标注该回或不回 ──
          h('div', { className: 'qs-block', style: { borderBottom: 'none' } },
            h('div', { className: 'qs-block-head' },
              h('div', { className: 'qs-rowtext' },
                h('span', { className: 'qs-title' }, '聊天记录：重放某一条 / 标注「该回」或「不回」'),
                h('span', { className: 'qs-desc' },
                  `从聊天记录文件里读最近 ${state.semanticMisses?.limit ?? 80} 条群消息（含已经回过的），`
                  + '外加聊天记录落盘之前、从语义日志里捞回来的判定；重启也还在。'
                  + '每行能重放（看它当时怎么想的），标注按钮只给一侧：没回过的行给「该回」（该回却没回），'
                  + '已经回过的行（标「已回」）给「不回」（回了其实不该回）——'
                  + '两类一起喂给之后改提示词，才既不会越调越吵、也不会越调越装死。'
                  + '机器人自己的回复也在列表里（灰底），只作上下文；图片行后面带文件名，方便认出是哪张图。'
                )
              ),
              h(Tag, { tone: 'neutral' },
                `该回 ${missReplyCount} · 不回 ${missSilentCount}`
              )
            ),
            missPersist ? null : h('p', { className: 'qs-warn' },
              '聊天记录落盘已关闭（消息与上下文 → 落盘保存），这里没有可重放的记录。'
            ),
            replayById ? null : h('p', { className: 'qs-warn' },
              '后端还是旧版本（不认「重放这一条」）：先重载插件、再刷新这一页，按钮才会可用。'
            ),
            missRows.length === 0
              ? h('p', { className: 'qs-note' },
                  missPersist ? '聊天记录里还没有群消息。群里聊几句再回来。' : ''
                )
              : h('div', { className: 'qs-misses' },
                  ...missRows.map((item) => {
                    const answered = item.answered === true
                    // 标注方向只露一侧，按 agent 当时有没有回这条决定：
                    //   没回 → 「该回」（漏判样本）；回过 → 「不回」（反例样本）。
                    // 例外：行上还留着另一侧的旧标记时把它一并放出来，
                    // 否则那个标记在页面上既看不见、也取消不掉（旧版本两侧都给按钮留下的数据）。
                    const showReply = !answered || item.markedLabel === 'should-reply'
                    const showSilent = answered || item.markedLabel === 'should-not-reply'
                    return h('div', {
                      className: `qs-miss-row${item.bot === true ? ' qs-miss-bot' : ''}${answered ? ' qs-miss-answered' : ''}`,
                      key: item.id,
                    },
                    h('span', {
                      className: 'qs-miss-time',
                      title: Number.isFinite(item.at) ? new Date(item.at).toLocaleString() : '',
                    }, fmtAt(item.at)),
                    h('span', { className: 'qs-miss-sender' }, item.sender || '某人'),
                    h('span', { className: 'qs-miss-text', title: item.text }, item.text || '（空消息）'),
                    item.image === undefined
                      ? null
                      : h('span', {
                          className: 'qs-miss-file',
                          title: `${item.image.count > 1 ? `共 ${item.image.count} 张，第一张：` : ''}${item.image.path}`,
                        }, item.image.file),
                    item.bot === true
                      ? h('span', {
                          className: 'qs-miss-note',
                          title: '机器人自己的发言：在列表里只作上下文，不能标注。',
                        }, '机器人')
                      : item.answered === true
                        ? h('span', {
                            className: 'qs-miss-note',
                            title: '这条当时放行了（agent 已经回应过）。可以标「不回」记成反例：回了但其实不该回。',
                          }, '已回')
                        : item.source === 'history'
                          ? h('span', {
                              className: 'qs-miss-note',
                              title: '这条已经不在内存里了：标记时用聊天记录重建 system + prompt，不是当时逐字节的输入。',
                            }, '重建')
                          : item.source === 'log'
                            ? h('span', {
                                className: 'qs-miss-note',
                                title: '来自语义日志：聊天记录落盘上线之前的判定，system + prompt 是当时逐字的。',
                              }, '日志')
                            : null,
                    item.bot === true
                      ? null
                      : [
                          h('button', {
                            type: 'button',
                            key: 'replay',
                            className: 'qs-mini',
                            title: replayById
                              ? '按这一条的输入重放一次（档位跟上面的选择走），保留思考；不写日志、不影响判定。'
                              : '后端还是旧版本，重载插件后这里才能用。',
                            disabled: replayBusy || !ready || !replayById,
                            onClick: () => replay(item.id),
                          }, replayBusy && replayRow === item.id ? '…' : '重放'),
                          // 「该回」：该回却没回（漏判）。只在没回过的行出现，再点一次取消。
                          showReply ? h('button', {
                            type: 'button',
                            key: 'mark-reply',
                            className: 'qs-mini',
                            'data-on': item.markedLabel === 'should-reply',
                            'aria-pressed': item.markedLabel === 'should-reply',
                            disabled: markBusy === item.id,
                            title: answered
                              ? '这条还留着旧版本的「该回」标记；它已经回过，取消掉就行。'
                              : '该回却没回：存成漏判样本（含当时的 system + prompt）。再点一次取消。',
                            onClick: () => markMiss(
                              item.id,
                              item.markedLabel !== 'should-reply',
                              'should-reply',
                            ),
                          }, markBusy === item.id ? '…' : '该回') : null,
                          // 「不回」：回了但其实不该回（误判放行）。只在回过的行出现。
                          showSilent ? h('button', {
                            type: 'button',
                            key: 'mark-silent',
                            className: 'qs-mini',
                            'data-on': item.markedLabel === 'should-not-reply',
                            'aria-pressed': item.markedLabel === 'should-not-reply',
                            disabled: markBusy === item.id,
                            title: '不该回却回了：存成反例样本（含当时的 system + prompt）。再点一次取消。',
                            onClick: () => markMiss(
                              item.id,
                              item.markedLabel !== 'should-not-reply',
                              'should-not-reply',
                            ),
                          }, markBusy === item.id ? '…' : '不回') : null,
                        ].filter((node) => node !== null)
                    )
                  })
                ),
            markError ? h('p', { className: 'qs-warn' }, markError) : null,
            missPath ? h('p', { className: 'qs-note qs-mono' }, `样本：${missPath}`) : null,
            missHistoryPath ? h('p', { className: 'qs-note qs-mono' }, `来源：${missHistoryPath}`) : null,
            missFromLog && missLogPath ? h('p', { className: 'qs-note qs-mono' }, `补历史：${missLogPath}`) : null
          ),
        ),

        ) : null,

        // ══════════════════════════════════════════════════════════════
        // 页签 4 · 权限与运行：谁能指挥它、它在哪跑
        // ══════════════════════════════════════════════════════════════
        view === 'runtime' ? h(react.Fragment, null,

        // ── 谁能用斜杠命令 ──
        h(GroupTitle, { title: '命令权限' }),
        h(Row, {
          stacked: true,
          title: '允许使用 / 的发送者 ID',
          desc: '群里任何人 @ 一下机器人再发 /new、/model 这类命令，就会直接改掉会话。'
            + '名单只放你信任的人：其他人的消息在进来之前会先去掉行首的 /，变成普通聊天。留空 = 不限制。',
          children: [
            h('textarea', {
              id: 'qs-slash-ids',
              key: 'ids',
              className: 'qs-textarea qs-textarea-mono',
              value: slashIds,
              spellCheck: false,
              placeholder: '从下面「最近一次发送者」或「调试日志」的 senderId 复制\n（每行一个，留空 = 不限制）',
              onChange: (event) => setSlashIds(event.target.value),
            }),
            // 配名单时要抄的 ID 就在同一个分组里，不用滚到页尾的状态块去找。
            h('p', { className: 'qs-note', key: 'sender' },
              '最近一次发送者：',
              h('span', { className: 'qs-mono' },
                typeof state.lastDecision?.senderId === 'string' && state.lastDecision.senderId !== ''
                  ? state.lastDecision.senderId
                  : '暂无（在群里说一句话，或打开调试日志后就有）'
              )
            ),
            h('p', { className: 'qs-note', key: 'hint1' },
              '群聊里用的是「群成员 openid」，私聊用的是「用户 openid」，同一个人在这两处、不同群里都可能不一样——要放开就都填上。',
              '只去掉行首的 /（@ 标记之后的也算），正文中间的 /（网址、路径）不动。'
            ),
            h('p', { className: 'qs-note', key: 'hint2' },
              '怎么找自己的 ID：先打开下面的「调试日志」，在群里随便说一句话，',
              '日志里这条记录的 senderId 就是。'
            ),
          ],
        }),

        // ── 机器人在哪跑 / 禁用什么工具 ──
        h(GroupTitle, { title: '机器人运行位置' }),
        h(Row, {
          stacked: true,
          title: '机器人工作区',
          star: true,
          desc: '写 im-qqbot.cwd。这里显示的是机器人当前实际使用的目录，连上后自动填入（未连上时为空，留空保存不会改动）。已有会话不会搬过去——发 /new 重开一个，新会话才建在新目录。',
          children: h('input', {
            id: 'qs-workspace',
            className: 'qs-input',
            type: 'text',
            value: workspace,
            spellCheck: false,
            placeholder: state.guard?.defaultWorkspace ?? '',
            onChange: (event) => setWorkspace(event.target.value),
          }),
        }),
        h(Row, {
          stacked: true,
          title: '额外受管目录',
          star: true,
          desc: '每行一个；机器人工作区本身会自动算进去，不用重复填。同样要 /new 后新会话才认。',
          children: h('textarea', {
            id: 'qs-extras',
            className: 'qs-textarea',
            value: extras,
            spellCheck: false,
            placeholder: state.guard?.defaultWorkspace ?? '',
            onChange: (event) => setExtras(event.target.value),
          }),
        }),
        h(Row, {
          stacked: true,
          title: '禁用的全局工具',
          star: true,
          desc: '每行一个。只能在会话创建时挂上，改完要 /new 对新会话才生效；preset 里的 web_search / web_fetch 管不到。',
          children: h('textarea', {
            id: 'qs-deny',
            className: 'qs-textarea qs-textarea-mono',
            value: deny,
            spellCheck: false,
            placeholder: 'qqbot_send_file\nworking_directory',
            onChange: (event) => setDeny(event.target.value),
          }),
        }),
        // 上一次「建会话」时 deny 的实际结果：restrict 对不认识的名字会抛错，
        // 以前只进服务端日志，页面上看起来像「已生效」。
        denyResult === null ? null : h('p', {
          className: denyFailed.length > 0 ? 'qs-field-err' : 'qs-note',
          style: { padding: '6px 0 0' },
        },
          `上次新建会话（${fmtAt(denyResult.at)}）：已生效 ${denyApplied.length} 个`,
          denyApplied.length > 0 ? `（${denyApplied.join('、')}）` : '',
          denyFailed.length === 0
            ? '。'
            : `；未生效 ${denyFailed.length} 个：${denyFailed.map((item) => `${item.tool}（${item.message}）`).join('；')}`,
        ),
        // 群聊是白名单：不在清单里的工具一律拒绝。和上面的黑名单成对，
        // 一个管「全局都别用」，一个管「群里只能用这些」。
        h(Row, {
          stacked: true,
          title: '群聊允许使用的工具',
          desc: [
            '每行一个，白名单——不在清单里的工具在群里一律拒绝（空 = 群里什么工具都不给）。',
            '图片模式为 agent 时会自动追加 read_image，不用手填。',
            '这次保存后立即生效，不用 /new；只影响群聊，私聊不受影响。',
          ].join(''),
          children: [
            h('textarea', {
              id: 'qs-allow',
              key: 'allow',
              className: 'qs-textarea qs-textarea-mono',
              value: allow,
              spellCheck: false,
              placeholder: 'qqbot_bot_profile\nweb_search',
              onChange: (event) => setAllow(event.target.value),
            }),
            h('span', {
              key: 'effective',
              className: 'qs-desc',
              style: { display: 'block', marginTop: '4px' },
            }, `当前实际生效：${(Array.isArray(guard.groupTools) ? guard.groupTools : []).join('、') || '（空，群里什么工具都不给）'}`),
          ],
        }),
        // 星号说明跟着三行一起走：以前它在组尾、而三行在页面中段，用户要滚很远才对得上。
        h('p', { className: 'qs-note', style: { padding: '10px 0 0' } },
          '* 带星号的三项只在建会话时读一次：改完在 QQ 里发 /new 重开一个会话才会用上新设置，',
          '正在用的旧会话保持原样。没有星号的设置保存后立即生效。'
        ),

        // ── 群内状态（官方 bot_state / info，只读） ──
        h(GroupTitle, { title: '群内状态' }),
        h(Row, {
          stacked: true,
          title: '机器人在各群的状态',
          desc: '读官方 bot_state / info（每群 30 QPM）。只查最近聊过的几个群，手动刷新，一分钟一次。',
          children: [
            h('div', {
              key: 'bar',
              style: { display: 'flex', alignItems: 'center', gap: '10px' },
            },
              h('button', {
                type: 'button',
                className: 'qs-mini',
                disabled: healthBusy,
                onClick: refreshHealth,
              }, healthBusy ? '刷新中…' : '刷新'),
              h('span', { className: 'qs-desc' },
                health?.at ? `上次成功：${fmtAt(health.at)}` : '还没查过'),
            ),
            healthNote === null ? null : h('span', {
              key: 'note',
              className: healthNote.kind === 'error' ? 'qs-field-err' : 'qs-desc',
              style: { display: 'block', marginTop: '6px' },
            }, healthNote.text),
            health?.error ? h('span', {
              key: 'err',
              className: 'qs-field-err',
              style: { display: 'block', marginTop: '6px' },
            }, `上次失败：${health.error}`) : null,
            ...(healthGroups.length === 0
              ? [h('div', { key: 'empty', className: 'qs-empty', style: { marginTop: '8px' } },
                health?.at ? '历史里还没有群消息，查不到群' : '点「刷新」查一次')]
              : healthGroups.map((row) => h('div', {
                key: row.id,
                style: {
                  marginTop: '10px',
                  paddingTop: '10px',
                  borderTop: '1px solid var(--qs-line, rgba(128,128,128,0.25))',
                },
              },
                h('div', { style: { fontWeight: 600 } },
                  `${row.name || '（未命名群）'}${row.members > 0 ? ` · ${row.members} 人` : ''}`),
                h('div', { className: 'qs-desc qs-mono', style: { display: 'block', marginTop: '2px' } }, row.id),
                h('div', { className: 'qs-desc', style: { display: 'block', marginTop: '4px' } },
                  `群消息：${recvLabel(row.recv)} · 主动消息：${row.proactive ? '允许' : '不允许'} ·`,
                  ` 身份：${row.role || '未知'} · 入群：${row.joinedAt || '—'}`),
                row.error ? h('span', {
                  className: 'qs-field-err',
                  style: { display: 'block', marginTop: '4px' },
                }, row.error) : null,
                ...(Array.isArray(row.warnings) ? row.warnings : []).map((code) => h('span', {
                  key: code,
                  className: 'qs-field-err',
                  style: { display: 'block', marginTop: '4px' },
                }, healthWarn(code))),
              ))),
          ],
        }),

        // ── 提示词改写（默认折叠；改的是语义/冷场/上下文/图片/拒绝语，跨页签，所以单独放） ──
        promptSection,

        // ── 诊断与状态：调试开关常显，状态明细收起来 ──
        h(Collapse, {
          title: '诊断与状态',
          note: '日志开关 · 运行状态 · 路径',
          badge: state.semanticHealth?.degraded === true ? '已降级' : '正常',
          tone: state.semanticHealth?.degraded === true ? 'warning' : 'neutral',
        },
          h(Row, {
            title: '调试日志',
            desc: [
              '把每条群消息的判断结果追加到 ',
              state.debugLogPath ?? 'debug.log',
              '。这个开关同时控制语义日志；日志放在插件自己的数据目录（见下方「路径」），单个超过 1MB 自动轮转。',
            ],
            control: h(Toggle, {
              checked: debug,
              onChange: setDebug,
              label: '调试日志',
              title: debug ? '已开启' : '已关闭',
            }),
          }),

          h('div', { className: 'qs-subsec' }, '模型与判断'),
          h('div', { className: 'qs-status' },
            h('span', { className: 'qs-status-key' }, '语义模型'),
            h('span', { className: 'qs-status-val qs-mono' },
              state.model === null || state.model === undefined || state.model === ''
                ? '未配置（语义判断不会回复）'
                : `${state.model}${state.modelSource === 'custom' ? '（手动指定）' : '（默认）'}`
            ),
            h('span', { className: 'qs-status-key' }, '语义判断次数'),
            h('span', { className: 'qs-status-val' },
              `${state.semanticCalls ?? 0} 次，失败 ${state.semanticFailures ?? 0} 次`
            ),
            h('span', { className: 'qs-status-key' }, '语义判定链路'),
            h('span', { className: 'qs-status-val' },
              state.semanticHealth?.degraded === true
                ? `已降级：连续 ${state.semanticHealth.failures} 次失败 —— ${state.semanticHealth.lastError || '未知错误'}（这段时间群消息一律不回复）`
                : '正常'
            ),
            h('span', { className: 'qs-status-key' }, '最近一次判断'),
            h('span', { className: 'qs-status-val' }, decisionLabel(state.lastDecision))
          ),

          // 这三行是「当前生效值」的快照：设置在上面各自的页签里，这里只回答「现在到底是什么」。
          h('div', { className: 'qs-subsec' }, '生效配置快照'),
          h('div', { className: 'qs-status' },
            h('span', { className: 'qs-status-key' }, '超时中断'),
            h('span', { className: 'qs-status-val' },
              state.timeout?.enabled === false
                ? '已关闭'
                : `群聊超过 ${Math.round((state.timeout?.ms ?? 15000) / 1000)} 秒中断（私聊不限）`
            ),
            h('span', { className: 'qs-status-key' }, '冷场主动发言'),
            h('span', { className: 'qs-status-val' },
              state.idle?.enabled !== true
                ? '已关闭'
                : `安静 ${state.idle?.minutes ?? 10} 分钟 · 每群每天最多 ${state.idle?.dailyLimit ?? 3} 次`
                  + ` · ${state.idle?.hoursStart ?? 9}:00–${state.idle?.hoursEnd ?? 24}:00`
                  + (state.idle?.recallMissed === false ? ' · 只自己找话' : ' · 补回被拦下的那条')
            ),
            h('span', { className: 'qs-status-key' }, '群聊图片'),
            h('span', { className: 'qs-status-val' },
              state.image?.mode === 'agent'
                ? `${IMAGE_MODE_LABELS.agent}（间隔 ${state.image?.recall?.gapMinutes ?? 1} 分钟分批 · 每轮最多 ${state.image?.recall?.maxImages ?? 4} 张）`
                : IMAGE_MODE_LABELS[state.image?.mode] ?? '只留占位符'
            )
          ),

          h('div', { className: 'qs-subsec' }, '路径'),
          h('div', { className: 'qs-status' },
            h('span', { className: 'qs-status-key' }, '受管目录'),
            h('span', { className: 'qs-status-val qs-mono' }, (guard.managed ?? []).join('\n') || '（空）'),
            h('span', { className: 'qs-status-key' }, '运行期设置'),
            h('span', { className: 'qs-status-val qs-mono' }, state.settingsPath ?? ''),
            h('span', { className: 'qs-status-key' }, '调试日志'),
            h('span', { className: 'qs-status-val qs-mono' }, state.debugLogPath ?? ''),
            h('span', { className: 'qs-status-key' }, '语义日志'),
            h('span', { className: 'qs-status-val qs-mono' }, state.semanticLogPath ?? '')
          )
        ),

        ) : null,

        ),

        savebar
      )
    }

    return {
      name: 'qqbot-suite-client',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          {
            name: 'settings.section',
            id: 'qqbot-suite',
            order: 8,
            label: 'QQ 机器人套件',
          },
          SettingsSection,
        ))
      },
    }
  },
})
