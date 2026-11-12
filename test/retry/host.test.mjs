/**
 * `index.js`（Host 半）的集成式单元测试。
 *
 * 用一个最小 mock ctx 驱动真实的 `apply()`：事件注册、`ctx.inject` 的 RPC 通道
 * 注册、以及 `agent/request-error` 监听器的返回语义都在这里跑一遍。
 *
 * ## 被测试的核心语义
 *
 * `agent/request-error` 是**每次**模型 attempt 失败都会触发的 waterfall，DSH 自己
 * 的自动重试策略挂在它下游。所以监听器必须：
 *
 * 1. 先调 `next()` 问下游还愿不愿意重试 —— 愿意就直接放行（不打扰用户）；
 * 2. 下游放弃（真正最终失败）才挂住等用户点「重试」；
 * 3. 「放弃」时**不调 next()**，返回 undefined 才能真的结束这一轮（调用 next 会
 *    把决策交回自动重试策略）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTINUE_PROMPT,
  createRetryUserMessage,
  detectRootAgent,
  installTurnRetry as apply,
  sessionIdOf,
  shouldGate,
} from '../../lib/retry/host.mjs';
import { RPC_CHANNEL } from '../../lib/retry/rpc.mjs';

/**
 * 造一个可用的 mock Agent。
 *
 * @param {string} sessionId - 会话 id。
 * @returns {object} agent。
 */
function makeAgent(sessionId) {
  return { session: { id: sessionId } };
}

/**
 * 造一个 mock Cordis ctx，并捕获注册的监听器与路由。
 *
 * @param {object} [options] - 环境开关。
 * @param {boolean} [options.hasLiveClient] - typertGateway.hasLiveClient 的返回值。
 * @param {object[] | undefined} [options.roots] - agents.roots() 的返回值；undefined 表示不提供该服务。
 * @param {object} [options.agents] - 直接替换 agents 服务（测 0.2.2-rc.2 形状用，可省略 roots）。
 * @param {object} [options.subagents] - subagents 服务（0.2.2-rc.2 的 rootOf 判根用）。
 * @param {boolean} [options.provideGateway] - 是否提供 typertGateway 服务。
 * @returns {{ ctx: object, handlers: Map<string, Function>, routes: object[], runCleanups: Function }} mock 环境。
 */
function makeCtx(options = {}) {
  const handlers = new Map();
  const routes = [];
  const cleanups = [];

  const services = {
    agents:
      options.agents !== undefined
        ? options.agents
        : options.roots === undefined && options.agent === undefined
          ? undefined
          : {
              roots: () => options.roots ?? (options.agent === undefined ? [] : [options.agent]),
              // driveRetry 走 `agents.get(id)` 拿 live agent；真实服务有这个入口。
              get: (id) => (options.agent !== undefined && options.agent.session?.id === id ? options.agent : undefined),
            },
    subagents: options.subagents,
    typertGateway:
      options.provideGateway === false
        ? undefined
        : {
            hasLiveClient: () => options.hasLiveClient === true,
          },
    connection: {
      admit: () => ({ peer: {} }),
      rpc: {
        handle: () => {
          throw new Error('rpc.handle fallback should not be used when webServer.register works');
        },
      },
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
  };

  const ctx = {
    logger: { info: () => {}, debug: () => {} },
    // Cordis 里服务既可以通过 `ctx.get(name)` 软取，也可以作为属性直取；
    // 两种形态都给上，才和真实 ctx 一致。
    ...services,
    get(name) {
      return services[name];
    },
    on(name, handler) {
      handlers.set(name, handler);
      return () => {};
    },
    inject(_names, callback) {
      // 真实 Cordis 是"服务就绪后回调"；这里同步回调即可，服务都在。
      callback(ctx);
      return () => {};
    },
    effect(factory, _label) {
      const cleanup = factory();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return () => {};
    },
  };

  return {
    ctx,
    handlers,
    routes,
    /** 跑一遍 effect 清理（模拟插件卸载）。 */
    runCleanups: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

/**
 * 造一个 mock HTTP request（`for await` 可读）。
 *
 * @param {object} body - 请求 JSON。
 * @returns {object} 近似 IncomingMessage。
 */
function makeRequest(body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    method: 'POST',
    url: `${RPC_CHANNEL}/`,
    on: () => {},
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  };
}

/**
 * 造一个 mock HTTP response，收集状态码与 body。
 *
 * @returns {object} 近似 ServerResponse。
 */
function makeResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(text) {
      this.body = text ?? '';
    },
  };
}

/**
 * 通过捕获到的 prefix 路由真的发一次 RPC 请求。
 *
 * @param {object[]} routes - 捕获的路由。
 * @param {string} method - endpoint。
 * @param {unknown} payload - payload。
 * @returns {Promise<object>} 服务端 result 信封。
 */
async function callRpc(routes, method, payload) {
  const route = routes.find((item) => item.path === RPC_CHANNEL);
  assert.ok(route, 'RPC prefix route should be registered');
  const req = makeRequest({ type: 'client-request', rpcId: 'r1', method, payload });
  const res = makeResponse();
  await route.handler(req, res);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.type, 'server-response');
  assert.equal(parsed.rpcId, 'r1');
  return parsed.result;
}

/**
 * 造一次失败 payload。
 *
 * @param {object} agent - mock agent。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {object} payload。
 */
function makePayload(agent, signal) {
  const controller = signal === undefined ? new AbortController() : undefined;
  return {
    agent,
    turn: 1,
    step: 1,
    provider: 'deepseek',
    failure: { code: 'TRANSPORT', message: 'Connection error.' },
    retryPolicy: undefined,
    signal: signal ?? controller.signal,
  };
}

/**
 * 造一个"下游自动重试策略"的 next。
 *
 * @param {'retry' | 'give-up'} behavior - 下游是否还愿意重试。
 * @returns {{ next: Function, calls: () => number }} next 与调用计数。
 */
function makeNext(behavior) {
  const state = { calls: 0 };
  return {
    next: async () => {
      state.calls += 1;
      return behavior === 'retry' ? { kind: 'retry' } : undefined;
    },
    calls: () => state.calls,
  };
}

test('sessionIdOf 兼容 id / sessionId 两种字段', () => {
  assert.equal(sessionIdOf({ session: { id: 'a' } }), 'a');
  assert.equal(sessionIdOf({ session: { sessionId: 'b' } }), 'b');
  assert.equal(sessionIdOf({ session: {} }), '');
  assert.equal(sessionIdOf(undefined), '');
});

test('shouldGate：无客户端、子代理、已取消、服务缺失都不拦', () => {
  const rootAgent = makeAgent('root');

  const offline = makeCtx({ hasLiveClient: false, roots: [rootAgent] });
  assert.equal(shouldGate(offline.ctx, makePayload(rootAgent)), false);

  const child = makeAgent('child');
  const withChild = makeCtx({ hasLiveClient: true, roots: [rootAgent] });
  assert.equal(shouldGate(withChild.ctx, makePayload(child)), false);

  const aborted = makeCtx({ hasLiveClient: true, roots: [rootAgent] });
  const controller = new AbortController();
  controller.abort();
  assert.equal(shouldGate(aborted.ctx, makePayload(rootAgent, controller.signal)), false);

  // fail-closed：探测服务缺失时不挂起（headless / 未知部署形态的保护）。
  const noGateway = makeCtx({ hasLiveClient: true, roots: [rootAgent], provideGateway: false });
  assert.equal(shouldGate(noGateway.ctx, makePayload(rootAgent)), false);

  const ok = makeCtx({ hasLiveClient: true, roots: [rootAgent] });
  assert.equal(shouldGate(ok.ctx, makePayload(rootAgent)), true);
});

test('shouldGate：0.2.2-rc.2 移除了 agents.roots()，用 subagents.rootOf 判根仍能正确否决子代理', () => {
  const rootAgent = makeAgent('root');
  const childAgent = makeAgent('child');
  // rc.2 的 agents 服务没有 roots()，只有 get()/list()/enter() 等。
  const rc2Agents = { get: () => undefined, list: () => [rootAgent, childAgent] };
  const subagents = {
    // rootOf 返回 agent 所在子智能体树的 live root：子代理返回 rootAgent，root 返回自己。
    rootOf: (agent) => (agent === childAgent ? rootAgent : agent),
  };

  const env = makeCtx({ hasLiveClient: true, agents: rc2Agents, subagents });
  assert.equal(shouldGate(env.ctx, makePayload(rootAgent)), true);
  assert.equal(shouldGate(env.ctx, makePayload(childAgent)), false);

  // 探测快照要能看出走的是哪一代判根信号。
  const verdict = detectRootAgent(env.ctx, childAgent);
  assert.equal(verdict.root, false);
  assert.equal(verdict.probe.via, 'subagents.rootOf');
});

test('detectRootAgent：两个服务都缺时用会话头兜底（子代理否决、fork 会话仍算根）', () => {
  const subagentAgent = { session: { id: 'sub', header: { origin: 'subagent', parentSession: 'root' } } };
  const forkAgent = { session: { id: 'fork', header: { parentSession: 'root' } } };
  const bareAgent = { session: { id: 'bare' } };
  const env = makeCtx({ hasLiveClient: true });

  assert.deepEqual(
    [subagentAgent, forkAgent, bareAgent].map((agent) => detectRootAgent(env.ctx, agent).root),
    // bareAgent 没有 session.header（真实 Agent 必有），无法判定时返回 undefined，
    // 调用方不据此否决——保守等于"按钮可能出现"，不会误伤根会话。
    [false, true, undefined],
  );
  assert.equal(detectRootAgent(env.ctx, undefined).root, undefined);
});

test('detectRootAgent：rc.1 的 agents.roots() 优先，行为保持不变', () => {
  const rootAgent = makeAgent('root');
  const childAgent = makeAgent('child');
  const env = makeCtx({
    hasLiveClient: true,
    roots: [rootAgent],
    subagents: { rootOf: () => rootAgent },
  });
  const verdict = detectRootAgent(env.ctx, rootAgent);
  assert.equal(verdict.root, true);
  assert.equal(verdict.probe.via, 'agents.roots');
  assert.equal(verdict.probe.count, 1);
});

test('apply 注册 agent/request-error 监听器与 RPC 前缀路由', () => {
  const env = makeCtx({ hasLiveClient: true, roots: [] });
  apply(env.ctx);
  assert.equal(typeof env.handlers.get('agent/request-error'), 'function');
  assert.ok(env.routes.some((route) => route.path === RPC_CHANNEL));
});

test('下游自动重试还愿意重试时直接放行，不挂起、不显示按钮', async () => {
  const agent = makeAgent('s0');
  const env = makeCtx({ hasLiveClient: true, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const downstream = makeNext('retry');
  const action = await handler(makePayload(agent), downstream.next);

  assert.deepEqual(action, { kind: 'retry' });
  assert.equal(downstream.calls(), 1);
  const list = await callRpc(env.routes, 'list', {});
  assert.deepEqual(list.value.gates, []);
  env.runCleanups();
});

test('自动重试耗尽后挂住，经 RPC retry 返回 { kind: "retry" }', async () => {
  const agent = makeAgent('s1');
  const env = makeCtx({ hasLiveClient: true, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const downstream = makeNext('give-up');

  const pending = handler(makePayload(agent), downstream.next);
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, '自动重试耗尽后应该挂住等用户点击');

  // 浏览器半查询：确实在等。
  const before = await callRpc(env.routes, 'pending', { sessionId: 's1' });
  assert.equal(before.ok, true);
  assert.equal(before.value.pending, true);
  assert.deepEqual(before.value.gate.failure, { code: 'TRANSPORT', message: 'Connection error.' });

  // 用户点「重试」。
  const retried = await callRpc(env.routes, 'retry', { sessionId: 's1' });
  assert.deepEqual(retried, { ok: true, value: { retried: true, via: 'gate' } });

  assert.deepEqual(await pending, { kind: 'retry' });
  assert.equal(downstream.calls(), 1, '只问一次下游，重试由我们直接回复 loop');
  env.runCleanups();
});

test('RPC cancel 返回 undefined（不把决策交回自动重试）', async () => {
  const agent = makeAgent('s2');
  const env = makeCtx({ hasLiveClient: true, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const downstream = makeNext('give-up');

  const pending = handler(makePayload(agent), downstream.next);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const canceled = await callRpc(env.routes, 'cancel', { sessionId: 's2' });
  assert.deepEqual(canceled, { ok: true, value: { canceled: true } });

  assert.equal(await pending, undefined);
  assert.equal(downstream.calls(), 1, '放弃之后不能再调用下游（否则自动重试会继续）');
  env.runCleanups();
});

test('signal abort 会让监听器立刻收尾', async () => {
  const agent = makeAgent('s3');
  const env = makeCtx({ hasLiveClient: true, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const controller = new AbortController();
  const downstream = makeNext('give-up');

  const pending = handler(makePayload(agent, controller.signal), downstream.next);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  assert.equal(await pending, undefined);
  env.runCleanups();
});

test('插件卸载（effect 清理）会放行挂起的 turn', async () => {
  const agent = makeAgent('s4');
  const env = makeCtx({ hasLiveClient: true, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const downstream = makeNext('give-up');
  const pending = handler(makePayload(agent), downstream.next);
  await new Promise((resolve) => setTimeout(resolve, 10));

  env.runCleanups();
  assert.equal(await pending, undefined);
});

test('不该拦的情况直接 next()，不会打开闸门', async () => {
  const agent = makeAgent('s5');
  const env = makeCtx({ hasLiveClient: false, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const downstream = makeNext('retry');
  assert.deepEqual(await handler(makePayload(agent), downstream.next), { kind: 'retry' });
  assert.equal(downstream.calls(), 1);

  const result = await callRpc(env.routes, 'pending', { sessionId: 's5' });
  assert.deepEqual(result, { ok: true, value: { pending: false, recoverable: null } });
  env.runCleanups();
});

test('同一会话重复失败不会堆积多个闸门（旧的被 superseded）', async () => {
  const agent = makeAgent('s6');
  const env = makeCtx({ hasLiveClient: true, roots: [agent] });
  apply(env.ctx);

  const handler = env.handlers.get('agent/request-error');
  const downstream = makeNext('give-up');
  const first = handler(makePayload(agent), downstream.next);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = handler(makePayload(agent), downstream.next);
  await new Promise((resolve) => setTimeout(resolve, 10));

  // 旧的已放行（superseded），新的还在等。
  assert.equal(await first, undefined);
  const pending = await callRpc(env.routes, 'pending', { sessionId: 's6' });
  assert.equal(pending.value.pending, true);

  await callRpc(env.routes, 'cancel', { sessionId: 's6' });
  assert.equal(await second, undefined);
  env.runCleanups();
});

test('上下文窗口溢出不给重试按钮/不记 recovery（重试只会再次超长）', async () => {
  const rootAgent = makeAgent('root');
  const env = makeCtx({ hasLiveClient: true, roots: [rootAgent], agent: rootAgent });
  apply(env.ctx);

  // 1) 闸门判定：CONTEXT_WINDOW_EXCEEDED 直接否决。
  const overflowPayload = makePayload(rootAgent);
  overflowPayload.failure = { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' };
  const verdict = shouldGate(env.ctx, overflowPayload);
  assert.equal(verdict, false);

  // 2) turn 以 CONTEXT_WINDOW_EXCEEDED 收尾时不写 recovery（否则按钮会引导再发一次超长输入）。
  env.handlers.get('session/event')({ id: 'root' }, {
    type: 'turn/end',
    data: {
      turn: 7,
      reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' } },
    },
  });
  const pending = await callRpc(env.routes, 'pending', { sessionId: 'root' });
  assert.equal(pending.value.recoverable, null);
  env.runCleanups();
});

test('createRetryUserMessage 是完整的 DSH UserMessage（role 不能漏，且 id 每次唯一）', () => {
  const first = createRetryUserMessage();
  const second = createRetryUserMessage();

  // DSH 0.2.2 的 `agent.followup(input: UserMessage)` 形状：
  // `{ id, role: 'user', content, source }`。少 role 时事件仍会落进日志，
  // 但 dsh-session 在 seed/load 边界会拒绝它，整条会话从此读不出来。
  assert.equal(first.role, 'user');
  assert.equal(typeof first.id, 'string');
  assert.ok(first.id.length > 0);
  assert.deepEqual(first.content, [{ type: 'text', text: CONTINUE_PROMPT }]);
  assert.deepEqual(first.source, { kind: 'user' });
  assert.notEqual(first.id, second.id, 'inbox 按 message.id 去重，重复会抛 already pending');
});

test('停止后重试：followup 拿到的消息带 role="user"（0.2.2 日志校验要求）', async () => {
  const captured = [];
  const agent = {
    session: { id: 's7' },
    async followup(input) {
      captured.push(input);
    },
  };
  const env = makeCtx({ hasLiveClient: true, roots: [agent], agent });
  apply(env.ctx);

  // 记录一次「用户点了停止」：turn/end 的 reason 是 aborted + user。
  env.handlers.get('session/event')({ id: 's7' }, {
    type: 'turn/end',
    data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  });

  const pending = await callRpc(env.routes, 'pending', { sessionId: 's7' });
  assert.equal(pending.value.recoverable?.turn, 3);

  const retried = await callRpc(env.routes, 'retry', { sessionId: 's7' });
  assert.deepEqual(retried, { ok: true, value: { retried: true, via: 'followup' } });

  assert.equal(captured.length, 1);
  const input = captured[0];
  assert.equal(input.role, 'user');
  assert.deepEqual(input.content, [{ type: 'text', text: CONTINUE_PROMPT }]);
  assert.deepEqual(input.source, { kind: 'user' });
  assert.equal(typeof input.id, 'string');
  env.runCleanups();
});

test('模型失败后 turn 以 error 结束：记下 recovery，之后回到该会话仍能重试', async () => {
  const captured = [];
  const agent = {
    session: { id: 's8' },
    async followup(input) {
      captured.push(input);
    },
  };
  const env = makeCtx({ hasLiveClient: true, roots: [agent], agent });
  apply(env.ctx);

  // 模型失败、闸门已关闭（超时/孤儿保护）之后，turn 以 error 收尾。
  env.handlers.get('session/event')({ id: 's8' }, {
    type: 'turn/end',
    data: {
      turn: 9,
      reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'Connection error.' } },
    },
  });

  // 浏览器半随后问 pending：没有闸门，但有 recoverable，且指明原因。
  const pending = await callRpc(env.routes, 'pending', { sessionId: 's8' });
  assert.equal(pending.value.pending, false);
  assert.equal(pending.value.recoverable?.turn, 9);
  assert.equal(pending.value.recoverable?.causeKind, 'error');

  // 点重试：只能驱动一次新的 turn（followup），消息形状与停止路径一致。
  const retried = await callRpc(env.routes, 'retry', { sessionId: 's8' });
  assert.deepEqual(retried, { ok: true, value: { retried: true, via: 'followup' } });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].role, 'user');

  // 用掉之后不再可重试。
  const after = await callRpc(env.routes, 'pending', { sessionId: 's8' });
  assert.equal(after.value.recoverable, null);
  env.runCleanups();
});

test('新 turn 开始会清掉上一条错误 recovery（不会一直挂着按钮）', async () => {
  const agent = { session: { id: 's9' } };
  const env = makeCtx({ hasLiveClient: true, roots: [agent], agent });
  apply(env.ctx);

  env.handlers.get('session/event')({ id: 's9' }, {
    type: 'turn/end',
    data: { turn: 4, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'x' } } },
  });
  assert.equal((await callRpc(env.routes, 'pending', { sessionId: 's9' })).value.recoverable?.turn, 4);

  env.handlers.get('session/event')({ id: 's9' }, { type: 'turn/start', data: { turn: 5 } });
  assert.equal((await callRpc(env.routes, 'pending', { sessionId: 's9' })).value.recoverable, null);
  env.runCleanups();
});
