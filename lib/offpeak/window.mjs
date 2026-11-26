/**
 * 「梁谷」的时间判定（纯函数）。
 *
 * ## 名词与官方口径
 *
 * - **高峰时段（peak）**：北京时间**周一至周五**（不含中国法定节假日）的
 *   **09:00–12:00** 与 **14:00–18:00**。高峰时段里**已启用**的会话会被挂起（hold），
 *   模型请求既不会开始、排队中的提示留在 durable inbox 里等空闲时段释放。
 * - **空闲时段（idle）**：除高峰以外的全部时间——每天 12:00–14:00 午休、18:00–次日 09:00、
 *   **周末全天**、**法定节假日全天**。空闲时段不暂停，会话照常跑。
 *
 * 也就是说「梁谷」= 让会话在高价的高峰时段休息、在便宜的空闲时段干活（谷 = 山谷，
 * 指价格/时段低谷）。组件名「梁谷」是用户定的名字，模块名仍是 `offpeak`（历史原因，保留）。
 *
 * ## 为什么全部做成纯函数
 *
 * 时区换算 + 「工作日/节假日」两张日历叠加，是这类功能最容易出错、也最难在真实环境里
 * 复现的部分（跨午夜、跨周、节假日后的恢复、DST）。这里不读进程时钟、不碰定时器：
 * 时间一律由调用方传入（`nowMs`），于是单测可以钉死每一个边界。定时器与副作用都在
 * `controller.mjs`。
 *
 * ## 时区换算的做法
 *
 * 不依赖任何第三方库：
 *
 * 1. `zonedParts(ms, tz)`：用 `Intl.DateTimeFormat` 把某个时间戳投影成该时区的墙上时间；
 * 2. `zoneOffsetMs(ms, tz)`：墙上时间按 UTC 解释再减去原时间戳，得到该时区的偏移；
 * 3. `wallClockToEpoch(...)`：把墙上时间换回时间戳（偏移量迭代两次，DST 切换处也稳定）。
 *
 * 只有"下一次边界发生在哪个绝对时刻"需要它；判断"现在是不是高峰"只需要 1。
 *
 * @module dsh-session-enhance/lib/offpeak/window
 */

/** 默认高峰时段：工作日上午 09:00–12:00、下午 14:00–18:00。 */
export const DEFAULT_PEAK_WINDOWS = '09:00-12:00,14:00-18:00';

/** 默认时区。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/**
 * 中国法定节假日（2026 + 2027，依据国务院办公厅通知）。
 *
 * 周末本来就是全天空闲，把落在周末的日期列全不影响判定（判定顺序：周末 → 节假日 →
 * 高峰窗口），但保持与官方通知一致便于人工核对。
 *
 * - **2026**（国办发明电〔2025〕7号）：元旦 01-01..01-03；春节 02-15..02-23；
 *   清明 04-04..04-06；劳动 05-01..05-05；端午 06-19..06-21；中秋 09-25..09-27；
 *   国庆 10-01..10-07（共 33 天）。
 * - **2027**（国办发明电〔2026〕10号，2026-11-05 发布）：元旦 01-01..01-03；
 *   春节 02-05..02-13；清明 04-03..04-05；劳动 05-01..05-05；端午 06-09（单日）；
 *   中秋 09-15（单日）；国庆 10-01..10-07（共 29 天）。
 *
 * 注意：调休补班的周末**不算工作日**——本插件按官方口径「周一至周五（不含法定节假日）」
 * 判高峰，补班的周六/周日仍是周末 → 空闲（用户 2026-11-26 明确）。
 */
export const HOLIDAY_RANGES = [
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
  ['2027-01-01', '2027-01-03'],
  ['2027-02-05', '2027-02-13'],
  ['2027-04-03', '2027-04-05'],
  ['2027-05-01', '2027-05-05'],
  ['2027-06-09', '2027-06-09'],
  ['2027-09-15', '2027-09-15'],
  ['2027-10-01', '2027-10-07'],
];

/**
 * 把 `[起, 止]` 闭区间展开成 `YYYY-MM-DD` 数组（UTC 日期，不受本地时区影响）。
 *
 * @param {string} from - 起始日期（含）。
 * @param {string} to - 结束日期（含）。
 * @returns {string[]} 日期列表。
 */
function expandDateRange(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  /** @type {string[]} */
  const dates = [];
  for (let cursor = start; cursor <= end; cursor += 24 * 60 * 60 * 1000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

/** 默认法定节假日日期表（`YYYY-MM-DD`，按日期升序、去重）。 */
export const DEFAULT_HOLIDAYS = [...new Set(HOLIDAY_RANGES.flatMap(([from, to]) => expandDateRange(from, to)))].sort();

/** 默认节假日配置文本（逗号分隔，Config 默认值由它生成）。 */
export const DEFAULT_HOLIDAYS_TEXT = DEFAULT_HOLIDAYS.join(',');

/** 默认「新会话是否自动启用」。 */
export const DEFAULT_ENABLED = false;

/** `HH:MM` 的严格形式（24 小时制，00:00–23:59）。 */
export const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/u;

/** `YYYY-MM-DD` 的严格形式。 */
export const HOLIDAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** 一天的分钟数。 */
export const MINUTES_PER_DAY = 24 * 60;

/** 找下一次边界时最多向后看多少天（节假日表填得再满也不该超过这个范围）。 */
export const MAX_BOUNDARY_SEARCH_DAYS = 400;

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
 * 墙上时间对应的日期字符串（`YYYY-MM-DD`，按该时区的日历日）。
 *
 * @param {{ year: number, month: number, day: number }} parts - 墙上时间。
 * @returns {string} `YYYY-MM-DD`。
 */
export function dateStringOf(parts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/**
 * 某个日历日是星期几（0=周日 … 6=周六）。
 *
 * 用 UTC 的中午做锚点算，避免本地时区/夏令时影响日期归属。
 *
 * @param {{ year: number, month: number, day: number }} parts - 墙上时间。
 * @returns {number} 0..6。
 */
export function weekdayOf(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0)).getUTCDay();
}

/**
 * 判断某个日期是否是周末。
 *
 * @param {{ year: number, month: number, day: number }} parts - 墙上时间。
 * @returns {boolean} 周六/周日则 true。
 */
export function isWeekend(parts) {
  const weekday = weekdayOf(parts);
  return weekday === 0 || weekday === 6;
}

/**
 * 把日期字符串偏移若干天（用于遍历未来的日历日）。
 *
 * @param {{ year: number, month: number, day: number }} parts - 基准墙上时间。
 * @param {number} days - 偏移天数（可为负）。
 * @returns {{ year: number, month: number, day: number }} 偏移后的日期。
 */
function shiftDays(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/**
 * 解析高峰时段配置文本（逗号分隔的 `HH:MM-HH:MM`）。
 *
 * 规则：起点含、终点不含；`起点 >= 终点` 视为非法（不跨午夜，因为官方口径是"当天两个
 * 上午/下午时段"，跨午夜对它没有意义）；非法条目逐条丢弃并记 issue，全部非法时回退默认。
 *
 * @param {unknown} text - 配置文本（如 `09:00-12:00,14:00-18:00`）。
 * @returns {{ windows: Array<{ start: string, end: string, startMinutes: number, endMinutes: number }>, text: string, issues: string[] }} 解析结果。
 */
export function parsePeakWindows(text) {
  /** @type {string[]} */
  const issues = [];
  const source = typeof text === 'string' ? text : text === undefined || text === null ? DEFAULT_PEAK_WINDOWS : String(text);
  /** @type {Array<{ start: string, end: string, startMinutes: number, endMinutes: number }>} */
  const windows = [];
  for (const rawSegment of source.split(',')) {
    const segment = rawSegment.trim();
    if (segment === '') continue;
    const dash = segment.indexOf('-');
    const startMinutes = dash < 0 ? undefined : parseClock(segment.slice(0, dash));
    const endMinutes = dash < 0 ? undefined : parseClock(segment.slice(dash + 1));
    if (startMinutes === undefined || endMinutes === undefined) {
      issues.push(`高峰时段片段 ${JSON.stringify(segment)} 不是合法的 HH:MM-HH:MM，已忽略`);
      continue;
    }
    if (startMinutes >= endMinutes) {
      issues.push(`高峰时段 ${segment} 的起点不早于终点，已忽略`);
      continue;
    }
    windows.push({
      start: formatClock(startMinutes),
      end: formatClock(endMinutes),
      startMinutes,
      endMinutes,
    });
  }
  if (windows.length === 0) {
    issues.push(`高峰时段配置为空或全部非法，回退默认 ${DEFAULT_PEAK_WINDOWS}`);
    for (const window of parsePeakWindows(DEFAULT_PEAK_WINDOWS).windows) windows.push(window);
  }
  windows.sort((left, right) => left.startMinutes - right.startMinutes);
  return { windows, text: windows.map((window) => `${window.start}-${window.end}`).join(','), issues };
}

/**
 * 判断一个日期字符串是否是真实存在的日历日。
 *
 * @param {string} text - `YYYY-MM-DD`。
 * @returns {boolean} 合法则 true。
 */
export function isValidDateString(text) {
  if (typeof text !== 'string') return false;
  const match = HOLIDAY_PATTERN.exec(text.trim());
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() + 1 === month && probe.getUTCDate() === day;
}

/**
 * 解析法定节假日配置（逗号/空白分隔的 `YYYY-MM-DD`，也接受数组）。
 *
 * 空串 = **不享受节假日豁免**（所有工作日都算高峰日）；非法日期丢弃并记 issue。
 *
 * @param {unknown} input - 配置值。
 * @returns {{ dates: Set<string>, text: string, issues: string[] }} 解析结果。
 */
export function parseHolidays(input) {
  /** @type {string[]} */
  const issues = [];
  /** @type {string[]} */
  const rawEntries = [];
  if (Array.isArray(input)) {
    for (const entry of input) rawEntries.push(String(entry));
  } else if (typeof input === 'string') {
    for (const entry of input.split(/[\s,]+/u)) rawEntries.push(entry);
  } else if (input !== undefined && input !== null) {
    issues.push(`节假日配置 ${JSON.stringify(input)} 不是字符串或数组，按空处理`);
  }
  /** @type {Set<string>} */
  const dates = new Set();
  for (const rawEntry of rawEntries) {
    const entry = rawEntry.trim();
    if (entry === '') continue;
    if (!isValidDateString(entry)) {
      issues.push(`节假日日期 ${JSON.stringify(entry)} 不是合法的 YYYY-MM-DD，已忽略`);
      continue;
    }
    dates.add(entry);
  }
  return { dates, text: [...dates].sort().join(','), issues };
}

/**
 * 某时刻是否处于高峰时段。
 *
 * 判定顺序（顺序即语义，不可交换）：
 *
 * 1. **周末**始终不是高峰（即使它落在某个"调休上班"的日期上，官方口径是周一至周五）；
 * 2. 日期在**法定节假日**表里 → 不是高峰；
 * 3. 否则，当天分钟数命中**任一**高峰窗口 → 是高峰。
 *
 * @param {number} nowMs - 时间戳（毫秒）。
 * @param {{ peakWindows: Array<{ startMinutes: number, endMinutes: number }>, timeZone: string, holidays: Set<string> }} sched - 归一化配置。
 * @returns {boolean} 高峰则 true。
 */
export function isPeakAt(nowMs, sched) {
  const parts = zonedParts(nowMs, sched.timeZone);
  if (isWeekend(parts)) return false;
  if (sched.holidays.has(dateStringOf(parts))) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return sched.peakWindows.some((window) => minutes >= window.startMinutes && minutes < window.endMinutes);
}

/**
 * 从某个时刻起，下一次"高峰/空闲"切换的绝对时刻与方向。
 *
 * 遍历未来的日历日（最多 `MAX_BOUNDARY_SEARCH_DAYS` 天），只看**高峰日**（工作日且非
 * 节假日）的窗口起点/终点，取严格大于 `now` 的最小者：
 *
 * - 落在**窗口起点** → `pause`（即将进入高峰，该挂起会话）；
 * - 落在**窗口终点** → `resume`（即将进入空闲，该释放会话）。
 *
 * 于是「周五 18:00 之后」的自然答案是下周一 09:00（周末整天空闲，没有边界）；
 * 「某个节假日最后一天 18:00 之后」是节后第一个工作日 09:00。
 *
 * @param {number} nowMs - 时间戳（毫秒）。
 * @param {{ peakWindows: Array<any>, timeZone: string, holidays: Set<string> }} sched - 归一化配置。
 * @returns {{ at: number | null, kind: 'pause' | 'resume' | null, msUntil: number | null }} 下一次切换。
 */
export function nextBoundary(nowMs, sched) {
  const today = zonedParts(nowMs, sched.timeZone);
  /** @type {{ at: number, kind: 'pause' | 'resume' } | null} */
  let best = null;
  for (let dayOffset = 0; dayOffset <= MAX_BOUNDARY_SEARCH_DAYS; dayOffset += 1) {
    const date = shiftDays(today, dayOffset);
    if (isWeekend(date)) continue;
    if (sched.holidays.has(dateStringOf(date))) continue;
    for (const window of sched.peakWindows) {
      const startAt = wallClockToEpoch(
        { year: date.year, month: date.month, day: date.day, hour: Math.floor(window.startMinutes / 60), minute: window.startMinutes % 60 },
        sched.timeZone,
      );
      const endAt = wallClockToEpoch(
        { year: date.year, month: date.month, day: date.day, hour: Math.floor(window.endMinutes / 60), minute: window.endMinutes % 60 },
        sched.timeZone,
      );
      for (const [at, kind] of [[startAt, 'pause'], [endAt, 'resume']]) {
        if (at <= nowMs) continue;
        if (best === null || at < best.at) best = { at, kind };
      }
    }
    // 当前这一天已经给出了候选：再往后的日子不可能更早，直接结束。
    if (best !== null) break;
  }
  if (best === null) return { at: null, kind: null, msUntil: null };
  return { at: best.at, kind: best.kind, msUntil: best.at - nowMs };
}

/**
 * 归一化整份时间配置：非法字段各自回退默认值，并把原因记进 `issues`。
 *
 * 不抛错：配置错不该让组件不激活，最坏结果是"按默认的高峰时段/2026 节假日工作"。
 *
 * 缺失（`undefined`/`null`）视为"没提供"，静默回退；只有**显式给了非法值**才记 issue。
 * 唯一的例外是 `holidays` 的空串：它是**合法**配置，含义是"不享受节假日豁免"。
 *
 * @param {{ peakWindows?: unknown, timeZone?: unknown, holidays?: unknown, defaultEnabled?: unknown }} [raw] - 原始配置。
 * @returns {{ peakWindowsText: string, peakWindows: Array<any>, timeZone: string, holidaysText: string, holidays: Set<string>, defaultEnabled: boolean, issues: string[] }} 归一化配置。
 */
export function normalizeSchedule(raw = {}) {
  /** @type {string[]} */
  const issues = [];

  let peakWindows;
  if (raw?.peakWindows === undefined || raw?.peakWindows === null) {
    peakWindows = parsePeakWindows(DEFAULT_PEAK_WINDOWS);
  } else {
    // `parsePeakWindows` 自己保证"逐条丢弃、全部非法才回退默认"，这里只把原因汇总上去；
    // 不能因为有一个坏条目就把用户写对的那几段也丢掉。
    peakWindows = parsePeakWindows(raw.peakWindows);
    if (peakWindows.issues.length > 0) issues.push(...peakWindows.issues);
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

  let holidays;
  if (raw?.holidays === undefined || raw?.holidays === null) {
    holidays = { dates: new Set(DEFAULT_HOLIDAYS), text: DEFAULT_HOLIDAYS_TEXT, issues: [] };
  } else {
    holidays = parseHolidays(raw.holidays);
    issues.push(...holidays.issues);
  }

  let defaultEnabled = DEFAULT_ENABLED;
  if (raw?.defaultEnabled === true || raw?.defaultEnabled === false) {
    defaultEnabled = raw.defaultEnabled;
  } else if (raw?.defaultEnabled !== undefined && raw?.defaultEnabled !== null) {
    issues.push(`defaultEnabled ${JSON.stringify(raw.defaultEnabled)} 不是布尔值，回退 ${DEFAULT_ENABLED}`);
  }

  return {
    peakWindowsText: peakWindows.text,
    peakWindows: peakWindows.windows,
    timeZone,
    holidaysText: holidays.text,
    holidays: holidays.dates,
    defaultEnabled,
    issues,
  };
}
