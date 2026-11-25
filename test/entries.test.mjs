/**
 * 四个 Loader 行入口的离线冒烟。
 *
 * 这一层只检查**形状**：每个入口导出 `name` / `inject` / `apply`，且 `apply` 在 mock
 * ctx 上注册了该组件应有的东西。真实 Loader 能否解析子路径 specifier、界面「包含的
 * 组件」显示几行，属于沙箱回归的范围（`devkit_sandbox_compose` / UI 沙箱），
 * `node --test` 看不到。
 *
 * @module dsh-session-enhance/test/entries
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as copyEntry from '../index.js';
import * as shareEntry from '../share/index.js';
import * as retryEntry from '../retry/index.js';
import * as offpeakEntry from '../offpeak/index.js';

/**
 * 造一个够用的 mock ctx。
 *
 * @param {Record<string, any>} [services] - `ctx.get()` 能取到的服务。
 * @returns {any} mock 上下文。
 */
function mockCtx(services = {}) {
  const tools = [];
  const effects = [];
  const events = [];
  const injections = [];
  return {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    get(key) {
      return services[key];
    },
    effect(fn, _label) {
      effects.push(fn);
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    on(event, handler) {
      events.push({ event, handler });
      return () => {};
    },
    inject(deps, callback) {
      injections.push({ deps, callback });
      return () => {};
    },
    logger: { info() {}, debug() {}, warn() {} },
    // 供断言读取的采集面。
    collected: { tools, effects, events, injections },
  };
}

test('四个入口都导出 name / inject / apply，且 name 与 Loader 行的 specifier 对应', () => {
  assert.equal(copyEntry.name, 'dsh-session-enhance');
  assert.equal(shareEntry.name, 'dsh-session-enhance/share');
  assert.equal(retryEntry.name, 'dsh-session-enhance/retry');
  assert.equal(offpeakEntry.name, 'dsh-session-enhance/offpeak');

  for (const entry of [copyEntry, shareEntry, retryEntry, offpeakEntry]) {
    assert.equal(typeof entry.apply, 'function');
    assert.ok(Array.isArray(entry.inject), 'inject 必须是数组');
  }

  // 前两个入口注册工具，都依赖 tools；中断重试与谷峰会话不注册工具，不声明这个硬依赖。
  assert.deepEqual(copyEntry.inject, ['tools']);
  assert.deepEqual(shareEntry.inject, ['tools']);
  assert.deepEqual(retryEntry.inject, []);
  assert.deepEqual(offpeakEntry.inject, []);
});

test('会话增强行注册 session_lookup / overview / grep / read 与 session_resume_subagents', () => {
  const ctx = mockCtx();
  copyEntry.apply(ctx);

  const names = ctx.collected.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'session_lookup',
    'session_overview',
    'session_grep',
    'session_read',
    'session_resume_subagents',
  ]);
  assert.match(ctx.collected.tools[0].description, /session ID/i);
  // 「先概括、再定向读」三件套的描述里要能看出分工（模型只读描述选工具）。
  assert.match(ctx.collected.tools[1].description, /how big|overview|first look/i);
  assert.match(ctx.collected.tools[2].description, /search INSIDE one/i);
  assert.match(ctx.collected.tools[3].description, /raw log text/i);
  assert.match(ctx.collected.tools[4].description, /subagent/i);
});

test('工具名不得与随附包的官方工具重名（重名会让官方插件行整行激活失败）', () => {
  // 真实事故（2026-11-17）：5.6.0 把会话内检索工具取名 `session_search`，与随附包的
  // `@deepseek-ai/dsh-tool-session-query` 同名。工具注册表对重名是**硬失败**，于是
  // 「设置 → 插件 → 实验性插件 → 会话搜索 → 会话历史工具」那一行被标成「异常」：
  //   tool "session_search" is already registered (for a per-agent variant, register
  //   through that agent's `agent.ctx` instead)
  // 用户在插件页看到红字，官方跨会话检索也跟着不可用。修复：本插件改名为 `session_grep`。
  //
  // 这份名字清单抄自随附包源码 `dsh-tool-session-query/src/index.ts`（DSH 0.2.2-rc.3
  // 的 `ctx.tools.register()` 五处 `name:`）。**升级 DSH 后要复核**，新增的官方工具名
  // 也加进来——这条门禁的价值就是「别再撞名」。
  const OFFICIAL_SESSION_TOOL_NAMES = [
    'session_search',
    'session_event_search',
    'session_trace',
    'session_event_trace',
    'session_event_read',
  ];

  const ctx = mockCtx();
  copyEntry.apply(ctx);
  const ours = ctx.collected.tools.map((tool) => tool.name);
  for (const name of ours) {
    assert.equal(
      OFFICIAL_SESSION_TOOL_NAMES.includes(name),
      false,
      `工具名 "${name}" 与官方 dsh-tool-session-query 重名：官方那行会整行激活失败`,
    );
  }
});

test('会话增强行声明 autoCompact 设置：volatile、默认关闭，并关闭自动生成页', () => {
  assert.equal(copyEntry.SETTINGS_NAMESPACE, 'dsh-session-enhance');

  const field = copyEntry.Config.dict.autoCompact;
  assert.equal(field.type, 'boolean');
  assert.equal(field.meta.volatile, true, 'volatile 才会出现在设置页并可热更新');
  assert.equal(field.meta.default, false, '自动压缩默认关闭');
  const parsed = new copyEntry.Config({});
  assert.equal(typeof parsed.autoCompact.get, 'function');
  assert.equal(parsed.autoCompact.get(), false);

  // 两级阈值也可配（volatile，设置页保存后热更新）。
  for (const [key, expected] of [
    ['pruneRatio', 0.6],
    ['compactRatio', 0.8],
  ]) {
    const ratioField = copyEntry.Config.dict[key];
    assert.equal(ratioField.type, 'number', key);
    assert.equal(ratioField.meta.volatile, true, `${key} 必须 volatile`);
    assert.equal(ratioField.meta.default, expected, key);
    assert.equal(parsed[key].get(), expected, key);
  }

  // apply 会在 settings 服务在场时声明「自绘页」策略（auto:false）。
  const ctx = mockCtx();
  copyEntry.apply(ctx);
  const settingsInjection = ctx.collected.injections.find((entry) => entry.deps.includes('settings'));
  assert.ok(settingsInjection, '应可选注入 settings');
  const calls = [];
  const settingsCtx = {
    settings: {
      configure: (presentation, owner) => {
        calls.push({ presentation, owner });
        return () => {};
      },
    },
    effect: (factory) => {
      const dispose = factory();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
  settingsInjection.callback(settingsCtx);
  assert.deepEqual(calls[0].presentation, { auto: false });
});

test('分享行只注册 session_share，并挂上两条路由（RPC 前缀 + 公开页）', async () => {
  const previousHome = process.env.DSH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-enhance-entries-'));
  process.env.DSH_HOME = home;
  try {
    const ctx = mockCtx({ sessionQuery: {}, sessions: {} });
    shareEntry.apply(ctx);

    const names = ctx.collected.tools.map((tool) => tool.name);
    assert.deepEqual(names, ['session_share']);

    // 两条路由都包在 `ctx.inject([...], cb)` 里等 webServer / connection 就位。
    const deps = ctx.collected.injections.map((entry) => entry.deps.join(','));
    assert.ok(deps.includes('connection,webServer'), '应声明分享 RPC 通道');
    assert.ok(deps.includes('webServer,sessionQuery'), '应声明公开分享路由');

    // 存储确实建在了 DSH_HOME 下：`list` 能正常返回空列表（目录在首次写入时才建，
    // 所以这里断言的行为面，不是文件是否存在）。
    const listed = await ctx.collected.tools[0].execute({ action: 'list' }, {});
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.shares, []);
    assert.equal(fs.existsSync(path.join(home, 'dsh-session-enhance', 'shares.json')), false, '纯查询不该落盘');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('中断重试行不注册工具，只挂 session/event 与 RPC 通道', () => {
  const ctx = mockCtx();
  retryEntry.apply(ctx);

  assert.deepEqual(ctx.collected.tools, [], '中断重试组件不该注册模型工具');

  const events = ctx.collected.events.map((entry) => entry.event);
  assert.ok(events.includes('session/event'), '应监听 turn 结束以判定用户中断');

  const deps = ctx.collected.injections.map((entry) => entry.deps.join(','));
  assert.ok(deps.includes('connection,webServer'), '应声明中断重试 RPC 通道');
});

test('谷峰会话行不注册工具，挂 agent 生命周期事件、配置热更新事件与 RPC 通道', () => {
  const previousHome = process.env.DSH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-enhance-offpeak-entries-'));
  process.env.DSH_HOME = home;
  try {
    const ctx = mockCtx();
    offpeakEntry.apply(ctx);

    assert.deepEqual(ctx.collected.tools, [], '谷峰会话组件不该注册模型工具');

    const events = ctx.collected.events.map((entry) => entry.event);
    for (const required of ['agent/created', 'agent/status', 'agent/disposed']) {
      assert.ok(events.includes(required), `应监听 ${required}`);
    }
    // 配置热更新（事件不存在时会静默降级，但入口必须尝试订阅）。
    assert.ok(events.includes('app-boot/config-reload'), '应监听配置重载');
    assert.ok(events.includes('settings/document-updated'), '应监听设置页保存');

    const deps = ctx.collected.injections.map((entry) => entry.deps.join(','));
    assert.ok(deps.includes('connection,webServer'), '应声明谷峰会话 RPC 通道');

    // 控制器挂载点交给 ctx.effect：组件停用即释放全部 hold。
    assert.ok(ctx.collected.effects.length >= 1, '应通过 ctx.effect 注册 dispose');
    // 状态文件路径在 DSH_HOME 下（此时还没写盘）。
    assert.equal(fs.existsSync(path.join(home, 'dsh-session-enhance', 'offpeak.json')), false);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('谷峰会话配置：四个字段都 volatile、默认值正确（设置页可热更新）', () => {
  const parsed = new offpeakEntry.Config({});
  for (const [key, expected] of [
    ['offPeakStart', '00:30'],
    ['offPeakEnd', '08:30'],
    ['timeZone', 'Asia/Shanghai'],
  ]) {
    const field = offpeakEntry.Config.dict[key];
    assert.equal(field.type, 'string', key);
    assert.equal(field.meta.volatile, true, `${key} 必须 volatile`);
    assert.equal(field.meta.default, expected, key);
    assert.equal(parsed[key].get(), expected, key);
  }
  const defaultField = offpeakEntry.Config.dict.defaultEnabled;
  assert.equal(defaultField.type, 'boolean');
  assert.equal(defaultField.meta.volatile, true);
  assert.equal(defaultField.meta.default, false, '新会话默认不启用');
  assert.equal(parsed.defaultEnabled.get(), false);
});

test('谷峰会话：非法窗口/时区回退默认值且只 warn 一次，不影响激活', () => {
  const warnings = [];
  const ctx = mockCtx();
  ctx.logger = { info() {}, debug() {}, warn: (message) => warnings.push(message) };

  // 两个字段都非法：窗口回退 00:30–08:30、时区回退 Asia/Shanghai。
  const config = new offpeakEntry.Config({ offPeakStart: '99:99', offPeakEnd: '25:00', timeZone: 'Mars/Olympus' });
  assert.doesNotThrow(() => offpeakEntry.apply(ctx, config));

  assert.equal(warnings.length, 1, '只 warn 一次');
  assert.match(warnings[0], /配置有非法值/u);
  assert.match(warnings[0], /00:30/u);
  assert.match(warnings[0], /Asia\/Shanghai/u);

  // 反复触发配置重载也只 warn 一次（缓存 + 只提示一次的标志）。
  const reload = ctx.collected.events.find((entry) => entry.event === 'app-boot/config-reload');
  assert.ok(reload, '应监听配置重载');
  for (let round = 0; round < 3; round += 1) reload.handler({});
  assert.equal(warnings.length, 1);
});
