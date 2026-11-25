/**
 * 「侧边提问」组件的 Host 半。
 *
 * ## 它做什么
 *
 * 侧边会话**不是**原会话的分支：它是一个**普通的新会话**，只是带着一段「询问提示词」
 * （见 `prompt.mjs`）——提示词里写明参考会话 id，让模型用会话查询工具按 id 去查。
 * 这样做的好处是侧边会话不背原会话的上下文预算，也不会把原会话的思考/工具轨迹带进来；
 * 需要哪些上文由模型按问题自己检索。
 *
 * Host 侧负责三件浏览器半做不到的事：
 *
 * 1. **创建会话**：`sessionController.create({ workspaceId | cwd, agentPreset })`——沿用原会话
 *    的工作区与 Agent 预设（这样侧边会话有同样的会话查询工具），并把新会话挂到该工作区；
 * 2. **只读**：`permissionPresets.setPreset({ sessionId, preset: 'read-only' })`。
 *    **fail-closed**：只读切不上就把刚建的会话归档并报错，绝不留下一个可写的「临时」会话；
 * 3. **权限恢复**：「保留」后把会话切回原会话当时的预设（`restorePreset`）。
 *
 * 浏览器半通过 `lib/sideask/rpc.mjs` 的 `/dsh-session-enhance-sideask` 通道调用这些能力，
 * 并用 `probe` 决定是否注册侧边提问的界面（组件行被停用时界面自动收起）。
 *
 * ## 依赖与降级
 *
 * | 服务 | 用途 | 缺失时 |
 * |---|---|---|
 * | `sessions` / `sessionController` | 读原会话、创建侧边会话 | `create` 返回可读失败 |
 * | `permissionPresets` | 只读与恢复 | 只读切不上 → 归档新会话并报错（fail-closed） |
 * | `agentPresets` | 读原会话的预设 | 省略预设（用部署默认），仍可用 |
 * | `workspaceRegistry` | 找回原会话的工作区 / 归档失败会话 | 退回原会话 cwd |
 *
 * @module dsh-session-enhance/lib/sideask/host
 */

import { BUILD } from '../build.mjs';
import { buildAskPrompt } from './prompt.mjs';
import { createSideAskHandler, installSideAskChannel } from './rpc.mjs';

/** 侧边会话默认的只读权限预设（DSH base bundle 内置）。 */
export const SIDEASK_READ_ONLY_PRESET = 'read-only';

/** 「保留」后恢复不出原预设时的兜底（base bundle 一定配置了它）。 */
export const SIDEASK_FALLBACK_PRESET = 'workspace-write';

/**
 * 失败的内部结果（由 RPC 层转成 `{ ok:false, error }` 信封）。
 *
 * @param {string} code - 稳定错误码。
 * @param {string} message - 人类可读说明。
 * @returns {{ ok: false, code: string, message: string }} 结果。
 */
function failure(code, message) {
  return { ok: false, code, message };
}

/**
 * 读一个活会话的标题（缺失/非字符串时返回 undefined）。
 *
 * @param {any} session - Host Session。
 * @returns {string | undefined} 标题。
 */
function titleOf(session) {
  const title = session?.header?.title;
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined;
}

/**
 * 创建侧边会话的控制器：持有「子会话 → 原会话 / 恢复预设」的进程内登记表。
 *
 * 登记表只活在 Host 进程里：重载后旧条目会丢，`restore` 会退回 catalog 的默认预设；
 * 侧边会话本身仍能正常工作（它的历史里有完整的询问提示词）。
 *
 * @param {object} services - 依赖服务。
 * @param {any} services.sessions - Host Session 存储（`get(id)`）。
 * @param {any} services.agents - Agent 注册表（`get(id)`，执行命令需要 Agent）。
 * @param {any} services.commands - 命令服务（`execute(agent, '/permission <preset>', [], signal)`）。
 * @param {any} services.sessionController - 会话控制器（`create(request)`）。
 * @param {any} services.permissionPresets - 权限预设服务（只读 `catalog()`；安装版没有 `setPreset`）。
 * @param {any} services.agentPresets - Agent 预设注册表（`presetForSession`）。
 * @param {any} services.workspaceRegistry - 工作区注册表（`list` / `archiveSession`）。
 * @returns {object} 控制器。
 */
export function createSideAskController({
  sessions, agents, commands, sessionController, permissionPresets, agentPresets, workspaceRegistry,
}) {
  /** @type {Map<string, { parentSessionId: string, restorePreset: string | null }>} */
  const registry = new Map();

  /**
   * 找到会话所属的工作区。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {any | undefined} 工作区实体。
   */
  function workspaceOf(sessionId) {
    try {
      const list = workspaceRegistry?.list?.() ?? [];
      return list.find(item => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId));
    } catch {
      return undefined;
    }
  }

  /**
   * 读会话的 Agent 预设（读不到就用默认）。
   *
   * @param {any} session - Host Session。
   * @returns {string | null} 预设 id。
   */
  function presetOf(session) {
    try {
      const preset = agentPresets?.presetForSession?.(session);
      return typeof preset === 'string' && preset !== '' ? preset : null;
    } catch {
      return null;
    }
  }

  /**
   * 把一个活会话切到某个权限预设。
   *
   * 安装版的 `permissionPresets` 服务**没有** `setPreset` 方法（只有 `catalog()`），
   * 官方切换当前会话的方式是执行斜杠命令 `/permission <preset>`（composer 的权限控件
   * 就是走 `session.command('/permission …')`）。Host 侧用 `commands.execute(agent, …)`
   * 走同一条命令，效果一致：命令内部同时写 sandbox 模式与 approval policy。
   *
   * @param {string} sessionId - 会话 id。
   * @param {string} preset - 预设 key。
   * @returns {Promise<{ ok: true, value: object } | { ok: false, code: string, message: string }>} 结果。
   */
  async function switchPreset(sessionId, preset) {
    try {
      const agent = agents?.get?.(sessionId);
      if (agent === undefined) {
        return failure('SESSION_NOT_LIVE', `session "${sessionId}" is not live in this Host`);
      }
      const controller = new AbortController();
      const execution = await commands.execute(agent, `/permission ${preset}`, [], controller.signal);
      if (execution === undefined) {
        return failure('PRESET_COMMAND_UNAVAILABLE', 'this Host offers no /permission command');
      }
      if (execution.result?.kind === 'error') {
        return failure('SET_PRESET_FAILED', String(execution.result.text ?? 'the /permission command failed'));
      }
      return { ok: true, value: { preset } };
    } catch (error) {
      return failure('SET_PRESET_FAILED', String(error?.message ?? error));
    }
  }

  /**
   * 读会话当前的权限预设（不是 Agent 预设）。
   *
   * `permissionPresets.current(session)` 是安装版提供的读法；`custom` / `auto` 或读不到时
   * 返回 null（调用方退回 catalog 默认）。注意别把它和 `agentPresets.presetForSession`
   * 混了：后者是 standard / cordis 这类**能力组合**，不是 read-only / workspace-write
   * 这类**权限预设**，用错会把 `/permission standard` 发给宿主并失败。
   *
   * @param {any} session - Host Session。
   * @returns {string | null} 权限预设 key。
   */
  function permissionOf(session) {
    try {
      const preset = permissionPresets?.current?.(session);
      if (typeof preset !== 'string' || preset === '' || preset === 'custom' || preset === 'auto') return null;
      return preset;
    } catch {
      return null;
    }
  }

  /**
   * 「保留」后要恢复的预设：登记表里的原预设 → catalog 默认值 → `workspace-write`。
   *
   * @param {string} sessionId - 侧边会话 id。
   * @returns {string} 预设 key。
   */
  function restorePresetFor(sessionId) {
    const entry = registry.get(sessionId);
    if (entry !== undefined && typeof entry.restorePreset === 'string' && entry.restorePreset !== '') {
      return entry.restorePreset;
    }
    try {
      const catalog = permissionPresets?.catalog?.();
      if (typeof catalog?.defaultPreset === 'string' && catalog.defaultPreset !== '') {
        return catalog.defaultPreset;
      }
    } catch { /* 退回固定值 */ }
    return SIDEASK_FALLBACK_PRESET;
  }

  return {
    /**
     * 为原会话创建一个新的只读侧边会话，并生成询问提示词。
     *
     * 失败时不会留下可写的临时会话：只读切不上就归档刚建的会话。
     *
     * @param {object} request - 创建参数。
     * @param {string} request.parentSessionId - 原会话 id。
     * @param {string} [request.quote] - 用户选中的原文。
     * @param {string} [request.locale] - 浏览器 locale id（决定提示词语言）。
     * @returns {Promise<{ ok: true, value: object } | { ok: false, code: string, message: string }>} 结果。
     */
    async create({ parentSessionId, quote, locale }) {
      const parent = sessions?.get?.(parentSessionId);
      if (parent === undefined) {
        return failure('SESSION_NOT_FOUND', `session "${parentSessionId}" is not live in this Host`);
      }
      const workspace = workspaceOf(parentSessionId);
      const cwd = typeof parent?.header?.cwd === 'string' ? parent.header.cwd : undefined;
      const parentAgentPreset = presetOf(parent);
      // 权限预设与 Agent 预设是两套东西：这里记的是「保留后要恢复的权限」。
      const parentPermission = permissionOf(parent);
      let created;
      try {
        created = await sessionController.create({
          ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
          ...(workspace === undefined && cwd !== undefined ? { cwd } : {}),
          ...(parentAgentPreset === null ? {} : { agentPreset: parentAgentPreset }),
        });
      } catch (error) {
        return failure('CREATE_FAILED', String(error?.message ?? error));
      }
      const sessionId = created?.sessionId;
      if (typeof sessionId !== 'string' || sessionId === '') {
        return failure('CREATE_FAILED', 'the Host returned no session id');
      }
      const readOnly = await switchPreset(sessionId, SIDEASK_READ_ONLY_PRESET);
      if (readOnly.ok === false) {
        // fail-closed：不留可写会话。
        try {
          await workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true });
        } catch { /* 归档失败也照旧返回错误：会话已建但只读未生效，调用方不应继续 */ }
        return failure('READ_ONLY_UNAVAILABLE', readOnly.message);
      }
      registry.set(sessionId, { parentSessionId, restorePreset: parentPermission });
      const prompt = buildAskPrompt({
        parentSessionId,
        parentTitle: titleOf(parent),
        quote,
        locale,
      });
      return {
        ok: true,
        value: {
          sessionId,
          prompt,
          restorePreset: parentPermission,
          parentSessionId,
          parentTitle: titleOf(parent),
        },
      };
    },

    /**
     * 切到指定权限预设（浏览器半「改回临时」时用只读）。
     *
     * @param {object} request - 参数。
     * @param {string} request.sessionId - 侧边会话 id。
     * @param {string} request.preset - 预设 key。
     * @returns {Promise<{ ok: true, value: object } | { ok: false, code: string, message: string }>} 结果。
     */
    async setPreset({ sessionId, preset }) {
      return switchPreset(sessionId, preset);
    },

    /**
     * 「保留」后恢复原会话当时的预设。
     *
     * @param {object} request - 参数。
     * @param {string} request.sessionId - 侧边会话 id。
     * @returns {Promise<{ ok: true, value: object } | { ok: false, code: string, message: string }>} 结果。
     */
    async restore({ sessionId }) {
      const preset = restorePresetFor(sessionId);
      const result = await switchPreset(sessionId, preset);
      if (result.ok === false) return result;
      return { ok: true, value: { preset } };
    },

    /**
     * 标签关闭后清理登记条目。
     *
     * @param {object} request - 参数。
     * @param {string} request.sessionId - 侧边会话 id。
     * @returns {{ forgotten: boolean }} 结果。
     */
    forget({ sessionId }) {
      return { forgotten: registry.delete(sessionId) };
    },

    /** 进程内登记表大小（诊断用）。 */
    get size() {
      return registry.size;
    },

    /** 清空登记表（组件卸载时）。 */
    dispose() {
      registry.clear();
    },
  };
}

/**
 * 挂载「侧边提问」组件：等服务就绪后装 RPC 通道。
 *
 * @param {object} ctx - Cordis 上下文（插件 scope）。
 * @returns {void}
 */
export function installSideAskComponent(ctx) {
  ctx.inject?.(
    ['sessions', 'agents', 'commands', 'sessionController', 'permissionPresets', 'agentPresets', 'workspaceRegistry'],
    (scope) => {
      const controller = createSideAskController({
        sessions: scope.sessions,
        agents: scope.agents,
        commands: scope.commands,
        sessionController: scope.sessionController,
        permissionPresets: scope.permissionPresets,
        agentPresets: scope.agentPresets,
        workspaceRegistry: scope.workspaceRegistry,
      });
      scope.effect?.(() => () => { controller.dispose(); }, 'dsh-session-enhance: side-ask registry');
      installSideAskChannel(scope, createSideAskHandler({ controller, build: BUILD }));
    },
  );
}
