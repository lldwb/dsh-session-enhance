/**
 * 「谷峰会话」的时间窗计算（纯函数）。
 *
 * ## 名词
 *
 * - **谷时（off-peak）**：配置里 `offPeakStart` → `offPeakEnd` 之间的时间窗（半开区间，
 *   起点含、终点不含）。谷时**不暂停**，会话照常跑。
 * - **峰时（peak）**：一天里除了谷时以外的时间。峰时里**已启用**的会话会被挂起
 *   （hold），模型请求既不会开始、排队中的提示留在 durable inbox 里等谷时释放。
 *
 * "谷峰会话"这个名字指的是「把会话放到谷时跑」：默认 00:30–08:30 是 DeepSeek 的
 * 优惠时段，其余时间是峰时。
 *
 * ## 为什么全部做成纯函数
 *
 * 时区换算是这类功能最容易出错、也最难在真实环境里复现的部分（跨午夜、月末、DST）。
 * 这里不读进程时钟、不碰定时器：时间一律由调用方传入（`nowMs`），于是单测可以
 * 钉死每一个边界。定时器与副作用都在 `controller.mjs`。
 *
 * ## 时区换算的做法
 *
 * 不依赖任何第三方库：
 *
 * 1. `zonedParts(ms, tz)`：用 `Intl.DateTimeFormat` 把某个时间戳投影成该时区的墙上时间；
 * 2. `zoneOffsetMs(ms, tz)`：墙上时间按 UTC 解释再减去原时间戳，得到该时区的偏移；
 * 3. `wallClockToEpoch(...)`：把墙上时间换回时间戳（偏移量迭代两次，DST 切换处也稳定）。
 *
 * 只有"下一次边界发生在哪个绝对时刻"需要它；判断"现在是不是谷时"只需要 1。
 *
 * @module dsh-session-enhance/lib/offpeak/window
 */

/** 默认谷时起点（含）。 */
export const DEFAULT_OFF_PEAK_START = '00:30';

/** 默认谷时终点（不含）。 */
export const DEFAULT_OFF_PEAK_END = '08:30';

/** 默认时区。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** 默认「新会话是否自动启用」。 */
export const DEFAULT_ENABLED = false;

/** `HH:MM` 的严格形式（24 小时制，00:00–23:59）。 */
export const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/u;

/** 一天的分钟数。 */
export const MINUTES_PER_DAY = 24 * 60;

/** 时区格式化器缓存（`Intl.DateTimeFormat` 构造很贵，而时区集合很小）。 */
const FORMATTERS = new Map();

/**
 * 取（或构造）某个时区的格式化器。
 *
 * 用 `hourCycle: 'h23'` 而不是 locale 默认，避免某些 locale 把午夜格式化成 `24:00`。
 *
 * @param {string} timeZone - IANA 时区名。
 * @returns {Intl.DateTimeFormat} 格式化器。
 */
function formatterFor(timeZone) {
  let formatter = FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * 解析 `HH:MM` 为「当天第几分钟」。
 *
 * @param {unknown} text - 待解析的字符串。
 * @returns {number | undefined} 0..1439，非法时 undefined（不做任何隐式纠正）。
 */
export function parseClock(text) {
  if (typeof text !== 'string') return undefined;
  const match = CLOCK_PATTERN.exec(text.trim());
  if (match === null) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * 把「当天第几分钟」格式化为 `HH:MM`。
 *
 * @param {number} minutes - 0..1439。
 * @returns {string} `HH:MM`。
 */
export function formatClock(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * 时区名是否被运行时接受。
 *
 * 只做「`Intl` 能否构造出格式化器」这一件事：`Asia/Shanghai`、`UTC`、`Etc/GMT-8`
 * 都合法，`Shanghai`、空串、非字符串都不合法。
 *
 * @param {unknown} timeZone - 待校验的时区名。
 * @returns {boolean} 合法则 true。
 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string') return false;
  const trimmed = timeZone.trim();
  if (trimmed === '') return false;
  try {
    formatterFor(trimmed).format(0);
    return true;
  } catch {
    // 非法时区：Intl 抛 RangeError。从缓存里删掉，避免留下半初始化的条目。
    FORMATTERS.delete(trimmed);
    return false;
  }
}

/**
 * 把时间戳投影成某时区的墙上时间。
 *
 * @param {number} nowMs - 时间戳（毫秒）。
 * @param {string} timeZone - 合法 IANA 时区名。
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }} 墙上时间。
 */
export function zonedParts(nowMs, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(nowMs));
  /** @type {Record<string, string>} */
  const fields = {};
  for (const part of parts) {
    if (part.type !== 'literal') fields[part.type] = part.value;
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second),
  };
}

/**
 * 某时刻在该时区的 UTC 偏移量（毫秒，东八区为 +8h）。
 *
 * @param {number} nowMs - 时间戳（毫秒）。
 * @param {string} timeZone - 合法 IANA 时区名。
 * @returns {number} 偏移毫秒数。
 */
export function zoneOffsetMs(nowMs, timeZone) {
  const parts = zonedParts(nowMs, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(nowMs / 1000) * 1000;
}

/**
 * 把「某时区的墙上时间」换回绝对时间戳。
 *
 * 偏移量迭代两次：第一次用近似偏移，第二次用近似时刻的真实偏移（DST 切换处也收敛）。
 * 遇到不存在的墙上时间（春季跳过的 1 小时）时返回一个邻近的合法时刻，不做抛错——
 * 这类边界只影响"下一次切换"的定时器精度，`reconcile` 的一秒轮询会兜住。
 *
 * @param {{ year: number, month: number, day: number, hour: number, minute: number }} wall - 墙上时间（月为 1..12）。
 * @param {string} timeZone - 合法 IANA 时区名。
 * @returns {number} 时间戳（毫秒）。
 */
export function wallClockToEpoch(wall, timeZone) {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
  let epoch = naive - zoneOffsetMs(naive, timeZone);
  for (let round = 0; round < 2; round += 1) {
    epoch = naive - zoneOffsetMs(epoch, timeZone);
  }
  return epoch;
}

/**
 * 某时刻在该时区的「当天第几分钟」。
 *
 * @param {number} nowMs - 时间戳（毫秒）。
 * @param {string} timeZone - 合法 IANA 时区名。
 * @returns {number} 0..1439。
 */
export function minutesOfDay(nowMs, timeZone) {
  const parts = zonedParts(nowMs, timeZone);
  return parts.hour * 60 + parts.minute;
}

/**
 * 「当天第几分钟」是否落在时间窗内（半开区间，支持跨午夜）。
 *
 * @param {number} minutes - 0..1439。
 * @param {number} startMinutes - 窗口起点（含）。
 * @param {number} endMinutes - 窗口终点（不含）。
 * @returns {boolean} 在窗内则 true；起点等于终点（空窗）恒为 false。
 */
export function isInWindow(minutes, startMinutes, endMinutes) {
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return minutes >= startMinutes && minutes < endMinutes;
  // 跨午夜：22:00 → 06:00 这类。
  return minutes >= startMinutes || minutes < endMinutes;
}

/**
 * 某时刻是否处于谷时。
 *
 * @param {number} nowMs - 时间戳（毫秒）。
 * @param {{ startMinutes: number, endMinutes: number, timeZone: string }} window - 已归一化的窗口。
 * @returns {boolean} 谷时则 true。
 */
export function isOffPeakAt(nowMs, window) {
  return isInWindow(minutesOfDay(nowMs, window.timeZone), window.startMinutes, window.endMinutes);
}

/**
 * 从某个时刻起，下一次相位切换的绝对时刻与方向。
 *
 * @param {number} nowMs - 时间戳（毫秒）。
 * @param {{ startMinutes: number, endMinutes: number, timeZone: string }} window - 已归一化的窗口。
 * @returns {{ at: number, kind: 'pause' | 'resume', msUntil: number }} `kind` 是"到达那一刻会发生什么"：
 *   谷时 ⇒ 该切峰（`pause`）；峰时 ⇒ 该入谷（`resume`）。
 */
export function nextBoundary(nowMs, window) {
  const offPeak = isOffPeakAt(nowMs, window);
  const kind = offPeak ? 'pause' : 'resume';
  const targetMinutes = offPeak ? window.endMinutes : window.startMinutes;
  const parts = zonedParts(nowMs, window.timeZone);
  const nowMinutes = parts.hour * 60 + parts.minute;
  // 边界分钟不在"未来"就顺延一天（相等也算过去：这是下一个自然日的同一条边界）。
  const dayOffset = targetMinutes <= nowMinutes ? 1 : 0;
  const at = wallClockToEpoch(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day + dayOffset,
      hour: Math.floor(targetMinutes / 60),
      minute: targetMinutes % 60,
    },
    window.timeZone,
  );
  return { at, kind, msUntil: at - nowMs };
}

/**
 * 归一化一份谷时窗口配置：非法字段各自回退默认值，并把原因记进 `issues`。
 *
 * 不抛错：配置错不该让组件不激活，最坏结果是"按默认窗口工作"。
 *
 * @param {{ offPeakStart?: unknown, offPeakEnd?: unknown, timeZone?: unknown }} [raw] - 原始配置。
 * @returns {{ start: string, end: string, startMinutes: number, endMinutes: number, timeZone: string, issues: string[] }} 归一化窗口。
 */
export function normalizeWindow(raw = {}) {
  /** @type {string[]} */
  const issues = [];

  // 缺失（undefined/null）视为"没提供"，静默回退；只有**显式给了非法值**才记 issue。
  // 这样 `normalizeWindow({ timeZone: 'UTC' })` 这种只覆盖一个字段的调用不会刷三条噪音。
  let startMinutes;
  if (raw?.offPeakStart === undefined || raw?.offPeakStart === null) {
    startMinutes = /** @type {number} */ (parseClock(DEFAULT_OFF_PEAK_START));
  } else {
    startMinutes = parseClock(raw.offPeakStart);
    if (startMinutes === undefined) {
      issues.push(`offPeakStart ${JSON.stringify(raw.offPeakStart)} 不是合法的 HH:MM，回退 ${DEFAULT_OFF_PEAK_START}`);
      startMinutes = /** @type {number} */ (parseClock(DEFAULT_OFF_PEAK_START));
    }
  }

  let endMinutes;
  if (raw?.offPeakEnd === undefined || raw?.offPeakEnd === null) {
    endMinutes = /** @type {number} */ (parseClock(DEFAULT_OFF_PEAK_END));
  } else {
    endMinutes = parseClock(raw.offPeakEnd);
    if (endMinutes === undefined) {
      issues.push(`offPeakEnd ${JSON.stringify(raw.offPeakEnd)} 不是合法的 HH:MM，回退 ${DEFAULT_OFF_PEAK_END}`);
      endMinutes = /** @type {number} */ (parseClock(DEFAULT_OFF_PEAK_END));
    }
  }

  let timeZone;
  if (raw?.timeZone === undefined || raw?.timeZone === null) {
    timeZone = DEFAULT_TIME_ZONE;
  } else if (typeof raw.timeZone === 'string' && isValidTimeZone(raw.timeZone)) {
    timeZone = raw.timeZone.trim();
  } else {
    issues.push(`timeZone ${JSON.stringify(raw.timeZone)} 不是合法的 IANA 时区，回退 ${DEFAULT_TIME_ZONE}`);
    timeZone = DEFAULT_TIME_ZONE;
  }

  if (startMinutes === endMinutes) {
    issues.push(`offPeakStart 与 offPeakEnd 相同（${formatClock(startMinutes)}）会让窗口为空，回退 ${DEFAULT_OFF_PEAK_START}–${DEFAULT_OFF_PEAK_END}`);
    startMinutes = /** @type {number} */ (parseClock(DEFAULT_OFF_PEAK_START));
    endMinutes = /** @type {number} */ (parseClock(DEFAULT_OFF_PEAK_END));
  }

  return {
    start: formatClock(startMinutes),
    end: formatClock(endMinutes),
    startMinutes,
    endMinutes,
    timeZone,
    issues,
  };
}

/**
 * 归一化整份谷峰配置（窗口 + `defaultEnabled`）。
 *
 * @param {{ offPeakStart?: unknown, offPeakEnd?: unknown, timeZone?: unknown, defaultEnabled?: unknown }} [raw] - 原始配置。
 * @returns {{ window: ReturnType<typeof normalizeWindow>, defaultEnabled: boolean, issues: string[] }} 归一化配置。
 */
export function normalizeSchedule(raw = {}) {
  const window = normalizeWindow(raw);
  /** @type {string[]} */
  const issues = [...window.issues];
  let defaultEnabled = DEFAULT_ENABLED;
  if (raw?.defaultEnabled === true || raw?.defaultEnabled === false) {
    defaultEnabled = raw.defaultEnabled;
  } else if (raw?.defaultEnabled !== undefined && raw?.defaultEnabled !== null) {
    issues.push(`defaultEnabled ${JSON.stringify(raw.defaultEnabled)} 不是布尔值，回退 ${DEFAULT_ENABLED}`);
  }
  return { window, defaultEnabled, issues };
}
