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
  DEFAULT_HEADROOM_TOKENS,
  DEFAULT_MAX_OVERFLOW_RETRIES,
  DEFAULT_PRUNE_RATIO,
  DEFAULT_WARNING_RATIO,
  REASON,
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
 * 深冻结一个值（与官方 `freezeMessage` 等价：`deepFreeze(structuredClone(x))`）。
 *
 * 这里不复用 `@deepseek-ai/dsh-llm` 的 `freezeMessage`：profile 里的第三方插件
 * 解析不到 `@deepseek-ai/*`（pnpm `link:` 不建那份依赖树），所以自己实现。
 * 官方的实现就是深冻结，没有额外 brand，行为一致。
 *
 * @template T
 * @param {T} value - 待冻结的值。
 * @returns {T} 同一个（已冻结的）值。
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(/** @type {any} */ (value)[key]);
  return value;
}

/**
 * 统计一组内容块里的文本字符数（与官方 pruner 的 `measureContent` 同口径：只数 text 块）。
 *
 * @param {any[]} blocks - 内容块。
 * @returns {number} 字符数。
 */
function textChars(blocks) {
  let chars = 0;
  if (!Array.isArray(blocks)) return 0;
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      chars += block.text.length;
    }
  }
  return chars;
}

/**
 * 按需修剪：**从新到旧**替换超预算工具结果，省够 `neededTokens` 就停。
 *
 * 为什么不用官方 `pruneSession`：它一趟扫描会把**所有**超预算工具结果一起换掉，
 * 包括很靠前的节点。表层替换会让「从第一个被替换 token 起」的前缀缓存全部失效，
 * 所以一次性全剪等于把缓存断点推到最前面——省 token 的反面。从新到旧剪，断点留在
 * 尾部附近，缓存保留得更多；省够就停，不可逆损失也更小。
 *
 * 替换协议与官方 pruner 完全一致（否则会话会拒绝写入）：
 * 先追加 `compaction/prune`（影子价格：`shadowedRange` / `shadowedSeqs` /
 * `shadowedTokenCount`），再追加 `tool/result`（`surfaceOp: replace` + `sourceEventSeqs`）。
 *
 * 任何前提缺失都返回 `null`，由调用方回退到官方 `pruneSession`。
 *
 * @param {{
 *   pruner: any,
 *   meter: any,
 *   session: any,
 *   neededTokens: number,
 *   log?: (level: string, message: string) => void,
 * }} input - 依赖。
 * @returns {{ pruned: number, charsRemoved: number, selective: boolean } | null} 结果；不可用时 null。
 */
function pruneSelective({ pruner, meter, session, neededTokens, log }) {
  if (typeof session?.append !== 'function') return null;
  if (typeof session?.eventAt !== 'function') return null;
  if (typeof session?.deriveEventMessage !== 'function') return null;
  if (!Array.isArray(session?.surface?.nodes)) return null;
  if (typeof pruner?.pruneContent !== 'function') return null;
  if (typeof meter?.estimateMessage !== 'function') return null;
  let candidates;
  try {
    candidates = [...session.surface.nodes];
  } catch {
    return null;
  }
  const target = Math.max(1, Math.floor(neededTokens));
  let pruned = 0;
  let charsRemoved = 0;
  let tokensSaved = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (tokensSaved >= target) break;
    const seq = candidates[index];
    let event;
    try {
      event = session.eventAt(seq);
    } catch {
      continue;
    }
    if (event?.type !== 'tool/result') continue;
    let original;
    try {
      original = session.deriveEventMessage(event);
    } catch {
      continue;
    }
    if (original === null || original === undefined) continue;
    let content;
    try {
      content = pruner.pruneContent(original.content);
    } catch {
      continue;
    }
    if (content === null) continue;
    const charsBefore = textChars(original.content);
    const charsAfter = textChars(content);
    const message = deepFreeze(structuredClone({ ...original, content }));
    try {
      const shadowedTokenCount = meter.estimateMessage(original);
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount,
      });
      session.append(
        'tool/result',
        { ...event.data, message },
        {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
          sourceEventSeqs: [seq],
        },
      );
      tokensSaved += Math.max(0, shadowedTokenCount - meter.estimateMessage(message));
    } catch (error) {
      // 已经落地的替换不会回滚（与官方 pruner 一致）；停在这里，别把异常抛给宿主。
      log?.('warn', `[dsh-session-enhance/compact] selective prune stopped at seq ${seq}: ${messageOf(error)}`);
      break;
    }
    pruned += 1;
    charsRemoved += charsBefore - charsAfter;
  }
  return { pruned, charsRemoved, selective: true };
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
export function createCompactionDriver({ ctx, readAutoCompact, readTierRatios, logger }) {
  /** 每个 agent 的溢出恢复次数（WeakMap：agent 释放即回收）。 */
  const overflowRetries = new WeakMap();

  /**
   * 当前是否有「本插件自己」正在调用 compaction 引擎。
   *
   * 守卫用它区分两种 `compactIfNeeded('pressure')`：
   * - 插件 L2 主动调用 → 必须放行（否则自己把自己拦住）；
   * - 官方 `agent/pre-step` 监听调用 → 开关打开时要让路（避免同一请求窗口压两次）。
   *
   * @type {number}
   */
  let pluginCallDepth = 0;

  /**
   * 读当前阈值配置（volatile：设置页保存后下一次 pre-step 立即生效）。
   *
   * @returns {{ pruneRatio: unknown, compactRatio: unknown, headroomTokens: number }} 阈值。
   */
  function tierOptions() {
    let ratios = {};
    try {
      const read = typeof readTierRatios === 'function' ? readTierRatios() : undefined;
      if (read !== null && typeof read === 'object') ratios = read;
    } catch {
      ratios = {};
    }
    return {
      pruneRatio: /** @type {any} */ (ratios)?.pruneRatio,
      compactRatio: /** @type {any} */ (ratios)?.compactRatio,
      headroomTokens: DEFAULT_HEADROOM_TOKENS,
    };
  }

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
   * 给一个 compaction 引擎装上「主动压缩仲裁器」。
   *
   * 官方 compaction-basic 的自动压缩（`agent/pre-step` 压力路径）会调用
   * `this.compactIfNeeded(agent, 'pressure', signal)`。我们在运行期把该方法包一层，
   * 按三态决定是否放行：
   *
   * | 情形 | 行为 | 为什么 |
   * |---|---|---|
   * | 非 `pressure`（溢出恢复 / 手动 / 切模型） | 原样转发 | 这些是安全网，任何开关都不该拦 |
   * | `pressure` 且是本插件在调（`pluginCallDepth > 0`） | 原样转发 | 否则插件 L2 会把自己拦住 |
   * | `pressure` 且 `autoCompact` **关闭** | **原样转发** | 「关」= 交还官方。5.3.0 之前这里返回 `null`，等于把官方的 80% 兜底也悄悄关掉了 |
   * | `pressure` 且 `autoCompact` **打开** | 返回 `null` | 插件独占主动压缩，官方 pre-step 监听让路，避免同一请求窗口压两次 |
   *
   * 只拦 `trigger === 'pressure'` —— 也就是**主动的**自动压缩；手动 `/compact`
   * （`compactNow`）、切模型检查（`compactPressure`，它不经过本方法）与
   * `context-overflow` 溢出恢复都不受影响。
   *
   * 为什么需要这一层：web 形态的 compaction 实例挂在 preset 的隔离组里
   * （`isolate: { compaction, toolResultPruner }`），profile patch 的 id 定向覆盖
   * 打不到它（Loader 的 id 表只递归 `group: true` 行）。运行期仲裁是唯一能让
   * `autoCompact` 成为「主动自动压缩唯一来源」的可靠手段。
   *
   * @param {any} engine - compaction 服务实例。
   * @returns {void}
   */
  function installAutoGuard(engine) {
    if (engine === null || typeof engine !== 'object') return;
    if (guardedEngines.has(engine)) return;
    const original = engine.compactIfNeeded;
    if (typeof original !== 'function') return;
    /** 仲裁版：三态放行/让路，见上面的表。 */
    function guardedCompactIfNeeded(agent, trigger, signal) {
      // 非主动压力路径：安全网，永不拦截。
      if (trigger !== 'pressure') return original.call(this, agent, trigger, signal);
      // 插件自己的调用：放行。
      if (pluginCallDepth > 0) return original.call(this, agent, trigger, signal);
      // 开关关闭：交还官方（「关」必须等于「没装插件」）。
      if (readAutoCompact() !== true) return original.call(this, agent, trigger, signal);
      // 开关打开：官方让路，由插件独占。
      return Promise.resolve(null);
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
   * 供 RPC 读取的 per-agent 自动压缩状态（熔断、有效窗口、最近一次决策）。
   *
   * `lastDecision` 是「为什么这一轮没压」的唯一可查来源：`get` RPC 会把它带给
   * 浏览器半，动作行的 tooltip 直接展示 tier / reason / 阈值。
   *
   * @param {any} agent - Agent。
   * @returns {{
   *   autoFailures: number,
   *   breakerOpen: boolean,
   *   effectiveWindow: number | null,
   *   lastDecision: object | null,
   *   lastPruned: number,
   * }} 状态。
   */
  function statusFor(agent) {
    const state = agent === undefined || agent === null ? undefined : autoStates.get(agent);
    const window = effectiveWindowFor(agent);
    let lastDecision = state?.lastDecision;
    if (lastDecision === undefined) {
      // 还没走过 pre-step（或本轮还没决策）：自动压缩关闭时答案是 AUTO_OFF；
      // 打开时按需算一次——面板打开时调用，代价是一次 O(surface) 测量。
      if (readAutoCompact() !== true) {
        lastDecision = { tier: TIER.NONE, reason: REASON.AUTO_OFF };
      } else {
        try {
          lastDecision = decide(agent);
        } catch {
          lastDecision = { tier: TIER.NONE, reason: REASON.NO_MEASUREMENT };
        }
      }
    }
    return {
      autoFailures: state?.failures ?? 0,
      breakerOpen: state?.breakerOpen === true,
      effectiveWindow: typeof window === 'number' ? window : null,
      lastDecision: lastDecision === undefined ? null : lastDecision,
      lastPruned: state?.lastPruned ?? 0,
    };
  }

  /**
   * 只做决策、不执行（供 RPC、手动压缩门控与单测使用）。
   *
   * @param {any} agent - Agent。
   * @returns {object} `resolveTier` 的决策。
   */
  function decide(agent) {
    const measured = measure(agent);
    if (measured === undefined) {
      return { tier: TIER.NONE, reason: REASON.NO_MEASUREMENT, ratio: null, window: null };
    }
    return resolveTier({ ...measured, ...tierOptions() });
  }

  /**
   * 以「本插件」身份调用 compaction 引擎（守卫据此放行）。
   *
   * @param {any} engine - compaction 服务。
   * @param {any} agent - Agent。
   * @param {string} trigger - `pressure` / `context-overflow`。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<any>} 官方返回值。
   */
  async function callEngine(engine, agent, trigger, signal) {
    pluginCallDepth += 1;
    try {
      return await engine.compactIfNeeded(agent, trigger, signal);
    } finally {
      pluginCallDepth -= 1;
    }
  }

  /**
   * 执行一次自动分级决策（L1 / L2）。
   *
   * @param {any} agent - Agent。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<object>} 决策结果（测试可断言）。
   */
  async function runAutoTier(agent, signal) {
    const decision = decide(agent);
    if (agent !== undefined && agent !== null) {
      const state = autoStateOf(agent);
      state.lastDecision = decision;
    }

    if (decision.tier === TIER.COMPACT) {
      const engine = agentService(ctx, agent, 'compaction');
      if (typeof engine?.compactIfNeeded !== 'function') {
        return { ...decision, reason: REASON.NO_COMPACTION };
      }
      const state = autoStateOf(agent);
      // 熔断：连续失败达到上限后不再尝试，直到压缩成功、新一轮开始或手动压缩成功。
      if (state.breakerOpen) {
        return { ...decision, reason: REASON.BREAKER_OPEN };
      }
      try {
        // 官方实现：先修剪全部可剪工具结果，再摘要最旧范围 —— 同一事务，一次断点。
        const result = await callEngine(engine, agent, 'pressure', signal);
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
        return { ...decision, compacted };
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
        return { ...decision, reason: REASON.NO_PRUNER };
      }
      // 按需修剪：从新到旧剪，压力降回阈值以下就停（而不是把所有超预算结果一次剪光）。
      const outcome = pruneWith(pruner, agent, decision);
      if (agent !== undefined && agent !== null) autoStateOf(agent).lastPruned = outcome.pruned;
      if (outcome.pruned > 0) {
        log(
          'info',
          `[dsh-session-enhance/compact] L1 prune at ${formatRatio(decision.ratio)}: ${outcome.pruned} tool results (~${outcome.charsRemoved} chars, ${outcome.selective ? 'newest-first' : 'all'})`,
        );
      }
      return { ...decision, pruned: outcome.pruned, charsRemoved: outcome.charsRemoved };
    }

    return decision;
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
   * 当前会话是否有**开放的 turn**。
   *
   * ## 为什么修剪必须先问这一句
   *
   * 修剪的落库协议是「追加 `compaction/prune` + 追加 `tool/result(surfaceOp: replace)`」。
   * DSH 的重放校验器对 surface 替换有一条硬规则：
   *
   * ```
   * if (openTurn === null) throw new SessionFormatError('tool/result replacement is outside an open turn')
   * ```
   *
   * 也就是说，**替换事件必须落在开放 turn 之内**。而修剪并不总在 turn 内发生：
   * 手动压缩 / `/compact`、以及 turn 刚被用户取消之后的尾巴，都可能落在 `turn/end` 之后。
   * 一旦在 turn 外 append，日志就永久损坏 —— 之后 `readSession` / `readSurface`
   * 全部失败，**会话历史再也读不出来、会话也无法冷恢复**（真实事故 2026-11-13：
   * 7 对 prune+replace 落在 `turn/end turn=11` 之后，整份日志被判 corrupt）。
   *
   * 判断走官方投影 `agents.turnBoundaryOf(session).openTurnStartSeq`：非 null 即 turn 开放。
   * 服务缺失（老版本 DSH / 离线测试）时返回 `true` —— 保持旧行为，不因为判断不了就停掉修剪。
   *
   * @param {any} agent - Agent。
   * @returns {boolean} 有开放 turn 时 true。
   */
  function isTurnOpen(agent) {
    const agents = serviceOf(ctx, 'agents');
    if (typeof agents?.turnBoundaryOf !== 'function') return true;
    try {
      const boundary = agents.turnBoundaryOf(agent?.session);
      return typeof boundary?.openTurnStartSeq === 'number';
    } catch {
      return true;
    }
  }

  /**
   * 修剪一次工具结果：优先按需（新到旧、省够就停），前提缺失时回退官方全量修剪。
   *
   * **turn 不开放时一律不剪**（连官方回退也不走）：两条路径都会 append surface 替换，
   * 在 turn 外落库就是损坏日志。见 `isTurnOpen` 的说明。
   *
   * @param {any} pruner - `toolResultPruner` 服务。
   * @param {any} agent - Agent（`pruneWith` 需要它的 session 与 turn 边界）。
   * @param {object} [decision] - 决策（带 `totalTokens` / `pruneThresholdTokens` 时启用按需模式）。
   * @returns {{ pruned: number, charsRemoved: number, selective: boolean, skippedOutsideTurn?: boolean }} 结果。
   */
  function pruneWith(pruner, agent, decision) {
    const session = agent?.session;
    if (!isTurnOpen(agent)) {
      log(
        'warn',
        '[dsh-session-enhance/compact] prune skipped: no open turn ' +
          '(a surface replacement written outside a turn corrupts the session log)',
      );
      return { pruned: 0, charsRemoved: 0, selective: true, skippedOutsideTurn: true };
    }
    const meter = serviceOf(ctx, 'tokenMeter');
    const total = typeof decision?.totalTokens === 'number' ? decision.totalTokens : undefined;
    const threshold =
      typeof decision?.pruneThresholdTokens === 'number' ? decision.pruneThresholdTokens : undefined;
    if (total !== undefined && threshold !== undefined) {
      const selective = pruneSelective({
        pruner,
        meter,
        session,
        neededTokens: Math.max(1, total - threshold),
        log,
      });
      if (selective !== null) return selective;
    }
    // 回退：官方一趟扫描（把所有超预算工具结果一起替换）。
    const result = pruner.pruneSession(session);
    return {
      pruned: Array.isArray(result?.pruned) ? result.pruned.length : 0,
      charsRemoved: typeof result?.charsRemoved === 'number' ? result.charsRemoved : 0,
      selective: false,
    };
  }

  /**
   * 手动压缩前的浅层批量修剪（L1）。供手动按钮与 `/compact` 之前调用。
   *
   * @param {any} agent - Agent。
   * @param {object} [decision] - 已算好的决策（省略时用官方全量修剪）。
   * @returns {{ available: boolean, pruned: number, charsRemoved: number, selective?: boolean, error?: string }} 结果。
   */
  function pruneAll(agent, decision) {
    const pruner = agentService(ctx, agent, 'toolResultPruner');
    if (typeof pruner?.pruneSession !== 'function') return { available: false, pruned: 0, charsRemoved: 0 };
    try {
      const outcome = pruneWith(pruner, agent, decision);
      return {
        available: true,
        pruned: outcome.pruned,
        charsRemoved: outcome.charsRemoved,
        selective: outcome.selective,
        ...(outcome.skippedOutsideTurn === true ? { skippedOutsideTurn: true } : {}),
      };
    } catch (error) {
      log('warn', `[dsh-session-enhance/compact] manual prune failed: ${messageOf(error)}`);
      return { available: true, pruned: 0, charsRemoved: 0, error: messageOf(error) };
    }
  }

  /**
   * 手动压缩前的**条件**修剪：只有压力达到 L1 阈值才剪。
   *
   * 这是 5.3.0 修的一个真实缺陷：以前 `pruneAll` 无条件先跑，于是对一个
   * 「没有可压缩历史」的会话点压缩，会先永久剪掉工具结果中间段、再返回 `NO_RANGE`
   * ——压缩没发生，损失发生了。现在低于阈值就跳过修剪，直接交给官方 `compactNow`。
   *
   * @param {any} agent - Agent。
   * @returns {{ available: boolean, pruned: number, charsRemoved: number, skipped: boolean, reason?: string, error?: string }} 结果。
   */
  function pruneIfNeeded(agent) {
    const decision = decide(agent);
    if (decision.tier !== TIER.PRUNE && decision.tier !== TIER.COMPACT) {
      return {
        available: true,
        pruned: 0,
        charsRemoved: 0,
        skipped: true,
        reason: decision.reason ?? REASON.BELOW_PRUNE_RATIO,
      };
    }
    const outcome = pruneAll(agent, decision);
    if (outcome.available === true && outcome.pruned > 0 && agent !== undefined && agent !== null) {
      autoStateOf(agent).lastPruned = outcome.pruned;
    }
    return { ...outcome, skipped: false };
  }

  /**
   * 当前配置与阈值（供 RPC / 设置页展示）。
   *
   * @returns {{
   *   autoCompact: boolean,
   *   pruneRatio: number,
   *   compactRatio: number,
   *   warningRatio: number,
   *   headroomTokens: number,
   *   maxOverflowRetries: number,
   *   autoFailureLimit: number,
   * }} 描述。
   */
  function describe() {
    const options = tierOptions();
    return {
      autoCompact: readAutoCompact() === true,
      pruneRatio: typeof options.pruneRatio === 'number' ? options.pruneRatio : DEFAULT_PRUNE_RATIO,
      compactRatio: typeof options.compactRatio === 'number' ? options.compactRatio : DEFAULT_COMPACT_RATIO,
      warningRatio: DEFAULT_WARNING_RATIO,
      headroomTokens: options.headroomTokens,
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
    decide,
    pruneAll,
    pruneIfNeeded,
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
