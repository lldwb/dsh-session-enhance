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
 * 本组件补这一格：两类「没做完」的轮次都可以重试——
 *
 * 1. **用户点停止**：`turn/end` 的取消原因是 `{ kind: 'aborted', reason: { kind: 'user' } }`；
 * 2. **应用被关闭 / 电脑重启 / 关机**：优雅退出时是 `{ kind: 'aborted', reason: { kind: 'disposed' } }`；
 *    强制关闭则连 `turn/end` 都没有；DSH 重启重放日志时也可能补写 `{ kind: 'interrupted' }`。
 *    两种形态都由启动扫描 `scanUnfinishedTurns()` 补记（时间窗 72 小时、最多读 60 份日志）。
 *
 * Host 记一条可重试记录（TTL 30 分钟），浏览器半在 composer 右侧显示「重试」按钮，
 * 点击后由 Host 驱动**新的一轮**：**官方 continuation 优先**
 * （`sessionController.prompt({ …, content: [] })`，与 composer 的「继续生成」同一条
 * Host 路径），官方不接受时回退 `agent.followup(中性提示词)`。
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
 * - 两类中断都可重试：`aborted + reason.kind === 'user'`（用户点停止）与
 *   `aborted + reason.kind === 'disposed'`（应用退出）；parent / hook 等取消不是
 *   "这一轮还能继续"的语义，不提供重试。
 * - 应用被**强制关闭 / 电脑重启 / 关机**：没有 `turn/end`，或重启重放时补写
 *   `{ kind: 'interrupted' }`；两种都由启动扫描 `scanUnfinishedTurns()` 补记
 *   （时间窗 72 小时、最多读 60 份日志）。
 * - 新的一轮开始（`turn/start`）或用户发来新消息时，记录立即作废。
 *
 * @module dsh-session-enhance/lib/retry/host
 */

import { randomUUID } from 'node:crypto';

import { BUILD } from '../build.mjs';
import { DEFAULT_RECOVERY_TTL_MS, RecoveryStore } from './recovery.mjs';
import { createRetryHandler, installRetryChannel } from './rpc.mjs';

/** 重试时发给 Agent 的中性继续消息（按中断原因区分，避免让 Agent 误判为失败）。 */
export const RETRY_CONTINUE_TEXT =
  '（上一轮因应用被关闭或中断而没有完成。请从中断处继续完成，不要复述已完成的部分。）';

/**
 * 被用户主动停止（暂停）后的继续文案。
 *
 * 用户 2026-11-27 更正：不要写「被你停止」——对 Agent 说话时「你」会让它以为
 * "这一轮是它自己停的"；要明确写**被用户暂停**。
 */
export const RETRY_CONTINUE_TEXT_USER =
  '（上一轮被用户暂停。请从中断处继续完成，不要复述已完成的部分。）';

/**
 * 被谷峰（高峰暂停）打断后的继续文案。
 *
 * 用户 2026-11-27 要求：这类中断必须写明「因为高峰暂停」，不能只写笼统的「上一轮被中断」，
 * 否则 Agent 会当成失败处理（重新规划、重派子代理、向用户报错）。
 */
export const RETRY_CONTINUE_TEXT_OFFPEAK =
  '（上一轮因谷峰「高峰暂停」而被中断，不是失败。请从中断处继续完成，不要复述已完成的部分。）';

/**
 * 按中断原因取继续文案。
 *
 * @param {'user'|'app'|'offpeak'|undefined} cause - 中断来源。
 * @returns {string} 文案。
 */
export function continueTextOf(cause) {
  if (cause === 'user') return RETRY_CONTINUE_TEXT_USER;
  if (cause === 'offpeak') return RETRY_CONTINUE_TEXT_OFFPEAK;
  return RETRY_CONTINUE_TEXT;
}

/** followup 消息 id 前缀（便于在会话历史里认出这条是本组件注入的）。 */
export const RETRY_MESSAGE_ID_PREFIX = 'dsh-session-enhance-retry-';

/**
 * 构造「中断后重试」驱动用的 user 消息。
 *
 * `agent.followup(input)` 的声明是 `UserMessage`，所以 `id` / `role` / `content` /
 * `source` 四个字段必须给全；0.2.2 的队列 dock 会读 `content[].text` 与
 * `source.kind`，非 user 的 source 会走不同分支。
 *
 * @param {'user'|'app'|'offpeak'|undefined} [cause] - 中断来源（决定文案）。
 * @returns {{ id: string, role: 'user', content: Array<{ type: 'text', text: string }>, source: { kind: 'user' } }} user 消息。
 */
export function createRetryUserMessage(cause) {
  return {
    id: `${RETRY_MESSAGE_ID_PREFIX}${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text: continueTextOf(cause) }],
    source: { kind: 'user' },
  };
}

/**
 * 这一轮的取消原因是不是「被谷峰（高峰暂停）打断」。
 *
 * 谷峰 controller 的 cancel 参数是 `{ kind: 'hook', reason: 'offpeak-pause' }`
 * （`hook` 是封闭 union 里唯一带自由字符串的成员）。
 *
 * @param {{ kind?: string, reason?: { kind?: string, reason?: string } } | undefined} reason - `turn/end` 的 reason。
 * @returns {boolean} 是谷峰暂停则 true。
 */
export function isOffpeakPause(reason) {
  return (
    reason?.kind === 'aborted' &&
    reason?.reason?.kind === 'hook' &&
    reason?.reason?.reason === 'offpeak-pause'
  );
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
 * 这一轮的取消原因是不是「应用被关闭/退出」。
 *
 * 两种形态：
 * - `aborted + reason.kind === 'disposed'`：进程退出时 Agent 被正常 dispose；
 * - `{ kind: 'interrupted' }`：进程**被强制结束**后，DSH 在下次启动重放日志时补写的
 *   「这一轮被应用中断了」（实测：杀掉宿主进程再启动，日志里会出现这个 reason）。
 *
 * @param {{ kind?: string, reason?: { kind?: string } } | undefined} reason - `turn/end` 的 reason。
 * @returns {boolean} 是应用中断则 true。
 */
export function isAppInterruption(reason) {
  if (reason?.kind === 'interrupted') return true;
  return reason?.kind === 'aborted' && reason?.reason?.kind === 'disposed';
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
    recovery.remember(sessionId, { turn: event.data?.turn, cause: 'user' });
    return;
  }
  if (isOffpeakPause(reason)) {
    // 谷峰高峰暂停：不是失败，也不该让 Agent 误判。记下来（文案会写明原因）；
    // 谷峰组件本身也会在空闲/关闭时自动恢复，这里的按钮只是让用户能提前手动继续。
    recovery.remember(sessionId, { turn: event.data?.turn, cause: 'offpeak' });
    return;
  }
  if (isAppInterruption(reason)) {
    // 应用退出：优雅退出是 aborted+disposed；被强制结束后 DSH 重放时补写 interrupted。
    recovery.remember(sessionId, { turn: event.data?.turn, cause: 'app' });
    return;
  }
  // completed / error / blocked，以及 aborted 但不是"还能继续"的语义（parent / hook /
  // legacy）：都不提供本组件的重试。失败擦除记录是让官方的继续生成成为唯一入口，
  // 避免同一轮同时出现两个重试 UI。
  recovery.forget(sessionId);
}

/**
 * 从一份原始日志里找出「可重试的、被应用中断的」回合。
 *
 * 两种形态都认：
 * 1. **没有 `turn/end`**：进程在写 `turn/end` 之前就被杀掉（硬关机/断电）；
 * 2. **`turn/end` 的 reason 是 `interrupted` 或 `aborted+disposed`**：DSH 重启重放时
 *    会给被中断的回合补一个结束事件（实测形态见 `isAppInterruption`）。
 *
 * @param {any[] | undefined} events - `sessionQuery.readSession()` 的 events。
 * @returns {{ turn: number, cause: 'app' } | undefined} 可重试的回合；没有则 undefined。
 */
export function pendingTurnOf(events) {
  if (!Array.isArray(events)) return undefined;
  /** @type {Map<number, any>} */
  const startAt = new Map();
  /** @type {Map<number, { at: number, reason: any }>} */
  const endAt = new Map();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const turn = typeof event?.data?.turn === 'number' ? event.data.turn : undefined;
    if (turn === undefined) continue;
    if (event.type === 'turn/start') startAt.set(turn, index);
    else if (event.type === 'turn/end') endAt.set(turn, { at: index, reason: event.data?.reason });
  }
  let candidate;
  for (const [turn, startedAt] of startAt) {
    const ended = endAt.get(turn);
    if (ended === undefined) {
      // 形态 1：完全没结束（且它必须是最后一轮，避免把陈年残局都算上）。
      if (candidate === undefined || startedAt > candidate.startedAt) {
        candidate = { turn, startedAt, cause: 'app' };
      }
      continue;
    }
    if (isAppInterruption(ended.reason)) {
      if (candidate === undefined || ended.at > candidate.startedAt) {
        candidate = { turn, startedAt: ended.at, cause: 'app' };
      }
    }
  }
  return candidate === undefined ? undefined : { turn: candidate.turn, cause: candidate.cause };
}

/** 启动扫描的时间窗：只看最近 72 小时内更新过的会话。 */
export const STARTUP_SCAN_LOOKBACK_MS = 72 * 60 * 60 * 1000;

/** 启动扫描最多读多少个会话日志（语料库很大时不拖慢启动）。 */
export const STARTUP_SCAN_MAX_SESSIONS = 60;

/**
 * 取 `sessionQuery` 服务（两种访问形态都兼容）。
 *
 * @param {any} ctx - 插件上下文。
 * @returns {any} 服务或 undefined。
 */
function sessionQueryOf(ctx) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined;
    if (service !== undefined && service !== null) return service;
  } catch {
    // 某些最小部署上 ctx.get 会抛。
  }
  return ctx?.sessionQuery;
}

/**
 * 启动时扫描「被应用关闭/重启打断」的会话，补记可重试记录。
 *
 * 认两种形态（见 {@link pendingTurnOf}）：最后一轮没有 `turn/end`，或它的
 * `turn/end` 是 `interrupted` / `aborted+disposed`。
 *
 * 只处理最近 {@link STARTUP_SCAN_LOOKBACK_MS} 内更新过、且最后一轮没有闭合的会话，
 * 最多读 {@link STARTUP_SCAN_MAX_SESSIONS} 份日志；任何单份日志读失败都跳过（不影响其它会话）。
 *
 * @param {{ sessionQuery?: any, recovery: import('./recovery.mjs').RecoveryStore, now?: number, lookbackMs?: number, maxSessions?: number }} options - 依赖。
 * @returns {Promise<{ scanned: number, seeded: Array<{ sessionId: string, turn: number }> }>} 结果（诊断用）。
 */
export async function scanUnfinishedTurns(options) {
  const sessionQuery = options?.sessionQuery;
  const recovery = options?.recovery;
  const empty = { scanned: 0, seeded: [] };
  if (recovery === undefined || recovery === null) return empty;
  if (typeof sessionQuery?.listSessions !== 'function' || typeof sessionQuery?.readSession !== 'function') return empty;

  const now = Number.isFinite(options?.now) ? options.now : Date.now();
  const lookbackMs = Number.isFinite(options?.lookbackMs) && options.lookbackMs > 0
    ? options.lookbackMs
    : STARTUP_SCAN_LOOKBACK_MS;
  const maxSessions = Number.isFinite(options?.maxSessions) && options.maxSessions > 0
    ? Math.trunc(options.maxSessions)
    : STARTUP_SCAN_MAX_SESSIONS;

  /** @type {any[]} */
  let records;
  try {
    records = await sessionQuery.listSessions();
  } catch {
    return empty;
  }
  if (!Array.isArray(records)) return empty;

  /** 取记录的更新时间（不同版本字段名不同，逐个兜底）。 */
  const updatedAtOf = (record) => {
    const candidates = [
      record?.header?.updatedAt,
      record?.header?.mtimeMs,
      record?.header?.createdAt,
      record?.updatedAt,
      record?.mtimeMs,
    ];
    for (const value of candidates) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value !== '') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return undefined;
  };

  const candidates = [];
  for (const record of records) {
    const sessionId = typeof record?.header?.id === 'string' ? record.header.id : '';
    if (sessionId === '') continue;
    const updatedAt = updatedAtOf(record);
    if (updatedAt !== undefined && now - updatedAt > lookbackMs) continue;
    candidates.push({ sessionId, updatedAt: updatedAt ?? 0 });
  }
  candidates.sort((left, right) => right.updatedAt - left.updatedAt);

  const seeded = [];
  let scanned = 0;
  for (const candidate of candidates.slice(0, maxSessions)) {
    let snapshot;
    try {
      snapshot = await sessionQuery.readSession(candidate.sessionId);
    } catch {
      continue; // 单份日志损坏/读失败不影响其它会话。
    }
    scanned += 1;
    const pending = pendingTurnOf(snapshot?.events);
    if (pending === undefined) continue;
    // 已有记录（例如同一进程内刚被用户停下）不覆盖：让最早那条的 cause/时间保留。
    if (recovery.peek(candidate.sessionId) !== undefined) continue;
    recovery.remember(candidate.sessionId, { turn: pending.turn, cause: pending.cause });
    seeded.push({ sessionId: candidate.sessionId, turn: pending.turn });
  }
  return { scanned, seeded };
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
 *    `agent.followup(createRetryUserMessage(cause))`：这一轮已经结束，`{ kind: 'retry' }` 会被
 *    loop 的 `signal.throwIfAborted()` 立刻抛出；`followup` 是 Agent 上唯一"排一条 user
 *    消息并唤醒驱动器"的入口。代价是历史里多一条中性提示词消息。
 *    **文案按中断原因区分**（见 {@link continueTextOf}）：谷峰暂停必须写明「高峰暂停、不是失败」。
 *    顺序对所有 cause 一致：**先官方、再带原因的兜底消息**。
 * 3. 两条都失败才返回错误（保持原有 `code`/`message` 结构，补 `method`/`reason`）。
 *
 * @param {any} ctx - 插件上下文。
 * @returns {(sessionId: string, cause?: 'user'|'app'|'offpeak') => Promise<{ ok: boolean, method?: 'official' | 'prompt' | null, code?: string, message?: string, reason?: string }>} 驱动函数。
 */
export function createDriveRetry(ctx) {
  return async function driveRetry(sessionId, cause) {
    // 1) 官方 continuation 优先（**所有中断原因都一样**，含谷峰「高峰暂停」）。
    //    官方成功时历史里是紧凑的「已请求继续生成」，不带原因说明；
    //    官方不可用（没有服务 / session/agent-busy / 不是可继续的失败轮）才回退到
    //    「带原因的中性提示词消息」——那时才用 cause 决定文案。
    if (await tryOfficialContinuation(ctx, sessionId)) {
      return { ok: true, method: 'official' };
    }

    // 2) 回退：agent.followup 排一条中性提示词消息（文案按 cause 区分）。
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
      await agent.followup(createRetryUserMessage(cause));
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

  /**
   * 启动扫描：补记「被应用关闭/重启」打断的轮次（这种中断没有 `turn/end`）。
   *
   * `sessionQuery` 可能在本插件激活后才就位，所以用 `ctx.inject` 等服务；扫描本身
   * 完全异步，失败/超时都不影响组件其它功能。
   */
  const runStartupScan = async (query) => {
    try {
      const result = await scanUnfinishedTurns({ sessionQuery: query, recovery });
      if (result.seeded.length > 0) {
        ctx.logger?.info?.(
          `dsh-session-enhance/retry: 发现 ${result.seeded.length} 个被应用关闭打断的回合，可在对应会话点「重试」继续。`,
        );
      }
    } catch (error) {
      ctx.logger?.debug?.(
        `dsh-session-enhance/retry: 启动扫描失败（忽略）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sessionQuery'], (scoped) => {
        void runStartupScan(sessionQueryOf(scoped));
      });
    } else {
      void runStartupScan(sessionQueryOf(ctx));
    }
  } catch {
    // 服务注入失败（最小部署）时不做扫描，组件其余能力照常。
  }

  // 卸载时清空记录（组件随时可被单独停用）。
  ctx.effect?.(() => () => {
    recovery.clear();
  }, 'dsh-session-enhance: interrupted retry recovery');

  ctx.logger?.debug?.(
    `dsh-session-enhance/retry: installed (build=${BUILD}, ttlMs=${DEFAULT_RECOVERY_TTL_MS})`,
  );
}
