/**
 * 会话「先概括、再定向读」三件套：`overview` / `search` / `read`。
 *
 * ## 为什么需要它们（真实痛点）
 *
 * `session_lookup` 一次就把「元数据 + 整棵树 + 每个会话的内容摘要」都读出来。对
 * 短会话够用，但真实场景里有两个硬问题：
 *
 * 1. **长会话没有概括**：一个 26 小时、4331 个事件的会话，`session_lookup` 只给最后
 *    几条（还各自截断到 800 字符）。想知道「这个会话一共干了什么、有多少轮、跨度多大、
 *    任务是什么」，只能靠模型自己数——数不出来。
 * 2. **长会话没有检索**：官方 `session_event_search` / `session_event_read` 带**工作区
 *    授权**（真实报错 `SESSION_QUERY_TOOL_UNAUTHORIZED: session target is outside the
 *    caller workspace`），读别的工作区的会话直接被拒；而用户主动粘过来的会话 id
 *    经常来自别的工作区。本插件走 `ctx.get('sessionQuery')` 服务，没有这层工具级限制，
 *    所以补上「会话内检索 + 按位置定向读」是这里唯一能做的事。
 *
 * ## 三件套的分工
 *
 * | 工具 | 一次调用读什么 | 用来回答 |
 * |---|---|---|
 * | `session_overview` | 目标会话**一次**日志读取（+ 语料库列举） | 这个会话是什么、多长、谁派的、下一步该读哪 |
 * | `session_search` | 目标会话**一次**日志读取（扫描语义文档） | 里面提到 X 的地方在哪（给 seq） |
 * | `session_read` | 目标会话**一次**日志读取（一条 + 上下文窗口） | 这个 seq 前后到底写了什么 |
 *
 * 三者都是「一次读取、有限输出」，所以可以反复调用而不会像 `session_lookup` 那样
 * 一次读二十份日志。
 *
 * @module dsh-session-enhance/lib/inspect
 */

import {
  classifyRole,
  errorCodeOf,
  flattenDescendants,
  isCompactCheckpoint,
  isInjectedUserEvent,
  messageFromEvent,
  messageTextOf,
  messagesOf,
  resolveFailureSummary,
  toIso,
  traceSessionById,
  truncateText,
} from './service.mjs';

/** `session_overview` 默认带出多少条最近消息。 */
export const DEFAULT_OVERVIEW_RECENT = 3;

/** `session_overview` 最近消息条数上限。 */
export const MAX_OVERVIEW_RECENT = 20;

/** 概览里「任务」一行的字符上限。 */
export const OVERVIEW_TASK_LIMIT = 300;

/** 概览里单条消息的字符上限。 */
export const OVERVIEW_TEXT_LIMIT = 400;

/** `session_search` 一次最多返回多少条命中。 */
export const MAX_SEARCH_LIMIT = 50;

/** `session_search` 默认返回多少条命中。 */
export const DEFAULT_SEARCH_LIMIT = 20;

/** 检索词最多拆成几段（每段都是 AND 关系）。 */
export const MAX_SEARCH_TERMS = 5;

/** 检索命中片段的字符上限。 */
export const SEARCH_SNIPPET_LIMIT = 300;

/** `session_read` 上下文窗口单侧上限（DSH 的 `readWindowMax` 默认 50）。 */
export const MAX_READ_WINDOW = 50;

/** `session_read` 默认上下文窗口单侧大小。 */
export const DEFAULT_READ_WINDOW = 3;

/** 尾读模式默认返回多少条语义消息。 */
export const DEFAULT_TAIL_LIMIT = 10;

/** 尾读模式条数上限。 */
export const MAX_TAIL_LIMIT = 100;

/** `session_read` 单条事件文本的字符上限。 */
export const READ_TEXT_LIMIT = 1200;

/**
 * 收口一个整数参数。
 *
 * @param {unknown} value - 外部传入的值。
 * @param {number} fallback - 非法时用的默认值。
 * @param {number} minimum - 下限。
 * @param {number} maximum - 上限。
 * @returns {number} 收口后的整数。
 */
export function clampInt(value, fallback, minimum, maximum) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  if (number < minimum) return minimum;
  if (number > maximum) return maximum;
  return number;
}

/**
 * 事件类型 → 粗粒度角色（检索/读取结果里给模型一个便宜的判据）。
 *
 * @param {unknown} type - 事件类型。
 * @returns {string} `user` / `assistant` / `summary` / `tool` / `system` / `other`。
 */
export function eventRoleOf(type) {
  if (type === 'user/message') return 'user';
  if (type === 'assistant/message') return 'assistant';
  if (type === 'compaction/summary') return 'summary';
  if (type === 'tool/call' || type === 'tool/result') return 'tool';
  if (type === 'system/message' || type === 'developer/message') return 'system';
  return 'other';
}

/**
 * 任意事件 → 一段可读文本（消息、工具调用、工具结果、标题都能取）。
 *
 * `session_read` 要读的是**原始日志窗口**，里面既有消息也有工具事件；只认消息的话，
 * 窗口里一半事件会变成空行，模型看不出发生了什么。
 *
 * @param {any} event - 一条会话事件。
 * @param {number} [textLimit] - 文本字符上限。
 * @returns {string} 可读文本；取不到时为空串。
 */
export function eventTextOf(event, textLimit = READ_TEXT_LIMIT) {
  if (event === null || typeof event !== 'object') return '';
  const message = messageFromEvent(event, textLimit);
  if (message !== undefined) return message.text;
  if (event.type === 'tool/call') {
    const name = typeof event.data?.name === 'string' ? event.data.name : '';
    let raw = '';
    try {
      const args = event.data?.arguments;
      raw = typeof args === 'string' ? args : JSON.stringify(args ?? '');
    } catch {
      raw = '';
    }
    if (name === '' && raw === '') return '';
    return truncateText(`工具调用 ${name}${raw === '' ? '' : ` ${raw}`}`, textLimit);
  }
  if (event.type === 'tool/result') {
    const text = messageTextOf(event);
    if (text !== '') return truncateText(text, textLimit);
    const code = typeof event.data?.error?.code === 'string' ? event.data.error.code : '';
    return code === '' ? '' : `工具错误：${code}`;
  }
  if (event.type === 'session/title') {
    const title = typeof event.data?.title === 'string' ? event.data.title : '';
    return title === '' ? '' : truncateText(`标题：${title}`, textLimit);
  }
  if (event.type === 'turn/start' || event.type === 'turn/end') {
    const turn = typeof event.data?.turn === 'number' ? event.data.turn : 0;
    return turn === 0 ? '' : `回合 ${turn} ${event.type === 'turn/start' ? '开始' : '结束'}`;
  }
  return '';
}

/**
 * 从表层事件里取标题（`session/title` 事件就在表层里，不必再读一次日志）。
 *
 * @param {any} surface - `sessionQuery.readSurface` 的返回值。
 * @returns {string} 标题；没有时为空串。
 */
export function titleFromSurface(surface) {
  const events = Array.isArray(surface?.events) ? surface.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'session/title') continue;
    const title = event.data?.title;
    if (typeof title === 'string' && title !== '') return title;
    const nested = event.data?.snapshot?.title;
    if (typeof nested === 'string' && nested !== '') return nested;
  }
  return '';
}

/**
 * 从表层事件里取「这个会话被交办了什么」（第一条用户消息）。
 *
 * @param {any} surface - `sessionQuery.readSurface` 的返回值。
 * @returns {string} 任务文本（截断）；没有时为空串。
 */
export function taskFromSurface(surface) {
  const events = Array.isArray(surface?.events) ? surface.events : [];
  for (const event of events) {
    const message = messageFromEvent(event, OVERVIEW_TASK_LIMIT);
    if (message === undefined) continue;
    if (message.role === 'user') return truncateText(message.text, OVERVIEW_TASK_LIMIT);
  }
  return '';
}

/**
 * 会话规模统计（全部来自一次表层读取）。
 *
 * `logSeq` 用 `capturedThroughSeq + 1`：它是**日志里最后一个事件的 seq**，所以是
 * 「这个会话有多少事件」的最好近似（表层事件数会少一些——被压缩/prune 掉的事件不在表层）。
 *
 * @param {any} surface - `sessionQuery.readSurface` 的返回值。
 * @returns {any} schema 对齐的统计对象。
 */
export function sessionStatsOf(surface) {
  const events = Array.isArray(surface?.events) ? surface.events : [];
  const counts = new Map();
  let firstTime = 0;
  let lastTime = 0;
  const semantic = { user: 0, assistant: 0, summary: 0 };
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const type = typeof event.type === 'string' ? event.type : '';
    counts.set(type, (counts.get(type) ?? 0) + 1);
    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0;
    if (time !== 0) {
      if (firstTime === 0 || time < firstTime) firstTime = time;
      if (time > lastTime) lastTime = time;
    }
    const message = messageFromEvent(event, 1);
    if (message !== undefined && message.role in semantic) semantic[message.role] += 1;
  }
  const captured = typeof surface?.capturedThroughSeq === 'number' ? surface.capturedThroughSeq : -1;
  const lastSeq = captured >= 0 ? captured + 1 : (events.length === 0 ? 0 : (events.at(-1)?.seq ?? 0) + 1);
  return {
    logSeq: lastSeq,
    surfaceEvents: events.length,
    userMessages: semantic.user,
    assistantMessages: semantic.assistant,
    summaries: semantic.summary,
    toolCalls: counts.get('tool/call') ?? 0,
    toolResults: counts.get('tool/result') ?? 0,
    turns: counts.get('turn/start') ?? 0,
    firstTime: firstTime === 0 ? '' : toIso(firstTime),
    lastTime: lastTime === 0 ? '' : toIso(lastTime),
    spanMinutes: firstTime !== 0 && lastTime !== 0 ? Math.round((lastTime - firstTime) / 60000) : 0,
  };
}

/**
 * 原始日志事件 → 规模统计。
 *
 * **必须用原始日志而不是当前表层**（真实回归踩到）：`tool/call`、`turn/start`、
 * `session/title` 都是 **log-only** 事件，被 `currentSurfaceEvents` 过滤掉——按表层算会得出
 * 「工具调用 0 次、回合 0 次」这种明显错误的概览。表层的价值在于「语义消息」的判定口径
 * （注入的 runtime-context 要不要算），所以用户消息一律用 `isInjectedUserEvent` 过滤。
 *
 * @param {any[]} events - `sessionQuery.readSession` 返回的原始事件。
 * @returns {any} schema 对齐的统计对象。
 */
export function statsOfEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const counts = new Map();
  let firstTime = 0;
  let lastTime = 0;
  let userMessages = 0;
  let summaries = 0;
  for (const event of list) {
    if (event === null || typeof event !== 'object') continue;
    const type = typeof event.type === 'string' ? event.type : '';
    counts.set(type, (counts.get(type) ?? 0) + 1);
    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0;
    if (time !== 0) {
      if (firstTime === 0 || time < firstTime) firstTime = time;
      if (time > lastTime) lastTime = time;
    }
    if (type === 'user/message' && !isInjectedUserEvent(event)) userMessages += 1;
    if (type === 'compaction/summary' || isCompactCheckpoint(event)) summaries += 1;
  }
  const assistantMessages = counts.get('assistant/message') ?? 0;
  const lastSeq = list.length === 0 ? 0 : (list[list.length - 1]?.seq ?? 0) + 1;
  return {
    logEvents: lastSeq,
    userMessages,
    assistantMessages,
    summaries,
    toolCalls: counts.get('tool/call') ?? 0,
    toolResults: counts.get('tool/result') ?? 0,
    turns: counts.get('turn/start') ?? 0,
    firstTime: firstTime === 0 ? '' : toIso(firstTime),
    lastTime: lastTime === 0 ? '' : toIso(lastTime),
    spanMinutes: firstTime !== 0 && lastTime !== 0 ? Math.round((lastTime - firstTime) / 60000) : 0,
  };
}

/**
 * 原始日志事件 → 最新标题。
 *
 * 标题是 `session/title` 事件（**log-only，不在当前表层**），所以必须从原始日志里找；
 * 早期版本从表层找，结果标题永远为空（真实回归踩到）。
 *
 * @param {any[]} events - 原始事件。
 * @returns {string} 标题；没有时为空串。
 */
export function titleOfEvents(events) {
  const list = Array.isArray(events) ? events : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index];
    if (event?.type !== 'session/title') continue;
    const title = event.data?.title;
    if (typeof title === 'string' && title !== '') return title;
    const nested = event.data?.snapshot?.title;
    if (typeof nested === 'string' && nested !== '') return nested;
  }
  return '';
}

/**
 * 原始日志事件 → 「这个会话被交办了什么」（第一条**非注入**用户消息）。
 *
 * @param {any[]} events - 原始事件。
 * @returns {string} 任务文本（截断）；没有时为空串。
 */
export function taskOfEvents(events) {
  const list = Array.isArray(events) ? events : [];
  for (const event of list) {
    const message = messageFromEvent(event, OVERVIEW_TASK_LIMIT);
    if (message === undefined || message.role !== 'user') continue;
    if (isInjectedUserEvent(event)) continue;
    return truncateText(message.text, OVERVIEW_TASK_LIMIT);
  }
  return '';
}

/**
 * 原始日志事件 → 最近 N 条语义消息（过滤框架注入，与 `messagesOf` 同口径）。
 *
 * @param {any[]} events - 原始事件。
 * @param {number} limit - 最多保留多少条（取最后 N 条）。
 * @returns {any[]} schema 对齐的消息列表。
 */
export function recentMessagesOfEvents(events, limit) {
  const list = Array.isArray(events) ? events : [];
  const messages = [];
  for (const event of list) {
    const message = messageFromEvent(event, OVERVIEW_TEXT_LIMIT);
    if (message === undefined) continue;
    if (isInjectedUserEvent(event)) continue;
    messages.push(message);
  }
  return messages.slice(-limit);
}

/**
 * 读整份原始日志（一次读取拿到统计 / 标题 / 任务 / 最近消息）。
 *
 * 为什么用 `readSession` 而不是 `readSurface`：概览要的是**日志全貌**（工具调用、回合、
 * 标题都在 log-only 事件里），而 surface 会把它们过滤掉。失败时返回错误而不是抛错，
 * 由调用方决定降级。
 *
 * @param {any} sessionQuery - `ctx.sessionQuery`。
 * @param {string} sessionId - 目标 id。
 * @returns {Promise<{ events?: any[], error: string, mode: string }>} 事件数组与错误。
 */
async function readLogSafe(sessionQuery, sessionId) {
  if (typeof sessionQuery?.readSession === 'function') {
    try {
      const snapshot = await sessionQuery.readSession(sessionId);
      if (Array.isArray(snapshot?.events)) return { events: snapshot.events, error: '', mode: 'log' };
    } catch (error) {
      return { events: undefined, error: error instanceof Error ? error.message : String(error), mode: 'log' };
    }
  }
  return { events: undefined, error: '', mode: 'unavailable' };
}

/** 空统计（失败分支用，保证输出 schema 形状固定）。 */
const EMPTY_STATS = Object.freeze({
  logEvents: 0,
  userMessages: 0,
  assistantMessages: 0,
  summaries: 0,
  toolCalls: 0,
  toolResults: 0,
  turns: 0,
  firstTime: '',
  lastTime: '',
  spanMinutes: 0,
});

/** 会话节点（概览/检索/读取共用；失败分支也用它）。 */
const EMPTY_SESSION = Object.freeze({
  id: '',
  title: '',
  role: 'root',
  workspace: '',
  createdAt: '',
  agentPreset: '',
  parentSessionId: '',
  delegationDepth: 0,
  isSeeded: false,
  live: false,
  persisted: false,
  isCurrent: false,
});

/**
 * 一次取血缘；失败时返回带文案的失败结果（四个工具共用同一套语义）。
 *
 * @param {any} sessionQuery - `ctx.sessionQuery`。
 * @param {string} targetId - 请求的 id。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<{ trace?: any, id?: string, resolvedFrom?: string, failure?: string }>} 解析结果。
 */
async function resolveTrace(sessionQuery, targetId, signal) {
  if (targetId === '') return { failure: '❌ 需要一个会话 ID：请把界面里复制的会话 ID 传进来。' };
  if (sessionQuery === undefined || sessionQuery === null) {
    return { failure: '❌ 本部署没有会话查询服务（sessionQuery），无法按 id 查会话。' };
  }
  try {
    const resolved = await traceSessionById(sessionQuery, targetId, signal);
    if (resolved.trace === null) return { failure: resolveFailureSummary(targetId, resolved.match) };
    return { trace: resolved.trace, id: resolved.id, resolvedFrom: resolved.resolvedFrom };
  } catch (error) {
    const code = errorCodeOf(error);
    const message = error instanceof Error ? error.message : String(error);
    return { failure: `❌ 查询会话失败${code === '' ? '' : `（${code}）`}：${message}` };
  }
}

/**
 * 读一次表层；失败时把原因带出来（不整体失败——元数据仍然有价值）。
 *
 * @param {any} sessionQuery - `ctx.sessionQuery`。
 * @param {string} sessionId - 目标 id。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<{ surface: any, error: string }>} 表层与错误。
 */
async function readSurfaceSafe(sessionQuery, sessionId, signal) {
  try {
    return { surface: await sessionQuery.readSurface(sessionId, signal), error: '' };
  } catch (error) {
    return { surface: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 概览失败结果（形状固定）。
 *
 * @param {string} targetId - 请求的 id。
 * @param {string} summary - 说明。
 * @returns {any} 输出。
 */
export function overviewFailure(targetId, summary) {
  return {
    ok: false,
    targetId: typeof targetId === 'string' ? targetId : '',
    session: { ...EMPTY_SESSION },
    tree: [],
    stats: { ...EMPTY_STATS },
    title: '',
    task: '',
    recent: [],
    surfaceError: '',
    summary,
    hint: '',
  };
}

/**
 * 一次调用拿到「这个会话是什么、多大、谁派的、下一步怎么读」。
 *
 * 成本：目标会话**一次**日志读取 + 一次语料库列举（树只取 header，不读内容）。
 *
 * @param {{
 *   sessionQuery: any,
 *   sessionId: string,
 *   currentId: string,
 *   related?: boolean,
 *   recentLimit?: number,
 *   signal?: AbortSignal,
 * }} request - 查询参数。
 * @returns {Promise<any>} 输出对象。
 */
export async function overviewSession(request) {
  const { sessionQuery, sessionId, currentId, signal } = request;
  const targetId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const related = request.related !== false;
  const recentLimit = clampInt(request.recentLimit, DEFAULT_OVERVIEW_RECENT, 1, MAX_OVERVIEW_RECENT);
  const resolved = await resolveTrace(sessionQuery, targetId, signal);
  if (resolved.failure !== undefined) return overviewFailure(targetId, resolved.failure);

  const { trace } = resolved;
  const header = trace.target?.header ?? {};
  const session = {
    id: typeof header.id === 'string' ? header.id : resolved.id,
    title: '',
    role: classifyRole(header),
    workspace: typeof header.cwd === 'string' ? header.cwd : '',
    createdAt: toIso(header.createdAt),
    agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
    parentSessionId: typeof header.parentSession === 'string' ? header.parentSession : '',
    delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : 0,
    isSeeded: header.isSeeded === true,
    live: trace.target?.live === true,
    persisted: trace.target?.persisted === true,
    isCurrent: typeof header.id === 'string' && header.id === currentId,
  };

  // 概览一次读取：readSession 给整份原始日志（统计/标题/任务/最近消息都从它来）。
  // 老部署没有 readSession 时降级到 readSurface（标题会缺，统计口径变表层口径）。
  const log = await readLogSafe(sessionQuery, resolved.id);
  const logEvents = log.events;
  const surface = logEvents === undefined ? await readSurfaceSafe(sessionQuery, resolved.id, signal) : undefined;
  const surfaceError = logEvents === undefined ? (log.error !== '' ? log.error : (surface?.error ?? '')) : '';
  const stats =
    logEvents !== undefined
      ? statsOfEvents(logEvents)
      : surface?.surface !== undefined
        ? // 降级：老部署没有 readSession，只能按当前表层口径统计（log-only 事件缺失，数字会偏小）。
          statsOfEvents(surface.surface.events)
        : { ...EMPTY_STATS };
  const title =
    logEvents !== undefined
      ? titleOfEvents(logEvents)
      : surface?.surface !== undefined
        ? titleFromSurface(surface.surface)
        : '';
  const task =
    logEvents !== undefined
      ? taskOfEvents(logEvents)
      : surface?.surface !== undefined
        ? taskFromSurface(surface.surface)
        : '';
  const recent =
    logEvents !== undefined
      ? recentMessagesOfEvents(logEvents, recentLimit)
      : surface?.surface !== undefined
        ? messagesOf(surface.surface, recentLimit, OVERVIEW_TEXT_LIMIT)
        : [];
  session.title = title;

  /** 树只给身份与位置，不给内容——要看内容用 `session_lookup`。 */
  const tree = [];
  if (related) {
    for (const [index, record] of (Array.isArray(trace.ancestors) ? trace.ancestors : []).entries()) {
      const ancestor = record?.header ?? {};
      tree.push({
        id: typeof ancestor.id === 'string' ? ancestor.id : '',
        role: classifyRole(ancestor),
        relation: 'ancestor',
        depth: index + 1,
        parentId: typeof ancestor.parentSession === 'string' ? ancestor.parentSession : '',
        createdAt: toIso(ancestor.createdAt),
        agentPreset: typeof ancestor.agentPreset === 'string' ? ancestor.agentPreset : '',
        live: record?.live === true,
        persisted: record?.persisted === true,
      });
    }
    for (const node of flattenDescendants(trace.descendants)) {
      const descendant = node.record?.header ?? {};
      tree.push({
        id: typeof descendant.id === 'string' ? descendant.id : '',
        role: classifyRole(descendant),
        relation: 'descendant',
        depth: node.depth,
        parentId: node.parentId,
        createdAt: toIso(descendant.createdAt),
        agentPreset: typeof descendant.agentPreset === 'string' ? descendant.agentPreset : '',
        live: node.record?.live === true,
        persisted: node.record?.persisted === true,
      });
    }
  }

  const lines = [];
  lines.push(`## 会话概览 ${session.id}`);
  if (resolved.resolvedFrom !== '' && resolved.resolvedFrom !== session.id) {
    lines.push('');
    lines.push(`> ℹ️ 你给的 \`${resolved.resolvedFrom}\` 与真实 id \`${session.id}\` 是同一个会话，已按 UUID 归一化。`);
  }
  lines.push('');
  lines.push(`- 标题：${session.title === '' ? '（尚无标题）' : session.title}`);
  lines.push(`- 类型：${session.role === 'root' ? '根会话' : session.role === 'subagent' ? '子代理会话' : '分支会话'}`);
  if (session.parentSessionId !== '') lines.push(`- 上级会话：\`${session.parentSessionId}\``);
  lines.push(`- 工作区：${session.workspace === '' ? '（未记录）' : `\`${session.workspace}\``}`);
  if (session.agentPreset !== '') lines.push(`- 预设：\`${session.agentPreset}\``);
  lines.push(`- 状态：${session.live ? '运行中（live）' : '未运行'} · ${session.persisted ? '已持久化' : '仅内存'}`);
  if (session.isCurrent) lines.push('- 这是**当前会话**。');
  lines.push('');
  lines.push('### 规模');
  lines.push(`- 日志事件数：**${stats.logEvents}**`);
  lines.push(`- 语义消息：user ${stats.userMessages} / assistant ${stats.assistantMessages} / 摘要 ${stats.summaries}`);
  lines.push(`- 工具调用 ${stats.toolCalls} 次 · 工具结果 ${stats.toolResults} 条 · 回合 ${stats.turns} 次`);
  if (stats.firstTime !== '' || stats.lastTime !== '') {
    lines.push(`- 时间跨度：${stats.firstTime === '' ? '（未知）' : stats.firstTime} → ${stats.lastTime === '' ? '（未知）' : stats.lastTime}（约 ${stats.spanMinutes} 分钟）`);
  }
  if (surfaceError !== '') {
    lines.push('');
    lines.push(`⚠️ **读取表层失败**：${surfaceError}`);
    lines.push('事件仍在磁盘上；这只是当前读不出来，不要据此判断「会话是空的」。');
  }
  if (logEvents === undefined && surface?.surface !== undefined) {
    lines.push('');
    lines.push('> ℹ️ 该部署的 `sessionQuery` 没有 `readSession`：统计按**当前表层**口径，log-only 事件（工具调用/回合/标题）可能缺失。');
  }
  if (task !== '') {
    lines.push('');
    lines.push('### 任务（第一条用户消息）');
    lines.push(task.replace(/\n+/g, ' ').trim());
  }
  if (recent.length > 0) {
    lines.push('');
    lines.push(`### 最近 ${recent.length} 条消息`);
    for (const message of recent) {
      lines.push(`- **${message.role}**（seq ${message.seq}）：${message.text.replace(/\n+/g, ' ').trim()}`);
    }
  }
  if (tree.length > 0) {
    lines.push('');
    lines.push(`### 会话树（${tree.length} 个相关会话，只有身份；内容用 session_lookup）`);
    for (const node of tree) {
      const where = node.relation === 'ancestor' ? `祖先 ${node.depth}` : `d${node.depth}`;
      const state = node.live ? ' · live' : '';
      lines.push(`- [${where}] \`${node.id}\` · ${node.role}${node.agentPreset === '' ? '' : ` · ${node.agentPreset}`}${state}`);
    }
  }

  const hint = [
    stats.logEvents > 200
      ? '这是长会话：别指望一次读完——用 `session_search` 按关键词定位（返回 seq），再用 `session_read` 读那条附近的原文。'
      : '会话不长：可以直接用 `session_lookup` 读整棵树的内容摘要，或用 `session_read` 读尾部原文。',
    tree.length > 0 ? '要看某个相关会话的标题与内容摘要，用 `session_lookup`（其 sessionId 指向它）。' : '',
    '要读某一段原文：`session_read`（给 seq 与 before/after 窗口）。',
  ]
    .filter((line) => line !== '')
    .join(' ');

  return {
    ok: true,
    targetId: session.id,
    session,
    tree,
    stats,
    title,
    task,
    recent,
    surfaceError,
    summary: lines.join('\n'),
    hint,
  };
}

/**
 * 检索失败结果（形状固定）。
 *
 * @param {string} targetId - 请求的 id。
 * @param {string} query - 检索词。
 * @param {string} summary - 说明。
 * @returns {any} 输出。
 */
export function searchFailure(targetId, query, summary) {
  return {
    ok: false,
    targetId: typeof targetId === 'string' ? targetId : '',
    query: typeof query === 'string' ? query : '',
    terms: [],
    hits: [],
    hitCount: 0,
    nextFromSeq: 0,
    summary,
    hint: '',
  };
}

/**
 * 会话内检索：按关键词在**语义文档**里找位置，返回 seq + 片段。
 *
 * 为什么用 `filterEvents`（扫描）而不是 `searchEvents`（FTS 索引）：
 * - 扫描不依赖 sqlite 索引能否建起来（真实遇到过 `SESSION_QUERY_PERSISTENCE_FAILED`），
 *   对「用户粘来的任意会话 id」更可靠；
 * - 语义是**字面、大小写不敏感**匹配，可预测；多词按 AND 处理，模型容易理解；
 * - 一次日志读取的成本对几 MB 的会话是毫秒级，换来的确定性更值。
 *
 * @param {{
 *   sessionQuery: any,
 *   sessionId: string,
 *   query: string,
 *   limit?: number,
 *   fromSeq?: number,
 *   types?: string[],
 *   signal?: AbortSignal,
 * }} request - 检索参数。
 * @returns {Promise<any>} 输出对象。
 */
export async function searchSession(request) {
  const { sessionQuery, sessionId, signal } = request;
  const targetId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const query = typeof request.query === 'string' ? request.query.trim() : '';
  if (query === '') return searchFailure(targetId, query, '❌ 需要一个检索词（query）：想在这会话里找什么？');
  const resolved = await resolveTrace(sessionQuery, targetId, signal);
  if (resolved.failure !== undefined) return searchFailure(targetId, query, resolved.failure);
  if (typeof sessionQuery.filterEvents !== 'function') {
    return searchFailure(targetId, query, '❌ 本部署的 sessionQuery 没有 filterEvents，无法做会话内检索。');
  }

  const limit = clampInt(request.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  const fromSeq = clampInt(request.fromSeq, 0, 0, Number.MAX_SAFE_INTEGER);
  const terms = query.split(/\s+/).filter((term) => term !== '').slice(0, MAX_SEARCH_TERMS);
  /** @type {any[]} */
  const filters = terms.map((term) => ({ kind: 'text', text: term }));
  if (Array.isArray(request.types) && request.types.length > 0) {
    filters.push({ kind: 'type', values: request.types.filter((type) => typeof type === 'string' && type !== '') });
  }
  if (fromSeq > 0) filters.push({ kind: 'seq', from: fromSeq });

  let documents;
  try {
    documents = await sessionQuery.filterEvents(resolved.id, filters);
  } catch (error) {
    const code = errorCodeOf(error);
    const message = error instanceof Error ? error.message : String(error);
    return searchFailure(
      targetId,
      query,
      `❌ 检索失败${code === '' ? '' : `（${code}）`}：${message}`,
    );
  }
  const all = Array.isArray(documents) ? documents : [];
  const page = all
    .filter((document) => typeof document?.seq === 'number' && (fromSeq === 0 || document.seq >= fromSeq))
    .slice(0, limit);
  const hits = page.map((document) => ({
    seq: document.seq,
    type: typeof document.type === 'string' ? document.type : '',
    role: eventRoleOf(document.type),
    time: toIso(document.time),
    surface: typeof document.surface === 'string' ? document.surface : '',
    snippet: truncateText(typeof document.text === 'string' ? document.text : '', SEARCH_SNIPPET_LIMIT),
  }));
  const nextFromSeq = all.length > page.length && page.length > 0 ? page[page.length - 1].seq + 1 : 0;

  const lines = [];
  lines.push(`## 会话内检索：${terms.join(' + ')}`);
  lines.push('');
  lines.push(`- 目标会话：\`${resolved.id}\``);
  lines.push(`- 命中：本次返回 ${hits.length} 条${nextFromSeq === 0 ? '' : `（还有更多，下一页从 seq ${nextFromSeq} 开始）`}`);
  if (hits.length === 0) {
    lines.push('');
    lines.push('没有命中。可以换更短的关键词、去掉 AND 的多词，或检查这个会话里是否真有那段内容。');
  } else {
    lines.push('');
    for (const hit of hits) {
      const where = hit.surface === 'current' ? '' : ` · ${hit.surface}`;
      lines.push(`- **seq ${hit.seq}** · ${hit.role} · ${hit.type}${where}`);
      lines.push(`  ${hit.snippet.replace(/\n+/g, ' ').trim()}`);
    }
  }

  const hint =
    hits.length === 0
      ? '换成单个关键词再试；本工具是字面匹配（大小写不敏感），不会做同义词/模糊匹配。'
      : [
          nextFromSeq === 0 ? '' : `下一页：\`session_search { sessionId, query, fromSeq: ${nextFromSeq} }\``,
          '要看某条命中前后的原文：`session_read`（seq 用命中里的 seq）。',
        ]
          .filter((line) => line !== '')
          .join(' ');

  return {
    ok: true,
    targetId: resolved.id,
    query,
    terms,
    hits,
    hitCount: hits.length,
    nextFromSeq,
    summary: lines.join('\n'),
    hint,
  };
}

/**
 * 读取失败结果（形状固定）。
 *
 * @param {string} targetId - 请求的 id。
 * @param {string} summary - 说明。
 * @returns {any} 输出。
 */
export function readFailure(targetId, summary) {
  return {
    ok: false,
    targetId: typeof targetId === 'string' ? targetId : '',
    mode: 'window',
    startSeq: 0,
    endSeq: 0,
    targetSeq: 0,
    events: [],
    summary,
    hint: '',
  };
}

/**
 * 按位置读原文：给定 seq 读「那条 + 前后窗口」，不给 seq 就读尾部若干条消息。
 *
 * 两种模式各读一次日志：
 * - 窗口模式用 `readEvent`：返回**原始日志**（含已被 prune/替换的 shadowed 事件），
 *   这样「seq 命中点附近到底写了什么」不会被当前表层过滤掉；
 * - 尾读模式用 `readSurface`：只给最后 N 条语义消息（每条带 seq，方便接着用窗口模式）。
 *
 * @param {{
 *   sessionQuery: any,
 *   sessionId: string,
 *   seq?: number,
 *   before?: number,
 *   after?: number,
 *   tailLimit?: number,
 *   signal?: AbortSignal,
 * }} request - 读取参数。
 * @returns {Promise<any>} 输出对象。
 */
export async function readSessionWindow(request) {
  const { sessionQuery, sessionId, signal } = request;
  const targetId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const resolved = await resolveTrace(sessionQuery, targetId, signal);
  if (resolved.failure !== undefined) return readFailure(targetId, resolved.failure);

  const hasSeq = typeof request.seq === 'number' && Number.isFinite(request.seq);
  const before = clampInt(request.before, DEFAULT_READ_WINDOW, 0, MAX_READ_WINDOW);
  const after = clampInt(request.after, DEFAULT_READ_WINDOW, 0, MAX_READ_WINDOW);

  if (hasSeq) {
    if (typeof sessionQuery.readEvent !== 'function') {
      return readFailure(targetId, '❌ 本部署的 sessionQuery 没有 readEvent，无法按 seq 读窗口。');
    }
    const seq = clampInt(request.seq, 0, 0, Number.MAX_SAFE_INTEGER);
    let window;
    try {
      window = await sessionQuery.readEvent({ sessionId: resolved.id, seq, before, after }, signal);
    } catch (error) {
      const code = errorCodeOf(error);
      const message = error instanceof Error ? error.message : String(error);
      return readFailure(targetId, `❌ 读取 seq ${seq} 失败${code === '' ? '' : `（${code}）`}：${message}`);
    }
    const events = (Array.isArray(window?.events) ? window.events : []).map((event) => ({
      seq: typeof event.seq === 'number' ? event.seq : 0,
      type: typeof event.type === 'string' ? event.type : '',
      role: eventRoleOf(event.type),
      surface: typeof event.surfaceOp === 'string' ? 'current' : '',
      time: toIso(event.time),
      text: eventTextOf(event),
      isTarget: typeof event.seq === 'number' && event.seq === seq,
    }));
    const startSeq = typeof window?.startSeq === 'number' ? window.startSeq : (events[0]?.seq ?? 0);
    const endSeq = typeof window?.endSeq === 'number' ? window.endSeq : (events.at(-1)?.seq ?? 0);
    const lines = [];
    lines.push(`## 会话原文 seq ${startSeq}–${endSeq}（目标 seq ${seq}）`);
    lines.push('');
    lines.push(`- 目标会话：\`${resolved.id}\``);
    lines.push(`- 窗口：前 ${before} 条 + 目标 + 后 ${after} 条，共 ${events.length} 条`);
    lines.push('');
    for (const event of events) {
      const marker = event.isTarget ? '→ ' : '  ';
      const text = event.text.replace(/\n+/g, ' ').trim();
      lines.push(`${marker}**seq ${event.seq}** · ${event.type}${text === '' ? '' : `：${text}`}`);
    }
    return {
      ok: true,
      targetId: resolved.id,
      mode: 'window',
      startSeq,
      endSeq,
      targetSeq: seq,
      events,
      summary: lines.join('\n'),
      hint: '要更宽的上下文就调大 before/after（单侧上限 50）；要换位置就再用 session_search 找 seq。',
    };
  }

  // 尾读模式
  const tailLimit = clampInt(request.tailLimit, DEFAULT_TAIL_LIMIT, 1, MAX_TAIL_LIMIT);
  const { surface, error } = await readSurfaceSafe(sessionQuery, resolved.id, signal);
  if (surface === undefined) return readFailure(targetId, `❌ 读取会话表层失败：${error}`);
  const messages = messagesOf(surface, tailLimit, READ_TEXT_LIMIT);
  const stats = sessionStatsOf(surface);
  const events = messages.map((message) => ({
    seq: message.seq,
    type: message.type,
    role: message.role,
    surface: 'current',
    time: message.time,
    text: message.text,
    isTarget: false,
  }));
  const lines = [];
  lines.push(`## 会话尾部（最后 ${events.length} 条消息）`);
  lines.push('');
  lines.push(`- 目标会话：\`${resolved.id}\`（日志事件数约 ${stats.logSeq}）`);
  lines.push('');
  for (const event of events) {
    lines.push(`- **seq ${event.seq}** · ${event.role}：${event.text.replace(/\n+/g, ' ').trim()}`);
  }
  return {
    ok: true,
    targetId: resolved.id,
    mode: 'tail',
    startSeq: events.length === 0 ? 0 : events[0].seq,
    endSeq: events.length === 0 ? 0 : events[events.length - 1].seq,
    targetSeq: 0,
    events,
    summary: lines.join('\n'),
    hint:
      events.length === 0
        ? '没有可读的语义消息（会话可能是空的，或表层不含文本）。'
        : '要读更早的内容：给 `seq`（例如某条命中的 seq）并用 before/after 取窗口；或用 `session_search` 定位。',
  };
}
