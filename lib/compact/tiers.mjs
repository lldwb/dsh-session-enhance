/**
 * 分级压缩（tiered compaction）的纯决策逻辑。
 *
 * ## 三级模型（对齐 Claude Code 的 auto-compact / microcompact / PTL 恢复）
 *
 * | 级 | 名称 | 动作 | 模型调用 | 触发（占有效窗口比例） |
 * |---|---|---|---|---|
 * | L1 | 微压缩 | 按需修剪超大工具结果（`pruneSession`） | 否 | ≥ `PRUNE_RATIO`（默认 0.60） |
 * | L2 | 深度压缩 | 「修剪 + 摘要较早历史」（`compaction.compactIfNeeded('pressure')`） | 是 | ≥ `COMPACT_RATIO`（默认 0.80） |
 * | L3 | 溢出恢复 | `compaction.compactIfNeeded('context-overflow')` 后重试请求 | 是 | 提供方返回 `CONTEXT_WINDOW_EXCEEDED` |
 *
 * ## 阈值公式与官方逐字一致
 *
 * 官方 `compaction-basic` 的阈值不是 `窗口 × 比例`，而是
 *
 * ```text
 * 消息预算   messageBudget  = contextWindow − reservedCompletionTokens
 * 压力预算   pressureBudget = messageBudget − headroomTokens（默认 65536）
 * 触发阈值   threshold      = min(contextWindow × thresholdRatio, pressureBudget)
 * ```
 *
 * 本模块照抄这个公式（`resolveCompactSpec`）。这不是洁癖：插件的守卫会让官方让路
 * （见 `host.mjs` 的 `inPluginCall`），所以插件**必须**复现官方的触发点，否则"接管"
 * 会悄悄把兜底阈值推后——小窗口（例如 128k 窗口 + 8k 预留）下官方 54k 就压，
 * 而只按 `窗口 × 0.8` 算要等到 96k。
 *
 * ## 批处理（一次性断点）
 *
 * 一次替换会让「从第一个被替换 token 起」的前缀缓存失效。因此：
 *
 * - L2 走官方 `compactIfNeeded('pressure')`：它先修剪**全部**可剪工具结果、再摘要最旧范围，
 *   两者在同一个事务里完成（一次 `compaction/start` … `compaction/end`，只换一次表层）。
 * - L1 由本插件按需修剪：**从新到旧**剪，压力降回阈值以下就停（见 `host.mjs` 的
 *   `pruneSelective`），避免把很早的节点也剪掉、把缓存断点推到最前面。
 *
 * @module dsh-session-enhance/lib/compact/tiers
 */

/** L1 微压缩的默认触发比例（占有效窗口）。 */
export const DEFAULT_PRUNE_RATIO = 0.6;

/** L2 深度压缩的默认触发比例（占有效窗口）。 */
export const DEFAULT_COMPACT_RATIO = 0.8;

/**
 * 「上下文即将用尽」预警比例（占有效窗口）。
 *
 * 对齐 Claude Code 的多级预警：进入该区间后界面会提示「即将用尽、建议手动压缩」，
 * 但不会自动压缩（自动压缩由 L2 阈值决定）。
 */
export const DEFAULT_WARNING_RATIO = 0.9;

/**
 * 输出预留之外还要留出的压缩余量（与官方 `headroomTokens` 默认值一致）。
 *
 * 官方默认 65536：压缩本身要发一次摘要请求、替换后还要继续跑，所以不能贴着窗口上限压。
 */
export const DEFAULT_HEADROOM_TOKENS = 65_536;

/** 连续自动压缩失败多少次后熔断（对齐 Claude Code 的 3 次熔断）。 */
export const DEFAULT_AUTO_FAILURE_LIMIT = 3;

/** L3 溢出恢复每个轮次最多重试次数（与官方 maxOverflowRetries 默认一致）。 */
export const DEFAULT_MAX_OVERFLOW_RETRIES = 1;

/** 三级标识。 */
export const TIER = Object.freeze({
  NONE: 'none',
  PRUNE: 'prune',
  COMPACT: 'compact',
  OVERFLOW: 'overflow',
});

/** 决策原因码：`get` RPC 与客户端用它回答「为什么这一轮没压」。 */
export const REASON = Object.freeze({
  /** 没有 tokenMeter 或测量失败。 */
  NO_MEASUREMENT: 'NO_MEASUREMENT',
  /** 拿不到上下文窗口（会话还没记录 request/context）。 */
  NO_WINDOW: 'NO_WINDOW',
  /** 窗口扣除预留与余量后没有压力预算（部署本身不可用）。 */
  NO_PRESSURE_BUDGET: 'NO_PRESSURE_BUDGET',
  /** 压力低于 L1 阈值。 */
  BELOW_PRUNE_RATIO: 'BELOW_PRUNE_RATIO',
  /** 自动压缩总开关关闭（官方接管主动压缩）。 */
  AUTO_OFF: 'AUTO_OFF',
  /** 找不到 toolResultPruner 服务。 */
  NO_PRUNER: 'NO_PRUNER',
  /** 找不到 compaction 服务。 */
  NO_COMPACTION: 'NO_COMPACTION',
  /** 连续失败达到上限，本轮暂停。 */
  BREAKER_OPEN: 'BREAKER_OPEN',
});

/**
 * 把一个值收敛成合法比例（0 < value ≤ 1），非法时回退。
 *
 * @param {unknown} value - 候选值。
 * @param {number} fallback - 回退值。
 * @returns {number} 合法比例。
 */
export function normalizeRatio(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) return fallback;
  return value;
}

/**
 * 计算有效上下文窗口：窗口减去输出预留。
 *
 * 这是「还能放多少输入」的上界，用于展示比例；**不用于**判定阈值（阈值见
 * `resolveTier`，那里还要再扣 `headroomTokens`）。
 *
 * @param {{ contextWindow?: unknown, maxTokens?: unknown }} input - 会话记录。
 * @returns {number | undefined} 有效窗口（正整数）；窗口缺失/非法时 undefined。
 */
export function effectiveWindow({ contextWindow, maxTokens } = {}) {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  const reserve =
    typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0;
  // 预留吃掉整个窗口时保底 1，避免除零；这种部署本身已无法工作。
  return Math.max(1, Math.floor(contextWindow) - Math.floor(reserve));
}

/**
 * 计算压力预算：窗口减去输出预留、再减去压缩余量（官方 `pressureBudgetTokens`）。
 *
 * @param {{ contextWindow?: unknown, maxTokens?: unknown, headroomTokens?: unknown }} input - 会话记录与余量。
 * @returns {number | undefined} 压力预算；窗口缺失/非法时 undefined。
 */
export function pressureBudget({ contextWindow, maxTokens, headroomTokens } = {}) {
  const budget = effectiveWindow({ contextWindow, maxTokens });
  if (budget === undefined) return undefined;
  const headroom =
    typeof headroomTokens === 'number' && Number.isFinite(headroomTokens) && headroomTokens >= 0
      ? Math.floor(headroomTokens)
      : DEFAULT_HEADROOM_TOKENS;
  return budget - headroom;
}

/**
 * 按官方公式算一个比例对应的触发阈值。
 *
 * `threshold = min(contextWindow × ratio, pressureBudget)`；预算为 1 时保底 1。
 *
 * @param {{ contextWindow: number, ratio: number, budget: number }} input - 窗口、比例、压力预算。
 * @returns {number} 触发阈值（正整数）。
 */
export function thresholdTokens({ contextWindow, ratio, budget }) {
  const byRatio = Math.floor(contextWindow * ratio);
  return Math.max(1, Math.min(byRatio, budget));
}

/**
 * 根据 token 用量与窗口决定这一轮该做哪一级。
 *
 * @param {{
 *   totalTokens?: unknown,
 *   contextWindow?: unknown,
 *   maxTokens?: unknown,
 *   headroomTokens?: unknown,
 *   pruneRatio?: unknown,
 *   compactRatio?: unknown,
 * }} input - 测量结果、窗口信息与阈值。
 * @returns {{
 *   tier: string,
 *   reason: string | null,
 *   ratio: number | null,
 *   window: number | null,
 *   pruneRatio: number,
 *   compactRatio: number,
 *   pruneThresholdTokens: number | null,
 *   compactThresholdTokens: number | null,
 * }} 决策。
 */
export function resolveTier(input = {}) {
  const compactRatio = normalizeRatio(input.compactRatio, DEFAULT_COMPACT_RATIO);
  // L1 必须早于 L2：配置被写成 prune ≥ compact 时收敛到 compact，避免 L1 永不触发。
  const pruneRatio = Math.min(normalizeRatio(input.pruneRatio, DEFAULT_PRUNE_RATIO), compactRatio);
  const window = effectiveWindow({ contextWindow: input.contextWindow, maxTokens: input.maxTokens });
  const total = input.totalTokens;
  const base = {
    pruneRatio,
    compactRatio,
    window: window ?? null,
    totalTokens: typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null,
    pruneThresholdTokens: null,
    compactThresholdTokens: null,
  };
  if (window === undefined) return { ...base, tier: TIER.NONE, reason: REASON.NO_WINDOW, ratio: null };
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
    return { ...base, tier: TIER.NONE, reason: REASON.NO_MEASUREMENT, ratio: null };
  }
  const budget = pressureBudget({
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
    headroomTokens: input.headroomTokens,
  });
  if (budget === undefined) return { ...base, tier: TIER.NONE, reason: REASON.NO_WINDOW, ratio: null };
  // 窗口扣掉输出预留与压缩余量后没有压力预算：官方在同样配置下抛
  // `TargetPressureConfigError`（只告警、不压缩）。这里对齐成「不压 + 给出原因」，
  // 而不是把阈值钳到 1 之后每轮都压。
  if (budget <= 0) return { ...base, tier: TIER.NONE, reason: REASON.NO_PRESSURE_BUDGET, ratio: null };
  const compactThresholdTokens = thresholdTokens({
    contextWindow: /** @type {number} */ (input.contextWindow),
    ratio: compactRatio,
    budget,
  });
  const pruneThresholdTokens = thresholdTokens({
    contextWindow: /** @type {number} */ (input.contextWindow),
    ratio: pruneRatio,
    budget,
  });
  const ratio = total / window;
  const withThresholds = { ...base, pruneThresholdTokens, compactThresholdTokens, ratio };
  if (total >= compactThresholdTokens) return { ...withThresholds, tier: TIER.COMPACT, reason: null };
  if (total >= pruneThresholdTokens) return { ...withThresholds, tier: TIER.PRUNE, reason: null };
  return { ...withThresholds, tier: TIER.NONE, reason: REASON.BELOW_PRUNE_RATIO };
}

/**
 * 把比例格式化成界面/日志用的百分比文本（保留一位小数）。
 *
 * @param {number | null | undefined} ratio - 比例。
 * @returns {string} 例如 `62.4%`；非法值返回 `—`。
 */
export function formatRatio(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}
