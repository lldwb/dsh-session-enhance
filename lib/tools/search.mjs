/**
 * `session_grep` —— 在一个会话**内部**按关键词检索（返回 seq + 片段）。
 *
 * ## 为什么这个工具必须存在
 *
 * 长会话（真实案例：26 小时、4331 个事件、3.7 MB 压缩日志）没法「读一遍」：`session_lookup`
 * 只给最后几条，而官方 `session_event_search` 带**工作区授权**
 * （`SESSION_QUERY_TOOL_UNAUTHORIZED: session target is outside the caller workspace`），
 * 用户在别的工作区粘来的会话 id 直接被拒。本插件走 `sessionQuery` 服务，没有这层限制。
 *
 * ## 语义（刻意做成可预测）
 *
 * - **字面匹配、大小写不敏感**，不做同义词/模糊/正则——模型能预期自己搜到什么；
 * - 空格分隔的多个词是 **AND**（都要出现，顺序不限，最多 5 个）；
 * - 命中按 seq 升序返回，带 `nextFromSeq` 供翻页（`fromSeq` 继续往后搜）。
 *
 * 定位到 seq 之后用 `session_read` 读该位置前后的原文——这是「检索 → 精读」的闭环。
 *
 * @module dsh-session-enhance/lib/tools/search
 */

import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_TERMS,
  searchSession,
} from '../inspect.mjs';
import { arr, obj, prop, text } from './schema.mjs';

/** 一条命中。 */
const hitNode = obj(
  {
    seq: prop('number', 'Event sequence number — pass this to session_read to see the surrounding原文.'),
    type: prop('string', 'Raw event type, e.g. "user/message" or "tool/result".'),
    role: prop('string', 'Coarse role: user, assistant, summary, tool, system, or other.'),
    time: prop('string', 'ISO 8601 event time, or an empty string.'),
    surface: prop('string', '"current" when the event is in the current model surface, otherwise "shadowed"/"log-only".'),
    snippet: prop('string', 'Bounded excerpt of the matched text.'),
  },
  ['seq', 'type', 'role', 'time', 'surface', 'snippet'],
);

/**
 * 构造 `session_grep` 工具定义。
 *
 * @param {any} ctx - Cordis 插件上下文（`execute` 里现场取服务）。
 * @returns {any} 工具定义。
 */
export function buildSearchTool(ctx) {
  return {
    name: 'session_grep',
    description:
      'Full-text search INSIDE one DSH session (not across sessions): find where something was said or done in a long conversation. ' +
      'Literal, case-insensitive; space-separated terms are AND-ed (max 5). Returns hits in seq order with a snippet, plus `nextFromSeq` for paging. ' +
      'Pair it with session_read: search gives you the seq, session_read shows the raw log around it. ' +
      'Works for sessions in any workspace (unlike the official session_event_search, which refuses sessions outside the caller workspace). ' +
      'Read-only.',
    parameters: obj({
      sessionId: prop(
        'string',
        'Session to search: full id (`session-<uuid>`), bare UUID, or an export file name. Omit to use the current session.',
      ),
      query: prop('string', `What to look for: literal text, up to ${MAX_SEARCH_TERMS} space-separated terms AND-ed together.`),
      limit: prop('number', `How many hits to return, 1-${MAX_SEARCH_LIMIT}. Defaults to ${DEFAULT_SEARCH_LIMIT}.`),
      fromSeq: prop('number', 'Only return hits at or after this seq; pass the previous `nextFromSeq` to page forward.'),
      types: arr(
        prop('string', 'Raw event type to include, e.g. "user/message".'),
        'Only search these event types; omit to search all semantic documents.',
      ),
    }),
    output: {
      schema: obj(
        {
          ok: prop('boolean', 'False when the search failed; `summary` then explains why.'),
          targetId: prop('string', 'The session that was searched.'),
          query: prop('string', 'The query as given.'),
          terms: arr(prop('string', 'One AND term.'), 'The parsed terms that were searched.'),
          hits: arr(hitNode, 'Hits in ascending seq order.'),
          hitCount: prop('number', 'Number of hits in this page.'),
          nextFromSeq: prop('number', 'Pass this as fromSeq to get the next page; 0 when there is no more.'),
          summary: prop('string', 'Human-readable markdown report; render this verbatim.'),
          hint: prop('string', 'Next-step guidance, or an empty string.'),
        },
        ['ok', 'targetId', 'query', 'terms', 'hits', 'hitCount', 'nextFromSeq', 'summary', 'hint'],
      ),
      render: (_args, value) => text(value.summary),
    },
    /**
     * 执行一次检索。
     *
     * @param {any} args - 模型参数。
     * @param {any} exec - 执行上下文。
     * @returns {Promise<any>} 输出 schema 对齐的结果。
     */
    async execute(args, exec) {
      const currentId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : '';
      const requested = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
      return searchSession({
        sessionQuery: typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined,
        sessionId: requested === '' ? currentId : requested,
        query: args?.query,
        limit: args?.limit,
        fromSeq: args?.fromSeq,
        types: args?.types,
        signal: exec?.signal,
      });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `会话内检索：${String(args?.query ?? '')}`,
    }),
  };
}
