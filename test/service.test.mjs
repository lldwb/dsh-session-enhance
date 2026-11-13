/**
 * 服务层测试：用假的 `sessionQuery` 固定住「血缘 + 标题 + 消息」的折叠结果。
 *
 * 假对象只实现本插件真正调用的三个方法（`traceSession`、
 * `readTitleSnapshots`、`readSurface`），方法形状照抄随附实现的返回结构。
 * 这样即便随附包升级，只要这三个契约不变，本文件无需改动；契约变了的信号
 * 会先出现在这里，而不是出现在用户的一次真实调用里。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkpointTextOf,
  classifyRole,
  failureResult,
  flattenDescendants,
  isCompactCheckpoint,
  looksInjected,
  lookupSession,
  messageTextOf,
  messagesOf,
  readTitles,
  renderLookup,
  titleTextOf,
  toIso,
  truncateText,
} from '../lib/service.mjs';
import { buildTools } from '../lib/tools.mjs';
import { validateValue } from './strict-schema.mjs';

/** 根会话头。 */
const ROOT = { version: 1, id: 'root-1', createdAt: 1_700_000_000_000, cwd: 'E:\\work', isSeeded: false, agentPreset: 'standard' };

/** 直接子代理（origin=subagent）。 */
const CHILD = {
  version: 1,
  id: 'child-1',
  createdAt: 1_700_000_100_000,
  cwd: 'E:\\work',
  parentSession: 'root-1',
  origin: 'subagent',
  delegationDepth: 1,
  isSeeded: true,
};

/** 孙代理：证明递归展开与深度。 */
const GRANDCHILD = {
  version: 1,
  id: 'grand-1',
  createdAt: 1_700_000_200_000,
  cwd: 'E:\\work',
  parentSession: 'child-1',
  origin: 'subagent',
  delegationDepth: 2,
  isSeeded: true,
};

/** 用户分支出来的会话（有父会话但不是 subagent）。 */
const FORK = { version: 1, id: 'fork-1', createdAt: 1_700_000_300_000, cwd: 'E:\\work', parentSession: 'root-1', isSeeded: true };

/** 事件：user 消息。 */
const USER_EVENT = { seq: 1, type: 'user/message', time: 1_700_000_400_000, data: { content: [{ type: 'text', text: '帮我看下鸡腿标注' }] } };

/** 事件：assistant 消息。 */
const ASSISTANT_EVENT = {
  seq: 2,
  type: 'assistant/message',
  time: 1_700_000_500_000,
  data: { message: { content: [{ type: 'text', text: '好的，我先看数据分布。' }, { type: 'tool-call', name: 'glob' }] } },
};

/** 事件：工具结果（本插件会跳过）。 */
const TOOL_EVENT = { seq: 3, type: 'tool/result', time: 1_700_000_600_000, data: { message: { content: [{ type: 'text', text: 'should not appear' }] } } };

/** 事件：压缩摘要（从 data.summary 取文本）。 */
const SUMMARY_EVENT = { seq: 4, type: 'compaction/summary', time: 1_700_000_700_000, data: { summary: [{ type: 'text', text: '此前讨论了标注格式。' }] } };

/** 事件：框架注入的 system 指令（本插件会跳过）。 */
const SYSTEM_EVENT = { seq: 5, type: 'system/message', time: 1_700_000_800_000, data: { message: { content: [{ type: 'text', text: 'You are an AI agent...' }] } } };

/** 事件：developer 消息（本插件会跳过）。 */
const DEVELOPER_EVENT = { seq: 6, type: 'developer/message', time: 1_700_000_900_000, data: { message: { content: [{ type: 'text', text: 'runtime context' }] } } };

/**
 * 构造一个假查询服务。
 *
 * @param {any} [overrides] - 覆盖单个方法或整体行为。
 * @returns {any} 假 `sessionQuery`。
 */
function fakeQuery(overrides = {}) {
  return {
    async traceSession(sessionId) {
      if (sessionId !== ROOT.id) {
        const error = new Error(`session "${sessionId}" not found`);
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
        throw error;
      }
      return {
        target: { header: ROOT, live: true, persisted: true },
        ancestors: [],
        descendants: [
          {
            session: { header: CHILD, live: false, persisted: true },
            descendants: [{ session: { header: GRANDCHILD, live: true, persisted: true }, descendants: [] }],
          },
          { session: { header: FORK, live: false, persisted: true }, descendants: [] },
        ],
        complete: true,
        root: { header: ROOT, live: true, persisted: true },
      };
    },
    async readTitleSnapshots(ids) {
      const titles = {
        'root-1': '鸡腿标注检查与子代理编排',
        'child-1': '子代理：检查标注脚本',
        'grand-1': '孙代理：跑一次抽样',
      };
      // 0.2.2 的形状：观察里的 `title` 是 SessionTitleSnapshot 对象，不是字符串。
      const snapshotOf = (text) => ({
        title: text,
        messageSeqs: [1],
        source: { kind: 'fallback' },
        eventSeq: 14,
        updatedAt: 1_700_000_950_000,
      });
      return ids.map((sessionId) =>
        titles[sessionId] === undefined
          ? { status: 'fulfilled', sessionId, value: { session: { id: sessionId } } }
          : { status: 'fulfilled', sessionId, value: { session: { id: sessionId }, title: snapshotOf(titles[sessionId]) } },
      );
    },
    async readSurface(sessionId) {
      if (sessionId !== ROOT.id) {
        const error = new Error('no surface');
        error.code = 'SESSION_QUERY_INVALID_SURFACE';
        throw error;
      }
      return { session: ROOT, inheritedEventCount: 0, capturedThroughSeq: 4, events: [USER_EVENT, ASSISTANT_EVENT, TOOL_EVENT, SUMMARY_EVENT] };
    },
    ...overrides,
  };
}

/** 找到 session_lookup 定义。 */
function lookupTool() {
  return buildTools({ get: () => undefined }).find((tool) => tool.name === 'session_lookup');
}

test('toIso 把毫秒转成 ISO，非法值返回空串', () => {
  assert.equal(toIso(0), '1970-01-01T00:00:00.000Z');
  assert.equal(toIso(undefined), '');
  assert.equal(toIso(Number.NaN), '');
  assert.equal(toIso('1700000000000'), '');
});

test('classifyRole 区分 root / subagent / fork', () => {
  assert.equal(classifyRole(ROOT), 'root');
  assert.equal(classifyRole(CHILD), 'subagent');
  assert.equal(classifyRole(FORK), 'fork');
  assert.equal(classifyRole({ id: 'x' }), 'root');
});

test('flattenDescendants 递归展开、父在前、深度正确', () => {
  const flat = flattenDescendants([
    { session: { header: CHILD }, descendants: [{ session: { header: GRANDCHILD }, descendants: [] }] },
    { session: { header: FORK }, descendants: [] },
  ]);
  assert.deepEqual(
    flat.map((node) => [node.record.header.id, node.depth, node.parentId]),
    [
      ['child-1', 1, ''],
      ['grand-1', 2, 'child-1'],
      ['fork-1', 1, ''],
    ],
  );
  assert.deepEqual(flattenDescendants(undefined), []);
});

test('titleTextOf 认得 0.2.2 的 SessionTitleSnapshot 对象，也容忍纯字符串', () => {
  assert.equal(titleTextOf({ title: '简单算术问题', messageSeqs: [8], source: { kind: 'provider' }, eventSeq: 18, updatedAt: 1 }), '简单算术问题');
  assert.equal(titleTextOf('纯字符串标题'), '纯字符串标题');
  assert.equal(titleTextOf(undefined), '');
  assert.equal(titleTextOf({}), '');
  assert.equal(titleTextOf({ title: 42 }), '');
});

test('readTitles 逐条吞掉 rejected 观察，整批失败也不抛', async () => {
  const titles = await readTitles(
    {
      async readTitleSnapshots(ids) {
        return [
          { status: 'rejected', sessionId: ids[0], reason: new Error('boom') },
          // 0.2.2：title 是 SessionTitleSnapshot 对象。
          {
            status: 'fulfilled',
            sessionId: ids[1],
            value: { session: { id: ids[1] }, title: { title: '有标题', messageSeqs: [], source: { kind: 'fallback' }, eventSeq: 1, updatedAt: 2 } },
          },
        ];
      },
    },
    ['a', 'b'],
  );
  assert.equal(titles.get('a'), undefined);
  assert.equal(titles.get('b'), '有标题');

  const empty = await readTitles(
    {
      async readTitleSnapshots() {
        throw new Error('整批失败');
      },
    },
    ['a'],
  );
  assert.equal(empty.size, 0);
});

test('messageTextOf 认得 content / message.content / summary 三种位置', () => {
  assert.equal(messageTextOf(USER_EVENT), '帮我看下鸡腿标注');
  assert.equal(messageTextOf(ASSISTANT_EVENT), '好的，我先看数据分布。');
  assert.equal(messageTextOf(SUMMARY_EVENT), '此前讨论了标注格式。');
  assert.equal(messageTextOf({ seq: 9, type: 'x', data: {} }), '');
  assert.equal(messageTextOf(undefined), '');
});

test('messagesOf 只保留人对人的语义事件：跳过工具结果、system 与 developer', () => {
  const messages = messagesOf(
    { events: [USER_EVENT, ASSISTANT_EVENT, TOOL_EVENT, SUMMARY_EVENT, SYSTEM_EVENT, DEVELOPER_EVENT] },
    10,
  );
  assert.deepEqual(
    messages.map((message) => message.role),
    ['user', 'assistant', 'summary'],
  );
  assert.equal(messages[0].seq, 1);
  assert.equal(messages[0].time, new Date(1_700_000_400_000).toISOString());
});

test('messagesOf 取最后 N 条', () => {
  const messages = messagesOf({ events: [USER_EVENT, ASSISTANT_EVENT, SUMMARY_EVENT] }, 2);
  assert.deepEqual(
    messages.map((message) => message.seq),
    [2, 4],
  );
});

test('messagesOf 按 data.source.kind 滤掉 0.2.2 的框架注入（runtime-context / skill-catalog / time-context）', () => {
  // 0.2.2 的注入事件：文本前缀不一定命中老的前缀表，但 source.kind 一定会。
  const runtimeContext = {
    seq: 9,
    type: 'user/message',
    time: 1_700_000_910_000,
    data: {
      role: 'user',
      source: { kind: 'runtime-context', form: 'snapshot' },
      content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: …' }],
    },
  };
  const skillCatalog = {
    seq: 10,
    type: 'user/message',
    time: 1_700_000_920_000,
    data: {
      role: 'user',
      source: { kind: 'skill-catalog', form: 'catalog' },
      content: [{ type: 'text', text: '<system-reminder>\nA skill is a reusable set of task-specific instructions.' }],
    },
  };
  // 0.2.1-alpha.1 起新增的 time-context：文本首行 `Time sampled while preparing …`。
  const timeContext = {
    seq: 11,
    type: 'user/message',
    time: 1_700_000_930_000,
    data: {
      role: 'user',
      source: { kind: 'time-context', form: 'snapshot' },
      content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-06T10:49:08+08:00[Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai.' }],
    },
  };
  // 真实用户消息：source.kind === 'user'，必须保留。
  const realUser = {
    seq: 8,
    type: 'user/message',
    time: 1_700_000_900_000,
    data: {
      role: 'user',
      source: { kind: 'user', rpcId: 'x' },
      content: [{ type: 'text', text: '用一句话回答：1+1 等于几？' }],
    },
  };
  const messages = messagesOf({ events: [runtimeContext, skillCatalog, timeContext, realUser, ASSISTANT_EVENT] }, 10);
  assert.deepEqual(
    messages.map((message) => [message.seq, message.role]),
    [
      [8, 'user'],
      [2, 'assistant'],
    ],
  );
});

test('messagesOf：压缩检查点映射成 summary 角色，并剥掉引导语与标签', () => {
  // 官方 compactCheckpointSource 落地的是 user/message，source.kind = 'compact-checkpoint'。
  const checkpoint = {
    seq: 20,
    type: 'user/message',
    time: 1_700_001_000_000,
    data: {
      source: { kind: 'compact-checkpoint', compactionId: 'c1' },
      content: [
        {
          type: 'text',
          text:
            'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. ' +
            'Treat the captured context as established background and build on it without restating it. ' +
            'Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>',
        },
        { type: 'text', text: '## Primary Request and Intent\n- 帮我看下鸡腿标注' },
        { type: 'text', text: '</compacted-summary>' },
      ],
    },
  };
  const messages = messagesOf({ events: [checkpoint, ASSISTANT_EVENT] }, 10);
  assert.deepEqual(
    messages.map((message) => message.role),
    ['summary', 'assistant'],
  );
  // 不是用户说的话：不能以引导语开头，也不能残留标签。
  assert.equal(messages[0].text.startsWith('This is an automatically generated checkpoint'), false);
  assert.equal(messages[0].text.includes('<compacted-summary>'), false);
  assert.equal(messages[0].text.includes('</compacted-summary>'), false);
  assert.ok(messages[0].text.startsWith('## Primary Request and Intent'));
  assert.equal(isCompactCheckpoint(checkpoint), true);
  assert.equal(isCompactCheckpoint(USER_EVENT), false);
});

test('messagesOf：检查点缺标签时原样保留内容（宁可多显示也不吞）', () => {
  const untagged = {
    seq: 21,
    type: 'user/message',
    time: 1_700_001_010_000,
    data: {
      source: { kind: 'compact-checkpoint', compactionId: 'c2' },
      content: [{ type: 'text', text: '## Current Work\n- 正在改压缩' }],
    },
  };
  const messages = messagesOf({ events: [untagged] }, 10);
  assert.equal(messages[0].role, 'summary');
  assert.equal(messages[0].text, '## Current Work\n- 正在改压缩');
});

test('messagesOf 对没有 source 字段的老日志仍按文本前缀滤注入', () => {
  const injected = {
    seq: 12,
    type: 'user/message',
    time: 1_700_000_940_000,
    data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 2, step 1: 2026-11-06T11:00:00+08:00[Asia/Shanghai]' }] },
  };
  assert.deepEqual(messagesOf({ events: [injected, USER_EVENT] }, 10).map((message) => message.seq), [1]);
});

test('truncateText 只在超长时截断并保留原长提示', () => {
  assert.equal(truncateText('短', 10), '短');
  const long = 'x'.repeat(20);
  assert.ok(truncateText(long, 5).startsWith('xxxxx'));
  assert.match(truncateText(long, 5), /原长 20 字符/);
});

test('lookupSession：根会话返回完整子代理树与最近消息', async () => {
  const value = await lookupSession({
    sessionQuery: fakeQuery(),
    sessionId: ROOT.id,
    currentId: 'root-1',
    includeMessages: true,
    messageLimit: 10,
  });

  assert.equal(value.ok, true);
  assert.equal(value.session.id, 'root-1');
  assert.equal(value.session.title, '鸡腿标注检查与子代理编排');
  assert.equal(value.session.role, 'root');
  assert.equal(value.session.workspace, 'E:\\work');
  assert.equal(value.session.isCurrent, true);
  assert.equal(value.subagentCount, 3);
  assert.deepEqual(
    value.subagents.map((node) => [node.id, node.depth, node.parentId]),
    [
      ['child-1', 1, ''],
      ['grand-1', 2, 'child-1'],
      ['fork-1', 1, ''],
    ],
  );
  assert.equal(value.subagents[1].role, 'subagent');
  assert.equal(value.subagents[2].role, 'fork');
  assert.equal(value.messages.length, 3);
  assert.match(value.summary, /### 子代理（共 3 个/);
  assert.match(value.summary, /grand-1/);
  assert.equal(value.complete, true);

  // 返回值必须通过工具自己声明的 output schema —— 这是"运行时 invalid output"的离线防线。
  const tool = lookupTool();
  assert.deepEqual(validateValue(value, tool.output.schema), []);
});

test('lookupSession：找不到会话时给出可读失败', async () => {
  const value = await lookupSession({
    sessionQuery: fakeQuery(),
    sessionId: 'missing-id',
    currentId: 'root-1',
    includeMessages: true,
    messageLimit: 10,
  });
  assert.equal(value.ok, false);
  assert.equal(value.targetId, 'missing-id');
  assert.match(value.summary, /找不到会话/);
  assert.deepEqual(validateValue(value, lookupTool().output.schema), []);
});

test('lookupSession：缺查询服务 / 空 id 都是结构化失败', async () => {
  const noService = await lookupSession({ sessionQuery: undefined, sessionId: 'x', currentId: '', includeMessages: true, messageLimit: 5 });
  assert.equal(noService.ok, false);
  assert.match(noService.summary, /没有会话查询服务/);

  const emptyId = await lookupSession({ sessionQuery: fakeQuery(), sessionId: '   ', currentId: '', includeMessages: true, messageLimit: 5 });
  assert.equal(emptyId.ok, false);
  assert.match(emptyId.summary, /需要一个会话 ID/);
  assert.deepEqual(validateValue(emptyId, lookupTool().output.schema), []);
});

test('lookupSession：includeMessages=false 时不读表层也不返回消息', async () => {
  let surfaceReads = 0;
  const value = await lookupSession({
    sessionQuery: fakeQuery({
      async readSurface() {
        surfaceReads += 1;
        throw new Error('不该被调用');
      },
    }),
    sessionId: ROOT.id,
    currentId: 'root-1',
    includeMessages: false,
    messageLimit: 10,
  });
  assert.equal(value.ok, true);
  assert.equal(surfaceReads, 0);
  assert.deepEqual(value.messages, []);
  assert.match(value.hint, /未返回消息正文/);
});

test('lookupSession：表层读取失败不影响元信息', async () => {
  const value = await lookupSession({
    sessionQuery: fakeQuery({
      async readSurface() {
        throw new Error('日志损坏');
      },
    }),
    sessionId: ROOT.id,
    currentId: 'root-1',
    includeMessages: true,
    messageLimit: 10,
  });
  assert.equal(value.ok, true);
  assert.equal(value.subagentCount, 3);
  assert.deepEqual(value.messages, []);
});

test('lookupSession：表层读取失败必须把错误说出来，不能伪装成「会话为空」', async () => {
  // 真实事故（2026-11-13）：日志被判 corrupt，工具却只显示「没有可读的语义消息」，
  // 用户以为历史丢了。读失败与空会话是两件事，摘要里必须能区分。
  const cause =
    'stored session "s1" is corrupt: SessionFormatError: tool/result replacement is outside an open turn';
  const value = await lookupSession({
    sessionQuery: fakeQuery({
      async readSurface() {
        throw new Error(cause);
      },
    }),
    sessionId: ROOT.id,
    currentId: 'root-1',
    includeMessages: true,
    messageLimit: 10,
  });

  assert.equal(value.ok, true);
  assert.deepEqual(value.messages, []);
  // 摘要里要出现原始错误与「不是没有内容」的判据。
  assert.match(value.summary, /读取会话表层失败/);
  assert.match(value.summary, /outside an open turn/);
  assert.match(value.summary, /不是.*会话没有内容/);
  // 不许再出现那句会被误读成「会话是空的」的文案。
  assert.doesNotMatch(value.summary, /没有可读的语义消息/);
});

test('lookupSession：表层读成功但确实没有语义消息时，仍用「可能为空」的措辞', async () => {
  const value = await lookupSession({
    sessionQuery: fakeQuery({
      async readSurface() {
        return { session: ROOT, inheritedEventCount: 0, capturedThroughSeq: 1, events: [] };
      },
    }),
    sessionId: ROOT.id,
    currentId: 'root-1',
    includeMessages: true,
    messageLimit: 10,
  });

  assert.deepEqual(value.messages, []);
  assert.match(value.summary, /没有可读的语义消息/);
  assert.doesNotMatch(value.summary, /读取会话表层失败/);
});

test('renderLookup：祖先链与不完整血缘都写进摘要', async () => {
  const query = fakeQuery({
    async traceSession() {
      return {
        target: { header: CHILD, live: false, persisted: true },
        ancestors: [{ header: ROOT, live: true, persisted: true }],
        descendants: [],
        complete: false,
        unresolvedParentId: 'deleted-parent',
      };
    },
  });
  const value = await lookupSession({ sessionQuery: query, sessionId: 'child-1', currentId: 'root-1', includeMessages: false, messageLimit: 5 });
  assert.equal(value.session.role, 'subagent');
  assert.equal(value.session.parentSessionId, 'root-1');
  assert.equal(value.ancestors.length, 1);
  assert.equal(value.complete, false);
  assert.equal(value.unresolvedParentId, 'deleted-parent');
  assert.match(value.summary, /祖先链/);
  assert.match(value.summary, /血缘不完整/);
  assert.match(value.summary, /deleted-parent/);
  assert.deepEqual(validateValue(value, lookupTool().output.schema), []);
});

test('renderLookup：子代理为空时明确说没有', () => {
  const value = renderLookup({
    trace: { target: { header: ROOT, live: true, persisted: false }, ancestors: [], descendants: [], complete: true },
    titles: new Map([['root-1', '标题']]),
    currentId: 'other',
    messages: [],
    includeMessages: true,
    inheritedEventCount: 0,
  });
  assert.equal(value.subagentCount, 0);
  assert.equal(value.session.isCurrent, false);
  assert.match(value.summary, /这个会话没有子代理会话/);
});

test('renderLookup：种子会话会提示继承事件', () => {
  const value = renderLookup({
    trace: { target: { header: CHILD, live: true, persisted: true }, ancestors: [], descendants: [], complete: true },
    titles: new Map(),
    currentId: '',
    messages: [],
    includeMessages: true,
    inheritedEventCount: 12,
  });
  assert.equal(value.inheritedEventCount, 12);
  assert.match(value.hint, /继承自父会话/);
});

/** 事件：框架注入的 runtime context（以 user 角色落盘，本插件会跳过）。 */
const RUNTIME_CONTEXT_EVENT = {
  seq: 7,
  type: 'user/message',
  time: 1_700_001_000_000,
  data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] },
};

/** 事件：框架注入的 skill 目录（以 user 角色落盘，本插件会跳过）。 */
const SKILL_REMINDER_EVENT = {
  seq: 8,
  type: 'user/message',
  time: 1_700_001_100_000,
  data: { content: [{ type: 'text', text: '<system-reminder> A skill is a reusable set of task-specific instructions.' }] },
};

test('looksInjected 认得框架注入前缀，普通用户消息不受影响', () => {
  assert.equal(looksInjected('Current runtime context. ...'), true);
  assert.equal(looksInjected('<system-reminder> ...'), true);
  assert.equal(looksInjected('The following skills are available in this session:'), true);
  assert.equal(looksInjected('帮我看下鸡腿标注'), false);
  assert.equal(looksInjected('系统提示词这块我想改成中文'), false);
});

test('messagesOf 跳过每轮注入的 runtime context 与 system-reminder', () => {
  const messages = messagesOf(
    { events: [USER_EVENT, RUNTIME_CONTEXT_EVENT, ASSISTANT_EVENT, SKILL_REMINDER_EVENT] },
    10,
  );
  assert.deepEqual(
    messages.map((message) => message.seq),
    [1, 2],
  );
});

// DSH 0.2.2-rc.2 的 runtime-context 文本（见 @deepseek-ai/dsh-agent-loop 的
// runtime-context.ts）：快照与清空提醒都被包进 `<system-reminder>`，引导语也换了。
const RC2_SNAPSHOT_TEXT = [
  '<system-reminder>',
  'The following information describes your current session:',
  '',
  'Current working directory: E:\\dsh-plugins',
  '',
  'Sandbox policy: danger-full-access',
  '</system-reminder>',
].join('\n');
const RC2_LATER_SNAPSHOT_TEXT = [
  '<system-reminder>',
  'The following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries.',
  '',
  'Current working directory: E:\\dsh-plugins',
  '</system-reminder>',
].join('\n');
const RC2_CLEARED_TEXT = [
  '<system-reminder>',
  'Current runtime context: none. Earlier runtime-context snapshots no longer apply.',
  '</system-reminder>',
].join('\n');

/** 造一条 rc.2 的 runtime-context 事件。 */
function rc2ContextEvent(seq, text, withSource = true) {
  return {
    seq,
    type: 'user/message',
    time: 1_700_002_000_000 + seq,
    data: {
      role: 'user',
      ...(withSource ? { source: { kind: 'runtime-context', form: 'snapshot', sections: [] } } : {}),
      content: [{ type: 'text', text }],
    },
  };
}

test('messagesOf 认得 0.2.2-rc.2 的 system-reminder 包装：快照 / 后续快照 / 清空提醒都滤掉', () => {
  const events = [
    rc2ContextEvent(20, RC2_SNAPSHOT_TEXT),
    rc2ContextEvent(21, RC2_LATER_SNAPSHOT_TEXT),
    rc2ContextEvent(22, RC2_CLEARED_TEXT),
    USER_EVENT,
    ASSISTANT_EVENT,
  ];
  const messages = messagesOf({ events }, 10);
  assert.deepEqual(messages.map((message) => message.seq), [1, 2]);
});

test('messagesOf 对没有 source 的 rc.2 文本仍按 <system-reminder> 前缀兜底过滤', () => {
  // 0.2.2 之前写入的老日志可能没有 source；rc.2 的新文案已经不再以
  // "Current runtime context." 开头，能兜住它的是 <system-reminder> 前缀。
  const events = [
    rc2ContextEvent(30, RC2_SNAPSHOT_TEXT, false),
    rc2ContextEvent(31, RC2_LATER_SNAPSHOT_TEXT, false),
    rc2ContextEvent(32, RC2_CLEARED_TEXT, false),
    USER_EVENT,
  ];
  const messages = messagesOf({ events }, 10);
  assert.deepEqual(messages.map((message) => message.seq), [1]);
});

test('looksInjected：rc.2 三种文本都命中，正文里提到这些词的用户消息不误伤', () => {
  assert.equal(looksInjected(RC2_SNAPSHOT_TEXT), true);
  assert.equal(looksInjected(RC2_LATER_SNAPSHOT_TEXT), true);
  assert.equal(looksInjected(RC2_CLEARED_TEXT), true);
  // 旧版未包装的清空提醒（0.2.2-rc.1 及更早）仍按旧前缀命中。
  assert.equal(looksInjected('Current runtime context: none. Earlier runtime-context snapshots no longer apply.'), true);
  // 用户消息里只是“提到”这些词，不以它们开头，不误判。
  assert.equal(looksInjected('为什么 <system-reminder> 会出现在日志里？'), false);
  assert.equal(looksInjected('我想改 Current runtime context. 的文案'), false);
});

test('failureResult 始终是完整形状', () => {
  const value = failureResult('abc', '❌ 原因');
  assert.deepEqual(Object.keys(value).sort(), Object.keys(lookupTool().output.schema.properties).sort());
  assert.deepEqual(validateValue(value, lookupTool().output.schema), []);
});
