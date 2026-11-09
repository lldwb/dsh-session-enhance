/**
 * 「会话增强」组件的 Host 半（Loader 行 `dsh-session-enhance`）。
 *
 * ## 它做什么
 *
 * 注册工具 `session_lookup`：按会话 id 返回标题、工作区、预设、父级链、全部子代理
 * （父在前、带 depth / parentId）、最近消息与继承事件数。省略 `sessionId` 时查当前
 * 会话——这就是"我给 Agent 一个会话 id，让它看看那个会话和它的子代理"那条路径。
 *
 * 本文件同时是包根导出（`exports["."]`）：`dsh-session-enhance` 这个 specifier 解析到这里，
 * 于是单入口配置（只写一行 `dsh-session-enhance`）仍然只有会话查询能力——三个组件真正
 * 合在一起的形态由 `cordis.patch.yml` 里的三行声明，而不是由包根隐式提供。
 *
 * ## 依赖
 *
 * | 服务 | 用途 | 缺失时 |
 * |---|---|---|
 * | `tools` | 注册工具 | 硬依赖（模块加载失败） |
 * | `sessionQuery` | 查会话与血缘 | 工具返回可读失败，不崩 |
 *
 * @module dsh-session-enhance
 */

import { buildLookupTool } from './lib/tools/lookup.mjs';
import { BUILD } from './lib/build.mjs';
import { createContextHandler, installContextChannel } from './lib/context/host.mjs';

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
  const definition = buildLookupTool(ctx);
  ctx.effect(() => ctx.tools.register(definition), 'dsh-session-enhance: tool session_lookup');
  // 上下文用量 + 手动压缩：浏览器半的 composer 小部件通过这条通道读用量/触发压缩。
  // 通道挂在本行（第一行）而不是 share/retry 行 —— 这两个子组件可能被单独停用，
  // 而「看上下文 / 压缩」与它们无关。依赖 tokenMeter / compaction 是软依赖。
  installContextChannel(ctx, createContextHandler({ ctx, logger: ctx.logger }));
  ctx.logger?.info?.(`dsh-session-enhance: ready (1 tool + context rpc, build=${BUILD})`);
}
