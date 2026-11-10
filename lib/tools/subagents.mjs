/**
 * `session_resume_subagents` —— 列出并冷恢复被终止的子智能体。
 *
 * ## 用途
 *
 * 重启 / 长任务中断之后，子智能体（`subagent` 工具派生的子会话、Agent Teams 的
 * teammate）的会话还在，但进程内的 Agent 已经没了。DSH 只允许**父级**通过 continuation
 * 通道把它们冷恢复；UI 打开子会话时会被 `ApiSessionSubagentOwnership` 拒绝。
 *
 * 这个工具把那条通道交给模型：
 *
 * - 在主会话（root / Lead）里调用：列出它名下所有子智能体及其状态，把未在线的逐个恢复；
 * - 在子会话里调用：通过它的父会话恢复它自己（父会话必须在线）。
 *
 * 恢复只发一条中性的「继续」消息，由 `dsh-subagent` / `dsh-experimental-agent-team`
 * 按该子会话的 descriptor 冷恢复——preset、工具限制、模型都沿用原记录。
 *
 * @module dsh-session-enhance/lib/tools/subagents
 */

import { arr, enumProp, obj, prop, text } from './schema.mjs';

/**
 * 目标节点 schema（列出的子智能体 / 本次恢复的结果共用）。
 *
 * @param {boolean} withOk - 是否包含恢复结果字段。
 * @returns {any} 对象 schema。
 */
function targetNode(withOk) {
  /** @type {Record<string, any>} */
  const properties = {
    id: prop('string', 'Session ID of the child.'),
    kind: prop('string', '"team" (Agent Teams teammate), "subagent" (delegation child), or "self" (this session itself).'),
    name: prop('string', 'Teammate name when kind is "team", otherwise an empty string.'),
    label: prop('string', 'Human-readable label or ID.'),
    status: prop('string', 'Runtime status: running, inactive, failed, or unknown.'),
    live: prop('boolean', 'True when the child agent is currently loaded in memory.'),
    resumable: prop('boolean', 'True when this tool can cold-resume the child now.'),
  };
  if (withOk) {
    properties.ok = prop('boolean', 'True when the resume message was accepted.');
    properties.code = prop('string', 'Stable error code when ok is false, otherwise an empty string.');
  }
  const required = Object.keys(properties);
  return obj(properties, required);
}

/** 目标列表节点（恢复结果额外带 ok/code）。 */
export const targetNodeSchema = targetNode(false);

/** 恢复结果节点。 */
export const resumedNodeSchema = targetNode(true);

/**
 * 构造 `session_resume_subagents` 工具定义。
 *
 * @param {(method: string, payload: unknown) => Promise<object>} handler - 与 RPC 共用的处理函数。
 * @returns {any} 工具定义。
 */
export function buildResumeSubagentsTool(handler) {
  /**
   * 把 handler 的失败信封转成工具输出（失败分支也要满足 output schema）。
   *
   * @param {string} sessionId - 会话 id。
   * @param {string} message - 失败说明。
   * @returns {any} 输出。
   */
  const failure = (sessionId, message) => ({
    ok: false,
    mode: 'parent',
    sessionId,
    parentSessionId: '',
    dryRun: false,
    resumableCount: 0,
    targets: [],
    resumed: [],
    summary: `❌ 恢复子智能体失败：${message}`,
  });

  return {
    name: 'session_resume_subagents',
    description:
      'List and cold-resume the subagents of a DSH session. After a restart or an interrupted long task, child sessions (delegation subagents and Agent Teams teammates) are persisted but their live agents are gone; DSH only resumes them when their parent sends them a continuation message. ' +
      'Call this in the parent (root / Lead) session to resume all offline children, or in a child session to resume that child through its parent. ' +
      'Set dryRun=true to only list. Omit sessionId to use the current session. Resuming sends one neutral "continue" message per child, so it costs model tokens.',
    parameters: obj({
      sessionId: prop(
        'string',
        'Parent (root) session ID, or a child session ID to resume through its parent. Omit to use the current session.',
      ),
      targets: arr(
        prop('string', 'A child session ID or teammate name.'),
        'Only resume these children. Omit to resume every offline child.',
      ),
      dryRun: prop('boolean', 'Only list the children and their status; do not send any resume message.'),
    }),
    output: {
      schema: obj(
        {
          ok: prop('boolean', 'False when the operation failed; `summary` explains why.'),
          mode: enumProp(['parent', 'child', 'root-cold'], 'Which side the request was served from.'),
          sessionId: prop('string', 'The session this tool inspected.'),
          parentSessionId: prop('string', 'Parent session ID for a child session, else an empty string.'),
          dryRun: prop('boolean', 'True when no resume message was sent.'),
          resumableCount: prop('number', 'How many children can be resumed right now.'),
          targets: arr(targetNodeSchema, 'Children visible from this session.'),
          resumed: arr(resumedNodeSchema, 'Resume attempts performed by this call.'),
          summary: prop('string', 'Human-readable markdown report; render this verbatim.'),
        },
        ['ok', 'mode', 'sessionId', 'parentSessionId', 'dryRun', 'resumableCount', 'targets', 'resumed', 'summary'],
      ),
      render: (_args, value) => text(value.summary),
    },
    /**
     * 执行一次列出 / 恢复。
     *
     * @param {any} args - 模型参数。
     * @param {any} exec - 执行上下文（`agent`、`signal`）。
     * @returns {Promise<any>} 输出 schema 对齐的结果。
     */
    async execute(args, exec) {
      const currentId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : '';
      const requested = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
      const sessionId = requested === '' ? currentId : requested;
      if (sessionId === '') return failure('', '当前会话没有可用的会话 ID。');
      const targets = Array.isArray(args?.targets)
        ? args.targets.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
        : [];
      const dryRun = args?.dryRun === true;

      let listed;
      try {
        listed = await handler('list', { sessionId });
      } catch (error) {
        return failure(sessionId, String(error?.message ?? error));
      }
      if (listed?.ok !== true) {
        return failure(sessionId, String(listed?.error?.message ?? listed?.error?.code ?? 'list failed'));
      }
      const view = listed.value;
      const rows = Array.isArray(view?.targets) ? view.targets : [];
      const resumable = rows.filter((row) => row.resumable === true);
      const mode = typeof view?.mode === 'string' ? view.mode : 'parent';
      const parentSessionId = typeof view?.parentSessionId === 'string' ? view.parentSessionId : '';

      let resumed = [];
      if (dryRun !== true && mode !== 'root-cold' && resumable.length > 0) {
        let outcome;
        try {
          outcome = await handler('resume', { sessionId, targets });
        } catch (error) {
          return failure(sessionId, String(error?.message ?? error));
        }
        if (outcome?.ok !== true) {
          return failure(sessionId, String(outcome?.error?.message ?? outcome?.error?.code ?? 'resume failed'));
        }
        resumed = Array.isArray(outcome.value?.results) ? outcome.value.results : [];
      }

      const lines = [];
      if (mode === 'root-cold') {
        lines.push('❌ 这是一个根会话，但它当前没有 live Agent；请先在界面里打开它再重试。');
      } else if (mode === 'child') {
        lines.push(`本会话是子会话（父会话 \`${parentSessionId}\`）。`);
        if (resumable.length === 0) {
          lines.push(resumableSizeNote(rows));
        } else if (dryRun) {
          lines.push('✅ 可以通过父会话恢复本会话（dryRun，未发送）。');
        } else {
          const hit = resumed.find((item) => item.id === sessionId);
          lines.push(hit?.ok === true ? '✅ 已通过父会话恢复本会话。' : `❌ 恢复失败：${hit?.code ?? 'UNKNOWN'}`);
        }
      } else {
        lines.push(`父会话 \`${sessionId}\` 的子智能体共 ${rows.length} 个，其中可恢复 ${resumable.length} 个。`);
        if (rows.length === 0) {
          lines.push('（没有注册在册的子智能体：它们可能是一次性 external 子代理，或已经清理。）');
        } else if (dryRun) {
          for (const row of rows) lines.push(`- ${formatRow(row)}`);
        } else if (resumed.length === 0) {
          lines.push('✅ 所有子智能体都在线，无需恢复。');
        } else {
          for (const row of resumed) {
            lines.push(`- ${formatRow(row)} → ${row.ok === true ? '已恢复' : `失败（${row.code}）`}`);
          }
        }
      }
      return {
        ok: true,
        mode,
        sessionId,
        parentSessionId,
        dryRun,
        resumableCount: resumable.length,
        targets: rows.map(toTargetView),
        resumed: resumed.map((row) => ({ ...toTargetView(row), ok: row.ok === true, code: row.ok === true ? '' : String(row.code ?? '') })),
        summary: lines.join('\n'),
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.dryRun === true ? '列出子智能体' : '恢复子智能体',
    }),
  };
}

/**
 * 把目标行收口成输出 schema 的字段（不出现 null）。
 *
 * @param {any} row - 内部行。
 * @returns {any} 输出行。
 */
function toTargetView(row) {
  return {
    id: typeof row?.id === 'string' ? row.id : '',
    kind: typeof row?.kind === 'string' ? row.kind : 'subagent',
    name: typeof row?.name === 'string' ? row.name : '',
    label: typeof row?.label === 'string' ? row.label : '',
    status: typeof row?.status === 'string' ? row.status : 'unknown',
    live: row?.live === true,
    resumable: row?.resumable === true,
  };
}

/**
 * 一行目标的可读描述。
 *
 * @param {any} row - 目标行。
 * @returns {string} 描述。
 */
function formatRow(row) {
  const name = typeof row?.name === 'string' && row.name !== '' ? `${row.name} ` : '';
  return `${name}\`${row?.label ?? row?.id ?? ''}\`（${row?.kind ?? 'subagent'}，${row?.live === true ? '在线' : '离线'}）`;
}

/**
 * 子会话不可恢复时的说明。
 *
 * @param {any[]} rows - 目标行。
 * @returns {string} 说明。
 */
function resumableSizeNote(rows) {
  const self = rows.find((row) => row.kind === 'self');
  if (self !== undefined && self.resumable !== true) {
    return '❌ 本会话的父会话当前不在线；请先打开父会话（主会话）再重试。';
  }
  return '当前没有可恢复的目标。';
}
