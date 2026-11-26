/**
 * 法定节假日的**自动更新**（纯逻辑 + 一个网络抓取入口，不依赖任何 AI）。
 *
 * ## 为什么需要它
 *
 * 国务院办公厅每年 11 月前后发布次年的放假安排，本组件原先把 2026/2027 的日期硬编码在
 * `window.mjs` 里——再往后就得人工改代码发版。这里改成：启动后（以及每 6 小时）由插件
 * 自己从公开数据源抓当年/次年的节假日表，缓存到 DSH_HOME，失败就继续用内置表。
 *
 * ## 数据源（按顺序尝试，任一成功即停）
 *
 * 1. `timor.tech`：免费、无需 key，`/api/holiday/year/<年>/` 返回全年条目
 *    （`holiday: true` = 休息日，`false` = 调休补班，补班这里不用）；
 * 2. `holiday-cn`（GitHub `NateScarlet/holiday-cn`，每日抓取国务院公告）：jsDelivr 与
 *    raw.githubusercontent 两个镜像，数据是 `days[]`，`isOffDay: true` 才是休息日。
 *
 * 第三方服务都可能故障，所以：**失败不改变任何行为**（继续用内置/上次缓存），且结果要过
 * 结构校验（年份必须匹配、日期必须是真实日历日、天数在合理区间）。
 *
 * ## 缓存
 *
 * `<DSH_HOME>/dsh-session-enhance/holidays-cache.json`，形如
 * `{ version: 1, fetchedAt, source, years: { '2027': ['2027-01-01', ...] } }`。
 * 7 天内视为新鲜，不再请求；跨年后「当年」缺失会触发一次刷新。定时器每天只做一次
 * **本地**检查（比较 `fetchedAt`），只有超过 7 天才真正发网络请求。
 *
 * @module dsh-session-enhance/lib/offpeak/holidays-fetch
 */

import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_HOLIDAYS_TEXT } from './window.mjs';

/** 缓存格式版本（结构不兼容时整份丢弃，重新抓取）。 */
export const HOLIDAY_CACHE_VERSION = 1;

/**
 * 缓存多久视为过期。
 *
 * 官方放假安排一年只发布一次（国务院通常在 11 月前后发次年通知），没必要高频复查：
 * 这里取 **7 天**——公告发布后最多一周内就能拿到，而全年实际网络请求只有几十次。
 */
export const HOLIDAY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 单次 HTTP 请求超时（毫秒）。 */
export const HOLIDAY_FETCH_TIMEOUT_MS = 8_000;

/** 一年节假日天数的合理区间（法定节假日通常 20~35 天；明显越界说明数据源异常）。 */
export const MIN_HOLIDAY_DAYS = 10;
export const MAX_HOLIDAY_DAYS = 60;

/** `YYYY-MM-DD` 的严格形式。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * 数据源列表（按可靠性/可达性排序）。
 *
 * `parse` 接收已解析的 JSON 与目标年份，返回 `YYYY-MM-DD[]`（休息日）。
 */
export const HOLIDAY_SOURCES = [
  {
    id: 'timor',
    url: (year) => `https://timor.tech/api/holiday/year/${year}/`,
    parse: parseTimorPayload,
  },
  {
    id: 'holiday-cn-jsdelivr',
    url: (year) => `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
    parse: parseHolidayCnPayload,
  },
  {
    id: 'holiday-cn-github',
    url: (year) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
    parse: parseHolidayCnPayload,
  },
];

/**
 * 判断一个字符串是否是真实存在的日历日（`YYYY-MM-DD`）。
 *
 * @param {unknown} text - 待校验文本。
 * @returns {boolean} 合法则 true。
 */
export function isValidHolidayDate(text) {
  if (typeof text !== 'string' || !DATE_PATTERN.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === text;
}

/**
 * 把一组候选日期清洗成「该年份内的合法日期、去重、升序」。
 *
 * @param {unknown} dates - 候选日期数组。
 * @param {number} year - 目标年份（日期必须以它开头）。
 * @returns {string[]} 清洗后的日期。
 */
export function sanitizeHolidayDates(dates, year) {
  if (!Array.isArray(dates)) return [];
  const prefix = `${year}-`;
  /** @type {Set<string>} */
  const unique = new Set();
  for (const entry of dates) {
    if (typeof entry !== 'string') continue;
    const text = entry.trim();
    if (!text.startsWith(prefix)) continue;
    if (!isValidHolidayDate(text)) continue;
    unique.add(text);
  }
  return [...unique].sort();
}

/**
 * 解析 timor.tech 的年度响应。
 *
 * @param {any} payload - `{ code: 0, holiday: { '01-01': { holiday: true, date: '2027-01-01' } } }`。
 * @param {number} year - 目标年份。
 * @returns {string[]} 休息日日期。
 */
export function parseTimorPayload(payload, year) {
  const table = payload !== null && typeof payload === 'object' ? payload.holiday : null;
  if (table === null || typeof table !== 'object') return [];
  /** @type {string[]} */
  const dates = [];
  for (const entry of Object.values(table)) {
    if (entry === null || typeof entry !== 'object') continue;
    // holiday:false 是调休补班（要上班），不参与「节假日豁免」。
    if (entry.holiday !== true) continue;
    const date = typeof entry.date === 'string' ? entry.date : undefined;
    if (date !== undefined) dates.push(date);
  }
  return sanitizeHolidayDates(dates, year);
}

/**
 * 解析 holiday-cn 的年度响应。
 *
 * @param {any} payload - `{ year: 2027, days: [{ date: '2027-01-01', isOffDay: true }] }`。
 * @param {number} year - 目标年份。
 * @returns {string[]} 休息日日期。
 */
export function parseHolidayCnPayload(payload, year) {
  const days = payload !== null && typeof payload === 'object' ? payload.days : null;
  if (!Array.isArray(days)) return [];
  /** @type {string[]} */
  const dates = [];
  for (const entry of days) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.isOffDay !== true) continue;
    if (typeof entry.date === 'string') dates.push(entry.date);
  }
  return sanitizeHolidayDates(dates, year);
}

/**
 * 校验一份抓取结果：年份内合法日期数量必须在合理区间。
 *
 * @param {string[]} dates - 清洗后的日期。
 * @returns {boolean} 可用则 true。
 */
export function isPlausibleHolidayTable(dates) {
  return Array.isArray(dates) && dates.length >= MIN_HOLIDAY_DAYS && dates.length <= MAX_HOLIDAY_DAYS;
}

/**
 * 从数据源抓某一年的节假日表（按 `HOLIDAY_SOURCES` 顺序回退）。
 *
 * 每个源都过「结构校验 + 天数校验」，全部失败返回 `null`（调用方保留内置/缓存值）。
 *
 * @param {number} year - 目标年份（如 2027）。
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, logger?: any }} [options] - 注入项（单测用）。
 * @returns {Promise<{ dates: string[], source: string } | null>} 结果或 null。
 */
export async function fetchHolidayYear(year, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : HOLIDAY_FETCH_TIMEOUT_MS;

  for (const source of HOLIDAY_SOURCES) {
    const url = source.url(year);
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          signal: controller === null ? undefined : controller.signal,
          headers: { accept: 'application/json' },
        });
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      if (response === null || typeof response !== 'object' || response.ok !== true) continue;
      const payload = await response.json();
      const dates = source.parse(payload, year);
      if (!isPlausibleHolidayTable(dates)) continue;
      return { dates, source: source.id };
    } catch (error) {
      options.logger?.debug?.(
        `[dsh-session-enhance/offpeak] holiday source ${source.id} failed for ${year}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return null;
}

/**
 * 节假日缓存文件路径（与 shares.json / offpeak.json 同目录）。
 *
 * @param {string} dshHome - 已解析的 DSH_HOME。
 * @returns {string} 绝对路径。
 */
export function holidayCacheFilePath(dshHome) {
  return path.join(dshHome, 'dsh-session-enhance', 'holidays-cache.json');
}

/**
 * 读缓存；文件缺失/损坏/版本不符都返回空缓存（不抛错）。
 *
 * @param {string} file - 缓存文件路径。
 * @returns {{ fetchedAt: number, source: string | null, years: Map<number, string[]> }} 缓存。
 */
export function loadHolidayCache(file) {
  /** @type {Map<number, string[]>} */
  const years = new Map();
  const empty = { fetchedAt: 0, source: null, years };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return empty;
  }
  if (raw === null || typeof raw !== 'object' || raw.version !== HOLIDAY_CACHE_VERSION) return empty;
  const fetchedAt = typeof raw.fetchedAt === 'number' && Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0;
  const source = typeof raw.source === 'string' ? raw.source : null;
  const table = raw.years !== null && typeof raw.years === 'object' ? raw.years : {};
  for (const [key, value] of Object.entries(table)) {
    const year = Number(key);
    if (!Number.isInteger(year)) continue;
    const dates = sanitizeHolidayDates(value, year);
    if (!isPlausibleHolidayTable(dates)) continue;
    years.set(year, dates);
  }
  return { fetchedAt, source, years };
}

/**
 * 写缓存（目录不存在则创建；失败静默——缓存只是加速，不影响判定）。
 *
 * @param {string} file - 缓存文件路径。
 * @param {{ fetchedAt: number, source: string | null, years: Map<number, string[]> }} cache - 缓存。
 * @returns {void}
 */
export function saveHolidayCache(file, cache) {
  /** @type {Record<string, string[]>} */
  const years = {};
  for (const [year, dates] of cache.years) years[String(year)] = dates;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ version: HOLIDAY_CACHE_VERSION, fetchedAt: cache.fetchedAt, source: cache.source, years }, null, 2)}\n`,
      'utf8'
    );
  } catch {
    // 缓存写失败不影响功能。
  }
}

/**
 * 合并「配置里的节假日」与「自动抓取的节假日」。
 *
 * 规则（用户显式配置优先）：
 * - `autoHolidays !== true` → 用配置值；
 * - 配置值**等于内置默认表**（用户没改过）→ 内置表 ∪ 抓取结果（抓取结果对同一年覆盖内置）；
 * - 配置值被改过（含空串 = 不豁免）→ **只用配置值**，自动更新不覆盖用户意图。
 *
 * @param {{ configText: string, autoHolidays: boolean, autoYears: Map<number, string[]> }} input - 输入。
 * @returns {{ text: string, auto: boolean }} 生效的节假日文本与是否用了自动数据。
 */
export function resolveHolidaysText({ configText, autoHolidays, autoYears }) {
  if (autoHolidays !== true) return { text: configText, auto: false };
  const customized = configText !== DEFAULT_HOLIDAYS_TEXT;
  if (customized) return { text: configText, auto: false };
  if (autoYears.size === 0) return { text: configText, auto: false };

  /** @type {Set<string>} */
  const years = new Set(configText.split(',').filter((entry) => entry !== ''));
  const merged = new Set(years);
  for (const dates of autoYears.values()) {
    for (const date of dates) merged.add(date);
  }
  return { text: [...merged].sort().join(','), auto: true };
}
