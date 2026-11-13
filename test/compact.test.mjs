/**
 * 分级压缩的离线测试：纯决策逻辑 + Host 驱动器（mock ctx，不碰真实 DSH 运行时）。
 *
 * @module dsh-session-enhance/test/compact
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_AUTO_FAILURE_LIMIT,
  DEFAULT_COMPACT_RATIO,
  DEFAULT_MAX_OVERFLOW_RETRIES,
  DEFAULT_PRUNE_RATIO,
  DEFAULT_WARNING_RATIO,
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
      requestContext: () => ({ contextWindow: options.contextWindow ?? 1_000_000 }),
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

test('tiers：resolveTier 在两级阈值处切换（1M 窗口，余量不构成约束）', () => {
  const base = { contextWindow: 1_000_000, maxTokens: 0 };
  // 压力预算 = 1,000,000 − 0 − 65,536 = 934,464；两级阈值取 min(窗口×比例, 预算)。
  assert.equal(resolveTier({ ...base, totalTokens: 599_999 }).tier, TIER.NONE);
  assert.equal(resolveTier({ ...base, totalTokens: 600_000 }).tier, TIER.PRUNE);
  assert.equal(resolveTier({ ...base, totalTokens: 799_999 }).tier, TIER.PRUNE);
  assert.equal(resolveTier({ ...base, totalTokens: 800_000 }).tier, TIER.COMPACT);
  assert.equal(resolveTier({ ...base, totalTokens: 1_000_000 }).tier, TIER.COMPACT);
  // 阈值本身也暴露出来（客户端 tooltip 用）。
  assert.equal(resolveTier({ ...base, totalTokens: 0 }).pruneThresholdTokens, 600_000);
  assert.equal(resolveTier({ ...base, totalTokens: 0 }).compactThresholdTokens, 800_000);
});

test('tiers：阈值按官方公式被 headroom 夹住（小窗口）', () => {
  // 官方：min(窗口×0.8, 窗口−预留−65536)。128k 窗口 + 8k 预留 → 预算 54,464，
  // 于是 0.8×128k=102,400 被压到 54,464 —— 而不是 96,000（只按窗口比例算的结果）。
  // 预算成为约束时 L1/L2 阈值相同（都等于预算），这是官方公式的直接后果。
  const small = { contextWindow: 128_000, maxTokens: 8_000 };
  assert.equal(resolveTier({ ...small, totalTokens: 54_463 }).tier, TIER.NONE);
  assert.equal(resolveTier({ ...small, totalTokens: 54_464 }).tier, TIER.COMPACT);
  assert.equal(resolveTier({ ...small, totalTokens: 0 }).compactThresholdTokens, 54_464);
  assert.equal(resolveTier({ ...small, totalTokens: 0 }).pruneThresholdTokens, 54_464);
});

test('tiers：窗口小于压缩余量时返回 NO_PRESSURE_BUDGET（不压缩，而不是永远压）', () => {
  const decision = resolveTier({ contextWindow: 50_000, maxTokens: 0, totalTokens: 40_000 });
  assert.equal(decision.tier, TIER.NONE);
  assert.equal(decision.reason, 'NO_PRESSURE_BUDGET');
});

test('tiers：pruneRatio ≥ compactRatio 时收敛到 compact（保证 L1 一定先于 L2）', () => {
  const decision = resolveTier({
    contextWindow: 1_000_000,
    maxTokens: 0,
    totalTokens: 0,
    pruneRatio: 0.95,
    compactRatio: 0.5
  });
  assert.equal(decision.pruneRatio, 0.5);
  assert.equal(decision.compactRatio, 0.5);
});

test('tiers：窗口/用量缺失时返回 none', () => {
  assert.equal(resolveTier({ totalTokens: 900_000 }).tier, TIER.NONE);
  assert.equal(resolveTier({ totalTokens: 900_000 }).reason, 'NO_WINDOW');
  assert.equal(resolveTier({ contextWindow: 1_000_000 }).tier, TIER.NONE);
  assert.equal(resolveTier({ contextWindow: 1_000_000 }).reason, 'NO_MEASUREMENT');
  assert.equal(resolveTier({ totalTokens: 900_000, contextWindow: 1_000_000 }).ratio, 0.9);
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
    // `agents` 只在测「修剪必须先有开放 turn」时注入；省略时 serviceOf 返回 undefined，
    // 驱动器的 isTurnOpen 回退为 true（保持既有用例的行为）。
    ...(options.agents === undefined ? {} : { agents: options.agents }),
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
  const env = makeDriverEnvironment({ auto: false, totalTokens: 900_000 });
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
  const env = makeDriverEnvironment({ auto: true, totalTokens: 650_000 });
  const agent = makeAgent();
  const outcome = await env.driver.runAutoTier(agent, { aborted: false });
  assert.equal(outcome.tier, TIER.PRUNE);
  assert.equal(outcome.pruned, 2);
  assert.equal(outcome.charsRemoved, 123);
  assert.equal(env.calls.prune, 1);
  assert.equal(env.calls.compactIfNeeded.length, 0);
});

test('driver：L2 区间走官方 compactIfNeeded("pressure")（修剪+摘要同一事务）', async () => {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 900_000 });
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
  const env = makeDriverEnvironment({ auto: true, totalTokens: 900_000 });
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

test('driver：溢出恢复是安全网，autoCompact 关闭时也介入', async () => {
  const env = makeDriverEnvironment({ auto: false });
  const agent = makeAgent({ generation: 1 });
  let attempts = 0;
  env.engine.compactIfNeeded = async () => {
    attempts += 1;
    agent.session.surface.replaceGeneration += 1;
    return { shadowedSeqs: [1], shadowedTokenCount: 10 };
  };
  const result = await env.driver.onRequestError(
    { agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: { aborted: false } },
    async () => undefined
  );
  assert.deepEqual(result, { kind: 'retry' });
  assert.equal(attempts, 1);
});

test('driver：自动压缩连续失败 3 次后熔断，空闲（轮结束）后重置', async () => {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 900_000 });
  const agent = makeAgent();
  let attempts = 0;
  env.engine.compactIfNeeded = async () => {
    attempts += 1;
    throw new Error('summary rejected');
  };

  // 前三次都会真正尝试，每次都被 onPreStep 吞掉（不抛给宿主）。
  for (let index = 0; index < 3; index += 1) {
    await env.driver.onPreStep({ agent, signal: { aborted: false } }, async () => undefined);
  }
  assert.equal(attempts, 3);
  assert.equal(env.driver.statusFor(agent).breakerOpen, true);
  assert.equal(env.driver.statusFor(agent).autoFailures, 3);

  // 熔断后第 4 次不再调用引擎。
  await env.driver.onPreStep({ agent, signal: { aborted: false } }, async () => undefined);
  assert.equal(attempts, 3);
  assert.equal(env.driver.statusFor(agent).breakerOpen, true);

  // 一轮结束（idle）后重置，下一轮重新给机会。
  env.driver.onStatus({ agent, status: 'idle' });
  assert.equal(env.driver.statusFor(agent).breakerOpen, false);
  assert.equal(env.driver.statusFor(agent).autoFailures, 0);
});

test('driver：自动压缩成功后清零失败计数', async () => {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 900_000 });
  const agent = makeAgent();
  let shouldFail = true;
  env.engine.compactIfNeeded = async () => {
    if (shouldFail) throw new Error('boom');
    return { shadowedSeqs: [1, 2], shadowedTokenCount: 100 };
  };
  for (let index = 0; index < 2; index += 1) {
    await env.driver.onPreStep({ agent, signal: { aborted: false } }, async () => undefined);
  }
  assert.equal(env.driver.statusFor(agent).autoFailures, 2);
  shouldFail = false;
  await env.driver.onPreStep({ agent, signal: { aborted: false } }, async () => undefined);
  assert.equal(env.driver.statusFor(agent).autoFailures, 0);
  assert.equal(env.driver.statusFor(agent).breakerOpen, false);
});

test('driver：statusFor 给出有效窗口、熔断状态与最近决策', () => {
  const env = makeDriverEnvironment({ auto: true });
  const agent = makeAgent({ contextWindow: 1_000, maxTokens: 200 });
  assert.equal(env.driver.effectiveWindowFor(agent), 800);
  const status = env.driver.statusFor(agent);
  assert.equal(status.autoFailures, 0);
  assert.equal(status.breakerOpen, false);
  assert.equal(status.effectiveWindow, 800);
  assert.equal(status.lastPruned, 0);
  // 小窗口下预算被 headroom 吃光：明确给出 NO_PRESSURE_BUDGET，而不是假装「没压力」。
  assert.equal(status.lastDecision.tier, TIER.NONE);
  assert.equal(status.lastDecision.reason, 'NO_PRESSURE_BUDGET');
  assert.equal(status.lastDecision.window, 800);
});

test('driver：autoCompact 关闭时 statusFor 明确回答 AUTO_OFF（为什么没压）', () => {
  const env = makeDriverEnvironment({ auto: false });
  const agent = makeAgent();
  const status = env.driver.statusFor(agent);
  assert.equal(status.lastDecision.tier, TIER.NONE);
  assert.equal(status.lastDecision.reason, 'AUTO_OFF');
});

test('driver：仲裁器三态 —— 关=交还官方、开+外部=让路、开+插件自己=放行', async () => {
  const env = makeDriverEnvironment({ auto: false, totalTokens: 900_000 });
  const agent = makeAgent();
  const original = env.engine.compactIfNeeded;
  // 第一次 pre-step 会安装仲裁器。
  await env.driver.onPreStep({ agent, signal: { aborted: false } }, async () => undefined);
  assert.notEqual(env.engine.compactIfNeeded, original);
  // ① 关闭时：pressure 路径**转发给官方**（5.3.0 之前这里返回 null，等于把官方兜底关掉）。
  const offPressure = await env.engine.compactIfNeeded(agent, 'pressure', { aborted: false });
  assert.equal(offPressure.shadowedTokenCount, 4_200);
  assert.equal(env.calls.compactIfNeeded.length, 1);
  // ② 关闭时：溢出恢复仍放行（安全网）。
  const overflow = await env.engine.compactIfNeeded(agent, 'context-overflow', { aborted: false });
  assert.equal(overflow.shadowedTokenCount, 4_200);
  // ③ 打开后：外部（官方 listener）的 pressure 调用被让路 → null。
  env.setAuto(true);
  assert.equal(await env.engine.compactIfNeeded(agent, 'pressure', { aborted: false }), null);
  // ④ 打开后：插件自己的 L2 调用必须放行（否则自己把自己拦住）。
  const own = await env.driver.runAutoTier(agent, { aborted: false });
  assert.equal(own.tier, TIER.COMPACT);
  assert.equal(own.compacted, true);
  // ⑤ 卸载后恢复原方法。
  for (const dispose of env.driver.attach()) dispose();
  assert.equal(env.engine.compactIfNeeded, original);
});

test('driver：pruneAll / describe / diag 的稳定形状', async () => {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 0 });
  const agent = makeAgent();
  // 不带决策 → 回退官方全量修剪（兼容旧调用方）。
  assert.deepEqual(env.driver.pruneAll(agent), {
    available: true,
    pruned: 2,
    charsRemoved: 123,
    selective: false
  });
  assert.deepEqual(env.driver.describe(), {
    autoCompact: true,
    pruneRatio: DEFAULT_PRUNE_RATIO,
    compactRatio: DEFAULT_COMPACT_RATIO,
    warningRatio: DEFAULT_WARNING_RATIO,
    headroomTokens: 65_536,
    maxOverflowRetries: DEFAULT_MAX_OVERFLOW_RETRIES,
    autoFailureLimit: DEFAULT_AUTO_FAILURE_LIMIT
  });
  const diag = env.driver.diag();
  assert.equal(diag.hasCompaction, true);
  assert.equal(diag.hasPruner, true);
  assert.equal(diag.hasTokenMeter, true);
  assert.equal(typeof diag.guardedEngines, 'number');
});

test('driver：pruneIfNeeded 在压力未达 L1 阈值时跳过修剪（不再「先剪后失败」）', () => {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 100 });
  const agent = makeAgent();
  const outcome = env.driver.pruneIfNeeded(agent);
  assert.equal(outcome.skipped, true);
  assert.equal(outcome.pruned, 0);
  assert.equal(outcome.reason, 'BELOW_PRUNE_RATIO');
  // 关键：一次 pruner 都没调用 —— 这就是 R7 的修复点。
  assert.equal(env.calls.prune, 0);
});

test('driver：pruneIfNeeded 在压力达 L1 阈值时按需修剪', () => {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 650_000 });
  const agent = makeAgent();
  const outcome = env.driver.pruneIfNeeded(agent);
  assert.equal(outcome.skipped, false);
  assert.equal(outcome.pruned, 2);
  assert.equal(env.calls.prune, 1);
});

/** 构造一个可被「按需修剪」驱动的假会话（只实现 pruneSelective 用到的方法）。 */
function makePrunableSession(entries) {
  const events = new Map();
  const appended = [];
  let seq = 100;
  for (const entry of entries) {
    events.set(entry.seq, {
      seq: entry.seq,
      type: 'tool/result',
      data: { message: { role: 'tool', content: [{ type: 'text', text: entry.text }] } }
    });
  }
  return {
    appended,
    requestContext: () => ({ contextWindow: 1_000_000 }),
    requestHeader: () => ({ config: { maxTokens: 0 } }),
    get surface() {
      return { nodes: [...events.keys()] };
    },
    eventAt: (target) => events.get(target),
    deriveEventMessage: (event) => event.data.message,
    append: (type, data, options) => {
      const next = { seq, type, data, ...options };
      appended.push(next);
      seq += 1;
      return next;
    }
  };
}

test('driver：按需修剪从新到旧剪，省够就停（不碰更早的节点）', () => {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 650_000 });
  const agent = makeAgent();
  // 三个超预算工具结果：seq 1（最早）、2、3（最新）。
  const session = makePrunableSession([
    { seq: 1, text: 'a'.repeat(20_000) },
    { seq: 2, text: 'b'.repeat(20_000) },
    { seq: 3, text: 'c'.repeat(20_000) }
  ]);
  agent.session = session;
  // pruneContent：砍到只剩 100 字符（省 19,900 字符 ≈ 4,975 tokens）。
  env.pruner.pruneContent = (blocks) => [{ type: 'text', text: blocks[0].text.slice(0, 100) }];
  env.meter.estimateMessage = (message) => message.content[0].text.length;

  const outcome = env.driver.runAutoTier(agent, { aborted: false });
  return outcome.then((decision) => {
    assert.equal(decision.tier, TIER.PRUNE);
    // 只需要省 650,000 − 600,000 = 50,000 tokens；一个节点只省 ~19,900，
    // 所以会继续剪到够为止，但**从最新开始**：先 3、再 2、再 1。
    const replaced = session.appended.filter((event) => event.surfaceOp !== undefined).map((event) => event.surfaceOp.startSeq);
    assert.deepEqual(replaced, [3, 2, 1]);
    // 每个替换前都有一条影子价格事件（否则会话会拒绝写入）。
    const shadowPrices = session.appended.filter((event) => event.type === 'compaction/prune');
    assert.equal(shadowPrices.length, replaced.length);
    assert.equal(shadowPrices[0].data.shadowedSeqs[0], 3);
    // 不再回退到官方全量修剪。
    assert.equal(env.calls.prune, 0);
  });
});

test('driver：按需修剪省够目标后停止（不把更早节点也剪掉）', () => {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 620_000 });
  const agent = makeAgent();
  const session = makePrunableSession([
    { seq: 1, text: 'a'.repeat(20_000) },
    { seq: 2, text: 'b'.repeat(20_000) }
  ]);
  agent.session = session;
  // 每个节点省 10,000 tokens；目标只差 20,000 → 剪两个刚好够，但不该再往下剪（没有第三个）。
  env.pruner.pruneContent = (blocks) => [{ type: 'text', text: blocks[0].text.slice(0, 10_000) }];
  env.meter.estimateMessage = (message) => message.content[0].text.length;

  return env.driver.runAutoTier(agent, { aborted: false }).then(() => {
    const replaced = session.appended
      .filter((event) => event.surfaceOp !== undefined)
      .map((event) => event.surfaceOp.startSeq);
    assert.deepEqual(replaced, [2, 1]);
  });
});

// ── 回归：修剪必须落在开放 turn 内 ────────────────────────────────────────────
//
// 真实事故（2026-11-13）：手动压缩在 `turn/end` 之后跑，把 7 对
// `compaction/prune` + `tool/result(surfaceOp: replace)` append 到 turn 之外，
// DSH 重放校验报 `SessionFormatError: tool/result replacement is outside an open turn`，
// 整份会话日志被判 corrupt —— 历史读不出来、会话也无法冷恢复。

/** 造一个「turn 是否开放」可控的 agents 服务。 */
function makeAgents({ turnOpen }) {
  return {
    turnBoundaryOf: () => ({
      openTurnStartSeq: turnOpen ? 100 : null,
      lastStepStartSeq: 100,
      lastStepBoundary: { kind: turnOpen ? 'start' : 'end', seq: 100 },
      lastTurn: 11
    })
  };
}

/** 造一份「压力已达 L1、且有可剪工具结果」的环境。 */
function makePrunableEnvironment({ turnOpen }) {
  const env = makeDriverEnvironment({ auto: true, totalTokens: 650_000, agents: makeAgents({ turnOpen }) });
  const agent = makeAgent();
  const session = makePrunableSession([{ seq: 1, text: 'a'.repeat(20_000) }]);
  agent.session = session;
  env.pruner.pruneContent = (blocks) => [{ type: 'text', text: blocks[0].text.slice(0, 100) }];
  env.meter.estimateMessage = (message) => message.content[0].text.length;
  return { env, agent, session };
}

test('driver：turn 已关闭时拒绝修剪（否则日志会被写坏）', async () => {
  const { env, agent, session } = makePrunableEnvironment({ turnOpen: false });

  const decision = await env.driver.runAutoTier(agent, { aborted: false });

  // 决策层仍然认为该剪（压力确实超了），但执行层必须停手。
  assert.equal(decision.tier, TIER.PRUNE);
  assert.equal(decision.pruned, 0);
  // 一条事件都不许写：写一条就损坏。
  assert.equal(session.appended.length, 0);
  // 也不许回退到官方全量修剪 —— 它同样 append surface 替换。
  assert.equal(env.calls.prune, 0);
});

test('driver：手动修剪（pruneAll）在 turn 已关闭时同样停手并标记原因', () => {
  const { env, agent, session } = makePrunableEnvironment({ turnOpen: false });

  const outcome = env.driver.pruneAll(agent);

  assert.equal(outcome.available, true);
  assert.equal(outcome.pruned, 0);
  assert.equal(outcome.skippedOutsideTurn, true);
  assert.equal(session.appended.length, 0);
  assert.equal(env.calls.prune, 0);
});

test('driver：turn 开放时正常修剪（守卫不误伤）', async () => {
  const { env, agent, session } = makePrunableEnvironment({ turnOpen: true });

  const decision = await env.driver.runAutoTier(agent, { aborted: false });

  assert.equal(decision.tier, TIER.PRUNE);
  assert.equal(decision.pruned, 1);
  const replaced = session.appended.filter((event) => event.surfaceOp !== undefined);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].surfaceOp.startSeq, 1);
  // 影子价格事件照旧先写。
  const shadowPrices = session.appended.filter((event) => event.type === 'compaction/prune');
  assert.equal(shadowPrices.length, 1);
});

test('driver：agents 服务缺失时保持旧行为（无法判断就不阻断修剪）', async () => {
  // 不注入 agents：serviceOf 返回 undefined → isTurnOpen 回退 true。
  const env = makeDriverEnvironment({ auto: true, totalTokens: 650_000 });
  const agent = makeAgent();
  const session = makePrunableSession([{ seq: 1, text: 'a'.repeat(20_000) }]);
  agent.session = session;
  env.pruner.pruneContent = (blocks) => [{ type: 'text', text: blocks[0].text.slice(0, 100) }];
  env.meter.estimateMessage = (message) => message.content[0].text.length;

  const decision = await env.driver.runAutoTier(agent, { aborted: false });

  assert.equal(decision.pruned, 1);
  assert.equal(session.appended.filter((event) => event.surfaceOp !== undefined).length, 1);
});
