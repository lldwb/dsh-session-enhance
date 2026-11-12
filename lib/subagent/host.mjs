/**
 * 「子智能体恢复」——把被终止（dispose/重启后离线）的子会话重新冷恢复。
 *
 * ## 为什么需要它
 *
 * DSH 里子智能体是**独立持久化的子会话**，父会话恢复（重启后重新打开）并不会自动把
 * 子智能体拉起来：
 *
 * - `subagent` 工具派生的子会话：只有「直接父级」对「直接可继续 child」调用
 *   `ctx.subagents.sendMessage(sender, childId, content)` 时才会**冷恢复**
 *   （`dsh-subagent` 的 manager 会 `agents.resume()` 并按 descriptor 复现 preset/工具）；
 * - Agent Teams 的 teammate：0.2.2-rc.2 起 Team 只剩任务板（`agentTeams` 只暴露
 *   `isEnabled` / `setEnabled` / `team_task_*` 对应的 `createTask` / `getTask` /
 *   `listTasks` / `updateTask`），teammate 就是**普通 subagent**，所以也走
 *   `ctx.subagents.sendMessage`。旧版本（0.2.2-rc.1 及更早）的
 *   `agentTeams.listMembers` / `agentTeams.sendMessage` 仍按存在性兼容；
 * - UI 自己不能恢复子代理会话：`dsh-api-session-controller` 对这类会话抛
 *   `ApiSessionSubagentOwnership`（"is a subagent session; use subagent delivery"）。
 *
 * 所以本模块提供两条路径：
 *
 * 1. `list`：父会话（root / Team Lead）里列出直接的子智能体（teammate + subagent child）
 *    及其在线状态；子会话里列出自己的父会话是否在线（能否由父级恢复自己）。
 * 2. `resume`：对未在线的目标逐个发送一条中性的「继续」消息，由官方机制冷恢复；
 *    子会话里调用时会用它的父级作为 sender 恢复它自己。
 *
 * 恢复只发一条消息（不复制历史、不重建 agent），具体组装由 `dsh-subagent` 按该子会话的
 * descriptor 完成 —— 因此恢复出来的是**原来的**子智能体（preset/工具限制/模型都在
 * descriptor 里）。
 *
 * @module dsh-session-enhance/lib/subagent/host
 */

/** 恢复时发给子智能体的中性继续消息。 */
export const SUBAGENT_CONTINUE_TEXT =
  '（上一轮被中断。请从中断处继续完成，不要复述已完成的部分。）';

/** 发给子智能体的完整 content blocks。 */
const CONTINUE_CONTENT = Object.freeze([{ type: 'text', text: SUBAGENT_CONTINUE_TEXT }]);

/**
 * 组装 `{ ok, value }` 成功信封。
 *
 * @param {unknown} value - 返回值。
 * @returns {{ ok: true, value: unknown }} 信封。
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * 组装失败信封（`details` 必须是对象）。
 *
 * @param {string} code - 机器可读错误码。
 * @param {string} message - 人类可读说明。
 * @param {Record<string, unknown>} [details] - 附加诊断字段。
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} 信封。
 */
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

/**
 * 从 payload 读 sessionId。
 *
 * @param {unknown} payload - RPC payload。
 * @returns {string | undefined} 会话 id。
 */
function readSessionId(payload) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = /** @type {{ sessionId?: unknown }} */ (payload).sessionId;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 从 payload 读 targets（按 id 或 name 过滤；省略 = 全部可恢复目标）。
 *
 * @param {unknown} payload - RPC payload。
 * @returns {string[]} 目标列表（可能为空数组 = 不过滤）。
 */
function readTargets(payload) {
  if (payload === null || typeof payload !== 'object') return [];
  const value = /** @type {{ targets?: unknown }} */ (payload).targets;
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

/**
 * 软取一个 Host 服务。
 *
 * @param {any} ctx - 插件上下文。
 * @param {string} name - 服务名。
 * @returns {any} 服务或 undefined。
 */
function serviceOf(ctx, name) {
  return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name];
}

/**
 * 把任意异常收成稳定错误码。
 *
 * @param {unknown} error - 异常。
 * @returns {string} 错误码。
 */
function errorCodeOf(error) {
  if (error !== null && typeof error === 'object') {
    const code = /** @type {{ code?: unknown }} */ (error).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return 'RESUME_FAILED';
}

/**
 * 列出某个父会话的直接子智能体（跨 DSH 版本）。
 *
 * 0.2.2-rc.2 把 `subagents.listChildren()` 从服务上移除了，只保留
 * `listDescendants(rootSessionId)`：它递归返回全部后代，每行带 `depth` 与
 * `kind`（`'child'` / `'diagnostic'`）。所以优先按新 API 取直接子节点
 * （`depth === 1`），再回退到旧 API。两者都没有时返回空数组（不抛）。
 *
 * @param {any} subagents - `ctx.subagents` 服务。
 * @param {string} parentId - 父会话 id。
 * @returns {Promise<any[]>} 直接子节点（`{ id, mode, label?, name? }` 形状）。
 */
export async function listDirectChildren(subagents, parentId) {
  if (typeof subagents?.listDescendants === 'function') {
    const rows = await subagents.listDescendants(parentId, undefined);
    return (Array.isArray(rows) ? rows : []).filter((row) => row?.kind === 'child' && row?.depth === 1);
  }
  if (typeof subagents?.listChildren === 'function') {
    const children = await subagents.listChildren(parentId, undefined);
    return Array.isArray(children) ? children : [];
  }
  return [];
}

/**
 * 创建子智能体恢复的 RPC 端点处理函数（与 HTTP 解耦，可离线单测）。
 *
 * @param {{ ctx: any, logger?: any }} options - 依赖。
 * @returns {(method: string, payload: unknown) => Promise<object>} 处理函数。
 */
export function createSubagentHandler({ ctx, logger }) {
  /**
   * 读一个会话的 header（用于找父会话 / 判断是否子会话）。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<any | undefined>} header 或 undefined。
   */
  const readHeader = async (sessionId) => {
    const query = serviceOf(ctx, 'sessionQuery');
    if (typeof query?.traceSession !== 'function') return undefined;
    const trace = await query.traceSession(sessionId, undefined);
    return trace?.target?.header ?? undefined;
  };

  /**
   * 列出一个「在线父级」名下所有可直接恢复的子智能体。
   *
   * @param {any} parentAgent - 确切在线的父 Agent（root / Team Lead）。
   * @returns {Promise<Array<object>>} 行列表。
   */
  const listTargets = async (parentAgent) => {
    const rows = [];
    const agents = serviceOf(ctx, 'agents');
    const teams = serviceOf(ctx, 'agentTeams');
    const subagents = serviceOf(ctx, 'subagents');

    // 1) Agent Teams 的 teammate（Lead 视角）。
    if (typeof teams?.listMembers === 'function') {
      try {
        const members = teams.listMembers(parentAgent);
        for (const member of Array.isArray(members) ? members : []) {
          if (member?.role !== 'teammate') continue;
          rows.push({
            kind: 'team',
            id: String(member.id ?? ''),
            name: String(member.name ?? ''),
            label: String(member.name ?? member.description ?? ''),
            status: String(member.status ?? 'unknown'),
            live: member.status === 'running',
            resumable: member.status === 'inactive' || member.status === 'failed',
          });
        }
      } catch (error) {
        logger?.debug?.(`[dsh-session-enhance/subagent] listMembers failed: ${String(error?.message ?? error)}`);
      }
    }

    // 2) subagent 工具派生的直接可继续子会话（rc.2 起 teammate 也是 subagent）。
    if (typeof subagents?.listDescendants === 'function' || typeof subagents?.listChildren === 'function') {
      try {
        const children = await listDirectChildren(subagents, parentAgent.id);
        for (const child of children) {
          if (child?.mode !== 'continuable') continue;
          const live = typeof agents?.get === 'function' ? agents.get(child.id) !== undefined : false;
          rows.push({
            kind: 'subagent',
            id: String(child.id ?? ''),
            name: typeof child.name === 'string' ? child.name : '',
            label: String(child.label ?? child.name ?? child.id ?? ''),
            status: live ? 'running' : 'inactive',
            live,
            resumable: !live,
          });
        }
      } catch (error) {
        logger?.debug?.(`[dsh-session-enhance/subagent] listDirectChildren failed: ${String(error?.message ?? error)}`);
      }
    }

    return rows;
  };

  /**
   * 判断一个子会话在父级视角的身份（kind + 名字）。
   *
   * - 0.2.2-rc.1 及更早：`agentTeams.listMembers` 能区分 `role: 'teammate'`；
   * - 0.2.2-rc.2 起：Team 只剩任务板，teammate 就是普通 subagent —— 名字来自
   *   父会话的子智能体 catalog（`listDescendants` 行上的 `name`）。
   *
   * @param {any} parentAgent - 父 Agent。
   * @param {string} childId - 子会话 id。
   * @returns {Promise<{ kind: string, name: string }>} 身份。
   */
  const childIdentityOf = async (parentAgent, childId) => {
    const teams = serviceOf(ctx, 'agentTeams');
    if (typeof teams?.listMembers === 'function') {
      try {
        const members = teams.listMembers(parentAgent);
        const match = (Array.isArray(members) ? members : []).find(
          (member) => member?.role === 'teammate' && String(member.id ?? '') === childId,
        );
        if (match !== undefined) return { kind: 'team', name: String(match.name ?? '') };
      } catch {
        // 旧服务形状不兼容：继续按 subagent 处理。
      }
    }
    const subagents = serviceOf(ctx, 'subagents');
    try {
      const children = await listDirectChildren(subagents, parentAgent.id);
      const match = children.find((child) => String(child?.id ?? '') === childId);
      return { kind: 'subagent', name: typeof match?.name === 'string' ? match.name : '' };
    } catch {
      return { kind: 'subagent', name: '' };
    }
  };

  /**
   * 冷恢复一个目标：teammate 走 agentTeams，subagent child 走 subagents。
   *
   * @param {any} sender - 确切在线的发送者（父级 / Lead）。
   * @param {{ kind: string, id: string, name: string }} target - 目标。
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>} 结果。
   */
  const resumeTarget = async (sender, target) => {
    const subagents = serviceOf(ctx, 'subagents');
    const teams = serviceOf(ctx, 'agentTeams');
    const signal = new AbortController().signal;
    try {
      if (target.kind === 'team' && typeof teams?.sendMessage === 'function' && target.name !== '') {
        await teams.sendMessage(sender, { target: target.name, content: [...CONTINUE_CONTENT], signal });
        return { ok: true };
      }
      if (typeof subagents?.sendMessage === 'function' && target.id !== '') {
        await subagents.sendMessage(sender, target.id, [...CONTINUE_CONTENT], { signal });
        return { ok: true };
      }
      return { ok: false, code: 'CONTINUATION_UNAVAILABLE' };
    } catch (error) {
      return { ok: false, code: errorCodeOf(error), message: String(error?.message ?? error) };
    }
  };

  return async function handle(method, payload) {
    switch (method) {
      case 'list': {
        const sessionId = readSessionId(payload);
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        const agents = serviceOf(ctx, 'agents');
        const liveAgent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
        if (liveAgent !== undefined && liveAgent !== null) {
          const targets = await listTargets(liveAgent);
          return ok({
            mode: 'parent',
            sessionId,
            parentSessionId: '',
            resumableCount: targets.filter((row) => row.resumable).length,
            targets,
          });
        }
        // 不是 live agent：可能是子代理会话（UI 不能直接恢复它）或冷 root 会话。
        const header = await readHeader(sessionId);
        if (header === undefined) return fail('SESSION_NOT_FOUND', `session "${sessionId}" not found`);
        const parentSessionId = typeof header.parentSession === 'string' ? header.parentSession : '';
        if (parentSessionId === '') {
          return ok({ mode: 'root-cold', sessionId, parentSessionId: '', resumableCount: 0, targets: [] });
        }
        const parentAgent = typeof agents?.get === 'function' ? agents.get(parentSessionId) : undefined;
        const parentLive = parentAgent !== undefined && parentAgent !== null;
        return ok({
          mode: 'child',
          sessionId,
          parentSessionId,
          parentLive,
          resumableCount: parentLive ? 1 : 0,
          targets: [
            {
              kind: 'self',
              id: sessionId,
              name: '',
              label: sessionId,
              status: 'inactive',
              live: false,
              resumable: parentLive,
            },
          ],
        });
      }
      case 'resume': {
        const sessionId = readSessionId(payload);
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        const requested = readTargets(payload);
        const agents = serviceOf(ctx, 'agents');
        const liveAgent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;

        /** 真正执行恢复的 sender 与目标集合。 */
        let sender;
        let candidates;
        let mode;
        if (liveAgent !== undefined && liveAgent !== null) {
          sender = liveAgent;
          mode = 'parent';
          candidates = await listTargets(liveAgent);
        } else {
          const header = await readHeader(sessionId);
          if (header === undefined) return fail('SESSION_NOT_FOUND', `session "${sessionId}" not found`);
          const parentSessionId = typeof header.parentSession === 'string' ? header.parentSession : '';
          if (parentSessionId === '') {
            return fail('ROOT_NOT_LIVE', 'This is a root session without a live agent; open it in the UI first.');
          }
          const parentAgent = typeof agents?.get === 'function' ? agents.get(parentSessionId) : undefined;
          if (parentAgent === undefined || parentAgent === null) {
            return fail(
              'PARENT_NOT_LIVE',
              `The parent session "${parentSessionId}" has no live agent; open the parent session first.`,
              { parentSessionId },
            );
          }
          const identity = await childIdentityOf(parentAgent, sessionId);
          sender = parentAgent;
          mode = 'child';
          candidates = [
            {
              kind: identity.kind,
              id: sessionId,
              name: identity.name,
              label: sessionId,
              status: 'inactive',
              live: false,
              resumable: true,
            },
          ];
        }

        const wanted = requested.length === 0 ? candidates : candidates.filter((row) => requested.includes(row.id) || requested.includes(row.name));
        const results = [];
        for (const target of wanted) {
          if (target.live === true || target.id === sender.id) {
            results.push({ id: target.id, kind: target.kind, name: target.name, ok: false, code: 'ALREADY_LIVE' });
            continue;
          }
          if (target.resumable !== true) {
            results.push({ id: target.id, kind: target.kind, name: target.name, ok: false, code: 'NOT_RESUMABLE' });
            continue;
          }
          const outcome = await resumeTarget(sender, target);
          logger?.info?.(
            `[dsh-session-enhance/subagent] resume ${target.kind} ${target.id}: ${outcome.ok ? 'ok' : outcome.code}`,
          );
          results.push({ id: target.id, kind: target.kind, name: target.name, ...outcome });
        }
        return ok({ mode, sessionId, results });
      }
      case 'diag': {
        const subagents = serviceOf(ctx, 'subagents');
        const teams = serviceOf(ctx, 'agentTeams');
        const query = serviceOf(ctx, 'sessionQuery');
        // 0.2.2-rc.2 移除了 `listChildren`：列出能力要看 `listDescendants`。
        const listing =
          typeof subagents?.listDescendants === 'function'
            ? 'listDescendants'
            : typeof subagents?.listChildren === 'function'
              ? 'listChildren'
              : 'none';
        return ok({
          hasSubagents: typeof subagents?.sendMessage === 'function' && listing !== 'none',
          // 旧版 Team 的 teammate 恢复通道；rc.2 起 Team 只剩任务板，此项为 false 属正常。
          hasAgentTeams: typeof teams?.sendMessage === 'function' && typeof teams?.listMembers === 'function',
          hasSessionQuery: typeof query?.traceSession === 'function',
          subagentListing: listing,
        });
      }
      default:
        return fail('UNKNOWN_METHOD', `Unknown endpoint "${String(method)}"`);
    }
  };
}
