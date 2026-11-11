/**
 * 分级压缩（tiered compaction）的纯决策逻辑。
 *
 * ## 三级模型（对齐 Claude Code 的 auto-compact / microcompact / PTL 恢复）
 *
 * | 级 | 名称 | 动作 | 模型调用 | 触发（占有效窗口比例） |
 * |---|---|---|---|---|
 * | L1 | 微压缩 | 批量修剪超大工具结果（`toolResultPruner.pruneSession`） | 否 | ≥ `PRUNE_RATIO`（默认 0.60） |
 * | L2 | 深度压缩 | 批量「修剪 + 摘要较早历史」（`compaction.compactIfNeeded('pressure')`） | 是 | ≥ `COMPACT_RATIO`（默认 0.80） |
 * | L3 | 溢出恢复 | `compaction.compactIfNeeded('context-overflow')` 后重试请求 | 是 | 提供方返回 `CONTEXT_WINDOW_EXCEEDED` |
 *
 * ## 批处理（一次性断点）
 *
 * 一次替换会让「从第一个被替换 token 起」的前缀缓存失效。因此：
 *
 * - L2 走官方 `compactIfNeeded('pressure')`：它先修剪**全部**可剪工具结果、再摘要最旧范围，
 *   两者在同一个事务里完成（一次 `compaction/start` … `compaction/end`，只换一次表层）。
 * - L1 只做一次 `pruneSession`，它在一趟扫描里把**所有**超预算工具结果一起替换（一次批量提交）。
 * - 自动模式下 L1 与 L2 在同一次 `agent/pre-step` 内完成（同一个请求窗口），下一次请求看到的
 *   是最终表层，因此只会产生一个缓存断点。
 *
 * ## 有效窗口
 *
 * 触发阈值不用裸 `contextWindow`，而是「窗口 − 输出预留」（与 Claude Code 的有效窗口一致）：
 * 预留取最近一次请求头的 `maxTokens`，缺失时按 0 处理。窗口与预留都来自会话自身记录的
 * `request/context` 与 `request/header`，无需额外模型调用。
 *
 * @module dsh-session-enhance/lib/compact/tiers
 */

/** L1 微压缩的默认触发比例（占有效窗口）。 */
export const DEFAULT_PRUNE_RATIO = 0.6;

/** L2 深度压缩的默认触发比例（占有效窗口）。 */
export const DEFAULT_COMPACT_RATIO = 0.8;

/** L3 溢出恢复每个轮次最多重试次数（与官方 maxOverflowRetries 默认一致）。 */
export const DEFAULT_MAX_OVERFLOW_RETRIES = 1;

/** 三级标识。 */
export const TIER = Object.freeze({
  NONE: 'none',
  PRUNE: 'prune',
  COMPACT: 'compact',
  OVERFLOW: 'overflow',
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
 * 根据 token 用量与窗口决定这一轮该做哪一级。
 *
 * @param {{
 *   totalTokens?: unknown,
 *   contextWindow?: unknown,
 *   maxTokens?: unknown,
 *   pruneRatio?: unknown,
 *   compactRatio?: unknown,
 * }} input - 测量结果与阈值。
 * @returns {{ tier: string, ratio: number | null, window: number | null, pruneRatio: number, compactRatio: number }} 决策。
 */
export function resolveTier(input = {}) {
  const pruneRatio = normalizeRatio(input.pruneRatio, DEFAULT_PRUNE_RATIO);
  const compactRatio = normalizeRatio(input.compactRatio, DEFAULT_COMPACT_RATIO);
  const window = effectiveWindow({ contextWindow: input.contextWindow, maxTokens: input.maxTokens });
  const total = input.totalTokens;
  if (window === undefined || typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
    return { tier: TIER.NONE, ratio: null, window: window ?? null, pruneRatio, compactRatio };
  }
  const ratio = total / window;
  if (ratio >= compactRatio) return { tier: TIER.COMPACT, ratio, window, pruneRatio, compactRatio };
  if (ratio >= pruneRatio) return { tier: TIER.PRUNE, ratio, window, pruneRatio, compactRatio };
  return { tier: TIER.NONE, ratio, window, pruneRatio, compactRatio };
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
