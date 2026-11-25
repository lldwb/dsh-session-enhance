/**
 * 「梁谷」组件的 RPC 通道与端点。
 *
 * ## 为什么自建 prefix 路由
 *
 * 与 `lib/retry/rpc.mjs`、`lib/context/host.mjs` 同一配方（已验证）：DSH 的 Remote 能力集
 * 是构建时固定导入的，第三方插件无法注册自己的 Remote namespace；`connection.rpc.handle`
 * 又会访问调用方 fiber 的 `webServer`，没同时 inject 时有 405 陷阱。所以：
 *
 * 1. `ctx.inject(['connection', 'webServer'], …)` 同时拿到两个服务；
 * 2. `webServer.register({ kind: 'prefix', path })`；
 * 3. 认证复用 `connection.admit(req)`；
 * 4. 信封与官方 carrier 一致：`{ type: 'client-request', rpcId, method, payload }` →
 *    `{ type: 'server-response', rpcId, result }`，`result` 为 `{ ok: true, value }` 或
 *    `{ ok: false, error: { code, message, details } }` —— **details 必须是对象**。
 *
 * ## 端点
 *
 * | endpoint    | 作用 |
 * |-------------|------|
 * | `status`    | 查询某会话的梁谷状态（启用与否、是否暂停中、下一次切换时刻、cover 细节） |
 * | `setEnabled`| 切换某会话的启用状态，返回**切换后**的同一份状态 |
 * | `diag`      | 诊断：全局相位、配置、存储健康度、全部相关会话 |
 *
 * ## 错误码
 *
 * - `BAD_REQUEST`：payload 不合法（缺 `sessionId`、`enabled` 不是布尔值）；
 * - `UNKNOWN_METHOD`：未知端点；
 * - `INTERNAL`：处理函数自己抛错（安装器兜底）。
 *
 * 组件停用时路由不存在 → 浏览器半的能力探测拿到 404/405，按钮隐藏。
 *
 * @module dsh-session-enhance/lib/offpeak/rpc
 */

/** 浏览器半调用本组件的 RPC 通道前缀。 */
export const OFFPEAK_RPC_CHANNEL = '/dsh-session-enhance-offpeak';

/** 请求体上限：这些端点只传几个 JSON 字段，32 KiB 有富余。 */
export const MAX_RPC_BODY_BYTES = 32 * 1024;

/**
 * 组装 `{ ok, value }` 成功信封。
 *
 * @param {unknown} value - 端点返回值。
 * @returns {{ ok: true, value: unknown }} 信封。
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * 组装 `{ ok: false, error }` 失败信封。`details` 固定为 `{}`（Connection 硬要求对象）。
 *
 * @param {string} code - 稳定错误码。
 * @param {string} message - 人类可读说明。
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} 信封。
 */
function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * 从 payload 里取会话 id（非字符串/空白串一律无效，不做隐式转换）。
 *
 * @param {unknown} payload - RPC payload。
 * @returns {string | undefined} 会话 id。
 */
export function readSessionId(payload) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = /** @type {{ sessionId?: unknown }} */ (payload).sessionId;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 从 payload 里取布尔值（只接受真正的 boolean）。
 *
 * @param {unknown} payload - RPC payload。
 * @param {string} key - 字段名。
 * @returns {boolean | undefined} 值。
 */
export function readBoolean(payload, key) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = /** @type {Record<string, unknown>} */ (payload)[key];
  return value === true || value === false ? value : undefined;
}

/**
 * 创建端点处理函数（与 HTTP 解耦，可离线单测）。
 *
 * @param {object} options - 依赖。
 * @param {any} options.controller - 梁谷控制器（`createOffpeakController` 的返回）。
 * @returns {(method: string, payload: unknown) => Promise<object>} 处理函数。
 */
export function createOffpeakHandler({ controller }) {
  return async function handle(method, payload) {
    switch (method) {
      case 'status': {
        const sessionId = readSessionId(payload);
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        return ok(controller.status(sessionId));
      }
      case 'setEnabled': {
        const sessionId = readSessionId(payload);
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        const enabled = readBoolean(payload, 'enabled');
        if (enabled === undefined) return fail('BAD_REQUEST', 'payload.enabled must be a boolean');
        return ok(controller.setEnabled(sessionId, enabled));
      }
      case 'diag': {
        return ok(controller.diag());
      }
      default: {
        return fail('UNKNOWN_METHOD', `Unknown endpoint "${String(method)}"`);
      }
    }
  };
}

/**
 * 在 Host 的 web server 上注册本组件的 RPC 前缀路由。
 *
 * 首选自建 prefix 路由；`webServer` 形状不兼容时退回 `connection.rpc.handle`。
 *
 * @param {any} ctx - Cordis 插件上下文。
 * @param {(method: string, payload: unknown) => Promise<object>} handler - 端点处理函数。
 * @returns {void}
 */
export function installOffpeakChannel(ctx, handler) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['connection', 'webServer'], (rpcCtx) => {
    rpcCtx.effect(() => {
      const connection = rpcCtx.connection;
      const webServer = rpcCtx.webServer;
      if (connection === undefined || webServer === undefined) return () => {};

      /** 读请求体（Node 的 req 是 AsyncIterable<Buffer>）。 */
      const readBody = async (req) => {
        const chunks = [];
        let total = 0;
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > MAX_RPC_BODY_BYTES) return undefined;
          chunks.push(buffer);
        }
        return Buffer.concat(chunks);
      };

      try {
        return webServer.register({
          kind: 'prefix',
          path: OFFPEAK_RPC_CHANNEL,
          handler: async (req, res) => {
            let admission;
            try {
              admission = connection.admit(req);
            } catch {
              res.writeHead(500);
              res.end('admission failed');
              return;
            }
            if ('rejection' in admission) {
              res.writeHead(admission.rejection);
              res.end('rejected');
              return;
            }
            if (req.method !== 'POST') {
              res.writeHead(404);
              res.end('not found');
              return;
            }
            let body;
            try {
              body = await readBody(req);
            } catch {
              res.writeHead(400);
              res.end('body unreadable');
              return;
            }
            if (body === undefined) {
              res.writeHead(413);
              res.end('body too large');
              return;
            }
            let request;
            try {
              request = JSON.parse(body.toString('utf8'));
            } catch {
              res.writeHead(400);
              res.end('body is not JSON');
              return;
            }
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const endpoint = url.pathname.startsWith(`${OFFPEAK_RPC_CHANNEL}/`)
              ? url.pathname.slice(OFFPEAK_RPC_CHANNEL.length + 1)
              : '';
            let result;
            try {
              result = await handler(String(request?.method ?? endpoint), request?.payload);
            } catch (error) {
              result = fail('INTERNAL', String(error?.message ?? error));
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'server-response', rpcId: request?.rpcId, result }));
          },
        });
      } catch {
        try {
          return connection.rpc.handle(OFFPEAK_RPC_CHANNEL, async (method, payload) => handler(method, payload));
        } catch {
          return () => {};
        }
      }
    }, 'dsh-session-enhance: offpeak rpc channel');
  });
}
