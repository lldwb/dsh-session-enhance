/**
 * 「侧边提问」组件的 RPC 通道与端点。
 *
 * 沿用「中断重试」组件已验证的配方（见 `lib/retry/rpc.mjs` 的注释）：第三方插件无法
 * 注册自己的 Remote namespace，只能用 Connection 的通用 RPC 通道；Host 侧首选自建
 * prefix 路由（`webServer.register({ kind: 'prefix' })` + `connection.admit(req)`），
 * 形状不兼容时退回 `connection.rpc.handle`。信封与官方 carrier 一致：
 * `{ type: 'client-request', rpcId, method, payload }` →
 * `{ type: 'server-response', rpcId, result }`，`result` 为 `{ ok: true, value }` 或
 * `{ ok: false, error: { code, message, details: {} } }`。
 *
 * 端点：
 *
 * | endpoint    | 作用 |
 * |-------------|------|
 * | `probe`     | 组件可用性探测（浏览器半据此决定是否注册侧边提问的界面） |
 * | `create`    | 为原会话创建一个**新的只读**侧边会话，并返回预填提示词 |
 * | `setPreset` | 把侧边会话切到指定权限预设（只读 / 恢复普通） |
 * | `restore`   | 「保留」后恢复原会话当时的权限预设 |
 * | `forget`    | 标签关闭后清理 Host 侧的临时记录 |
 *
 * @module dsh-session-enhance/lib/sideask/rpc
 */

/** 浏览器半调用本组件的 RPC 通道前缀。 */
export const SIDEASK_RPC_CHANNEL = '/dsh-session-enhance-sideask';

/** 请求体上限：只传会话 id / 预设名 / 一段引用文字，64 KiB 有富余。 */
export const MAX_RPC_BODY_BYTES = 64 * 1024;

/**
 * 组装成功结果。
 *
 * @param {unknown} value - 端点返回值。
 * @returns {{ ok: true, value: unknown }} 信封。
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * 组装失败结果。`details` 必须是对象（Connection 硬要求）。
 *
 * @param {string} code - 稳定错误码。
 * @param {string} message - 人类可读说明。
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} 信封。
 */
function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * 从 payload 里取非空字符串字段（不做隐式类型转换）。
 *
 * @param {unknown} payload - RPC payload。
 * @param {string} field - 字段名。
 * @returns {string | undefined} 去除首尾空白后仍非空的值。
 */
function readStringField(payload, field) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = /** @type {Record<string, unknown>} */ (payload)[field];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 创建端点处理函数（与 HTTP 解耦，可用普通单测直接驱动）。
 *
 * @param {object} options - 依赖。
 * @param {object} options.controller - 侧边会话控制器（`createSideAskController` 的返回值）。
 * @param {string} [options.build] - 构建标识，`probe` 会带出去便于排查。
 * @returns {(method: string, payload: unknown) => Promise<object>} 处理函数。
 */
export function createSideAskHandler({ controller, build }) {
  return async function handle(method, payload) {
    switch (method) {
      case 'probe': {
        return ok({ available: true, build: build ?? undefined });
      }
      case 'create': {
        const parentSessionId = readStringField(payload, 'parentSessionId');
        if (parentSessionId === undefined) return fail('BAD_REQUEST', 'payload.parentSessionId is required');
        const quote = typeof payload === 'object' && payload !== null
          ? /** @type {{ quote?: unknown }} */ (payload).quote
          : undefined;
        const locale = readStringField(payload, 'locale');
        const result = await controller.create({
          parentSessionId,
          quote: typeof quote === 'string' ? quote : undefined,
          locale,
        });
        if (result?.ok === false) return fail(result.code ?? 'CREATE_FAILED', result.message ?? 'Could not create the side session');
        return ok(result.value);
      }
      case 'setPreset': {
        const sessionId = readStringField(payload, 'sessionId');
        const preset = readStringField(payload, 'preset');
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        if (preset === undefined) return fail('BAD_REQUEST', 'payload.preset is required');
        const result = await controller.setPreset({ sessionId, preset });
        if (result?.ok === false) return fail(result.code ?? 'SET_PRESET_FAILED', result.message ?? 'Could not switch the permission preset');
        return ok(result.value);
      }
      case 'restore': {
        const sessionId = readStringField(payload, 'sessionId');
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        const result = await controller.restore({ sessionId });
        if (result?.ok === false) return fail(result.code ?? 'RESTORE_FAILED', result.message ?? 'Could not restore the permission preset');
        return ok(result.value);
      }
      case 'forget': {
        const sessionId = readStringField(payload, 'sessionId');
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        return ok(controller.forget({ sessionId }));
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
 * @param {object} ctx - Cordis 上下文（插件 scope）。
 * @param {(method: string, payload: unknown) => Promise<object>} handler - 端点处理函数。
 * @returns {void}
 */
export function installSideAskChannel(ctx, handler) {
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
          path: SIDEASK_RPC_CHANNEL,
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
            const endpoint = url.pathname.startsWith(`${SIDEASK_RPC_CHANNEL}/`)
              ? url.pathname.slice(SIDEASK_RPC_CHANNEL.length + 1)
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
          return connection.rpc.handle(SIDEASK_RPC_CHANNEL, async (method, payload) => handler(method, payload));
        } catch {
          return () => {};
        }
      }
    }, 'dsh-session-enhance: side-ask rpc channel');
  });
}
