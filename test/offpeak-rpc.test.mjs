/**
 * 「谷峰会话」RPC：端点信封、错误码、以及 prefix 路由的安装形状。
 *
 * handler 与 HTTP 解耦，所以先直接驱动它（不碰 Node 的 req/res）；再用 mock
 * `webServer` / `connection` 验一遍安装器（认证、信封、405/400/413 分支、退路）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_RPC_BODY_BYTES,
  OFFPEAK_RPC_CHANNEL,
  createOffpeakHandler,
  installOffpeakChannel,
  readBoolean,
  readSessionId,
} from '../lib/offpeak/rpc.mjs';

/** 造一个最少可用的假控制器。 */
function createFakeController() {
  const calls = [];
  const statusValue = {
    enabled: true,
    enabledSource: 'session',
    paused: true,
    offPeak: false,
    window: { start: '00:30', end: '08:30', timeZone: 'Asia/Shanghai' },
    serverNow: 1,
    nextChangeAt: 2,
    nextChangeKind: 'resume',
    cover: { agent: true, running: false, held: true, interrupted: false, queued: 0 },
    persisted: true,
    build: 'b',
  };
  return {
    calls,
    statusValue,
    status(sessionId) {
      calls.push(['status', sessionId]);
      return statusValue;
    },
    setEnabled(sessionId, enabled) {
      calls.push(['setEnabled', sessionId, enabled]);
      return { ...statusValue, enabled, paused: enabled && !statusValue.offPeak };
    },
    diag() {
      calls.push(['diag']);
      return { build: 'b', paused: true, sessions: [] };
    },
  };
}

test('常量：通道前缀与请求体上限', () => {
  assert.equal(OFFPEAK_RPC_CHANNEL, '/dsh-session-enhance-offpeak');
  assert.equal(MAX_RPC_BODY_BYTES, 32 * 1024);
});

test('入参读取：空串/空白/非字符串一律无效', () => {
  assert.equal(readSessionId({ sessionId: ' s1 ' }), 's1');
  assert.equal(readSessionId({ sessionId: '' }), undefined);
  assert.equal(readSessionId({ sessionId: '   ' }), undefined);
  assert.equal(readSessionId({ sessionId: 42 }), undefined);
  assert.equal(readSessionId({}), undefined);
  assert.equal(readSessionId(null), undefined);
  assert.equal(readSessionId('s1'), undefined);

  assert.equal(readBoolean({ enabled: true }, 'enabled'), true);
  assert.equal(readBoolean({ enabled: false }, 'enabled'), false);
  assert.equal(readBoolean({ enabled: 'true' }, 'enabled'), undefined);
  assert.equal(readBoolean({ enabled: 1 }, 'enabled'), undefined);
  assert.equal(readBoolean(undefined, 'enabled'), undefined);
});

test('status：缺 sessionId → BAD_REQUEST（details 必须是对象）', async () => {
  const handler = createOffpeakHandler({ controller: createFakeController() });
  const result = await handler('status', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'BAD_REQUEST');
  assert.deepEqual(result.error.details, {});
  assert.equal(result.error.message, 'payload.sessionId is required');
});

test('status / diag：成功信封与透传', async () => {
  const controller = createFakeController();
  const handler = createOffpeakHandler({ controller });

  const status = await handler('status', { sessionId: 's1' });
  assert.equal(status.ok, true);
  assert.deepEqual(status.value, controller.statusValue);
  assert.deepEqual(controller.calls[0], ['status', 's1']);

  const diag = await handler('diag', {});
  assert.equal(diag.ok, true);
  assert.equal(diag.value.build, 'b');
  assert.deepEqual(controller.calls.at(-1), ['diag']);
});

test('setEnabled：enabled 必须是布尔值；成功返回切换后的状态', async () => {
  const controller = createFakeController();
  const handler = createOffpeakHandler({ controller });

  for (const payload of [
    { sessionId: 's1' },
    { sessionId: 's1', enabled: 'true' },
    { sessionId: 's1', enabled: 1 },
    { sessionId: 's1', enabled: null },
  ]) {
    const result = await handler('setEnabled', payload);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'BAD_REQUEST');
    assert.match(result.error.message, /boolean/u);
  }
  assert.deepEqual(controller.calls, [], '非法入参不该进控制器');

  const ok = await handler('setEnabled', { sessionId: 's1', enabled: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.enabled, true);
  assert.deepEqual(controller.calls, [['setEnabled', 's1', true]]);

  const off = await handler('setEnabled', { sessionId: 's1', enabled: false });
  assert.equal(off.value.enabled, false);
  assert.equal(off.value.paused, false);
});

test('未知端点 → UNKNOWN_METHOD；sessionId 首尾空白被 trim', async () => {
  const controller = createFakeController();
  const handler = createOffpeakHandler({ controller });

  const unknown = await handler('nope', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'UNKNOWN_METHOD');
  assert.deepEqual(unknown.error.details, {});

  await handler('status', { sessionId: ' s1 ' });
  assert.deepEqual(controller.calls[0], ['status', 's1']);
});

/**
 * 造一个 mock `webServer` + `connection` + `res`，跑一遍安装后的 HTTP 分支。
 *
 * @param {object} [options] - 覆盖项。
 * @param {boolean} [options.registerThrows] - 让 `webServer.register` 抛错（测退路）。
 * @returns {{ ctx: any, calls: any[], connection: any, responses: any[] }} 夹具。
 */
function createChannelFixture(options = {}) {
  const responses = [];
  const calls = [];
  const connection = {
    admit: (req) => req.admission ?? {},
    rpc: { handle: (channel, fn) => { calls.push({ channel, fn }); } },
  };
  const webServer = {
    register: (route) => {
      if (options.registerThrows === true) throw new Error('unsupported route kind');
      calls.push({ route });
      return () => {};
    },
  };
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['connection', 'webServer']);
      callback({
        connection,
        webServer,
        effect(factory) {
          const dispose = factory();
          return typeof dispose === 'function' ? dispose : () => {};
        },
      });
      return () => {};
    },
  };
  /**
   * 发一个请求给注册的 prefix handler。
   *
   * @param {{ method?: string, url?: string, body?: string | Buffer, admission?: object }} request - 请求。
   * @returns {Promise<{ status: number, headers: object, body: string }>} 响应。
   */
  async function request(request) {
    const route = calls.find((call) => call.route)?.route;
    assert.ok(route, '应先注册 prefix 路由');
    const chunks = request.body === undefined ? [] : [Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body, 'utf8')];
    const req = {
      method: request.method ?? 'POST',
      url: request.url ?? `/dsh-session-enhance-offpeak/status`,
      admission: request.admission,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    };
    let captured;
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers ?? {};
      },
      end(body) {
        this.body = body ?? '';
      },
    };
    await route.handler(req, res);
    captured = { status: res.statusCode, headers: res.headers, body: res.body };
    responses.push(captured);
    return captured;
  }
  return { ctx, calls, connection, responses, request };
}

test('安装器：注册 prefix 路由（kind/path），并走 connection.admit 认证', async () => {
  const fixture = createChannelFixture();
  const controller = createFakeController();
  installOffpeakChannel(fixture.ctx, createOffpeakHandler({ controller }));
  const route = fixture.calls.find((call) => call.route)?.route;
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, OFFPEAK_RPC_CHANNEL);

  // 非 POST → 404
  const get = await fixture.request({ method: 'GET' });
  assert.equal(get.status, 404);

  // admission 拒绝 → 透传状态码（不能当成功）
  const rejected = await fixture.request({ admission: { rejection: 401 } });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body, 'rejected');

  // 正常信封：{type:'server-response', rpcId, result}
  const ok = await fixture.request({
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'status', payload: { sessionId: 's1' } }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'application/json');
  const envelope = JSON.parse(ok.body);
  assert.equal(envelope.type, 'server-response');
  assert.equal(envelope.rpcId, 'r1');
  assert.equal(envelope.result.ok, true);
  assert.equal(envelope.result.value.enabled, true);
});

test('安装器：method 缺省时用 URL 里的 endpoint；坏 JSON / 超大 body 分别 400/413', async () => {
  const fixture = createChannelFixture();
  const controller = createFakeController();
  installOffpeakChannel(fixture.ctx, createOffpeakHandler({ controller }));

  // 请求体没有 method → 用 /<prefix>/diag 的 diag。
  const viaUrl = await fixture.request({
    url: '/dsh-session-enhance-offpeak/diag',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r2', payload: {} }),
  });
  assert.equal(viaUrl.status, 200);
  const envelope = JSON.parse(viaUrl.body);
  assert.equal(envelope.result.ok, true);

  const badJson = await fixture.request({ body: '{ oops' });
  assert.equal(badJson.status, 400);

  const tooLarge = await fixture.request({ body: Buffer.alloc(MAX_RPC_BODY_BYTES + 1) });
  assert.equal(tooLarge.status, 413);
});

test('安装器：handler 抛错 → 200 + INTERNAL 信封（不让 HTTP 层裸崩）', async () => {
  const fixture = createChannelFixture();
  const controller = {
    status() {
      throw new Error('boom');
    },
    setEnabled() {
      throw new Error('boom');
    },
    diag() {
      throw new Error('boom');
    },
  };
  installOffpeakChannel(fixture.ctx, createOffpeakHandler({ controller }));
  const response = await fixture.request({ body: JSON.stringify({ method: 'status', payload: { sessionId: 's1' } }) });
  assert.equal(response.status, 200);
  const envelope = JSON.parse(response.body);
  assert.equal(envelope.result.ok, false);
  assert.equal(envelope.result.error.code, 'INTERNAL');
  assert.match(envelope.result.error.message, /boom/u);
});

test('安装器：webServer.register 抛错时退回 connection.rpc.handle', () => {
  const fixture = createChannelFixture({ registerThrows: true });
  installOffpeakChannel(fixture.ctx, createOffpeakHandler({ controller: createFakeController() }));
  const fallback = fixture.calls.find((call) => call.channel);
  assert.ok(fallback, '应走 connection.rpc.handle 退路');
  assert.equal(fallback.channel, OFFPEAK_RPC_CHANNEL);
});
