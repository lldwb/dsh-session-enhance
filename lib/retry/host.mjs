/**
 * 「中断重试」组件的 Host 半。
 *
 * ## 它补的是什么
 *
 * DSH 0.2.2 官方内置了失败恢复：模型请求以 `turn/end { reason: { kind: 'error' } }`
 * 结束时，`conversationContinuation` 投影会记录一个可继续位置，composer 的主按钮变成
 * 「继续生成」。但它**只覆盖 error 且错误码属于可继续集合**的情况，不覆盖
 * `aborted`（用户点停止）—— 用户中断的轮次在官方语义里是"正常结束"。
 *
 * 本组件补这一格：用户点停止后，`turn/end` 的取消原因是
 * `{ kind: 'aborted', reason: { kind: 'user' } }`；Host 记一条可重试记录（TTL 30 分钟），
 * 浏览器半在 composer 右侧显示「重试」按钮，点击后由 Host 用 `agent.followup()`
 * 发一条中性 user 消息驱动**新的一轮**（这一轮已经结束，没有原地重试可言）。
 *
 * ## 与官方的关系
 *
 * 两者互斥、不冲突：官方只在失败后出现继续入口，本组件只在用户中断后出现重试按钮；
 * 组件停用时浏览器半的能力探测会让按钮不渲染。
 *
 * ## 边界
 *
 * - 只有 `aborted + reason.kind === 'user'` 才记录；parent / hook / disposed 等取消
 *   不是用户本意，不提供重试。
 * - 记录只在内存：Host 重启后丢失；旧的历史会话不会出现无法执行的按钮。
 * - 新的一轮开始（`turn/start`）或用户发来新消息时，记录立即作废。
 *
 * @module dsh-session-enhance/lib/retry/host
 */

import { randomUUID } from 'node:crypto';

import { BUILD } from '../build.mjs';
import { DEFAULT_RECOVERY_TTL_MS, RecoveryStore } from './recovery.mjs';
import { createRetryHandler, installRetryChannel } from './rpc.mjs';

/** 重试时发给 Agent 的中性继续消息。 */
export const RETRY_CONTINUE_TEXT =
  '（上一轮被用户中断。请从中断处继续完成，不要复述已完成的部分。）';

/** followup 消息 id 前缀（便于在会话历史里认出这条是本组件注入的）。 */
export const RETRY_MESSAGE_ID_PREFIX = 'dsh-session-enhance-retry-';

/**
 * 构造「中断后重试」驱动用的 user 消息。
 *
 * `agent.followup(input)` 的声明是 `UserMessage`，所以 `id` / `role` / `content` /
 * `source` 四个字段必须给全；0.2.2 的队列 dock 会读 `content[].text` 与
 * `source.kind`，非 user 的 source 会走不同分支。
 *
 * @returns {{ id: string, role: 'user', content: Array<{ type: 'text', text: string }>, source: { kind: 'user' } }} user 消息。
 */
export function createRetryUserMessage() {
  return {
    id: `${RETRY_MESSAGE_ID_PREFIX}${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text: RETRY_CONTINUE_TEXT }],
    source: { kind: 'user' },
  };
}

/**
 * 这一轮的取消原因是不是「用户本人点了停止」。
 *
 * @param {{ kind?: string, reason?: { kind?: string } } | undefined} reason - `turn/end` 的 reason。
 * @returns {boolean} 是用户中断则 true。
 */
export function isUserInterruption(reason) {
  return reason?.kind === 'aborted' && reason?.reason?.kind === 'user';
}

/**
 * 从 `session/event` 的 session 参数取会话 id。
 *
 * @param {{ id?: unknown, sessionId?: unknown } | undefined} session - 会话对象。
 * @returns {string} 会话 id（取不到时为空串）。
 */
export function sessionIdOf(session) {
  const id = session?.id ?? session?.sessionId;
  return typeof id === 'string' ? id : '';
}

/**
 * 把一条 `session/event` 消化成「可重试记录」的增删。
 *
 * 抽成纯函数（不碰 Cordis）：单测可以直接驱动它，不用伪造事件总线。
 *
 * @param {RecoveryStore} recovery - 记录存储。
 * @param {{ id?: unknown, sessionId?: unknown } | undefined} session - 会话对象。
 * @param {{ type?: string, data?: any }} event - 会话事件。
 * @returns {void}
 */
export function handleSessionEvent(recovery, session, event) {
  const sessionId = sessionIdOf(session);
  if (sessionId === '') return;

  if (event?.type === 'turn/start') {
    // 新的一轮开始了：之前那条"可重试"的记录已经过时。
    recovery.forget(sessionId);
    return;
  }
  if (event?.type === 'user/message') {
    // 用户发来新消息（append）：他显然不打算重试上一轮，记录作废。
    const data = event.data;
    if (data?.source?.kind === 'user' && Array.isArray(data?.content) && data.content.length > 0) {
      recovery.forget(sessionId);
    }
    return;
  }
  if (event?.type !== 'turn/end') return;

  const reason = event.data?.reason;
  if (isUserInterruption(reason)) {
    recovery.remember(sessionId, { turn: event.data?.turn });
    return;
  }
  // completed / error / blocked，以及 aborted 但不是用户本意（parent / hook /
  // disposed / legacy）：都不提供本组件的重试。失败擦除记录是让官方的继续生成
  // 成为唯一入口，避免同一轮同时出现两个重试 UI。
  recovery.forget(sessionId);
}

/**
 * 取 `agents` 服务（两种访问形态都兼容）。
 *
 * @param {any} ctx - 插件上下文。
 * @returns {any} agents 服务或 undefined。
 */
function agentService(ctx) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined;
    if (service !== undefined && service !== null) return service;
  } catch {
    // ctx.get 在某些最小部署上会抛，回退属性访问。
  }
  return ctx?.agents;
}

/**
 * 创建「驱动一次新的一轮」的函数。
 *
 * 只能用 `agent.followup()`：这一轮已经结束，`{ kind: 'retry' }` 会被 loop 的
 * `signal.throwIfAborted()` 立刻抛出；`followup` 是 Agent 上唯一"排一条 user 消息并
 * 唤醒驱动器"的入口。代价是历史里多一条中性消息 —— 这是当前架构下的既定取舍。
 *
 * @param {any} ctx - 插件上下文。
 * @returns {(sessionId: string) => Promise<{ ok: boolean, code?: string, message?: string }>} 驱动函数。
 */
export function createDriveRetry(ctx) {
  return async function driveRetry(sessionId) {
    const agents = agentService(ctx);
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
    if (agent === undefined || agent === null) {
      return { ok: false, code: 'NO_LIVE_AGENT', message: 'This session has no live agent to drive.' };
    }
    if (typeof agent.followup !== 'function') {
      return { ok: false, code: 'NO_FOLLOWUP', message: 'Agent.followup is unavailable in this build.' };
    }
    try {
      await agent.followup(createRetryUserMessage());
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'FOLLOWUP_FAILED', message: String(error?.message ?? error) };
    }
  };
}

/**
 * 注册「中断重试」组件。
 *
 * @param {any} ctx - Cordis 插件上下文。
 * @returns {void}
 */
export function installInterruptedRetry(ctx) {
  const recovery = new RecoveryStore();
  const driveRetry = createDriveRetry(ctx);
  const handler = createRetryHandler({
    recovery,
    driveRetry,
    probe: () => {
      const agents = agentService(ctx);
      return {
        hasAgents: typeof agents?.get === 'function',
        storeSize: recovery.size,
        ttlMs: recovery.ttlMs,
      };
    },
  });

  installRetryChannel(ctx, handler);

  ctx.on?.('session/event', (session, event) => {
    handleSessionEvent(recovery, session, event);
  });

  // 卸载时清空记录（组件随时可被单独停用）。
  ctx.effect?.(() => () => {
    recovery.clear();
  }, 'dsh-session-enhance: interrupted retry recovery');

  ctx.logger?.debug?.(
    `dsh-session-enhance/retry: installed (build=${BUILD}, ttlMs=${DEFAULT_RECOVERY_TTL_MS})`,
  );
}
