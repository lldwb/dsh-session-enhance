/**
 * 「用户中断后可重试」的记录。
 *
 * ## 为什么需要它
 *
 * 官方「继续生成」只覆盖**模型失败**（`turn/end reason.kind === 'error'` 且错误码属于
 * RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE / STREAM_CLOSED，
 * 见 `dsh-api-session-controller` 的 `conversationContinuation` 投影）。用户点**停止**
 * 的那一轮以 `reason.kind === 'aborted'` 正常结束，官方不提供继续入口。
 *
 * 本组件补的就是这一格：`turn/end` 的取消原因是
 * `{ kind: 'aborted', reason: { kind: 'user' } }` 时记一条「这一轮被本人停止、还可以
 * 再来一次」的记录；用户之后回到这个会话仍能看到「重试」按钮。
 *
 * ## 边界
 *
 * - 只有 `reason.kind === 'aborted'` 且 `reason.reason.kind === 'user'` 才记录：
 *   parent / hook / disposed 等取消不是用户本意，不该给重试。
 * - 记录只在内存里：Host 重启后丢失（历史会话里不会出现无法执行的按钮）。
 * - 新一代价：这一轮已经结束，没有"原地重试"可言；用户点重试时只能由
 *   `agent.followup()` 发一条中性 user 消息驱动**新的一轮**（历史里会多一条消息）。
 *
 * @module dsh-session-enhance/lib/retry/recovery
 */

/** 记录有效期：超过之后不再提供重试，避免旧会话一直挂着按钮。 */
export const DEFAULT_RECOVERY_TTL_MS = 30 * 60 * 1000;

/**
 * 一条「可重试的中断」记录。
 */
class RecoveryEntry {
  /**
   * @param {string} sessionId - 会话 id。
   * @param {{ turn: number | undefined, at: number }} info - 中断信息。
   */
  constructor(sessionId, info) {
    this.sessionId = sessionId;
    this.turn = info.turn;
    this.at = info.at;
  }

  /**
   * 序列化给浏览器半。
   *
   * @param {number} now - 当前时间戳。
   * @returns {{ sessionId: string, turn: number | undefined, ageMs: number }} 快照。
   */
  snapshot(now) {
    return {
      sessionId: this.sessionId,
      turn: this.turn,
      ageMs: Math.max(0, now - this.at),
    };
  }
}

/**
 * 每个会话至多一条的「刚被用户中断、可重试」记录。
 */
export class RecoveryStore {
  /** @type {Map<string, RecoveryEntry>} */
  #entries = new Map();

  /** @type {number} */
  #ttlMs;

  /** @type {() => number} */
  #now;

  /**
   * @param {{ ttlMs?: number, now?: () => number }} [options] - 有效期与时钟。
   */
  constructor(options = {}) {
    this.#ttlMs =
      Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? Math.trunc(options.ttlMs) : DEFAULT_RECOVERY_TTL_MS;
    this.#now = typeof options.now === 'function' ? options.now : () => Date.now();
  }

  /** 有效期（毫秒）。 */
  get ttlMs() {
    return this.#ttlMs;
  }

  /** 当前记录条数（诊断用）。 */
  get size() {
    return this.#entries.size;
  }

  /**
   * 记住一次用户中断。
   *
   * @param {string} sessionId - 会话 id。
   * @param {{ turn: number | undefined }} info - 被中断的轮次。
   * @returns {void}
   */
  remember(sessionId, info) {
    this.#entries.set(sessionId, new RecoveryEntry(sessionId, { turn: info?.turn, at: this.#now() }));
  }

  /**
   * 读当前记录（已过期则顺手清掉）。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {{ sessionId: string, turn: number | undefined, ageMs: number } | undefined} 快照。
   */
  peek(sessionId) {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) return undefined;
    const now = this.#now();
    if (now - entry.at > this.#ttlMs) {
      this.#entries.delete(sessionId);
      return undefined;
    }
    return entry.snapshot(now);
  }

  /**
   * 取出并清掉记录（用户点了重试，用掉一次）。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {{ sessionId: string, turn: number | undefined, ageMs: number } | undefined} 快照。
   */
  take(sessionId) {
    const snapshot = this.peek(sessionId);
    this.#entries.delete(sessionId);
    return snapshot;
  }

  /**
   * 忘掉某会话的记录（新的一轮开始 / 用户发了新消息 / 收尾不是用户中断）。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {void}
   */
  forget(sessionId) {
    this.#entries.delete(sessionId);
  }

  /**
   * 清空所有记录（插件卸载）。
   *
   * @returns {void}
   */
  clear() {
    this.#entries.clear();
  }
}
