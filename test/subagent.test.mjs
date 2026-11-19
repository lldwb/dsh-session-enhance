/**
 * 子智能体恢复（Host 半）的离线测试。
 *
 * 覆盖 `createSubagentHandler` 的三个端点语义：
 * - `list`：父会话里列 teammate + subagent child；子会话里判断父级是否在线；
 * - `resume`：父会话里逐个冷恢复、子会话里经父级恢复自己、各种失败码；
 * - `diag`：三条软依赖是否在场。
 *
 * 同时按 DSH 0.2.2-rc.5 的服务形状构造夹具：`subagents.listDescendants`
 * （旧的 `listChildren` 已从服务移除、rc.5 不存在），`agentTeams` 只剩任务板
 * （`listTasks`/`isEnabled`，没有 `listMembers`）。
 *
 * 不碰真实运行时：`agents` / `subagents` / `agentTeams` / `sessionQuery` 都是 mock。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSubagentHandler,
  listDirectChildren,
  SUBAGENT_CONTINUE_TEXT
} from '../lib/subagent/host.mjs';

/**
 * 造一个 mock 插件上下文。
 *
 * @param {object} [options] - mock 服务。
 * @param {Function} [options.agentGet] - agents.get。
 * @param {object} [options.subagents] - subagents 服务。
 * @param {object} [options.agentTeams] - agentTeams 服务。
 * @param {object} [options.sessionQuery] - sessionQuery 服务。
 * @returns {{ ctx: object, calls: object[] }} mock 环境。
 */
function makeCtx(options = {}) {
  const calls = [];
  const services = {
    agents: { get: options.agentGet ?? (() => undefined) },
    subagents: options.subagents,
    agentTeams: options.agentTeams,
    sessionQuery: options.sessionQuery
  };
  const ctx = {
    logger: { info: () => {}, debug: () => {} },
    ...services,
    get(name) {
      return services[name];
    },
    effect(factory) {
      factory();
      return () => {};
    }
  };
  return { ctx, calls };
}

/** 一个 lead/root agent。 */
const lead = { id: 'lead-1', session: { id: 'lead-1' } };

/** 子会话 header。 */
function childHeader(id, parent) {
  return { id, origin: 'subagent', parentSession: parent, isSeeded: false };
}

test('list：父会话里列出 teammate 与可继续 subagent child，并标记在线状态', async () => {
  const env = makeCtx({
    agentGet: (id) => (id === 'lead-1' ? lead : id === 'sub-live' ? { id: 'sub-live' } : undefined),
    agentTeams: {
      listMembers: () => [
        { id: 'lead-1', name: 'lead', role: 'lead', status: 'running' },
        { id: 'team-1', name: 'alice', role: 'teammate', status: 'inactive' },
        { id: 'team-2', name: 'bob', role: 'teammate', status: 'running' }
      ],
      sendMessage: () => {}
    },
    subagents: {
      listDescendants: async () => [
        { kind: 'child', id: 'sub-live', depth: 1, mode: 'continuable', label: 'live child' },
        { kind: 'child', id: 'sub-dead', depth: 1, mode: 'continuable', label: 'dead child' },
        { kind: 'child', id: 'one-shot', depth: 1, mode: 'one-shot' },
        { kind: 'child', id: 'grand-child', depth: 2, mode: 'continuable' }
      ],
      sendMessage: () => {}
    }
  });
  const result = await createSubagentHandler({ ctx: env.ctx })('list', { sessionId: 'lead-1' });
  assert.equal(result.ok, true);
  assert.equal(result.value.mode, 'parent');
  const rows = result.value.targets;
  assert.deepEqual(
    rows.map((row) => [row.kind, row.id, row.live, row.resumable]),
    [
      ['team', 'team-1', false, true],
      ['team', 'team-2', true, false],
      ['subagent', 'sub-live', true, false],
      ['subagent', 'sub-dead', false, true]
    ]
  );
  assert.equal(result.value.resumableCount, 2);
});

test('list：0.2.2-rc.2 服务形状（无 listChildren，只有 listDescendants）仍能列出直接子节点', async () => {
  // rc.2 的 `subagents` 只暴露 listDescendants：递归返回全部后代，每行带 depth 与
  // kind（'child' / 'diagnostic'）。直接子节点 = kind 'child' 且 depth 1。
  const env = makeCtx({
    agentGet: (id) => (id === 'lead-1' ? lead : id === 'sub-live' ? { id: 'sub-live' } : undefined),
    subagents: {
      listDescendants: async () => [
        { kind: 'child', id: 'sub-dead', depth: 1, mode: 'continuable', label: 'dead child', name: 'worker', activity: 'inactive' },
        { kind: 'child', id: 'sub-live', depth: 1, mode: 'continuable', label: 'live child', activity: 'running' },
        { kind: 'child', id: 'one-shot', depth: 1, mode: 'one-shot', label: 'one shot', activity: 'inactive' },
        { kind: 'child', id: 'grand-child', depth: 2, mode: 'continuable', label: 'grand child', activity: 'inactive' },
        { kind: 'diagnostic', id: 'broken', depth: 1, reason: 'unavailable' }
      ],
      sendMessage: () => {}
    }
  });
  const result = await createSubagentHandler({ ctx: env.ctx })('list', { sessionId: 'lead-1' });
  assert.equal(result.ok, true);
  assert.equal(result.value.mode, 'parent');
  const rows = result.value.targets;
  // 只保留 depth 1 的 continuable child：one-shot、depth 2、diagnostic 都排除。
  assert.deepEqual(
    rows.map((row) => [row.kind, row.id, row.name, row.live, row.resumable]),
    [
      ['subagent', 'sub-dead', 'worker', false, true],
      ['subagent', 'sub-live', '', true, false]
    ]
  );
  assert.equal(result.value.resumableCount, 1);
});

test('list：rc.2 形状下不再把 teammate 单列（Team 只剩任务板，teammate 就是 subagent）', async () => {
  const env = makeCtx({
    agentGet: (id) => (id === 'lead-1' ? lead : undefined),
    // rc.2 的 agentTeams 只有任务板方法，没有 listMembers / sendMessage。
    agentTeams: { isEnabled: () => true, listTasks: () => [] },
    subagents: {
      listDescendants: async () => [
        { kind: 'child', id: 'worker-1', depth: 1, mode: 'continuable', label: 'worker 1', name: 'alice' }
      ],
      sendMessage: () => {}
    }
  });
  const result = await createSubagentHandler({ ctx: env.ctx })('list', { sessionId: 'lead-1' });
  assert.deepEqual(result.value.targets.map((row) => [row.kind, row.id, row.name]), [['subagent', 'worker-1', 'alice']]);
});

test('list：子会话且父级在线 → child 模式、自身可恢复', async () => {
  const env = makeCtx({
    agentGet: (id) => (id === 'parent-1' ? { id: 'parent-1' } : undefined),
    sessionQuery: { traceSession: async (id) => ({ target: { header: childHeader(id, 'parent-1') } }) }
  });
  const result = await createSubagentHandler({ ctx: env.ctx })('list', { sessionId: 'child-1' });
  assert.equal(result.value.mode, 'child');
  assert.equal(result.value.parentSessionId, 'parent-1');
  assert.equal(result.value.parentLive, true);
  assert.equal(result.value.resumableCount, 1);
  assert.equal(result.value.targets[0].kind, 'self');
});

test('list：子会话且父级离线 → 可恢复数为 0；根会话冷启动 → root-cold', async () => {
  const offline = makeCtx({
    agentGet: () => undefined,
    sessionQuery: { traceSession: async (id) => ({ target: { header: childHeader(id, 'parent-1') } }) }
  });
  assert.equal((await createSubagentHandler({ ctx: offline.ctx })('list', { sessionId: 'child-1' })).value.resumableCount, 0);

  const root = makeCtx({
    sessionQuery: { traceSession: async (id) => ({ target: { header: { id, isSeeded: false } } }) }
  });
  assert.equal((await createSubagentHandler({ ctx: root.ctx })('list', { sessionId: 'root-1' })).value.mode, 'root-cold');
});

test('resume：父会话里恢复全部离线目标（team 用名字、subagent 用 id），跳过在线目标', async () => {
  const sent = [];
  const env = makeCtx({
    agentGet: (id) => (id === 'lead-1' ? lead : id === 'sub-live' ? { id: 'sub-live' } : undefined),
    agentTeams: {
      listMembers: () => [
        { id: 'lead-1', name: 'lead', role: 'lead', status: 'running' },
        { id: 'team-1', name: 'alice', role: 'teammate', status: 'inactive' }
      ],
      sendMessage: async (caller, request) => {
        sent.push({ kind: 'team', caller: caller.id, target: request.target, text: request.content[0].text });
      }
    },
    subagents: {
      listDescendants: async () => [
        { kind: 'child', id: 'sub-live', depth: 1, mode: 'continuable' },
        { kind: 'child', id: 'sub-dead', depth: 1, mode: 'continuable' }
      ],
      sendMessage: async (sender, targetId, content) => {
        sent.push({ kind: 'subagent', sender: sender.id, target: targetId, text: content[0].text });
      }
    }
  });
  const result = await createSubagentHandler({ ctx: env.ctx })('resume', { sessionId: 'lead-1' });
  assert.equal(result.ok, true);
  const byTarget = Object.fromEntries(result.value.results.map((row) => [row.id, row]));
  assert.equal(byTarget['team-1'].ok, true);
  assert.equal(byTarget['sub-dead'].ok, true);
  assert.equal(byTarget['sub-live'].code, 'ALREADY_LIVE');
  assert.deepEqual(
    sent.map((item) => [item.kind, item.target]),
    [
      ['team', 'alice'],
      ['subagent', 'sub-dead']
    ]
  );
  assert.ok(sent.every((item) => item.text === SUBAGENT_CONTINUE_TEXT));
});

test('resume：rc.2 形状下恢复 depth-1 continuable child（按 session id 发 continuation）', async () => {
  const sent = [];
  const env = makeCtx({
    agentGet: (id) => (id === 'lead-1' ? lead : id === 'sub-live' ? { id: 'sub-live' } : undefined),
    subagents: {
      listDescendants: async () => [
        { kind: 'child', id: 'sub-dead', depth: 1, mode: 'continuable', label: 'dead child', name: 'worker' },
        { kind: 'child', id: 'sub-live', depth: 1, mode: 'continuable', label: 'live child' },
        { kind: 'child', id: 'grand-child', depth: 2, mode: 'continuable', label: 'grand child' }
      ],
      sendMessage: async (sender, targetId, content) => {
        sent.push({ sender: sender.id, targetId, text: content[0].text });
      }
    }
  });
  const result = await createSubagentHandler({ ctx: env.ctx })('resume', { sessionId: 'lead-1' });
  assert.equal(result.ok, true);
  // 只恢复离线的 depth-1 child；在线的 sub-live 跳过，depth 2 的孙节点不在直接子节点列表里。
  assert.deepEqual(sent.map((item) => item.targetId), ['sub-dead']);
  assert.ok(sent.every((item) => item.sender === 'lead-1' && item.text === SUBAGENT_CONTINUE_TEXT));
  const byTarget = Object.fromEntries(result.value.results.map((row) => [row.id, row]));
  assert.equal(byTarget['sub-live'].code, 'ALREADY_LIVE');
});

test('resume：rc.2 形状下子会话经父级恢复自己时 kind 为 subagent、名字取自 catalog', async () => {
  const sent = [];
  const env = makeCtx({
    agentGet: (id) => (id === 'parent-1' ? { id: 'parent-1' } : undefined),
    subagents: {
      listDescendants: async () => [
        { kind: 'child', id: 'child-1', depth: 1, mode: 'continuable', label: 'child', name: 'worker-a' }
      ],
      sendMessage: async (sender, targetId) => {
        sent.push({ sender: sender.id, targetId });
      }
    },
    sessionQuery: { traceSession: async (id) => ({ target: { header: childHeader(id, 'parent-1') } }) }
  });
  const result = await createSubagentHandler({ ctx: env.ctx })('resume', { sessionId: 'child-1' });
  assert.equal(result.value.mode, 'child');
  assert.equal(result.value.results[0].kind, 'subagent');
  assert.equal(result.value.results[0].name, 'worker-a');
  assert.deepEqual(sent, [{ sender: 'parent-1', targetId: 'child-1' }]);
});

test('resume：子会话里通过父会话恢复自己；父不在线时返回 PARENT_NOT_LIVE', async () => {
  const sent = [];
  const liveParent = makeCtx({
    agentGet: (id) => (id === 'parent-1' ? { id: 'parent-1' } : undefined),
    subagents: {
      listDescendants: async () => [],
      sendMessage: async (sender, targetId) => {
        sent.push({ sender: sender.id, targetId });
      }
    },
    sessionQuery: { traceSession: async (id) => ({ target: { header: childHeader(id, 'parent-1') } }) }
  });
  const okResult = await createSubagentHandler({ ctx: liveParent.ctx })('resume', { sessionId: 'child-1' });
  assert.equal(okResult.value.mode, 'child');
  assert.equal(okResult.value.results[0].ok, true);
  assert.deepEqual(sent, [{ sender: 'parent-1', targetId: 'child-1' }]);

  const deadParent = makeCtx({
    agentGet: () => undefined,
    sessionQuery: { traceSession: async (id) => ({ target: { header: childHeader(id, 'parent-1') } }) }
  });
  const failed = await createSubagentHandler({ ctx: deadParent.ctx })('resume', { sessionId: 'child-1' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'PARENT_NOT_LIVE');
});

test('resume：targets 可以按 id/名字过滤；未知目标不误发消息', async () => {
  const sent = [];
  const env = makeCtx({
    agentGet: (id) => (id === 'lead-1' ? lead : undefined),
    subagents: {
      listDescendants: async () => [{ kind: 'child', id: 'sub-a', depth: 1, mode: 'continuable' }],
      sendMessage: async (_sender, targetId) => {
        sent.push(targetId);
      }
    }
  });
  const result = await createSubagentHandler({ ctx: env.ctx })('resume', {
    sessionId: 'lead-1',
    targets: ['nope']
  });
  assert.equal(result.value.results.length, 0);
  assert.deepEqual(sent, []);
});

test('diag：报告 subagents / agentTeams / sessionQuery 是否在场（rc.5 形状；旧 listChildren 不再被识别）', async () => {
  // 旧 0.2.2-rc.1 形状（只有 listChildren）在 rc.5 已不被识别：subagents.listChildren
  // 已从服务移除，不再探测/回退 —— subagentListing 报 none（不猜测能力）。
  const legacy = makeCtx({
    subagents: { listChildren: async () => [], sendMessage: async () => {} },
    agentTeams: { listMembers: () => [], sendMessage: async () => {} },
    sessionQuery: { traceSession: async () => ({}) }
  });
  assert.deepEqual((await createSubagentHandler({ ctx: legacy.ctx })('diag', {})).value, {
    hasSubagents: false,
    hasAgentTeams: true,
    hasSessionQuery: true,
    subagentListing: 'none'
  });

  // rc.5 形状（自 rc.2 起）：listChildren 移除，只剩 listDescendants；Team 只剩任务板。
  const rc2 = makeCtx({
    subagents: { listDescendants: async () => [], sendMessage: async () => {} },
    agentTeams: { isEnabled: () => false, listTasks: () => [] },
    sessionQuery: { traceSession: async () => ({}) }
  });
  assert.deepEqual((await createSubagentHandler({ ctx: rc2.ctx })('diag', {})).value, {
    hasSubagents: true,
    hasAgentTeams: false,
    hasSessionQuery: true,
    subagentListing: 'listDescendants'
  });

  const bare = makeCtx({});
  assert.deepEqual((await createSubagentHandler({ ctx: bare.ctx })('diag', {})).value, {
    hasSubagents: false,
    hasAgentTeams: false,
    hasSessionQuery: false,
    subagentListing: 'none'
  });
});

test('listDirectChildren：只走 rc.5 的 listDescendants（kind=child & depth=1）；无该 API 时返回 []、不再探测 listChildren', async () => {
  const rows = await listDirectChildren(
    {
      listDescendants: async () => [
        { kind: 'child', id: 'a', depth: 1, mode: 'continuable' },
        { kind: 'child', id: 'b', depth: 2, mode: 'continuable' },
        { kind: 'diagnostic', id: 'c', depth: 1, reason: 'corrupt' }
      ],
      // rc.5 的服务没有该 API：万一代码回退到它，这里会抛错，测试立刻失败。
      listChildren: async () => {
        throw new Error('rc.5 must not call listChildren');
      }
    },
    'parent'
  );
  assert.deepEqual(rows.map((row) => row.id), ['a']);

  // 只有旧 API 的服务：rc.5 上 listChildren 不存在，必须返回 []，且一次都不该调用它。
  let legacyCalls = 0;
  const legacyRows = await listDirectChildren(
    {
      listChildren: async () => {
        legacyCalls += 1;
        return [{ id: 'x', mode: 'continuable' }];
      }
    },
    'parent'
  );
  assert.deepEqual(legacyRows, []);
  assert.equal(legacyCalls, 0, 'rc.5 不应再探测 subagents.listChildren');

  assert.deepEqual(await listDirectChildren(undefined, 'parent'), []);
  assert.deepEqual(await listDirectChildren({}, 'parent'), []);
});

test('恢复文案稳定', () => {
  assert.ok(SUBAGENT_CONTINUE_TEXT.includes('继续'));
});
