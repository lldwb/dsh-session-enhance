/**
 * 「中断重试」Host 侧：事件判定与「官方 continuation 优先、提示词兜底」的驱动。
 *
 * 全部用 mock（不碰真实 Cordis / Agent），钉住关键契约：
 * 1. 只有 `aborted + reason.kind === 'user'` 才算用户中断；
 * 2. 驱动顺序：官方 `sessionController.prompt({ … mode:'queue', content: [] })` 优先；
 *    官方不可用 → 回退 `agent.followup`，且 followup 消息带全 `id` / `role` / `content`
 *    / `source`（source 是 user）；
 * 3. 只有两条都失败才返回错误。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RETRY_CONTINUE_TEXT,
  RETRY_MESSAGE_ID_PREFIX,
  createDriveRetry,
  isAppInterruption,
  scanUnfinishedTurns,
  pendingTurnOf,
  createRetryUserMessage,
  handleSessionEvent,
  isUserInterruption,
  sessionIdOf,
} from '../../lib/retry/host.mjs';
import { RecoveryStore } from '../../lib/retry/recovery.mjs';

/**
 * 造一条会话事件。
 *
 * @param {string} type - 事件类型。
 * @param {object} [data] - 事件数据。
 * @returns {{ type: string, data: object }} mock 事件。
 */
function event(type, data = {}) {
  return { type, data };
}

test('isUserInterruption：只有 aborted + user 才算', () => {
  assert.equal(isUserInterruption({ kind: 'aborted', reason: { kind: 'user' } }), true);
  assert.equal(isUserInterruption({ kind: 'aborted', reason: { kind: 'parent' } }), false);
  assert.equal(isUserInterruption({ kind: 'aborted', reason: { kind: 'hook', reason: 'x' } }), false);
  assert.equal(isUserInterruption({ kind: 'aborted', reason: { kind: 'disposed' } }), false);
  assert.equal(isUserInterruption({ kind: 'aborted', reason: { kind: 'legacy' } }), false);
  assert.equal(isUserInterruption({ kind: 'error', error: { code: 'TIMEOUT' } }), false);
  assert.equal(isUserInterruption({ kind: 'completed' }), false);
  assert.equal(isUserInterruption(undefined), false);
});

test('sessionIdOf：id 与 sessionId 两种形状', () => {
  assert.equal(sessionIdOf({ id: 's1' }), 's1');
  assert.equal(sessionIdOf({ sessionId: 's2' }), 's2');
  assert.equal(sessionIdOf({}), '');
  assert.equal(sessionIdOf(undefined), '');
});

test('handleSessionEvent：用户中断记录一条（带 turn / cause=user）', () => {
  const recovery = new RecoveryStore();
  handleSessionEvent(recovery, { id: 's1' }, event('turn/end', { turn: 7, reason: { kind: 'aborted', reason: { kind: 'user' } } }));
  const snapshot = recovery.peek('s1');
  assert.equal(snapshot.sessionId, 's1');
  assert.equal(snapshot.turn, 7);
  assert.equal(snapshot.cause, 'user');
  assert.ok(snapshot.ageMs >= 0, 'ageMs 是相对时间，不钉死具体值');
});

test('handleSessionEvent：应用退出（aborted + disposed）也记录，cause=app', () => {
  const recovery = new RecoveryStore();
  handleSessionEvent(
    recovery,
    { id: 's1' },
    event('turn/end', { turn: 8, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }),
  );
  const snapshot = recovery.peek('s1');
  assert.equal(snapshot?.turn, 8, '应用被关闭的那一轮同样可重试');
  assert.equal(snapshot?.cause, 'app');
});

test('handleSessionEvent：parent/hook 取消、error、completed 不记录，并清掉旧记录', () => {
  const cases = [
    { kind: 'aborted', reason: { kind: 'parent' } },
    { kind: 'aborted', reason: { kind: 'hook', reason: 'shutdown' } },
    { kind: 'error', error: { code: 'TIMEOUT' } },
    { kind: 'completed' },
  ];
  for (const reason of cases) {
    const recovery = new RecoveryStore();
    recovery.remember('s1', { turn: 1 });
    handleSessionEvent(recovery, { id: 's1' }, event('turn/end', { turn: 2, reason }));
    assert.equal(recovery.peek('s1'), undefined, `reason=${JSON.stringify(reason)} 不该保留记录`);
  }
});

test('handleSessionEvent：turn/start 与 append 的用户消息都会作废记录', () => {
  const recovery = new RecoveryStore();
  recovery.remember('s1', { turn: 1 });
  handleSessionEvent(recovery, { id: 's1' }, event('turn/start', { turn: 2 }));
  assert.equal(recovery.peek('s1'), undefined);

  recovery.remember('s1', { turn: 2 });
  handleSessionEvent(recovery, { id: 's1' }, event('user/message', {
    source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }],
  }));
  assert.equal(recovery.peek('s1'), undefined);
});

test('handleSessionEvent：取不到 sessionId 时忽略', () => {
  const recovery = new RecoveryStore();
  handleSessionEvent(recovery, {}, event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }));
  assert.equal(recovery.size, 0);
});

test('createRetryUserMessage：形状完整（0.2.2 的 followup 契约）', () => {
  const message = createRetryUserMessage();
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.startsWith(RETRY_MESSAGE_ID_PREFIX));
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: RETRY_CONTINUE_TEXT }]);
  assert.deepEqual(message.source, { kind: 'user' });
  assert.ok(RETRY_CONTINUE_TEXT.includes('应用被关闭'), '提示词要覆盖「应用被关闭」这种中断');
  assert.ok(RETRY_CONTINUE_TEXT.includes('中断'), '也要覆盖被停止/其它中断');
  assert.notEqual(createRetryUserMessage().id, message.id, '每次 id 唯一');
});

test('createDriveRetry：官方 continuation 成功 → 不 followup，返回 method=official', async () => {
  const prompts = [];
  const followups = [];
  const agent = { followup: async (message) => { followups.push(message); } };
  const ctx = {
    get: (key) => {
      if (key === 'agents') return { get: () => agent };
      if (key === 'sessionController') {
        return {
          prompt: async (request, signal) => {
            prompts.push({ request, signal });
            return { accepted: true };
          },
        };
      }
      return undefined;
    },
  };

  const outcome = await createDriveRetry(ctx)('s1');
  assert.deepEqual(outcome, { ok: true, method: 'official' });
  assert.equal(prompts.length, 1, '应优先走官方 continuation');
  assert.deepEqual(followups, [], '官方成功就不该再发兜底提示词');

  // 官方 SessionPromptRequest 形状：sessionId / requestId（uuid）/ mode / 空 content，
  // 且第二个参数是调用方取消用的 AbortSignal（官方实现会调用 signal.throwIfAborted()）。
  const { request, signal } = prompts[0];
  assert.equal(request.sessionId, 's1');
  assert.equal(typeof request.requestId, 'string');
  assert.match(request.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  assert.equal(request.mode, 'queue');
  assert.deepEqual(request.content, [], '空 content = 官方「继续生成」语义');
  assert.ok(signal instanceof AbortSignal, '必须传 AbortSignal');
});

test('createDriveRetry：官方抛错（session/agent-busy 等）→ 回退 followup，返回 method=prompt', async () => {
  const captured = [];
  const prompts = [];
  const agent = { followup: async (message) => { captured.push(message); } };
  const ctx = {
    get: (key) => {
      if (key === 'agents') return { get: () => agent };
      if (key === 'sessionController') {
        return {
          prompt: async (request) => {
            prompts.push(request);
            // 官方对「inbox 已有排队输入 / 不是可继续的失败轮」回的就是这个码。
            throw Object.assign(new Error('generation continuation is unavailable'), { code: 'session/agent-busy' });
          },
        };
      }
      return undefined;
    },
  };

  const outcome = await createDriveRetry(ctx)('s1');
  assert.deepEqual(outcome, { ok: true, method: 'prompt' });
  assert.equal(prompts.length, 1, '应确实试过官方');
  assert.equal(captured.length, 1, '官方失败后必须回退提示词');
  assert.equal(captured[0].content[0].text, RETRY_CONTINUE_TEXT);
});

test('createDriveRetry：没有 sessionController → 直接 followup（method=prompt）', async () => {
  const captured = [];
  const agent = { followup: async (message) => { captured.push(message); } };
  const ctx = { get: (key) => (key === 'agents' ? { get: () => agent } : undefined) };
  const outcome = await createDriveRetry(ctx)('s1');
  assert.deepEqual(outcome, { ok: true, method: 'prompt' });
  assert.equal(captured.length, 1);
});

test('createDriveRetry：官方同步抛错（prompt 不是函数 / 坏服务）也不影响兜底', async () => {
  const captured = [];
  const agent = { followup: async (message) => { captured.push(message); } };
  const ctx = {
    get: (key) => {
      if (key === 'agents') return { get: () => agent };
      if (key === 'sessionController') return { prompt: 'not-a-function' };
      return undefined;
    },
  };
  const outcome = await createDriveRetry(ctx)('s1');
  assert.deepEqual(outcome, { ok: true, method: 'prompt' });
  assert.equal(captured.length, 1);
});

test('createDriveRetry：调用 agent.followup 并把消息原样交给它（无官方服务路径）', async () => {
  const captured = [];
  const agent = { followup: async (message) => { captured.push(message); } };
  const ctx = { get: (key) => (key === 'agents' ? { get: (id) => (id === 's1' ? agent : undefined) } : undefined) };
  const outcome = await createDriveRetry(ctx)('s1');
  assert.deepEqual(outcome, { ok: true, method: 'prompt' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].role, 'user');
  assert.equal(captured[0].content[0].text, RETRY_CONTINUE_TEXT);
});

test('createDriveRetry：无 live agent / 无 followup / followup 抛错都给结构化错误（含 method=null）', async () => {
  const noAgent = await createDriveRetry({ get: () => ({ get: () => undefined }) })('s1');
  assert.equal(noAgent.ok, false);
  assert.equal(noAgent.code, 'NO_LIVE_AGENT');
  assert.equal(noAgent.method, null);
  assert.equal(noAgent.reason, 'no-live-agent');

  const noFollowup = await createDriveRetry({ agents: { get: () => ({}) } })('s1');
  assert.equal(noFollowup.ok, false);
  assert.equal(noFollowup.code, 'NO_FOLLOWUP');
  assert.equal(noFollowup.method, null);
  assert.equal(noFollowup.reason, 'followup-unavailable');

  const failing = await createDriveRetry({
    get: () => ({ get: () => ({ followup: async () => { throw new Error('boom'); } }) }),
  })('s1');
  assert.equal(failing.ok, false);
  assert.equal(failing.code, 'FOLLOWUP_FAILED');
  assert.equal(failing.method, null);
  assert.equal(failing.reason, 'followup-failed');
  assert.match(failing.message, /boom/);
});

test('createDriveRetry：官方与兜底都失败 → 返回 FOLLOWUP_FAILED（不是"部分成功"）', async () => {
  const ctx = {
    get: (key) => {
      if (key === 'agents') return { get: () => ({ followup: async () => { throw new Error('agent gone'); } }) };
      if (key === 'sessionController') return { prompt: async () => { throw new Error('no continuation'); } };
      return undefined;
    },
  };
  const outcome = await createDriveRetry(ctx)('s1');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'FOLLOWUP_FAILED');
  assert.equal(outcome.method, null);
  assert.match(outcome.message, /agent gone/);
});

test('isAppInterruption：disposed 与 interrupted 都算应用中断', () => {
  assert.equal(isAppInterruption({ kind: 'aborted', reason: { kind: 'disposed' } }), true, '优雅退出');
  assert.equal(isAppInterruption({ kind: 'interrupted' }), true, '强杀后 DSH 重放补写的 interrupted');
  assert.equal(isAppInterruption({ kind: 'aborted', reason: { kind: 'user' } }), false);
  assert.equal(isAppInterruption({ kind: 'aborted', reason: { kind: 'parent' } }), false);
  assert.equal(isAppInterruption({ kind: 'completed' }), false);
  assert.equal(isAppInterruption(undefined), false);
});

test('pendingTurnOf：未闭合回合与 interrupted 结束都算应用中断', () => {
  const closed = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  ];
  assert.equal(pendingTurnOf(closed), undefined, '正常闭合');

  const open = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2 } }
  ];
  assert.deepEqual(pendingTurnOf(open), { turn: 2, cause: 'app' }, '第 2 轮没闭合');

  assert.deepEqual(
    pendingTurnOf([
      { type: 'turn/start', data: { turn: 3 } },
      { type: 'turn/start', data: { turn: 5 } },
      { type: 'user/message', data: {} }
    ]),
    { turn: 5, cause: 'app' },
    '多个未闭合取最后那个'
  );

  // 进程被强杀后重启，DSH 会补写 turn/end { reason: { kind: 'interrupted' } }（实测形态）。
  assert.deepEqual(
    pendingTurnOf([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } }
    ]),
    { turn: 1, cause: 'app' },
    'interrupted 结束同样可重试'
  );

  // 正常完成不算。
  assert.equal(
    pendingTurnOf([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
    ]),
    undefined
  );
  assert.equal(pendingTurnOf(undefined), undefined);
});

test('scanUnfinishedTurns：重建「应用关闭/重启前没做完」的会话记录', async () => {
  const recovery = new RecoveryStore();
  const now = Date.UTC(2026, 10, 27, 4, 0, 0);
  const sessions = [
    { id: 's-open', updatedAt: now - 60_000, events: [{ type: 'turn/start', data: { turn: 4 } }] },
    {
      id: 's-closed',
      updatedAt: now - 120_000,
      events: [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
      ]
    },
    {
      id: 's-old',
      updatedAt: now - 10 * 24 * 60 * 60 * 1000,
      events: [{ type: 'turn/start', data: { turn: 9 } }]
    }
  ];
  const sessionQuery = {
    listSessions: async () => sessions.map((s) => ({ header: { id: s.id, updatedAt: s.updatedAt } })),
    readSession: async (id) => {
      const found = sessions.find((s) => s.id === id);
      if (found === undefined) throw new Error('missing');
      return { events: found.events };
    }
  };
  const result = await scanUnfinishedTurns({ sessionQuery, recovery, now });
  assert.deepEqual(result.seeded.map((s) => s.sessionId), ['s-open'], '只补记最近且未闭合的会话');
  assert.equal(result.scanned, 2, '时间窗外的会话不读日志');
  const snapshot = recovery.peek('s-open');
  assert.equal(snapshot?.cause, 'app', '启动扫描的来源是应用中断');
  assert.equal(snapshot?.turn, 4);
  assert.equal(recovery.peek('s-closed'), undefined);
  assert.equal(recovery.peek('s-old'), undefined);
});

test('scanUnfinishedTurns：缺服务/读日志抛错/已有记录都不炸', async () => {
  const recovery = new RecoveryStore();
  assert.deepEqual(await scanUnfinishedTurns({ recovery }), { scanned: 0, seeded: [] });
  assert.deepEqual(await scanUnfinishedTurns({ sessionQuery: {}, recovery }), { scanned: 0, seeded: [] });

  const sessionQuery = {
    listSessions: async () => [
      { header: { id: 'broken', updatedAt: Date.now() } },
      { header: { id: 'ok', updatedAt: Date.now() } }
    ],
    readSession: async (id) => {
      if (id === 'broken') throw new Error('corrupt');
      return { events: [{ type: 'turn/start', data: { turn: 2 } }] };
    }
  };
  const result = await scanUnfinishedTurns({ sessionQuery, recovery, now: Date.now() });
  assert.deepEqual(result.seeded.map((s) => s.sessionId), ['ok'], '坏日志跳过，其它照常');

  recovery.remember('ok', { turn: 2, cause: 'user' });
  await scanUnfinishedTurns({ sessionQuery, recovery, now: Date.now() });
  assert.equal(recovery.peek('ok')?.cause, 'user', '已有记录不被扫描覆盖');
});
