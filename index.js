/**
 * 「会话增强」组件的 Host 半（Loader 行 `dsh-session-enhance`）。
 *
 * ## 它做什么
 *
 * 注册两个工具与两条 UI RPC 通道：
 *
 * - `session_lookup`：按会话 id 返回标题、工作区、预设、父级链、全部子代理
 *   （父在前、带 depth / parentId）、最近消息与继承事件数。省略 `sessionId` 时查当前
 *   会话——这就是"我给 Agent 一个会话 id，让它看看那个会话和它的子代理"那条路径。
 * - `session_resume_subagents`：列出并冷恢复被终止的子智能体（`subagent` 派生的子会话与
 *   Agent Teams 的 teammate）。DSH 只允许父级通过 continuation 通道冷恢复它们，UI 打开
 *   子会话时会被 `ApiSessionSubagentOwnership` 拒绝；本工具把这条通道交给模型。
 * - `/dsh-session-enhance-context`：composer 官方「上下文已用」面板里的手动压缩动作。
 * - `/dsh-session-enhance-subagent`：浏览器半标题栏「恢复子智能体」按钮。
 *
 * 本文件同时是包根导出（`exports["."]`）：`dsh-session-enhance` 这个 specifier 解析到这里，
 * 于是单入口配置（只写一行 `dsh-session-enhance`）仍然有会话查询能力——三个组件真正
 * 合在一起的形态由 `cordis.patch.yml` 里的三行声明，而不是由包根隐式提供。
 *
 * ## 依赖
 *
 * | 服务 | 用途 | 缺失时 |
 * |---|---|---|
 * | `tools` | 注册工具 | 硬依赖（模块加载失败） |
 * | `sessionQuery` | 查会话与血缘 | 工具返回可读失败，不崩 |
 * | `agents` / `subagents` / `agentTeams` | 子智能体恢复 | 对应能力返回明确错误码 |
 * | `tokenMeter` / `compaction` / `commands` | 上下文用量与手动压缩 | 按钮置灰并提示 |
 *
 * @module dsh-session-enhance
 */

import { buildLookupTool } from './lib/tools/lookup.mjs';
import { buildResumeSubagentsTool } from './lib/tools/subagents.mjs';
import { BUILD } from './lib/build.mjs';
import { createContextHandler, installContextChannel } from './lib/context/host.mjs';
import { createSubagentHandler, installSubagentChannel } from './lib/subagent/host.mjs';

/** Cordis 插件名：与包根 specifier 同名。 */
export const name = 'dsh-session-enhance';

/** `tools` 是硬依赖：注册工具是这个组件的存在理由。 */
export const inject = ['tools'];

export { BUILD };

/**
 * 注册「会话增强」组件。
 *
 * @param {any} ctx - Cordis 插件上下文。
 * @returns {void}
 */
export function apply(ctx) {
  const lookup = buildLookupTool(ctx);
  ctx.effect(() => ctx.tools.register(lookup), 'dsh-session-enhance: tool session_lookup');

  // 子智能体恢复：RPC 通道（浏览器半标题栏按钮）与工具（模型可主动恢复）共用同一个处理器。
  const subagentHandler = createSubagentHandler({ ctx, logger: ctx.logger });
  ctx.effect(
    () => ctx.tools.register(buildResumeSubagentsTool(subagentHandler)),
    'dsh-session-enhance: tool session_resume_subagents',
  );
  installSubagentChannel(ctx, subagentHandler);

  // 上下文用量 + 手动压缩：官方 ContextMeter 面板里的动作通过这条通道调 compactNow。
  // 通道挂在本行（第一行）而不是 share/retry 行 —— 这两个子组件可能被单独停用，
  // 而「看上下文 / 压缩 / 恢复子智能体」与它们无关。依赖均为软依赖。
  installContextChannel(ctx, createContextHandler({ ctx, logger: ctx.logger }));
  ctx.logger?.info?.(`dsh-session-enhance: ready (2 tools + context/subagent rpc, build=${BUILD})`);
}
