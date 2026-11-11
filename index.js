/**
 * 「会话增强」组件的 Host 半（Loader 行 `dsh-session-enhance`）。
 *
 * ## 它做什么
 *
 * 注册两个工具、一条 UI RPC 通道，以及**分级上下文压缩**的自动驱动器：
 *
 * - `session_lookup`：按会话 id 返回标题、工作区、预设、父级链、全部子代理
 *   （父在前、带 depth / parentId）、最近消息与继承事件数。省略 `sessionId` 时查当前
 *   会话——这就是"我给 Agent 一个会话 id，让它看看那个会话和它的子代理"那条路径。
 * - `session_resume_subagents`：列出并冷恢复被终止的子智能体（`subagent` 派生的子会话与
 *   Agent Teams 的 teammate）。DSH 只允许父级通过 continuation 通道冷恢复它们，UI 打开
 *   子会话时会被 `ApiSessionSubagentOwnership` 拒绝；本工具把这条通道交给模型。
 * - `/dsh-session-enhance-context`：官方「上下文已用」面板里的手动压缩动作。
 * - `/dsh-session-enhance-subagent`：浏览器半标题栏「恢复子智能体」按钮。
 * - **分级自动压缩**（`lib/compact/host.mjs`）：`autoCompact` 打开时，在每次模型请求前
 *   按压力执行 L1 批量修剪工具结果（不调模型）/ L2 修剪+摘要（一次事务）/ L3 溢出恢复。
 *   `autoCompact` 默认关闭，可在「设置 → 插件 → 会话增强」里打开。
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
 * | `tokenMeter` / `compaction` / `commands` / `toolResultPruner` | 上下文用量与压缩 | 对应能力降级（按钮置灰、自动压缩跳过该级） |
 * | `settings` | 设置页策略（自绘页） | 可选，缺失时仍可运行 |
 *
 * @module dsh-session-enhance
 */

import z from '@deepseek-ai/schemastery';

import { buildLookupTool } from './lib/tools/lookup.mjs';
import { buildResumeSubagentsTool } from './lib/tools/subagents.mjs';
import { BUILD } from './lib/build.mjs';
import { createContextHandler, installContextChannel } from './lib/context/host.mjs';
import { createCompactionDriver } from './lib/compact/host.mjs';
import { readOption } from './lib/compact/options.mjs';
import { createSubagentHandler, installSubagentChannel } from './lib/subagent/host.mjs';

/** Cordis 插件名：与包根 specifier 同名。 */
export const name = 'dsh-session-enhance';

/** `tools` 是硬依赖：注册工具是这个组件的存在理由。 */
export const inject = ['tools'];

/**
 * 设置命名空间 = Loader 行 id（设置服务按行 id 投影 volatile 字段）。
 *
 * 客户端半在 `client.js` 里硬编码同一个字符串（浏览器包不能依赖 Host 包）。
 */
export const SETTINGS_NAMESPACE = name;

/**
 * 插件配置。
 *
 * - `autoCompact`：分级自动压缩总开关，**默认关闭**；volatile ⇒ 设置页保存后原地热更新，
 *   下一次 `agent/pre-step` 立即按新值执行，不需要重启。
 */
export const Config = z.object({
  autoCompact: z.boolean().default(false).volatile(),
});

export { BUILD };

/**
 * 注册「会话增强」组件。
 *
 * @param {any} ctx - Cordis 插件上下文。
 * @param {any} [config] - 已解析的插件配置（`Config` 的实例）。
 * @returns {void}
 */
export function apply(ctx, config) {
  /** 每次读取都是最新值（volatile 字段是活引用，不是快照）。 */
  const readAutoCompact = () => readOption(config, 'autoCompact', false) === true;

  const lookup = buildLookupTool(ctx);
  ctx.effect(() => ctx.tools.register(lookup), 'dsh-session-enhance: tool session_lookup');

  // 子智能体恢复：RPC 通道（浏览器半标题栏按钮）与工具（模型可主动恢复）共用同一个处理器。
  const subagentHandler = createSubagentHandler({ ctx, logger: ctx.logger });
  ctx.effect(
    () => ctx.tools.register(buildResumeSubagentsTool(subagentHandler)),
    'dsh-session-enhance: tool session_resume_subagents',
  );
  installSubagentChannel(ctx, subagentHandler);

  // 分级自动压缩：L1 修剪 / L2 修剪+摘要 / L3 溢出恢复，全部由 autoCompact 控制。
  const driver = createCompactionDriver({ ctx, readAutoCompact, logger: ctx.logger });
  ctx.effect(() => {
    const disposers = driver.attach();
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 卸载阶段的异常不影响其余清理。
        }
      }
    };
  }, 'dsh-session-enhance: tiered compaction driver');

  // 上下文用量 + 手动（分级）压缩：官方 ContextMeter 面板里的动作通过这条通道调压缩。
  // 通道挂在本行（第一行）而不是 share/retry 行 —— 这两个子组件可能被单独停用，
  // 而「看上下文 / 压缩 / 恢复子智能体」与它们无关。依赖均为软依赖。
  installContextChannel(ctx, createContextHandler({ ctx, logger: ctx.logger, driver }));

  // 设置页由浏览器半自绘（「设置 → 插件 → 会话增强」），关掉自动生成页避免双页。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.effect(
        () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
        'dsh-session-enhance: settings presentation policy',
      );
    });
  }

  ctx.logger?.info?.(
    `dsh-session-enhance: ready (2 tools + context/subagent rpc + tiered compaction, build=${BUILD})`,
  );
}
