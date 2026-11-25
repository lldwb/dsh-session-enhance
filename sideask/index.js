/**
 * 「侧边提问」组件的 Host 半（Loader 行 `dsh-session-enhance/sideask`）。
 *
 * 侧边提问不是原会话的分支：它创建一个**新的只读会话**，把原会话 id 写进「询问提示词」，
 * 让模型用会话查询工具按 id 去查需要的内容。Host 侧负责创建会话、切只读（fail-closed）
 * 与「保留」后恢复权限；浏览器半负责侧栏标签、选区弹层与标题栏入口。
 *
 * 实现都在 `lib/sideask/`：
 *
 * - `prompt.mjs`：询问提示词（纯函数，可离线单测）；
 * - `rpc.mjs`：`/dsh-session-enhance-sideask` 通道（probe / create / setPreset / restore / forget）；
 * - `host.mjs`：创建会话、只读与权限恢复。
 *
 * 这个组件不注册任何模型工具。
 *
 * @module dsh-session-enhance/sideask
 */

import { BUILD } from '../lib/build.mjs';
import { installSideAskComponent } from '../lib/sideask/host.mjs';

/** Cordis 插件名：与 Loader 行的 `name` 一致。 */
export const name = 'dsh-session-enhance/sideask';

/** 不注册工具；依赖由 `installSideAskComponent` 用 `ctx.inject` 软取。 */
export const inject = [];

export { BUILD };

/**
 * 注册「侧边提问」组件。
 *
 * @param {any} ctx - Cordis 插件上下文。
 * @returns {void}
 */
export function apply(ctx) {
  installSideAskComponent(ctx);
  ctx.logger?.info?.(`dsh-session-enhance/sideask: ready (build=${BUILD})`);
}
