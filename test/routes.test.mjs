/**
 * 四条 webServer 路由的**准入声明**回归。
 *
 * ## 为什么单独一个文件
 *
 * DSH 0.2.2-rc.3 起 `webServer.register()` 的 `auth` 字段默认是 `'required'`：
 * 没有已认证 Peer 的请求会在**进入 handler 之前**被拒（无人决策时 503，决策未通过
 * 401/403）。所以：
 *
 * - **免登录只读分享页** `GET /share/<token>` 必须显式 `auth: 'anonymous'`，
 *   否则分享链接在 rc.3 上直接打不开（rc.2 没有这个字段，行为是"完全不拦"）；
 * - 三条 RPC 通道（分享 / 中断重试 / 上下文）是**登录后**用的，必须保持默认
 *   `required`，绝不能顺手写成 anonymous —— 那等于把「创建分享」「驱动新一轮」
 *   暴露给未认证的请求。
 *
 * 这两个方向都可能被"随手改成一致"以后破坏，所以各写一条断言钉住。
 * 真实的准入执行（WebServer + Connection 的 `webserver/authorize`）属于沙箱回归的
 * 范围，离线单测只看声明与 handler 自身行为。
 *
 * @module dsh-session-enhance/test/routes
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { installContextChannel } from '../lib/context/host.mjs';
import { mountShareRoutes } from '../lib/public.mjs';
import { mountShareRpc } from '../lib/rpc.mjs';
import { installRetryChannel } from '../lib/retry/rpc.mjs';

/**
 * 造一个只记录路由注册的 mock 上下文。
 *
 * @param {Record<string, any>} [services] - `ctx.get()` 能额外取到的服务。
 * @returns {{ ctx: any, routes: any[] }} mock 环境与注册到的路由。
 */
function makeCtx(services = {}) {
  const routes = [];
  const table = {
    ...services,
    connection: {
      // 分享读取路由不该调 admit；其它通道调它做双保险。
      admit: () => ({ peer: {} }),
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
    ...table,
    get(name) {
      return table[name];
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
 * 一个够用的假 `sessionQuery`（分享页渲染只需要 trace + 标题 + 表层）。
 *
 * @param {string} sessionId - 会话 id。
 * @returns {any} 假查询服务。
 */
function fakeSessionQuery(sessionId) {
  return {
    async traceSession(id) {
      if (id !== sessionId) throw new Error('not found');
      return {
        target: {
          header: { id: sessionId, createdAt: 1_700_000_000_000, isSeeded: false },
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
          title: { title: '会话增强：路由准入', messageSeqs: [1], source: { kind: 'fallback' }, eventSeq: 1, updatedAt: 1_700_000_000_000 },
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
 * 一个假响应，记录状态码、响应头与响应体。
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

const SESSION_ID = 'session-route-ok';

/**
 * 挂上分享页的公开路由并取回它。
 *
 * @returns {any} 注册到的路由。
 */
function shareRoute() {
  const { ctx, routes } = makeCtx({ sessionQuery: fakeSessionQuery(SESSION_ID) });
  mountShareRoutes(ctx, {
    store: { get: (token) => (token === 'token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' ? { token, sessionId: SESSION_ID, createdAt: 1_700_000_000_000, includeDescendants: false } : undefined) },
    sessionQuery: () => fakeSessionQuery(SESSION_ID),
    sessions: () => undefined,
    logger: { warn: () => {} },
  });
  assert.equal(routes.length, 1, '公开分享路由应只注册一条');
  return routes[0];
}

test('分享页路由显式声明 auth:anonymous（rc.3 起默认 required 会把它挡在 handler 之前）', () => {
  const route = shareRoute();
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/share');
  assert.equal(
    route.auth,
    'anonymous',
    '免登录只读分享页必须匿名：漏了它，rc.3 上 /share/<token> 会在进 handler 前被拒（503）',
  );
});

test('分享页路由的 handler 自身仍只认 token：未知 token 404、非 GET/HEAD 405、合法 token 200', async () => {
  const route = shareRoute();

  const notFound = fakeResponse();
  await route.handler({ method: 'GET', url: '/share/token-bbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, notFound);
  assert.equal(notFound.status, 404);

  const wrongMethod = fakeResponse();
  await route.handler({ method: 'POST', url: '/share/token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, wrongMethod);
  assert.equal(wrongMethod.status, 405);

  const ok = fakeResponse();
  await route.handler({ method: 'GET', url: '/share/token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, ok);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /会话增强：路由准入/u);
  assert.equal(ok.headers['cache-control'], 'no-store');
});

test('三条登录后 RPC 通道保持默认 auth（required），不得声明 anonymous', () => {
  const share = makeCtx();
  mountShareRpc(share.ctx, {
    store: { listForSession: () => [], create: () => ({}), revoke: () => false },
    sessionQuery: () => undefined,
    sessions: () => undefined,
    originOf: () => 'http://127.0.0.1:1',
  });
  assert.equal(share.routes.length, 1);
  assert.equal(share.routes[0].path, '/dsh-session-enhance');
  assert.equal(
    share.routes[0].auth,
    undefined,
    '分享创建/撤销通道必须要求认证：声明 anonymous 等于让未登录请求也能创建分享',
  );

  const retry = makeCtx();
  installRetryChannel(retry.ctx, async () => ({ ok: true, value: {} }));
  assert.equal(retry.routes.length, 1);
  assert.equal(retry.routes[0].path, '/dsh-session-enhance-retry');
  assert.equal(retry.routes[0].auth, undefined, '中断重试通道必须要求认证');

  const context = makeCtx();
  installContextChannel(context.ctx, async () => ({ ok: true, value: {} }));
  assert.equal(context.routes.length, 1);
  assert.equal(context.routes[0].path, '/dsh-session-enhance-context');
  assert.equal(context.routes[0].auth, undefined, '手动压缩通道必须要求认证');
});
