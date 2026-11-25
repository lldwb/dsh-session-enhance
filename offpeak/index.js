/**
 * 「谷峰会话」组件的 Host 半（Loader 行 `dsh-session-enhance/offpeak`）。
 *
 * ## 它做什么
 *
 * 让会话只在 **DeepSeek 谷时**跑：在谷时窗口（默认 00:30–08:30）之外——也就是峰时——
 * 把**已启用**会话的 Agent 挂起（maintenance hold + `agent/status: running` 的同步
 * cancel 安全网），用户这时发的提示留在 durable inbox 里；谷时一到释放并自动续跑。
 * 每会话的开关由浏览器半通过 RPC `/dsh-session-enhance-offpeak` 切换。
 *
 * 机制细节见 `lib/offpeak/controller.mjs` 的模块注释（三层保护与重入说明）。
 *
 * ## 为什么它是一个独立组件（独立 Loader 行）
 *
 * 这是本包第四个可单独启停的组件：不用峰谷调度的人可以关掉这一行，界面上对应的开关
 * 会因能力探测失败而隐藏（与「会话分享」「中断重试」同一约定）。
 *
 * ## 依赖
 *
 * | 服务 | 用途 | 缺失时 |
 * |---|---|---|
 * | `agents` | 取 live Agent、`turnBoundaryOf` | 软依赖：不 hold、不崩；`status.cover.agent=false` |
 * | `connection` + `webServer` | RPC 通道 | 通道不挂载（浏览器半探测失败即隐藏开关） |
 *
 * `inject = []`：不注册模型工具、不要求任何服务在激活时就位——`agents` 用 `ctx.get()`
 * 软取（`lib/retry/host.mjs` 同款），于是这个组件在 headless / 未挂 agent-loop 的部署里
 * 也能干净地激活。
 *
 * ## 配置（全部 volatile，设置页保存后热更新）
 *
 * - `offPeakStart` / `offPeakEnd`：谷时窗口（`HH:MM`，起点含、终点不含，支持跨午夜）；
 * - `timeZone`：窗口按哪个时区解释（默认 `Asia/Shanghai`）；
 * - `defaultEnabled`：**没有显式记录**的会话是否默认启用。
 *
 * 非法窗口/时区一律回退默认值并 **只 warn 一次**（配置错不该让组件不激活）。
 *
 * @module dsh-session-enhance/offpeak
 */

import z from '@deepseek-ai/schemastery';

import { BUILD } from '../lib/build.mjs';
import { readOption } from '../lib/compact/options.mjs';
import { resolveDshHome } from '../lib/shares.mjs';
import { createOffpeakController } from '../lib/offpeak/controller.mjs';
import { createOffpeakHandler, installOffpeakChannel } from '../lib/offpeak/rpc.mjs';
import { createOffpeakStore, offpeakStateFilePath } from '../lib/offpeak/store.mjs';
import {
  DEFAULT_ENABLED,
  DEFAULT_OFF_PEAK_END,
  DEFAULT_OFF_PEAK_START,
  DEFAULT_TIME_ZONE,
  normalizeSchedule,
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
  offPeakStart: z.string().default(DEFAULT_OFF_PEAK_START).volatile(),
  offPeakEnd: z.string().default(DEFAULT_OFF_PEAK_END).volatile(),
  timeZone: z.string().default(DEFAULT_TIME_ZONE).volatile(),
  defaultEnabled: z.boolean().default(DEFAULT_ENABLED).volatile(),
});

/**
 * 注册「谷峰会话」组件。
 *
 * @param {any} ctx - Cordis 插件上下文。
 * @param {any} [config] - 已解析的插件配置（`Config` 的实例）。
 * @returns {void}
 */
export function apply(ctx, config) {
  /** 非法配置只 warn 一次（配置错会持续存在，逐次告警只会刷屏）。 */
  let warnedInvalidConfig = false;

  /**
   * 读一份归一化配置；按原始值缓存，volatile 字段一变就重新归一化。
   *
   * @returns {{ window: any, defaultEnabled: boolean, issues: string[] }} 归一化配置。
   */
  let cachedKey = null;
  /** @type {any} */
  let cachedValue = null;
  const readSchedule = () => {
    const raw = {
      offPeakStart: readOption(config, 'offPeakStart', DEFAULT_OFF_PEAK_START),
      offPeakEnd: readOption(config, 'offPeakEnd', DEFAULT_OFF_PEAK_END),
      timeZone: readOption(config, 'timeZone', DEFAULT_TIME_ZONE),
      defaultEnabled: readOption(config, 'defaultEnabled', DEFAULT_ENABLED),
    };
    const key = JSON.stringify(raw);
    if (key === cachedKey && cachedValue !== null) return cachedValue;
    const value = normalizeSchedule(raw);
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
  const store = createOffpeakStore({ storeFile: offpeakStateFilePath(resolveDshHome()) });

  const controller = createOffpeakController({
    // agents 是软依赖：某些部署（headless、未挂 agent-loop）没有这个服务。
    getAgents: () => (typeof ctx?.get === 'function' ? ctx.get('agents') : undefined),
    store,
    readSchedule,
    logger: ctx.logger,
    build: BUILD,
  });

  installOffpeakChannel(ctx, createOffpeakHandler({ controller }));

  // 控制器自己挂 agent/created · agent/status · agent/disposed 与配置热更新事件，
  // 返回的 dispose 交给 ctx.effect（组件停用即释放全部 hold、清定时器）。
  ctx.effect(() => controller.attach(ctx), 'dsh-session-enhance: offpeak hold controller');

  ctx.logger?.info?.(`dsh-session-enhance/offpeak: ready (hold controller + rpc, build=${BUILD})`);
}
