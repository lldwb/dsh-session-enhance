/**
 * 四条 webServer 路由的注册与实际准入回归（目标运行时：DSH 0.2.2-rc.5）。
 *
 * ## rc.5 的事实（5.6.3 起按它改写；旧注释描述的是 master 基线）
 *
 * rc.5 的 `WebRoute` 只有 `kind` / `path` / `handler` 三个字段
 * （`packages/host/webserver/src/index.ts:52`），`register()` 只做 `table.set(path, route)`
 * （同文件 :445）——**没有路由级 `auth` 字段，也不会在进入 handler 之前拒掉请求**。
 * 路由级 `auth: 'anonymous' | 'required'`、`webserver/authorize` 事件与 `503` 只存在于
 * master 基线，rc.3 / rc.5 都没有；旧版写在 route 对象上的 `auth` 键会被 rc.5 静默忽略
 * （本次已删除）。
 *
 * 四份注册各自的真实准入边界因此是：
 * - 公开分享页 `GET|HEAD /share/<token>`：只看 URL 里的随机 token（24 字节，不可枚举、
 *   可撤销、每次现读日志），不认 Peer 身份 —— 这正是"分享链接谁拿到谁能开"的语义；
 * - 三条 RPC 通道（分享 / 中断重试 / 上下文）：唯一准入是 **handler 内的
 *   `connection.admit(req)`**。`PeerAdmission = { peer } | { rejection: 401 | 403 }`
 *   （`packages/client/connection/src/rpc.ts:119`，**没有 503**），拒绝时 handler 原样写
 *   状态码并直接返回。
 *
 * ⚠️ **不能因为 rc.5 没有路由级 auth 就删掉 admit**：那是这三条通道唯一的准入。
 *
 * 本文件钉住两件事（断言都必须能在"改坏"时真的失败）：
 * 1. 四条路由注册出来都没有 `auth` 键（防止把 master-only 字段再写回来）；
 * 2. 三条 RPC 的 handler 仍以 `connection.admit` 为准入：拒绝 → 写状态码且不进业务；
 *    放行 → 才走到业务。
 *
 * @module dsh-session-enhance/test/routes
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { installContextChannel } from '../lib/context/host.mjs';
import { mountShareRoutes } from '../lib/public.mjs';
import { mountShareRpc } from '../lib/rpc.mjs';
import { installRetryChannel } from '../lib/retry/rpc.mjs';

const SHARE_TOKEN = 'token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SESSION_ID = 'session-route-ok';
const SHARE_PAGE = '/share';
const SHARE_RPC = '/dsh-session-enhance';
const RETRY_RPC = '/dsh-session-enhance-retry';
const CONTEXT_RPC = '/dsh-session-enhance-context';

/**
 * 造一个 mock 插件上下文：`webServer.register` 只记录路由，`connection.admit` 可注入。
 *
 * @param {{ admit?: (req?: any) => { peer?: any, rejection?: 401 | 403 } }} [options] - `connection.admit` 的返回值。
 * @returns {{ ctx: any, routes: any[] }} mock 环境与注册到的路由。
 */
function makeCtx(options = {}) {
  const admit = options.admit ?? (() => ({ peer: {} }));
  const routes = [];
  const services = {
    connection: {
      admit: (req) => admit(req),
      // 旧版逃生口：webServer.register 可用时绝不该走到这里。
      rpc: {
        handle: () => {
          throw new Error('rpc.handle fallback must not be used when webServer.register works');
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
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
    ...services,
    get(name) {
      return services[name];
    },
    inject(_names, callback) {
      callback(ctx);
      return () => {};
    },
    effect(factory) {
      factory();
      return () => {};
    },
  };
  return { ctx, routes };
}

/**
 * 取回某条已注册路由；没注册就失败（别让"路由根本没挂上"混进后面的断言里）。
 *
 * @param {{ routes: any[] }} env - mock 环境。
 * @param {string} path - 期望的路由前缀。
 * @returns {any} 注册对象。
 */
function onlyRoute(env, path) {
  const route = env.routes.find((item) => item.path === path);
  assert.ok(route, `路由 ${path} 应注册成功`);
  return route;
}

/**
 * 一个够用的假 `sessionQuery`（分享页渲染只需要 trace + 标题 + 表层）。
 *
 * @returns {any} 假查询服务。
 */
function fakeSessionQuery() {
  return {
    async traceSession(id) {
      if (id !== SESSION_ID) throw new Error('not found');
      return {
        target: {
          header: { id: SESSION_ID, createdAt: 1_700_000_000_000, isSeeded: false },
          live: false,
          persisted: true,
        },
        ancestors: [],
        descendants: [],
        complete: true,
      };
    },
    async readTitleSnapshots(ids) {
      return ids.map((id) => ({
        status: 'fulfilled',
        sessionId: id,
        value: {
          session: { id },
          title: {
            title: '会话增强：路由准入',
            messageSeqs: [1],
            source: { kind: 'fallback' },
            eventSeq: 1,
            updatedAt: 1_700_000_000_000,
          },
        },
      }));
    },
    async readSurface() {
      return {
        inheritedEventCount: 0,
        events: [
          { seq: 1, type: 'user/message', time: 1_700_000_100_000, data: { content: [{ type: 'text', text: '你好' }] } },
        ],
      };
    },
  };
}

/**
 * 一个假响应：记录状态码、响应头与响应体。
 *
 * @returns {any} 假 `res`。
 */
function fakeResponse() {
  return {
    headersSent: false,
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.headersSent = true;
      this.status = status;
      this.headers = headers ?? {};
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}

/**
 * 一个假请求（Node 的 `req` 是 `AsyncIterable<Buffer>`，三条 RPC handler 都按流读 body）。
 *
 * @param {{ method?: string, url?: string, body?: string }} [options] - 请求形状。
 * @returns {any} 假 `req`。
 */
function fakeRequest(options = {}) {
  const method = options.method ?? 'POST';
  const url = options.url ?? '/';
  const body = options.body ?? '';
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')];
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/**
 * 挂上公开分享页路由。
 *
 * @param {{ admit?: (req?: any) => any }} [options] - 注入的准入结果（分享页自己不调 admit）。
 * @returns {{ env: any, route: any }} 环境与路由。
 */
function mountSharePage(options = {}) {
  const env = makeCtx(options);
  mountShareRoutes(env.ctx, {
    store: {
      get: (token) =>
        token === SHARE_TOKEN
          ? { token, sessionId: SESSION_ID, createdAt: 1_700_000_000_000, includeDescendants: false }
          : undefined,
    },
    sessionQuery: () => fakeSessionQuery(),
    sessions: () => undefined,
    logger: { warn: () => {} },
  });
  return { env, route: onlyRoute(env, SHARE_PAGE) };
}

/**
 * 挂上「分享创建 / 查询 / 撤销」RPC 通道，并给业务路径装上计数器。
 *
 * @param {{ admit?: (req?: any) => any }} [options] - 注入的准入结果。
 * @returns {{ env: any, route: any, business: { calls: number } }} 环境、路由与业务计数。
 */
function mountShareRpcEnv(options = {}) {
  const env = makeCtx(options);
  const business = { calls: 0 };
  mountShareRpc(env.ctx, {
    store: {
      listForSession: () => {
        business.calls += 1;
        return [];
      },
      create: () => {
        business.calls += 1;
        return {};
      },
      revoke: () => {
        business.calls += 1;
        return false;
      },
    },
    sessionQuery: () => ({ traceSession: async () => ({}) }),
    sessions: () => undefined,
    originOf: () => 'http://127.0.0.1:5173',
  });
  return { env, route: onlyRoute(env, SHARE_RPC), business };
}

/**
 * 挂上「中断重试」RPC 通道，并给业务 handler 装上计数器。
 *
 * @param {{ admit?: (req?: any) => any }} [options] - 注入的准入结果。
 * @returns {{ env: any, route: any, business: { calls: number } }} 环境、路由与业务计数。
 */
function mountRetryEnv(options = {}) {
  const env = makeCtx(options);
  const business = { calls: 0 };
  installRetryChannel(env.ctx, async () => {
    business.calls += 1;
    return { ok: true, value: { pending: false } };
  });
  return { env, route: onlyRoute(env, RETRY_RPC), business };
}

/**
 * 挂上「上下文用量 / 手动压缩」RPC 通道，并给业务 handler 装上计数器。
 *
 * @param {{ admit?: (req?: any) => any }} [options] - 注入的准入结果。
 * @returns {{ env: any, route: any, business: { calls: number } }} 环境、路由与业务计数。
 */
function mountContextEnv(options = {}) {
  const env = makeCtx(options);
  const business = { calls: 0 };
  installContextChannel(env.ctx, async () => {
    business.calls += 1;
    return { ok: true, value: { canCompact: false } };
  });
  return { env, route: onlyRoute(env, CONTEXT_RPC), business };
}

test('四条路由都注册成功，且注册对象里没有 rc.5 不存在的 auth 字段', () => {
  const routes = [
    mountSharePage().route,
    mountShareRpcEnv().route,
    mountRetryEnv().route,
    mountContextEnv().route,
  ];
  assert.equal(routes.length, 4, '四条路由应全部注册成功');
  assert.deepEqual(
    routes.map((route) => route.path),
    [SHARE_PAGE, SHARE_RPC, RETRY_RPC, CONTEXT_RPC],
  );
  for (const route of routes) {
    assert.equal(route.kind, 'prefix', `${route.path} 应是 prefix 路由`);
    assert.equal(
      Object.hasOwn(route, 'auth'),
      false,
      `${route.path} 不应带 auth：rc.5 的 WebRoute 只有 kind/path/handler，该字段是 master-only`,
    );
    assert.equal(route.auth, undefined, `${route.path} 的 route.auth 应为 undefined`);
    // rc.5 的 WebRoute 就这三个字段；多出来的键（如旧版 auth）只会被 register() 静默忽略。
    assert.deepEqual(Object.keys(route).sort(), ['handler', 'kind', 'path']);
  }
});

test('分享页 handler 自身仍只认 token：未知 token 404、非 GET/HEAD 405、合法 token 200', async () => {
  const { route } = mountSharePage();

  const notFound = fakeResponse();
  await route.handler({ method: 'GET', url: '/share/token-bbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, notFound);
  assert.equal(notFound.status, 404);

  const wrongMethod = fakeResponse();
  await route.handler({ method: 'POST', url: `/share/${SHARE_TOKEN}` }, wrongMethod);
  assert.equal(wrongMethod.status, 405);

  const ok = fakeResponse();
  await route.handler({ method: 'GET', url: `/share/${SHARE_TOKEN}` }, ok);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /会话增强：路由准入/u);
  assert.equal(ok.headers['cache-control'], 'no-store');
});

test('三条 RPC 路由：connection.admit 拒绝时写回状态码，且不进入业务', async () => {
  // rc.5 的 PeerAdmission 只有 401 / 403 两种拒绝（没有 503）。
  for (const rejection of [401, 403]) {
    const share = mountShareRpcEnv({ admit: () => ({ rejection }) });
    const shareRes = fakeResponse();
    await share.route.handler(
      fakeRequest({
        url: SHARE_RPC,
        body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'share.status', payload: { sessionId: SESSION_ID } }),
      }),
      shareRes,
    );
    assert.equal(shareRes.status, rejection, '分享通道应原样写回 admit 的拒绝状态码');
    assert.equal(share.business.calls, 0, '拒绝时不得进入分享业务（否则未认证请求能创建/读取分享）');

    const retry = mountRetryEnv({ admit: () => ({ rejection }) });
    const retryRes = fakeResponse();
    await retry.route.handler(
      fakeRequest({ url: `${RETRY_RPC}/pending`, body: JSON.stringify({ rpcId: 'r2', method: 'pending', payload: {} }) }),
      retryRes,
    );
    assert.equal(retryRes.status, rejection, '中断重试通道应原样写回拒绝状态码');
    assert.equal(retry.business.calls, 0, '拒绝时不得进入重试业务');

    const context = mountContextEnv({ admit: () => ({ rejection }) });
    const contextRes = fakeResponse();
    await context.route.handler(
      fakeRequest({ url: `${CONTEXT_RPC}/get`, body: JSON.stringify({ rpcId: 'r3', method: 'get', payload: {} }) }),
      contextRes,
    );
    assert.equal(contextRes.status, rejection, '上下文通道应原样写回拒绝状态码');
    assert.equal(context.business.calls, 0, '拒绝时不得进入压缩业务');
  }
});

test('三条 RPC 路由：connection.admit 放行后才进入业务（用业务真的跑了做证据）', async () => {
  const share = mountShareRpcEnv({ admit: () => ({ peer: {} }) });
  const shareRes = fakeResponse();
  await share.route.handler(
    fakeRequest({
      url: SHARE_RPC,
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'share.status', payload: { sessionId: SESSION_ID } }),
    }),
    shareRes,
  );
  assert.equal(shareRes.status, 200);
  assert.equal(share.business.calls, 1, '放行后应执行 share.status 业务');
  const shareBody = JSON.parse(shareRes.body);
  assert.equal(shareBody.type, 'server-response');
  assert.equal(shareBody.rpcId, 'r1');
  assert.equal(shareBody.result.ok, true);
  assert.deepEqual(shareBody.result.value.shares, []);

  const retry = mountRetryEnv({ admit: () => ({ peer: {} }) });
  const retryRes = fakeResponse();
  await retry.route.handler(
    fakeRequest({ url: `${RETRY_RPC}/pending`, body: JSON.stringify({ rpcId: 'r2', method: 'pending', payload: {} }) }),
    retryRes,
  );
  assert.equal(retryRes.status, 200);
  assert.equal(retry.business.calls, 1, '放行后应执行重试业务');
  const retryBody = JSON.parse(retryRes.body);
  assert.equal(retryBody.type, 'server-response');
  assert.equal(retryBody.result.ok, true);

  const context = mountContextEnv({ admit: () => ({ peer: {} }) });
  const contextRes = fakeResponse();
  await context.route.handler(
    fakeRequest({ url: `${CONTEXT_RPC}/get`, body: JSON.stringify({ rpcId: 'r3', method: 'get', payload: {} }) }),
    contextRes,
  );
  assert.equal(contextRes.status, 200);
  assert.equal(context.business.calls, 1, '放行后应执行上下文业务');
  const contextBody = JSON.parse(contextRes.body);
  assert.equal(contextBody.type, 'server-response');
  assert.equal(contextBody.result.ok, true);
});
