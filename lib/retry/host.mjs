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
 * 浏览器半在 composer 右侧显示「重试」按钮，点击后由 Host 驱动**新的一轮**：
 * **官方 continuation 优先**（`sessionController.prompt({ …, content: [] })`，与 composer
 * 的「继续生成」同一条 Host 路径），官方不接受时回退 `agent.followup(中性提示词)`。
 *
 * ## 与官方的关系
 *
 * 两者互斥、不冲突：官方只在失败后出现继续入口，本组件只在用户中断后出现重试按钮；
 * 组件停用时浏览器半的能力探测会让按钮不渲染。驱动时优先借用官方 continuation
 * （历史里是紧凑的「已请求继续生成」），官方拒绝（例如本轮不是可继续的失败轮）
 * 才回退成自带的提示词消息。
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
 * 取 `sessionController` 服务（官方 continuation 的入口）。
 *
 * @param {any} ctx - 插件上下文。
 * @returns {any} sessionController 服务或 undefined。
 */
function sessionControllerOf(ctx) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined;
    return service === undefined || service === null ? undefined : service;
  } catch {
    return undefined;
  }
}

/** 官方 continuation 的等待上限：它只是把一条空消息排进 inbox，不该慢。 */
export const OFFICIAL_CONTINUE_TIMEOUT_MS = 10_000;

/**
 * 试一次**官方 continuation**（与 composer 上「继续生成」同一条 Host 路径）。
 *
 * `sessionController.prompt()` 的 `SessionPromptRequest` 契约：
 * `{ requestId, sessionId, mode: 'queue', content: [] }` —— **空 content 表示
 * 「继续一个 eligible 的失败空闲会话」**，Host 会以 `source.kind = 'retry'` 记录这条消息，
 * 渲染成紧凑的「已请求继续生成」。第二个参数是调用方取消用的 `AbortSignal`（必填）。
 *
 * 官方路径会拒绝很多场景（`session/agent-busy`：没有可继续的失败、inbox 里已有排队输入、
 * Agent 正在跑…），这些都属于"官方不可用"，由调用方回退到 `agent.followup()`。
 *
 * @param {any} ctx - 插件上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<boolean>} 官方接受了则 true；服务缺失/抛错一律 false。
 */
export async function tryOfficialContinuation(ctx, sessionId) {
  const controller = sessionControllerOf(ctx);
  if (controller === undefined || typeof controller.prompt !== 'function') return false;
  const signal =
    typeof AbortSignal?.timeout === 'function'
      ? AbortSignal.timeout(OFFICIAL_CONTINUE_TIMEOUT_MS)
      : new AbortController().signal;
  try {
    await controller.prompt(
      {
        sessionId,
        requestId: randomUUID(),
        mode: 'queue',
        // 空数组 = 官方「继续生成」语义（api/session-controller 的 SessionPromptRequest）。
        content: [],
      },
      signal,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建「驱动一次新的一轮」的函数。
 *
 * 顺序：**官方 continuation 优先，提示词兜底**。
 *
 * 1. 先走 `sessionController.prompt({ …, content: [] })`：与官方「继续生成」完全同一条
 *    路径，历史里显示成紧凑的「已请求继续生成」。成功即 `{ ok: true, method: 'official' }`。
 * 2. 官方不可用（没有服务 / `session/agent-busy` / 会话不可继续）→ 回退
 *    `agent.followup(createRetryUserMessage())`：这一轮已经结束，`{ kind: 'retry' }` 会被
 *    loop 的 `signal.throwIfAborted()` 立刻抛出；`followup` 是 Agent 上唯一"排一条 user
 *    消息并唤醒驱动器"的入口。代价是历史里多一条中性提示词消息。
 * 3. 两条都失败才返回错误（保持原有 `code`/`message` 结构，补 `method`/`reason`）。
 *
 * @param {any} ctx - 插件上下文。
 * @returns {(sessionId: string) => Promise<{ ok: boolean, method?: 'official' | 'prompt' | null, code?: string, message?: string, reason?: string }>} 驱动函数。
 */
export function createDriveRetry(ctx) {
  return async function driveRetry(sessionId) {
    // 1) 官方 continuation 优先。
    if (await tryOfficialContinuation(ctx, sessionId)) {
      return { ok: true, method: 'official' };
    }

    // 2) 回退：agent.followup 排一条中性提示词消息。
    const agents = agentService(ctx);
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
    if (agent === undefined || agent === null) {
      return {
        ok: false,
        method: null,
        code: 'NO_LIVE_AGENT',
        message: 'This session has no live agent to drive (official continuation was also unavailable).',
        reason: 'no-live-agent',
      };
    }
    if (typeof agent.followup !== 'function') {
      return {
        ok: false,
        method: null,
        code: 'NO_FOLLOWUP',
        message: 'Agent.followup is unavailable in this build (official continuation was also unavailable).',
        reason: 'followup-unavailable',
      };
    }
    try {
      await agent.followup(createRetryUserMessage());
      return { ok: true, method: 'prompt' };
    } catch (error) {
      return {
        ok: false,
        method: null,
        code: 'FOLLOWUP_FAILED',
        message: String(error?.message ?? error),
        reason: 'followup-failed',
      };
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
