/**
 * 「先概括、再定向读」三件套的离线测试：`session_overview` / `session_search` / `session_read`。
 *
 * 用假 `sessionQuery` 固定住四个方法的形状（`traceSession` / `readSurface` /
 * `filterEvents` / `readEvent`），并让每个返回的**输出对象**都过一遍工具自己声明的
 * JSON Schema —— 运行时 `tool returned invalid output` 的离线防线。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SEARCH_LIMIT,
  eventRoleOf,
  eventTextOf,
  MAX_SEARCH_TERMS,
  overviewSession,
  readSessionWindow,
  searchSession,
  sessionStatsOf,
  taskFromSurface,
  titleFromSurface,
} from '../lib/inspect.mjs';
import { buildReadTool } from '../lib/tools/read.mjs';
import { buildOverviewTool } from '../lib/tools/overview.mjs';
import { buildSearchTool } from '../lib/tools/search.mjs';
import { validateValue } from './strict-schema.mjs';

/** 根会话头。 */
const ROOT = {
  version: 1,
  id: 'session-root',
  createdAt: 1_700_020_000_000,
  cwd: 'E:\\work',
  isSeeded: false,
  agentPreset: 'standard',
};

/** 子会话头（父 = 根）。 */
const CHILD = {
  version: 1,
  id: 'child-1',
  createdAt: 1_700_020_100_000,
  cwd: 'E:\\work',
  parentSession: 'session-root',
  origin: 'subagent',
  delegationDepth: 1,
  isSeeded: false,
  agentPreset: 'commander',
};

/** 孙会话头（父 = 子）。 */
const GRAND = {
  version: 1,
  id: 'grand-1',
  createdAt: 1_700_020_200_000,
  cwd: 'E:\\work',
  parentSession: 'child-1',
  origin: 'subagent',
  delegationDepth: 2,
  isSeeded: false,
  agentPreset: 'cordis',
};

/** 根会话的表层事件：标题 + 任务 + 工具调用 + 回合 + 普通问答。 */
function rootSurface() {
  return {
    inheritedEventCount: 0,
    capturedThroughSeq: 11,
    events: [
      { seq: 1, type: 'turn/start', time: 1_700_020_001_000, data: { turn: 1 } },
      { seq: 3, type: 'user/message', time: 1_700_020_002_000, data: { content: [{ type: 'text', text: '把 rc.2 适配做完，再出包' }] } },
      { seq: 5, type: 'tool/call', time: 1_700_020_003_000, data: { name: 'pwsh', arguments: '{"command":"node --test"}' } },
      { seq: 6, type: 'tool/result', time: 1_700_020_004_000, data: { message: { content: [{ type: 'text', text: 'tests 690/690 pass' }] } } },
      { seq: 8, type: 'assistant/message', time: 1_700_020_005_000, data: { message: { content: [{ type: 'text', text: '适配完成，690 条测试全绿' }] } } },
      { seq: 10, type: 'session/title', time: 1_700_020_006_000, data: { title: 'rc.2 适配与出包', messageSeqs: [3], source: { kind: 'provider' } } },
      { seq: 11, type: 'user/message', time: 1_700_020_007_000, data: { content: [{ type: 'text', text: '进度如何' }] } },
    ],
  };
}

/** 子会话的表层。 */
function childSurface() {
  return {
    inheritedEventCount: 0,
    capturedThroughSeq: 4,
    events: [
      { seq: 1, type: 'user/message', time: 1_700_020_101_000, data: { content: [{ type: 'text', text: '你是小组长，负责测试迁移' }] } },
      { seq: 3, type: 'assistant/message', time: 1_700_020_102_000, data: { message: { content: [{ type: 'text', text: '迁移完成' }] } } },
    ],
  };
}

/** 检索用的语义文档（`filterEvents` 的返回形状）。 */
const DOCUMENTS = [
  { sessionId: 'session-root', seq: 3, type: 'user/message', time: 1_700_020_002_000, surface: 'current', text: '把 rc.2 适配做完，再出包' },
  { sessionId: 'session-root', seq: 6, type: 'tool/result', time: 1_700_020_004_000, surface: 'current', text: 'tests 690/690 pass' },
  { sessionId: 'session-root', seq: 8, type: 'assistant/message', time: 1_700_020_005_000, surface: 'current', text: '适配完成，690 条测试全绿，可以出包' },
  { sessionId: 'session-root', seq: 11, type: 'user/message', time: 1_700_020_007_000, surface: 'current', text: '进度如何' },
];

/**
 * 根会话的**原始日志**：比表层多出 log-only 事件（title / tool-call / turn），
 * 概览统计必须用这份，否则会得出「工具调用 0 次」。
 */
function rootLog() {
  return [
    { seq: 0, type: 'turn/start', time: 1_700_020_000_500, data: { turn: 1 } },
    { seq: 1, type: 'user/message', time: 1_700_020_001_000, data: { content: [{ type: 'text', text: '把 rc.2 适配做完，再出包' }] } },
    { seq: 2, type: 'assistant/message', time: 1_700_020_002_000, data: { message: { content: [{ type: 'text', text: '先跑测试' }] } } },
    { seq: 3, type: 'tool/call', time: 1_700_020_003_000, data: { name: 'pwsh', arguments: '{"command":"node --test"}' } },
    { seq: 4, type: 'tool/result', time: 1_700_020_004_000, data: { message: { content: [{ type: 'text', text: 'tests 690/690 pass' }] } } },
    { seq: 5, type: 'assistant/message', time: 1_700_020_005_000, data: { message: { content: [{ type: 'text', text: '适配完成，690 条测试全绿' }] } } },
    { seq: 6, type: 'turn/end', time: 1_700_020_006_000, data: { turn: 1 } },
    // 注入的 runtime context（统计里不算「用户消息」）
    { seq: 7, type: 'user/message', time: 1_700_020_006_500, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current working directory: E:\\work' }] } },
    { seq: 8, type: 'session/title', time: 1_700_020_007_000, data: { title: 'rc.2 适配与出包', messageSeqs: [1], source: { kind: 'provider' } } },
    { seq: 9, type: 'user/message', time: 1_700_020_008_000, data: { content: [{ type: 'text', text: '进度如何' }] } },
  ];
}

/**
 * 假查询服务。
 *
 * @param {any} [overrides] - 覆盖方法。
 * @returns {any} 假 `sessionQuery`。
 */
function fakeQuery(overrides = {}) {
  const records = [
    { header: ROOT, live: false, persisted: true },
    { header: CHILD, live: false, persisted: true },
    { header: GRAND, live: false, persisted: true },
  ];
  const surfaces = { 'session-root': rootSurface(), 'child-1': childSurface(), 'grand-1': childSurface() };
  const headerOf = (id) => records.find((record) => record.header.id === id)?.header;
  const query = {
    /** 记录检索收到的过滤器，便于断言 AND 语义。 */
    lastFilters: undefined,
    async traceSession(id) {
      if (!surfaces[id]) {
        const error = new Error(`session "${id}" not found`);
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
        throw error;
      }
      // 祖先：沿 parentSession 往上走（父不在语料里时停）。
      const ancestors = [];
      let parent = headerOf(id)?.parentSession;
      while (parent !== undefined) {
        const header = headerOf(parent);
        if (header === undefined) break;
        ancestors.push(records.find((record) => record.header.id === parent));
        parent = header.parentSession;
      }
      // 后代：递归（父在前）。
      const nodeOf = (childId) => ({
        session: records.find((record) => record.header.id === childId),
        descendants: records
          .filter((record) => record.header.parentSession === childId)
          .map((record) => nodeOf(record.header.id)),
      });
      const descendants = records
        .filter((record) => record.header.parentSession === id)
        .map((record) => nodeOf(record.header.id));
      return {
        target: records.find((record) => record.header.id === id),
        ancestors,
        descendants,
        complete: true,
      };
    },
    async readSurface(id) {
      const surface = surfaces[id];
      if (surface === undefined) throw new Error(`no surface for ${id}`);
      return surface;
    },
    /** 概览走这条：一次读取拿到整份原始日志（含 log-only 事件）。 */
    async readSession(id) {
      if (surfaces[id] === undefined) throw new Error(`no log for ${id}`);
      return { session: headerOf(id), inheritedEventCount: 0, events: id === 'session-root' ? rootLog() : surfaces[id].events };
    },
    async filterEvents(id, filters) {
      query.lastFilters = filters;
      return DOCUMENTS.filter((document) => {
        for (const filter of filters) {
          if (filter.kind === 'text' && !document.text.toLowerCase().includes(filter.text.toLowerCase())) return false;
          if (filter.kind === 'seq' && (document.seq < (filter.from ?? 0) || document.seq > (filter.to ?? Infinity))) return false;
          if (filter.kind === 'type' && !filter.values.includes(document.type)) return false;
        }
        return true;
      });
    },
    async readEvent({ sessionId, seq, before = 0, after = 0 }) {
      const surface = surfaces[sessionId];
      const all = surface?.events ?? [];
      const startSeq = Math.max(0, seq - before);
      const endSeq = seq + after;
      const events = all.filter((event) => event.seq >= startSeq && event.seq <= endSeq);
      return { session: ROOT, inheritedEventCount: 0, target: all.find((event) => event.seq === seq), events, startSeq, endSeq };
    },
    async listSessions() {
      return records;
    },
    ...overrides,
  };
  return query;
}

/** 三个工具的 ctx（`get('sessionQuery')` 返回假服务）。 */
function ctxWith(query) {
  return { get: (key) => (key === 'sessionQuery' ? query : undefined) };
}

/** 概览工具的输出 schema。 */
function overviewSchema() {
  return buildOverviewTool(ctxWith(undefined)).output.schema;
}

/** 检索工具的输出 schema。 */
function searchSchema() {
  return buildSearchTool(ctxWith(undefined)).output.schema;
}

/** 读取工具的输出 schema。 */
function readSchema() {
  return buildReadTool(ctxWith(undefined)).output.schema;
}

test('eventRoleOf 把事件类型折成粗粒度角色', () => {
  assert.equal(eventRoleOf('user/message'), 'user');
  assert.equal(eventRoleOf('assistant/message'), 'assistant');
  assert.equal(eventRoleOf('compaction/summary'), 'summary');
  assert.equal(eventRoleOf('tool/call'), 'tool');
  assert.equal(eventRoleOf('tool/result'), 'tool');
  assert.equal(eventRoleOf('system/message'), 'system');
  assert.equal(eventRoleOf('turn/start'), 'other');
  assert.equal(eventRoleOf(undefined), 'other');
});

test('eventTextOf 能读出消息 / 工具调用 / 工具结果 / 标题 / 回合', () => {
  assert.equal(eventTextOf({ type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } }), '你好');
  assert.match(eventTextOf({ type: 'tool/call', data: { name: 'pwsh', arguments: '{"command":"ls"}' } }), /工具调用 pwsh/);
  assert.match(eventTextOf({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ok' }] } } }), /ok/);
  assert.equal(eventTextOf({ type: 'session/title', data: { title: '标题' } }), '标题：标题');
  assert.equal(eventTextOf({ type: 'turn/start', data: { turn: 3 } }), '回合 3 开始');
  assert.equal(eventTextOf({ type: 'unknown/x', data: {} }), '');
  assert.equal(eventTextOf(undefined), '');
});

test('titleFromSurface / taskFromSurface 从表层事件里就近取', () => {
  const surface = rootSurface();
  assert.equal(titleFromSurface(surface), 'rc.2 适配与出包');
  assert.equal(taskFromSurface(surface), '把 rc.2 适配做完，再出包');
  // 没有标题事件时回落到空串；容忍 data.snapshot.title 的形状。
  assert.equal(titleFromSurface({ events: [] }), '');
  assert.equal(titleFromSurface({ events: [{ type: 'session/title', data: { snapshot: { title: '嵌套形状' } } }] }), '嵌套形状');
  assert.equal(taskFromSurface({ events: [] }), '');
});

test('sessionStatsOf：规模统计来自一次表层读取', () => {
  const stats = sessionStatsOf(rootSurface());
  // capturedThroughSeq=11 ⇒ 日志事件数按 seq 上界算 12。
  assert.equal(stats.logSeq, 12);
  assert.equal(stats.surfaceEvents, 7);
  assert.equal(stats.userMessages, 2);
  assert.equal(stats.assistantMessages, 1);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.toolResults, 1);
  assert.equal(stats.turns, 1);
  assert.equal(stats.firstTime, new Date(1_700_020_001_000).toISOString());
  assert.equal(stats.lastTime, new Date(1_700_020_007_000).toISOString());
  assert.equal(stats.spanMinutes, 0);
  assert.deepEqual(sessionStatsOf(undefined), {
    logSeq: 0,
    surfaceEvents: 0,
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
});

test('overviewSession：一次调用给出标题 / 任务 / 规模 / 树 / 最近消息', async () => {
  const value = await overviewSession({
    sessionQuery: fakeQuery(),
    sessionId: 'session-root',
    currentId: '',
    related: true,
    recentLimit: 2,
  });

  assert.equal(value.ok, true);
  assert.equal(value.session.id, 'session-root');
  // 标题来自 log-only 的 session/title 事件——从表层取会永远为空（真实回归踩到）。
  assert.equal(value.title, 'rc.2 适配与出包');
  assert.equal(value.task, '把 rc.2 适配做完，再出包');
  // 统计按整份日志算：工具调用/回合必须非零（表层口径会给出 0）。
  assert.equal(value.stats.logEvents, 10);
  assert.equal(value.stats.toolCalls, 1);
  assert.equal(value.stats.turns, 1);
  assert.equal(value.stats.userMessages, 2, '注入的 runtime-context 不算用户消息');
  assert.equal(value.stats.assistantMessages, 2);
  assert.deepEqual(
    value.tree.map((node) => [node.id, node.relation, node.depth]),
    [
      ['child-1', 'descendant', 1],
      ['grand-1', 'descendant', 2],
    ],
  );
  assert.equal(value.recent.length, 2);
  assert.match(value.summary, /会话概览 session-root/);
  assert.match(value.summary, /### 规模/);
  assert.match(value.summary, /工具调用 1 次/);
  assert.match(value.summary, /### 任务/);
  assert.match(value.summary, /### 会话树/);
  assert.doesNotMatch(value.summary, /没有 `readSession`/);
  assert.deepEqual(validateValue(value, overviewSchema()), []);
});

test('overviewSession：没有 readSession 的老部署降级为表层口径，并在摘要里说明', async () => {
  const value = await overviewSession({
    sessionQuery: fakeQuery({ readSession: undefined }),
    sessionId: 'session-root',
    currentId: '',
    related: false,
    recentLimit: 1,
  });
  assert.equal(value.ok, true);
  // 降级后仍要满足同一份 schema（字段集合固定）。
  assert.deepEqual(validateValue(value, overviewSchema()), []);
  assert.equal(value.title, 'rc.2 适配与出包', '表层里也有 title 事件，标题仍能拿到');
  assert.match(value.summary, /没有 `readSession`/);
  // 降级口径下统计只覆盖表层事件（这份表层里恰好有 tool/call，所以数字仍是 1）。
  assert.equal(value.stats.toolCalls, 1);
});

test('overviewSession：目标是子会话时树里带祖先（谁派的它）', async () => {
  const value = await overviewSession({
    sessionQuery: fakeQuery(),
    sessionId: 'grand-1',
    currentId: '',
    related: true,
    recentLimit: 3,
  });
  assert.equal(value.ok, true);
  assert.equal(value.session.parentSessionId, 'child-1');
  assert.deepEqual(
    value.tree.map((node) => [node.id, node.relation, node.depth]),
    [
      ['child-1', 'ancestor', 1],
      ['session-root', 'ancestor', 2],
    ],
  );
  assert.match(value.summary, /上级会话：`child-1`/);
  assert.deepEqual(validateValue(value, overviewSchema()), []);
});

test('overviewSession：长会话提示改用检索（hint 里点名工具）', async () => {
  // 长的原始日志：seq 上界决定「长会话」判据。
  const longLog = [
    { seq: 1, type: 'user/message', time: 1_700_020_000_000, data: { content: [{ type: 'text', text: '长会话' }] } },
    ...Array.from({ length: 4300 }, (_unused, index) => ({
      seq: index + 2,
      type: 'tool/result',
      time: 1_700_020_001_000 + index,
      data: { message: { content: [{ type: 'text', text: `r${index}` }] } },
    })),
  ];
  const value = await overviewSession({
    sessionQuery: fakeQuery({ async readSession() { return { session: ROOT, inheritedEventCount: 0, events: longLog }; } }),
    sessionId: 'session-root',
    currentId: '',
    related: false,
    recentLimit: 1,
  });
  assert.equal(value.ok, true);
  assert.equal(value.stats.logEvents, 4302);
  assert.match(value.hint, /session_search/);
  assert.match(value.hint, /session_read/);
});

test('overviewSession：related=false 时不列树', async () => {
  const value = await overviewSession({
    sessionQuery: fakeQuery(),
    sessionId: 'session-root',
    currentId: '',
    related: false,
    recentLimit: 1,
  });
  assert.deepEqual(value.tree, []);
  assert.doesNotMatch(value.summary, /### 会话树/);
});

test('overviewSession：日志读失败不算整体失败，错误写进 surfaceError', async () => {
  const value = await overviewSession({
    sessionQuery: fakeQuery({
      async readSession() {
        throw new Error('stored session is corrupt');
      },
      async readSurface() {
        throw new Error('stored session is corrupt');
      },
    }),
    sessionId: 'session-root',
    currentId: '',
    related: true,
    recentLimit: 1,
  });
  assert.equal(value.ok, true);
  assert.equal(value.surfaceError, 'stored session is corrupt');
  assert.match(value.summary, /读取表层失败/);
  assert.equal(value.stats.logEvents, 0);
  assert.deepEqual(validateValue(value, overviewSchema()), []);
});

test('overviewSession：找不到会话 / 缺服务都是结构化失败', async () => {
  const missing = await overviewSession({ sessionQuery: fakeQuery(), sessionId: 'nope-1', currentId: '', related: true });
  assert.equal(missing.ok, false);
  assert.match(missing.summary, /找不到会话/);
  assert.deepEqual(validateValue(missing, overviewSchema()), []);

  const noService = await overviewSession({ sessionQuery: undefined, sessionId: 'x', currentId: '' });
  assert.equal(noService.ok, false);
  assert.match(noService.summary, /没有会话查询服务/);

  const empty = await overviewSession({ sessionQuery: fakeQuery(), sessionId: '  ', currentId: '' });
  assert.equal(empty.ok, false);
  assert.match(empty.summary, /需要一个会话 ID/);
});

test('searchSession：多词 AND、命中带 seq 与片段', async () => {
  const query = fakeQuery();
  const value = await searchSession({ sessionQuery: query, sessionId: 'session-root', query: '690 出包' });

  assert.equal(value.ok, true);
  assert.deepEqual(value.terms, ['690', '出包']);
  // AND：只有 seq 8 同时含「690」和「出包」（seq 3 只有「出包」、seq 6 只有「690」）。
  assert.deepEqual(value.hits.map((hit) => hit.seq), [8]);
  assert.equal(value.hitCount, 1);
  assert.equal(value.nextFromSeq, 0);
  assert.match(value.summary, /会话内检索：690 \+ 出包/);
  assert.match(value.summary, /seq 8/);
  // AND 语义靠把每个词作为一个 text 过滤器交给引擎。
  assert.deepEqual(query.lastFilters, [
    { kind: 'text', text: '690' },
    { kind: 'text', text: '出包' },
  ]);
  assert.deepEqual(validateValue(value, searchSchema()), []);
});

test('searchSession：fromSeq 翻页与 nextFromSeq', async () => {
  const first = await searchSession({ sessionQuery: fakeQuery(), sessionId: 'session-root', query: '包', limit: 2 });
  assert.deepEqual(first.hits.map((hit) => hit.seq), [3, 8]);
  // 命中 seq 3 与 8（用户任务 + 助手收尾），limit=1 时下一页从 4 开始。
  const paged = await searchSession({ sessionQuery: fakeQuery(), sessionId: 'session-root', query: '包', limit: 1 });
  assert.deepEqual(paged.hits.map((hit) => hit.seq), [3]);
  assert.equal(paged.nextFromSeq, 4);
  assert.match(paged.hint, /fromSeq: 4/);
});

test('searchSession：无命中 / 缺检索词 / 引擎报错都给出可读结论', async () => {
  const none = await searchSession({ sessionQuery: fakeQuery(), sessionId: 'session-root', query: '不存在的词' });
  assert.equal(none.ok, true);
  assert.equal(none.hitCount, 0);
  assert.match(none.summary, /没有命中/);

  const emptyQuery = await searchSession({ sessionQuery: fakeQuery(), sessionId: 'session-root', query: '   ' });
  assert.equal(emptyQuery.ok, false);
  assert.match(emptyQuery.summary, /需要一个检索词/);

  const broken = await searchSession({
    sessionQuery: fakeQuery({
      async filterEvents() {
        const error = new Error('session history storage is unavailable');
        error.code = 'SESSION_QUERY_PERSISTENCE_FAILED';
        throw error;
      },
    }),
    sessionId: 'session-root',
    query: '包',
  });
  assert.equal(broken.ok, false);
  assert.match(broken.summary, /检索失败/);
  assert.match(broken.summary, /storage is unavailable/);
  assert.deepEqual(validateValue(broken, searchSchema()), []);
});

test('searchSession：terms 上限与 limit 收口', async () => {
  const value = await searchSession({
    sessionQuery: fakeQuery(),
    sessionId: 'session-root',
    query: Array.from({ length: MAX_SEARCH_TERMS + 3 }, (_unused, index) => `t${index}`).join(' '),
    limit: 999,
  });
  assert.equal(value.terms.length, MAX_SEARCH_TERMS);
  assert.ok(value.hitCount <= DEFAULT_SEARCH_LIMIT || value.hitCount === 0);
});

test('readSessionWindow：给 seq 读窗口，标记目标事件', async () => {
  const value = await readSessionWindow({
    sessionQuery: fakeQuery(),
    sessionId: 'session-root',
    seq: 6,
    before: 2,
    after: 1,
  });

  assert.equal(value.ok, true);
  assert.equal(value.mode, 'window');
  assert.equal(value.targetSeq, 6);
  assert.equal(value.startSeq, 4);
  assert.equal(value.endSeq, 7);
  assert.deepEqual(value.events.map((event) => event.seq), [5, 6]);
  const target = value.events.find((event) => event.isTarget === true);
  assert.equal(target.seq, 6);
  assert.match(target.text, /690\/690 pass/);
  assert.match(value.summary, /目标 seq 6/);
  assert.deepEqual(validateValue(value, readSchema()), []);
});

test('readSessionWindow：不给 seq 读尾部，并给出 seq 供后续切窗口', async () => {
  const value = await readSessionWindow({ sessionQuery: fakeQuery(), sessionId: 'session-root', tailLimit: 2 });
  assert.equal(value.ok, true);
  assert.equal(value.mode, 'tail');
  assert.equal(value.targetSeq, 0);
  assert.deepEqual(value.events.map((event) => event.seq), [8, 11]);
  assert.equal(value.startSeq, 8);
  assert.equal(value.endSeq, 11);
  assert.match(value.hint, /seq/);
  assert.deepEqual(validateValue(value, readSchema()), []);
});

test('readSessionWindow：seq 不存在 / 缺 readEvent 都给结构化失败', async () => {
  const missingSeq = await readSessionWindow({ sessionQuery: fakeQuery(), sessionId: 'session-root', seq: 999 });
  // 假 readEvent 不抛错但窗口为空；真实引擎会报 SESSION_QUERY_EVENT_NOT_FOUND。
  assert.equal(missingSeq.ok, true);
  assert.deepEqual(missingSeq.events, []);

  const failing = await readSessionWindow({
    sessionQuery: fakeQuery({
      async readEvent() {
        const error = new Error('session "session-root" has no event at seq 999');
        error.code = 'SESSION_QUERY_EVENT_NOT_FOUND';
        throw error;
      },
    }),
    sessionId: 'session-root',
    seq: 999,
  });
  assert.equal(failing.ok, false);
  assert.match(failing.summary, /读取 seq 999 失败/);
  assert.match(failing.summary, /EVENT_NOT_FOUND/);
  assert.deepEqual(validateValue(failing, readSchema()), []);

  const noReadEvent = await readSessionWindow({
    sessionQuery: fakeQuery({ readEvent: undefined }),
    sessionId: 'session-root',
    seq: 1,
  });
  assert.equal(noReadEvent.ok, false);
  assert.match(noReadEvent.summary, /没有 readEvent/);
});
