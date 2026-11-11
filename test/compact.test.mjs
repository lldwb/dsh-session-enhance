/**
 * 分级压缩的离线测试：纯决策逻辑 + Host 驱动器（mock ctx，不碰真实 DSH 运行时）。
 *
 * @module dsh-session-enhance/test/compact
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_COMPACT_RATIO,
  DEFAULT_MAX_OVERFLOW_RETRIES,
  DEFAULT_PRUNE_RATIO,
  TIER,
  effectiveWindow,
  formatRatio,
  normalizeRatio,
  resolveTier
} from '../lib/compact/tiers.mjs';
import { createCompactionDriver } from '../lib/compact/host.mjs';
import { readOption } from '../lib/compact/options.mjs';

/** 构造一个 agent（带 preset 服务解析所需的 ctx）。 */
function makeAgent(options = {}) {
  const generation = options.generation ?? 1;
  return {
    session: {
      id: 's1',
      requestContext: () => ({ contextWindow: options.contextWindow ?? 1_000 }),
      requestHeader: () => ({ config: { maxTokens: options.maxTokens ?? 0 } }),
      surface: { replaceGeneration: generation }
    },
    ctx: { get: () => undefined }
  };
}

/** 构造 mock 插件上下文。 */
function makeCtx(services = {}) {
  const events = [];
  const cleanups = [];
  return {
    get: (name) => services[name],
    on: (name, handler, options) => {
      events.push({ name, handler, options });
      return () => {
        const index = events.findIndex((entry) => entry.handler === handler);
        if (index >= 0) events.splice(index, 1);
      };
    },
    effect: (factory) => {
      const dispose = factory();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return () => {};
    },
    logger: { info() {}, warn() {}, debug() {} },
    collected: { events, cleanups }
  };
}

test('tiers：normalizeRatio 只接受 (0,1]', () => {
  assert.equal(normalizeRatio(0.5, 0.8), 0.5);
  assert.equal(normalizeRatio(1, 0.8), 1);
  assert.equal(normalizeRatio(0, 0.8), 0.8);
  assert.equal(normalizeRatio(-1, 0.8), 0.8);
  assert.equal(normalizeRatio(2, 0.8), 0.8);
  assert.equal(normalizeRatio('0.5', 0.8), 0.8);
  assert.equal(normalizeRatio(undefined, 0.8), 0.8);
});

test('tiers：effectiveWindow = 窗口 − 输出预留', () => {
  assert.equal(effectiveWindow({ contextWindow: 1_000, maxTokens: 200 }), 800);
  assert.equal(effectiveWindow({ contextWindow: 1_000 }), 1_000);
  assert.equal(effectiveWindow({ contextWindow: 100, maxTokens: 500 }), 1);
  assert.equal(effectiveWindow({}), undefined);
  assert.equal(effectiveWindow({ contextWindow: 0 }), undefined);
});

test('tiers：resolveTier 在两级阈值处切换', () => {
  const base = { contextWindow: 1_000, maxTokens: 0 };
  assert.equal(resolveTier({ ...base, totalTokens: 599 }).tier, TIER.NONE);
  assert.equal(resolveTier({ ...base, totalTokens: 600 }).tier, TIER.PRUNE);
  assert.equal(resolveTier({ ...base, totalTokens: 799 }).tier, TIER.PRUNE);
  assert.equal(resolveTier({ ...base, totalTokens: 800 }).tier, TIER.COMPACT);
  assert.equal(resolveTier({ ...base, totalTokens: 1_000 }).tier, TIER.COMPACT);
});

test('tiers：窗口/用量缺失时返回 none', () => {
  assert.equal(resolveTier({ totalTokens: 900 }).tier, TIER.NONE);
  assert.equal(resolveTier({ contextWindow: 1_000 }).tier, TIER.NONE);
  assert.equal(resolveTier({ totalTokens: 900, contextWindow: 1_000 }).ratio, 0.9);
  assert.equal(formatRatio(0.624), '62.4%');
  assert.equal(formatRatio(undefined), '—');
});

test('options：readOption 兼容 volatile 引用与普通值', () => {
  const live = { value: false, get() { return this.value; } };
  assert.equal(readOption({ autoCompact: live }, 'autoCompact', true), false);
  live.value = true;
  assert.equal(readOption({ autoCompact: live }, 'autoCompact', false), true);
  assert.equal(readOption({ autoCompact: true }, 'autoCompact', false), true);
  assert.equal(readOption({}, 'autoCompact', false), false);
  assert.equal(readOption(undefined, 'autoCompact', true), true);
  assert.equal(readOption({ autoCompact: null }, 'autoCompact', 'fallback'), 'fallback');
});

/** 构造一个带引擎/pruner/meter 的驱动器环境。 */
function makeDriverEnvironment(options = {}) {
  let auto = options.auto === true;
  let totalTokens = options.totalTokens ?? 0;
  const calls = { prune: 0, compactIfNeeded: [], compactNow: 0, measure: 0 };
  const engine = {
    compactIfNeeded: async (agent, trigger, signal) => {
      calls.compactIfNeeded.push({ trigger, signal });
      if (options.compactResult === null) return null;
      return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 4_200 };
    },
    compactNow: async () => {
      calls.compactNow += 1;
      return { shadowedSeqs: [1], shadowedTokenCount: 1 };
    }
  };
  const pruner = {
    pruneSession: () => {
      calls.prune += 1;
      return { pruned: [{}, {}], charsRemoved: 123 };
    }
  };
  const meter = {
    measure: () => {
      calls.measure += 1;
      return { totalTokens };
    }
  };
  const services = {
    compaction: engine,
    toolResultPruner: pruner,
    tokenMeter: meter,
    agentPresets: {
      serviceFor: (_agent, name) => services[name]
    }
  };
  const ctx = makeCtx(services);
  const driver = createCompactionDriver({ ctx, readAutoCompact: () => auto, logger: ctx.logger });
  return {
    ctx,
    driver,
    engine,
    pruner,
    meter,
    calls,
    setAuto: (value) => {
      auto = value;
    },
    setTotalTokens: (value) => {
      totalTokens = value;
    }
  };
}

test('driver：开关关闭时 pre-step 不测量、不压缩、不修剪，且总是 next()', async () => {
  const env = makeDriverEnvironment({ auto: false, totalTokens: 900 });
  const agent = makeAgent();
  let nextCalled = 0;
  const decision = await env.driver.onPreStep({ agent, signal: { aborted: false } }, async () => {
    nextCalled += 1;
    return { kind: 'enter', messages: [] };
  });
  assert.equal(nextCalled, 1);
  assert.equal(decision.kind, 'enter');
  assert.equal(env.calls.measure, 0);
  assert.equal(env.calls.prune, 0);
  assert.equal(env.calls.compactIfNeeded.length, 0);
});

test('driver：开关打开且低于 L1 阈值时什么也不做', async () => {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 100 });
  const agent = makeAgent();
  await env.driver.onPreStep({ agent, signal: { aborted: false } }, async () => undefined);
  assert.equal(env.calls.prune, 0);
  assert.equal(env.calls.compactIfNeeded.length, 0);
});

test('driver：L1 区间只做一次批量修剪（不调模型）', async () => {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 650 });
  const agent = makeAgent();
  const outcome = await env.driver.runAutoTier(agent, { aborted: false });
  assert.equal(outcome.tier, TIER.PRUNE);
  assert.equal(outcome.pruned, 2);
  assert.equal(outcome.charsRemoved, 123);
  assert.equal(env.calls.prune, 1);
  assert.equal(env.calls.compactIfNeeded.length, 0);
});

test('driver：L2 区间走官方 compactIfNeeded("pressure")（修剪+摘要同一事务）', async () => {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 900 });
  const agent = makeAgent();
  const outcome = await env.driver.runAutoTier(agent, { aborted: false });
  assert.equal(outcome.tier, TIER.COMPACT);
  assert.equal(outcome.compacted, true);
  assert.equal(env.calls.compactIfNeeded.length, 1);
  assert.equal(env.calls.compactIfNeeded[0].trigger, 'pressure');
  // 不直接调用 pruner：官方 compactPressure 会在同一事务里先剪枝。
  assert.equal(env.calls.prune, 0);
});

test('driver：pre-step 内异常被吞掉，仍然 next()（宿主不兜异常）', async () => {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 900 });
  env.engine.compactIfNeeded = async () => {
    throw new Error('boom');
  };
  const agent = makeAgent();
  let nextCalled = 0;
  const decision = await env.driver.onPreStep({ agent, signal: { aborted: false } }, async () => {
    nextCalled += 1;
    return { kind: 'enter', messages: [] };
  });
  assert.equal(nextCalled, 1);
  assert.equal(decision.kind, 'enter');
});

test('driver：溢出恢复在表层前进后返回 retry，且受每轮次数上限约束', async () => {
  const env = makeDriverEnvironment({ auto: true });
  const agent = makeAgent({ generation: 1 });
  // compactIfNeeded 成功即视为表层前进：把 generation 加一。
  env.engine.compactIfNeeded = async () => {
    agent.session.surface.replaceGeneration += 1;
    return { shadowedSeqs: [1], shadowedTokenCount: 10 };
  };
  const payload = {
    agent,
    failure: { code: 'CONTEXT_WINDOW_EXCEEDED' },
    signal: { aborted: false }
  };
  const first = await env.driver.onRequestError(payload, async () => undefined);
  assert.deepEqual(first, { kind: 'retry' });

  // 第二次：已达上限，交回 next()。
  let nextCalled = 0;
  const second = await env.driver.onRequestError(payload, async () => {
    nextCalled += 1;
    return undefined;
  });
  assert.equal(nextCalled, 1);
  assert.equal(second, undefined);
});

test('driver：溢出恢复在表层未前进时交回 next()', async () => {
  const env = makeDriverEnvironment({ auto: true });
  const agent = makeAgent();
  env.engine.compactIfNeeded = async () => null;
  let nextCalled = 0;
  const result = await env.driver.onRequestError(
    { agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: { aborted: false } },
    async () => {
      nextCalled += 1;
      return undefined;
    }
  );
  assert.equal(nextCalled, 1);
  assert.equal(result, undefined);
});

test('driver：autoCompact 关闭时溢出恢复不介入', async () => {
  const env = makeDriverEnvironment({ auto: false });
  const agent = makeAgent();
  let nextCalled = 0;
  await env.driver.onRequestError(
    { agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: { aborted: false } },
    async () => {
      nextCalled += 1;
      return undefined;
    }
  );
  assert.equal(nextCalled, 1);
  assert.equal(env.calls.compactIfNeeded.length, 0);
});

test('driver：自动压缩守卫让官方 pressure 路径在关闭时真正停手，且可恢复', async () => {
  const env = makeDriverEnvironment({ auto: false });
  const agent = makeAgent();
  const original = env.engine.compactIfNeeded;
  // 第一次 pre-step 会安装守卫。
  await env.driver.onPreStep({ agent, signal: { aborted: false } }, async () => undefined);
  assert.notEqual(env.engine.compactIfNeeded, original);
  // 关闭时 pressure 路径返回 null（官方 listener 因此不做任何事）。
  assert.equal(await env.engine.compactIfNeeded(agent, 'pressure', { aborted: false }), null);
  // 溢出恢复路径仍放行（安全网）。
  const overflow = await env.engine.compactIfNeeded(agent, 'context-overflow', { aborted: false });
  assert.equal(overflow.shadowedTokenCount, 4_200);
  // 打开后 pressure 路径恢复。
  env.setAuto(true);
  const pressure = await env.engine.compactIfNeeded(agent, 'pressure', { aborted: false });
  assert.equal(pressure.shadowedTokenCount, 4_200);
  // 卸载后恢复原方法。
  for (const dispose of env.driver.attach()) dispose();
  assert.equal(env.engine.compactIfNeeded, original);
});

test('driver：pruneAll / describe / diag 的稳定形状', async () => {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 0 });
  const agent = makeAgent();
  assert.deepEqual(env.driver.pruneAll(agent), { available: true, pruned: 2, charsRemoved: 123 });
  assert.deepEqual(env.driver.describe(), {
    autoCompact: true,
    pruneRatio: DEFAULT_PRUNE_RATIO,
    compactRatio: DEFAULT_COMPACT_RATIO,
    maxOverflowRetries: DEFAULT_MAX_OVERFLOW_RETRIES
  });
  const diag = env.driver.diag();
  assert.equal(diag.hasCompaction, true);
  assert.equal(diag.hasPruner, true);
  assert.equal(diag.hasTokenMeter, true);
  assert.equal(typeof diag.guardedEngines, 'number');
});
