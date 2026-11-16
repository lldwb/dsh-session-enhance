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
  clampNestedMessageLimit,
  classifyRole,
  DEFAULT_NESTED_MESSAGE_LIMIT,
  failureResult,
  flattenDescendants,
  isCompactCheckpoint,
  looksInjected,
  lookupSession,
  MAX_NESTED_MESSAGE_LIMIT,
  messageTextOf,
  messagesOf,
  NESTED_SESSION_CAP,
  nestedDigestOf,
  readTitles,
  renderLookup,
  sessionUuidOf,
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

// #region 会话 id 归一化（2026-11-15 真实事故：会话 id 前缀被丢掉 → 「找不到会话」）
//
// 事故现场（会话 session-31874d86 的 seq 2699/2700）：用户写的是
// `session-559eb381-…会话提到的…`，模型把 `session-` 前缀丢掉、又粘上了后面的中文，
// `session_lookup` 拿整串去精确匹配，直接回「找不到会话」——而那份会话就在本机。
// 三种写法（`session-<uuid>` / 裸 `<uuid>` / `dsh-session-session-<uuid>.zip`）指向同一份日志，
// 归一化的锚点是 UUID。

/** 事故里那个根会话的真实 id：带 `session-` 前缀。 */
const UUID_ROOT_ID = 'session-559eb381-39ff-42bf-b3b6-4ae109b37eb1';

/** 同一棵树的子代理：真实 id 是**裸 UUID**（子代理会话没有前缀）。 */
const UUID_CHILD_ID = '1da52432-571f-458c-a8f0-5716e8cf2d59';

/** 事故里的根会话头。 */
const UUID_ROOT = {
  version: 1,
  id: UUID_ROOT_ID,
  createdAt: 1_700_001_000_000,
  cwd: 'C:\\Users\\32471\\Documents\\deepseek-harness\\ungrouped',
  isSeeded: false,
  agentPreset: 'standard',
};

/** 事故里的子代理会话头。 */
const UUID_CHILD = {
  version: 1,
  id: UUID_CHILD_ID,
  createdAt: 1_700_001_100_000,
  cwd: 'C:\\Users\\32471\\Documents\\deepseek-harness\\ungrouped',
  parentSession: UUID_ROOT_ID,
  origin: 'subagent',
  delegationDepth: 1,
  isSeeded: false,
};

/**
 * 照随附实现语义的假查询：`traceSession` **只认精确 id**（裸 UUID / 导出文件名一律
 * `SESSION_QUERY_SESSION_NOT_FOUND`），另暴露 `listSessions` 供归一化回查。
 *
 * `listCalls` 记录语料库被列了几次：快路径不该多列。
 *
 * @param {any} [overrides] - 覆盖单个方法。
 * @returns {any} 假 `sessionQuery`。
 */
function uuidQuery(overrides = {}) {
  const records = [
    { header: UUID_ROOT, live: true, persisted: true },
    { header: UUID_CHILD, live: false, persisted: true },
  ];
  const query = {
    listCalls: 0,
    async traceSession(sessionId) {
      const found = records.find((record) => record.header.id === sessionId);
      if (found === undefined) {
        const error = new Error(`session "${sessionId}" not found`);
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
        throw error;
      }
      return {
        target: found,
        ancestors: found.header.parentSession === undefined ? [] : [{ header: UUID_ROOT, live: true, persisted: true }],
        descendants: [],
        complete: true,
      };
    },
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => ({
        status: 'fulfilled',
        sessionId,
        value: {
          session: { id: sessionId },
          title: { title: '远程配置飞牛应用默认地址', messageSeqs: [1], source: { kind: 'fallback' }, eventSeq: 1, updatedAt: 1_700_001_500_000 },
        },
      }));
    },
    async readSurface(sessionId) {
      return { session: { id: sessionId }, inheritedEventCount: 0, capturedThroughSeq: 1, events: [USER_EVENT] };
    },
    async listSessions() {
      query.listCalls += 1;
      return records;
    },
    ...overrides,
  };
  return query;
}

test('sessionUuidOf 从三种写法里取出同一段 UUID', () => {
  const uuid = '559eb381-39ff-42bf-b3b6-4ae109b37eb1';
  const same = [
    uuid,
    `session-${uuid}`,
    `dsh-session-session-${uuid}.zip`,
    `C:\\Users\\32471\\Downloads\\dsh-session-session-${uuid}.zip`,
    // 事故现场：id 后面直接粘着正文，没有分隔符。
    `session-${uuid}会话提到的`,
    `  session-${uuid}  `,
  ];
  for (const value of same) assert.equal(sessionUuidOf(value), uuid, value);
  // 大写也认（UUID 大小写不敏感），归一化输出统一小写。
  assert.equal(sessionUuidOf(uuid.toUpperCase()), uuid);
  assert.equal(sessionUuidOf('missing-id'), '');
  assert.equal(sessionUuidOf(undefined), '');
  assert.equal(sessionUuidOf(42), '');
});

test('lookupSession：裸 UUID 归一化到带 session- 前缀的真实 id（2026-11-15 真实事故）', async () => {
  const query = uuidQuery();
  const value = await lookupSession({
    sessionQuery: query,
    sessionId: '559eb381-39ff-42bf-b3b6-4ae109b37eb1',
    currentId: '',
    includeMessages: true,
    messageLimit: 5,
  });

  assert.equal(value.ok, true);
  assert.equal(value.targetId, UUID_ROOT_ID);
  assert.equal(value.session.id, UUID_ROOT_ID);
  assert.equal(value.session.title, '远程配置飞牛应用默认地址');
  assert.equal(value.messages.length, 1);
  // 归一化必须写进摘要：模型下一轮要引用真实 id，用户也要知道「我给的写法被认成了哪个会话」。
  assert.match(value.summary, /归一化/);
  assert.match(value.summary, /559eb381-39ff-42bf-b3b6-4ae109b37eb1/);
  assert.deepEqual(validateValue(value, lookupTool().output.schema), []);
});

test('lookupSession：会话导出文件名（整条路径 + .zip）也能归一化', async () => {
  const value = await lookupSession({
    sessionQuery: uuidQuery(),
    sessionId: 'C:\\Users\\32471\\Downloads\\dsh-session-session-559eb381-39ff-42bf-b3b6-4ae109b37eb1.zip',
    currentId: '',
    includeMessages: false,
    messageLimit: 5,
  });
  assert.equal(value.ok, true);
  assert.equal(value.session.id, UUID_ROOT_ID);
  assert.match(value.summary, /归一化/);
});

test('lookupSession：id 后面粘了正文也能归一化（事故里的原样粘贴）', async () => {
  const value = await lookupSession({
    sessionQuery: uuidQuery(),
    sessionId: 'session-559eb381-39ff-42bf-b3b6-4ae109b37eb1会话提到的',
    currentId: '',
    includeMessages: false,
    messageLimit: 5,
  });
  assert.equal(value.ok, true);
  assert.equal(value.session.id, UUID_ROOT_ID);
});

test('lookupSession：子代理的裸 UUID 照常命中（不能一律加 session- 前缀）', async () => {
  const value = await lookupSession({
    sessionQuery: uuidQuery(),
    sessionId: UUID_CHILD_ID,
    currentId: '',
    includeMessages: false,
    messageLimit: 5,
  });
  assert.equal(value.ok, true);
  assert.equal(value.session.id, UUID_CHILD_ID);
  assert.equal(value.session.role, 'subagent');
  assert.equal(value.session.parentSessionId, UUID_ROOT_ID);
  // 精确命中 = 快路径：不该为了归一化多列一次语料库。
  assert.doesNotMatch(value.summary, /归一化/);
});

test('lookupSession：精确 id 命中时不额外列语料库（快路径不变慢）', async () => {
  const query = uuidQuery();
  const value = await lookupSession({
    sessionQuery: query,
    sessionId: UUID_ROOT_ID,
    currentId: '',
    includeMessages: false,
    messageLimit: 5,
  });
  assert.equal(value.ok, true);
  assert.equal(query.listCalls, 0);
});

test('lookupSession：没有 UUID 的 id 不会去列语料库', async () => {
  const query = uuidQuery();
  const value = await lookupSession({
    sessionQuery: query,
    sessionId: 'missing-id',
    currentId: '',
    includeMessages: false,
    messageLimit: 5,
  });
  assert.equal(value.ok, false);
  assert.match(value.summary, /找不到会话/);
  assert.equal(query.listCalls, 0, '没有 UUID 可回查时不该列语料库');
});

test('lookupSession：同一 UUID 命中多个会话时明确报不唯一，不随便挑一个', async () => {
  const query = uuidQuery({
    async listSessions() {
      return [
        { header: UUID_ROOT, live: true, persisted: true },
        { header: { ...UUID_ROOT, id: '559eb381-39ff-42bf-b3b6-4ae109b37eb1' }, live: false, persisted: true },
      ];
    },
  });
  const value = await lookupSession({
    sessionQuery: query,
    sessionId: '559eb381-39ff-42bf-b3b6-4ae109b37eb1',
    currentId: '',
    includeMessages: false,
    messageLimit: 5,
  });
  assert.equal(value.ok, false);
  assert.match(value.summary, /不唯一/);
  assert.match(value.summary, /session-559eb381-39ff-42bf-b3b6-4ae109b37eb1/);
  assert.match(value.summary, /559eb381-39ff-42bf-b3b6-4ae109b37eb1/);
  assert.deepEqual(validateValue(value, lookupTool().output.schema), []);
});

test('lookupSession：回查语料库失败时把原因带出来，不伪装成「会话不存在」', async () => {
  // 2026-11-15 的另一份日志里真的出现过 `session history storage is unavailable`：
  // 「存储挂了」和「没有这个会话」是两件事，摘要里必须能区分。
  const query = uuidQuery({
    async listSessions() {
      throw new Error('session history storage is unavailable');
    },
  });
  const value = await lookupSession({
    sessionQuery: query,
    sessionId: '559eb381-39ff-42bf-b3b6-4ae109b37eb1',
    currentId: '',
    includeMessages: false,
    messageLimit: 5,
  });
  assert.equal(value.ok, false);
  assert.match(value.summary, /找不到会话/);
  assert.match(value.summary, /回查/);
  assert.match(value.summary, /storage is unavailable/);
  assert.deepEqual(validateValue(value, lookupTool().output.schema), []);
});

test('lookupSession：取消信号原样抛出，不被当成「会话不存在」', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const query = uuidQuery({
    async listSessions() {
      throw abort;
    },
  });
  const value = await lookupSession({
    sessionQuery: query,
    sessionId: '559eb381-39ff-42bf-b3b6-4ae109b37eb1',
    currentId: '',
    includeMessages: false,
    messageLimit: 5,
  });
  assert.equal(value.ok, false);
  // 走到「查询会话失败」这条通用分支，而不是「找不到会话」。
  assert.match(value.summary, /查询会话失败/);
  assert.doesNotMatch(value.summary, /回查/);
});
// #endregion

// #region 谱系内容读取（子会话 / 孙会话 / 上级会话都要能读到内容）
//
// 用户诉求（2026-11-16）：按 id 读会话时，要连带读到它的子会话、子会话的子会话；
// 如果目标是子会话，还要知道它的上级会话。元数据（祖先链 + 递归后代）早就有了，
// 这次补的是**内容**：每个谱系会话的「任务 + 最近消息」。

/** 三层谱系的会话头：root → child-a → grand-a，root → child-b。 */
const TREE_HEADERS = {
  'session-root': { version: 1, id: 'session-root', createdAt: 1_700_010_000_000, cwd: 'E:\\work', isSeeded: false, agentPreset: 'standard' },
  'child-a': {
    version: 1,
    id: 'child-a',
    createdAt: 1_700_010_100_000,
    cwd: 'E:\\work',
    parentSession: 'session-root',
    origin: 'subagent',
    delegationDepth: 1,
    isSeeded: false,
    agentPreset: 'commander',
  },
  'grand-a': {
    version: 1,
    id: 'grand-a',
    createdAt: 1_700_010_200_000,
    cwd: 'E:\\work',
    parentSession: 'child-a',
    origin: 'subagent',
    delegationDepth: 2,
    isSeeded: false,
    agentPreset: 'cordis',
  },
  'child-b': {
    version: 1,
    id: 'child-b',
    createdAt: 1_700_010_300_000,
    cwd: 'E:\\work',
    parentSession: 'session-root',
    origin: 'subagent',
    delegationDepth: 1,
    isSeeded: false,
    agentPreset: 'commander',
  },
};

/** 每个会话的表层事件（任务 + 两三条消息）。 */
const TREE_SURFACES = {
  'session-root': [
    { seq: 1, type: 'user/message', time: 1_700_010_001_000, data: { content: [{ type: 'text', text: '把 rc.2 适配做完' }] } },
    { seq: 2, type: 'assistant/message', time: 1_700_010_002_000, data: { message: { content: [{ type: 'text', text: '我先拆成三条工作流' }] } } },
  ],
  'child-a': [
    { seq: 1, type: 'user/message', time: 1_700_010_101_000, data: { content: [{ type: 'text', text: '你是小组长，负责 devkit 适配' }] } },
    { seq: 2, type: 'assistant/message', time: 1_700_010_102_000, data: { message: { content: [{ type: 'text', text: '收到，我派一个子代理迁移测试' }] } } },
    { seq: 3, type: 'tool/result', time: 1_700_010_103_000, data: { message: { content: [{ type: 'text', text: '不该出现' }] } } },
    { seq: 4, type: 'assistant/message', time: 1_700_010_104_000, data: { message: { content: [{ type: 'text', text: '小组长收尾：三条都过了' }] } } },
  ],
  'grand-a': [
    { seq: 1, type: 'user/message', time: 1_700_010_201_000, data: { content: [{ type: 'text', text: '迁移 guard 测试到 6.0.0' }] } },
    { seq: 2, type: 'assistant/message', time: 1_700_010_202_000, data: { message: { content: [{ type: 'text', text: '迁移完成，34 条用例全绿' }] } } },
  ],
  'child-b': [
    { seq: 1, type: 'user/message', time: 1_700_010_301_000, data: { content: [{ type: 'text', text: '你是小组长，负责 commander 适配' }] } },
    { seq: 2, type: 'assistant/message', time: 1_700_010_302_000, data: { message: { content: [{ type: 'text', text: 'commander 7.0.0 已交付' }] } } },
  ],
};

/**
 * 照真实语义的假查询：`traceSession` 从静态谱系算出祖先与后代（父在前），
 * `readSurface` 按 id 返回预置事件，`readTitleSnapshots` 返回标题。
 *
 * @param {{ broken?: string[], extraChildren?: number, surfaces?: Record<string, any[]> }} [options] - 定制行为。
 * @returns {any} 假 `sessionQuery`。
 */
function treeQuery(options = {}) {
  const broken = new Set(options.broken ?? []);
  // 本地副本：`extraChildren` 只影响本用例，别污染模块级的 TREE_HEADERS
  // （否则上一个用例造出来的会话会出现在下一个用例的谱系里）。
  const headers = { ...TREE_HEADERS };
  const extraCount = options.extraChildren ?? 0;
  for (let index = 1; index <= extraCount; index += 1) {
    const id = `extra-${index}`;
    headers[id] = {
      version: 1,
      id,
      createdAt: 1_700_010_400_000 + index,
      cwd: 'E:\\work',
      parentSession: 'session-root',
      origin: 'subagent',
      delegationDepth: 1,
      isSeeded: false,
    };
  }
  const ids = Object.keys(headers);
  const recordOf = (id) => ({ header: headers[id], live: false, persisted: true });
  const childrenOf = (id) => ids.filter((candidate) => headers[candidate].parentSession === id);
  const ancestorsOf = (id) => {
    const chain = [];
    let current = headers[id];
    while (current?.parentSession !== undefined) {
      chain.push(current.parentSession);
      current = headers[current.parentSession];
    }
    return chain;
  };
  const nodeOf = (id) => ({
    session: recordOf(id),
    descendants: childrenOf(id).map(nodeOf),
  });

  return {
    async traceSession(id) {
      if (headers[id] === undefined) {
        const error = new Error(`session "${id}" not found`);
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
        throw error;
      }
      const ancestors = ancestorsOf(id).map(recordOf);
      return {
        target: recordOf(id),
        ancestors,
        descendants: childrenOf(id).map(nodeOf),
        complete: true,
        root: recordOf(ancestors.at(-1)?.header?.id ?? id),
      };
    },
    async readTitleSnapshots(requested) {
      return requested.map((id) => ({
        status: 'fulfilled',
        sessionId: id,
        value: {
          session: { id },
          title: { title: `${id} 的标题`, messageSeqs: [1], source: { kind: 'fallback' }, eventSeq: 1, updatedAt: 1_700_010_900_000 },
        },
      }));
    },
    async readSurface(id) {
      if (broken.has(id)) throw new Error(`stored session "${id}" is corrupt: SessionFormatError`);
      const events = options.surfaces?.[id] ?? TREE_SURFACES[id] ?? [];
      return { session: headers[id], inheritedEventCount: 0, capturedThroughSeq: events.length, events };
    },
    async listSessions() {
      return ids.map(recordOf);
    },
  };
}

test('nestedDigestOf：任务取第一条用户消息，消息只保留最近 N 条', () => {
  const digest = nestedDigestOf({ events: TREE_SURFACES['child-a'] }, 2);
  assert.equal(digest.task, '你是小组长，负责 devkit 适配');
  // tool/result 与注入上下文都不该出现，且只留最后 2 条。
  assert.deepEqual(digest.messages.map((message) => message.seq), [2, 4]);
  assert.equal(digest.messages.at(-1).text, '小组长收尾：三条都过了');

  const empty = nestedDigestOf({ events: [] }, 2);
  assert.deepEqual(empty, { task: '', messages: [] });
  assert.deepEqual(nestedDigestOf(undefined, 2), { task: '', messages: [] });
});

test('clampNestedMessageLimit 收口到 1..MAX，非法值回落默认', () => {
  assert.equal(clampNestedMessageLimit(undefined), DEFAULT_NESTED_MESSAGE_LIMIT);
  assert.equal(clampNestedMessageLimit(5), 5);
  assert.equal(clampNestedMessageLimit(0), 1);
  assert.equal(clampNestedMessageLimit(-3), 1);
  assert.equal(clampNestedMessageLimit(MAX_NESTED_MESSAGE_LIMIT + 99), MAX_NESTED_MESSAGE_LIMIT);
  assert.equal(clampNestedMessageLimit(Number.NaN), DEFAULT_NESTED_MESSAGE_LIMIT);
  assert.equal(clampNestedMessageLimit('3'), DEFAULT_NESTED_MESSAGE_LIMIT);
});

test('lookupSession：根会话默认读到子会话与孙会话的内容（任务 + 最近消息）', async () => {
  const value = await lookupSession({
    sessionQuery: treeQuery(),
    sessionId: 'session-root',
    currentId: '',
    includeMessages: true,
    messageLimit: 5,
  });

  assert.equal(value.ok, true);
  // 后代元数据仍是父在前、带深度。
  assert.deepEqual(
    value.subagents.map((node) => [node.id, node.depth, node.parentId]),
    [
      ['child-a', 1, ''],
      ['grand-a', 2, 'child-a'],
      ['child-b', 1, ''],
    ],
  );
  // 内容：两个子会话 + 一个孙会话，全是后代关系。
  assert.deepEqual(
    value.nested.map((node) => [node.id, node.relation, node.depth, node.parentId]),
    [
      ['child-a', 'descendant', 1, ''],
      ['grand-a', 'descendant', 2, 'child-a'],
      ['child-b', 'descendant', 1, ''],
    ],
  );
  const grand = value.nested.find((node) => node.id === 'grand-a');
  assert.equal(grand.title, 'grand-a 的标题');
  assert.equal(grand.task, '迁移 guard 测试到 6.0.0');
  assert.equal(grand.messages.at(-1).text, '迁移完成，34 条用例全绿');

  assert.equal(value.nestedTruncated, 0);
  assert.match(value.summary, /谱系内会话内容/);
  assert.match(value.summary, /迁移 guard 测试到 6\.0\.0/);
  assert.match(value.summary, /上级会话：`child-a`/);
  assert.deepEqual(validateValue(value, lookupTool().output.schema), []);
});

test('lookupSession：目标是子会话时，祖先链与祖先内容都读得到', async () => {
  const value = await lookupSession({
    sessionQuery: treeQuery(),
    sessionId: 'grand-a',
    currentId: '',
    includeMessages: true,
    messageLimit: 5,
  });

  assert.equal(value.ok, true);
  assert.equal(value.session.role, 'subagent');
  assert.equal(value.session.parentSessionId, 'child-a');
  assert.deepEqual(
    value.ancestors.map((node) => node.id),
    ['child-a', 'session-root'],
  );
  // 祖先也要有内容：谁派的它、上级当时在做什么。
  assert.deepEqual(
    value.nested.map((node) => [node.id, node.relation, node.depth]),
    [
      ['child-a', 'ancestor', 1],
      ['session-root', 'ancestor', 2],
    ],
  );
  const parent = value.nested[0];
  assert.equal(parent.task, '你是小组长，负责 devkit 适配');
  assert.equal(parent.parentId, 'session-root');
  assert.match(value.summary, /\[祖先 1\]/);
  assert.deepEqual(validateValue(value, lookupTool().output.schema), []);
});

test('lookupSession：includeNestedMessages=false 时只返回元数据（不读其他日志）', async () => {
  const read = [];
  const query = treeQuery();
  const original = query.readSurface.bind(query);
  query.readSurface = async (id, signal) => {
    read.push(id);
    return original(id, signal);
  };

  const value = await lookupSession({
    sessionQuery: query,
    sessionId: 'session-root',
    currentId: '',
    includeMessages: true,
    messageLimit: 5,
    includeNestedMessages: false,
  });

  assert.equal(value.ok, true);
  assert.deepEqual(value.nested, []);
  assert.deepEqual(read, ['session-root'], '关掉谱系内容后只该读目标会话');
  assert.equal(value.subagentCount, 3);
  assert.match(value.hint, /includeNestedMessages=true/);
  assert.deepEqual(validateValue(value, lookupTool().output.schema), []);
});

test('lookupSession：includeMessages=false 时不读谱系内容', async () => {
  const read = [];
  const query = treeQuery();
  const original = query.readSurface.bind(query);
  query.readSurface = async (id, signal) => {
    read.push(id);
    return original(id, signal);
  };

  const value = await lookupSession({
    sessionQuery: query,
    sessionId: 'session-root',
    currentId: '',
    includeMessages: false,
    messageLimit: 5,
  });

  assert.equal(value.ok, true);
  assert.deepEqual(value.nested, []);
  assert.deepEqual(read, []);
  assert.equal(value.subagentCount, 3);
});

test('lookupSession：谱系会话数超过上限时读 NESTED_SESSION_CAP 个并报出剩余数量', async () => {
  const extras = NESTED_SESSION_CAP + 3;
  const value = await lookupSession({
    sessionQuery: treeQuery({ extraChildren: extras }),
    sessionId: 'session-root',
    currentId: '',
    includeMessages: true,
    messageLimit: 3,
  });

  assert.equal(value.ok, true);
  assert.equal(value.nested.length, NESTED_SESSION_CAP);
  // 固定后代 3 个（child-a / grand-a / child-b）+ extras，减去单次上限即剩余。
  assert.equal(value.nestedTruncated, 3 + extras - NESTED_SESSION_CAP);
  assert.equal(value.nested.length + value.nestedTruncated, 3 + extras);
  assert.match(value.summary, /还有 \d+ 个谱系内会话没读/);
});

test('lookupSession：某个谱系会话读失败时，其余内容照常返回并显示原始错误', async () => {
  const value = await lookupSession({
    sessionQuery: treeQuery({ broken: ['child-b'] }),
    sessionId: 'session-root',
    currentId: '',
    includeMessages: true,
    messageLimit: 3,
  });

  assert.equal(value.ok, true);
  const brokenNode = value.nested.find((node) => node.id === 'child-b');
  assert.equal(brokenNode.task, '');
  assert.deepEqual(brokenNode.messages, []);
  assert.match(brokenNode.error, /corrupt/);
  // 其余会话不受影响。
  assert.equal(value.nested.find((node) => node.id === 'grand-a').task, '迁移 guard 测试到 6.0.0');
  assert.match(value.summary, /读取失败/);
  assert.deepEqual(validateValue(value, lookupTool().output.schema), []);
});
// #endregion
