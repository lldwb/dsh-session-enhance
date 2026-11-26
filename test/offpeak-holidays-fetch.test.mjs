/**
 * `lib/offpeak/holidays-fetch.mjs` 的单测：解析、校验、多源回退、缓存往返、合并规则。
 *
 * 这里全部用注入的 `fetchImpl`，不发真实网络请求。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  fetchHolidayYear,
  holidayCacheFilePath,
  HOLIDAY_SOURCES,
  isPlausibleHolidayTable,
  isValidHolidayDate,
  loadHolidayCache,
  parseHolidayCnPayload,
  parseTimorPayload,
  resolveHolidaysText,
  sanitizeHolidayDates,
  saveHolidayCache,
} from '../lib/offpeak/holidays-fetch.mjs';
import { DEFAULT_HOLIDAYS_TEXT } from '../lib/offpeak/window.mjs';

/** timor.tech 2027 的真实响应（截取，含 rest 字段与补班条目）。 */
const TIMOR_2027 = {
  code: 0,
  holiday: {
    '01-01': { holiday: true, name: '元旦', wage: 3, date: '2027-01-01' },
    '01-02': { holiday: true, name: '元旦', wage: 2, date: '2027-01-02' },
    '01-03': { holiday: true, name: '元旦', wage: 2, date: '2027-01-03' },
    '01-31': { holiday: false, name: '春节前补班', wage: 1, date: '2027-01-31' },
    '02-05': { holiday: true, name: '除夕', wage: 3, date: '2027-02-05' },
    '02-13': { holiday: true, name: '初八', wage: 2, date: '2027-02-13' },
    '02-14': { holiday: false, name: '春节后补班', wage: 1, date: '2027-02-14' },
  },
};

/** holiday-cn 的真实结构（截取）。 */
const HOLIDAY_CN_2027 = {
  year: 2027,
  papers: ['https://www.gov.cn/...'],
  days: [
    { name: '元旦', date: '2027-01-01', isOffDay: true },
    { name: '元旦', date: '2027-01-02', isOffDay: true },
    { name: '春节前补班', date: '2027-01-31', isOffDay: false },
    { name: '除夕', date: '2027-02-05', isOffDay: true },
  ],
};

test('parseTimorPayload：只取 holiday:true 的休息日，补班条目忽略，只保留目标年份', () => {
  const dates = parseTimorPayload(TIMOR_2027, 2027);
  assert.deepEqual(dates, ['2027-01-01', '2027-01-02', '2027-01-03', '2027-02-05', '2027-02-13']);
  assert.equal(dates.includes('2027-01-31'), false, '补班日不是休息日');
  // 年份不匹配 → 空
  assert.deepEqual(parseTimorPayload(TIMOR_2027, 2026), []);
  // 结构不对 → 空，不抛错
  assert.deepEqual(parseTimorPayload(null, 2027), []);
  assert.deepEqual(parseTimorPayload({ code: 0 }, 2027), []);
});

test('parseHolidayCnPayload：只取 isOffDay:true，忽略补班与非法日期', () => {
  assert.deepEqual(parseHolidayCnPayload(HOLIDAY_CN_2027, 2027), [
    '2027-01-01',
    '2027-01-02',
    '2027-02-05',
  ]);
  assert.deepEqual(parseHolidayCnPayload({ days: [{ date: '2027-02-30', isOffDay: true }] }, 2027), []);
  assert.deepEqual(parseHolidayCnPayload({ days: 'nope' }, 2027), []);
});

test('sanitizeHolidayDates / isValidHolidayDate：严格日期、去重、升序', () => {
  assert.equal(isValidHolidayDate('2027-01-01'), true);
  assert.equal(isValidHolidayDate('2027-02-30'), false, '2 月没有 30 号');
  assert.equal(isValidHolidayDate('2027-1-1'), false);
  assert.equal(isValidHolidayDate('2027/01/01'), false);
  assert.equal(isValidHolidayDate(20270101), false);
  assert.deepEqual(
    sanitizeHolidayDates(['2027-02-05', '2027-01-01', '2027-01-01', '2026-10-01', 'bad', 42], 2027),
    ['2027-01-01', '2027-02-05']
  );
});

test('isPlausibleHolidayTable：天数在合理区间才算可用（防数据源返回残缺表）', () => {
  const many = Array.from({ length: 29 }, (_, index) => `2027-01-${String((index % 28) + 1).padStart(2, '0')}`);
  assert.equal(isPlausibleHolidayTable(many), true);
  assert.equal(isPlausibleHolidayTable([]), false);
  assert.equal(isPlausibleHolidayTable(['2027-01-01']), false, '太少视为残缺');
  assert.equal(isPlausibleHolidayTable(Array.from({ length: 61 }, () => '2027-01-01')), false, '太多视为异常');
});

/** 构造一个最小 fetch 替身：按 url 命中表返回。 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    for (const [match, response] of routes) {
      if (url.includes(match)) {
        if (response instanceof Error) throw response;
        return {
          ok: response.ok !== false,
          json: async () => response.body
        };
      }
    }
    const missing = new Error(`no route for ${url}`);
    throw missing;
  };
  impl.calls = calls;
  return impl;
}

const bigTable = (year) => Array.from({ length: 29 }, (_, index) => `${year}-01-${String(index + 1).padStart(2, '0')}`);
const bigPayload = (year) => ({
  code: 0,
  holiday: Object.fromEntries(
    bigTable(year).map((date, index) => [`${date.slice(5)}-${index}`, { holiday: true, date }])
  ),
});

test('fetchHolidayYear：主源失败自动回退到下一个源，成功即停', async () => {
  const fetchImpl = fakeFetch([
    ['timor.tech', new Error('blocked')],
    ['jsdelivr', { ok: false, body: null }],
    ['raw.githubusercontent.com', { ok: true, body: { days: bigTable(2027).map((date) => ({ date, isOffDay: true })) } }]
  ]);
  const result = await fetchHolidayYear(2027, { fetchImpl });
  assert.notEqual(result, null);
  assert.equal(result.source, 'holiday-cn-github');
  assert.equal(result.dates.length, 29);
  assert.equal(fetchImpl.calls.length, 3, '三个源都试过');
});

test('fetchHolidayYear：全部源失败 / 数据残缺 → null（调用方保留内置表）', async () => {
  const failing = fakeFetch([
    ['timor.tech', new Error('offline')],
    ['jsdelivr', new Error('offline')],
    ['raw.githubusercontent.com', new Error('offline')]
  ]);
  assert.equal(await fetchHolidayYear(2027, { fetchImpl: failing }), null);

  const tiny = fakeFetch([['timor.tech', { ok: true, body: { holiday: { '01-01': { holiday: true, date: '2027-01-01' } } } }]]);
  assert.equal(await fetchHolidayYear(2027, { fetchImpl: tiny }), null, '只有 1 天视为残缺');
});

test('缓存：写读往返、损坏/版本不符时返回空缓存', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offpeak-holiday-cache-'));
  try {
    const file = holidayCacheFilePath(dir);
    assert.equal(file.endsWith(path.join('dsh-session-enhance', 'holidays-cache.json')), true);
    const years = new Map([[2027, bigTable(2027)]]);
    saveHolidayCache(file, { fetchedAt: 123456, source: 'timor', years });
    const loaded = loadHolidayCache(file);
    assert.equal(loaded.fetchedAt, 123456);
    assert.equal(loaded.source, 'timor');
    assert.deepEqual(loaded.years.get(2027), bigTable(2027));

    fs.writeFileSync(file, '{not json', 'utf8');
    assert.equal(loadHolidayCache(file).years.size, 0, '损坏则忽略');

    fs.writeFileSync(file, JSON.stringify({ version: 999, fetchedAt: 1, years: {} }), 'utf8');
    assert.equal(loadHolidayCache(file).years.size, 0, '版本不符则忽略');

    // 不存在的文件也返回空，不抛错。
    assert.equal(loadHolidayCache(path.join(dir, 'nope.json')).years.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveHolidaysText：用户显式配置优先；未改过才与自动数据合并', () => {
  const autoYears = new Map([[2027, ['2027-01-01', '2027-01-02']]]);

  // 关掉自动更新 → 用配置。
  assert.deepEqual(resolveHolidaysText({ configText: DEFAULT_HOLIDAYS_TEXT, autoHolidays: false, autoYears }), {
    text: DEFAULT_HOLIDAYS_TEXT,
    auto: false
  });

  // 默认表 + 自动数据 → 并集（自动数据是额外日期）。
  const merged = resolveHolidaysText({ configText: DEFAULT_HOLIDAYS_TEXT, autoHolidays: true, autoYears });
  assert.equal(merged.auto, true);
  assert.ok(merged.text.includes('2027-01-01'));

  // 用户改过（含空串 = 不豁免）→ 一律用配置，自动数据不覆盖。
  assert.deepEqual(resolveHolidaysText({ configText: '2026-01-01', autoHolidays: true, autoYears }), {
    text: '2026-01-01',
    auto: false
  });
  assert.deepEqual(resolveHolidaysText({ configText: '', autoHolidays: true, autoYears }), { text: '', auto: false });

  // 没有自动数据 → 原样返回配置。
  assert.deepEqual(
    resolveHolidaysText({ configText: DEFAULT_HOLIDAYS_TEXT, autoHolidays: true, autoYears: new Map() }),
    { text: DEFAULT_HOLIDAYS_TEXT, auto: false }
  );
});

test('HTTP 超时：慢响应被 abort，回退到下一个源', async () => {
  const slow = async (url, options = {}) => {
    if (url.includes('timor.tech')) {
      // 模拟一个「不主动返回、只等信号」的慢响应：abort 时立即失败。
      await new Promise((resolve, reject) => {
        const signal = options.signal;
        const timer = setTimeout(() => reject(new Error('timeout not fired')), 5_000);
        if (signal !== undefined && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
      });
      return { ok: true, json: async () => bigPayload(2027) };
    }
    if (url.includes('jsdelivr')) {
      return { ok: true, json: async () => ({ days: bigTable(2027).map((date) => ({ date, isOffDay: true })) }) };
    }
    throw new Error('unexpected');
  };
  const started = Date.now();
  const result = await fetchHolidayYear(2027, { fetchImpl: slow, timeoutMs: 50 });
  assert.notEqual(result, null, '慢源超时后仍拿到备用源的数据');
  assert.equal(result.source, 'holiday-cn-jsdelivr');
  assert.ok(Date.now() - started < 3_000, '没有等满 5 秒');
});

test('数据源清单：timor 主源在前，且每个源都生成含年份的 URL', () => {
  assert.equal(HOLIDAY_SOURCES[0].id, 'timor');
  for (const source of HOLIDAY_SOURCES) {
    const url = source.url(2027);
    assert.ok(url.includes('2027'), `${source.id} 的 URL 应含年份：${url}`);
    assert.ok(url.startsWith('https://'), '只用 HTTPS');
  }
});
