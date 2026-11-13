/**
 * 「中断重试」组件的 Host 半（Loader 行 `dsh-session-enhance/retry`）。
 *
 * 只补官方「继续生成」覆盖不到的场景：用户点了停止的那一轮，官方语义里是正常结束
 * （`aborted`），不会出现继续入口。本组件在 `turn/end` 取消原因为
 * `{ kind: 'aborted', reason: { kind: 'user' } }` 时记一条可重试记录，浏览器半在
 * composer 右侧显示「重试」按钮；点击后由 Host 用 `agent.followup()` 驱动新一轮
 * （历史里会多一条中性消息，不是原地重试）。
 *
 * 实现全部在 `lib/retry/`：
 *
 * - `recovery.mjs`：可重试记录（TTL 30 分钟）；
 * - `host.mjs`：`session/event` 判定、followup 驱动、组件接线；
 * - `rpc.mjs`：`/dsh-session-enhance-retry` 通道与 pending / retry / diag 端点。
 *
 * 这个组件**不需要 `tools`**：它不注册任何模型工具，只挂事件与 RPC。
 *
 * @module dsh-session-enhance/retry
 */

import { BUILD } from '../lib/build.mjs';
import { installInterruptedRetry } from '../lib/retry/host.mjs';

/** Cordis 插件名：与 Loader 行的 `name` 一致。 */
export const name = 'dsh-session-enhance/retry';

/** 不注册工具；`installInterruptedRetry` 自己用 `ctx.inject` 软取 connection / webServer。 */
export const inject = [];

export { BUILD };

/**
 * 注册「中断重试」组件。
 *
 * @param {any} ctx - Cordis 插件上下文。
 * @returns {void}
 */
export function apply(ctx) {
  installInterruptedRetry(ctx);
  ctx.logger?.info?.(`dsh-session-enhance/retry: ready (build=${BUILD})`);
}
