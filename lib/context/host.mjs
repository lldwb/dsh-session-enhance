/**
 * 「上下文用量 + 手动压缩」组件的 Host 半。
 *
 * ## 它解决什么
 *
 * 会话越长，模型请求的输入 token 越接近上下文窗口；一旦超过窗口，提供方直接返回
 * `CONTEXT_WINDOW_EXCEEDED`，这一轮只能失败（用户看到的是一整轮红色错误，
 * 且"继续/重试"只会让输入更长）。本组件给浏览器半提供两件事：
 *
 * 1. `get`：当前会话的估算上下文用量与窗口大小（来自 `ctx.tokenMeter.contextPressure`）；
 * 2. `compact`：立即对当前会话做一次**手动压缩**（来自 `ctx.compaction.compactNow`）。
 *
 * ## 依赖是软依赖
 *
 * - `tokenMeter`：随附组合通常都在；缺失时 `get` 返回 `available:false`，按钮隐藏。
 * - `compaction`：只有挂载了 `@deepseek-ai/dsh-compaction-basic` 时才有这个服务。
 *   缺失时 `compact` 返回 `COMPACTION_UNAVAILABLE`（界面把按钮置灰并提示），
 *   绝不静默失败。
 *
 * ## 为什么不用官方 `/compact` 命令
 *
 * 官方命令面向"打字的人"；本组件面向 composer 上的按钮 + 用量提示。两者共用同一个
 * `ctx.compaction.compactNow()` 实现，行为一致（同样要求 agent 空闲、同样写
 * `compaction/start` 与 `compaction/summary` 事件）。
 *
 * @module dsh-session-enhance/lib/context/host
 */

/** 浏览器半调用本组件的 RPC 通道前缀（与分享 / 重试通道各自独立）。 */
export const CONTEXT_RPC_CHANNEL = '/dsh-session-enhance-context';

/** 手动压缩的等待上限：压缩要调用摘要模型，长历史可能跑几分钟。 */
export const MANUAL_COMPACT_TIMEOUT_MS = 300_000;

/** 请求体上限：只传 sessionId，32 KiB 富余。 */
export const MAX_RPC_BODY_BYTES = 32 * 1024;

/**
 * 组装 `{ ok, value }` 成功信封。
 *
 * @param {unknown} value - 返回值。
 * @returns {{ ok: true, value: unknown }} 信封。
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * 组装 `{ ok:false, error }` 失败信封（`details` 必须是对象）。
 *
 * @param {string} code - 机器可读错误码。
 * @param {string} message - 人类可读说明。
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} 信封。
 */
function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * 从 payload 里读 sessionId（空/null/非字符串一律无效）。
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
 * 软取一个 Host 服务。
 *
 * @param {any} ctx - 插件上下文。
 * @param {string} name - 服务名。
 * @returns {any} 服务或 undefined。
 */
function serviceOf(ctx, name) {
  return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name];
}

/**
 * 把 `ManualCompactionError.code` 映射成稳定的机器码。
 *
 * @param {unknown} error - 捕获到的异常。
 * @returns {string} 机器码。
 */
function compactionErrorCode(error) {
  const code = error !== null && typeof error === 'object' ? String(/** @type {any} */ (error).code ?? '') : '';
  switch (code) {
    case 'busy':
      return 'BUSY';
    case 'cancelled':
      return 'CANCELLED';
    case 'changed':
      return 'CHANGED';
    case 'summary':
      return 'SUMMARY_FAILED';
    case 'commit':
      return 'COMMIT_FAILED';
    case 'persistence':
      return 'PERSISTENCE_FAILED';
    default:
      return 'COMPACT_FAILED';
  }
}

/**
 * 创建上下文 RPC 端点处理函数（与 HTTP 解耦，可离线单测）。
 *
 * @param {{ ctx: any, logger?: any }} options - 依赖。
 * @returns {(method: string, payload: unknown) => Promise<object>} 处理函数。
 */
export function createContextHandler({ ctx, logger }) {
  /**
   * 取某会话的 live Agent（compress 与 pressure 都要求会话里有 live agent）。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {any} agent 或 undefined。
   */
  const agentOf = (sessionId) => {
    const agents = serviceOf(ctx, 'agents');
    return typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
  };

  return async function handle(method, payload) {
    switch (method) {
      case 'get': {
        const sessionId = readSessionId(payload);
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        const agent = agentOf(sessionId);
        if (agent === undefined || agent === null) {
          // 没有 live agent（历史会话刚打开、或会话已卸载）：没有压力可报，界面隐藏。
          return ok({ available: false, reason: 'NO_LIVE_AGENT' });
        }
        const meter = serviceOf(ctx, 'tokenMeter');
        if (typeof meter?.contextPressure !== 'function') {
          return ok({ available: false, reason: 'NO_TOKEN_METER' });
        }
        let pressure;
        try {
          pressure = meter.contextPressure(agent.session) ?? {};
        } catch (error) {
          logger?.debug?.(`[dsh-session-enhance/context] contextPressure failed: ${String(error?.message ?? error)}`);
          return ok({ available: false, reason: 'PRESSURE_UNAVAILABLE' });
        }
        const compaction = serviceOf(ctx, 'compaction');
        return ok({
          available: true,
          pressureTokens: typeof pressure.pressureTokens === 'number' ? pressure.pressureTokens : null,
          contextWindow: typeof pressure.contextWindow === 'number' ? pressure.contextWindow : null,
          canCompact: typeof compaction?.compactNow === 'function',
        });
      }
      case 'compact': {
        const sessionId = readSessionId(payload);
        if (sessionId === undefined) return fail('BAD_REQUEST', 'payload.sessionId is required');
        const compaction = serviceOf(ctx, 'compaction');
        if (typeof compaction?.compactNow !== 'function') {
          return fail(
            'COMPACTION_UNAVAILABLE',
            'Compaction is not available in this deployment (mount @deepseek-ai/dsh-compaction-basic).',
          );
        }
        const agent = agentOf(sessionId);
        if (agent === undefined || agent === null) {
          return fail('NO_LIVE_AGENT', 'This session has no live agent to compact.');
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort(new Error('manual compaction timed out'));
        }, MANUAL_COMPACT_TIMEOUT_MS);
        timer.unref?.();
        try {
          const signal =
            typeof AbortSignal.any === 'function'
              ? AbortSignal.any([controller.signal])
              : controller.signal;
          const result = await compaction.compactNow(agent, signal, 'dsh-session-enhance-context');
          if (result === null || result === undefined) {
            return ok({ compacted: false, reason: 'NO_RANGE' });
          }
          return ok({
            compacted: true,
            items: Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : null,
            tokensSaved:
              typeof result.shadowedTokenCount === 'number' ? result.shadowedTokenCount : null,
          });
        } catch (error) {
          const code = compactionErrorCode(error);
          const message = String(error?.message ?? error);
          logger?.debug?.(`[dsh-session-enhance/context] manual compaction failed (${code}): ${message}`);
          return fail(code, message);
        } finally {
          clearTimeout(timer);
        }
      }
      case 'diag': {
        const compaction = serviceOf(ctx, 'compaction');
        const meter = serviceOf(ctx, 'tokenMeter');
        return ok({
          hasCompaction: typeof compaction?.compactNow === 'function',
          hasTokenMeter: typeof meter?.contextPressure === 'function',
          timeoutMs: MANUAL_COMPACT_TIMEOUT_MS,
        });
      }
      default:
        return fail('UNKNOWN_METHOD', `Unknown endpoint "${String(method)}"`);
    }
  };
}

/**
 * 在 Host 的 web server 上注册上下文 RPC 前缀路由。
 *
 * 与分享 / 重试通道相同的配方：自建 prefix 路由 + `connection.admit(req)` 认证；
 * `webServer` 形状不兼容时退回官方 `connection.rpc.handle`。
 *
 * @param {any} ctx - 插件上下文。
 * @param {(method: string, payload: unknown) => Promise<object>} handler - 端点处理函数。
 * @returns {void}
 */
export function installContextChannel(ctx, handler) {
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
          path: CONTEXT_RPC_CHANNEL,
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
            const endpoint = url.pathname.startsWith(`${CONTEXT_RPC_CHANNEL}/`)
              ? url.pathname.slice(CONTEXT_RPC_CHANNEL.length + 1)
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
          return connection.rpc.handle(CONTEXT_RPC_CHANNEL, async (method, payload) =>
            handler(method, payload),
          );
        } catch {
          return () => {};
        }
      }
    }, 'dsh-session-enhance: context rpc channel');
  });
}
