/**
 * `session_read` —— 按位置读会话原文：某条事件 + 前后窗口，或直接读尾部。
 *
 * ## 为什么不是复用 `session_lookup`
 *
 * `session_lookup` 给的是**当前表层**折叠后的「语义消息」，而且只给最后 N 条、每条
 * 截断 800 字符。长会话里你要看的是「seq 1737 附近到底发生了什么」——那是**原始日志**，
 * 里面有工具调用、工具结果、被 prune 掉的旧内容、回合边界。这个工具读的就是原始日志，
 * 并用 `surface` 字段告诉你那条还在不在当前表层。
 *
 * ## 两种模式
 *
 * - 给 `seq`：窗口模式（`before`/`after` 各最多 50 条）→ 精读某个命中点；
 * - 不给 `seq`：尾读模式（最后 N 条语义消息，各带 seq）→ 快速看「现在到哪了」，
 *   然后拿其中的 seq 再切窗口。
 *
 * @module dsh-session-enhance/lib/tools/read
 */

import {
  DEFAULT_READ_WINDOW,
  DEFAULT_TAIL_LIMIT,
  MAX_READ_WINDOW,
  MAX_TAIL_LIMIT,
  readSessionWindow,
} from '../inspect.mjs';
import { arr, obj, prop, text } from './schema.mjs';

/** 窗口/尾读里的一条事件。 */
const eventNode = obj(
  {
    seq: prop('number', 'Event sequence number.'),
    type: prop('string', 'Raw event type.'),
    role: prop('string', 'Coarse role: user, assistant, summary, tool, system, or other.'),
    surface: prop('string', '"current" when in the current surface, otherwise an empty string (log-only/shadowed).'),
    time: prop('string', 'ISO 8601 event time, or an empty string.'),
    text: prop('string', 'Readable text extracted from the event, truncated when very long.'),
    isTarget: prop('boolean', 'True for the event named by seq (window mode only).'),
  },
  ['seq', 'type', 'role', 'surface', 'time', 'text', 'isTarget'],
);

/**
 * 构造 `session_read` 工具定义。
 *
 * @param {any} ctx - Cordis 插件上下文（`execute` 里现场取服务）。
 * @returns {any} 工具定义。
 */
export function buildReadTool(ctx) {
  return {
    name: 'session_read',
    description:
      'Read raw log text from one DSH session by position. ' +
      'Give `seq` (typically a hit from session_grep) to get that event plus a before/after window (max 50 each side); omit `seq` to read the tail (last N semantic messages, each with its seq). ' +
      'Unlike session_lookup this returns the raw log — tool calls, tool results and pruned/shadowed events included — and marks which events are still in the current surface. ' +
      'Works for sessions in any workspace. Read-only.',
    parameters: obj({
      sessionId: prop(
        'string',
        'Session to read: full id (`session-<uuid>`), bare UUID, or an export file name. Omit to use the current session.',
      ),
      seq: prop('number', 'Event seq to center the window on (from session_grep or a previous read). Omit to read the tail.'),
      before: prop('number', `How many preceding events to include, 0-${MAX_READ_WINDOW}. Defaults to ${DEFAULT_READ_WINDOW}.`),
      after: prop('number', `How many following events to include, 0-${MAX_READ_WINDOW}. Defaults to ${DEFAULT_READ_WINDOW}.`),
      tailLimit: prop(
        'number',
        `Tail mode only: how many recent messages to return, 1-${MAX_TAIL_LIMIT}. Defaults to ${DEFAULT_TAIL_LIMIT}.`,
      ),
    }),
    output: {
      schema: obj(
        {
          ok: prop('boolean', 'False when the read failed; `summary` then explains why.'),
          targetId: prop('string', 'The session that was read.'),
          mode: prop('string', '"window" (around seq) or "tail" (last messages).'),
          startSeq: prop('number', 'First seq included; 0 when nothing was read.'),
          endSeq: prop('number', 'Last seq included; 0 when nothing was read.'),
          targetSeq: prop('number', 'The requested seq in window mode; 0 in tail mode.'),
          events: arr(eventNode, 'Events in ascending seq order.'),
          summary: prop('string', 'Human-readable markdown report; render this verbatim.'),
          hint: prop('string', 'Next-step guidance, or an empty string.'),
        },
        ['ok', 'targetId', 'mode', 'startSeq', 'endSeq', 'targetSeq', 'events', 'summary', 'hint'],
      ),
      render: (_args, value) => text(value.summary),
    },
    /**
     * 执行一次读取。
     *
     * @param {any} args - 模型参数。
     * @param {any} exec - 执行上下文。
     * @returns {Promise<any>} 输出 schema 对齐的结果。
     */
    async execute(args, exec) {
      const currentId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : '';
      const requested = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
      return readSessionWindow({
        sessionQuery: typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined,
        sessionId: requested === '' ? currentId : requested,
        seq: args?.seq,
        before: args?.before,
        after: args?.after,
        tailLimit: args?.tailLimit,
        signal: exec?.signal,
      });
    },
    presentCall: (args) => ({
      card: 'generic',
      title:
        typeof args?.seq === 'number' ? `读取会话 seq ${args.seq} 附近` : '读取会话尾部',
    }),
  };
}
