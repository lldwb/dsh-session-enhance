/**
 * 「谷峰会话」时间窗纯函数。
 *
 * 这一层不碰时钟、不碰定时器：所有"现在"都由参数传入，于是每个相位边界（含跨午夜、
 * 月末、非法配置回退）都能钉死。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_OFF_PEAK_END,
  DEFAULT_OFF_PEAK_START,
  DEFAULT_TIME_ZONE,
  formatClock,
  isInWindow,
  isOffPeakAt,
  isValidTimeZone,
  minutesOfDay,
  nextBoundary,
  normalizeSchedule,
  normalizeWindow,
  parseClock,
  wallClockToEpoch,
  zoneOffsetMs,
  zonedParts,
} from '../lib/offpeak/window.mjs';

/** 2026-11-25 00:00 +08:00（Asia/Shanghai）的时间戳。 */
const SHANGHAI_MIDNIGHT = Date.UTC(2026, 10, 24, 16, 0, 0);

/** 默认窗口（00:30–08:30，Asia/Shanghai）的归一化结果。 */
const DEFAULT_WINDOW = normalizeWindow({});

/** 构造默认窗口下某天的某个墙上时刻（小时:分钟，Asia/Shanghai）。 */
function shanghaiAt(hour, minute, dayOffset = 0) {
  return wallClockToEpoch({ year: 2026, month: 11, day: 25 + dayOffset, hour, minute }, DEFAULT_TIME_ZONE);
}

test('parseClock：严格 HH:MM，不做隐式纠正', () => {
  assert.equal(parseClock('00:30'), 30);
  assert.equal(parseClock('08:30'), 510);
  assert.equal(parseClock('23:59'), 1439);
  assert.equal(parseClock(' 07:05 '), 425, '允许首尾空白');
  assert.equal(parseClock('24:00'), undefined);
  assert.equal(parseClock('7:05'), undefined);
  assert.equal(parseClock('07:5'), undefined);
  assert.equal(parseClock('07:60'), undefined);
  assert.equal(parseClock('abc'), undefined);
  assert.equal(parseClock(''), undefined);
  assert.equal(parseClock(undefined), undefined);
  assert.equal(parseClock(30), undefined);
});

test('formatClock 与 parseClock 互逆', () => {
  for (const minutes of [0, 30, 425, 510, 1439]) {
    assert.equal(parseClock(formatClock(minutes)), minutes);
  }
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(1439), '23:59');
});

test('isValidTimeZone：只认 Intl 接受的 IANA 名', () => {
  assert.equal(isValidTimeZone('Asia/Shanghai'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Etc/GMT-8'), true);
  assert.equal(isValidTimeZone(' America/New_York '), true, '首尾空白会被 trim');
  assert.equal(isValidTimeZone('Shanghai'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(undefined), false);
  assert.equal(isValidTimeZone(8), false);
});

test('normalizeWindow：默认值、非法值逐字段回退并记 issues', () => {
  assert.deepEqual(
    { start: DEFAULT_WINDOW.start, end: DEFAULT_WINDOW.end, timeZone: DEFAULT_WINDOW.timeZone },
    { start: DEFAULT_OFF_PEAK_START, end: DEFAULT_OFF_PEAK_END, timeZone: DEFAULT_TIME_ZONE },
  );
  assert.deepEqual(DEFAULT_WINDOW.issues, []);
  assert.equal(DEFAULT_WINDOW.startMinutes, 30);
  assert.equal(DEFAULT_WINDOW.endMinutes, 510);

  const badStart = normalizeWindow({ offPeakStart: '25:00' });
  assert.equal(badStart.start, DEFAULT_OFF_PEAK_START);
  assert.equal(badStart.issues.length, 1);
  assert.match(badStart.issues[0], /offPeakStart/);

  const badZone = normalizeWindow({ timeZone: 'Mars/Olympus' });
  assert.equal(badZone.timeZone, DEFAULT_TIME_ZONE);
  assert.equal(badZone.issues.length, 1);
  assert.match(badZone.issues[0], /timeZone/);

  // 起点==终点 → 空窗口，回退默认（否则永远处于谷时或永远处于峰时，都不是用户要的）。
  const empty = normalizeWindow({ offPeakStart: '08:00', offPeakEnd: '08:00' });
  assert.equal(empty.start, DEFAULT_OFF_PEAK_START);
  assert.equal(empty.end, DEFAULT_OFF_PEAK_END);
  assert.match(empty.issues[0], /相同/);

  // 跨午夜是合法配置，不产生 issue。
  const overnight = normalizeWindow({ offPeakStart: '22:00', offPeakEnd: '06:00' });
  assert.deepEqual(overnight.issues, []);
  assert.equal(overnight.startMinutes, 22 * 60);
  assert.equal(overnight.endMinutes, 6 * 60);

  // 全合法时 issues 为空。
  const clean = normalizeWindow({ offPeakStart: '01:15', offPeakEnd: '07:45', timeZone: 'UTC' });
  assert.deepEqual(clean.issues, []);
  assert.equal(clean.start, '01:15');
  assert.equal(clean.timeZone, 'UTC');
});

test('normalizeSchedule：defaultEnabled 只接受布尔值', () => {
  assert.equal(normalizeSchedule({}).defaultEnabled, false);
  assert.equal(normalizeSchedule({ defaultEnabled: true }).defaultEnabled, true);
  const bad = normalizeSchedule({ defaultEnabled: 'yes' });
  assert.equal(bad.defaultEnabled, false);
  assert.equal(bad.issues.length, 1);
  assert.match(bad.issues[0], /defaultEnabled/);
});

test('isInWindow：普通窗口半开区间与跨午夜窗口', () => {
  // 00:30–08:30：起点含、终点不含。
  assert.equal(isInWindow(30, 30, 510), true);
  assert.equal(isInWindow(29, 30, 510), false);
  assert.equal(isInWindow(509, 30, 510), true);
  assert.equal(isInWindow(510, 30, 510), false);

  // 22:00–06:00：跨午夜。
  assert.equal(isInWindow(22 * 60, 22 * 60, 6 * 60), true);
  assert.equal(isInWindow(1439, 22 * 60, 6 * 60), true);
  assert.equal(isInWindow(0, 22 * 60, 6 * 60), true);
  assert.equal(isInWindow(359, 22 * 60, 6 * 60), true);
  assert.equal(isInWindow(360, 22 * 60, 6 * 60), false);
  assert.equal(isInWindow(12 * 60, 22 * 60, 6 * 60), false);

  // 空窗口恒 false。
  assert.equal(isInWindow(30, 30, 30), false);
});

test('时区换算：Asia/Shanghai 偏移 +8h、墙上时间与绝对时刻互逆', () => {
  assert.equal(zoneOffsetMs(SHANGHAI_MIDNIGHT, DEFAULT_TIME_ZONE), 8 * 60 * 60 * 1000);
  assert.deepEqual(zonedParts(SHANGHAI_MIDNIGHT, DEFAULT_TIME_ZONE), {
    year: 2026,
    month: 11,
    day: 25,
    hour: 0,
    minute: 0,
    second: 0,
  });
  // 00:30 +08 == 前一天 16:30Z
  assert.equal(shanghaiAt(0, 30), Date.UTC(2026, 10, 24, 16, 30));
  assert.equal(minutesOfDay(shanghaiAt(8, 29), DEFAULT_TIME_ZONE), 509);
  // UTC 时区下墙上时间就是 UTC。
  assert.equal(wallClockToEpoch({ year: 2026, month: 11, day: 25, hour: 0, minute: 30 }, 'UTC'), Date.UTC(2026, 10, 25, 0, 30));
});

test('isOffPeakAt：默认窗口内的判定（含两侧边界）', () => {
  assert.equal(isOffPeakAt(shanghaiAt(0, 29), DEFAULT_WINDOW), false, '00:29 还是峰时');
  assert.equal(isOffPeakAt(shanghaiAt(0, 30), DEFAULT_WINDOW), true, '00:30 起点含');
  assert.equal(isOffPeakAt(shanghaiAt(1, 0), DEFAULT_WINDOW), true);
  assert.equal(isOffPeakAt(shanghaiAt(8, 29), DEFAULT_WINDOW), true);
  assert.equal(isOffPeakAt(shanghaiAt(8, 30), DEFAULT_WINDOW), false, '08:30 终点不含');
  assert.equal(isOffPeakAt(shanghaiAt(12, 0), DEFAULT_WINDOW), false);

  // 跨午夜窗口：22:00–06:00 的峰时是 06:00–22:00。
  const overnight = normalizeWindow({ offPeakStart: '22:00', offPeakEnd: '06:00' });
  assert.equal(isOffPeakAt(shanghaiAt(23, 0), overnight), true);
  assert.equal(isOffPeakAt(shanghaiAt(0, 0), overnight), true);
  assert.equal(isOffPeakAt(shanghaiAt(5, 59), overnight), true);
  assert.equal(isOffPeakAt(shanghaiAt(6, 0), overnight), false);
  assert.equal(isOffPeakAt(shanghaiAt(21, 59), overnight), false);
});

test('nextBoundary：谷时→下一次切峰，峰时→下一次入谷（跨自然日）', () => {
  // 谷时 01:00 → 08:30 切峰。
  const fromOffPeak = nextBoundary(shanghaiAt(1, 0), DEFAULT_WINDOW);
  assert.equal(fromOffPeak.kind, 'pause');
  assert.equal(fromOffPeak.at, shanghaiAt(8, 30));
  assert.equal(fromOffPeak.msUntil, shanghaiAt(8, 30) - shanghaiAt(1, 0));

  // 峰时 10:00 → 次日 00:30 入谷。
  const fromPeak = nextBoundary(shanghaiAt(10, 0), DEFAULT_WINDOW);
  assert.equal(fromPeak.kind, 'resume');
  assert.equal(fromPeak.at, shanghaiAt(0, 30, 1));

  // 正好在谷时起点：仍算谷时，下一次是当天的终点。
  const exactlyStart = nextBoundary(shanghaiAt(0, 30), DEFAULT_WINDOW);
  assert.equal(exactlyStart.kind, 'pause');
  assert.equal(exactlyStart.at, shanghaiAt(8, 30));

  // 正好在终点：已经切峰，下一次是次日起点。
  const exactlyEnd = nextBoundary(shanghaiAt(8, 30), DEFAULT_WINDOW);
  assert.equal(exactlyEnd.kind, 'resume');
  assert.equal(exactlyEnd.at, shanghaiAt(0, 30, 1));

  // 跨午夜窗口：谷时 23:00 → 次日 06:00 切峰（顺延一天）。
  const overnight = normalizeWindow({ offPeakStart: '22:00', offPeakEnd: '06:00' });
  const overnightNext = nextBoundary(shanghaiAt(23, 0), overnight);
  assert.equal(overnightNext.kind, 'pause');
  assert.equal(overnightNext.at, shanghaiAt(6, 0, 1));
});

test('DST 时区也能算出稳定的下一次边界（America/New_York 春季切换日）', () => {
  const window = normalizeWindow({ offPeakStart: '00:30', offPeakEnd: '08:30', timeZone: 'America/New_York' });
  // 2026-03-08 是美东春季切换日（02:00 → 03:00）。取切换后的峰时（09:00 EDT），
  // 下一次入谷应在次日（03-09）00:30。
  const afterSwitch = Date.UTC(2026, 2, 8, 13, 0, 0); // 09:00 EDT
  const next = nextBoundary(afterSwitch, window);
  assert.ok(Number.isFinite(next.at));
  assert.equal(next.kind, 'resume');
  const parts = zonedParts(next.at, 'America/New_York');
  assert.equal(parts.hour, 0);
  assert.equal(parts.minute, 30);
  assert.equal(parts.day, 9, '同一自然日的 00:30 已经过去，应顺延到次日');
});
