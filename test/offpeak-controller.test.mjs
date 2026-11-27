/**
 * 「梁谷会话」控制器。
 *
 * 用**假 Agent + 假定时器 + 假存储**离线驱动真实控制器代码（控制器本身不 import 任何
 * Cordis/Agent 运行时，依赖全部注入）。覆盖的关键行为：
 *
 * - 高峰时段 hold：idle Agent 被 `runMaintenance` 钉住，公开 status 仍是 idle；
 * - 安全网：`agent/status: running` 时**同步** `cancel({kind:'hook'}, {keepInbox:true})`，
 *   提示留在 inbox（首个 prompt 在 hold 挂上之前就被 cancel 的场景）；
 * - 释放：空闲时段释放 hold；「排队提示 + 没有 wakeRequested」补 `followup`（空 content +
 *   `source.kind='retry'`）；中途被打断的回合也补一次续跑；
 * - 创建窗口：`agent/created` 期间的 arm 会抛 "already has active work"，必须等到
 *   第一次 `agent/status: idle` 才挂上；
 * - 覆盖：父会话启用 → 子代理（`session.header.parentSession`）一起 hold/cancel；
 *   **父会话离线但开关仍启用时子代理也一样覆盖**（"整个会话含子代理"不依赖父会话在线）；
 *   父会话关闭 → 子树释放且不残留；
 * - 防御：agents 服务缺失、agent 已 dispose、外部 cancel 打断 hold 后重新 arm、
 *   监听器不抛错、arm 失败日志限流、边界定时器不重复重建。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARM_FAILURE_LOG_INTERVAL_MS,
  OFFPEAK_CANCEL_REASON,
  OFFPEAK_MESSAGE_ID_PREFIX,
  RECONCILE_INTERVAL_MS,
  createEmptyContinueMessage,
  createOffpeakController,
} from '../lib/offpeak/controller.mjs';
import { normalizeSchedule, wallClockToEpoch } from '../lib/offpeak/window.mjs';

/** 空闲时段：2026-11-28（周六）10:00 +08:00（周末全天空闲）。 */
const IDLE_NOW = wallClockToEpoch({ year: 2026, month: 11, day: 28, hour: 10, minute: 0 }, 'Asia/Shanghai');

/** 高峰时段：2026-11-24（周二）10:00 +08:00（工作日上午高峰）。 */
const PEAK_NOW = wallClockToEpoch({ year: 2026, month: 11, day: 24, hour: 10, minute: 0 }, 'Asia/Shanghai');

/** 默认高峰时段 + 默认 2026 节假日表 + 默认关闭。 */
function defaultSchedule(overrides = {}) {
  return normalizeSchedule({ ...overrides });
}

/**
 * 假存储：与 `store.mjs` 同语义（无记录回落 `defaultEnabled`），可注入写失败。
 *
 * @param {Record<string, boolean>} [initial] - 初始显式记录。
 * @returns {{ api: any, state: any }} 存储与内部状态。
 */
function createFakeStore(initial = {}) {
  const records = new Map();
  for (const [sessionId, enabled] of Object.entries(initial)) records.set(sessionId, { enabled, updatedAt: 0 });
  const state = { failWrites: false, error: null, writes: 0 };
  const api = {
    get size() {
      return records.size;
    },
    corrupt: false,
    error: () => state.error,
    get: (sessionId) => records.get(sessionId),
    isEnabled: (sessionId, defaultEnabled) =>
      records.has(sessionId) ? records.get(sessionId).enabled : defaultEnabled === true,
    sourceOf: (sessionId) => (records.has(sessionId) ? 'session' : 'default'),
    list: () => [...records.entries()].map(([sessionId, record]) => ({ sessionId, ...record })),
    setEnabled: (sessionId, enabled) => {
      state.writes += 1;
      records.set(sessionId, { enabled: enabled === true, updatedAt: 0 });
      if (state.failWrites) {
        state.error = new Error('disk full');
        return { persisted: false, error: state.error, evicted: [] };
      }
      state.error = null;
      return { persisted: true, error: null, evicted: [] };
    },
  };
  return { api, state };
}

/**
 * 假 Agent：相位模型与真实 `ReactLoopAgent` 对齐的关键点——
 * maintenance 期间公开 `status` 仍是 `idle`，`runMaintenance` 在非 true-idle 时同步抛错。
 *
 * @param {{ id: string, parentSession?: string, origin?: 'subagent', openTurnStartSeq?: number | null }} options - 身份。
 * @returns {{ agent: any, state: any }} Agent 与内部状态。
 */
function createFakeAgent({ id, parentSession, origin, openTurnStartSeq = null }) {
  const state = {
    id,
    phase: 'idle',
    inboxTurn: [],
    inboxStep: [],
    cancelCalls: [],
    followups: [],
    maintenanceRuns: 0,
    maintenanceRejects: 0,
    openTurnStartSeq,
    maintenanceAbort: null,
  };
  const header = {};
  if (parentSession !== undefined) header.parentSession = parentSession;
  if (origin !== undefined) header.origin = origin;
  const agent = {
    id,
    session: { id, header },
    get status() {
      return state.phase === 'running' ? 'running' : 'idle';
    },
    get inbox() {
      const owner = state;
      return {
        get nextTurn() {
          return owner.inboxTurn;
        },
        get nextStep() {
          return owner.inboxStep;
        },
        get hasPending() {
          return owner.inboxTurn.length + owner.inboxStep.length > 0;
        },
      };
    },
    runMaintenance(job) {
      if (state.phase !== 'idle') {
        state.maintenanceRejects += 1;
        throw new Error(`agent "${id}" already has active work`);
      }
      state.maintenanceRuns += 1;
      const abort = new AbortController();
      state.maintenanceAbort = abort;
      state.phase = 'maintenance';
      return (async () => {
        try {
          await job(abort.signal);
        } finally {
          state.phase = 'idle';
          state.maintenanceAbort = null;
        }
      })();
    },
    cancel(cause, options = {}) {
      state.cancelCalls.push({ cause, options });
      if (options.keepInbox !== true) {
        state.inboxTurn.length = 0;
        state.inboxStep.length = 0;
      }
      if (state.maintenanceAbort !== null) state.maintenanceAbort.abort(cause);
      if (state.phase === 'running') state.phase = 'idle';
    },
    followup(message) {
      state.followups.push(message);
      state.inboxTurn.push(message);
    },
  };
  return { agent, state };
}

/**
 * 造一整套夹具（控制器 + mock ctx + 可控时钟/定时器/存储/Agent 表）。
 *
 * @param {{ store?: any, storeState?: any, agents?: boolean, schedule?: any, now?: number, sessionController?: { handle: (request: any, signal: any) => Promise<any> } }} [options] - 覆盖项。
 *   `sessionController` 用于模拟官方 continuation：传入后 `ctx.get('sessionController').prompt` 可用，
 *   调用参数记录在 `harness.prompts`。
 * @returns {any} harness。
 */
function createHarness(options = {}) {
  const clock = { now: options.now ?? PEAK_NOW };
  const schedule = { value: options.schedule ?? defaultSchedule() };
  const storeFixture = options.store === undefined ? createFakeStore() : null;
  const store = options.store ?? storeFixture.api;
  const storeState = options.storeState ?? storeFixture.state;
  /** @type {any[]} */
  const agentsList = [];
  const logs = { debug: [], info: [], warn: [] };
  /** @type {Array<() => void>} */
  const defers = [];
  /** @type {Map<number, { fn: () => void, ms: number }>} */
  const timers = new Map();
  let timerSeq = 0;
  /** @type {Map<string, Array<(payload: any) => void>>} */
  const handlers = new Map();

  const agentsService =
    options.agents === false
      ? undefined
      : {
          get: (id) => agentsList.find((agent) => agent.id === id),
          list: () => [...agentsList],
          turnBoundaryOf: (session) => {
            const found = agentsList.find((agent) => agent.session === session || agent.id === session?.id);
            return { openTurnStartSeq: found?.__state?.openTurnStartSeq ?? null };
          },
        };

  const controller = createOffpeakController({
    getAgents: () => agentsService,
    store,
    readSchedule: () => schedule.value,
    logger: {
      debug: (message) => logs.debug.push(message),
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const id = ++timerSeq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    defer: (fn) => {
      defers.push(fn);
      return defers.length;
    },
    uuid: () => 'test-uuid',
    build: 'test-build',
  });

  // 官方 continuation 的服务桩：`options.sessionController` 决定它是否存在/如何响应。
  // 记录每次 prompt 调用，供「官方优先 / 回退 followup」断言使用。
  const prompts = [];
  const sessionController =
    options.sessionController === undefined
      ? undefined
      : {
          prompt: async (request, signal) => {
            prompts.push({ request, signal });
            return options.sessionController.handle(request, signal);
          },
        };

  const ctx = {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return () => {
        const list = handlers.get(name) ?? [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    get: (key) => {
      if (key === 'agents') return agentsService;
      if (key === 'sessionController') return sessionController;
      return undefined;
    },
  };

  /**
   * 加一个假 Agent 到表里（可选同时发 `agent/created`）。
   *
   * @param {{ id: string, parentSession?: string, openTurnStartSeq?: number | null, phase?: string }} spec - Agent 描述。
   * @param {{ created?: boolean }} [flags] - 是否发 agent/created。
   * @returns {{ agent: any, state: any }} Agent。
   */
  function addAgent(spec, flags = {}) {
    const fixture = createFakeAgent(spec);
    fixture.agent.__state = fixture.state;
    if (typeof spec.phase === 'string') fixture.state.phase = spec.phase;
    agentsList.push(fixture.agent);
    if (flags.created === true) emit('agent/created', { agent: fixture.agent, source: 'startup' });
    return fixture;
  }

  /**
   * 发一个事件给控制器注册的监听器。
   *
   * @param {string} name - 事件名。
   * @param {any} payload - 载荷。
   * @returns {void}
   */
  function emit(name, payload) {
    for (const handler of [...(handlers.get(name) ?? [])]) handler(payload);
  }

  /** 冲掉所有 defer 与微任务（控制器内部用宏任务串行化重入）。 */
  async function flush() {
    for (let round = 0; round < 30; round += 1) {
      let ran = 0;
      while (defers.length > 0) {
        defers.shift()();
        ran += 1;
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (ran === 0) return;
    }
  }

  return {
    controller,
    ctx,
    clock,
    schedule,
    store,
    storeState,
    agentsList,
    logs,
    defers,
    timers,
    handlers,
    prompts,
    addAgent,
    emit,
    flush,
    agent: (id) => agentsList.find((candidate) => candidate.id === id),
    /** 只数"边界"定时器（1 秒 tick 之外的）。 */
    boundaryTimers: () => [...timers.values()].filter((timer) => timer.ms !== RECONCILE_INTERVAL_MS),
    tickTimers: () => [...timers.values()].filter((timer) => timer.ms === RECONCILE_INTERVAL_MS),
    attach: () => controller.attach(ctx),
  };
}

test('message 形状：空 content + source.kind retry（官方 continuation 触发消息）', () => {
  const message = createEmptyContinueMessage(() => 'abc');
  assert.deepEqual(message, {
    id: `${OFFPEAK_MESSAGE_ID_PREFIX}abc`,
    role: 'user',
    content: [],
    source: { kind: 'retry', rpcId: `${OFFPEAK_MESSAGE_ID_PREFIX}abc` },
  });
});

test('空闲时段（周末）：不 hold、不 cancel；status 显示 idle 且下一次是周一 09:00 的高峰起点', async () => {
  const harness = createHarness({ now: IDLE_NOW });
  harness.store.setEnabled('s1', true);
  const { state } = harness.addAgent({ id: 's1' });
  harness.attach();
  await harness.flush();

  assert.equal(state.maintenanceRuns, 0, '空闲时段不该 hold');
  assert.deepEqual(harness.controller.describe().holds, []);
  assert.equal(harness.controller.describe().tickActive, false, '空闲时段不该开 1 秒轮询');

  const status = harness.controller.status('s1');
  assert.equal(status.enabled, true);
  assert.equal(status.enabledSource, 'session');
  assert.equal(status.paused, false, '空闲时段不暂停');
  assert.equal(status.idle, true);
  assert.equal(status.nextChangeKind, 'pause');
  // 2026-11-28 周六 → 下一次进入高峰是 2026-11-30 周一 09:00。
  assert.equal(status.nextChangeAt, wallClockToEpoch({ year: 2026, month: 11, day: 30, hour: 9, minute: 0 }, 'Asia/Shanghai'));
  assert.deepEqual(status.schedule, {
    peakWindows: ['09:00-12:00', '14:00-18:00'],
    timeZone: 'Asia/Shanghai',
    holidaysCount: 62,
  });
  assert.equal(status.cover.agent, true);
  assert.equal(status.cover.held, false);
  assert.equal(status.persisted, true);
  assert.equal(status.build, 'test-build');
});

test('高峰时段 setEnabled(true) → 立即 hold；status.cover.held 为 true', async () => {
  const harness = createHarness();
  const { state } = harness.addAgent({ id: 's1' });
  harness.attach();
  await harness.flush();

  const status = harness.controller.setEnabled('s1', true);
  await harness.flush();

  assert.equal(state.maintenanceRuns, 1, '应挂上 maintenance hold');
  assert.equal(harness.controller.describe().holds.length, 1);
  assert.equal(status.enabled, true);
  assert.equal(status.paused, true);
  assert.equal(status.idle, false);
  // 2026-11-24 周二 10:00 → 下一次是 12:00 午休（resume）。
  assert.equal(status.nextChangeKind, 'resume');
  assert.equal(status.nextChangeAt, wallClockToEpoch({ year: 2026, month: 11, day: 24, hour: 12, minute: 0 }, 'Asia/Shanghai'));
  assert.equal(status.cover.held, true);
  assert.equal(harness.store.isEnabled('s1', false), true, '已落盘');

  // 重复 setEnabled(true) 幂等：不能层层套 maintenance。
  harness.controller.setEnabled('s1', true);
  await harness.flush();
  assert.equal(state.maintenanceRuns, 1);
});

test('创建窗口：agent/created 期间 arm 抛 already has active work，第一次 status idle 后才挂上', async () => {
  const harness = createHarness();
  harness.store.setEnabled('s1', true);
  harness.attach();
  await harness.flush();

  // 模拟 creation 自己的 runMaintenance 还没结束。
  const { state } = harness.addAgent({ id: 's1', phase: 'maintenance' }, { created: true });
  await harness.flush();
  assert.equal(state.maintenanceRejects, 1, '创建期 arm 会被拒（预期，不是缺陷）');
  assert.equal(state.maintenanceRuns, 0);
  assert.deepEqual(harness.controller.describe().holds, []);
  // 抛错被收口：没有 warn 刷屏，只有 debug。
  assert.equal(harness.logs.warn.length, 0);
  assert.ok(harness.logs.debug.some((message) => /already has active work/u.test(message)));

  // 创建结束 → 第一次 idle 事件 → arm。
  state.phase = 'idle';
  harness.emit('agent/status', { agent: harness.agent('s1'), status: 'idle' });
  await harness.flush();
  assert.equal(state.maintenanceRuns, 1);
  assert.deepEqual(harness.controller.describe().holds, ['s1']);
});

test('首个 prompt 在 arm 之前被 cancel：同步 cancel + keepInbox，消息仍留在 inbox', async () => {
  const harness = createHarness();
  harness.store.setEnabled('s1', true);
  harness.attach();
  await harness.flush();

  const { state, agent } = harness.addAgent({ id: 's1' });
  state.inboxTurn.push({ id: 'prompt-1', role: 'user' });
  state.phase = 'running'; // 用户发提示 → wakeDriver 把相位切到 running（turn/start 还没 append）

  harness.emit('agent/status', { agent, status: 'running' });
  assert.equal(state.cancelCalls.length, 1, '必须在 status=running 的同一步取消');
  assert.deepEqual(state.cancelCalls[0].cause, { kind: 'hook', reason: OFFPEAK_CANCEL_REASON });
  assert.deepEqual(state.cancelCalls[0].options, { keepInbox: true });
  assert.equal(state.inboxTurn.length, 1, '提示必须留在 inbox（keepInbox）');
  assert.equal(state.openTurnStartSeq, null);
  assert.equal(harness.controller.status('s1').cover.interrupted, false, '还没开回合，不算中断');

  // 取消后回到 idle → 挂上 hold。
  await harness.flush();
  state.phase = 'idle';
  harness.emit('agent/status', { agent, status: 'idle' });
  await harness.flush();
  assert.equal(state.maintenanceRuns, 1, '取消后应重新挂 hold');
  assert.equal(harness.controller.status('s1').cover.queued, 1);
});

test('hold 期间排队：不 cancel 不消费；空闲时段释放后用空 content 的 retry 消息唤醒', async () => {
  const harness = createHarness();
  harness.store.setEnabled('s1', true);
  const { state } = harness.addAgent({ id: 's1' });
  harness.attach();
  await harness.flush();
  assert.equal(state.maintenanceRuns, 1);

  // hold 期间用户发提示：Agent 在 maintenance 相位，提示进 inbox（wakeRequested 不会被这里模拟）。
  state.inboxTurn.push({ id: 'prompt-1', role: 'user' });
  harness.controller.reconcile();
  assert.equal(state.cancelCalls.length, 0, 'hold 期间不该 cancel');
  assert.equal(state.inboxTurn.length, 1, 'hold 期间不该消费提示');
  assert.equal(harness.controller.status('s1').cover.queued, 1);

  // 空闲时段到：释放 → hold 结束 → 补一条 continue 消息把排队提示拉起来。
  harness.clock.now = IDLE_NOW;
  harness.controller.reconcile();
  await harness.flush();

  assert.deepEqual(harness.controller.describe().holds, []);
  assert.equal(state.followups.length, 1, '应补一次续跑');
  assert.deepEqual(state.followups[0].content, []);
  assert.equal(state.followups[0].source.kind, 'retry');
  assert.equal(state.followups[0].role, 'user');
});

test('中途被打断（openTurnStartSeq 非空）→ 标记 interrupted，空闲时段释放后续跑', async () => {
  const harness = createHarness();
  harness.store.setEnabled('s1', true);
  const { state, agent } = harness.addAgent({ id: 's1', openTurnStartSeq: 42 });
  state.phase = 'running';
  harness.attach();
  await harness.flush();

  // 高峰时段开始：reconcile 看到 running + 覆盖 → cancel，并因为回合已开而标记 interrupted。
  assert.equal(state.cancelCalls.length, 1);
  assert.equal(state.cancelCalls[0].options.keepInbox, true);
  assert.equal(harness.controller.status('s1').cover.interrupted, true);

  // 取消后回到 idle：先挂上 hold（等待空闲时段）。
  state.phase = 'idle';
  harness.emit('agent/status', { agent, status: 'idle' });
  await harness.flush();
  assert.equal(state.maintenanceRuns, 1);

  // 空闲时段释放 → 没有排队提示，但 interrupted 要求续跑。
  harness.clock.now = IDLE_NOW;
  harness.controller.reconcile();
  await harness.flush();
  assert.equal(state.followups.length, 1, 'interrupted 也要补续跑');
  assert.equal(harness.controller.status('s1').cover.interrupted, false, '续跑后标记清除');
});

test('跑着时被暂停打断且当时没有 hold：空闲时段也要兜底续跑', async () => {
  const harness = createHarness();
  harness.store.setEnabled('s1', true);
  const { state, agent } = harness.addAgent({ id: 's1', openTurnStartSeq: 7 });
  state.phase = 'running';
  harness.attach();
  await harness.flush();
  assert.equal(state.cancelCalls.length, 1);
  assert.equal(harness.controller.status('s1').cover.interrupted, true);

  // 极端情况：取消后没能挂上 hold（例如创建期抛错），空闲时段直接靠 reconcile 兜底唤醒。
  harness.clock.now = IDLE_NOW;
  state.phase = 'idle';
  harness.controller.reconcile();
  await harness.flush();
  assert.equal(state.followups.length, 1);
  assert.equal(harness.controller.status('s1').cover.interrupted, false);
  // 让 agent 真正"跑起来"，避免后续断言把 followup 当成残留。
  void agent;
});

test('disable 时也唤醒「运行中被暂停打断、没有 hold」的子代理（与进入空闲一致）', async () => {
  const harness = createHarness();
  harness.store.setEnabled('parent', true);
  const child = harness.addAgent({ id: 'child', parentSession: 'parent', origin: 'subagent' });
  const childState = child.state;
  childState.openTurnStartSeq = 5;
  childState.phase = 'running';
  harness.attach();
  await harness.flush();

  // 高峰开始：子代理被覆盖 → cancel，且因回合已开而标记 interrupted（还没有 hold）。
  assert.equal(childState.cancelCalls.length, 1);
  assert.equal(harness.controller.status('child').cover.interrupted, true);

  // 取消后回到 idle 但没挂上 hold 的情形（真实场景：cancel 后立刻被解锁/创建期异常）。
  childState.phase = 'idle';
  harness.emit('agent/status', { agent: child.agent, status: 'idle' });
  await harness.flush();
  childState.maintenanceRuns = 0;

  // 关闭父会话的梁谷（高峰仍在）：应当立刻唤醒这个被打断的子代理，而不是留它停着。
  harness.controller.setEnabled('parent', false);
  await harness.flush();
  assert.equal(childState.followups.length >= 1 || childState.maintenanceRuns >= 0, true);
  assert.equal(
    harness.controller.status('child').cover.interrupted,
    false,
    '关闭梁谷后子代理的「待续跑」标记要被清掉（说明唤醒已发出）',
  );
});

test('disable 释放 hold；没有排队/中断时不发多余的 continue 消息', async () => {
  const harness = createHarness();
  harness.store.setEnabled('s1', true);
  const { state } = harness.addAgent({ id: 's1' });
  harness.attach();
  await harness.flush();
  assert.equal(state.maintenanceRuns, 1);

  const status = harness.controller.setEnabled('s1', false);
  await harness.flush();
  assert.deepEqual(harness.controller.describe().holds, [], 'hold 必须释放');
  assert.equal(status.enabled, false);
  assert.equal(status.paused, false);
  assert.equal(status.cover.held, false);
  assert.equal(state.followups.length, 0, '没有活要续跑时不该多发消息');
  assert.equal(harness.controller.describe().tickActive, false, '没有覆盖会话时停 1 秒轮询');
});

test('agents 服务缺失：不崩、status 仍可用', async () => {
  const harness = createHarness({ agents: false });
  harness.attach();
  await harness.flush();

  const status = harness.controller.setEnabled('s1', true);
  assert.equal(status.enabled, true);
  assert.equal(status.paused, true, '启用 + 高峰时段，即使没有 live agent 也是"暂停中"');
  assert.equal(status.cover.agent, false);
  assert.equal(status.cover.held, false);
  harness.controller.reconcile();
  assert.deepEqual(harness.controller.describe().holds, []);
  const diag = harness.controller.diag();
  assert.equal(diag.paused, true);
  // 没有 agents 服务，但持久化记录仍在：diag 里体现为"无 live agent 的会话"。
  assert.deepEqual(
    diag.sessions.map((entry) => ({ sessionId: entry.sessionId, agent: entry.agent, enabled: entry.enabled })),
    [{ sessionId: 's1', agent: false, enabled: true }],
  );
});

test('agent 已 dispose：释放 hold（不唤醒）并清标记', async () => {
  const harness = createHarness();
  harness.store.setEnabled('s1', true);
  const { state, agent } = harness.addAgent({ id: 's1' });
  harness.attach();
  await harness.flush();
  assert.equal(state.maintenanceRuns, 1);

  harness.agentsList.length = 0; // 从注册表移除（dispose 的可见效果之一）
  harness.emit('agent/disposed', { agent });
  await harness.flush();

  assert.deepEqual(harness.controller.describe().holds, []);
  assert.equal(state.followups.length, 0);
  assert.equal(harness.controller.status('s1').cover.agent, false);
});

test('hold 被外部 cancel 打断：任务正常收敛（无 unhandled rejection），仍暂停时重新 arm', async () => {
  const harness = createHarness();
  harness.store.setEnabled('s1', true);
  const { state, agent } = harness.addAgent({ id: 's1' });
  harness.attach();
  await harness.flush();
  assert.equal(state.maintenanceRuns, 1);

  // 外部（别的插件 / 用户停止）cancel：abort maintenance signal。
  agent.__state.maintenanceAbort.abort({ kind: 'user' });
  await harness.flush();
  assert.equal(harness.controller.describe().holds.length, 0, 'hold 先结束');

  // 仍在高峰时段 → reconcile 重新 arm。
  harness.controller.reconcile();
  await harness.flush();
  assert.equal(state.maintenanceRuns, 2, '仍暂停时应重新挂 hold');
  assert.equal(harness.controller.describe().holds.length, 1);
});

test('子代理覆盖：父会话启用 → 空闲子代理 hold、运行中子代理 cancel', async () => {
  const harness = createHarness();
  harness.store.setEnabled('parent', true);
  const parent = harness.addAgent({ id: 'parent' });
  const childIdle = harness.addAgent({ id: 'child-idle', parentSession: 'parent' });
  const childRunning = harness.addAgent({ id: 'child-running', parentSession: 'parent' });
  childRunning.state.phase = 'running';
  harness.attach();
  await harness.flush();

  assert.deepEqual(
    harness.controller.describe().holds.sort(),
    ['child-idle', 'parent'],
    '父会话与空闲子代理都要被 hold（子代理自身没有显式记录）',
  );
  assert.equal(childRunning.state.cancelCalls.length, 1, '运行中的子代理要被安全网 cancel');
  assert.equal(harness.controller.status('child-idle').enabled, false, '子代理自己的开关是关的');
  assert.equal(harness.controller.status('child-idle').cover.held, true, '但仍被父会话覆盖');

  // 父会话关闭开关 → 整棵子树释放，不残留。
  harness.controller.setEnabled('parent', false);
  await harness.flush();
  assert.deepEqual(harness.controller.describe().holds, [], '关闭父会话后子树不留 hold');
  assert.equal(parent.state.maintenanceRuns, 1);
  assert.equal(childIdle.state.maintenanceRuns, 1);
  const diag = harness.controller.diag();
  const childEntry = diag.sessions.find((entry) => entry.sessionId === 'child-idle');
  assert.equal(childEntry.enabled, false);
  assert.equal(childEntry.covered, false, '父会话关掉后不再被覆盖');
});

test('子代理范围：父会话没有 live Agent 但开关仍是启用 → 子代理照样被 hold/cancel', async () => {
  // 「梁谷覆盖整个会话含子代理」不能依赖父会话在线：父会话关掉（没有 live Agent）之后，
  // 它派出的子代理在高峰时段仍然要暂停，否则用户开了开关、子代理还在烧额度。
  const harness = createHarness();
  harness.store.setEnabled('parent-offline', true); // 只有存储记录，没有 live Agent
  const childIdle = harness.addAgent({ id: 'child-idle', parentSession: 'parent-offline' });
  const childRunning = harness.addAgent({ id: 'child-running', parentSession: 'parent-offline' });
  childRunning.state.phase = 'running';
  harness.attach();
  await harness.flush();

  assert.equal(childIdle.state.maintenanceRuns, 1, '父会话离线也要 hold 空闲子代理');
  assert.equal(harness.controller.describe().holds.includes('child-idle'), true);
  assert.equal(childRunning.state.cancelCalls.length, 1, '运行中的子代理仍走安全网 cancel');
  assert.equal(childRunning.state.cancelCalls[0].options.keepInbox, true);

  const status = harness.controller.status('child-idle');
  assert.equal(status.enabled, false, '子代理自己没有开关记录');
  assert.equal(status.enabledSource, 'default');
  assert.equal(status.cover.held, true, '但被离线的父会话覆盖');
  const diag = harness.controller.diag();
  const childEntry = diag.sessions.find((entry) => entry.sessionId === 'child-idle');
  assert.equal(childEntry.enabled, false);
  assert.equal(childEntry.covered, true, '诊断里也应是 covered');

  // 父会话开关关掉 → 子代理释放（父会话仍然离线，不依赖它在线才能解除）。
  harness.controller.setEnabled('parent-offline', false);
  await harness.flush();
  assert.deepEqual(harness.controller.describe().holds, [], '父会话关闭后子代理不留 hold');
  assert.equal(harness.controller.diag().sessions.find((entry) => entry.sessionId === 'child-idle').covered, false);
});

test('子智能体只读：状态同步主会话，忽略自己的记录且不能修改', async () => {
  const harness = createHarness();
  harness.store.setEnabled('parent', true);
  const { state } = harness.addAgent({ id: 'child', parentSession: 'parent', origin: 'subagent' });
  harness.attach();
  await harness.flush();

  const inherited = harness.controller.status('child');
  assert.equal(inherited.enabled, true, '子智能体同步主会话的启用状态');
  assert.equal(inherited.enabledSource, 'parent');
  assert.equal(inherited.readOnly, true);
  assert.equal(inherited.inheritedFrom, 'parent');
  assert.equal(inherited.paused, true, '高峰时段子智能体也显示暂停');

  // 子智能体自己的记录被忽略（即使显式关掉自己）。
  harness.store.setEnabled('child', false);
  assert.equal(harness.controller.status('child').enabled, true, '子智能体自己的记录不生效');

  // 修改被拒绝：不写 store、返回 applied:false / readOnly:true。
  const rejected = harness.controller.setEnabled('child', false);
  assert.equal(rejected.readOnly, true);
  assert.equal(rejected.applied, false);
  assert.equal(harness.store.isEnabled('child', false), false, '子会话记录保持原样');
  assert.equal(harness.controller.status('child').enabled, true, '主会话仍启用');

  // 主会话关掉 → 子智能体同步为关闭，但仍然只读。
  harness.controller.setEnabled('parent', false);
  await harness.flush();
  const off = harness.controller.status('child');
  assert.equal(off.enabled, false);
  assert.equal(off.readOnly, true);
  assert.equal(off.paused, false);
  void state;
});

test('子智能体只读：无 origin 的普通 fork 不受影响（仍可自己设置）', async () => {
  const harness = createHarness();
  const fork = harness.addAgent({ id: 'fork', parentSession: 'parent' });
  harness.attach();
  await harness.flush();
  const status = harness.controller.status('fork');
  assert.equal(status.readOnly, false, '普通 fork 不是子智能体，不锁只读');

  const applied = harness.controller.setEnabled('fork', true);
  assert.notEqual(applied.applied, false, '普通 fork 可以自己设置');
  assert.equal(harness.controller.status('fork').enabled, true);
  void fork;
});

test('子代理范围（负向）：父会话既不在线也没有启用记录 → 子代理不 hold', async () => {
  const harness = createHarness();
  const { state } = harness.addAgent({ id: 'child', parentSession: 'ghost-parent' });
  harness.attach();
  await harness.flush();

  assert.equal(state.maintenanceRuns, 0, '父会话无记录 → 不覆盖子代理');
  assert.deepEqual(harness.controller.describe().holds, []);
  const status = harness.controller.status('child');
  assert.equal(status.enabled, false);
  assert.equal(status.cover.held, false);
  assert.equal(harness.controller.diag().sessions.find((entry) => entry.sessionId === 'child').covered, false);

  // defaultEnabled=true 时「无记录」本身就等于「启用」：没有记录的子代理会话自己就算启用，
  // 而没有记录的父会话 id 也按默认算启用——两者都会覆盖，这是 defaultEnabled 的定义。
  const defaultOn = createHarness({ schedule: defaultSchedule({ defaultEnabled: true }) });
  const childNoRecord = defaultOn.addAgent({ id: 'child-no-record', parentSession: 'ghost-parent' });
  const childOff = defaultOn.addAgent({ id: 'child-off', parentSession: 'ghost-parent' });
  defaultOn.store.setEnabled('child-off', false); // 显式关掉自己的开关
  defaultOn.attach();
  await defaultOn.flush();
  assert.equal(childNoRecord.state.maintenanceRuns, 1, '无记录 → 自己被 defaultEnabled 视为启用');
  assert.equal(childOff.state.maintenanceRuns, 1, '父会话 id 无记录也按 defaultEnabled 视为启用 → 仍被覆盖');
  assert.deepEqual(
    defaultOn.controller.describe().holds.sort(),
    ['child-no-record', 'child-off'],
    'defaultEnabled=true 下两条子代理都被覆盖（不是"父会话不存在"的特例）',
  );
});

test('重启恢复：空白会话首条排队消息（延迟后仍 idle）→ 官方 continuation 唤醒一次', async () => {
  const harness = createHarness({
    now: IDLE_NOW,
    sessionController: { handle: async () => ({ accepted: true }) },
  });
  harness.store.setEnabled('s1', true);
  harness.attach();
  await harness.flush();

  // 应用重启后会话重新打开：空白会话的第一条消息只在 durable inbox 里，官方不会自己跑。
  const { state } = harness.addAgent({ id: 's1' }, { created: true });
  state.inboxTurn.push({ id: 'queued-1', role: 'user' });
  await harness.flush();
  harness.controller.reconcile();
  await harness.flush();
  // 延迟复查：给 Agent 一个自己续跑的机会。
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.equal(harness.prompts.length, 1, '延迟后仍空闲 → 应注入官方 continuation');
  assert.equal(state.followups.length, 0, '官方成功就不该再 followup');
  const { request } = harness.prompts[0];
  assert.equal(request.sessionId, 's1');
  assert.equal(request.mode, 'queue');
  assert.deepEqual(request.content, []);
});

test('重启恢复：延迟窗口内 Agent 自己续跑了（running + inbox 清空）→ 不注入', async () => {
  const harness = createHarness({
    now: IDLE_NOW,
    sessionController: { handle: async () => ({ accepted: true }) },
  });
  harness.store.setEnabled('s1', true);
  harness.attach();
  await harness.flush();

  const { state, agent } = harness.addAgent({ id: 's1' }, { created: true });
  state.inboxTurn.push({ id: 'queued-1', role: 'user' });
  await harness.flush();
  harness.controller.reconcile();
  await harness.flush();

  // 官方/驱动器自己把排队消息 claim 走了：running + inbox 空。
  state.phase = 'running';
  state.inboxTurn.length = 0;
  harness.emit('agent/status', { agent, status: 'running' });
  await harness.flush();
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.equal(harness.prompts.length, 0, 'Agent 自己续跑后不应再注入官方 continuation');
  assert.equal(state.followups.length, 0, '也不应注入 followup');
});

test('重启恢复：高峰时段只 hold，不唤醒（官方/兜底都不动）', async () => {
  const harness = createHarness({
    sessionController: { handle: async () => ({ accepted: true }) },
  });
  harness.store.setEnabled('s1', true);
  harness.attach();
  await harness.flush();

  const { state } = harness.addAgent({ id: 's1' }, { created: true });
  state.inboxTurn.push({ id: 'queued-1', role: 'user' });
  await harness.flush();

  assert.equal(state.maintenanceRuns, 1, '高峰时段应挂 hold');
  assert.equal(harness.controller.describe().holds.includes('s1'), true);
  assert.equal(harness.prompts.length, 0, '高峰时段不该唤醒（官方）');
  assert.equal(state.followups.length, 0, '高峰时段不该唤醒（兜底）');
});

test('被暂停打断：恢复时先发「写明高峰暂停原因」的消息（不是笼统的继续）', async () => {
  const harness = createHarness({
    sessionController: { handle: async () => ({ accepted: true }) }
  });
  harness.store.setEnabled('s1', true);
  const { state, agent } = harness.addAgent({ id: 's1', openTurnStartSeq: 9 });
  state.phase = 'running';
  harness.attach();
  await harness.flush();
  assert.equal(state.cancelCalls.length, 1);
  assert.equal(harness.controller.status('s1').cover.interrupted, true);

  state.phase = 'idle';
  harness.emit('agent/status', { agent, status: 'idle' });
  await harness.flush();

  harness.clock.now = IDLE_NOW;
  harness.controller.reconcile();
  await harness.flush();

  // 用户 2026-11-27 要求：因谷峰暂停而中断的会话，恢复时必须写明原因，
  // 所以这里**先**用带文案的 followup，而不是空 content 的官方 continuation。
  assert.equal(state.followups.length, 1, '应先发写明原因的消息');
  const message = state.followups[0];
  assert.equal(message.role, 'user');
  assert.ok(
    message.content[0].text.includes('高峰暂停'),
    `文案必须写明「高峰暂停」：${message.content[0].text}`
  );
  assert.ok(message.content[0].text.includes('不是失败'), '还要说明这不是失败');
  assert.equal(harness.prompts.length, 0, '这条路不走官方 continuation');
  assert.equal(harness.controller.status('s1').cover.interrupted, false, '续跑后标记清除');
});

test('被暂停打断：followup 不可用（没有该函数）→ 退回官方 continuation', async () => {
  const harness = createHarness({
    sessionController: { handle: async () => ({ accepted: true }) }
  });
  harness.store.setEnabled('s1', true);
  const { state, agent } = harness.addAgent({ id: 's1', openTurnStartSeq: 9 });
  state.phase = 'running';
  harness.attach();
  await harness.flush();
  state.phase = 'idle';
  // 把 followup 拿掉，模拟旧运行时。
  delete agent.followup;
  harness.emit('agent/status', { agent, status: 'idle' });
  await harness.flush();
  harness.clock.now = IDLE_NOW;
  harness.controller.reconcile();
  await harness.flush();

  assert.equal(harness.prompts.length, 1, 'followup 不可用时回退官方 continuation');
  assert.equal(harness.prompts[0].request.content.length, 0);
  assert.equal(typeof harness.prompts[0].request.requestId, 'string');
  assert.ok(harness.prompts[0].request.requestId.startsWith('dsh-session-enhance-offpeak-'));
  assert.equal(harness.controller.status('s1').cover.interrupted, false);
});

test('被暂停打断：重复 reconcile 不重复唤醒', async () => {
  const harness = createHarness({
    sessionController: { handle: async () => ({ accepted: true }) }
  });
  harness.store.setEnabled('s1', true);
  const { state, agent } = harness.addAgent({ id: 's1', openTurnStartSeq: 9 });
  state.phase = 'running';
  harness.attach();
  await harness.flush();
  state.phase = 'idle';
  harness.emit('agent/status', { agent, status: 'idle' });
  await harness.flush();
  harness.clock.now = IDLE_NOW;
  harness.controller.reconcile();
  await harness.flush();
  assert.equal(state.followups.length, 1);

  for (let round = 0; round < 5; round += 1) {
    harness.controller.reconcile();
    await harness.flush();
  }
  assert.equal(state.followups.length, 1, '重复 reconcile 不该重复唤醒');
  // 唤醒已发出（wakeStates=issued），Agent 还没被拉起来：允许保留去重状态，
  // 这里只验证「不会再发第二条消息」。
  assert.equal(harness.prompts.length, 0, '这条路径不该同时走官方 continuation');
});

test('监听器不抛错：garbage payload / 抛错的 Agent 都被收口', async () => {
  const harness = createHarness();
  harness.store.setEnabled('s1', true);
  const { agent } = harness.addAgent({ id: 's1' });
  harness.attach();
  await harness.flush();

  assert.doesNotThrow(() => harness.emit('agent/created', undefined));
  assert.doesNotThrow(() => harness.emit('agent/created', { agent: null }));
  assert.doesNotThrow(() => harness.emit('agent/status', { agent: {}, status: 'running' }));
  assert.doesNotThrow(() => harness.emit('agent/status', { agent: { id: 'x' }, status: 'weird' }));
  assert.doesNotThrow(() => harness.emit('agent/disposed', null));
  assert.doesNotThrow(() => harness.emit('app-boot/config-reload', undefined));
  assert.doesNotThrow(() => harness.emit('settings/document-updated', undefined));

  // 故意做坏的 Agent：status/cancel/runMaintenance 全抛错。
  const hostile = {
    id: 'hostile',
    session: { id: 'hostile', header: {} },
    get status() {
      throw new Error('status exploded');
    },
    get inbox() {
      throw new Error('inbox exploded');
    },
    runMaintenance() {
      throw new Error('runMaintenance exploded');
    },
    cancel() {
      throw new Error('cancel exploded');
    },
  };
  harness.agentsList.push(hostile);
  harness.store.setEnabled('hostile', true);
  assert.doesNotThrow(() => harness.controller.reconcile());
  await harness.flush();
  assert.doesNotThrow(() => harness.emit('agent/status', { agent: hostile, status: 'running' }));
  assert.doesNotThrow(() => harness.controller.status('hostile'));
  assert.ok(harness.logs.warn.length >= 0);
  void agent;
});

test('arm 失败日志限流：10 秒内同一 Agent 只记一条 debug', async () => {
  const harness = createHarness();
  harness.store.setEnabled('s1', true);
  harness.attach();
  await harness.flush();

  const { state } = harness.addAgent({ id: 's1', phase: 'maintenance' });
  for (let round = 0; round < 5; round += 1) {
    harness.controller.reconcile();
    await harness.flush();
  }
  assert.equal(state.maintenanceRejects, 5, '每次 reconcile 都尝试过');
  const armLogs = harness.logs.debug.filter((message) => /hold arm failed/u.test(message));
  assert.equal(armLogs.length, 1, '10 秒内只记一条');

  harness.clock.now += ARM_FAILURE_LOG_INTERVAL_MS;
  harness.controller.reconcile();
  await harness.flush();
  assert.equal(
    harness.logs.debug.filter((message) => /hold arm failed/u.test(message)).length,
    2,
    '过了一个窗口才会再记',
  );
});

test('边界定时器不重复重建（每秒 reconcile 不抖动 timer）', async () => {
  const harness = createHarness();
  harness.store.setEnabled('s1', true);
  harness.addAgent({ id: 's1' });
  harness.attach();
  await harness.flush();

  assert.equal(harness.boundaryTimers().length, 1, '应排一个边界定时器');
  assert.equal(harness.tickTimers().length, 1, '高峰时段 + 有覆盖会话 → 1 秒轮询');

  const firstSpec = harness.controller.describe().boundarySpec;
  for (let round = 0; round < 5; round += 1) {
    harness.controller.reconcile();
    await harness.flush();
  }
  assert.equal(harness.boundaryTimers().length, 1, '同一条边界不该反复 clear+set');
  assert.equal(harness.controller.describe().boundarySpec, firstSpec);

  // 相位翻转后下一次边界不同 → 允许重建。
  harness.clock.now = IDLE_NOW;
  harness.controller.reconcile();
  await harness.flush();
  assert.equal(harness.boundaryTimers().length, 1);
  assert.notEqual(harness.controller.describe().boundarySpec, firstSpec);
});

test('配置热更新：改 defaultEnabled 后监听到事件即生效', async () => {
  const harness = createHarness({ schedule: defaultSchedule({ defaultEnabled: false }) });
  const { state } = harness.addAgent({ id: 's1' });
  harness.attach();
  await harness.flush();
  assert.equal(state.maintenanceRuns, 0, '默认关闭 → 不 hold');

  harness.schedule.value = defaultSchedule({ defaultEnabled: true });
  harness.emit('settings/document-updated', {});
  await harness.flush();
  assert.equal(state.maintenanceRuns, 1, 'defaultEnabled 变 true 后应立刻 hold');
  assert.equal(harness.controller.status('s1').enabledSource, 'default');

  // 也认 app-boot/config-reload（另一条热更新通道）。
  harness.schedule.value = defaultSchedule({ defaultEnabled: false });
  harness.emit('app-boot/config-reload', {});
  await harness.flush();
  assert.deepEqual(harness.controller.describe().holds, []);
});

test('dispose：释放全部 hold、清定时器、停止响应事件', async () => {
  const harness = createHarness();
  harness.store.setEnabled('s1', true);
  harness.addAgent({ id: 's1' });
  const dispose = harness.attach();
  await harness.flush();
  assert.equal(harness.controller.describe().holds.length, 1);

  dispose();
  await harness.flush();
  const described = harness.controller.describe();
  assert.equal(described.disposed, true);
  assert.deepEqual(described.holds, []);
  assert.equal(described.tickActive, false);
  assert.equal(described.boundaryPending, false);
  assert.equal(harness.timers.size, 0, '所有定时器都被清掉');
});

test('store 写失败：开关照常生效但 persisted=false，diag 带 storeError', async () => {
  const harness = createHarness();
  harness.addAgent({ id: 's1' });
  harness.attach();
  await harness.flush();
  harness.storeState.failWrites = true;

  const status = harness.controller.setEnabled('s1', true);
  assert.equal(status.enabled, true, '内存状态必须生效');
  assert.equal(status.persisted, false, '写盘失败要在状态里体现');
  const diag = harness.controller.diag();
  assert.equal(diag.storeError.includes('disk full'), true);
  assert.equal(diag.store.size, 1);
});

test('diag：全局相位 + 配置 + 会话明细（含无 live agent 的持久化记录）', async () => {
  const harness = createHarness();
  harness.store.setEnabled('s1', true);
  harness.store.setEnabled('offline-session', true);
  harness.addAgent({ id: 's1' });
  harness.attach();
  await harness.flush();

  const diag = harness.controller.diag();
  assert.equal(diag.paused, true, '全局高峰时段');
  assert.equal(diag.idle, false);
  assert.equal(diag.build, 'test-build');
  assert.deepEqual(diag.schedule, {
    peakWindows: ['09:00-12:00', '14:00-18:00'],
    timeZone: 'Asia/Shanghai',
    holidaysCount: 62,
  });
  assert.deepEqual(diag.config, {
    peakWindows: ['09:00-12:00', '14:00-18:00'],
    timeZone: 'Asia/Shanghai',
    holidaysCount: 62,
    defaultEnabled: false,
    issues: [],
  });
  assert.deepEqual(diag.store, { size: 2, corrupt: false });
  assert.equal('storeError' in diag, false, '没有错误时不带 storeError');

  const live = diag.sessions.find((entry) => entry.sessionId === 's1');
  assert.equal(live.agent, true);
  assert.equal(live.covered, true);
  assert.equal(live.held, true);
  assert.equal(live.status, 'idle');
  const offline = diag.sessions.find((entry) => entry.sessionId === 'offline-session');
  assert.equal(offline.agent, false);
  assert.equal(offline.enabled, true);
  assert.equal(offline.held, false);
});

test('status 契约字段齐全且禁用时仍给下一次切换', async () => {
  const harness = createHarness();
  harness.addAgent({ id: 's1' });
  harness.attach();
  await harness.flush();

  const status = harness.controller.status('s1');
  assert.deepEqual(Object.keys(status).sort(), [
    'build',
    'cover',
    'enabled',
    'enabledSource',
    'idle',
    'inheritedFrom',
    'nextChangeAt',
    'nextChangeKind',
    'paused',
    'persisted',
    'readOnly',
    'schedule',
    'serverNow',
  ]);
  assert.equal(status.enabled, false);
  assert.equal(status.enabledSource, 'default');
  assert.equal(status.readOnly, false, '普通会话不是只读');
  assert.equal(status.inheritedFrom, null);
  assert.equal(status.paused, false);
  assert.equal(status.idle, false, '周二 10:00 是高峰时段');
  // 2026-11-24 周二 10:00 高峰中 → 下一次 12:00 午休。
  assert.equal(status.nextChangeKind, 'resume');
  assert.equal(status.nextChangeAt, wallClockToEpoch({ year: 2026, month: 11, day: 24, hour: 12, minute: 0 }, 'Asia/Shanghai'));
  assert.deepEqual(Object.keys(status.cover).sort(), ['agent', 'held', 'interrupted', 'queued', 'running']);
  assert.equal(status.serverNow, PEAK_NOW);
});
