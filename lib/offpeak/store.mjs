/**
 * 「谷峰会话」的每会话启用状态存储。
 *
 * ## 存什么
 *
 * 只有一张表：`sessionId → { enabled, updatedAt }`。**不存会话内容、不存运行时状态**
 * （hold / interrupted 这类标记是进程内的，重启后按"峰时就该暂停"重新推导即可）。
 *
 * `defaultEnabled` 只在**没有显式记录**的会话上生效——用户手动开/关过的会话永远按记录走，
 * 这样"新会话默认启用"与"我明确关掉这个会话"不会互相打架。
 *
 * ## 文件与写盘
 *
 * `<DSH_HOME>/dsh-session-enhance/offpeak.json`，原子写（同目录临时文件 + `rename`）。
 * 容量上限默认 500 条，超出按 `updatedAt` 淘汰最旧的——这张表只用于"用户偏好"，
 * 老会话的记录丢了也只会回落到 `defaultEnabled`，不会丢数据。
 *
 * ## 损坏容忍
 *
 * 文件读不出来（JSON 坏了、半个写入、权限问题）时：
 *
 * - **不抛错**：插件照常激活，内存里从空表开始；
 * - 记下 `corrupt` 与原始错误，RPC 的 `persisted` 变 false，`diag` 里能看到 `storeError`；
 * - 首次成功写盘前，把坏文件**备份**成 `<file>.corrupt-<时间戳>.bak`（只备份一次），
 *   不静默丢掉用户的偏好文件。
 *
 * 这与 `shares.json` 的策略不同：分享记录坏了要"拒绝写入以免覆盖用户数据"，
 * 而这里只是开关偏好——让用户能继续用（并在诊断里如实说明）比锁死更合适。
 *
 * @module dsh-session-enhance/lib/offpeak/store
 */

import fs from 'node:fs';
import path from 'node:path';

/** 磁盘格式版本；不兼容变更时递增。 */
export const STORE_VERSION = 1;

/** 默认容量上限（条）。 */
export const DEFAULT_MAX_ENTRIES = 500;

/** 本包（4.0+）的存储目录名，与 `shares.json` 共用。 */
const STORE_DIR_NAME = 'dsh-session-enhance';

/** 合法会话 id 的最小形状校验：非空字符串即可（会话 id 的格式不由本组件定义）。 */
function normalizeSessionId(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 谷峰状态文件路径。
 *
 * @param {string} dshHome - 已解析的 DSH_HOME（见 `lib/shares.mjs` 的 `resolveDshHome`）。
 * @returns {string} `offpeak.json` 的绝对路径。
 */
export function offpeakStateFilePath(dshHome) {
  return path.join(dshHome, STORE_DIR_NAME, 'offpeak.json');
}

/**
 * 创建谷峰会话状态存储。
 *
 * @param {object} options - 依赖。
 * @param {string} options.storeFile - 状态文件绝对路径。
 * @param {number} [options.maxEntries] - 容量上限（默认 500）。
 * @param {() => number} [options.now] - 时钟（单测注入）。
 * @returns {any} 存储对象。
 */
export function createOffpeakStore(options) {
  const storeFile = options.storeFile;
  const maxEntries =
    Number.isFinite(options.maxEntries) && options.maxEntries > 0
      ? Math.max(1, Math.trunc(options.maxEntries))
      : DEFAULT_MAX_ENTRIES;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  /** @type {Map<string, { enabled: boolean, updatedAt: number }>} */
  let records = new Map();
  let loaded = false;
  /** 读/解析失败：只在诊断与 `persisted` 上体现，不阻止写入。 */
  let loadError = null;
  /** 解析失败时保留的原始文本（首次写盘前备份）。 */
  let corruptText = null;
  let corruptBackupTried = false;
  let corrupt = false;
  /** 最近一次写盘失败。 */
  let writeError = null;

  /**
   * 从磁盘原文解析出记录表（宽松清洗：坏条目跳过，不整体失败）。
   *
   * @param {string} text - 文件文本。
   * @returns {Map<string, { enabled: boolean, updatedAt: number }>} 记录表。
   */
  function parseState(text) {
    const parsed = JSON.parse(text.replace(/^\uFEFF/u, ''));
    const rawSessions =
      parsed !== null && typeof parsed === 'object' && parsed.sessions !== null && typeof parsed.sessions === 'object'
        ? parsed.sessions
        : {};
    const next = new Map();
    for (const [sessionId, value] of Object.entries(rawSessions)) {
      const id = normalizeSessionId(sessionId);
      if (id === undefined) continue;
      if (value === null || typeof value !== 'object') continue;
      const record = /** @type {any} */ (value);
      if (typeof record.enabled !== 'boolean') continue;
      next.set(id, {
        enabled: record.enabled,
        updatedAt:
          typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : now(),
      });
    }
    return next;
  }

  /** 惰性加载：只执行一次。 */
  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    let text;
    try {
      text = fs.readFileSync(storeFile, 'utf8');
    } catch (error) {
      if (error !== null && typeof error === 'object' && /** @type {any} */ (error).code === 'ENOENT') return;
      loadError = error instanceof Error ? error : new Error(String(error));
      return;
    }
    try {
      records = parseState(text);
    } catch (error) {
      corrupt = true;
      corruptText = text;
      loadError = new Error(
        `谷峰会话状态文件无法解析，已从空状态继续（下次写入前会先备份坏文件）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 首次写盘前备份损坏的旧文件（best-effort，失败不影响写入）。
   *
   * @param {number} at - 时间戳（用于文件名）。
   * @returns {void}
   */
  function backupCorruptFile(at) {
    if (corruptText === null || corruptBackupTried) return;
    corruptBackupTried = true;
    const backupFile = `${storeFile}.corrupt-${at}.bak`;
    try {
      fs.mkdirSync(path.dirname(storeFile), { recursive: true });
      fs.writeFileSync(backupFile, corruptText, 'utf8');
      corruptText = null;
    } catch {
      // 备份失败不影响主流程：坏文件内容已经在内存里，且下次写入会覆盖它。
    }
  }

  /**
   * 原子写盘。
   *
   * @returns {{ persisted: boolean, error: Error | null }} 写盘结果。
   */
  function persist() {
    const stamp = now();
    backupCorruptFile(stamp);
    try {
      fs.mkdirSync(path.dirname(storeFile), { recursive: true });
      const serialized = {
        version: STORE_VERSION,
        sessions: Object.fromEntries(records),
      };
      const temporary = `${storeFile}.${process.pid}.${stamp}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, storeFile);
      writeError = null;
      return { persisted: true, error: null };
    } catch (error) {
      writeError = error instanceof Error ? error : new Error(String(error));
      return { persisted: false, error: writeError };
    }
  }

  /**
   * 容量淘汰：按 `updatedAt` 升序淘汰最旧的记录。
   *
   * @returns {string[]} 被淘汰的会话 id。
   */
  function evictOverflow() {
    if (records.size <= maxEntries) return [];
    const ordered = [...records.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const evicted = [];
    for (const [sessionId] of ordered.slice(0, records.size - maxEntries)) {
      records.delete(sessionId);
      evicted.push(sessionId);
    }
    return evicted;
  }

  return {
    /** 状态文件位置（诊断用）。 */
    storeFile,

    /** 容量上限。 */
    maxEntries,

    /** 是否有损坏文件被容忍（诊断用）。 */
    get corrupt() {
      ensureLoaded();
      return corrupt;
    },

    /** 当前记录条数。 */
    get size() {
      ensureLoaded();
      return records.size;
    },

    /**
     * 当前的读/写错误（没有则 null）。
     *
     * 读错误会让 `persisted` 为 false；写错误同理。第一次成功写盘后写错误清除，
     * 但损坏读错误保留（它描述的是磁盘上那个坏文件，不应被后续写入抹掉）。
     *
     * @returns {Error | null} 错误或 null。
     */
    error() {
      ensureLoaded();
      if (loadError !== null) return loadError;
      return writeError;
    },

    /**
     * 某会话的显式记录。
     *
     * @param {string} sessionId - 会话 id。
     * @returns {{ enabled: boolean, updatedAt: number } | undefined} 记录。
     */
    get(sessionId) {
      ensureLoaded();
      const id = normalizeSessionId(sessionId);
      return id === undefined ? undefined : records.get(id);
    },

    /**
     * 某会话是否启用（无显式记录时回落到 `defaultEnabled`）。
     *
     * @param {string} sessionId - 会话 id。
     * @param {boolean} defaultEnabled - 默认值。
     * @returns {boolean} 是否启用。
     */
    isEnabled(sessionId, defaultEnabled) {
      const record = this.get(sessionId);
      return record === undefined ? defaultEnabled === true : record.enabled;
    },

    /**
     * 某会话的启用状态来源。
     *
     * @param {string} sessionId - 会话 id。
     * @returns {'session' | 'default'} 来源。
     */
    sourceOf(sessionId) {
      return this.get(sessionId) === undefined ? 'default' : 'session';
    },

    /**
     * 写入一条显式记录并落盘。
     *
     * 写盘失败**不抛错**：返回 `{ persisted: false, error }`，由调用方把 `persisted`
     * 透传给界面（用户开关照常生效，只是重启后会回落到默认值）。
     *
     * @param {string} sessionId - 会话 id。
     * @param {boolean} enabled - 是否启用。
     * @returns {{ persisted: boolean, error: Error | null, evicted: string[] }} 写盘结果与被淘汰的会话。
     */
    setEnabled(sessionId, enabled) {
      ensureLoaded();
      const id = normalizeSessionId(sessionId);
      if (id === undefined) throw new Error('缺少 sessionId');
      records.set(id, { enabled: enabled === true, updatedAt: now() });
      const evicted = evictOverflow();
      const outcome = persist();
      return { ...outcome, evicted };
    },

    /**
     * 全部记录（`updatedAt` 新的在前）。
     *
     * @returns {Array<{ sessionId: string, enabled: boolean, updatedAt: number }>} 记录列表。
     */
    list() {
      ensureLoaded();
      return [...records.entries()]
        .map(([sessionId, record]) => ({ sessionId, ...record }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
  };
}
