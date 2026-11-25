/**
 * 「新建梁谷会话」的 Host 实现：建一个空白会话，并把它的梁谷开关写为启用。
 *
 * ## 为什么不能只看 live Agent
 *
 * 新建会话页（hero）上的空白会话**可能还没有 live Agent**（Agent 通常在第一轮提示时才创建）。
 * 6.2.0 的第一版只从 `agents.get(sourceSessionId)?.session.header` 取 cwd，拿不到就退化成
 * “不指明工作区”调用 `sessionController.create()`：
 *
 * - Host 会用默认目录建会话，**不会把新会话 attach 到任何工作区**；
 * - 侧边栏/工作区列表里因此看不到它，`uiWorkspace.openSession(newId)` 也无法把界面导航过去；
 * - 用户看到的现象就是“按钮点了没反应”，而实际上每次点击都建出了一个孤儿空白会话。
 *
 * 修复分两步：
 *
 * 1. **源会话头**优先取 live Agent，其次从持久化读（`sessionQuery.traceSession` 的
 *    `target.header`）——冷会话同样能拿到 `cwd` / `agentPreset`；
 * 2. **工作区**优先按「源会话是否是该工作区成员」（`workspace.sessionIds`）判断，
 *    其次按 `cwd` 调 `workspaceRegistry.resolveByPath`；找到就带 `workspaceId` 创建，
 *    Host 会把新会话 attach 进工作区（必要时再显式 `attachSession` 兜底）。
 *
 * ## 依赖全部注入
 *
 * `getService(name)` 由入口提供（`ctx.get` 包装）；`controller.setEnabled` 负责写开关。
 * 这样本模块可以脱离 Cordis 单测。
 *
 * @module dsh-session-enhance/lib/offpeak/create
 */

/**
 * 组装带稳定 `code` 的错误（RPC 错误码用）。
 *
 * @param {string} code - 稳定错误码。
 * @param {string} message - 人类可读说明。
 * @returns {Error & { code: string }} 错误。
 */
function failure(code, message) {
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = code;
  return error;
}

/**
 * 把任意异常收成一行字符串。
 *
 * @param {unknown} error - 捕获到的异常。
 * @returns {string} 说明。
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 新建并启用一个「梁谷会话」。
 *
 * @param {object} options - 依赖。
 * @param {string} options.sourceSessionId - 源会话 id（用于定位工作区/cwd/preset）。
 * @param {(name: string) => any} options.getService - 软取 Host 服务（缺失返回 undefined）。
 * @param {any} options.controller - 梁谷控制器（需要 `setEnabled`）。
 * @param {any} [options.logger] - 日志（debug/warn）。
 * @returns {Promise<{ sessionId: string, agentPreset: string | null, workspaceId: string | null }>} 新会话。
 */
export async function createLiangguSession({ sourceSessionId, getService, controller, logger }) {
  const service = typeof getService === 'function' ? getService : () => undefined;
  /** 安全日志。 */
  const log = (level, message) => {
    try {
      logger?.[level]?.(message);
    } catch {
      // 日志失败与业务无关。
    }
  };

  const sessionController = service('sessionController');
  if (sessionController === undefined || sessionController === null || typeof sessionController.create !== 'function') {
    throw failure('UNAVAILABLE', 'session-controller is unavailable in this deployment');
  }

  // 1) 源会话头：live Agent 优先，其次持久化 trace（冷会话/空白会话也能拿到 cwd）。
  let liveSession;
  const agents = service('agents');
  try {
    liveSession = typeof agents?.get === 'function' ? agents.get(sourceSessionId)?.session : undefined;
  } catch {
    liveSession = undefined;
  }
  let header = liveSession?.header;
  if (header === undefined) {
    const query = service('sessionQuery');
    if (typeof query?.traceSession === 'function') {
      try {
        const trace = await query.traceSession(sourceSessionId);
        header = trace?.target?.header;
      } catch (error) {
        log('debug', `[dsh-session-enhance/offpeak] read header for ${sourceSessionId} failed: ${describeError(error)}`);
      }
    }
  }
  const cwd =
    typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined;

  // preset：header 里有就用（冷会话也可用；这是创建该会话时记录的预设）；
  // header 没有但源会话是 live 的，再问 agentPresets。
  let agentPreset =
    typeof header?.agentPreset === 'string' && header.agentPreset !== '' ? header.agentPreset : undefined;
  if (agentPreset === undefined && liveSession !== undefined) {
    const presets = service('agentPresets');
    if (typeof presets?.presetForSession === 'function') {
      try {
        agentPreset = presets.presetForSession(liveSession) ?? undefined;
      } catch {
        // 读不到就交给 Host 默认 preset。
      }
    }
  }

  // 2) 工作区：成员关系优先（与路径无关，冷热都成立），其次按 cwd 解析。
  const registry = service('workspaceRegistry');
  let workspace;
  if (typeof registry?.list === 'function') {
    try {
      for (const item of registry.list()) {
        if (Array.isArray(item?.sessionIds) && item.sessionIds.includes(sourceSessionId)) {
          workspace = item;
          break;
        }
      }
    } catch {
      workspace = undefined;
    }
  }
  if (workspace === undefined && cwd !== undefined && typeof registry?.resolveByPath === 'function') {
    try {
      workspace = await registry.resolveByPath(cwd);
    } catch (error) {
      log('debug', `[dsh-session-enhance/offpeak] resolve workspace for ${sourceSessionId} failed: ${describeError(error)}`);
    }
  }
  const workspaceId = typeof workspace?.id === 'string' && workspace.id !== '' ? workspace.id : undefined;

  // 3) 建会话：带上 workspaceId（Host 会 attach 到工作区）；拿不到才退到 cwd / 默认目录。
  let created;
  try {
    created = await sessionController.create({
      ...(workspaceId !== undefined ? { workspaceId } : cwd !== undefined ? { cwd } : {}),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    });
  } catch (error) {
    throw failure('CREATE_FAILED', `could not create a new session: ${describeError(error)}`);
  }
  const sessionId = created?.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw failure('CREATE_FAILED', 'session-controller returned no session id');
  }

  // 4) 兜底 attach：理论上带了 workspaceId 时 Host 已经挂好；这里防“解析到工作区但走了 cwd 分支”。
  if (workspace !== undefined && workspaceId === undefined && typeof workspace.attachSession === 'function') {
    try {
      await workspace.attachSession(sessionId);
    } catch (error) {
      log('warn', `[dsh-session-enhance/offpeak] attach ${sessionId} to workspace failed: ${describeError(error)}`);
    }
  }

  // 5) 写开关：之后该会话的 Agent 创建/首条提示都会按梁谷规则处理。
  controller.setEnabled(sessionId, true);
  return {
    sessionId,
    agentPreset: created?.agentPreset ?? agentPreset ?? null,
    workspaceId: workspaceId ?? null,
  };
}
