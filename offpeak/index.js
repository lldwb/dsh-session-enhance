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
import { createOffpeakHandler, installOffpeakChannel } from '../lib/offpeak/rpc.mjs';
import { createOffpeakStore, offpeakStateFilePath } from '../lib/offpeak/store.mjs';
import {
  DEFAULT_ENABLED,
  DEFAULT_HOLIDAYS_TEXT,
  DEFAULT_PEAK_WINDOWS,
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
  peakWindows: z.string().default(DEFAULT_PEAK_WINDOWS).volatile(),
  timeZone: z.string().default(DEFAULT_TIME_ZONE).volatile(),
  holidays: z.string().default(DEFAULT_HOLIDAYS_TEXT).volatile(),
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

  /**
   * 读一份归一化配置；按原始值缓存，volatile 字段一变就重新归一化。
   *
   * @returns {any} 归一化配置（`normalizeSchedule` 的返回值）。
   */
  let cachedKey = null;
  /** @type {any} */
  let cachedValue = null;
  const readSchedule = () => {
    const raw = {
      peakWindows: readOption(config, 'peakWindows', DEFAULT_PEAK_WINDOWS),
      timeZone: readOption(config, 'timeZone', DEFAULT_TIME_ZONE),
      holidays: readOption(config, 'holidays', DEFAULT_HOLIDAYS_TEXT),
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

  /**
   * 新建一个「梁谷会话」：在源会话所在的工作区建空白会话，并把梁谷开关写为启用。
   *
   * 会话创建走 Host 的 `sessionController.create()`——与客户端「新建会话」同一条 Host
   * 路径（空白会话，首条提示前不建 Agent）；创建成功后立刻把该会话写入开关存储，于是
   * 它之后的第一次 Agent 创建就会按梁谷规则 hold/放行。
   *
   * @param {string} sourceSessionId - 当前会话 id（用来取工作区、cwd 与 preset）。
   * @returns {Promise<{ sessionId: string, agentPreset: string | null, workspaceId: string | null }>} 新会话。
   */
  const createLiangguSession = async (sourceSessionId) => {
    /** 软取 Host 服务（缺失/异常时 undefined）。 */
    const service = (name) => {
      try {
        return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
      } catch {
        return undefined;
      }
    };
    /** 组装带稳定 code 的错误（RPC 错误码用）。 */
    const failure = (code, message) => {
      const error = new Error(message);
      error.code = code;
      return error;
    };

    const sessionController = service('sessionController');
    if (sessionController === undefined || sessionController === null || typeof sessionController.create !== 'function') {
      throw failure('UNAVAILABLE', 'session-controller is unavailable in this deployment');
    }

    const agents = service('agents');
    const sourceSession =
      typeof agents?.get === 'function' ? agents.get(sourceSessionId)?.session : undefined;
    const cwd =
      typeof sourceSession?.header?.cwd === 'string' && sourceSession.header.cwd !== ''
        ? sourceSession.header.cwd
        : undefined;

    // 同一个工作区：优先按 cwd 找 Workspace（create 传 workspaceId 时 Host 才会把新会话
    // attach 到工作区，侧边栏才看得见）；找不到就退回按 cwd 建（默认工作区）。
    let workspaceId;
    const registry = service('workspaceRegistry');
    if (cwd !== undefined && typeof registry?.resolveByPath === 'function') {
      try {
        const workspace = await registry.resolveByPath(cwd);
        if (typeof workspace?.id === 'string' && workspace.id !== '') workspaceId = workspace.id;
      } catch (error) {
        ctx.logger?.debug?.(
          `dsh-session-enhance/offpeak: resolve workspace for ${sourceSessionId} failed: ${String(error?.message ?? error)}`,
        );
      }
    }

    // 沿用源会话记录的 preset（空白会话通常还没有记录 → 交给 Host 默认 preset）。
    let agentPreset;
    const presets = service('agentPresets');
    if (sourceSession !== undefined && typeof presets?.presetForSession === 'function') {
      try {
        agentPreset = presets.presetForSession(sourceSession) ?? undefined;
      } catch {
        // preset 读不到就走默认。
      }
    }

    let created;
    try {
      created = await sessionController.create({
        ...(workspaceId !== undefined ? { workspaceId } : cwd !== undefined ? { cwd } : {}),
        ...(agentPreset === undefined ? {} : { agentPreset }),
      });
    } catch (error) {
      throw failure('CREATE_FAILED', `could not create a new session: ${String(error?.message ?? error)}`);
    }
    const sessionId = created?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw failure('CREATE_FAILED', 'session-controller returned no session id');
    }

    // 写为启用：之后该会话的 Agent 创建/首条提示都会被梁谷规则覆盖。
    controller.setEnabled(sessionId, true);
    return {
      sessionId,
      agentPreset: created?.agentPreset ?? agentPreset ?? null,
      workspaceId: workspaceId ?? null,
    };
  };

  installOffpeakChannel(ctx, createOffpeakHandler({ controller, createLiangguSession }));

  // 控制器自己挂 agent/created · agent/status · agent/disposed 与配置热更新事件，
  // 返回的 dispose 交给 ctx.effect（组件停用即释放全部 hold、清定时器）。
  ctx.effect(() => controller.attach(ctx), 'dsh-session-enhance: 梁谷 hold controller');

  ctx.logger?.info?.(`dsh-session-enhance/offpeak: ready (hold controller + rpc, build=${BUILD})`);
}
