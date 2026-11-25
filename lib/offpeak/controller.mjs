/**
 * 「谷峰会话」的 Host 控制核：相位计时器 + hold 控制器 + 每会话状态。
 *
 * ## 它要保证的一件事
 *
 * **峰时里，已启用会话的 Agent 一次模型请求都不能开始**；用户在这期间发出的提示留在
 * durable inbox 里，谷时一到自动续跑。次日的峰时再暂停、再释放，如此往复。
 *
 * ## 怎么做到（三层，缺一不可）
 *
 * 1. **maintenance hold（主手段）**：Agent 空闲时 `runMaintenance(async (signal) => gate)`
 *    把 Agent 钉在 maintenance 相位——公开 `status` 仍是 `idle`，但 `wakeDriver` 只会把
 *    "来新提示了"记成 `wakeRequested`，不会开轮次。释放 gate 时，`runMaintenance` 自己的
 *    `finally` 会在 `wakeRequested && inbox.hasPending` 时自动唤醒，排队提示立刻续跑。
 * 2. **`agent/status: running` 同步 cancel（安全网）**：万一有绕过 hold 的入口
 *    （创建时首条提示、外部 followup …），在 `status` 刚变 `running`、**还没 append
 *    `turn/start`** 的那一刻 `cancel({kind:'hook', reason:'offpeak-pause'}, {keepInbox:true})`：
 *    轮次被 abort 在开轮之前，提示留在 inbox，没有 `turn/*` 事件、没有模型调用。
 * 3. **1 秒 reconcile**：只在「峰时且至少一个会话启用」时跑，兜住漏事件（订阅失败、
 *    Agent 被外部 cancel 打断 hold、创建期不支持 arm 等）。
 *
 * ## 为什么事件回调里不能抛错
 *
 * `agent/created` 是 **serial** 派发：监听器抛错会让 Agent 创建失败。
 * `agent/status` 是 **emit**：抛错会打断驱动。所以这里每个监听的入口都 try/catch，
 * 只记 debug/warn，绝不让异常冒出去。
 *
 * ## 重入
 *
 * 在 `running` 回调里 `cancel()` 会（经微任务）触发 `agent/status: idle`，它又会来 arm
 * hold。所有"顺手做一次"的动作都走 `scheduleReconcile()`（`setTimeout(0)`）而不是同步
 * 递归；`reconcile()` 自己用 `reconciling` 标志防重入，arm 前先查 holds 表。
 *
 * ## 依赖全部注入
 *
 * `getAgents` / `now` / `setTimer` / `clearTimer` / `defer` / `readSchedule` / `store` /
 * `logger` / `uuid` 都是参数：于是这只控制器不需要真实 Cordis、真实 Agent 或真实时钟
 * 就能离线测清楚（`test/offpeak-controller.test.mjs`）。
 *
 * @module dsh-session-enhance/lib/offpeak/controller
 */

import { randomUUID } from 'node:crypto';

import { isOffPeakAt, nextBoundary, normalizeSchedule } from './window.mjs';

/** 峰时暂停时给 Agent 的取消原因（`hook` 是封闭 union 里唯一带自由字符串的成员）。 */
export const OFFPEAK_CANCEL_REASON = 'offpeak-pause';

/** resume 时注入的"中性继续"消息 id 前缀（便于在会话历史里认出是本组件注入的）。 */
export const OFFPEAK_MESSAGE_ID_PREFIX = 'dsh-session-enhance-offpeak-';

/** 峰时 + 有启用会话时的 reconcile 间隔。 */
export const RECONCILE_INTERVAL_MS = 1_000;

/** 同一个 Agent 的 arm 失败日志最小间隔（避免刷屏）。 */
export const ARM_FAILURE_LOG_INTERVAL_MS = 10_000;

/** `setTimeout` 的最大安全值（超过会被 Node 当作 1ms）。 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** 读不到配置时的兜底：默认窗口 + 默认关闭暂停。 */
const FALLBACK_SCHEDULE = normalizeSchedule({});

/**
 * 构造「已请求继续生成」用的中性 user 消息。
 *
 * 这是官方 continuation 触发消息的形状：`content: []` + `source.kind === 'retry'`，
 * 渲染层把它显示成紧凑的「已请求继续生成」而不是一条空消息。它只在"排队提示被提前
 * cancel 掉、`wakeRequested` 没被置位"时使用——没有这条消息，inbox 里的提示会一直
 * 躺着到下一次真实输入。
 *
 * @param {() => string} [uuid] - id 生成器（单测注入固定值）。
 * @returns {{ id: string, role: 'user', content: [], source: { kind: 'retry', rpcId: string } }} user 消息。
 */
export function createEmptyContinueMessage(uuid = () => randomUUID()) {
  const id = `${OFFPEAK_MESSAGE_ID_PREFIX}${uuid()}`;
  return { id, role: 'user', content: [], source: { kind: 'retry', rpcId: id } };
}

/**
 * 把任意异常收成一行字符串（日志与诊断用，绝不再抛）。
 *
 * @param {unknown} error - 捕获到的异常。
 * @returns {string} 说明。
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 等待 hold 释放：`gate` resolve 或 `signal` abort 都算结束。
 *
 * **永远 resolve、永不 reject**：外部 `agent.cancel()` 会 abort maintenance 的 signal，
 * 如果这里 reject，`runMaintenance` 返回的 promise 会 reject，而那个 promise 的
 * `finally` 已经把相位切回 idle——拒绝只会变成一条 unhandled rejection。
 *
 * @param {Promise<unknown>} gate - 释放信号。
 * @param {AbortSignal | undefined} signal - maintenance 的 signal。
 * @returns {Promise<void>} 结束即 resolve。
 */
function waitForRelease(gate, signal) {
  if (signal !== undefined && signal !== null && signal.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        signal?.removeEventListener?.('abort', finish);
      } catch {
        // 移除监听失败不影响 resolve。
      }
      resolve();
    };
    try {
      signal?.addEventListener?.('abort', finish, { once: true });
    } catch {
      // 某些 AbortSignal polyfill 不接受 options；退化成不带 options 的注册。
      try {
        signal?.addEventListener?.('abort', finish);
      } catch {
        // 注册不上就只能靠 gate。
      }
    }
    gate.then(finish, finish);
  });
}

/**
 * 创建谷峰控制器。
 *
 * @param {object} options - 依赖（全部注入，便于离线单测）。
 * @param {() => any} options.getAgents - 取 `agents` 服务（可能返回 undefined）。
 * @param {any} options.store - 每会话启用状态存储（`./store.mjs`）。
 * @param {() => { window: any, defaultEnabled: boolean, issues?: string[] }} options.readSchedule - 读归一化后的当前配置。
 * @param {any} [options.logger] - 日志（debug/warn/info）。
 * @param {string} [options.build] - 构建戳（透传给 RPC）。
 * @param {() => number} [options.now] - 时钟。
 * @param {(fn: () => void, ms: number) => any} [options.setTimer] - 定时器（默认 setTimeout + unref）。
 * @param {(handle: any) => void} [options.clearTimer] - 清定时器。
 * @param {(fn: () => void) => any} [options.defer] - 下一个宏任务（默认 setTimeout 0 + unref）。
 * @param {() => string} [options.uuid] - id 生成器。
 * @returns {any} 控制器。
 */
export function createOffpeakController(options = {}) {
  const getAgents = typeof options.getAgents === 'function' ? options.getAgents : () => undefined;
  const store = options.store;
  const readSchedule = typeof options.readSchedule === 'function' ? options.readSchedule : () => FALLBACK_SCHEDULE;
  const logger = options.logger;
  const build = typeof options.build === 'string' ? options.build : '';
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setTimer =
    typeof options.setTimer === 'function'
      ? options.setTimer
      : (fn, ms) => {
          const handle = setTimeout(fn, ms);
          handle?.unref?.();
          return handle;
        };
  const clearTimer =
    typeof options.clearTimer === 'function'
      ? options.clearTimer
      : (handle) => {
          if (handle !== null && handle !== undefined) clearTimeout(handle);
        };
  const defer =
    typeof options.defer === 'function'
      ? options.defer
      : (fn) => {
          const handle = setTimeout(fn, 0);
          handle?.unref?.();
          return handle;
        };
  const uuid = typeof options.uuid === 'function' ? options.uuid : () => randomUUID();

  /** sessionId → hold 记录。 */
  const holds = new Map();
  /** 被暂停打断了一个已开始的回合、等释放后续跑的会话。 */
  const interrupted = new Set();
  /** 已经排了"释放后续跑"的会话（`releaseHold` 与谷时兜底可能同时触发，去重）。 */
  const wakeScheduled = new Set();
  /** sessionId → 上一次 arm 失败日志时间（限流）。 */
  const armFailureAt = new Map();

  let disposed = false;
  let reconciling = false;
  let reconcileScheduled = false;
  let boundaryTimer = null;
  /** 已排定的边界标识（时区|起点|终点|绝对时刻|方向）；相同则不重建定时器。 */
  let boundarySpec = null;
  let tickTimer = null;
  let tickToken = 0;

  /**
   * 安全写日志（logger 本身坏了也不能抛）。
   *
   * @param {'debug' | 'info' | 'warn'} level - 级别。
   * @param {string} message - 内容。
   * @returns {void}
   */
  function log(level, message) {
    try {
      logger?.[level]?.(message);
    } catch {
      // 日志失败与业务无关。
    }
  }

  /**
   * 取 agents 服务（缺失/异常时 undefined）。
   *
   * @returns {any} 服务或 undefined。
   */
  function agentsService() {
    try {
      const service = getAgents();
      return service === undefined || service === null ? undefined : service;
    } catch (error) {
      log('debug', `[dsh-session-enhance/offpeak] agents service unavailable: ${describeError(error)}`);
      return undefined;
    }
  }

  /**
   * 从 Agent 上取会话 id（`agent.id`，退化到 `agent.session.id`）。
   *
   * @param {any} agent - Agent。
   * @returns {string | undefined} 会话 id。
   */
  function sessionIdOf(agent) {
    try {
      const id = agent?.id ?? agent?.session?.id;
      return typeof id === 'string' && id !== '' ? id : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 全部 live Agent（服务缺失/异常时空数组）。
   *
   * @returns {any[]} Agent 列表。
   */
  function listAgents() {
    const service = agentsService();
    if (service === undefined) return [];
    try {
      const list = typeof service.list === 'function' ? service.list() : [];
      return Array.isArray(list) ? list.filter((agent) => agent !== null && typeof agent === 'object') : [];
    } catch (error) {
      log('debug', `[dsh-session-enhance/offpeak] agents.list failed: ${describeError(error)}`);
      return [];
    }
  }

  /**
   * 按会话 id 取 live Agent（`get` 不可用时退回扫描 list）。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {any} Agent 或 undefined。
   */
  function agentOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    const service = agentsService();
    if (service !== undefined && typeof service.get === 'function') {
      try {
        const agent = service.get(sessionId);
        if (agent !== undefined && agent !== null) return agent;
      } catch (error) {
        log('debug', `[dsh-session-enhance/offpeak] agents.get failed: ${describeError(error)}`);
      }
    }
    return listAgents().find((agent) => sessionIdOf(agent) === sessionId);
  }

  /**
   * 读 Agent 的公开状态（读不到时 undefined）。
   *
   * @param {any} agent - Agent。
   * @returns {'idle' | 'running' | undefined} 状态。
   */
  function statusOf(agent) {
    if (agent === undefined || agent === null) return undefined;
    try {
      const status = agent.status;
      return status === 'idle' || status === 'running' ? status : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 排队中的提示条数（`nextTurn.length + nextStep.length`）。
   *
   * @param {any} agent - Agent。
   * @returns {number} 条数。
   */
  function queuedOf(agent) {
    if (agent === undefined || agent === null) return 0;
    try {
      const inbox = agent.inbox;
      const nextTurn = Array.isArray(inbox?.nextTurn) ? inbox.nextTurn.length : 0;
      const nextStep = Array.isArray(inbox?.nextStep) ? inbox.nextStep.length : 0;
      return nextTurn + nextStep;
    } catch {
      return 0;
    }
  }

  /**
   * 当前打开的回合起点 seq（null 表示没有进行中的回合）。
   *
   * 取不到（老版本没有 `turnBoundaryOf`、会话已 dispose）时按 null 处理：宁可**不**标
   * interrupted（少发一条继续消息），也不要凭空发一条。
   *
   * @param {any} agent - Agent。
   * @returns {number | null} `openTurnStartSeq`。
   */
  function openTurnStartSeq(agent) {
    if (agent === undefined || agent === null) return null;
    const service = agentsService();
    if (service === undefined || typeof service.turnBoundaryOf !== 'function') return null;
    try {
      const boundary = service.turnBoundaryOf(agent.session);
      const seq = boundary?.openTurnStartSeq;
      return typeof seq === 'number' && Number.isFinite(seq) ? seq : null;
    } catch (error) {
      log('debug', `[dsh-session-enhance/offpeak] turnBoundaryOf failed: ${describeError(error)}`);
      return null;
    }
  }

  /**
   * 读当前配置（异常时回退默认，绝不让一次配置读取失败暂停整个组件）。
   *
   * @returns {{ window: any, defaultEnabled: boolean, issues: string[] }} 归一化配置。
   */
  function schedule() {
    try {
      const value = readSchedule();
      if (value !== null && typeof value === 'object' && value.window !== null && typeof value.window === 'object') {
        return {
          window: value.window,
          defaultEnabled: value.defaultEnabled === true,
          issues: Array.isArray(value.issues) ? value.issues : [],
        };
      }
    } catch (error) {
      log('warn', `[dsh-session-enhance/offpeak] readSchedule failed, using defaults: ${describeError(error)}`);
    }
    return FALLBACK_SCHEDULE;
  }

  /**
   * 当前是不是峰时（峰时 = 不在谷时窗口里）。
   *
   * 计算失败时返回 false（不暂停）——宁可少暂停，也不要因为一次时区/配置异常把所有
   * 会话锁死。
   *
   * @param {{ window: any }} sched - 归一化配置。
   * @returns {boolean} 峰时则 true。
   */
  function isPeak(sched) {
    try {
      return !isOffPeakAt(now(), sched.window);
    } catch (error) {
      log('debug', `[dsh-session-enhance/offpeak] phase evaluation failed: ${describeError(error)}`);
      return false;
    }
  }

  /**
   * 某 Agent 的父会话 id（子代理会话的 `session.header.parentSession`）。
   *
   * 普通 fork 没有这个字段；`origin === 'subagent'` 才是子代理，但这里不做分类——
   * 只要链上有父会话就沿链向上看（父会话自己的开关就是最自然的"覆盖"语义）。
   *
   * @param {any} agent - Agent。
   * @returns {string | undefined} 父会话 id。
   */
  function parentSessionIdOf(agent) {
    try {
      const id = agent?.session?.header?.parentSession;
      return typeof id === 'string' && id !== '' ? id : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 某会话是否启用（无显式记录时回落 `defaultEnabled`）。
   *
   * @param {string} sessionId - 会话 id。
   * @param {{ defaultEnabled: boolean }} sched - 归一化配置。
   * @returns {boolean} 是否启用。
   */
  function enabledOf(sessionId, sched) {
    try {
      return store?.isEnabled?.(sessionId, sched.defaultEnabled === true) === true;
    } catch (error) {
      log('debug', `[dsh-session-enhance/offpeak] store read failed: ${describeError(error)}`);
      return sched.defaultEnabled === true;
    }
  }

  /**
   * 某 Agent 是否被"谷峰调度"覆盖。
   *
   * 覆盖语义 = **这个会话里一切涉及 AI 调用的操作都要按谷峰走**，所以不能只看本会话
   * 自己的开关：启用父会话后，它派出的子代理（`session.header.parentSession` 指向父会话）
   * 在峰时也必须一起暂停——否则用户开了开关，子代理照样在峰时烧额度。
   *
   * 判定顺序：
   * 1. 本会话被启用 → 覆盖；
   * 2. 否则沿 `parentSession` 向上，任一级**live Agent** 的会话被启用 → 覆盖；
   * 3. 链上取不到 live Agent 就停（父会话已关闭/未加载，无法继续判定）。
   *
   * @param {any} agent - Agent。
   * @param {{ defaultEnabled: boolean }} sched - 归一化配置。
   * @returns {boolean} 是否被覆盖。
   */
  function coveredOf(agent, sched) {
    const sessionId = sessionIdOf(agent);
    if (sessionId === undefined) return false;
    if (enabledOf(sessionId, sched)) return true;

    /** @type {Set<string>} */
    const seen = new Set([sessionId]);
    let parentAgent = agent;
    let parentId = parentSessionIdOf(agent);
    while (parentId !== undefined && !seen.has(parentId)) {
      seen.add(parentId);
      const nextAgent = agentOf(parentId);
      if (nextAgent === undefined) return false; // 父会话没有 live Agent：链到此为止
      if (enabledOf(parentId, sched)) return true;
      parentAgent = nextAgent;
      parentId = parentSessionIdOf(parentAgent);
    }
    return false;
  }

  /**
   * 某会话启用状态的来源。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {'session' | 'default'} 来源。
   */
  function enabledSourceOf(sessionId) {
    try {
      return store?.sourceOf?.(sessionId) === 'session' ? 'session' : 'default';
    } catch {
      return 'default';
    }
  }

  /**
   * 读存储错误（用于 `persisted` 与 `diag.storeError`）。
   *
   * @returns {Error | null} 错误或 null。
   */
  function storeError() {
    try {
      const error = typeof store?.error === 'function' ? store.error() : null;
      return error ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 记录一次 arm 失败（同一 Agent 每 10 秒最多一条 debug 日志）。
   *
   * @param {string} sessionId - 会话 id。
   * @param {unknown} error - 失败原因。
   * @returns {void}
   */
  function noteArmFailure(sessionId, error) {
    const at = now();
    const last = armFailureAt.get(sessionId);
    if (last !== undefined && at - last < ARM_FAILURE_LOG_INTERVAL_MS) return;
    armFailureAt.set(sessionId, at);
    log('debug', `[dsh-session-enhance/offpeak] hold arm failed for ${sessionId}: ${describeError(error)}`);
    if (armFailureAt.size > 200) {
      for (const [key, loggedAt] of armFailureAt) {
        if (at - loggedAt > ARM_FAILURE_LOG_INTERVAL_MS) armFailureAt.delete(key);
      }
    }
  }

  /**
   * 在 Agent 上挂一个 maintenance hold。
   *
   * @param {any} agent - 目标 Agent。
   * @returns {boolean} 是否成功挂上。
   */
  function armHold(agent) {
    const sessionId = sessionIdOf(agent);
    if (sessionId === undefined || disposed) return false;

    const existing = holds.get(sessionId);
    if (existing !== undefined) {
      if (existing.agent === agent) return true;
      // 同 id 换了 Agent 实例：先释放旧的，避免留下一个永远不 resolve 的 gate。
      releaseHold(sessionId, { reason: 'replaced', wake: false });
    }

    /** @type {any} */
    const record = { sessionId, agent, armedAt: now(), released: false, releaseReason: null, releaseGate: null };
    const gate = new Promise((resolve) => {
      record.releaseGate = resolve;
    });
    record.release = (reason) => {
      if (record.released) return;
      record.released = true;
      record.releaseReason = reason;
      if (holds.get(sessionId) === record) holds.delete(sessionId);
      record.releaseGate();
    };
    holds.set(sessionId, record);

    let task;
    try {
      if (typeof agent.runMaintenance !== 'function') {
        holds.delete(sessionId);
        noteArmFailure(sessionId, new Error('agent.runMaintenance is unavailable in this build'));
        return false;
      }
      task = agent.runMaintenance(async (signal) => {
        await waitForRelease(gate, signal);
      });
    } catch (error) {
      // 典型：agent/created 派发还在 creation 自己的 runMaintenance 里 → "already has active work"。
      holds.delete(sessionId);
      noteArmFailure(sessionId, error);
      return false;
    }

    record.task = task;
    Promise.resolve(task).then(
      () => {
        onHoldSettled(sessionId, record);
      },
      (error) => {
        onHoldSettled(sessionId, record, error);
      },
    );
    return true;
  }

  /**
   * hold 结束（释放或被外部打断）后的收尾：若仍该暂停，下一个宏任务重新 arm。
   *
   * @param {string} sessionId - 会话 id。
   * @param {any} record - hold 记录。
   * @param {unknown} [error] - 结束时的异常（若有）。
   * @returns {void}
   */
  function onHoldSettled(sessionId, record, error) {
    if (holds.get(sessionId) === record) holds.delete(sessionId);
    if (error !== undefined) {
      log('debug', `[dsh-session-enhance/offpeak] hold for ${sessionId} ended with error: ${describeError(error)}`);
    }
    if (disposed) return;
    // 被外部 cancel 打断、或创建期 arm 失败：下个宏任务由 reconcile 决定是否重新 arm。
    scheduleReconcile();
  }

  /**
   * 暂停一个正在跑的 Agent：abort 当前回合（保留 inbox），并把"已开始回合被打断"记下来。
   *
   * 调用点在 `agent/status: running` 的监听里时回合还没 append `turn/start`，
   * `openTurnStartSeq` 是 null → 不会误标 interrupted。
   *
   * @param {any} agent - 目标 Agent。
   * @returns {boolean} 是否发出了 cancel。
   */
  function pauseAgent(agent) {
    const sessionId = sessionIdOf(agent);
    if (sessionId === undefined) return false;
    if (typeof agent?.cancel !== 'function') return false;
    try {
      if (openTurnStartSeq(agent) !== null) interrupted.add(sessionId);
      // `hook` 是 AgentCancelCause 封闭 union 里唯一带自由字符串的成员；
      // 自定义 kind 会走 assertNever 并在 finally 里把 turn/end 写成 null（2026-11-20 事故）。
      agent.cancel({ kind: 'hook', reason: OFFPEAK_CANCEL_REASON }, { keepInbox: true });
      return true;
    } catch (error) {
      log('debug', `[dsh-session-enhance/offpeak] cancel for ${sessionId} failed: ${describeError(error)}`);
      return false;
    }
  }

  /**
   * 确保一个 Agent 处于 hold 状态（幂等）。
   *
   * @param {any} agent - 目标 Agent。
   * @returns {boolean} 是否处于 hold。
   */
  function ensureHeld(agent) {
    const sessionId = sessionIdOf(agent);
    if (sessionId === undefined) return false;
    const existing = holds.get(sessionId);
    if (existing !== undefined && existing.agent === agent) return true;
    if (existing !== undefined) releaseHold(sessionId, { reason: 'replaced', wake: false });
    const status = statusOf(agent);
    if (status === 'running') {
      // 安全网：同步 cancel，轮次还没开起来就被 abort。
      pauseAgent(agent);
      return false;
    }
    if (status !== 'idle') return false;
    return armHold(agent);
  }

  /**
   * 释放一个 hold（幂等）。释放后按需要唤醒被压住的排队提示。
   *
   * @param {string} sessionId - 会话 id。
   * @param {{ reason?: string, wake?: boolean }} [releaseOptions] - 释放原因与是否尝试续跑。
   * @returns {any} 被释放的 hold 记录（没有则 undefined）。
   */
  function releaseHold(sessionId, releaseOptions = {}) {
    const record = holds.get(sessionId);
    if (record === undefined) return undefined;
    record.release(releaseOptions.reason ?? 'release');
    if (releaseOptions.wake !== false) scheduleWake(sessionId, record);
    return record;
  }

  /**
   * 排一次"释放后续跑"（按会话去重）。
   *
   * `releaseHold` 与 reconcile 的谷时兜底可能对同一会话各排一次（一个来自 hold 释放、
   * 一个来自 interrupted 标记），不去重就会给同一个会话发两条「已请求继续生成」。
   *
   * @param {string} sessionId - 会话 id。
   * @param {any} record - 触发本次唤醒的 hold 记录（可省略）。
   * @returns {void}
   */
  function scheduleWake(sessionId, record) {
    if (disposed || wakeScheduled.has(sessionId)) return;
    wakeScheduled.add(sessionId);
    defer(() => {
      wakeScheduled.delete(sessionId);
      if (disposed) return;
      try {
        wakeAfterRelease(sessionId, record);
      } catch (error) {
        log('warn', `[dsh-session-enhance/offpeak] resume-wake failed for ${sessionId}: ${describeError(error)}`);
      }
    });
  }

  /**
   * 释放后的续跑判定。
   *
   * 两种需要主动唤醒的情况：
   *
   * 1. 排队提示还在、但 maintenance 的 `wakeRequested` 没置位（提示在 hold 挂上之前就被
   *    cancel 掉了）——不补一条继续消息，它会一直躺着；
   * 2. 峰时打断了一个已开始的回合（`interrupted`），释放时要让模型从中断处继续。
   *
   * 若释放时 Agent 已经被 `runMaintenance` 的自动唤醒拉起来（status 不是 idle），什么都不做。
   *
   * @param {string} sessionId - 会话 id。
   * @param {any} record - 刚释放的 hold 记录。
   * @returns {void}
   */
  function wakeAfterRelease(sessionId, record) {
    if (disposed) return;
    const agent = agentOf(sessionId);
    if (agent === undefined) {
      interrupted.delete(sessionId);
      return;
    }
    if (statusOf(agent) !== 'idle') {
      // 已经被自动唤醒（或正在被安全网 cancel）：不需要额外消息。
      interrupted.delete(sessionId);
      return;
    }
    const queued = queuedOf(agent);
    const wasInterrupted = interrupted.delete(sessionId);
    if (queued === 0 && wasInterrupted !== true) return;
    if (typeof agent.followup !== 'function') return;
    try {
      agent.followup(createEmptyContinueMessage(uuid));
      log(
        'info',
        `[dsh-session-enhance/offpeak] resumed ${sessionId} (queued=${queued}, interrupted=${wasInterrupted === true}, reason=${record?.releaseReason ?? 'release'})`,
      );
    } catch (error) {
      log('warn', `[dsh-session-enhance/offpeak] followup for ${sessionId} failed: ${describeError(error)}`);
    }
  }

  /**
   * 安排一次"下一个宏任务"的 reconcile（自动去重）。
   *
   * @returns {void}
   */
  function scheduleReconcile() {
    if (disposed || reconcileScheduled) return;
    reconcileScheduled = true;
    defer(() => {
      reconcileScheduled = false;
      if (disposed) return;
      try {
        reconcile();
      } catch (error) {
        log('warn', `[dsh-session-enhance/offpeak] deferred reconcile failed: ${describeError(error)}`);
      }
    });
  }

  /**
   * 开/关 1 秒轮询（只在峰时且有启用会话时开）。
   *
   * @param {boolean} active - 是否需要轮询。
   * @returns {void}
   */
  function setTicking(active) {
    if (disposed) return;
    if (!active) {
      tickToken += 1;
      clearTimer(tickTimer);
      tickTimer = null;
      return;
    }
    if (tickTimer !== null) return;
    const token = ++tickToken;
    tickTimer = setTimer(() => {
      if (disposed || token !== tickToken) return;
      tickTimer = null;
      try {
        reconcile();
      } catch (error) {
        log('warn', `[dsh-session-enhance/offpeak] tick reconcile failed: ${describeError(error)}`);
      }
    }, RECONCILE_INTERVAL_MS);
  }

  /**
   * 重排"下一次相位切换"的边界定时器。
   *
   * 用精确 `setTimeout` 到边界 + reconcile 时重排，而不是靠 1 秒轮询去"发现"边界：
   * 轮询只在暂停期开，而谷时释放必须准时（用户等了 8 小时，不该再多等一拍）。
   *
   * **已经排的是同一条边界就不重建**：reconcile 每秒都会跑一次，无条件 clear+set
   * 会让一个"8 小时后触发"的定时器每秒重建一次（无意义抖动，也让 timer 句柄一直换）。
   *
   * @param {{ window: any }} sched - 归一化配置。
   * @returns {void}
   */
  function rescheduleBoundaryTimer(sched) {
    if (disposed) return;
    let boundary;
    try {
      boundary = nextBoundary(now(), sched.window);
    } catch (error) {
      log('debug', `[dsh-session-enhance/offpeak] boundary timer failed: ${describeError(error)}`);
      return;
    }
    if (boundary === null || !Number.isFinite(boundary.at)) return;
    const spec = `${sched.window.timeZone}|${sched.window.start}|${sched.window.end}|${boundary.at}|${boundary.kind}`;
    if (boundaryTimer !== null && boundarySpec === spec) return;
    clearTimer(boundaryTimer);
    boundaryTimer = null;
    boundarySpec = spec;
    const delay = Math.max(0, Math.min(boundary.at - now(), MAX_TIMER_DELAY_MS));
    boundaryTimer = setTimer(() => {
      boundaryTimer = null;
      boundarySpec = null;
      if (disposed) return;
      log('info', `[dsh-session-enhance/offpeak] boundary reached (${boundary.kind}), reconciling`);
      refresh();
    }, delay);
  }

  /**
   * 一次全量对账：释放不该 hold 的、hold 该 hold 的、重排定时器。
   *
   * @returns {void}
   */
  function reconcile() {
    if (disposed) return;
    if (reconciling) {
      reconcileScheduled = true;
      return;
    }
    reconciling = true;
    try {
      const sched = schedule();
      const peak = isPeak(sched);
      const agents = listAgents();
      /** @type {Set<string>} */
      const liveIds = new Set();

      for (const agent of agents) {
        const sessionId = sessionIdOf(agent);
        if (sessionId === undefined) continue;
        liveIds.add(sessionId);
        // 覆盖 = 本会话启用，或它的任一祖先会话（子代理的父会话）启用。
        const covered = coveredOf(agent, sched);
        if (!peak || !covered) {
          if (holds.has(sessionId)) {
            releaseHold(sessionId, { reason: !peak ? 'off-peak' : 'uncovered', wake: true });
          }
          continue;
        }
        ensureHeld(agent);
      }

      // Agent 已消失：释放 hold（不唤醒）并清掉标记。
      for (const sessionId of [...holds.keys()]) {
        if (!liveIds.has(sessionId)) releaseHold(sessionId, { reason: 'agent-gone', wake: false });
      }
      for (const sessionId of [...interrupted]) {
        if (!liveIds.has(sessionId)) interrupted.delete(sessionId);
      }
      for (const sessionId of [...armFailureAt.keys()]) {
        if (!liveIds.has(sessionId)) armFailureAt.delete(sessionId);
      }

      // 谷时兜底：有些会话是「跑着的时候被暂停打断」的——它当时不是 hold 状态，
      // 因此没有 releaseHold 去触发续跑。相位翻回谷时时必须把它们唤醒一次，
      // 否则那一轮就永远停在"被中断"上了。
      if (!peak) {
        for (const sessionId of [...interrupted]) {
          const agent = agentOf(sessionId);
          if (agent === undefined || statusOf(agent) !== 'idle') continue;
          scheduleWake(sessionId, undefined);
        }
      }

      const needsTick = peak && agents.some((agent) => coveredOf(agent, sched));
      setTicking(needsTick);
      rescheduleBoundaryTimer(sched);
    } catch (error) {
      log('warn', `[dsh-session-enhance/offpeak] reconcile failed: ${describeError(error)}`);
    } finally {
      reconciling = false;
    }
    if (reconcileScheduled) {
      reconcileScheduled = false;
      scheduleReconcile();
    }
  }

  /**
   * 配置热更新后重新对账（volatile 字段改了窗口/时区/defaultEnabled）。
   *
   * @returns {void}
   */
  function refresh() {
    if (disposed) return;
    try {
      reconcile();
    } catch (error) {
      log('warn', `[dsh-session-enhance/offpeak] refresh failed: ${describeError(error)}`);
    }
  }

  /**
   * `agent/status` 监听体（已在外层 try/catch 里）。
   *
   * @param {{ agent?: any, status?: string }} [payload] - 事件载荷。
   * @returns {void}
   */
  function onAgentStatus(payload) {
    const agent = payload?.agent;
    const status = payload?.status;
    if (agent === undefined || agent === null) return;
    if (sessionIdOf(agent) === undefined) return;
    if (status === 'running') {
      const sched = schedule();
      // 覆盖判定（含子代理：父会话启用则子代理也被暂停）——不是只看本会话的开关。
      if (!isPeak(sched) || !coveredOf(agent, sched)) {
        scheduleReconcile();
        return;
      }
      // 关键：同步 cancel（turn/start 还没 append）——见模块注释第 2 层。
      pauseAgent(agent);
      scheduleReconcile();
      return;
    }
    if (status === 'idle') scheduleReconcile();
  }

  /**
   * `agent/disposed` 监听体。
   *
   * @param {{ agent?: any }} [payload] - 事件载荷。
   * @returns {void}
   */
  function onAgentDisposed(payload) {
    const agent = payload?.agent;
    const sessionId = sessionIdOf(agent);
    if (sessionId === undefined) return;
    const record = holds.get(sessionId);
    if (record !== undefined && record.agent === agent) {
      releaseHold(sessionId, { reason: 'disposed', wake: false });
    }
    interrupted.delete(sessionId);
    armFailureAt.delete(sessionId);
    scheduleReconcile();
  }

  /**
   * 给 RPC 的每会话状态。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {object} 状态值（见 `lib/offpeak/rpc.mjs` 的 `status` 端点）。
   */
  function status(sessionId) {
    const sched = schedule();
    const peak = isPeak(sched);
    const enabled = enabledOf(sessionId, sched);
    const agent = agentOf(sessionId);
    const at = now();
    let boundary = { at: null, kind: null };
    try {
      const next = nextBoundary(at, sched.window);
      boundary = { at: next.at, kind: next.kind };
    } catch (error) {
      log('debug', `[dsh-session-enhance/offpeak] nextBoundary failed: ${describeError(error)}`);
    }
    return {
      enabled,
      enabledSource: enabledSourceOf(sessionId),
      // 本会话是否正处于暂停状态（启用 + 峰时）。
      paused: enabled && peak,
      // 全局相位：现在是不是谷时。
      offPeak: !peak,
      window: {
        start: sched.window.start,
        end: sched.window.end,
        timeZone: sched.window.timeZone,
      },
      serverNow: at,
      // 下一次相位切换（禁用时也照常给，界面只在启用时用）。
      nextChangeAt: boundary.at,
      nextChangeKind: boundary.kind,
      cover: {
        agent: agent !== undefined,
        running: statusOf(agent) === 'running',
        held: holds.has(sessionId),
        interrupted: interrupted.has(sessionId),
        queued: queuedOf(agent),
      },
      persisted: storeError() === null,
      build,
    };
  }

  /**
   * 切换某会话的启用状态，并返回**切换后**的状态。
   *
   * 写盘失败不影响开关生效：返回 `persisted: false`，界面据此提示"重启后可能回落"。
   *
   * @param {string} sessionId - 会话 id。
   * @param {boolean} enabled - 目标状态。
   * @returns {object} 切换后的状态值。
   */
  function setEnabled(sessionId, enabled) {
    const target = enabled === true;
    let persisted = true;
    try {
      const outcome = store?.setEnabled?.(sessionId, target);
      if (outcome !== null && typeof outcome === 'object' && outcome.persisted === false) persisted = false;
    } catch (error) {
      persisted = false;
      log('warn', `[dsh-session-enhance/offpeak] persist for ${sessionId} failed: ${describeError(error)}`);
    }

    const sched = schedule();
    const peak = isPeak(sched);
    // 开关所在会话的**子代理**也要立即跟上：覆盖判定是"本会话或任一祖先会话启用"，
    // 所以父会话一开/一关，整棵子树都要重新评估，不能只处理被点的那个会话。
    const agents = listAgents();
    if (target === true) {
      if (peak) {
        for (const agent of agents) {
          if (!coveredOf(agent, sched)) continue;
          ensureHeld(agent);
        }
        scheduleReconcile();
      }
    } else {
      for (const agent of agents) {
        const agentSessionId = sessionIdOf(agent);
        if (agentSessionId === undefined) continue;
        if (coveredOf(agent, sched)) continue;
        if (!holds.has(agentSessionId)) continue;
        releaseHold(agentSessionId, { reason: 'disabled', wake: true });
      }
      scheduleReconcile();
    }

    const value = status(sessionId);
    if (!persisted) value.persisted = false;
    return value;
  }

  /**
   * 诊断快照（`diag` 端点）。
   *
   * @returns {object} 诊断值。
   */
  function diag() {
    const sched = schedule();
    const peak = isPeak(sched);
    const at = now();
    const agents = listAgents();
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {any[]} */
    const sessions = [];
    for (const agent of agents) {
      const sessionId = sessionIdOf(agent);
      if (sessionId === undefined || seen.has(sessionId)) continue;
      seen.add(sessionId);
      sessions.push({
        sessionId,
        agent: true,
        enabled: enabledOf(sessionId, sched),
        enabledSource: enabledSourceOf(sessionId),
        // 是否被谷峰调度覆盖（自身启用，或父会话启用）。
        covered: coveredOf(agent, sched),
        status: statusOf(agent) ?? 'unknown',
        held: holds.has(sessionId),
        interrupted: interrupted.has(sessionId),
        queued: queuedOf(agent),
      });
    }
    let records = [];
    try {
      records = typeof store?.list === 'function' ? store.list() : [];
    } catch (error) {
      log('debug', `[dsh-session-enhance/offpeak] store.list failed: ${describeError(error)}`);
    }
    for (const record of Array.isArray(records) ? records : []) {
      const sessionId = record?.sessionId;
      if (typeof sessionId !== 'string' || seen.has(sessionId)) continue;
      seen.add(sessionId);
      sessions.push({
        sessionId,
        agent: false,
        enabled: record.enabled === true,
        enabledSource: 'session',
        covered: false,
        status: null,
        held: false,
        interrupted: interrupted.has(sessionId),
        queued: 0,
      });
    }

    const error = storeError();
    return {
      build,
      now: at,
      // 全局相位：谷时 true。
      offPeak: !peak,
      // 全局相位：峰时 true（= 暂停期）。
      paused: peak,
      window: {
        start: sched.window.start,
        end: sched.window.end,
        timeZone: sched.window.timeZone,
      },
      config: {
        offPeakStart: sched.window.start,
        offPeakEnd: sched.window.end,
        timeZone: sched.window.timeZone,
        defaultEnabled: sched.defaultEnabled === true,
        issues: sched.issues,
      },
      store: {
        size: typeof store?.size === 'number' ? store.size : 0,
        corrupt: store?.corrupt === true,
      },
      sessions,
      ...(error === null ? {} : { storeError: describeError(error) }),
    };
  }

  /**
   * 内部状态快照（只给单测/日志用，不进 RPC 契约）。
   *
   * @returns {object} 快照。
   */
  function describe() {
    const tryRead = (read) => {
      try {
        return read();
      } catch {
        return undefined;
      }
    };
    return {
      holds: [...holds.keys()],
      interrupted: [...interrupted],
      tickActive: tickTimer !== null,
      boundaryPending: boundaryTimer !== null,
      boundarySpec,
      disposed,
      storeSize: tryRead(() => (typeof store?.size === 'number' ? store.size : 0)),
    };
  }

  /**
   * 挂事件监听并做首次对账；返回 dispose。
   *
   * 每个监听入口都自带 try/catch（`agent/created` 抛错会让创建失败、`agent/status`
   * 抛错会打断驱动），订阅本身失败（事件不存在）也只是降级，不影响组件其余功能。
   *
   * @param {any} ctx - Cordis 插件上下文。
   * @returns {() => void} dispose。
   */
  function attach(ctx) {
    /** @type {Array<() => void>} */
    const disposers = [];
    const subscribe = (name, handler) => {
      try {
        const off = ctx?.on?.(name, (payload) => {
          try {
            handler(payload);
          } catch (error) {
            log('warn', `[dsh-session-enhance/offpeak] ${name} listener failed: ${describeError(error)}`);
          }
        });
        if (typeof off === 'function') disposers.push(off);
      } catch (error) {
        log('debug', `[dsh-session-enhance/offpeak] subscribe ${name} failed (ignored): ${describeError(error)}`);
      }
    };

    subscribe('agent/created', () => {
      // creation 自己的 runMaintenance 还没结束（RUNTIME FACT：arm 会抛 already has active work），
      // 所以这里只排一次延后对账，等 creation 收敛后再 arm。
      scheduleReconcile();
    });
    subscribe('agent/status', (payload) => {
      onAgentStatus(payload);
    });
    subscribe('agent/disposed', (payload) => {
      onAgentDisposed(payload);
    });
    // 配置热更新：volatile 字段改了窗口/时区/defaultEnabled 要立刻重排 + 重新对账。
    // 事件不存在时 subscribe 静默降级（reconcile 每次都会重读配置，最坏晚一个边界/一秒）。
    subscribe('app-boot/config-reload', () => {
      refresh();
    });
    subscribe('settings/document-updated', () => {
      refresh();
    });

    refresh();

    return () => {
      if (disposed) return;
      disposed = true;
      // 定时器要直接清：setTicking 自己也看 disposed，先置位会导致它早退、timer 残留。
      tickToken += 1;
      clearTimer(tickTimer);
      tickTimer = null;
      clearTimer(boundaryTimer);
      boundaryTimer = null;
      boundarySpec = null;
      for (const sessionId of [...holds.keys()]) {
        releaseHold(sessionId, { reason: 'dispose', wake: false });
      }
      holds.clear();
      interrupted.clear();
      wakeScheduled.clear();
      armFailureAt.clear();
      for (const off of disposers) {
        try {
          off();
        } catch {
          // 卸载阶段的异常不影响其余清理。
        }
      }
    };
  }

  return {
    attach,
    reconcile,
    refresh,
    status,
    setEnabled,
    diag,
    describe,
    /** 测试/诊断用：当前的 holds 表（只读副本）。 */
    holds: () => [...holds.entries()].map(([sessionId, record]) => ({ sessionId, agent: record.agent })),
  };
}
