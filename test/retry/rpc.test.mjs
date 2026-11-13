/**
 * 「中断重试」RPC 端点（与 HTTP 解耦的纯 handler）。
 *
 * 覆盖 pending / retry / diag 的信封与错误码；不测真实 HTTP 挂载（沙箱回归覆盖）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_RPC_BODY_BYTES, RETRY_RPC_CHANNEL, createRetryHandler } from '../../lib/retry/rpc.mjs';
import { RecoveryStore } from '../../lib/retry/recovery.mjs';

test('通道与请求体上限常量', () => {
  assert.equal(RETRY_RPC_CHANNEL, '/dsh-session-enhance-retry');
  assert.equal(MAX_RPC_BODY_BYTES, 32 * 1024);
});

test('pending：缺 sessionId → BAD_REQUEST；无记录 → recoverable null；有记录 → 快照', async () => {
  const recovery = new RecoveryStore();
  const handler = createRetryHandler({ recovery });

  const bad = await handler('pending', {});
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'BAD_REQUEST');
  assert.deepEqual(bad.error.details, {});

  const empty = await handler('pending', { sessionId: 's1' });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.value, { pending: false, recoverable: null });

  recovery.remember('s1', { turn: 4 });
  const hit = await handler('pending', { sessionId: 's1' });
  assert.equal(hit.ok, true);
  assert.equal(hit.value.pending, true, '有记录时 pending 必须为 true');
  assert.equal(hit.value.recoverable.sessionId, 's1');
  assert.equal(hit.value.recoverable.turn, 4);
});

test('retry：缺 sessionId → BAD_REQUEST；无记录 → NOT_AVAILABLE 且不驱动', async () => {
  const driven = [];
  const handler = createRetryHandler({
    recovery: new RecoveryStore(),
    driveRetry: async (sessionId) => { driven.push(sessionId); return { ok: true }; },
  });

  const bad = await handler('retry', {});
  assert.equal(bad.error.code, 'BAD_REQUEST');

  const missing = await handler('retry', { sessionId: 's1' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'NOT_AVAILABLE');
  assert.deepEqual(driven, []);
});

test('retry：有记录 → 取走记录并驱动一次新一轮', async () => {
  const recovery = new RecoveryStore();
  recovery.remember('s1', { turn: 2 });
  const driven = [];
  const handler = createRetryHandler({
    recovery,
    driveRetry: async (sessionId) => { driven.push(sessionId); return { ok: true }; },
  });

  const result = await handler('retry', { sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { retried: true, via: 'followup' });
  assert.deepEqual(driven, ['s1']);
  assert.equal(recovery.peek('s1'), undefined, '用过即作废');
});

test('retry：驱动失败透传错误码；无 driveRetry → NOT_AVAILABLE', async () => {
  const recovery = new RecoveryStore();
  recovery.remember('s1', { turn: 2 });
  const failing = createRetryHandler({
    recovery,
    driveRetry: async () => ({ ok: false, code: 'NO_LIVE_AGENT', message: 'no agent' }),
  });
  const result = await failing('retry', { sessionId: 's1' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NO_LIVE_AGENT');

  const noDrive = createRetryHandler({ recovery: new RecoveryStore() });
  const noRecord = await noDrive('retry', { sessionId: 's9' });
  assert.equal(noRecord.error.code, 'NOT_AVAILABLE');
});

test('diag：返回 probe、可重试快照与 TTL', async () => {
  const recovery = new RecoveryStore({ ttlMs: 5_000 });
  recovery.remember('s1', { turn: 1 });
  const handler = createRetryHandler({ recovery, probe: () => ({ hasAgents: true }) });

  const result = await handler('diag', { sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.probe, { hasAgents: true });
  assert.equal(result.value.recoverable.sessionId, 's1');
  assert.equal(result.value.ttlMs, 5_000);
  assert.equal(result.value.storeSize, 1);

  const noSession = await handler('diag', {});
  assert.equal(noSession.value.recoverable, null);
});

test('未知端点 → UNKNOWN_METHOD', async () => {
  const handler = createRetryHandler({ recovery: new RecoveryStore() });
  const result = await handler('nope', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNKNOWN_METHOD');
});
