/**
 * 「中断重试」Host 侧：事件判定与 followup 驱动。
 *
 * 全部用 mock（不碰真实 Cordis / Agent），钉住两个关键契约：
 * 1. 只有 `aborted + reason.kind === 'user'` 才算用户中断；
 * 2. followup 消息必须带全 `id` / `role` / `content` / `source`，且 source 是 user。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RETRY_CONTINUE_TEXT,
  RETRY_MESSAGE_ID_PREFIX,
  createDriveRetry,
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

test('handleSessionEvent：用户中断记录一条（带 turn）', () => {
  const recovery = new RecoveryStore();
  handleSessionEvent(recovery, { id: 's1' }, event('turn/end', { turn: 7, reason: { kind: 'aborted', reason: { kind: 'user' } } }));
  const snapshot = recovery.peek('s1');
  assert.equal(snapshot.sessionId, 's1');
  assert.equal(snapshot.turn, 7);
  assert.ok(snapshot.ageMs >= 0, 'ageMs 是相对时间，不钉死具体值');
});

test('handleSessionEvent：非用户原因的 aborted / error / completed 不记录，并清掉旧记录', () => {
  const cases = [
    { kind: 'aborted', reason: { kind: 'parent' } },
    { kind: 'aborted', reason: { kind: 'hook', reason: 'shutdown' } },
    { kind: 'aborted', reason: { kind: 'disposed' } },
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
  assert.ok(RETRY_CONTINUE_TEXT.includes('中断'));
  assert.notEqual(createRetryUserMessage().id, message.id, '每次 id 唯一');
});

test('createDriveRetry：调用 agent.followup 并把消息原样交给它', async () => {
  const captured = [];
  const agent = { followup: async (message) => { captured.push(message); } };
  const ctx = { get: (key) => (key === 'agents' ? { get: (id) => (id === 's1' ? agent : undefined) } : undefined) };
  const outcome = await createDriveRetry(ctx)('s1');
  assert.deepEqual(outcome, { ok: true });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].role, 'user');
  assert.equal(captured[0].content[0].text, RETRY_CONTINUE_TEXT);
});

test('createDriveRetry：无 live agent / 无 followup / followup 抛错都给结构化错误', async () => {
  const noAgent = await createDriveRetry({ get: () => ({ get: () => undefined }) })('s1');
  assert.equal(noAgent.ok, false);
  assert.equal(noAgent.code, 'NO_LIVE_AGENT');

  const noFollowup = await createDriveRetry({ agents: { get: () => ({}) } })('s1');
  assert.equal(noFollowup.ok, false);
  assert.equal(noFollowup.code, 'NO_FOLLOWUP');

  const failing = await createDriveRetry({
    get: () => ({ get: () => ({ followup: async () => { throw new Error('boom'); } }) }),
  })('s1');
  assert.equal(failing.ok, false);
  assert.equal(failing.code, 'FOLLOWUP_FAILED');
  assert.match(failing.message, /boom/);
});
