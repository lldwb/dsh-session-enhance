/**
 * 「梁谷」时间判定（纯函数）。
 *
 * 官方口径：高峰 = 北京时间**周一至周五**（不含中国法定节假日）的 09:00–12:00 与
 * 14:00–18:00；其余（午休、夜间、周末、法定节假日全天）都是空闲时段。
 *
 * 这一层不碰时钟、不碰定时器：所有"现在"都由参数传入，于是每个相位边界（含跨周末、
 * 节假日、节后恢复、DST）都能钉死。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HOLIDAYS,
  DEFAULT_HOLIDAYS_TEXT,
  DEFAULT_PEAK_WINDOWS,
  DEFAULT_TIME_ZONE,
  MAX_BOUNDARY_SEARCH_DAYS,
  dateStringOf,
  formatClock,
  isPeakAt,
  isValidDateString,
  isValidTimeZone,
  nextBoundary,
  normalizeSchedule,
  parseClock,
  parseHolidays,
  parsePeakWindows,
  wallClockToEpoch,
  weekdayOf,
  zonedParts,
} from '../lib/offpeak/window.mjs';

/** 默认高峰时段的归一化配置。 */
const DEFAULT_SCHEDULE = normalizeSchedule({});

/**
 * 构造 2026 年某天某墙上时刻（Asia/Shanghai）的时间戳。
 *
 * @param {number} month - 1..12。
 * @param {number} day - 1..31。
 * @param {number} hour - 0..23。
 * @param {number} minute - 0..59。
 * @returns {number} 时间戳。
 */
function at(month, day, hour, minute) {
  return wallClockToEpoch({ year: 2026, month, day, hour, minute }, DEFAULT_TIME_ZONE);
}

/** 2027 年的同一时刻（上海时区）。 */
function at2027(month, day, hour, minute) {
  return wallClockToEpoch({ year: 2027, month, day, hour, minute }, DEFAULT_TIME_ZONE);
}

/**
 * 把时间戳断言成"某天某时刻（上海）"。
 *
 * @param {number} actual - 实际时间戳。
 * @param {number} month - 月。
 * @param {number} day - 日。
 * @param {number} hour - 时。
 * @param {number} minute - 分。
 * @returns {void}
 */
function assertShanghai(actual, month, day, hour, minute) {
  assert.equal(actual, at(month, day, hour, minute), `期望 2026-${month}-${day} ${hour}:${minute} +08`);
}

test('默认常量：官方高峰时段、上海时区、2026+2027 法定节假日 62 天', () => {
  assert.equal(DEFAULT_PEAK_WINDOWS, '09:00-12:00,14:00-18:00');
  assert.equal(DEFAULT_TIME_ZONE, 'Asia/Shanghai');
  assert.equal(DEFAULT_HOLIDAYS.length, 62, '2026 的 33 天 + 2027 的 29 天');
  assert.equal(DEFAULT_HOLIDAYS_TEXT, DEFAULT_HOLIDAYS.join(','));
  assert.equal(DEFAULT_HOLIDAYS[0], '2026-01-01');
  assert.equal(DEFAULT_HOLIDAYS.at(-1), '2027-10-07');
  // 各区间的首尾都在（抽查，防止区间展开错位）。
  for (const date of ['2026-01-03', '2026-02-15', '2026-02-23', '2026-04-04', '2026-05-05', '2026-06-19', '2026-09-25', '2026-10-01']) {
    assert.ok(DEFAULT_HOLIDAYS.includes(date), `默认节假日应包含 ${date}`);
  }
  assert.deepEqual([...DEFAULT_HOLIDAYS].sort(), DEFAULT_HOLIDAYS, '按日期升序');
  assert.equal(new Set(DEFAULT_HOLIDAYS).size, DEFAULT_HOLIDAYS.length, '去重');
});

test('parseClock / formatClock：严格 HH:MM，不做隐式纠正', () => {
  assert.equal(parseClock('00:00'), 0);
  assert.equal(parseClock('09:00'), 540);
  assert.equal(parseClock('23:59'), 1439);
  assert.equal(parseClock(' 14:30 '), 870);
  assert.equal(parseClock('24:00'), undefined);
  assert.equal(parseClock('9:00'), undefined);
  assert.equal(parseClock('09:0'), undefined);
  assert.equal(parseClock('09:60'), undefined);
  assert.equal(parseClock(''), undefined);
  assert.equal(parseClock(540), undefined);
  for (const minutes of [0, 540, 870, 1439]) assert.equal(parseClock(formatClock(minutes)), minutes);
});

test('isValidTimeZone / zonedParts / dateStringOf / weekdayOf', () => {
  assert.equal(isValidTimeZone('Asia/Shanghai'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Shanghai'), false);
  assert.equal(isValidTimeZone(''), false);

  const parts = zonedParts(at(11, 24, 9, 30), DEFAULT_TIME_ZONE);
  assert.deepEqual(parts, { year: 2026, month: 11, day: 24, hour: 9, minute: 30, second: 0 });
  assert.equal(dateStringOf(parts), '2026-11-24');
  assert.equal(weekdayOf(parts), 2, '2026-11-24 是周二');

  // 已知星期：2026-01-01 周四、02-23 周一、11-28 周六。
  assert.equal(weekdayOf({ year: 2026, month: 1, day: 1 }), 4);
  assert.equal(weekdayOf({ year: 2026, month: 2, day: 23 }), 1);
  assert.equal(weekdayOf({ year: 2026, month: 11, day: 28 }), 6);

  // 时区换算：上海 +8h，UTC 时区墙上时间就是 UTC。
  assert.equal(at(11, 24, 9, 0), Date.UTC(2026, 10, 24, 1, 0));
  assert.equal(wallClockToEpoch({ year: 2026, month: 11, day: 24, hour: 9, minute: 0 }, 'UTC'), Date.UTC(2026, 10, 24, 9, 0));
});

test('parsePeakWindows：正常/空白/逐条非法/起止倒置/全非法回退', () => {
  const normal = parsePeakWindows('09:00-12:00,14:00-18:00');
  assert.deepEqual(normal.issues, []);
  assert.deepEqual(normal.windows.map((window) => `${window.start}-${window.end}`), ['09:00-12:00', '14:00-18:00']);
  assert.deepEqual(
    normal.windows.map((window) => [window.startMinutes, window.endMinutes]),
    [[540, 720], [840, 1080]],
  );

  // 空白与顺序无关（会按起点排序）。
  const spaced = parsePeakWindows(' 14:00 - 18:00 , 09:00 - 12:00 ');
  assert.deepEqual(spaced.issues, []);
  assert.deepEqual(spaced.windows.map((window) => window.start), ['09:00', '14:00']);

  // 逐条非法：坏条目被丢弃并记 issue，好条目保留。
  const mixed = parsePeakWindows('09:00-12:00,25:00-26:00,14:00-18:00');
  assert.equal(mixed.windows.length, 2);
  assert.equal(mixed.issues.length, 1);
  assert.match(mixed.issues[0], /25:00-26:00/);

  // 起点 >= 终点非法（不跨午夜）。全非法 → 回退默认两段，且会额外记一条"回退"说明。
  const reversed = parsePeakWindows('18:00-09:00');
  assert.equal(reversed.issues.length, 2);
  assert.match(reversed.issues[0], /起点不早于终点/);
  assert.match(reversed.issues[1], /回退默认/);
  assert.equal(reversed.windows.length, 2, '全部非法 → 回退默认两段');

  // 空串 / 全非法都回退默认 + 记 issue。
  for (const text of ['', '   ', 'abc', '10:00-10:00']) {
    const fallback = parsePeakWindows(text);
    assert.equal(fallback.windows.length, 2, `输入 ${JSON.stringify(text)} 应回退默认`);
    assert.ok(fallback.issues.length >= 1);
  }
});

test('parseHolidays：字符串/数组/空串/非法日期', () => {
  const fromString = parseHolidays('2026-01-01,2026-01-02 2026-01-03');
  assert.deepEqual([...fromString.dates], ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.deepEqual(fromString.issues, []);

  const fromArray = parseHolidays(['2026-02-23', '2026-02-24']);
  assert.deepEqual([...fromArray.dates], ['2026-02-23', '2026-02-24']);
  assert.deepEqual(fromArray.text, '2026-02-23,2026-02-24');

  // 空串 = 不享受节假日豁免（合法配置，不是错误）。
  const empty = parseHolidays('');
  assert.equal(empty.dates.size, 0);
  assert.deepEqual(empty.issues, []);

  // 非法日期被丢弃并记 issue；不存在的日历日（02-30）也算非法。
  const messy = parseHolidays('2026-01-01,2026-02-30,not-a-date,2026-13-01');
  assert.deepEqual([...messy.dates], ['2026-01-01']);
  assert.equal(messy.issues.length, 3);

  assert.equal(isValidDateString('2026-02-28'), true);
  assert.equal(isValidDateString('2026-02-30'), false);
  assert.equal(isValidDateString('2026-2-3'), false);
  assert.equal(isValidDateString(20260203), false);
});

test('normalizeSchedule：默认值、非法值逐字段回退、holidays 空串语义', () => {
  assert.equal(DEFAULT_SCHEDULE.peakWindowsText, DEFAULT_PEAK_WINDOWS);
  assert.equal(DEFAULT_SCHEDULE.timeZone, DEFAULT_TIME_ZONE);
  assert.equal(DEFAULT_SCHEDULE.holidays.size, 62);
  assert.equal(DEFAULT_SCHEDULE.defaultEnabled, false);
  assert.deepEqual(DEFAULT_SCHEDULE.issues, []);

  // 显式非法时段：全部非法 → 回退默认并记 issue。
  const badWindows = normalizeSchedule({ peakWindows: '99:00-00:00' });
  assert.equal(badWindows.peakWindowsText, DEFAULT_PEAK_WINDOWS);
  assert.ok(badWindows.issues.length >= 1);
  assert.match(badWindows.issues.join(';'), /高峰时段/);

  // 部分非法：只丢坏的那条，用户写对的几条必须保留（不能整组回退默认）。
  const partial = normalizeSchedule({ peakWindows: '09:00-12:00,25:00-26:00' });
  assert.equal(partial.peakWindowsText, '09:00-12:00');
  assert.match(partial.issues.join(';'), /25:00-26:00/);

  // 自定义时段可以用（比如只避开上午高峰）。
  const custom = normalizeSchedule({ peakWindows: '09:00-12:00' });
  assert.equal(custom.peakWindowsText, '09:00-12:00');
  assert.deepEqual(custom.issues, []);

  // 非法时区回退上海。
  const badZone = normalizeSchedule({ timeZone: 'Mars/Olympus' });
  assert.equal(badZone.timeZone, DEFAULT_TIME_ZONE);
  assert.match(badZone.issues.join(';'), /timeZone/);

  // 节假日：缺失 → 默认 2026 表；空串 → 空表（不豁免）。
  assert.equal(normalizeSchedule({}).holidays.size, 62);
  assert.equal(normalizeSchedule({ holidays: '' }).holidays.size, 0);
  assert.deepEqual(normalizeSchedule({ holidays: '' }).issues, []);

  // defaultEnabled 只接受布尔。
  assert.equal(normalizeSchedule({ defaultEnabled: true }).defaultEnabled, true);
  const badDefault = normalizeSchedule({ defaultEnabled: 'yes' });
  assert.equal(badDefault.defaultEnabled, false);
  assert.match(badDefault.issues.join(';'), /defaultEnabled/);
});

test('isPeakAt：工作日两个时段（含边界）、午休、夜间', () => {
  // 2026-11-24 周二。
  assert.equal(isPeakAt(at(11, 24, 8, 59), DEFAULT_SCHEDULE), false, '09:00 之前空闲');
  assert.equal(isPeakAt(at(11, 24, 9, 0), DEFAULT_SCHEDULE), true, '09:00 起点含');
  assert.equal(isPeakAt(at(11, 24, 11, 59), DEFAULT_SCHEDULE), true);
  assert.equal(isPeakAt(at(11, 24, 12, 0), DEFAULT_SCHEDULE), false, '12:00 终点不含');
  assert.equal(isPeakAt(at(11, 24, 13, 30), DEFAULT_SCHEDULE), false, '午休空闲');
  assert.equal(isPeakAt(at(11, 24, 14, 0), DEFAULT_SCHEDULE), true, '14:00 起点含');
  assert.equal(isPeakAt(at(11, 24, 17, 59), DEFAULT_SCHEDULE), true);
  assert.equal(isPeakAt(at(11, 24, 18, 0), DEFAULT_SCHEDULE), false, '18:00 终点不含');
  assert.equal(isPeakAt(at(11, 24, 22, 0), DEFAULT_SCHEDULE), false, '夜间空闲');
});

test('isPeakAt：周末全天空闲（即使落在 09:00-18:00 之间）', () => {
  // 2026-11-28 周六、11-29 周日。
  for (const day of [28, 29]) {
    for (const hour of [9, 10, 14, 17]) {
      assert.equal(isPeakAt(at(11, day, hour, 0), DEFAULT_SCHEDULE), false, `11-${day} ${hour}:00 周末应空闲`);
    }
  }
});

test('isPeakAt：法定节假日（工作日日期）全天空闲；节后工作日恢复高峰', () => {
  // 元旦：2026-01-01 周四、01-02 周五都是节假日；01-03 周六；01-04 周日；01-05 周一恢复。
  assert.equal(isPeakAt(at(1, 1, 10, 0), DEFAULT_SCHEDULE), false, '2026-01-01 周四节假日');
  assert.equal(isPeakAt(at(1, 2, 10, 0), DEFAULT_SCHEDULE), false, '2026-01-02 周五节假日');
  assert.equal(isPeakAt(at(1, 5, 10, 0), DEFAULT_SCHEDULE), true, '节后周一恢复高峰');

  // 春节：2026-02-23 周一（假期最后一天）空闲；02-24 周二恢复。
  assert.equal(isPeakAt(at(2, 23, 10, 0), DEFAULT_SCHEDULE), false, '2026-02-23 周一在春节假期内');
  assert.equal(isPeakAt(at(2, 24, 10, 0), DEFAULT_SCHEDULE), true, '节后 02-24 恢复高峰');

  // 中秋：2026-09-25 周五；国庆：2026-10-01 周四。
  assert.equal(isPeakAt(at(9, 25, 10, 0), DEFAULT_SCHEDULE), false);
  assert.equal(isPeakAt(at(10, 1, 10, 0), DEFAULT_SCHEDULE), false);

  // 2027（国办发明电〔2026〕10 号）：春节 2027-02-05..02-13；节后 02-15 周一恢复高峰。
  assert.equal(isPeakAt(at2027(2, 5, 10, 0), DEFAULT_SCHEDULE), false, '2027-02-05 除夕在春节假期内');
  assert.equal(isPeakAt(at2027(2, 13, 10, 0), DEFAULT_SCHEDULE), false, '2027-02-13 假期最后一天');
  assert.equal(isPeakAt(at2027(2, 15, 10, 0), DEFAULT_SCHEDULE), true, '2027-02-15 节后周一恢复高峰');
  // 2027 国庆 10-01..10-07；10-08 周五恢复高峰。
  assert.equal(isPeakAt(at2027(10, 1, 10, 0), DEFAULT_SCHEDULE), false);
  assert.equal(isPeakAt(at2027(10, 8, 10, 0), DEFAULT_SCHEDULE), true, '2027-10-08 节后周五恢复高峰');
  // 2027 端午 06-09（周三单日）；中秋 09-15（周三单日）都在假期内，各自前后工作日仍是高峰。
  assert.equal(isPeakAt(at2027(6, 9, 10, 0), DEFAULT_SCHEDULE), false, '2027-06-09 端午单日');
  assert.equal(isPeakAt(at2027(6, 10, 10, 0), DEFAULT_SCHEDULE), true, '2027-06-10 次日恢复高峰');
  assert.equal(isPeakAt(at2027(9, 15, 10, 0), DEFAULT_SCHEDULE), false, '2027-09-15 中秋单日');

  // 自定义空节假日表 = 不豁免：同一个 2026-01-01 变成高峰日。
  const noExemption = normalizeSchedule({ holidays: '' });
  assert.equal(isPeakAt(at(1, 1, 10, 0), noExemption), true, '空节假日表时工作日按高峰算');
  assert.equal(isPeakAt(at(1, 3, 10, 0), noExemption), false, '周末仍然空闲');
});

test('nextBoundary：工作日内的关口（高峰→午休→高峰→夜间）', () => {
  const fromPeakMorning = nextBoundary(at(11, 24, 10, 0), DEFAULT_SCHEDULE);
  assert.equal(fromPeakMorning.kind, 'resume');
  assertShanghai(fromPeakMorning.at, 11, 24, 12, 0);
  assert.equal(fromPeakMorning.msUntil, fromPeakMorning.at - at(11, 24, 10, 0));

  const fromLunch = nextBoundary(at(11, 24, 12, 30), DEFAULT_SCHEDULE);
  assert.equal(fromLunch.kind, 'pause');
  assertShanghai(fromLunch.at, 11, 24, 14, 0);

  const fromPeakAfternoon = nextBoundary(at(11, 24, 14, 0), DEFAULT_SCHEDULE);
  assert.equal(fromPeakAfternoon.kind, 'resume');
  assertShanghai(fromPeakAfternoon.at, 11, 24, 18, 0);

  // 18:00 之后：次日（周三）09:00 才再次进入高峰。
  const fromEvening = nextBoundary(at(11, 24, 18, 0), DEFAULT_SCHEDULE);
  assert.equal(fromEvening.kind, 'pause');
  assertShanghai(fromEvening.at, 11, 25, 9, 0);
});

test('nextBoundary：跨周末（周五 18:00 之后 → 下周一 09:00）', () => {
  // 2026-11-27 周五。
  const fridayEvening = nextBoundary(at(11, 27, 18, 0), DEFAULT_SCHEDULE);
  assert.equal(fridayEvening.kind, 'pause');
  assertShanghai(fridayEvening.at, 11, 30, 9, 0, );
  // 周六 10:00 也一样是下周一。
  const saturday = nextBoundary(at(11, 28, 10, 0), DEFAULT_SCHEDULE);
  assert.equal(saturday.kind, 'pause');
  assertShanghai(saturday.at, 11, 30, 9, 0);
  // 周日晚上也是下周一。
  const sundayNight = nextBoundary(at(11, 29, 23, 0), DEFAULT_SCHEDULE);
  assert.equal(sundayNight.kind, 'pause');
  assertShanghai(sundayNight.at, 11, 30, 9, 0);
  // 周一 08:00 还是"下一次 09:00"。
  const mondayEarly = nextBoundary(at(11, 30, 8, 0), DEFAULT_SCHEDULE);
  assert.equal(mondayEarly.kind, 'pause');
  assertShanghai(mondayEarly.at, 11, 30, 9, 0);
});

test('nextBoundary：节假日（元旦/春节）后恢复、假期内没有边界', () => {
  // 2025-12-31 周三 20:00：次日 01-01 是节假日 → 下一次高峰是 01-05 周一 09:00。
  const newYearEve = nextBoundary(
    wallClockToEpoch({ year: 2025, month: 12, day: 31, hour: 20, minute: 0 }, DEFAULT_TIME_ZONE),
    DEFAULT_SCHEDULE,
  );
  assert.equal(newYearEve.kind, 'pause');
  assertShanghai(newYearEve.at, 1, 5, 9, 0);

  // 春节假期最后一天 2026-02-23 周一 10:00 → 下一次 02-24 周二 09:00。
  const lastHoliday = nextBoundary(at(2, 23, 10, 0), DEFAULT_SCHEDULE);
  assert.equal(lastHoliday.kind, 'pause');
  assertShanghai(lastHoliday.at, 2, 24, 9, 0);

  // 假期内的一个工作日中午：下一次仍是节后第一个工作日。
  const midHoliday = nextBoundary(at(2, 18, 12, 30), DEFAULT_SCHEDULE);
  assert.equal(midHoliday.kind, 'pause');
  assertShanghai(midHoliday.at, 2, 24, 9, 0);

  // 节假日表为空时，02-23 周一就是正常高峰日 → 下一次边界是当天 12:00 午休。
  const noExemption = normalizeSchedule({ holidays: '' });
  const onMonday = nextBoundary(at(2, 23, 10, 0), noExemption);
  assert.equal(onMonday.kind, 'resume');
  assertShanghai(onMonday.at, 2, 23, 12, 0);
});

test('nextBoundary：严格大于 now（正好落在边界时刻时给出下一条）', () => {
  // 正好 12:00（高峰刚结束）→ 下一次是 14:00 的 pause。
  const exactlyNoon = nextBoundary(at(11, 24, 12, 0), DEFAULT_SCHEDULE);
  assert.equal(exactlyNoon.kind, 'pause');
  assertShanghai(exactlyNoon.at, 11, 24, 14, 0);
  // 正好 14:00（高峰刚开始）→ 下一次是 18:00 的 resume。
  const exactlyAfternoon = nextBoundary(at(11, 24, 14, 0), DEFAULT_SCHEDULE);
  assert.equal(exactlyAfternoon.kind, 'resume');
  assertShanghai(exactlyAfternoon.at, 11, 24, 18, 0);
  // 正好 18:00 → 次日 09:00 pause。
  const exactlyEvening = nextBoundary(at(11, 24, 18, 0), DEFAULT_SCHEDULE);
  assert.equal(exactlyEvening.kind, 'pause');
  assertShanghai(exactlyEvening.at, 11, 25, 9, 0);
});

test('nextBoundary：节假日表覆盖未来 400 天时返回 null（不假装有边界）', () => {
  const holidays = [];
  const base = at(11, 24, 0, 0);
  for (let offset = 0; offset <= MAX_BOUNDARY_SEARCH_DAYS + 2; offset += 1) {
    const day = new Date(base + offset * 24 * 60 * 60 * 1000);
    holidays.push(day.toISOString().slice(0, 10));
  }
  const sched = normalizeSchedule({ holidays });
  const boundary = nextBoundary(base, sched);
  assert.deepEqual(boundary, { at: null, kind: null, msUntil: null });
});

test('DST 时区（America/New_York）也能算出稳定的下一次边界', () => {
  const sched = normalizeSchedule({ timeZone: 'America/New_York' });
  // 2026-03-09 周一 10:00 EDT（春季切换后的第一个工作日）。
  const monday = Date.UTC(2026, 2, 9, 14, 0, 0); // 10:00 EDT
  assert.equal(isPeakAt(monday, sched), true);
  const boundary = nextBoundary(monday, sched);
  assert.equal(boundary.kind, 'resume');
  const parts = zonedParts(boundary.at, 'America/New_York');
  assert.deepEqual([parts.day, parts.hour, parts.minute], [9, 12, 0], '纽约当地 12:00 午休开始');
});
