/**
 * `session_overview` —— 拿到会话 id 先看「概括」，再决定怎么读。
 *
 * ## 它解决什么
 *
 * `session_lookup` 是「一次把整棵树的内容都读出来」的重工具。长会话（真实案例：26 小时、
 * 4331 个事件）上这么做既慢又没用——你真正想先知道的是「这是什么会话、多长、谁派的、
 * 有几个子会话」，然后才决定去读哪一段。
 *
 * 这个工具因此刻意做成**便宜**的：目标会话只读一次日志，树里其他会话只取 header 不读内容。
 *
 * ## 输出怎么用
 *
 * `stats.logSeq` 是判断「要不要改用检索」的判据：几百个事件以内可以直接 `session_lookup`；
 * 上千个事件就该先 `session_grep` 定位、再 `session_read` 读窗口。
 *
 * @module dsh-session-enhance/lib/tools/overview
 */

import {
  DEFAULT_OVERVIEW_RECENT,
  MAX_OVERVIEW_RECENT,
  overviewSession,
} from '../inspect.mjs';
import { arr, obj, prop, text } from './schema.mjs';

/** 会话树节点（只有身份，没有内容）。 */
const treeNode = obj(
  {
    id: prop('string', 'Session ID of the related session.'),
    role: prop('string', '"root", "subagent", or "fork".'),
    relation: prop('string', '"ancestor" (upstream) or "descendant" (spawned by the target).'),
    depth: prop('number', 'Ancestor distance (1 = direct parent) or descendant depth (1 = direct child).'),
    parentId: prop('string', 'That session’s own parent id, or an empty string.'),
    createdAt: prop('string', 'ISO 8601 creation time, or an empty string.'),
    agentPreset: prop('string', 'Agent preset id, or an empty string.'),
    live: prop('boolean', 'True when that session is loaded in memory.'),
    persisted: prop('boolean', 'True when that session has a stored log.'),
  },
  ['id', 'role', 'relation', 'depth', 'parentId', 'createdAt', 'agentPreset', 'live', 'persisted'],
);

/** 会话规模统计（来自一次整份日志读取，log-only 事件也计入）。 */
const statsNode = obj(
  {
    logEvents: prop('number', 'Number of events in the log; the size yardstick.'),
    userMessages: prop('number', 'Real user messages (framework-injected context is excluded).'),
    assistantMessages: prop('number', 'Assistant messages.'),
    summaries: prop('number', 'Compaction summaries and checkpoints.'),
    toolCalls: prop('number', 'Tool calls (log-only events, so this counts what actually happened).'),
    toolResults: prop('number', 'Tool results.'),
    turns: prop('number', 'Turn starts.'),
    firstTime: prop('string', 'ISO 8601 timestamp of the earliest event, or an empty string.'),
    lastTime: prop('string', 'ISO 8601 timestamp of the latest event, or an empty string.'),
    spanMinutes: prop('number', 'Rounded minutes between firstTime and lastTime; 0 when unknown.'),
  },
  ['logEvents', 'userMessages', 'assistantMessages', 'summaries', 'toolCalls', 'toolResults', 'turns', 'firstTime', 'lastTime', 'spanMinutes'],
);

/** 会话身份节点。 */
const sessionNode = obj(
  {
    id: prop('string', 'Session ID exactly as stored.'),
    title: prop('string', 'Folded title, or an empty string.'),
    role: prop('string', '"root", "subagent", or "fork".'),
    workspace: prop('string', 'Working directory recorded in the header, or an empty string.'),
    createdAt: prop('string', 'ISO 8601 creation timestamp, or an empty string.'),
    agentPreset: prop('string', 'Agent preset id, or an empty string.'),
    parentSessionId: prop('string', 'Parent session id, or an empty string for a root session.'),
    delegationDepth: prop('number', 'Delegation depth recorded in the header; 0 for a root session.'),
    isSeeded: prop('boolean', 'True when the session started from another session’s history.'),
    live: prop('boolean', 'True when the session is currently loaded in memory.'),
    persisted: prop('boolean', 'True when the session has a stored log.'),
    isCurrent: prop('boolean', 'True when this is the session that called the tool.'),
  },
  [
    'id',
    'title',
    'role',
    'workspace',
    'createdAt',
    'agentPreset',
    'parentSessionId',
    'delegationDepth',
    'isSeeded',
    'live',
    'persisted',
    'isCurrent',
  ],
);

/** 消息节点。 */
const messageNode = obj(
  {
    seq: prop('number', 'Event sequence number inside the session log.'),
    type: prop('string', 'Raw event type.'),
    role: prop('string', 'Semantic role: user, assistant, or summary.'),
    text: prop('string', 'Plain text, truncated when very long.'),
    time: prop('string', 'ISO 8601 event time, or an empty string.'),
  },
  ['seq', 'type', 'role', 'text', 'time'],
);

/**
 * 构造 `session_overview` 工具定义。
 *
 * @param {any} ctx - Cordis 插件上下文（`execute` 里现场取服务）。
 * @returns {any} 工具定义。
 */
export function buildOverviewTool(ctx) {
  return {
    name: 'session_overview',
    description:
      'Cheap first look at a DSH session by ID: what it is (title/workspace/preset/parent), how big it is (event count, message and tool-call counts, time span), the task it was given, its last few messages, and the shape of its session tree (ancestors + all descendants, identity only). ' +
      'Call this FIRST when the user pastes a session ID: it reads only one log, so it stays fast even for very long sessions, and it tells you whether to read the whole tree (session_lookup) or search it instead (session_grep + session_read). ' +
      'The id may be written as the full id (`session-<uuid>`), a bare UUID (subagent sessions), or an export file name. ' +
      'Read-only.',
    parameters: obj({
      sessionId: prop(
        'string',
        'Target session ID: full id (`session-<uuid>`), bare UUID, or an export file name. Omit to use the current session.',
      ),
      related: prop(
        'boolean',
        'Include the session tree (ancestors + all descendants, identity only, no content reads). Defaults to true.',
      ),
      recentLimit: prop(
        'number',
        `How many recent messages to include, 1-${MAX_OVERVIEW_RECENT}. Defaults to ${DEFAULT_OVERVIEW_RECENT}.`,
      ),
    }),
    output: {
      schema: obj(
        {
          ok: prop('boolean', 'False when the lookup failed; `summary` then explains why.'),
          targetId: prop('string', 'The requested session ID (empty when none was given).'),
          session: sessionNode,
          tree: arr(treeNode, 'Related sessions (ancestors first, then descendants parent-before-child); identity only.'),
          stats: statsNode,
          title: prop('string', 'Folded title, or an empty string.'),
          task: prop('string', 'First user message (what the session was asked to do), truncated; empty when unreadable.'),
          recent: arr(messageNode, 'Most recent semantic messages, oldest first.'),
          surfaceError: prop('string', 'Raw read error when the log surface could not be read; empty on success.'),
          summary: prop('string', 'Human-readable markdown report; render this verbatim.'),
          hint: prop('string', 'Next-step guidance (which tool to use next), or an empty string.'),
        },
        ['ok', 'targetId', 'session', 'tree', 'stats', 'title', 'task', 'recent', 'surfaceError', 'summary', 'hint'],
      ),
      render: (_args, value) => text(value.summary),
    },
    /**
     * 执行一次概览。
     *
     * @param {any} args - 模型参数。
     * @param {any} exec - 执行上下文。
     * @returns {Promise<any>} 输出 schema 对齐的结果。
     */
    async execute(args, exec) {
      const currentId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : '';
      const requested = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
      return overviewSession({
        sessionQuery: typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined,
        sessionId: requested === '' ? currentId : requested,
        currentId,
        related: args?.related !== false,
        recentLimit: args?.recentLimit,
        signal: exec?.signal,
      });
    },
    presentCall: (args) => {
      const requested = typeof args?.sessionId === 'string' && args.sessionId.trim() !== '' ? args.sessionId.trim() : '当前会话';
      return { card: 'generic', title: `会话概览：${requested}` };
    },
  };
}
