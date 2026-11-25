/**
 * `dsh-session-enhance` 浏览器半里「谷峰会话」chip 的离线冒烟测试。
 *
 * 覆盖四件事（都不需要浏览器、不联网、不调模型）：
 *
 * 1. **bundle 形状**：`client.js` 通过 `window.__ModuleLoader__.load({ id, factory })`
 *    注册，工厂只 require 平台模块表里的两个说明符，并导出 `apply` / `inject` /
 *    `OffpeakButton` 与三个纯函数；
 * 2. **槽位注册**：`apply(mockCtx)` 在 `conversation.session.header.utilities` 上注册
 *    `session-offpeak` 贡献（order -12），且原有三个组件仍在（防回归）；
 * 3. **词典**：`offpeak.*` 词条在 en / zh 两份词典里键集一致，中文是「谷峰 / 谷时 /
 *    暂停」这类自然文案；
 * 4. **行为**：纯函数（倒计时格式、状态判定、时区换算）＋ 组件渲染出的 `data-*`
 *    钩子与 title 文案 ＋ 控制器 RPC/定时器语义（busy → 服务端返回 → 失败回退并
 *    Toast、1 秒 tick、15 秒轮询、订阅者归零时清理定时器）。
 *
 * ## harness 是怎么立起来的
 *
 * `client.js` 是手写 bundle：顶层只有一句 `window.__ModuleLoader__.load({ factory })`，
 * factory 里 `require` 两个 shell 静态模块。所以：
 *
 * 1. `import('../client.js')` **之前**摆好 `globalThis.window`（含捕获点）；
 * 2. 拿到 factory 后手动 `factory(fakeRequire)` —— 每调一次就是一个新的模块闭包，
 *    等价于刷新页面后脚本重新执行，互不污染；
 * 3. `apply(mockCtx)`，从 `slots.register` 的回调里拿到贡献项；
 * 4. 组件渲染用 `jsx` / `jsxs` 的测试替身，产出的是一棵普通对象树，可以直接断言
 *    `data-*` 属性与文案；hooks 由测试侧直接喂快照（真实 renderer 也是这么喂的）。
 *
 * 时间相关的行为不 sleep：把 `setInterval` 替换成「只记录不调度」的替身，再手动
 * 调用记录下来的回调，定时器语义就是确定的。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

/** client.js 的绝对 URL（`import()` 需要 URL 或路径）。 */
const CLIENT_URL = new URL('../client.js', import.meta.url).href;

/** 主题槽位名（与实现约定一致）。 */
const HEADER_SLOT = 'conversation.session.header.utilities';

/** 本插件的词典命名空间。 */
const NS = 'dsh-session-enhance';

/** import 之后由 `window.__ModuleLoader__.load` 交出的 definition。 */
let capturedDefinition = null;

// ⚠️ 必须在 `import('../client.js')` **之前**摆好 window：bundle 顶层就调用
// `window.__ModuleLoader__.load(...)`，晚一步就是 "window is not defined"。
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      capturedDefinition = definition;
    }
  }
};

await import(CLIENT_URL);

// #region 测试替身：jsx / jsxs / primitives / 词典
/**
 * 极简 `jsx` 替身：只记录 type / props / key。
 *
 * 被测组件把 children 放在 props 里传，所以渲染结果是一棵可以用普通对象遍历的树。
 * @param {any} type - 元素类型。
 * @param {any} props - 属性。
 * @param {any} key - React key。
 * @returns {{ type: any, props: any, key: any }} 元素描述。
 */
function jsx(type, props, key) {
  return { type, props: props === undefined ? {} : props, key };
}

/** 与 {@link jsx} 同形（jsxs 只影响 React 内部的 children 归一化，测试不关心）。 */
const jsxs = jsx;

/** primitives 的占位组件缓存（同一个键返回同一个函数，方便按引用断言）。 */
const primitiveComponents = new Map();

/**
 * 取一个 primitives 占位组件。
 * @param {string} name - 导出名（Button / Toast / Modal …）。
 * @returns {Function} 占位组件。
 */
function primitiveOf(name) {
  if (!primitiveComponents.has(name)) {
    const component = function Primitive(props) {
      return { type: name, props };
    };
    component.displayName = name;
    primitiveComponents.set(name, component);
  }
  return primitiveComponents.get(name);
}

/** `@deepseek-ai/dsh-client-ui-primitives` 的替身：任何导出都是可调用的占位组件。 */
const primitives = new Proxy(
  {},
  {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      return primitiveOf(key);
    }
  }
);

/** factory 用到的说明符（测完断言只有平台模块表里那两个）。 */
const requiredSpecifiers = [];

/**
 * 工厂的 `require` 替身：只认两个平台模块，其它说明符照真实行为抛错。
 * @param {string} specifier - 模块说明符。
 * @returns {any} 替身模块。
 */
function fakeRequire(specifier) {
  requiredSpecifiers.push(specifier);
  if (specifier === 'react/jsx-runtime') return { jsx, jsxs };
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error(`client-modules: require("${specifier}") missed the module table`);
}

/**
 * 调一次 factory，得到一套全新的模块导出（= 刷新页面后重新执行脚本）。
 * @returns {any} `{ apply, inject, OffpeakButton, ... }`。
 */
function loadModule() {
  assert.notEqual(capturedDefinition, null, 'client.js 必须调用 window.__ModuleLoader__.load({ factory })');
  return capturedDefinition.factory(fakeRequire);
}

/**
 * 文案插值：把 `{name}` 换成 params 里的值（与真实 locale 服务同口径）。
 * @param {unknown} text - 词典原文。
 * @param {any} params - 参数。
 * @returns {string} 结果。
 */
function interpolate(text, params) {
  if (typeof text !== 'string') return '';
  if (params === null || params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

/**
 * 由词典造一个 `t`。
 * @param {Record<string, string>} dictionaries - 词典（zh）。
 * @returns {(key: string, params?: any) => string} 词典读取器。
 */
function makeT(dictionaries) {
  return (key, params) => interpolate(dictionaries[key] === undefined ? key : dictionaries[key], params);
}
// #endregion

// #region mock ctx
/**
 * 造一个够用的浏览器插件上下文。
 *
 * 只实现 `apply()` 与控制器实际用到的四个面：`locale`（绑定 + 注册）、`slots`
 * （注入即注册）、`effect`（立即执行并记住清理函数）、`connection`（透传给控制器）。
 *
 * @param {{ connection?: any }} [options] - 可注入的 RPC 连接。
 * @returns {{ ctx: any, state: any }} 上下文与记录。
 */
function createMockCtx(options = {}) {
  const state = {
    dictionaries: {},
    localeRegisters: [],
    registrations: [],
    injections: [],
    effectLabels: [],
    disposers: []
  };
  const ctx = {
    connection: options.connection,
    configForms: undefined,
    locale: {
      bind: () => (key, params) => interpolate(state.dictionaries[key] === undefined ? key : state.dictionaries[key], params),
      register: (namespace, dictionaries) => {
        state.localeRegisters.push({ namespace, dictionaries });
        Object.assign(state.dictionaries, dictionaries.zh === undefined ? {} : dictionaries.zh);
        return () => {};
      }
    },
    slots: {
      inject: (name, callback) => {
        state.injections.push(name);
        // 真实 slots.inject 在槽位声明后回调；测试里直接执行，注册结果立刻可断言。
        return callback();
      },
      register: (entry, component) => {
        const handle = { entry, component };
        state.registrations.push(handle);
        return handle;
      }
    },
    effect: (factory, label) => {
      state.effectLabels.push(label);
      const disposer = factory();
      if (typeof disposer === 'function') state.disposers.push(disposer);
      return () => {};
    }
  };
  return { ctx, state };
}

/** 推进事件循环（只 flush 微任务 + 一轮 setImmediate，不 sleep）。 */
async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 起一个「已 apply 的模块」：装好 fetch 替身（能力探测用）、执行 apply、等探测落地。
 *
 * @param {{ connection?: any, offpeakStatus?: number }} [options] - RPC 连接与谷峰通道的探测状态码。
 * @returns {Promise<any>} 环境句柄（含 restore）。
 */
async function setup(options = {}) {
  const fetchCalls = [];
  const previousFetch = globalThis.fetch;
  // 能力探测只认 HTTP 状态：200 = 组件在，405 = 组件停用。
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    const offpeakStatus = options.offpeakStatus === undefined ? 200 : options.offpeakStatus;
    return { status: url === '/dsh-session-enhance-offpeak' ? offpeakStatus : 200 };
  };
  const { ctx, state } = createMockCtx({ connection: options.connection });
  const module = loadModule();
  module.apply(ctx);
  await flushAsync();
  const localeRegister = state.localeRegisters.find((item) => item.namespace === NS);
  assert.notEqual(localeRegister, undefined, 'apply 必须注册本插件的词典');
  const zh = localeRegister.dictionaries.zh;
  return {
    module,
    ctx,
    state,
    fetchCalls,
    zh,
    en: localeRegister.dictionaries.en,
    t: makeT(zh),
    restore: () => {
      if (previousFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = previousFetch;
    }
  };
}

/**
 * 取谷峰贡献项。
 * @param {any} state - mock ctx 的记录。
 * @returns {any} `{ entry, component }`。
 */
function offpeakContributionOf(state) {
  const contribution = state.registrations.find((item) => item.entry.id === 'session-offpeak');
  assert.notEqual(contribution, undefined, 'apply 必须在标题栏 utils 槽位注册 session-offpeak');
  return contribution;
}

/**
 * 由贡献项的 `inject(sessionId)` 造一个控制器。
 * @param {any} state - mock ctx 的记录。
 * @param {string} sessionId - 会话 id。
 * @returns {any} 控制器（`{ getSnapshot, subscribe, toggle, refresh, dismissNotice, dispose }`）。
 */
function createStoreOf(state, sessionId) {
  const injected = offpeakContributionOf(state).entry.inject(sessionId);
  return injected.offpeak;
}
// #endregion

// #region 渲染工具
/**
 * 深度遍历元素树。
 * @param {any} node - 元素 / 数组 / 标量。
 * @param {(node: any) => void} visit - 访问器。
 * @returns {void}
 */
function walkTree(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  if (node.props !== undefined) walkTree(node.props.children, visit);
}

/**
 * 收集满足条件的元素。
 * @param {any} tree - 元素树。
 * @param {(node: any) => boolean} predicate - 条件。
 * @returns {any[]} 命中的元素。
 */
function collectNodes(tree, predicate) {
  const found = [];
  walkTree(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

/**
 * 渲染 chip（hooks 由测试侧直接喂快照，等价于真实 renderer 的绑定）。
 *
 * @param {any} module - 模块导出。
 * @param {(key: string, params?: any) => string} t - 词典。
 * @param {any} snapshot - 控制器快照。
 * @param {{ capability?: boolean, sessionId?: string }} [options] - 能力探测结果与会话 id。
 * @returns {any} 渲染结果与动作记录。
 */
function renderChip(module, t, snapshot, options = {}) {
  const toggles = [];
  const dismissed = [];
  const capability = options.capability === undefined ? true : options.capability;
  const props = {
    sessionId: options.sessionId === undefined ? 'session-render' : options.sessionId,
    t,
    useOffpeak: (selector) => selector(snapshot),
    useCapability: (selector) => selector({ share: true, retry: true, offpeak: capability }),
    offpeak: {
      toggle: () => {
        toggles.push(true);
        return Promise.resolve();
      },
      dismissNotice: (sequence) => {
        dismissed.push(sequence);
      }
    }
  };
  const tree = module.OffpeakButton(props);
  const buttons = collectNodes(tree, (node) => node.type === 'button');
  return { tree, button: buttons.length === 1 ? buttons[0] : undefined, buttons, toggles, dismissed };
}

/**
 * 取 chip 的文字（按钮里那个承载文案的 span）。
 * @param {any} button - 按钮元素。
 * @returns {string} 文案。
 */
function chipTextOf(button) {
  const texts = collectNodes(button, (node) => node.type === 'span' && typeof node.props.children === 'string');
  return texts.map((node) => node.props.children).join('');
}
// #endregion

// #region 状态夹具
/** `nextChangeAt`：2026-01-02 00:30Z = Asia/Shanghai 08:30（用于断言 title 里的钟点）。 */
const NEXT_CHANGE_AT = Date.UTC(2026, 0, 2, 0, 30);

/** 3h05m 的毫秒数（chip 倒计时的展示样本）。 */
const COUNTDOWN_MS = (3 * 60 * 60 + 5 * 60) * 1000;

/** 谷时窗口（与 Host 默认配置一致）。 */
const WINDOW = { start: '00:30', end: '08:30', timeZone: 'Asia/Shanghai' };

/**
 * 造一个 Host 状态。
 * @param {Record<string, any>} overrides - 覆盖字段。
 * @returns {any} 状态对象。
 */
function statusOf(overrides = {}) {
  return {
    enabled: true,
    enabledSource: 'session',
    paused: false,
    offPeak: true,
    window: { ...WINDOW },
    serverNow: NEXT_CHANGE_AT - COUNTDOWN_MS,
    nextChangeAt: NEXT_CHANGE_AT,
    nextChangeKind: 'pause',
    cover: { agent: true, running: false, held: false, interrupted: false, queued: 0 },
    persisted: true,
    build: 'test',
    ...overrides
  };
}

/**
 * 造一个控制器快照。
 * @param {Record<string, any>} overrides - 覆盖字段。
 * @returns {any} 快照对象。
 */
function snapshotOf(overrides = {}) {
  return { status: null, busy: false, notice: null, countdownMs: null, ...overrides };
}
// #endregion

// #region bundle 形状
test('bundle 用 window.__ModuleLoader__.load 注册，工厂只 require 平台模块表里的说明符', () => {
  assert.equal(capturedDefinition.id, 'dsh-session-enhance');
  const module = loadModule();
  assert.deepEqual([...new Set(requiredSpecifiers)].sort(), [
    '@deepseek-ai/dsh-client-ui-primitives',
    'react/jsx-runtime'
  ]);
  assert.equal(typeof module.apply, 'function');
  assert.ok(Array.isArray(module.inject));
  for (const service of ['slots', 'locale', 'connection']) {
    assert.ok(module.inject.includes(service), `inject 必须声明 ${service}`);
  }
});

test('导出面：apply / inject / OffpeakButton 与三个纯函数', () => {
  const module = loadModule();
  assert.equal(typeof module.OffpeakButton, 'function');
  assert.equal(typeof module.offpeakViewState, 'function');
  assert.equal(typeof module.formatOffpeakCountdown, 'function');
  assert.equal(typeof module.formatOffpeakClock, 'function');
  // 原有组件不能被这次改动弄丢（回归保护）。
  assert.equal(typeof module.InterruptedRetryButton, 'function');
  assert.equal(typeof module.ContextSessionTracker, 'function');
  assert.equal(typeof module.AutoCompactCard, 'function');
});
// #endregion

// #region 槽位注册与词典
test('apply 在标题栏 utils 槽位注册 session-offpeak（order -12、locale=NS）', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const contribution = offpeakContributionOf(env.state);
  assert.equal(contribution.entry.name, HEADER_SLOT);
  assert.equal(contribution.entry.id, 'session-offpeak');
  assert.equal(contribution.entry.order, -12);
  assert.equal(contribution.entry.locale, NS);
  assert.equal(contribution.component, env.module.OffpeakButton);

  // 原有三个控件必须还在同一个槽位（这次改动只新增，不动别人）。
  const ids = env.state.registrations.map((item) => item.entry.id);
  for (const id of ['session-id-copy', 'session-share', 'session-interrupted-retry', 'session-context']) {
    assert.ok(ids.includes(id), `原有贡献 ${id} 不能丢`);
  }
  // 顺序：谷峰 -12 < 分享 -11 < 复制 -10。
  const orderOf = (id) => env.state.registrations.find((item) => item.entry.id === id).entry.order;
  assert.ok(orderOf('session-offpeak') < orderOf('session-share'));
  assert.ok(orderOf('session-share') < orderOf('session-id-copy'));
  assert.ok(env.state.injections.includes(HEADER_SLOT));
});

test('能力探测：谷峰通道 200 → capability.offpeak=true；405 → false', async (t) => {
  const okEnv = await setup({ offpeakStatus: 200 });
  t.after(okEnv.restore);
  const okStore = offpeakContributionOf(okEnv.state).entry.inject('session-alpha');
  assert.deepEqual(okStore.hooks.capability.getSnapshot(), { share: true, retry: true, offpeak: true });
  assert.ok(
    okEnv.fetchCalls.some(
      (call) => call.url === '/dsh-session-enhance-offpeak' && call.init.method === 'POST'
    ),
    '能力探测必须 POST 谷峰通道（method=status、空 payload）'
  );
  const probeBody = JSON.parse(okEnv.fetchCalls.find((call) => call.url === '/dsh-session-enhance-offpeak').init.body);
  assert.equal(probeBody.method, 'status');

  const missingEnv = await setup({ offpeakStatus: 405 });
  t.after(missingEnv.restore);
  const missingStore = offpeakContributionOf(missingEnv.state).entry.inject('session-beta');
  assert.equal(missingStore.hooks.capability.getSnapshot().offpeak, false);
  // 其它两个组件的能力不受影响。
  assert.equal(missingStore.hooks.capability.getSnapshot().share, true);
  assert.equal(missingStore.hooks.capability.getSnapshot().retry, true);
});

test('词典：offpeak.* 在 en/zh 键集一致，中文文案自然（谷峰/谷时/暂停）', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const zhKeys = Object.keys(env.zh).filter((key) => key.startsWith('offpeak.'));
  const enKeys = Object.keys(env.en).filter((key) => key.startsWith('offpeak.'));
  assert.ok(zhKeys.length >= 10, `offpeak 词条太少：${zhKeys.length}`);
  assert.deepEqual(zhKeys.slice().sort(), enKeys.slice().sort(), 'en/zh 的 offpeak 键必须一一对应');

  assert.equal(env.zh['offpeak.chip.off'], '谷峰');
  assert.ok(env.zh['offpeak.chip.paused'].includes('暂停'));
  assert.ok(env.zh['offpeak.chip.paused'].includes('{countdown}'));
  assert.ok(env.zh['offpeak.chip.active'].includes('谷时'));
  assert.equal(env.zh['offpeak.chip.busy'], '…');
  assert.ok(env.zh['offpeak.title.paused'].includes('不会发起任何 AI 调用'));
  assert.ok(env.zh['offpeak.resumeAt'].includes('自动恢复'));
  assert.ok(env.zh['offpeak.pauseAt'].includes('自动暂停'));
  assert.ok(env.zh['offpeak.queued'].includes('{n}'));
  for (const key of zhKeys) {
    assert.ok(env.en[key].length > 0, `en 词条 ${key} 不能为空`);
  }
});
// #endregion

// #region 纯函数
test('formatOffpeakCountdown：3h05m / 12m34s / 42s，负数与非法值按 0', () => {
  const { formatOffpeakCountdown } = loadModule();
  assert.equal(formatOffpeakCountdown(COUNTDOWN_MS), '3h05m');
  assert.equal(formatOffpeakCountdown(12 * 60 * 1000 + 34 * 1000), '12m34s');
  assert.equal(formatOffpeakCountdown(59 * 1000), '59s');
  assert.equal(formatOffpeakCountdown(60 * 1000), '1m00s');
  assert.equal(formatOffpeakCountdown(3600 * 1000), '1h00m');
  assert.equal(formatOffpeakCountdown(0), '0s');
  assert.equal(formatOffpeakCountdown(-5000), '0s');
  assert.equal(formatOffpeakCountdown(Number.NaN), '0s');
  assert.equal(formatOffpeakCountdown('not-a-number'), '0s');
  assert.equal(formatOffpeakCountdown(undefined), '0s');
});

test('offpeakViewState：off / paused / active / busy 四个状态', () => {
  const { offpeakViewState } = loadModule();
  assert.equal(offpeakViewState(null), 'off');
  assert.equal(offpeakViewState({}), 'off');
  assert.equal(offpeakViewState(snapshotOf()), 'off');
  assert.equal(offpeakViewState(snapshotOf({ status: statusOf({ enabled: false }) })), 'off');
  assert.equal(offpeakViewState(snapshotOf({ status: statusOf({ enabled: true, paused: false }) })), 'active');
  assert.equal(offpeakViewState(snapshotOf({ status: statusOf({ enabled: true, paused: true }) })), 'paused');
  // busy 优先于 enabled/paused：切换中先显示「…」。
  assert.equal(offpeakViewState(snapshotOf({ busy: true, status: statusOf({ paused: true }) })), 'busy');
});

test('formatOffpeakClock：按配置时区（含午夜 h23 口径）换算，非法输入返回空串', () => {
  const { formatOffpeakClock } = loadModule();
  // 2026-01-02T00:30Z = 上海 08:30。
  assert.equal(formatOffpeakClock(NEXT_CHANGE_AT, 'Asia/Shanghai'), '08:30');
  // 2025-01-01T16:00Z = 上海次日 00:00 —— 必须是 00:00，不能是 24:00。
  assert.equal(formatOffpeakClock(Date.UTC(2025, 0, 1, 16, 0), 'Asia/Shanghai'), '00:00');
  assert.equal(formatOffpeakClock(undefined, 'Asia/Shanghai'), '');
  assert.equal(formatOffpeakClock(Number.NaN, 'Asia/Shanghai'), '');
  // 时区非法时退回本机时区，但仍给出 HH:MM，而不是空串或异常。
  assert.match(formatOffpeakClock(NEXT_CHANGE_AT, 'Not/AZone'), /^\d{2}:\d{2}$/);
});
// #endregion

// #region 组件渲染
test('渲染：关闭态是 muted「谷峰」，title 写明窗口与点击开启', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const off = renderChip(env.module, env.t, snapshotOf({ status: statusOf({ enabled: false, paused: false, offPeak: false }) }));
  assert.notEqual(off.button, undefined);
  assert.equal(off.button.props['data-dsh-offpeak-button'], '');
  assert.equal(off.button.props['data-offpeak-state'], 'off');
  assert.equal(off.button.props['data-offpeak-enabled'], 'false');
  assert.equal(off.button.props.disabled, false);
  assert.equal(chipTextOf(off.button), '谷峰');
  assert.ok(off.button.props.title.includes('谷峰会话：关闭'));
  assert.ok(off.button.props.title.includes('00:30–08:30（Asia/Shanghai）'));
  assert.ok(off.button.props.title.includes('点击开启'));
  // 还没读到状态时也要能渲染（title 用不带窗口的那条）。
  const unknown = renderChip(env.module, env.t, snapshotOf());
  assert.equal(unknown.button.props['data-offpeak-state'], 'off');
  assert.ok(unknown.button.props.title.includes('谷峰会话：关闭'));
});

test('渲染：暂停态是 amber「谷峰 暂停 3h05m」，title 写明自动恢复与排队条数', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const pausedStatus = statusOf({
    paused: true,
    offPeak: false,
    nextChangeKind: 'resume',
    cover: { agent: true, running: false, held: true, interrupted: false, queued: 2 }
  });
  const paused = renderChip(env.module, env.t, snapshotOf({ status: pausedStatus, countdownMs: COUNTDOWN_MS }));
  assert.equal(paused.button.props['data-offpeak-state'], 'paused');
  assert.equal(paused.button.props['data-offpeak-enabled'], 'true');
  assert.equal(chipTextOf(paused.button), '谷峰 暂停 3h05m');
  const title = paused.button.props.title;
  assert.ok(title.includes('谷峰会话：已暂停'));
  assert.ok(title.includes('谷时窗口 00:30–08:30（Asia/Shanghai）'));
  assert.ok(title.includes('将在 08:30 自动恢复'));
  assert.ok(title.includes('队列中 2 条消息'));
  // 颜色走主题 token（暂停 = warn），并带 fallback。
  assert.ok(String(paused.button.props.style.color).includes('--dsw-alias-state-warn'));
});

test('渲染：谷时是 green「谷峰 谷时」，title 写明自动暂停；busy 是「…」且禁用', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const active = renderChip(env.module, env.t, snapshotOf({ status: statusOf({ paused: false }), countdownMs: COUNTDOWN_MS }));
  assert.equal(active.button.props['data-offpeak-state'], 'active');
  assert.equal(chipTextOf(active.button), '谷峰 谷时');
  assert.ok(active.button.props.title.includes('谷时运行中'));
  assert.ok(active.button.props.title.includes('将在 08:30 自动暂停'));
  assert.ok(String(active.button.props.style.color).includes('--dsw-alias-state-success'));

  const busy = renderChip(
    env.module,
    env.t,
    snapshotOf({ status: statusOf({ paused: true }), busy: true, countdownMs: COUNTDOWN_MS })
  );
  assert.equal(busy.button.props['data-offpeak-state'], 'busy');
  assert.equal(busy.button.props.disabled, true);
  assert.equal(chipTextOf(busy.button), '…');
  // 点一下会调控制器的 toggle（busy 时按钮被禁用，但 onClick 语义仍要连对）。
  busy.button.props.onClick();
  assert.deepEqual(busy.toggles, [true]);
});

test('渲染：失败 Toast 用 sequence 当 key，onDone 只清对应那条', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const notice = { text: '切换谷峰会话失败（BAD_REQUEST）', sequence: 7 };
  const rendered = renderChip(env.module, env.t, snapshotOf({ status: statusOf({ enabled: false }), notice }));
  const toasts = collectNodes(rendered.tree, (node) => node.type === primitives.Toast);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].props.text, notice.text);
  assert.equal(toasts[0].key, 7, 'Toast 必须以 sequence 当 React key，连续点击才会重播动画');
  toasts[0].props.onDone();
  assert.deepEqual(rendered.dismissed, [7]);
  // 没有 notice 时不渲染 Toast。
  const quiet = renderChip(env.module, env.t, snapshotOf({ status: statusOf({ enabled: false }) }));
  assert.equal(collectNodes(quiet.tree, (node) => node.type === primitives.Toast).length, 0);
});

test('渲染：能力探测 false / 无 sessionId 都返回隐藏占位（保持订阅，不返回 null）', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const disabled = renderChip(env.module, env.t, snapshotOf({ status: statusOf({ paused: true }) }), {
    capability: false
  });
  assert.equal(disabled.buttons.length, 0);
  const disabledPlaceholders = collectNodes(disabled.tree, (node) => node.props['data-offpeak-hidden'] === 'disabled');
  assert.equal(disabledPlaceholders.length, 1);
  assert.equal(disabledPlaceholders[0].props.style.display, 'none');

  const noSession = renderChip(env.module, env.t, snapshotOf(), { sessionId: '' });
  assert.equal(noSession.buttons.length, 0);
  assert.equal(collectNodes(noSession.tree, (node) => node.props['data-offpeak-hidden'] === 'no-session').length, 1);
});
// #endregion

// #region 控制器：RPC 与 busy 语义
/**
 * 造一个可控的 RPC 连接。
 * @param {{ status?: (payload: any) => any, setEnabled?: (payload: any) => any }} [handlers] - 方法处理函数。
 * @returns {{ connection: any, calls: any[] }} 连接与调用记录。
 */
function createConnection(handlers = {}) {
  const calls = [];
  const connection = {
    rpc: {
      call: async (channel, method, payload) => {
        calls.push({ channel, method, payload });
        if (method === 'status') {
          return handlers.status === undefined ? { ok: true, value: statusOf({ enabled: false }) } : handlers.status(payload);
        }
        if (method === 'setEnabled') {
          return handlers.setEnabled === undefined
            ? { ok: true, value: statusOf({ enabled: payload.enabled }) }
            : handlers.setEnabled(payload);
        }
        throw new Error(`unexpected method ${method}`);
      }
    }
  };
  return { connection, calls };
}

test('toggle：先 busy，再按服务端返回更新（通道/方法/payload 都要对）', async (t) => {
  const { connection, calls } = createConnection();
  const env = await setup({ connection });
  t.after(env.restore);

  const store = createStoreOf(env.state, 'session-rpc');
  await store.refresh();
  assert.equal(store.getSnapshot().status.enabled, false);
  assert.equal(store.getSnapshot().busy, false);

  const pending = store.toggle();
  // busy 必须是**同步**置上的：否则连点会发两次请求、请求期间 chip 也没有「…」。
  assert.equal(store.getSnapshot().busy, true);
  await pending;

  assert.equal(store.getSnapshot().busy, false);
  assert.equal(store.getSnapshot().status.enabled, true);
  const setEnabledCalls = calls.filter((call) => call.method === 'setEnabled');
  assert.deepEqual(setEnabledCalls.map((call) => call.payload), [{ sessionId: 'session-rpc', enabled: true }]);
  assert.ok(calls.every((call) => call.channel === '/dsh-session-enhance-offpeak'));
  // 再点一次 → 关掉（目标值取服务端上次说的 enabled 取反）。
  await store.toggle();
  assert.equal(store.getSnapshot().status.enabled, false);
  assert.deepEqual(
    calls.filter((call) => call.method === 'setEnabled').map((call) => call.payload.enabled),
    [true, false]
  );
});

test('toggle 失败：保留旧状态并弹 Toast（业务错误码进文案）', async (t) => {
  const { connection } = createConnection({
    setEnabled: () => ({ ok: false, error: { code: 'BAD_REQUEST', message: 'bad input' } })
  });
  const env = await setup({ connection });
  t.after(env.restore);

  const store = createStoreOf(env.state, 'session-rpc');
  await store.refresh();
  assert.equal(store.getSnapshot().status.enabled, false);

  await store.toggle();
  // 状态回到点击前（失败不改状态）。
  assert.equal(store.getSnapshot().status.enabled, false);
  assert.equal(store.getSnapshot().busy, false);
  const notice = store.getSnapshot().notice;
  assert.notEqual(notice, null);
  assert.ok(notice.text.includes('BAD_REQUEST'), `Toast 文案应带错误码：${notice.text}`);
  assert.equal(typeof notice.sequence, 'number');

  // dismissNotice 只清序号匹配的那条。
  store.dismissNotice(notice.sequence - 1);
  assert.notEqual(store.getSnapshot().notice, null);
  store.dismissNotice(notice.sequence);
  assert.equal(store.getSnapshot().notice, null);
});

test('toggle 成功但未落盘（persisted:false）：状态照常更新，Toast 提示重启后可能回落', async (t) => {
  const { connection } = createConnection({
    status: () => ({ ok: true, value: statusOf({ enabled: false }) }),
    setEnabled: (payload) => ({ ok: true, value: statusOf({ enabled: payload.enabled, persisted: false }) })
  });
  const env = await setup({ connection });
  t.after(env.restore);

  const store = createStoreOf(env.state, 'session-persist');
  await store.refresh();
  await store.toggle();
  // 开关必须生效（Host 的设计是「写盘失败不影响开关」）。
  assert.equal(store.getSnapshot().status.enabled, true);
  assert.equal(store.getSnapshot().status.persisted, false);
  const notice = store.getSnapshot().notice;
  assert.notEqual(notice, null);
  assert.ok(notice.text.includes('写入磁盘'), `Toast 应说明没落盘：${notice.text}`);
});

test('toggle 失败：传输层异常与「没有连接」都收口成一句「未连接到 Host」', async (t) => {
  const throwing = createConnection({
    setEnabled: () => {
      throw new Error('socket died');
    }
  });
  const env = await setup({ connection: throwing.connection });
  t.after(env.restore);
  const store = createStoreOf(env.state, 'session-retry');
  await store.refresh();
  await store.toggle();
  assert.equal(store.getSnapshot().status.enabled, false);
  assert.ok(store.getSnapshot().notice.text.includes('未连接到 Host'));

  // 完全没有 connection（旧 Host / 设置页场景）也不能炸。
  const bareEnv = await setup();
  t.after(bareEnv.restore);
  const bareStore = createStoreOf(bareEnv.state, 'session-bare');
  await bareStore.toggle();
  assert.notEqual(bareStore.getSnapshot().notice, null);
  assert.ok(bareStore.getSnapshot().notice.text.includes('未连接'));
});
// #endregion

// #region 控制器：tick / 轮询 / 定时器清理
/**
 * 把 `setInterval` 换成「只记录不调度」的替身。
 * @param {any} t - node:test 上下文（用于自动还原）。
 * @returns {{ created: any[], cleared: any[] }} 记录。
 */
function interceptIntervals(t) {
  const created = [];
  const cleared = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (callback, ms) => {
    const handle = { callback, ms };
    created.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    cleared.push(handle);
  };
  t.after(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });
  return { created, cleared };
}

test('订阅者归零时清理 1s tick 与 15s 轮询，再次订阅会重新拉状态', async (t) => {
  const { connection, calls } = createConnection();
  const env = await setup({ connection });
  t.after(env.restore);
  const intervals = interceptIntervals(t);
  const store = createStoreOf(env.state, 'session-timer');

  const unsubscribe = store.subscribe(() => {});
  await flushAsync();
  assert.deepEqual(
    intervals.created.map((handle) => handle.ms).sort((left, right) => left - right),
    [1000, 15000]
  );
  const statusCallsAfterStart = calls.filter((call) => call.method === 'status').length;
  assert.ok(statusCallsAfterStart >= 1, '首个订阅者出现时应立即拉一次状态');

  unsubscribe();
  assert.equal(intervals.cleared.length, 2, '订阅者归零必须清掉两个定时器（组件卸载不残留）');

  // 再次订阅（切回会话）：立即重新拉状态，不停在上一次快照上。
  const unsubscribeAgain = store.subscribe(() => {});
  await flushAsync();
  assert.ok(calls.filter((call) => call.method === 'status').length > statusCallsAfterStart);
  unsubscribeAgain();
});

test('1s tick：暂停中刷新倒计时，到点立刻向 Host 对齐（不等 15 秒轮询）', async (t) => {
  // 服务端时钟与 nextChangeAt 都由 Date.now() 生成，避免测试依赖真实时钟。
  let offsetMs = 10000;
  const { connection, calls } = createConnection({
    status: () => {
      const serverNow = Date.now();
      return {
        ok: true,
        value: statusOf({
          paused: true,
          offPeak: false,
          serverNow,
          nextChangeAt: serverNow + offsetMs,
          nextChangeKind: 'resume'
        })
      };
    }
  });
  const env = await setup({ connection });
  t.after(env.restore);
  const intervals = interceptIntervals(t);
  const store = createStoreOf(env.state, 'session-tick');

  const unsubscribe = store.subscribe(() => {});
  try {
    await flushAsync();
    const first = store.getSnapshot().countdownMs;
    assert.ok(typeof first === 'number' && first > 5000 && first <= 10000, `初始倒计时应约 10s，实际 ${first}`);

    const tick = intervals.created.find((handle) => handle.ms === 1000).callback;
    tick();
    const second = store.getSnapshot().countdownMs;
    assert.ok(second <= first, 'tick 应该让倒计时单调变小');

    // 模拟「已过点但服务端还没翻状态」：tick 必须主动对齐一次。
    offsetMs = -1000;
    await store.refresh();
    assert.equal(store.getSnapshot().countdownMs, 0, '过点后倒计时截到 0，不显示负数');
    const beforeTick = calls.filter((call) => call.method === 'status').length;
    tick();
    await flushAsync();
    assert.ok(
      calls.filter((call) => call.method === 'status').length > beforeTick,
      '到点后 tick 应触发一次 status 对齐'
    );
    // 已经对齐过就别每秒重拉：同一个过期 deadline 下再 tick 不应再发请求。
    const afterAlign = calls.filter((call) => call.method === 'status').length;
    tick();
    await flushAsync();
    assert.equal(calls.filter((call) => call.method === 'status').length, afterAlign);
  } finally {
    unsubscribe();
  }
});
// #endregion
