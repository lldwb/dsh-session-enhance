/**
 * 「中断重试」组件的可重试记录（纯状态）。
 *
 * 覆盖：快照字段、TTL 过期、take/forget/clear。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_RECOVERY_TTL_MS, RecoveryStore } from '../../lib/retry/recovery.mjs';

test('默认 TTL 是 30 分钟', () => {
  assert.equal(DEFAULT_RECOVERY_TTL_MS, 30 * 60 * 1000);
  assert.equal(new RecoveryStore().ttlMs, DEFAULT_RECOVERY_TTL_MS);
});

test('remember / peek：返回 sessionId、turn 与 ageMs', () => {
  let now = 1_000;
  const store = new RecoveryStore({ now: () => now });
  store.remember('s1', { turn: 3 });

  now = 1_500;
  const snapshot = store.peek('s1');
  assert.deepEqual(snapshot, { sessionId: 's1', turn: 3, ageMs: 500 });
  assert.equal(store.size, 1);
});

test('TTL 过期：peek 返回 undefined 并清掉记录', () => {
  let now = 1_000;
  const store = new RecoveryStore({ ttlMs: 100, now: () => now });
  store.remember('s1', { turn: 1 });

  now = 1_100;
  assert.ok(store.peek('s1') !== undefined, '边界值（恰好等于 TTL）仍有效');

  now = 1_101;
  assert.equal(store.peek('s1'), undefined);
  assert.equal(store.size, 0);
});

test('take：取出并清掉记录（只能用一次）', () => {
  const store = new RecoveryStore();
  store.remember('s1', { turn: 2 });

  const taken = store.take('s1');
  assert.equal(taken.sessionId, 's1');
  assert.equal(taken.turn, 2);
  assert.equal(store.peek('s1'), undefined);
  assert.equal(store.take('s1'), undefined);
});

test('forget / clear / size', () => {
  const store = new RecoveryStore();
  store.remember('s1', { turn: 1 });
  store.remember('s2', { turn: 1 });
  assert.equal(store.size, 2);

  store.forget('s1');
  assert.equal(store.size, 1);
  assert.equal(store.peek('s1'), undefined);

  store.clear();
  assert.equal(store.size, 0);
  assert.equal(store.peek('s2'), undefined);
});
