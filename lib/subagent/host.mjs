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
 * - Agent Teams 的 teammate：Lead 对 `inactive` 成员调用
 *   `ctx.agentTeams.sendMessage(lead, { target: name, content })` 会冷恢复；
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

/** 子智能体恢复的 RPC 通道（与分享 / 重试 / 上下文通道各自独立）。 */
export const SUBAGENT_RPC_CHANNEL = '/dsh-session-enhance-subagent';

/** 恢复时发给子智能体的中性继续消息（与重试半的 followup 文案一致）。 */
export const SUBAGENT_CONTINUE_TEXT =
  '（上一轮被中断。请从中断处继续完成，不要复述已完成的部分。）';

/** 发给子智能体的完整 content blocks。 */
const CONTINUE_CONTENT = Object.freeze([{ type: 'text', text: SUBAGENT_CONTINUE_TEXT }]);

/** 请求体上限：只传 sessionId / targets，32 KiB 富余。 */
export const MAX_RPC_BODY_BYTES = 32 * 1024;

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

    // 2) subagent 工具派生的直接可继续子会话。
    if (typeof subagents?.listChildren === 'function') {
      try {
        const children = await subagents.listChildren(parentAgent.id, undefined);
        for (const child of Array.isArray(children) ? children : []) {
          if (child?.mode !== 'continuable') continue;
          const live = typeof agents?.get === 'function' ? agents.get(child.id) !== undefined : false;
          rows.push({
            kind: 'subagent',
            id: String(child.id ?? ''),
            name: '',
            label: String(child.label ?? child.id ?? ''),
            status: live ? 'running' : 'inactive',
            live,
            resumable: !live,
          });
        }
      } catch (error) {
        logger?.debug?.(`[dsh-session-enhance/subagent] listChildren failed: ${String(error?.message ?? error)}`);
      }
    }

    return rows;
  };

  /**
   * 判断一个子会话是不是某个 Lead 的 teammate，并返回成员名。
   *
   * @param {any} parentAgent - 父 Agent。
   * @param {string} childId - 子会话 id。
   * @returns {string | undefined} teammate 名字（不是 teammate 时为 undefined）。
   */
  const teammateNameOf = (parentAgent, childId) => {
    const teams = serviceOf(ctx, 'agentTeams');
    if (typeof teams?.listMembers !== 'function') return undefined;
    try {
      const members = teams.listMembers(parentAgent);
      const match = (Array.isArray(members) ? members : []).find(
        (member) => member?.role === 'teammate' && String(member.id ?? '') === childId,
      );
      return match === undefined ? undefined : String(match.name ?? '');
    } catch {
      return undefined;
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
          const teammateName = teammateNameOf(parentAgent, sessionId);
          sender = parentAgent;
          mode = 'child';
          candidates = [
            {
              kind: teammateName === undefined ? 'subagent' : 'team',
              id: sessionId,
              name: teammateName ?? '',
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
        return ok({
          hasSubagents: typeof subagents?.sendMessage === 'function' && typeof subagents?.listChildren === 'function',
          hasAgentTeams: typeof teams?.sendMessage === 'function' && typeof teams?.listMembers === 'function',
          hasSessionQuery: typeof query?.traceSession === 'function',
        });
      }
      default:
        return fail('UNKNOWN_METHOD', `Unknown endpoint "${String(method)}"`);
    }
  };
}

/**
 * 在 Host 的 web server 上注册子智能体恢复的 RPC 前缀路由。
 *
 * 与其它通道相同的配方：自建 prefix 路由 + `connection.admit(req)` 认证；
 * `webServer` 形状不兼容时退回官方 `connection.rpc.handle`。
 *
 * @param {any} ctx - 插件上下文。
 * @param {(method: string, payload: unknown) => Promise<object>} handler - 端点处理函数。
 * @returns {void}
 */
export function installSubagentChannel(ctx, handler) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['connection', 'webServer'], (rpcCtx) => {
    rpcCtx.effect(() => {
      const connection = rpcCtx.connection;
      const webServer = rpcCtx.webServer;
      if (connection === undefined || webServer === undefined) return () => {};

      /** 读请求体（Node 的 req 是 AsyncIterable<Buffer>）。 */
      const readBody = async (req) => {
        const chunks = [];
        let total = 0;
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > MAX_RPC_BODY_BYTES) return undefined;
          chunks.push(buffer);
        }
        return Buffer.concat(chunks);
      };

      try {
        return webServer.register({
          kind: 'prefix',
          path: SUBAGENT_RPC_CHANNEL,
          handler: async (req, res) => {
            let admission;
            try {
              admission = connection.admit(req);
            } catch {
              res.writeHead(500);
              res.end('admission failed');
              return;
            }
            if ('rejection' in admission) {
              res.writeHead(admission.rejection);
              res.end('rejected');
              return;
            }
            if (req.method !== 'POST') {
              res.writeHead(404);
              res.end('not found');
              return;
            }
            let body;
            try {
              body = await readBody(req);
            } catch {
              res.writeHead(400);
              res.end('body unreadable');
              return;
            }
            if (body === undefined) {
              res.writeHead(413);
              res.end('body too large');
              return;
            }
            let request;
            try {
              request = JSON.parse(body.toString('utf8'));
            } catch {
              res.writeHead(400);
              res.end('body is not JSON');
              return;
            }
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const endpoint = url.pathname.startsWith(`${SUBAGENT_RPC_CHANNEL}/`)
              ? url.pathname.slice(SUBAGENT_RPC_CHANNEL.length + 1)
              : '';
            let result;
            try {
              result = await handler(String(request?.method ?? endpoint), request?.payload);
            } catch (error) {
              result = fail('INTERNAL', String(error?.message ?? error));
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'server-response', rpcId: request?.rpcId, result }));
          },
        });
      } catch {
        try {
          return connection.rpc.handle(SUBAGENT_RPC_CHANNEL, async (method, payload) =>
            handler(method, payload),
          );
        } catch {
          return () => {};
        }
      }
    }, 'dsh-session-enhance: subagent rpc channel');
  });
}
