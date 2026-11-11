/**
 * 分级压缩的 Host 半驱动器。
 *
 * ## 它做什么
 *
 * 在 `agent/pre-step`（每一次模型请求发出之前）按上下文压力决定这一轮做哪一级压缩：
 *
 * 1. **L1 微压缩**：压力 ≥ `pruneRatio`（默认 0.60）时，调用官方
 *    `ctx.toolResultPruner.pruneSession(session)`，一趟扫描把**所有**超预算工具结果
 *    一起替换 —— 不调模型。
 * 2. **L2 深度压缩**：压力 ≥ `compactRatio`（默认 0.80）时，调用官方
 *    `ctx.compaction.compactIfNeeded(agent, 'pressure', signal)`：它先修剪全部可剪工具结果、
 *    再摘要最旧范围，两者在同一个压缩事务里完成 —— **一次批量提交只断一次前缀缓存**。
 * 3. **L3 溢出恢复**：提供方返回 `CONTEXT_WINDOW_EXCEEDED` 时，调用
 *    `compactIfNeeded(agent, 'context-overflow', signal)`，表层真的前进过才返回
 *    `{ kind: 'retry' }` 让 agent loop 重试（每轮最多一次）。
 *
 * 开关 `autoCompact` 默认关闭：关闭时 L1/L2/L3 全部不跑，只剩手动压缩。
 *
 * ## 为什么在 pre-step
 *
 * 这是「下一次请求发出前」最后一个可控点，也是官方 compaction-basic 自己的挂点
 * （`compaction-basic.js` 的 `_registerAutomaticCompaction`）。放在这里，L1 与 L2
 * 能在**同一个请求窗口**内完成，下一次请求看到的是最终表层 —— 只有一个缓存断点。
 *
 * ## 服务解析：优先 agent 自己的 preset 组合
 *
 * 标准模式下，`compaction` / `toolResultPruner` 由 preset 的隔离组提供（`isolate`），
 * 与 Host 层是不同实例。`agentPresets.serviceFor(agent, name)` 能拿到该 agent 绑定的
 * 那一份；拿不到时回退到 `agent.ctx.get(name)`，再回退到 Host 服务。
 *
 * ## 失败绝不冒泡
 *
 * 宿主 waterfall 不兜异常：listener 抛错会被 agent loop 的 catch 静默吞掉，导致整轮
 * 不发请求。所以这里所有路径都 try/catch，并且**永远** `return next()`。
 *
 * @module dsh-session-enhance/lib/compact/host
 */

import {
  DEFAULT_AUTO_FAILURE_LIMIT,
  DEFAULT_COMPACT_RATIO,
  DEFAULT_MAX_OVERFLOW_RETRIES,
  DEFAULT_PRUNE_RATIO,
  DEFAULT_WARNING_RATIO,
  TIER,
  effectiveWindow,
  formatRatio,
  resolveTier,
} from './tiers.mjs';

/** 溢出错误码：与官方 compaction-basic 使用同一个常量值。 */
export const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED';

/**
 * 取一个 Host 服务（软取，任何异常都当成缺失）。
 *
 * @param {any} ctx - 插件上下文。
 * @param {string} name - 服务名。
 * @returns {any} 服务或 undefined。
 */
function serviceOf(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name);
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * 取某个 agent 视角下的服务：优先它绑定的 preset 隔离组，其次 agent.ctx，最后 Host。
 *
 * @param {any} ctx - 插件上下文。
 * @param {any} agent - Agent。
 * @param {string} name - 服务名。
 * @returns {any} 服务或 undefined。
 */
function agentService(ctx, agent, name) {
  const presets = serviceOf(ctx, 'agentPresets');
  if (typeof presets?.serviceFor === 'function') {
    try {
      const scoped = presets.serviceFor(agent, name);
      if (scoped !== undefined && scoped !== null) return scoped;
    } catch {
      // 回退到下面的路径。
    }
  }
  try {
    const scoped = agent?.ctx?.get?.(name);
    if (scoped !== undefined && scoped !== null) return scoped;
  } catch {
    // 回退到 Host。
  }
  return serviceOf(ctx, name);
}

/**
 * 把异常转成一行可读文本。
 *
 * @param {unknown} error - 异常。
 * @returns {string} 文本。
 */
function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error === 'object' && typeof /** @type {any} */ (error).message === 'string') {
    return /** @type {any} */ (error).message;
  }
  return String(error);
}

/**
 * 创建分级压缩驱动器（与 Cordis 解耦，可离线单测）。
 *
 * @param {{
 *   ctx: any,
 *   readAutoCompact: () => boolean,
 *   logger?: any,
 * }} options - 依赖。
 * @returns {{
 *   attach: () => Array<() => void>,
 *   onPreStep: (payload: any, next: () => Promise<any>) => Promise<any>,
 *   onRequestError: (payload: any, next: () => Promise<any>) => Promise<any>,
 *   onStatus: (payload: any) => void,
 *   runAutoTier: (agent: any, signal?: AbortSignal) => Promise<object>,
 *   pruneAll: (agent: any) => { available: boolean, pruned: number, charsRemoved: number, error?: string },
 *   describe: () => object,
 *   diag: () => object,
 * }} 驱动器。
 */
export function createCompactionDriver({ ctx, readAutoCompact, logger }) {
  /** 每个 agent 的溢出恢复次数（WeakMap：agent 释放即回收）。 */
  const overflowRetries = new WeakMap();

  /**
   * 每个 agent 的自动压缩熔断状态。
   *
   * 对齐 Claude Code 的「连续失败 3 次熔断」：摘要连续失败（例如提供方按自己的枚举
   * 拒绝摘要请求）时不能每步重试——真实事故里一个会话因此打了 160 次失败的摘要调用。
   *
   * @type {WeakMap<object, { failures: number, breakerOpen: boolean, warned: boolean }>}
   */
  const autoStates = new WeakMap();

  /** 已被本插件装上「自动压缩守卫」的 compaction 引擎实例。 */
  const guardedEngines = new WeakSet();

  /** 卸载时恢复原方法的清理函数。 */
  const guardRestorers = [];

  /**
   * 给一个 compaction 引擎装上「自动压缩守卫」。
   *
   * 官方 compaction-basic 的自动压缩（`agent/pre-step` 压力路径）会调用
   * `this.compactIfNeeded(agent, 'pressure', signal)`。我们在运行期把该方法包一层：
   * 开关关闭时直接返回 `null`（等价于「本轮不需要压缩」），开关打开时原样转发。
   *
   * 只拦 `trigger === 'pressure'` —— 也就是**主动的**自动压缩；手动 `/compact`
   * （`compactNow`）、切模型检查（`compactPressure`）与 `context-overflow` 溢出恢复
   * 都不受影响，仍由官方实现负责（它们是安全网，不该被开关关掉）。
   *
   * 为什么需要这一层：web 形态的 compaction 实例挂在 preset 的隔离组里
   * （`isolate: { compaction, toolResultPruner }`），profile patch 的 id 定向覆盖
   * 打不到它（Loader 的 id 表只递归 `group: true` 行）。运行期守卫是唯一能让
   * `autoCompact` 成为唯一主动自动压缩源的可靠手段。
   *
   * @param {any} engine - compaction 服务实例。
   * @returns {void}
   */
  function installAutoGuard(engine) {
    if (engine === null || typeof engine !== 'object') return;
    if (guardedEngines.has(engine)) return;
    const original = engine.compactIfNeeded;
    if (typeof original !== 'function') return;
    /** 守卫版：开关关闭时只拦主动压力路径。 */
    function guardedCompactIfNeeded(agent, trigger, signal) {
      if (trigger === 'pressure' && readAutoCompact() !== true) return Promise.resolve(null);
      return original.call(this, agent, trigger, signal);
    }
    try {
      engine.compactIfNeeded = guardedCompactIfNeeded;
      guardedEngines.add(engine);
      guardRestorers.push(() => {
        try {
          if (engine.compactIfNeeded === guardedCompactIfNeeded) engine.compactIfNeeded = original;
        } catch {
          // 实例已释放/冻结：无需恢复。
        }
      });
    } catch (error) {
      log('warn', `[dsh-session-enhance/compact] could not install auto-compaction guard: ${messageOf(error)}`);
    }
  }

  /**
   * 给某个 agent 可见的所有 compaction 实例装上守卫（preset 隔离组 + Host 平面）。
   *
   * @param {any} agent - Agent。
   * @returns {void}
   */
  function guardForAgent(agent) {
    try {
      const presets = serviceOf(ctx, 'agentPresets');
      if (typeof presets?.serviceFor === 'function') installAutoGuard(presets.serviceFor(agent, 'compaction'));
    } catch {
      // 取不到 preset 实例时继续尝试 Host 平面。
    }
    installAutoGuard(serviceOf(ctx, 'compaction'));
  }

  /**
   * 写一条日志（日志服务缺失/异常都不影响压缩流程）。
   *
   * @param {'info'|'warn'|'debug'} level - 级别。
   * @param {string} message - 文本。
   * @returns {void}
   */
  const log = (level, message) => {
    try {
      logger?.[level]?.(message);
    } catch {
      // 日志失败不能影响主流程。
    }
  };

  /**
   * 读当前会话的 token 测量与窗口信息。
   *
   * @param {any} agent - Agent。
   * @returns {{ totalTokens?: number, contextWindow?: number, maxTokens?: number } | undefined} 测量。
   */
  function measure(agent) {
    const session = agent?.session;
    if (session === undefined || session === null) return undefined;
    const meter = serviceOf(ctx, 'tokenMeter');
    if (typeof meter?.measure !== 'function') return undefined;
    let totalTokens;
    try {
      const measured = meter.measure(session);
      if (typeof measured?.totalTokens === 'number' && Number.isFinite(measured.totalTokens)) {
        totalTokens = measured.totalTokens;
      }
    } catch (error) {
      log('debug', `[dsh-session-enhance/compact] measure failed: ${messageOf(error)}`);
      return undefined;
    }
    let contextWindow;
    let maxTokens;
    try {
      const context = typeof session.requestContext === 'function' ? session.requestContext() : undefined;
      if (typeof context?.contextWindow === 'number') contextWindow = context.contextWindow;
    } catch {
      // 窗口缺失时 resolveTier 会返回 none。
    }
    try {
      const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined;
      if (typeof header?.config?.maxTokens === 'number') maxTokens = header.config.maxTokens;
    } catch {
      // 输出预留缺失按 0 处理。
    }
    return { totalTokens, contextWindow, maxTokens };
  }

  /**
   * 取/建某个 agent 的自动压缩熔断状态。
   *
   * @param {any} agent - Agent。
   * @returns {{ failures: number, breakerOpen: boolean, warned: boolean }} 状态。
   */
  function autoStateOf(agent) {
    let state = autoStates.get(agent);
    if (state === undefined) {
      state = { failures: 0, breakerOpen: false, warned: false };
      autoStates.set(agent, state);
    }
    return state;
  }

  /**
   * 清零熔断状态（压缩成功、新一轮开始或手动压缩成功后调用）。
   *
   * @param {any} agent - Agent。
   * @returns {void}
   */
  function resetAutoFailures(agent) {
    if (agent === undefined || agent === null) return;
    const state = autoStates.get(agent);
    if (state === undefined) return;
    state.failures = 0;
    state.breakerOpen = false;
    state.warned = false;
  }

  /**
   * 计算某个 agent 的有效窗口（模型窗口 − 输出预留）。
   *
   * @param {any} agent - Agent。
   * @returns {number | undefined} 有效窗口。
   */
  function effectiveWindowFor(agent) {
    const session = agent?.session;
    if (session === undefined || session === null) return undefined;
    let contextWindow;
    let maxTokens;
    try {
      const context = typeof session.requestContext === 'function' ? session.requestContext() : undefined;
      if (typeof context?.contextWindow === 'number') contextWindow = context.contextWindow;
    } catch {
      return undefined;
    }
    try {
      const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined;
      if (typeof header?.config?.maxTokens === 'number') maxTokens = header.config.maxTokens;
    } catch {
      // 输出预留缺失按 0 处理。
    }
    return effectiveWindow({ contextWindow, maxTokens });
  }

  /**
   * 供 RPC 读取的 per-agent 自动压缩状态（熔断、有效窗口）。
   *
   * @param {any} agent - Agent。
   * @returns {{ autoFailures: number, breakerOpen: boolean, effectiveWindow: number | null }} 状态。
   */
  function statusFor(agent) {
    const state = agent === undefined || agent === null ? undefined : autoStates.get(agent);
    const window = effectiveWindowFor(agent);
    return {
      autoFailures: state?.failures ?? 0,
      breakerOpen: state?.breakerOpen === true,
      effectiveWindow: typeof window === 'number' ? window : null,
    };
  }

  /**
   * 执行一次自动分级决策（L1 / L2）。
   *
   * @param {any} agent - Agent。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<object>} 决策结果（测试可断言）。
   */
  async function runAutoTier(agent, signal) {
    const measured = measure(agent);
    if (measured === undefined) return { tier: TIER.NONE, reason: 'NO_MEASUREMENT' };
    const decision = resolveTier(measured);

    if (decision.tier === TIER.COMPACT) {
      const engine = agentService(ctx, agent, 'compaction');
      if (typeof engine?.compactIfNeeded !== 'function') {
        return { tier: decision.tier, ratio: decision.ratio, reason: 'NO_COMPACTION' };
      }
      const state = autoStateOf(agent);
      // 熔断：连续失败达到上限后不再尝试，直到压缩成功、新一轮开始或手动压缩成功。
      if (state.breakerOpen) {
        return { tier: decision.tier, ratio: decision.ratio, reason: 'BREAKER_OPEN' };
      }
      try {
        // 官方实现：先修剪全部可剪工具结果，再摘要最旧范围 —— 同一事务，一次断点。
        const result = await engine.compactIfNeeded(agent, 'pressure', signal);
        state.failures = 0;
        state.breakerOpen = false;
        state.warned = false;
        const compacted = result !== null && result !== undefined;
        if (compacted) {
          const items = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0;
          log(
            'info',
            `[dsh-session-enhance/compact] L2 compact at ${formatRatio(decision.ratio)}: shadowed ${items} nodes (~${result.shadowedTokenCount ?? 0} tokens)`,
          );
        }
        return { tier: decision.tier, ratio: decision.ratio, compacted };
      } catch (error) {
        state.failures += 1;
        if (state.failures >= DEFAULT_AUTO_FAILURE_LIMIT && !state.breakerOpen) {
          state.breakerOpen = true;
          if (!state.warned) {
            state.warned = true;
            log(
              'warn',
              `[dsh-session-enhance/compact] auto compaction paused after ${state.failures} consecutive failures (${messageOf(error)}); it will retry in the next turn`,
            );
          }
        }
        throw error;
      }
    }

    if (decision.tier === TIER.PRUNE) {
      const pruner = agentService(ctx, agent, 'toolResultPruner');
      if (typeof pruner?.pruneSession !== 'function') {
        return { tier: decision.tier, ratio: decision.ratio, reason: 'NO_PRUNER' };
      }
      // 一趟扫描替换所有超预算工具结果：批量提交，只断一次。
      const result = pruner.pruneSession(agent.session);
      const pruned = Array.isArray(result?.pruned) ? result.pruned.length : 0;
      if (pruned > 0) {
        log(
          'info',
          `[dsh-session-enhance/compact] L1 prune at ${formatRatio(decision.ratio)}: ${pruned} tool results (~${result.charsRemoved ?? 0} chars)`,
        );
      }
      return {
        tier: decision.tier,
        ratio: decision.ratio,
        pruned,
        charsRemoved: typeof result?.charsRemoved === 'number' ? result.charsRemoved : 0,
      };
    }

    return { tier: TIER.NONE, ratio: decision.ratio };
  }

  /**
   * `agent/pre-step` 监听：开关打开时执行 L1/L2，然后继续下一步。
   *
   * @param {any} payload - 事件载荷。
   * @param {() => Promise<any>} next - waterfall 的下一步。
   * @returns {Promise<any>} 决策。
   */
  async function onPreStep(payload, next) {
    try {
      const agent = payload?.agent;
      // 无论开关开不开，都先把「自动压缩守卫」装上：开关关闭时官方自动压缩必须真正停手。
      if (agent !== undefined && agent !== null) guardForAgent(agent);
      if (readAutoCompact() === true && payload?.signal?.aborted !== true) {
        await runAutoTier(agent, payload?.signal);
      }
    } catch (error) {
      // 宿主不兜异常：这里吞掉，保证整轮照常发请求。
      log('warn', `[dsh-session-enhance/compact] auto compaction failed: ${messageOf(error)}; continuing the turn`);
    }
    return next();
  }

  /**
   * `agent/request-error` 监听：L3 溢出恢复。
   *
   * 这是**被动安全网**，与 `autoCompact` 开关无关：即使主动自动压缩被关闭，
   * 提供方确认溢出后也应先压缩再重试，而不是把红色报错直接丢给用户
   * （对齐 Claude Code 的 Reactive Compact / 错误扣留）。
   *
   * @param {any} payload - 事件载荷。
   * @param {() => Promise<any>} next - waterfall 的下一步。
   * @returns {Promise<any>} 决策。
   */
  async function onRequestError(payload, next) {
    try {
      if (payload?.failure?.code !== CONTEXT_WINDOW_EXCEEDED) return next();
      if (payload?.signal?.aborted === true) return next();
      const agent = payload?.agent;
      if (agent === undefined || agent === null) return next();
      const engine = agentService(ctx, agent, 'compaction');
      if (typeof engine?.compactIfNeeded !== 'function') return next();
      const retries = overflowRetries.get(agent) ?? 0;
      if (retries >= DEFAULT_MAX_OVERFLOW_RETRIES) return next();
      const generation = agent.session?.surface?.replaceGeneration;
      try {
        await engine.compactIfNeeded(agent, 'context-overflow', payload.signal);
      } catch (error) {
        log('warn', `[dsh-session-enhance/compact] overflow recovery failed: ${messageOf(error)}`);
      }
      if (payload.signal?.aborted === true) return next();
      const nextGeneration = agent.session?.surface?.replaceGeneration;
      if (typeof generation !== 'number' || typeof nextGeneration !== 'number' || nextGeneration <= generation) {
        return next();
      }
      overflowRetries.set(agent, retries + 1);
      // 溢出压缩成功说明摘要链路是通的：清掉主动自动压缩的熔断计数。
      resetAutoFailures(agent);
      log('info', '[dsh-session-enhance/compact] L3 context-overflow recovery: retrying the request');
      return { kind: 'retry' };
    } catch (error) {
      log('warn', `[dsh-session-enhance/compact] overflow recovery crashed: ${messageOf(error)}`);
      return next();
    }
  }

  /**
   * `agent/status` 监听：agent 空闲（一轮结束）时清掉溢出计数与熔断状态。
   *
   * 熔断按「轮」重置而不是永久关闭：同一轮里最多尝试 3 次，避免真实事故里
   * 「每步重试、一轮 34 次摘要失败」的浪费；下一轮仍给一次重新开始的机会。
   *
   * @param {any} payload - 事件载荷。
   * @returns {void}
   */
  function onStatus(payload) {
    try {
      if (payload?.status !== 'idle' || payload?.agent === undefined) return;
      overflowRetries.delete(payload.agent);
      resetAutoFailures(payload.agent);
    } catch {
      // 忽略。
    }
  }

  /**
   * 手动压缩前的浅层批量修剪（L1）。供手动按钮与 `/compact` 之前调用。
   *
   * @param {any} agent - Agent。
   * @returns {{ available: boolean, pruned: number, charsRemoved: number, error?: string }} 结果。
   */
  function pruneAll(agent) {
    const pruner = agentService(ctx, agent, 'toolResultPruner');
    if (typeof pruner?.pruneSession !== 'function') return { available: false, pruned: 0, charsRemoved: 0 };
    try {
      const result = pruner.pruneSession(agent.session);
      return {
        available: true,
        pruned: Array.isArray(result?.pruned) ? result.pruned.length : 0,
        charsRemoved: typeof result?.charsRemoved === 'number' ? result.charsRemoved : 0,
      };
    } catch (error) {
      log('warn', `[dsh-session-enhance/compact] manual prune failed: ${messageOf(error)}`);
      return { available: true, pruned: 0, charsRemoved: 0, error: messageOf(error) };
    }
  }

  /**
   * 当前配置与阈值（供 RPC / 设置页展示）。
   *
   * @returns {{ autoCompact: boolean, pruneRatio: number, compactRatio: number, maxOverflowRetries: number }} 描述。
   */
  function describe() {
    return {
      autoCompact: readAutoCompact() === true,
      pruneRatio: DEFAULT_PRUNE_RATIO,
      compactRatio: DEFAULT_COMPACT_RATIO,
      warningRatio: DEFAULT_WARNING_RATIO,
      maxOverflowRetries: DEFAULT_MAX_OVERFLOW_RETRIES,
      autoFailureLimit: DEFAULT_AUTO_FAILURE_LIMIT,
    };
  }

  /**
   * 软依赖诊断。
   *
   * @returns {object} 诊断。
   */
  function diag() {
    return {
      ...describe(),
      hasCompaction: typeof serviceOf(ctx, 'compaction')?.compactIfNeeded === 'function',
      hasPruner: typeof serviceOf(ctx, 'toolResultPruner')?.pruneSession === 'function',
      hasTokenMeter: typeof serviceOf(ctx, 'tokenMeter')?.measure === 'function',
      guardedEngines: guardRestorers.length,
    };
  }

  /**
   * 取某个 agent 视角下的 compaction 服务（preset 隔离组优先）。
   *
   * @param {any} agent - Agent。
   * @returns {any} compaction 服务或 undefined。
   */
  function compactionFor(agent) {
    return agentService(ctx, agent, 'compaction');
  }

  /**
   * 取某个 agent 视角下的工具结果修剪器（preset 隔离组优先）。
   *
   * @param {any} agent - Agent。
   * @returns {any} 修剪器或 undefined。
   */
  function prunerFor(agent) {
    return agentService(ctx, agent, 'toolResultPruner');
  }

  /**
   * 取某个 agent 视角下的命令服务。
   *
   * @param {any} agent - Agent。
   * @returns {any} commands 服务或 undefined。
   */
  function commandsFor(agent) {
    return agentService(ctx, agent, 'commands');
  }

  /**
   * 注册事件监听；返回卸载函数数组（Cordis 的 ctx.on 本身也会随 fiber 释放）。
   *
   * @returns {Array<() => void>} 卸载函数。
   */
  function attach() {
    const disposers = [];
    const register = (name, handler, options) => {
      if (typeof ctx?.on !== 'function') return;
      try {
        const dispose = options === undefined ? ctx.on(name, handler) : ctx.on(name, handler, options);
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (error) {
        log('warn', `[dsh-session-enhance/compact] failed to register ${name}: ${messageOf(error)}`);
      }
    };
    // prepend：抢在官方 compaction-basic 的压力 listener 之前装守卫并做分级压缩。
    register('agent/pre-step', onPreStep, { prepend: true });
    register('agent/request-error', onRequestError);
    register('agent/status', onStatus);
    // 卸载时恢复被守卫过的引擎方法。
    disposers.push(() => {
      for (const restore of guardRestorers.splice(0)) {
        try {
          restore();
        } catch {
          // 忽略。
        }
      }
    });
    return disposers;
  }

  return {
    attach,
    onPreStep,
    onRequestError,
    onStatus,
    runAutoTier,
    pruneAll,
    describe,
    diag,
    statusFor,
    effectiveWindowFor,
    resetAutoFailures,
    compactionFor,
    prunerFor,
    commandsFor,
  };
}
