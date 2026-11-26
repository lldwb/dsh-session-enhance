/**
 * 「梁谷」组件的 Host 半（Loader 行 `dsh-session-enhance/offpeak`）。
 *
 * ## 它做什么
 *
 * 让会话只在 **DeepSeek 空闲时段**跑：官方口径的高峰时段是**北京时间周一至周五
 * （不含中国法定节假日）09:00–12:00、14:00–18:00**，其余时间（午休、夜间、周末、
 * 法定节假日全天）都是空闲时段。高峰时段里把**已启用**会话的 Agent 挂起
 * （maintenance hold + `agent/status: running` 的同步 cancel 安全网），用户这时发的
 * 提示留在 durable inbox 里；进入空闲时段后释放并自动续跑。
 * 每会话的开关由浏览器半通过 RPC `/dsh-session-enhance-offpeak` 切换。
 *
 * 机制细节见 `lib/offpeak/controller.mjs` 的模块注释（三层保护与重入说明）；
 * 时间判定（工作日/节假日/时段）见 `lib/offpeak/window.mjs`（纯函数）。
 *
 * ## 为什么它是一个独立组件（独立 Loader 行）
 *
 * 这是本包第四个可单独启停的组件：不用梁谷调度的人可以关掉这一行，界面上对应的开关
 * 会因能力探测失败而隐藏（与「会话分享」「中断重试」同一约定）。
 *
 * ## 依赖
 *
 * | 服务 | 用途 | 缺失时 |
 * |---|---|---|
 * | `agents` | 取 live Agent、`turnBoundaryOf` | 软依赖：不 hold、不崩；`status.cover.agent=false` |
 * | `connection` + `webServer` | RPC 通道 | 通道不挂载（浏览器半探测失败即隐藏开关） |
 * | `sessionController` | 「新建梁谷会话」按钮建会话 | 软依赖：该端点返回 `UNAVAILABLE`，其余照常 |
 * | `workspaceRegistry` | 解析源会话的工作区，新会话落在同一个工作区 | 软依赖：退化到按 cwd 建会话 |
 * | `agentPresets` | 新会话沿用源会话的 preset | 软依赖：交给 Host 默认 preset |
 *
 * `inject = []`：不注册模型工具、不要求任何服务在激活时就位——`agents` / `sessionController`
 * 等全部用 `ctx.get()` 软取（`lib/retry/host.mjs` 同款），于是这个组件在 headless /
 * 未挂 agent-loop 的部署里也能干净地激活。
 *
 * ## RPC 端点（浏览器半）
 *
 * `status` / `setEnabled` / `diag`，外加 `createLiangguSession`（标题栏下方「新建梁谷会话」
 * 按钮用：建一个空白会话并把梁谷写为启用，返回新会话 id）。
 *
 * ## 配置（全部 volatile，设置页保存后热更新）
 *
 * - `peakWindows`：高峰时段列表（逗号分隔的 `HH:MM-HH:MM`，起点含、终点不含），
 *   默认 `09:00-12:00,14:00-18:00`；
 * - `timeZone`：时段与节假日按哪个时区解释（默认 `Asia/Shanghai`）；
 * - `holidays`：法定节假日日期（逗号/空白分隔的 `YYYY-MM-DD`），默认 2026 年国务院通知
 *   的日期；**空串 = 不享受节假日豁免**（所有工作日都算高峰日）；
 * - `defaultEnabled`：**没有显式记录**的会话是否默认启用。
 *
 * 非法时段/时区/日期一律回退默认值并 **只 warn 一次**（配置错不该让组件不激活）。
 *
 * @module dsh-session-enhance/offpeak
 */

import z from '@deepseek-ai/schemastery';

import { BUILD } from '../lib/build.mjs';
import { readOption } from '../lib/compact/options.mjs';
import { resolveDshHome } from '../lib/shares.mjs';
import { createOffpeakController } from '../lib/offpeak/controller.mjs';
import {
  fetchHolidayYear,
  holidayCacheFilePath,
  loadHolidayCache,
  resolveHolidaysText,
  saveHolidayCache,
  HOLIDAY_CACHE_TTL_MS,
} from '../lib/offpeak/holidays-fetch.mjs';
import { createOffpeakHandler, installOffpeakChannel } from '../lib/offpeak/rpc.mjs';
import { createOffpeakStore, offpeakStateFilePath } from '../lib/offpeak/store.mjs';
import {
  DEFAULT_ENABLED,
  DEFAULT_HOLIDAYS_TEXT,
  DEFAULT_PEAK_WINDOWS,
  DEFAULT_TIME_ZONE,
  normalizeSchedule,
  parseHolidays,
  zonedParts,
} from '../lib/offpeak/window.mjs';

/** Cordis 插件名：与 Loader 行的 `name` 一致。 */
export const name = 'dsh-session-enhance/offpeak';

/** 不注册模型工具；`agents` 由控制器软取。 */
export const inject = [];

export { BUILD };

/**
 * 插件配置（schemastery）。
 *
 * 四个字段全部 `.volatile()`：设置页保存后原地热更新，控制器下一次 `readSchedule()`
 * 立刻按新值判断相位/重排边界定时器，不需要重启。
 */
export const Config = z.object({
  peakWindows: z.string().default(DEFAULT_PEAK_WINDOWS).volatile(),
  timeZone: z.string().default(DEFAULT_TIME_ZONE).volatile(),
  holidays: z.string().default(DEFAULT_HOLIDAYS_TEXT).volatile(),
  autoHolidays: z.boolean().default(true).volatile(),
  defaultEnabled: z.boolean().default(DEFAULT_ENABLED).volatile(),
});

/**
 * 注册「梁谷」组件。
 *
 * @param {any} ctx - Cordis 插件上下文。
 * @param {any} [config] - 已解析的插件配置（`Config` 的实例）。
 * @returns {void}
 */
export function apply(ctx, config) {
  /** 非法配置只 warn 一次（配置错会持续存在，逐次告警只会刷屏）。 */
  let warnedInvalidConfig = false;

  // ---- 法定节假日自动更新（不经过 AI：插件自己拉公开数据源）----
  const dshHome = resolveDshHome();
  const holidayCacheFile = holidayCacheFilePath(dshHome);
  const cachedHolidays = loadHolidayCache(holidayCacheFile);
  /** @type {Map<number, string[]>} 自动抓取到的年份 → 休息日日期。 */
  const autoYears = cachedHolidays.years;
  let autoFetchedAt = cachedHolidays.fetchedAt;
  /** 自动数据版本号：变化后让 readSchedule 的缓存失效。 */
  let autoRevision = 0;
  /** 最近一次成功抓取的来源（写进缓存，便于诊断）。 */
  let autoSource = cachedHolidays.source;
  let refreshing = false;

  /** 当前时区的年份。 */
  const currentYearOf = (timeZone) => {
    try {
      return zonedParts(Date.now(), timeZone).year;
    } catch {
      return new Date().getFullYear();
    }
  };

  /**
   * 读一份归一化配置；按原始值 + 自动数据版本缓存，字段一变就重新归一化。
   *
   * 节假日优先级：用户显式改过 `holidays` → 以配置为准；否则内置表 ∪ 自动抓取结果
   * （抓取结果对同一年覆盖内置）。
   *
   * @returns {any} 归一化配置（`normalizeSchedule` 的返回值）。
   */
  let cachedKey = null;
  /** @type {any} */
  let cachedValue = null;
  const readSchedule = () => {
    const peakWindows = readOption(config, 'peakWindows', DEFAULT_PEAK_WINDOWS);
    const timeZone = readOption(config, 'timeZone', DEFAULT_TIME_ZONE);
    const defaultEnabled = readOption(config, 'defaultEnabled', DEFAULT_ENABLED);
    const autoHolidays = readOption(config, 'autoHolidays', true) === true;
    // 先归一化配置里的文本（去空白/非法项、排序），再与自动数据合并。
    const configHolidaysText = parseHolidays(readOption(config, 'holidays', DEFAULT_HOLIDAYS_TEXT)).text;
    const resolved = resolveHolidaysText({ configText: configHolidaysText, autoHolidays, autoYears });

    const key = JSON.stringify({ peakWindows, timeZone, holidaysText: resolved.text, defaultEnabled, autoRevision });
    if (key === cachedKey && cachedValue !== null) return cachedValue;
    const value = normalizeSchedule({ peakWindows, timeZone, holidays: resolved.text, defaultEnabled });
    value.holidaysAuto = resolved.auto;
    value.holidaysFetchedAt = resolved.auto ? autoFetchedAt : 0;
    value.holidaysSource = resolved.auto ? cachedHolidays.source : null;
    if (value.issues.length > 0 && !warnedInvalidConfig) {
      warnedInvalidConfig = true;
      try {
        ctx.logger?.warn?.(`dsh-session-enhance/offpeak: 配置有非法值，已回退默认（只提示一次）：${value.issues.join('；')}`);
      } catch {
        // 日志失败与业务无关。
      }
    }
    cachedKey = key;
    cachedValue = value;
    return value;
  };

  // 状态文件与 shares.json 同目录：<DSH_HOME>/dsh-session-enhance/offpeak.json
  const store = createOffpeakStore({ storeFile: offpeakStateFilePath(dshHome) });

  const controller = createOffpeakController({
    // agents 是软依赖：某些部署（headless、未挂 agent-loop）没有这个服务。
    getAgents: () => (typeof ctx?.get === 'function' ? ctx.get('agents') : undefined),
    store,
    readSchedule,
    logger: ctx.logger,
    build: BUILD,
  });

  /**
   * 抓当年 + 次年节假日；失败保留内置/上次缓存（只记 debug，不打扰用户）。
   *
   * @param {boolean} [force] - true 时忽略 24 小时 TTL（配置更新/手动触发）。
   * @returns {Promise<void>} 完成。
   */
  const refreshHolidays = async (force = false) => {
    if (refreshing) return;
    const schedule = readSchedule();
    // 用户关掉自动更新、或显式改过 holidays（含空串 = 不豁免）→ 不再抓取，避免覆盖用户意图。
    const autoHolidays = readOption(config, 'autoHolidays', true) === true;
    const customized = parseHolidays(readOption(config, 'holidays', DEFAULT_HOLIDAYS_TEXT)).text !== DEFAULT_HOLIDAYS_TEXT;
    if (!autoHolidays || customized) return;
    const year = currentYearOf(schedule.timeZone);
    const years = [year, year + 1];
    const stale =
      force === true ||
      autoFetchedAt === 0 ||
      Date.now() - autoFetchedAt > HOLIDAY_CACHE_TTL_MS ||
      !autoYears.has(year);
    if (!stale) return;

    refreshing = true;
    let changed = false;
    try {
      for (const targetYear of years) {
        const result = await fetchHolidayYear(targetYear, { logger: ctx.logger });
        if (result === null) continue;
        const previous = autoYears.get(targetYear);
        if (previous !== undefined && previous.join(',') === result.dates.join(',')) continue;
        autoYears.set(targetYear, result.dates);
        autoSource = result.source;
        changed = true;
        ctx.logger?.info?.(
          `dsh-session-enhance/offpeak: 节假日表已更新 ${targetYear}（${result.dates.length} 天，来源 ${result.source}）`
        );
      }
      if (changed || autoFetchedAt === 0) {
        autoFetchedAt = Date.now();
        autoRevision += 1;
        saveHolidayCache(holidayCacheFile, { fetchedAt: autoFetchedAt, source: autoSource, years: autoYears });
        cachedKey = null;
        cachedValue = null;
        // 用新表重新对账：可能刚好处在"节假日/工作日"翻转的那天。
        controller.refresh();
      }
    } catch (error) {
      ctx.logger?.debug?.(
        `[dsh-session-enhance/offpeak] holiday refresh failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      refreshing = false;
    }
  };

  installOffpeakChannel(ctx, createOffpeakHandler({ controller }));

  // 控制器自己挂 agent/created · agent/status · agent/disposed 与配置热更新事件，
  // 返回的 dispose 交给 ctx.effect（组件停用即释放全部 hold、清定时器）。
  ctx.effect(() => controller.attach(ctx), 'dsh-session-enhance: 梁谷 hold controller');

  // 自动更新：启动 3 秒后做一次检查（不阻塞激活），之后**每天**做一次本地检查；
  // 只有缓存超过 7 天（HOLIDAY_CACHE_TTL_MS）才真正发网络请求——一年只更新一次表，
  // 没必要高频复查。组件停用即清定时器。
  ctx.effect(() => {
    /** @type {any} */
    let timer;
    const kickoff = setTimeout(() => {
      void refreshHolidays(false);
    }, 3_000);
    const interval = setInterval(() => {
      void refreshHolidays(false);
    }, 24 * 60 * 60 * 1000);
    timer = { kickoff, interval };
    if (typeof kickoff?.unref === 'function') kickoff.unref();
    if (typeof interval?.unref === 'function') interval.unref();
    // 配置热更新（例如刚打开「自动更新节假日」）时立刻补一次。
    const off = typeof ctx?.on === 'function'
      ? ctx.on('app-boot/config-reload', () => {
          cachedKey = null;
          cachedValue = null;
          void refreshHolidays(false);
        })
      : undefined;
    return () => {
      clearTimeout(timer.kickoff);
      clearInterval(timer.interval);
      try {
        if (typeof off === 'function') off();
      } catch {
        // 卸载阶段忽略。
      }
    };
  }, 'dsh-session-enhance: 节假日自动更新');

  ctx.logger?.info?.(`dsh-session-enhance/offpeak: ready (hold controller + rpc, build=${BUILD})`);
}
