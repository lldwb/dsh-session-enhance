/**
 * 「中断重试」组件的 RPC 通道与端点。
 *
 * ## 为什么自建 prefix 路由
 *
 * DSH 的 Remote 能力集是构建时固定导入的，第三方插件无法注册自己的 Remote namespace；
 * 唯一可用的是 Connection 的通用 RPC 通道 `ctx.connection.rpc.call(channel, endpoint,
 * payload)`。Host 侧若直接用 `connection.rpc.handle(...)`，它内部会访问调用方 fiber 的
 * `webServer`，没有同时 inject 时会抛错，客户端最终拿到 **HTTP 405**（落到 SPA
 * fallback），很难排查。所以这里沿用已验证配方：
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
 * | endpoint  | 作用 |
 * |-----------|------|
 * | `pending` | 查询某会话是否有「被用户中断、可重试」的记录 |
 * | `retry`   | 用户点了「重试」：取走记录并用 `agent.followup()` 驱动新一轮 |
 * | `diag`    | 诊断：运行时探测快照 + 当前记录 |
 *
 * @module dsh-session-enhance/lib/retry/rpc
 */

/** 浏览器半调用本组件的 RPC 通道前缀。 */
export const RETRY_RPC_CHANNEL = '/dsh-session-enhance-retry';

/** 请求体上限：这些端点只传几个 JSON 字段，32 KiB 有富余。 */
export const MAX_RPC_BODY_BYTES = 32 * 1024;

/**
 * 组装 `{ ok, value }` 成功结果。
 *
 * @param {unknown} value - 端点返回值。
 * @returns {{ ok: true, value: unknown }} 信封。
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * 组装 `{ ok: false, error }` 失败结果。`details` 固定为 `{}`（Connection 硬要求对象）。
 *
 * @param {string} code - 稳定错误码。
 * @param {string} message - 人类可读说明。
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} 信封。
 */
function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * 从 payload 里取会话 id（非字符串/空串一律无效，不做隐式转换）。
 *
 * @param {unknown} payload - RPC payload。
 * @returns {string | undefined} 会话 id。
 */
function readSessionId(payload) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = /** @type {{ sessionId?: unknown }} */ (payload).sessionId;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 调一次探测，任何异常都收成可序列化的字符串（诊断端点不能自己抛）。
 *
 * @param {() => object} probe - 探测函数。
 * @returns {object} 快照。
 */
function safeProbe(probe) {
  try {
    const value = probe();
    return value !== null && typeof value === 'object' ? value : { value: String(value) };
  } catch (error) {
    return { probeError: String(error?.message ?? error) };
  }
}

/**
 * 创建端点处理函数（与 HTTP 解耦，可用普通单测直接驱动）。
 *
 * @param {object} options - 依赖。
 * @param {import('./recovery.mjs').RecoveryStore} options.recovery - 「用户中断、可重试」记录。
 * @param {(sessionId: string) => Promise<object>} [options.driveRetry] - 驱动一次新的 turn（可省略）。
 * @param {() => object} [options.probe] - 当前运行时探测快照（可省略）。
 * @returns {(method: string, payload: unknown) => Promise<object>} 处理函数。
 */
export function createRetryHandler({ recovery, driveRetry, probe }) {
  return async function handle(method, payload) {
    switch (method) {
      case 'pending': {
        const sessionId = readSessionId(payload);
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        const recoverable = recovery?.peek?.(sessionId) ?? null;
        return ok({ pending: recoverable !== null, recoverable });
      }
      case 'retry': {
        const sessionId = readSessionId(payload);
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        const entry = recovery?.take?.(sessionId);
        if (entry === undefined) {
          return fail(
            'NOT_AVAILABLE',
            'No interrupted turn is available for retry in this session (it may have expired, already resumed, or the Host restarted).',
          );
        }
        if (typeof driveRetry !== 'function') {
          return fail('NOT_AVAILABLE', 'Driving a new turn is not available in this Host.');
        }
        const outcome = await driveRetry(sessionId);
        if (outcome?.ok === true) return ok({ retried: true, via: 'followup' });
        return fail(outcome?.code ?? 'RETRY_FAILED', outcome?.message ?? 'Could not drive a new turn.');
      }
      case 'diag': {
        const sessionId = readSessionId(payload);
        return ok({
          probe: typeof probe === 'function' ? safeProbe(probe) : null,
          recoverable: sessionId === undefined ? null : (recovery?.peek?.(sessionId) ?? null),
          storeSize: typeof recovery?.size === 'number' ? recovery.size : 0,
          ttlMs: typeof recovery?.ttlMs === 'number' ? recovery.ttlMs : undefined,
        });
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
 * @param {object} ctx - Cordis 上下文（插件 scope）。
 * @param {(method: string, payload: unknown) => Promise<object>} handler - 端点处理函数。
 * @returns {void}
 */
export function installRetryChannel(ctx, handler) {
  ctx.inject?.(['connection', 'webServer'], (rpcCtx) => {
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
          path: RETRY_RPC_CHANNEL,
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
            const endpoint = url.pathname.startsWith(`${RETRY_RPC_CHANNEL}/`)
              ? url.pathname.slice(RETRY_RPC_CHANNEL.length + 1)
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
          return connection.rpc.handle(RETRY_RPC_CHANNEL, async (method, payload) => handler(method, payload));
        } catch {
          return () => {};
        }
      }
    }, 'dsh-session-enhance: interrupted retry rpc channel');
  });
}
