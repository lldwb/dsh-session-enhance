/**
 * 上下文用量 + 手动压缩（Host 半）的离线测试。
 *
 * 覆盖两件事：
 * 1. `createContextHandler` 的业务语义（用量字段、压缩成功/失败码映射、软依赖缺失）；
 * 2. `installContextChannel` 的 RPC 信封与认证（真实 prefix 路由 + 假 req/res）。
 *
 * 不碰真实 DSH 运行时：tokenMeter / compaction / agents 都是 mock。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_RPC_CHANNEL,
  createContextHandler,
  installContextChannel,
  MANUAL_COMPACT_TIMEOUT_MS,
  MAX_RPC_BODY_BYTES
} from '../lib/context/host.mjs';

/**
 * 造一个 mock 插件上下文。
 *
 * @param {{ pressure?: object, compaction?: object, agent?: object, meter?: object, admit?: Function }} [options] - 服务与路由开关。
 * @returns {{ ctx: object, routes: object[], runCleanups: Function }} mock 环境。
 */
function makeCtx(options = {}) {
  const routes = [];
  const cleanups = [];
  const services = {
    agents:
      options.agent === undefined
        ? undefined
        : {
            get: (id) => (options.agent.session?.id === id ? options.agent : undefined)
          },
    tokenMeter:
      options.meter !== undefined
        ? options.meter
        : options.pressure === undefined
          ? undefined
          : { contextPressure: () => options.pressure },
    compaction: options.compaction,
    commands: options.commands,
    connection: {
      admit: options.admit ?? (() => ({ peer: {} })),
      rpc: {
        handle: () => {
          throw new Error('rpc.handle fallback must not be used when webServer.register works');
        }
      }
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      }
    }
  };
  const ctx = {
    logger: { info: () => {}, debug: () => {} },
    // Cordis 里服务既可 `ctx.get(name)` 软取，也可作为 scope 上的属性直取；
    // `installContextChannel` 的 `ctx.inject(['connection','webServer'], cb)` 回调里
    // 拿到的正是属性形态，所以两种都给上。
    ...services,
    get(name) {
      return services[name];
    },
    inject(_names, callback) {
      callback(ctx);
      return () => {};
    },
    effect(factory) {
      const cleanup = factory();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return () => {};
    }
  };
  return {
    ctx,
    routes,
    runCleanups: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    }
  };
}

/** 一个 live agent。 */
const agent = { session: { id: 's1' } };

test('get：返回压力与窗口，并说明压缩是否可用', async () => {
  const env = makeCtx({
    agent,
    pressure: { pressureTokens: 512_000, contextWindow: 1_048_576 },
    compaction: { compactNow: () => {} }
  });
  const handle = createContextHandler({ ctx: env.ctx });
  const result = await handle('get', { sessionId: 's1' });
  assert.deepEqual(result, {
    ok: true,
    value: {
      available: true,
      pressureTokens: 512_000,
      contextWindow: 1_048_576,
      canCompact: true,
      autoCompact: false,
      pruneRatio: null,
      compactRatio: null,
      warningRatio: null,
      canPrune: false,
      effectiveWindow: null,
      autoFailures: 0,
      breakerOpen: false
    }
  });
});

test('get：没有 live agent / 没有 tokenMeter 时返回 available:false', async () => {
  const noAgent = makeCtx({ pressure: { pressureTokens: 1, contextWindow: 2 } });
  assert.equal(
    (await createContextHandler({ ctx: noAgent.ctx })('get', { sessionId: 'nope' })).value.reason,
    'NO_LIVE_AGENT'
  );

  const noMeter = makeCtx({ agent });
  assert.equal(
    (await createContextHandler({ ctx: noMeter.ctx })('get', { sessionId: 's1' })).value.reason,
    'NO_TOKEN_METER'
  );
});

test('get：缺 sessionId 返回 BAD_REQUEST', async () => {
  const env = makeCtx({ agent });
  const result = await createContextHandler({ ctx: env.ctx })('get', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'BAD_REQUEST');
});

test('compact：成功时返回压缩条数与释放 token 数', async () => {
  const calls = [];
  const env = makeCtx({
    agent,
    compaction: {
      compactNow: async (target, signal, commandId) => {
        calls.push({ target, signal, commandId });
        return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 4_200 };
      }
    }
  });
  const result = await createContextHandler({ ctx: env.ctx })('compact', { sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    compacted: true,
    via: 'service',
    items: 3,
    tokensSaved: 4_200,
    pruned: 0,
    charsRemoved: 0
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, agent);
  assert.equal(calls[0].commandId, 'dsh-session-enhance-context');
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('compact：没有可压缩范围时返回 compacted:false', async () => {
  const env = makeCtx({ agent, compaction: { compactNow: async () => null } });
  const result = await createContextHandler({ ctx: env.ctx })('compact', { sessionId: 's1' });
  assert.deepEqual(result, {
    ok: true,
    value: { compacted: false, reason: 'NO_RANGE', via: 'service', pruned: 0, charsRemoved: 0 }
  });
});

test('compact：压缩插件没挂载时返回 COMPACTION_UNAVAILABLE（不静默失败）', async () => {
  const env = makeCtx({ agent });
  const result = await createContextHandler({ ctx: env.ctx })('compact', { sessionId: 's1' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'COMPACTION_UNAVAILABLE');
});

test('compact：busy / summary 等 ManualCompactionError 映射成稳定机器码', async () => {
  for (const [raw, expected] of [
    ['busy', 'BUSY'],
    ['cancelled', 'CANCELLED'],
    ['changed', 'CHANGED'],
    ['summary', 'SUMMARY_FAILED'],
    ['commit', 'COMMIT_FAILED'],
    ['persistence', 'PERSISTENCE_FAILED'],
    ['weird', 'COMPACT_FAILED']
  ]) {
    const env = makeCtx({
      agent,
      compaction: {
        compactNow: async () => {
          const error = new Error('mock');
          error.code = raw;
          throw error;
        }
      }
    });
    const result = await createContextHandler({ ctx: env.ctx })('compact', { sessionId: 's1' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, expected, `raw code ${raw}`);
  }
});

test('compact：没有 live agent 时不调 compaction', async () => {
  let called = 0;
  const env = makeCtx({ compaction: { compactNow: async () => { called += 1; return null; } } });
  const result = await createContextHandler({ ctx: env.ctx })('compact', { sessionId: 'gone' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NO_LIVE_AGENT');
  assert.equal(called, 0);
});

test('diag：报告软依赖是否在场与超时配置', async () => {
  const env = makeCtx({ agent, compaction: { compactNow: () => {} }, pressure: {} });
  const result = await createContextHandler({ ctx: env.ctx })('diag', {});
  assert.deepEqual(result.value, {
    hasCompaction: true,
    hasTokenMeter: true,
    hasCommand: false,
    hasPruner: false,
    timeoutMs: MANUAL_COMPACT_TIMEOUT_MS
  });
});

test('compact：优先执行官方 /compact 命令（与用户输入走同一条链路），并解析结果', async () => {
  const executed = [];
  const env = makeCtx({
    agent,
    compaction: { compactNow: async () => { throw new Error('should prefer the command'); } },
    commands: {
      execute: async (target, line, attachments, signal) => {
        executed.push({ target, line, attachments, signal });
        return {
          commandId: 'cmd-1',
          result: { kind: 'success', text: 'Compacted 12 history items (~4,200 tokens).', sourceEventSeq: 9 }
        };
      }
    }
  });
  const result = await createContextHandler({ ctx: env.ctx })('compact', { sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    compacted: true,
    via: 'command',
    text: 'Compacted 12 history items (~4,200 tokens).',
    items: 12,
    tokensSaved: 4200,
    pruned: 0,
    charsRemoved: 0
  });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].target, agent);
  assert.equal(executed[0].line, '/compact');
  assert.deepEqual(executed[0].attachments, []);
  assert.ok(executed[0].signal instanceof AbortSignal);
});

test('compact：命令返回「没有可压缩历史」时不当作成功', async () => {
  const env = makeCtx({
    agent,
    commands: {
      execute: async () => ({ commandId: 'cmd-2', result: { kind: 'success', text: 'No compactable history yet.' } })
    }
  });
  const result = await createContextHandler({ ctx: env.ctx })('compact', { sessionId: 's1' });
  assert.deepEqual(result, {
    ok: true,
    value: {
      compacted: false,
      reason: 'NO_RANGE',
      via: 'command',
      text: 'No compactable history yet.',
      pruned: 0,
      charsRemoved: 0
    }
  });
});

test('compact：命令失败文案映射回稳定错误码（busy / summary / changed …）', async () => {
  const cases = [
    ['Compaction is unavailable because this process has an active compaction, or the agent is not idle.', 'BUSY'],
    ['Compaction cancelled.', 'CANCELLED'],
    ['The history selected for compaction changed before it could be replaced. The attempt is recorded in the session log.', 'CHANGED'],
    ['Compaction could not produce a useful summary. The attempt is recorded in the session log.', 'SUMMARY_FAILED'],
    ['Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.', 'COMMIT_FAILED'],
    ['Compaction finished, but the session could not be saved.', 'PERSISTENCE_FAILED'],
    ['something else entirely', 'COMPACT_FAILED']
  ];
  for (const [text, expected] of cases) {
    const env = makeCtx({
      agent,
      commands: { execute: async () => ({ commandId: 'cmd-x', result: { kind: 'error', text } }) }
    });
    const result = await createContextHandler({ ctx: env.ctx })('compact', { sessionId: 's1' });
    assert.equal(result.ok, false, text);
    assert.equal(result.error.code, expected, text);
    assert.equal(result.error.details.via, 'command', text);
  }
});

test('compact：命令未注册（execute 返回 undefined）时回退到 compaction.compactNow', async () => {
  let called = 0;
  const env = makeCtx({
    agent,
    compaction: {
      compactNow: async () => {
        called += 1;
        return { shadowedSeqs: [1, 2], shadowedTokenCount: 900 };
      }
    },
    commands: { execute: async () => undefined }
  });
  const result = await createContextHandler({ ctx: env.ctx })('compact', { sessionId: 's1' });
  assert.equal(called, 1);
  assert.deepEqual(result, {
    ok: true,
    value: { compacted: true, via: 'service', items: 2, tokensSaved: 900, pruned: 0, charsRemoved: 0 }
  });
});

/** 造一个 mock HTTP request。 */
function makeRequest(body, init = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    method: init.method ?? 'POST',
    url: init.url ?? `${CONTEXT_RPC_CHANNEL}/get`,
    async *[Symbol.asyncIterator]() {
      yield payload;
    }
  };
}

/** 造一个 mock HTTP response。 */
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
    }
  };
}

test('installContextChannel：注册 prefix 路由并回传标准 server-response 信封', async () => {
  const env = makeCtx({
    agent,
    pressure: { pressureTokens: 100, contextWindow: 1_000 }
  });
  installContextChannel(env.ctx, createContextHandler({ ctx: env.ctx }));
  const route = env.routes.find((item) => item.path === CONTEXT_RPC_CHANNEL);
  assert.ok(route, 'prefix route should be registered');

  const req = makeRequest({ type: 'client-request', rpcId: 'r1', method: 'get', payload: { sessionId: 's1' } }, { url: `${CONTEXT_RPC_CHANNEL}/get` });
  const res = makeResponse();
  await route.handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.type, 'server-response');
  assert.equal(parsed.rpcId, 'r1');
  assert.equal(parsed.result.ok, true);
  assert.equal(parsed.result.value.canCompact, false);
  env.runCleanups();
});

test('installContextChannel：非 POST 404、认证拒绝透传状态码', async () => {
  const env = makeCtx({ agent, pressure: {} });
  installContextChannel(env.ctx, createContextHandler({ ctx: env.ctx }));
  const route = env.routes.find((item) => item.path === CONTEXT_RPC_CHANNEL);

  const getRes = makeResponse();
  await route.handler(makeRequest({}, { method: 'GET' }), getRes);
  assert.equal(getRes.statusCode, 404);

  const rejecting = makeCtx({ agent, pressure: {}, admit: () => ({ rejection: 401 }) });
  installContextChannel(rejecting.ctx, createContextHandler({ ctx: rejecting.ctx }));
  const rejectRoute = rejecting.routes.find((item) => item.path === CONTEXT_RPC_CHANNEL);
  const rejectRes = makeResponse();
  await rejectRoute.handler(makeRequest({}), rejectRes);
  assert.equal(rejectRes.statusCode, 401);
  rejecting.runCleanups();
  env.runCleanups();
});

test('RPC 常量：通道名与请求体上限是稳定契约', () => {
  assert.equal(CONTEXT_RPC_CHANNEL, '/dsh-session-enhance-context');
  assert.equal(MAX_RPC_BODY_BYTES, 32 * 1024);
});

test('get：driver 提供自动压缩状态、阈值与修剪器可用性', async () => {
  const env = makeCtx({ agent, pressure: { pressureTokens: 100, contextWindow: 1_000 } });
  const driver = {
    describe: () => ({ autoCompact: true, pruneRatio: 0.6, compactRatio: 0.8, warningRatio: 0.9 }),
    prunerFor: () => ({ pruneSession: () => ({ pruned: [], charsRemoved: 0 }) }),
    statusFor: () => ({ autoFailures: 2, breakerOpen: true, effectiveWindow: 800 })
  };
  const result = await createContextHandler({ ctx: env.ctx, driver })('get', { sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.equal(result.value.autoCompact, true);
  assert.equal(result.value.pruneRatio, 0.6);
  assert.equal(result.value.compactRatio, 0.8);
  assert.equal(result.value.warningRatio, 0.9);
  assert.equal(result.value.canPrune, true);
  assert.equal(result.value.effectiveWindow, 800);
  assert.equal(result.value.autoFailures, 2);
  assert.equal(result.value.breakerOpen, true);
});

test('compact：先批量修剪工具输出（L1），再执行压缩（L2），并回报 pruned', async () => {
  const env = makeCtx({
    agent,
    compaction: {
      compactNow: async () => ({ shadowedSeqs: [1, 2], shadowedTokenCount: 900 })
    }
  });
  const driver = {
    compactionFor: () => env.ctx.compaction,
    commandsFor: () => undefined,
    pruneAll: () => ({ available: true, pruned: 3, charsRemoved: 1_200 }),
    describe: () => ({ autoCompact: false, pruneRatio: 0.6, compactRatio: 0.8 })
  };
  const result = await createContextHandler({ ctx: env.ctx, driver })('compact', { sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    compacted: true,
    via: 'service',
    items: 2,
    tokensSaved: 900,
    pruned: 3,
    charsRemoved: 1_200
  });
});
