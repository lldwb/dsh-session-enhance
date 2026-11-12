/**
 * 重试半的 Host 侧：模型调用失败后，点「重试」直接重新调用模型。
 *
 * 本文件由原 `dsh-turn-retry` 插件的入口抽成，合并进「会话增强」后入口变成
 * {@link installTurnRetry}，行为与注释原样保留。
 *
 * ## 它解决的痛点
 *
 * DSH 的模型请求自带自动重试（默认 5 次，指数退避），但**重试全部失败**之后，
 * 这一轮（turn）会以错误结束，界面只剩一行红色错误。用户想继续，只能自己在输入框
 * 敲一句「继续」——这会往对话里追加一条用户消息，污染历史，而且要先想"该说什么"。
 *
 * ## 机制（为什么能做到"不追加消息"）
 *
 * `@deepseek-ai/dsh-agent-loop` 在最终失败后会走一个 waterfall：
 *
 * ```js
 * const action = await this.dispatch.waterfall('agent/request-error', payload, () => Promise.resolve(void 0));
 * if (action?.kind !== 'retry') throw new LlmError(...);
 * continue;   // ← 回到同一 turn/step 的模型请求
 * ```
 *
 * 也就是说：**监听器返回 `{ kind: 'retry' }`，loop 就在原地重新 dispatch 模型调用**，
 * 不会追加用户消息，也不会开新 turn。默认（不返回或返回 undefined）则是原本的
 * "这一轮失败"。
 *
 * 关键取舍：用户点按钮是**异步**的，所以监听器必须把这次失败**挂住**——返回一个
 * 尚未 resolve 的 Promise，等浏览器半把用户的点击通过 RPC 送回来再放行。挂起期间
 * 这一轮的 turn 尚未结束（Agent 仍是 running），这是必要的：一旦让 loop 收尾，
 * 就再也没有"在同一处重新调用模型"的入口了。
 *
 * 为了防止把 Agent 永久卡住，闸门有等待上限（默认 120s），并且会在下列情况立刻
 * 放行：用户按停止 / turn 被取消（`signal` abort）、插件卸载、同一会话开了新闸门。
 *
 * ## 只拦"人能看到"的失败
 *
 * - 不是 root Agent（子代理、workflow 子任务）不拦：那些没有对应界面，挂住只会
 *   让父流程一起等超时。
 * - 没有活跃浏览器客户端时不拦：没人能点按钮，挂住没有意义。
 * - `signal` 已 abort 时不拦：用户已经按了停止。
 *
 * ## turn 结束后仍可重试
 *
 * 闸门只在 turn 结束前存在（可见会话最多 120 秒、不可见会话 5 秒孤儿保护）。为避免
 * "turn 已经结束、用户后来才看到错误 → 永远没有重试入口"，`turn/end` 以
 * `reason.kind === 'error'` 收尾时还会在 recovery 里记一条（TTL 30 分钟）：
 * 用户随时回到该会话，覆盖层都会显示「上一轮失败 —— 点击重试」。代价与停止后重试
 * 相同 —— 只能 `agent.followup()` 驱动新 turn，历史里会多一条中性消息。
 *
 * @module dsh-session-enhance/lib/retry/host
 */

import { randomUUID } from 'node:crypto';

import { DEFAULT_ORPHAN_WAIT_MS, DEFAULT_WAIT_MS, RetryGate } from './gate.mjs';
import { Diagnostics } from './diagnostics.mjs';
import { RecoveryStore } from './recovery.mjs';
import { createRpcHandler, installRpcChannel } from './rpc.mjs';

/** 重试半的构建戳：行为有可观察变化时递增，便于从日志确认进程里跑的是哪版。 */
export const RETRY_BUILD = '2026-11-12.1';

/** 等待上限（毫秒）。超过后按原有语义结束这一轮。 */
export const WAIT_MS = DEFAULT_WAIT_MS;

/** 开闸后多久没人来查 pending 就放行（毫秒）。 */
export const ORPHAN_WAIT_MS = DEFAULT_ORPHAN_WAIT_MS;

/**
 * 「停止后重试」用的驱动消息文本。
 *
 * 用户点停止之后，这一轮已经结束，物理上无法原地重试（turn 信号已经 abort），
 * 只能用 `agent.followup()` 排一条消息驱动新的一轮。这条消息会进入会话历史，
 * 所以写得尽量中性、不含额外要求，让模型只做"继续刚才那件事"。
 */
export const CONTINUE_PROMPT = '（上一轮被用户中断。请从中断处继续完成，不要复述已完成的部分。）';

/**
 * 本插件的历史 source kind（2.x 时代的包名，3.0 改名后刻意保留）。
 *
 * 2.0.2 起不再用于 `agent.followup()`：那条消息必须伪装成**普通用户消息**
 * （`source.kind === 'user'`）——队列 dock 对非 user 的 source 会走不同分支，实测会崩。
 * 保留这个导出只是为了让旧日志/旧记录仍能对上号，以及给外部脚本一个稳定字符串。
 */
export const RETRY_SOURCE_KIND = 'dsh-session-id';

/**
 * 生成 followup 消息的 id。
 *
 * `agent-loop` 的 inbox 投影会把每条待处理消息按 `message.id` 去重（重复即抛
 * `message "..." is already pending`），队列 dock 也用它当 React key。所以程序化
 * 追加消息时必须自带一个唯一 id —— 这是 `agent.followup()` 的隐式契约。
 *
 * 前缀保留 2.x 的 `dsh-session-id-retry-`（不是新包名）：历史会话里已经有该前缀的
 * 记录，保持同一种前缀才能跨版本 grep / 统计「插件注入的重试消息」。
 *
 * @returns {string} 唯一消息 id。
 */
export function createRetryMessageId() {
  return `dsh-session-id-retry-${randomUUID()}`;
}

/**
 * 从 Agent 身上取会话 id。
 *
 * DSH 的 `Agent` 暴露会话对象的字段名在版本间有过差异（`id` / `sessionId`），
 * 这里两种都认，避免因一个字段名让整个插件静默失效。
 *
 * @param {unknown} agent - Agent 对象。
 * @returns {string} 会话 id；取不到时为空串。
 */
export function sessionIdOf(agent) {
  const session = /** @type {{ session?: { id?: unknown, sessionId?: unknown } }} */ (agent)?.session;
  const raw = session?.id ?? session?.sessionId;
  return typeof raw === 'string' ? raw : '';
}

/**
 * 软取一个 Host 服务：Cordis 里服务既可能通过 `ctx.get(name)` 拿，也可能作为属性直取。
 *
 * @param {any} ctx - 插件上下文。
 * @param {string} name - 服务名。
 * @returns {any} 服务或 undefined。
 */
function serviceOf(ctx, name) {
  return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name];
}

/**
 * 判断一个 Agent 是不是「有界面的根 Agent」。
 *
 * DSH 0.2.2-rc.2 移除了 `agents.roots()`（同批还移除了 `isOwnedBy()`，并把
 * `enter(agent, owner)` 改成 `enter(agent)`）：运行时 owner 关系换成了 subagent 树。
 * 所以这里按三代信号依次判，任一代给出布尔结论就返回：
 *
 * 1. `agents.roots()`（0.2.2-rc.1 及更早，运行时 owner 关系，最权威）；
 * 2. `subagents.rootOf(agent) === agent`（0.2.2-rc.2 起：rootOf 返回 agent 所在
 *    子智能体树的 live root，agent 自己就是 root 时返回它自己）；
 * 3. 会话头 `origin !== 'subagent'`（两个服务都缺时的最后兜底；注意 fork 会话的
 *    `parentSession` 有值但 `origin` 不是 subagent，仍算根）。
 *
 * @param {any} ctx - 插件上下文。
 * @param {any} agent - 待判定的 Agent。
 * @returns {{ root: boolean | undefined, probe: object }} `root` 为 undefined 表示无法判断（不要据此否决）。
 */
export function detectRootAgent(ctx, agent) {
  const probe = { via: 'unknown', root: null, detail: '' };
  if (agent === undefined || agent === null) return { root: undefined, probe };

  const agents = serviceOf(ctx, 'agents');
  if (typeof agents?.roots === 'function') {
    try {
      const roots = agents.roots();
      if (Array.isArray(roots)) {
        probe.via = 'agents.roots';
        probe.count = roots.length;
        probe.root = roots.includes(agent);
        return { root: probe.root, probe };
      }
    } catch (error) {
      probe.detail = String(error?.message ?? error);
    }
  }

  const subagents = serviceOf(ctx, 'subagents');
  if (typeof subagents?.rootOf === 'function') {
    try {
      probe.via = 'subagents.rootOf';
      probe.root = subagents.rootOf(agent) === agent;
      return { root: probe.root, probe };
    } catch (error) {
      probe.detail = String(error?.message ?? error);
    }
  }

  const header = agent?.session?.header;
  if (header !== null && typeof header === 'object') {
    probe.via = 'session.header';
    probe.root = header.origin !== 'subagent';
    return { root: probe.root, probe };
  }

  return { root: undefined, probe };
}

/**
 * 判定这次失败是否值得挂起等用户点击，并给出**为什么**。
 *
 * 除了结论，还返回 `reasons`（逐条否决原因）与 `probe`（当时的运行时探测快照）。
 * 这两个字段只用于诊断：界面表现为「按钮没出现」时，光看 UI 无法区分是"不是 root
 * Agent"、"没有活跃客户端"还是"下游还在自动重试"，而 `diag` RPC 端点能直接给出。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} payload - `agent/request-error` 的 payload。
 * @returns {{ allowed: boolean, reasons: string[], probe: object }} 判定结果。
 */
export function evaluateGate(ctx, payload) {
  const reasons = [];
  const probe = {
    hasGet: typeof ctx.get === 'function',
    hasAgentsService: false,
    rootsIncludes: null,
    rootProbe: null,
    hasGateway: false,
    hasLiveClient: null,
  };

  const signal = payload?.signal;
  if (signal !== undefined && signal !== null && signal.aborted === true) {
    reasons.push('signal-aborted');
  }

  // 上下文窗口溢出是**确定性**失败：重试只会再发一次同样超长的输入，必然再次失败
  // （4.1 起由 composer 的「上下文 / 压缩」按钮 + compaction-basic 负责处理）。
  // 所以这里不给重试按钮，避免用户点了之后又是红色错误、还把会话历史越堆越长。
  if (payload?.failure?.code === 'CONTEXT_WINDOW_EXCEEDED') {
    reasons.push('context-overflow');
  }

  // 只处理"有人能看见"的 root Agent。子代理/工作流子任务没有对应界面。
  // 0.2.2-rc.2 移除了 agents.roots()，detectRootAgent 会按 roots() → subagents.rootOf()
  // → 会话头 origin 三代信号回退，见其 docblock。
  const agents = serviceOf(ctx, 'agents');
  probe.hasAgentsService = agents !== undefined && agents !== null;
  const rootDetection = detectRootAgent(ctx, payload?.agent);
  probe.rootProbe = rootDetection.probe;
  probe.rootsIncludes = typeof rootDetection.root === 'boolean' ? rootDetection.root : null;
  if (rootDetection.root === false) reasons.push('not-root-agent');

  // 没有活跃浏览器客户端时挂起毫无意义（没人点得到按钮）。
  //
  // 这里故意 fail-closed：探测服务缺失时**不**挂起。理由是"挂起要有人能点"，而
  // 服务缺失恰恰说明当前部署形态未知（headless 模板、未来的精简组合）；误挂会把
  // 一个无人值守的任务卡到 120 秒超时，代价远高于"少一个按钮"。headless 模板实测
  // 该服务存在且 hasLiveClient() === false，两条路径都不会挂。
  const gateway = typeof ctx.get === 'function' ? ctx.get('typertGateway') : ctx.typertGateway;
  probe.hasGateway = gateway !== undefined && gateway !== null;
  if (!probe.hasGateway) {
    reasons.push('no-typert-gateway');
  } else if (typeof gateway.hasLiveClient !== 'function') {
    reasons.push('gateway-without-hasLiveClient');
  } else {
    try {
      probe.hasLiveClient = gateway.hasLiveClient();
      if (probe.hasLiveClient !== true) reasons.push('no-live-client');
    } catch (error) {
      probe.hasLiveClient = null;
      probe.liveClientError = String(error?.message ?? error);
      reasons.push('live-client-probe-failed');
    }
  }

  return { allowed: reasons.length === 0, reasons, probe };
}

/**
 * 判定这次失败是否值得挂起（布尔快捷方式）。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} payload - `agent/request-error` 的 payload。
 * @returns {boolean} 是否挂起。
 */
export function shouldGate(ctx, payload) {
  return evaluateGate(ctx, payload).allowed;
}

/**
 * 构造「停止后重试」驱动用的那条 user 消息。
 *
 * `agent.followup(input)` 的声明是 `UserMessage`（见 `@deepseek-ai/dsh-llm/message`：
 * `{ id, role: 'user', content, source }`），所以这里必须给全四个字段：
 *
 * - `id`：inbox 投影按 id 去重、队列 dock 拿它当 React key，缺了就崩/重复即抛；
 * - `role`：**0.2.2 起最容易被漏掉的一个**——漏了事件照样写进日志，但
 *   `dsh-session` 在 seed/load 边界会拒绝它（`message must have role "user"`），
 *   后果是这次请求被提供方 400 拒掉（真实回归里 sub2api 报 `missing field 'role'`），
 *   并且该会话此后再也读不出来（`readSurface` / `readTitleSnapshots` 走同一条日志校验，
 *   分享页显示 0 条消息、标题退回「会话分享」）；
 * - `content` / `source`：队列 dock 会读 `content[].text` 与 `source.kind`。
 *
 * 抽成导出函数是为了让测试能直接钉住这个契约（形状错在真实运行时才发现，代价太大）。
 *
 * @returns {{ id: string, role: 'user', content: Array<{ type: 'text', text: string }>, source: { kind: 'user' } }} user 消息。
 */
export function createRetryUserMessage() {
  return {
    id: createRetryMessageId(),
    role: 'user',
    content: [{ type: 'text', text: CONTINUE_PROMPT }],
    source: { kind: 'user' },
  };
}

/**
 * 在已经运行的插件上下文里装上重试半。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @returns {void}
 */
export function installTurnRetry(ctx) {
  const gate = new RetryGate({ waitMs: WAIT_MS });
  const recovery = new RecoveryStore();
  const diagnostics = new Diagnostics();

  /**
   * 驱动一次新的 turn（「停止后重试」路径）。
   *
   * 这里只能用 `agent.followup()`：它是 Agent 上唯一"排一条 user 消息并唤醒驱动器"
   * 的入口（`inject()` 不唤醒，`steer()` 面向进行中的步骤）。所以停止后的重试会在
   * 历史里留下一条本插件签名的消息 —— 这是 DSH 当前架构下无法回避的代价。
   *
   * @param {string} sessionId - 目标会话。
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>} 结果。
   */
  const driveRetry = async (sessionId) => {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents;
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
    if (agent === undefined || agent === null) {
      return { ok: false, code: 'NO_LIVE_AGENT', message: 'This session has no live agent to drive.' };
    }
    if (typeof agent.followup !== 'function') {
      return { ok: false, code: 'NO_FOLLOWUP', message: 'Agent.followup is unavailable in this build.' };
    }
    try {
      // 消息形状（含 0.2.2 必需的 `role: 'user'`）由 `createRetryUserMessage()`
      // 统一构造并被单元测试钉住，见该函数的注释。
      await agent.followup(createRetryUserMessage());
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'FOLLOWUP_FAILED', message: String(error?.message ?? error) };
    }
  };

  // 浏览器半的动作通道（pending / retry / cancel / list / diag）。
  installRpcChannel(
    ctx,
    createRpcHandler({
      gate,
      recovery,
      driveRetry,
      diagnostics,
      // 诊断端点读"此刻"的探测状态：服务是否在场、有没有活跃客户端。
      probe: () => ({ ...evaluateGate(ctx, { agent: undefined, signal: undefined }).probe, gates: gate.size }),
    }),
  );

  // 「用户点了停止」的记录：turn 收尾时 reason 是
  // `{ kind: 'aborted', reason: { kind: 'user' | 'parent' | 'disposed' | 'hook' } }`。
  // 只有 `user` 才代表本人按了停止；其余（归档、插件 hook、父代理收尾）不该给重试。
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session?.id ?? session?.sessionId ?? '');
    if (sessionId === '') return;

    if (event.type === 'turn/start') {
      // 新的一轮开始了：之前那条"可重试"的记录已经过时。
      recovery.forget(sessionId);
      return;
    }
    if (event.type !== 'turn/end') return;

    const reason = event.data?.reason;
    if (reason === undefined || reason === null) return;

    // 两种"这一轮已经结束、但用户可能想再来一次"的收尾：
    // - error：模型最终失败（自动重试耗尽）后 turn 以错误结束。闸门只存在于 turn
    //   结束前（可见会话最多 120 秒、不可见会话 5 秒孤儿保护），一旦 turn 结束，
    //   浏览器半就再也没有入口显示「重试」。所以这里补一条 recovery：**失败之后**
    //   用户随时回到这个会话（哪怕切走过、或当时根本没看这屏）仍能点重试。
    // - aborted + user cause：用户自己点了停止（原有路径）。
    const causeKind =
      reason.kind === 'error' && reason.error?.code === 'CONTEXT_WINDOW_EXCEEDED'
        ? undefined
        : reason.kind === 'error'
          ? 'error'
          : reason.kind === 'aborted' && reason.reason?.kind === 'user'
            ? 'user'
            : undefined;
    if (causeKind === undefined) {
      if (reason.kind === 'error' && reason.error?.code === 'CONTEXT_WINDOW_EXCEEDED') {
        diagnostics.record({ kind: 'context-overflow-skipped', sessionId, turn: event.data?.turn });
      }
      return;
    }

    // 只在"有人能看见、能点"的会话里记 —— 与失败路径用同一套探测。
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents;
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
    const verdict = evaluateGate(ctx, { agent, signal: undefined });
    if (!verdict.allowed) {
      diagnostics.record({
        kind: causeKind === 'error' ? 'failure-skipped' : 'stop-skipped',
        sessionId,
        turn: event.data?.turn,
        reasons: verdict.reasons,
        probe: verdict.probe,
      });
      return;
    }

    recovery.remember(sessionId, { turn: event.data?.turn, causeKind });
    diagnostics.record({
      kind: causeKind === 'error' ? 'failure-recorded' : 'stop-recorded',
      sessionId,
      turn: event.data?.turn,
    });
  });

  ctx.on('agent/request-error', async (payload, next) => {
    const verdict = evaluateGate(ctx, payload);
    if (!verdict.allowed) {
      // 不挂起也要留痕：界面表现为"按钮没出现"时，这条记录是唯一的线索。
      diagnostics.record({
        kind: 'skipped',
        sessionId: sessionIdOf(payload.agent),
        turn: payload.turn,
        step: payload.step,
        provider: payload.provider,
        reasons: verdict.reasons,
        probe: verdict.probe,
      });
      return next();
    }

    const sessionId = sessionIdOf(payload.agent);
    if (sessionId === '') return next();

    // 先问下游：DSH 自带的重试策略如果还愿意重试（返回 `{ kind: 'retry' }`），
    // 就让它继续 —— 自动重试期间不该用按钮打扰用户。
    //
    // 这一步是整个插件语义的关键：`agent/request-error` 是**每次** attempt 失败都会
    // 触发的 waterfall，自动重试的实现挂在它下游。只有下游放弃时，这次失败才是
    // 真正的"最终失败"，也才是该问用户要不要再来一次的时刻。
    const downstream = await next();
    if (downstream !== undefined && downstream !== null && downstream.kind === 'retry') {
      diagnostics.record({
        kind: 'auto-retry',
        sessionId,
        turn: payload.turn,
        step: payload.step,
        provider: payload.provider,
      });
      return downstream;
    }

    // 到这里说明自动重试已经耗尽（或该路由没有重试策略）：挂住等用户点击。
    diagnostics.record({
      kind: 'gate-opened',
      sessionId,
      turn: payload.turn,
      step: payload.step,
      provider: payload.provider,
      failure: payload.failure ?? null,
      probe: verdict.probe,
    });
    const { decision } = gate.open(
      sessionId,
      {
        turn: payload.turn,
        step: payload.step,
        provider: payload.provider,
        failure: payload.failure,
      },
      payload.signal,
      // 孤儿保护：开闸后若 5 秒内没有浏览器半来查 pending，说明这个页面上没有能点
      // 按钮的半边（典型：插件刚装还没刷新页面）。此时立刻按原生语义结束，而不是
      // 让用户对着"运行中"白等满 120 秒。
      { orphanWaitMs: ORPHAN_WAIT_MS },
    );

    const reason = await decision;
    diagnostics.record({ kind: 'gate-closed', sessionId, reason, turn: payload.turn, step: payload.step });
    if (reason === 'retry') {
      ctx.logger?.info?.(`[dsh-session-enhance/retry] retry requested for ${sessionId} (turn ${payload.turn}, step ${payload.step})`);
      // 交给 loop：同一 turn/step 重新请求模型，不追加任何用户消息。
      return { kind: 'retry' };
    }
    ctx.logger?.debug?.(`[dsh-session-enhance/retry] gate closed (${reason}) for ${sessionId}`);
    // 放弃/超时/取消：**不调用 next()**。调用它会把决策交回自动重试策略，那会继续
    // 重试而不是结束这一轮；直接返回 undefined 才是"让它失败"的语义。
    return undefined;
  });

  // 插件卸载/重载时把挂起的 turn 全部放行，别让它们永远等下去。
  ctx.effect(() => () => {
    gate.dispose();
    recovery.clear();
  }, 'dsh-session-enhance: retry gate lifecycle');

  ctx.logger?.info?.(
    `[dsh-session-enhance/retry] ready (build=${RETRY_BUILD}, waitMs=${WAIT_MS}, orphanWaitMs=${ORPHAN_WAIT_MS})`,
  );
}
