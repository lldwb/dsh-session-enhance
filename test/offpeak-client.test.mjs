/**
 * `dsh-session-enhance` 浏览器半里「梁谷」chip 的离线冒烟测试。
 *
 * 覆盖四件事（都不需要浏览器、不联网、不调模型）：
 *
 * 1. **bundle 形状**：`client.js` 通过 `window.__ModuleLoader__.load({ id, factory })`
 *    注册，工厂只 require 平台模块表里的两个说明符，并导出 `apply` / `inject` /
 *    `OffpeakButton` 与四个纯函数；
 * 2. **槽位注册**：`apply(mockCtx)` 在 `conversation.session.header.utilities` 上注册
 *    `session-offpeak` 贡献（order -12），且原有三个组件仍在（防回归）；
 * 3. **词典**：`offpeak.*` 词条在 en / zh 两份词典里键集一致，中文是「梁谷 / 空闲时段 /
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
  if (specifier === 'react') {
    return {
      createElement: jsx,
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      useMemo: (factory) => factory(),
      useRef: (value) => ({ current: value })
    };
  }
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
 * @param {{ connection?: any, offpeakStatus?: number }} [options] - RPC 连接与梁谷通道的探测状态码。
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
 * 取梁谷贡献项。
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
  // Tooltip（占位组件）的 children 是原生 span 锚点，里面才是官方 Pill。
  const tooltip = collectNodes(tree, (node) => node.props !== undefined && typeof node.props.label === 'string')[0];
  const pills = collectNodes(
    tooltip === undefined ? null : tooltip.props.children,
    (node) => node.props !== undefined && node.props['data-dsh-offpeak-button'] !== undefined
  );
  const button = pills.length === 1 ? pills[0] : undefined;
  return {
    tree,
    button,
    buttons: pills,
    tooltip,
    label: tooltip === undefined ? undefined : tooltip.props.label,
    toggles,
    dismissed
  };
}

/**
 * 取 chip 的文字（按钮里那个承载文案的 span）。
 * @param {any} button - 按钮元素。
 * @returns {string} 文案。
 */
function chipTextOf(button) {
  const texts = collectNodes(button, (node) => node.type === 'span' && typeof node.props.children === 'string');
  // 三段布局：图标 + 名称 + 状态，这里按「名称 状态」拼接（关态状态为空）。
  return texts.map((node) => node.props.children).join(' ').trim();
}

/**
 * 取 hero 开关的文字（按钮里承载倒计时/空闲的那个 span；关态为空串）。
 * @param {any} button - 按钮元素。
 * @returns {string} 文案。
 */
function heroTextOf(button) {
  const texts = collectNodes(button, (node) => node.type === 'span' && typeof node.props.children === 'string');
  return texts.map((node) => node.props.children).join(' ').trim();
}

/**
 * 渲染新建会话页的「梁谷」开关。
 *
 * 组件用 primitives 的 `Tooltip` 包裹按钮，所以测试要从 Tooltip 的 props 里取按钮与 label
 * （占位组件不会渲染 children）。
 *
 * @param {any} module - 已加载的浏览器半模块。
 * @param {(key: string, params?: any) => string} t - 词典。
 * @param {{ view?: 'off'|'paused'|'idle'|'busy', capability?: boolean, sessionId?: string }} [options] - 夹具。
 * @returns {any} `{ tree, tooltip, button, buttons, toggles, label }`。
 */
function renderHeroToggle(module, t, options = {}) {
  const toggles = [];
  const dismissed = [];
  const capability = options.capability === undefined ? true : options.capability;
  const view = options.view === undefined ? 'off' : options.view;
  const snapshot = snapshotOf({
    status: statusOf({
      enabled: view !== 'off',
      paused: view === 'paused',
      ...(options.readOnly === true ? { readOnly: true, enabledSource: 'parent', inheritedFrom: 'parent' } : {})
    }),
    busy: view === 'busy',
    countdownMs: options.countdownMs === undefined ? COUNTDOWN_MS : options.countdownMs,
    notice: options.notice === undefined ? null : options.notice
  });
  const props = {
    sessionId: options.sessionId === undefined ? 'session-src' : options.sessionId,
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
  const tree = module.LiangguHeroToggle(props);
  // Tooltip 的 children 是原生 span 锚点，Pill 在它的子树里。
  const tooltip = collectNodes(tree, (node) => node.props !== undefined && typeof node.props.label === 'string')[0];
  const button = collectNodes(
    tooltip === undefined ? null : tooltip.props.children,
    (node) => node.props !== undefined && node.props['data-dsh-lianggu-hero'] !== undefined
  )[0];
  const buttons = button === undefined ? [] : [button];
  return {
    tree,
    tooltip,
    button,
    buttons,
    toggles,
    dismissed,
    label: tooltip === undefined ? undefined : tooltip.props.label
  };
}
// #endregion

// #region 状态夹具
/** `nextChangeAt`：2026-01-02 00:30Z = Asia/Shanghai 08:30（用于断言 title 里的钟点）。 */
const NEXT_CHANGE_AT = Date.UTC(2026, 0, 2, 0, 30);

/** 3h05m 的毫秒数（chip 倒计时的展示样本）。 */
const COUNTDOWN_MS = (3 * 60 * 60 + 5 * 60) * 1000;

/** 官方高峰时段（Host 默认配置，也是 title 里的展示样本）。 */
const SCHEDULE = Object.freeze({
  peakWindows: ['09:00-12:00', '14:00-18:00'],
  timeZone: 'Asia/Shanghai',
  holidaysCount: 0
});

/**
 * 造一个 Host 状态（新契约：只有 `schedule`，不再有 `window` / `offPeak`）。
 * @param {Record<string, any>} overrides - 覆盖字段。
 * @returns {any} 状态对象。
 */
function statusOf(overrides = {}) {
  return {
    enabled: true,
    enabledSource: 'session',
    paused: false,
    idle: true,
    schedule: { ...SCHEDULE, peakWindows: [...SCHEDULE.peakWindows] },
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
    'react',
    'react/jsx-runtime'
  ]);
  assert.equal(typeof module.apply, 'function');
  assert.ok(Array.isArray(module.inject));
  for (const service of ['slots', 'locale', 'connection']) {
    assert.ok(module.inject.includes(service), `inject 必须声明 ${service}`);
  }
});

test('导出面：apply / inject / OffpeakButton / 梁谷开关 与五个纯函数', () => {
  const module = loadModule();
  assert.equal(typeof module.OffpeakButton, 'function');
  assert.equal(typeof module.LiangguHeroToggle, 'function');
  assert.equal(typeof module.offpeakViewState, 'function');
  assert.equal(typeof module.formatOffpeakCountdown, 'function');
  assert.equal(typeof module.formatOffpeakClock, 'function');
  assert.equal(typeof module.formatPeakWindowList, 'function');
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
  // 顺序：梁谷 -12 < 分享 -11 < 复制 -10。
  const orderOf = (id) => env.state.registrations.find((item) => item.entry.id === id).entry.order;
  assert.ok(orderOf('session-offpeak') < orderOf('session-share'));
  assert.ok(orderOf('session-share') < orderOf('session-id-copy'));
  assert.ok(env.state.injections.includes(HEADER_SLOT));

  // 6.3.0：新建会话页（hero 行）的「梁谷」开关。
  const heroContribution = env.state.registrations.find((item) => item.entry.id === 'lianggu-hero-toggle');
  assert.notEqual(heroContribution, undefined, 'apply 必须在 hero options 槽位注册 lianggu-hero-toggle');
  assert.equal(heroContribution.entry.name, 'conversation.hero.options');
  assert.equal(heroContribution.entry.order, 0);
  assert.equal(heroContribution.entry.locale, NS);
  assert.equal(heroContribution.component, env.module.LiangguHeroToggle);
  assert.ok(env.state.injections.includes('conversation.hero.options'));
  // 与标题栏 chip 同一个控制器：inject 出来的是 offpeak store（带 toggle）。
  const injected = heroContribution.entry.inject('session-src');
  assert.equal(typeof injected.offpeak.toggle, 'function');
});

test('能力探测：梁谷通道 200 → capability.offpeak=true；405 → false', async (t) => {
  const okEnv = await setup({ offpeakStatus: 200 });
  t.after(okEnv.restore);
  const okStore = offpeakContributionOf(okEnv.state).entry.inject('session-alpha');
  assert.deepEqual(okStore.hooks.capability.getSnapshot(), { share: true, retry: true, offpeak: true });
  assert.ok(
    okEnv.fetchCalls.some(
      (call) => call.url === '/dsh-session-enhance-offpeak' && call.init.method === 'POST'
    ),
    '能力探测必须 POST 梁谷通道（method=status、空 payload）'
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

test('词典：offpeak.* 在 en/zh 键集一致，文案为「谷峰插件/高峰/空闲」且无旧名', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const zhKeys = Object.keys(env.zh).filter((key) => key.startsWith('offpeak.'));
  const enKeys = Object.keys(env.en).filter((key) => key.startsWith('offpeak.'));
  assert.deepEqual(zhKeys.slice().sort(), enKeys.slice().sort(), 'en/zh 的 offpeak 键必须一一对应');
  for (const key of zhKeys) {
    assert.ok(!env.zh[key].includes('梁谷'), `词条 ${key} 仍含旧名「梁谷」：${env.zh[key]}`);
    assert.ok(!/Lianggu/i.test(env.en[key]), `词条 ${key} 仍含旧名 Lianggu`);
    assert.ok(env.zh[key].length > 0 && env.en[key].length > 0, `词条 ${key} 不能为空`);
  }

  assert.equal(env.zh['offpeak.phase.peak'], '高峰');
  assert.equal(env.zh['offpeak.phase.idle'], '空闲');
  assert.equal(env.zh['offpeak.chip.busy'], '…');
  assert.ok(env.zh['offpeak.tipNormal'].includes('普通会话'));
  assert.ok(env.zh['offpeak.tipSetIdle'].includes('空闲会话'));
  assert.ok(env.zh['offpeak.tipPeak'].includes('暂停'));
  assert.ok(env.zh['offpeak.tipResumeAt'].includes('{time}'));
  assert.ok(env.zh['offpeak.tipPauseAt'].includes('{time}'));
  assert.ok(env.zh['offpeak.readOnlyHint'].includes('继承自主会话'));
});

// #region 纯函数
test('formatOffpeakCountdown：>1h 小时分钟；1min~1h 分钟秒；<1min 只显示秒', () => {
  const { formatOffpeakCountdown } = loadModule();
  assert.equal(formatOffpeakCountdown(COUNTDOWN_MS), '3h05m');
  assert.equal(formatOffpeakCountdown(12 * 60 * 1000 + 34 * 1000), '12m34s');
  assert.equal(formatOffpeakCountdown(59 * 60 * 1000 + 59 * 1000), '59m59s');
  assert.equal(formatOffpeakCountdown(60 * 1000), '1m00s');
  // 不足 1 分钟：省略「0m」，直接 `59s` / `42s`（用户 2026-11-26 要求）。
  assert.equal(formatOffpeakCountdown(59 * 1000), '59s');
  assert.equal(formatOffpeakCountdown(42 * 1000), '42s');
  assert.equal(formatOffpeakCountdown(5 * 1000), '5s');
  // 1 小时整点仍按「分钟秒」= 60m00s；超过 1 小时转小时。
  assert.equal(formatOffpeakCountdown(3600 * 1000), '60m00s');
  assert.equal(formatOffpeakCountdown(3601 * 1000), '1h00m');
  assert.equal(formatOffpeakCountdown(0), '0s');
  assert.equal(formatOffpeakCountdown(999), '0s');
  assert.equal(formatOffpeakCountdown(-5000), '0s');
  assert.equal(formatOffpeakCountdown(Number.NaN), '0s');
  assert.equal(formatOffpeakCountdown('not-a-number'), '0s');
  assert.equal(formatOffpeakCountdown(undefined), '0s');
});

test('offpeakViewState：off / paused / idle / busy 四个状态', () => {
  const { offpeakViewState } = loadModule();
  assert.equal(offpeakViewState(null), 'off');
  assert.equal(offpeakViewState({}), 'off');
  assert.equal(offpeakViewState(snapshotOf()), 'off');
  assert.equal(offpeakViewState(snapshotOf({ status: statusOf({ enabled: false }) })), 'off');
  assert.equal(offpeakViewState(snapshotOf({ status: statusOf({ enabled: true, paused: false }) })), 'idle');
  assert.equal(offpeakViewState(snapshotOf({ status: statusOf({ enabled: true, paused: true }) })), 'paused');
  // busy 优先于 enabled/paused：切换中先显示「…」。
  assert.equal(offpeakViewState(snapshotOf({ busy: true, status: statusOf({ paused: true }) })), 'busy');
});

test('formatPeakWindowList：schedule.peakWindows → 「09:00–12:00、14:00–18:00」，空值退回官方默认', () => {
  const { formatPeakWindowList } = loadModule();
  assert.equal(formatPeakWindowList(['09:00-12:00', '14:00-18:00'], '、'), '09:00–12:00、14:00–18:00');
  // 英文连接符与不补零的写法都要处理。
  assert.equal(formatPeakWindowList(['9:00-12:00', '14:00~18:00'], ', '), '09:00–12:00, 14:00–18:00');
  // 空数组 / 非数组 / 全是空串 → 官方默认时段。
  assert.equal(formatPeakWindowList([], '、'), '09:00–12:00、14:00–18:00');
  assert.equal(formatPeakWindowList(undefined, '、'), '09:00–12:00、14:00–18:00');
  assert.equal(formatPeakWindowList(['', '  '], '、'), '09:00–12:00、14:00–18:00');
  // 认不出的条目原样保留（Host 配置里出现别的写法时不要吞掉它）。
  assert.equal(formatPeakWindowList(['09:00-12:00', '整日'], '、'), '09:00–12:00、整日');
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

// #region 组件渲染（谷峰插件：峰/谷 + 倒计时 + 黑白款）
test('渲染：高峰 = 图标+「高峰」+倒计时，选中为浅灰款', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const pausedStatus = statusOf({
    enabled: true,
    paused: true,
    idle: false,
    nextChangeKind: 'resume',
    cover: { agent: true, running: false, held: true, interrupted: false, queued: 2 }
  });
  const peak = renderChip(env.module, env.t, snapshotOf({ status: pausedStatus, countdownMs: COUNTDOWN_MS }));
  assert.equal(peak.button.props['data-offpeak-state'], 'paused');
  assert.equal(peak.button.props['data-offpeak-enabled'], 'true');
  assert.equal(chipTextOf(peak.button), '高峰 3h05m');
  // 内部高峰橙、框为选中黑款。
  assert.ok(String(peak.button.props.style.color).includes('--dsw-alias-state-warn'), '高峰内部橙色');
  assert.equal(peak.button.props.style.border, '1px solid #d0d3d8', '选中为浅灰边框');
  assert.ok(String(peak.button.props.style.background).includes('--dsw-alias-state-warn-tertiary'), '高峰背景为橙');
  assert.ok(peak.label.includes('已暂停 AI 调用'), `高峰提示：${peak.label}`);
  assert.ok(/进入空闲/u.test(peak.label), `高峰提示应给切换时刻：${peak.label}`);
  assert.ok(peak.label.includes('点击可取消'), `高峰提示应说明点击行为：${peak.label}`);
  // 峰用太阳图标。
  assert.ok(collectNodes(peak.tree, (node) => node.type === 'circle').length >= 1, '高峰应是太阳');
});

test('渲染：空闲 = 图标+「空闲」+倒计时，未选中为深色款', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const idleStatus = statusOf({ enabled: true, paused: false, idle: true, nextChangeKind: 'pause' });
  const idle = renderChip(env.module, env.t, snapshotOf({ status: idleStatus, countdownMs: COUNTDOWN_MS }));
  assert.equal(idle.button.props['data-offpeak-state'], 'idle');
  assert.equal(chipTextOf(idle.button), '空闲 3h05m');
  assert.ok(String(idle.button.props.style.color).includes('--dsw-alias-state-success'), '空闲内部绿色');
  assert.equal(idle.button.props.style.border, '1px solid #d0d3d8', '选中为浅灰边框');
  assert.ok(String(idle.button.props.style.background).includes('--dsw-alias-state-success-tertiary'), '空闲背景为绿');
  assert.ok(idle.label.includes('AI 调用正常运行'), `空闲提示：${idle.label}`);
  assert.ok(/进入高峰/u.test(idle.label), `空闲提示应给切换时刻：${idle.label}`);
  // 谷用弯月+星（path）。
  assert.ok(collectNodes(idle.tree, (node) => node.type === 'path').length >= 2, '空闲应是月亮+星');

  // 未选中（普通会话）= 白款，但内部同样显示「空闲 + 倒计时」。
  const plainStatus = statusOf({ enabled: false, paused: false, idle: true });
  const plain = renderChip(env.module, env.t, snapshotOf({ status: plainStatus, countdownMs: COUNTDOWN_MS }));
  assert.equal(plain.button.props['data-offpeak-enabled'], 'false');
  assert.equal(chipTextOf(plain.button), '空闲 3h05m', '未选中也显示相位+倒计时');
  assert.equal(plain.button.props.style.border, '1px solid #ffffff', '未选中为白色边框');
  assert.ok(String(plain.button.props.style.background).includes('--dsw-alias-state-success-tertiary'), '未选中背景仍按相位（空闲绿）');
  assert.ok(String(plain.button.props.style.color).includes('--dsw-alias-state-success'), '内部仍是空闲绿（不随选中变）');
  assert.ok(plain.label.includes('普通会话'), `未选中提示：${plain.label}`);
  assert.ok(plain.label.includes('点击设为「空闲会话」'), `未选中提示应说明点击行为：${plain.label}`);
});

test('渲染：busy 显示「…」且禁用；失败 Toast 用 sequence 当 key', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const busy = renderChip(
    env.module,
    env.t,
    snapshotOf({ status: statusOf({ enabled: true, paused: true }), busy: true, countdownMs: COUNTDOWN_MS })
  );
  assert.equal(busy.button.props['data-offpeak-state'], 'busy');
  assert.equal(busy.button.props.disabled, true);
  assert.equal(chipTextOf(busy.button), '高峰 …');

  const notice = { text: '切换谷峰插件失败（BAD_REQUEST）', sequence: 7 };
  const rendered = renderChip(env.module, env.t, snapshotOf({ status: statusOf({ enabled: false }), notice }));
  const toasts = collectNodes(rendered.tree, (node) => node.type === primitives.Toast);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].props.text, notice.text);
  assert.equal(toasts[0].key, 7);
  toasts[0].props.onDone();
  assert.deepEqual(rendered.dismissed, [7]);
});

test('尺寸：chip 与 hero 高度固定 24px，宽度随内容自适应（不再有固定宽度槽位）', async (t) => {
  const env = await setup();
  t.after(env.restore);
  const states = [
    ['peak', snapshotOf({ status: statusOf({ enabled: true, paused: true }), countdownMs: COUNTDOWN_MS }), 'paused'],
    ['idle', snapshotOf({ status: statusOf({ enabled: true, paused: false }), countdownMs: COUNTDOWN_MS }), 'idle'],
    ['off', snapshotOf({ status: statusOf({ enabled: false, paused: false }), countdownMs: COUNTDOWN_MS }), 'off'],
    ['busy', snapshotOf({ status: statusOf({ enabled: true, paused: true }), busy: true }), 'busy']
  ];
  for (const [name, snapshot, view] of states) {
    const chip = renderChip(env.module, env.t, snapshot);
    assert.equal(chip.button.props.style.width, undefined, `chip ${name} 不设固定宽度（随内容收缩）`);
    assert.equal(chip.button.props.style.height, '24px', `chip ${name} 高固定`);
    assert.equal(chip.button.props['data-offpeak-state'], view);
    const hero = renderHeroToggle(env.module, env.t, { view });
    assert.equal(hero.button.props.style.width, undefined, `hero ${name} 不设固定宽度`);
    assert.equal(hero.button.props.style.height, '24px', `hero ${name} 高固定`);
  }
});

test('三段紧凑：gap 2px + 倒计时内容宽（不占固定槽位，消灭中间/右侧空白）', async (t) => {
  const env = await setup();
  t.after(env.restore);
  const chip = renderChip(env.module, env.t, snapshotOf({ status: statusOf({ enabled: true, paused: true }), countdownMs: COUNTDOWN_MS }));
  assert.equal(chip.button.props.style.gap, '2px', '段间距收到 2px');
  const hero = renderHeroToggle(env.module, env.t, { view: 'idle' });
  assert.equal(hero.button.props.style.gap, '2px');

  const children = chip.button.props.children;
  assert.equal(children.length, 3, '图标 / 相位 / 倒计时');
  assert.equal(children[1].props.style.width, '24px', '相位固定 24px');
  assert.equal(children[2].props.style.flex, '0 0 auto', '倒计时按内容宽，不撑满');
  assert.equal(children[2].props.style.overflow, undefined, '不再需要省略号裁剪');
  // 峰值最长文案 `14h48m` 也只是一段内容宽，不会再被固定槽位的余量隔开。
  const longText = chipTextOf(chip.button);
  assert.ok(longText.includes('3h05m'));
});

test('新建页开关：失败时与 chip 一样弹 Toast（不再静默）', async (t) => {
  const env = await setup();
  t.after(env.restore);
  const notice = { text: '切换谷峰插件失败（READ_ONLY_INHERITED）', sequence: 9 };
  const rendered = renderHeroToggle(env.module, env.t, { view: 'paused', notice });
  const toasts = collectNodes(rendered.tree, (node) => node.type === primitives.Toast);
  assert.equal(toasts.length, 1, 'hero 开关失败时必须渲染 Toast');
  assert.equal(toasts[0].props.text, notice.text);
  assert.equal(toasts[0].key, 9);
  toasts[0].props.onDone();
  assert.deepEqual(rendered.dismissed, [9]);

  const quiet = renderHeroToggle(env.module, env.t, { view: 'paused' });
  assert.equal(collectNodes(quiet.tree, (node) => node.type === primitives.Toast).length, 0);
});

test('倒计时 emoji：高峰→空闲用 🎉/🎊，空闲→高峰用 ⏳/⏰（≤60s / ≤10s）', async (t) => {
  const env = await setup();
  t.after(env.restore);
  const peakAt = (countdownMs) =>
    renderChip(env.module, env.t, snapshotOf({ status: statusOf({ enabled: true, paused: true }), countdownMs }));
  const idleAt = (countdownMs) =>
    renderChip(env.module, env.t, snapshotOf({ status: statusOf({ enabled: true, paused: false }), countdownMs }));

  assert.equal(chipTextOf(peakAt(37_000).button), '高峰 🎉 37s');
  assert.equal(chipTextOf(peakAt(9_000).button), '高峰 🎊 9s');
  assert.equal(chipTextOf(peakAt(61_000).button), '高峰 1m01s');
  assert.equal(chipTextOf(idleAt(59_000).button), '空闲 ⏳ 59s');
  assert.equal(chipTextOf(idleAt(1_000).button), '空闲 ⏰ 1s');
  // hero 同款。
  assert.equal(heroTextOf(renderHeroToggle(env.module, env.t, { view: 'paused', countdownMs: 37_000 }).button), '高峰 🎉 37s');
});

test('三段布局：图标 + 固定宽相位 + 倒计时，相位位置不随状态变化', async (t) => {
  const env = await setup();
  t.after(env.restore);

  for (const [snapshot, expectedPhase] of [
    [snapshotOf({ status: statusOf({ enabled: true, paused: true }), countdownMs: COUNTDOWN_MS }), '高峰'],
    [snapshotOf({ status: statusOf({ enabled: true, paused: false }), countdownMs: COUNTDOWN_MS }), '空闲'],
    [snapshotOf({ status: statusOf({ enabled: false, paused: false }), countdownMs: COUNTDOWN_MS }), '空闲']
  ]) {
    const chip = renderChip(env.module, env.t, snapshot);
    const children = chip.button.props.children;
    assert.equal(children.length, 3, '三段：图标 / 相位 / 倒计时');
    assert.equal(children[1].props.style.width, '24px');
    assert.equal(children[1].props.style.flex, 'none');
    assert.equal(children[1].props.children, expectedPhase, '相位段位置固定、只换文字');
    assert.equal(children[2].props.style.flex, '0 0 auto');
  }

  // hero 同结构。
  const hero = renderHeroToggle(env.module, env.t, { view: 'paused' });
  const heroChildren = hero.button.props.children;
  assert.equal(heroChildren.length, 3);
  assert.equal(heroChildren[1].props.style.width, '24px');
  assert.equal(heroChildren[1].props.children, '高峰');
});

test('倒计时紧迫感：按剩余时间给 urgent/final，未选中也生效', async (t) => {
  const env = await setup();
  t.after(env.restore);
  const at = (countdownMs, enabled = true) =>
    renderChip(
      env.module,
      env.t,
      snapshotOf({ status: statusOf({ enabled, paused: enabled }), countdownMs })
    );
  assert.equal(at(120_000).button.props['data-offpeak-urgent'], undefined);
  assert.equal(at(61_000).button.props['data-offpeak-urgent'], undefined);
  assert.equal(at(60_000).button.props['data-offpeak-urgent'], 'urgent');
  assert.equal(at(37_000).button.props['data-offpeak-urgent'], 'urgent');
  assert.equal(at(10_000).button.props['data-offpeak-urgent'], 'final');
  assert.equal(at(9_000).button.props['data-offpeak-urgent'], 'final');
  assert.equal(at(0).button.props['data-offpeak-urgent'], undefined);
  // 未选中（普通会话）也显示倒计时与紧迫动效。
  assert.equal(at(15_000, false).button.props['data-offpeak-urgent'], 'urgent');
});

test('渲染：能力探测 false / 无 sessionId 都返回隐藏占位（保持订阅，不返回 null）', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const disabled = renderChip(env.module, env.t, snapshotOf({ status: statusOf({ paused: true }) }), {
    capability: false
  });
  assert.equal(disabled.buttons.length, 0);
  assert.equal(collectNodes(disabled.tree, (node) => node.props['data-offpeak-hidden'] === 'disabled').length, 1);

  const noSession = renderChip(env.module, env.t, snapshotOf(), { sessionId: '' });
  assert.equal(noSession.buttons.length, 0);
  assert.equal(collectNodes(noSession.tree, (node) => node.props['data-offpeak-hidden'] === 'no-session').length, 1);
});
// #endregion

// #region 新建会话页的「谷峰插件」开关
test('新建页开关：峰/谷 + 倒计时；选中浅灰、未选中深色；内容不随选中变化', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const peak = renderHeroToggle(env.module, env.t, { view: 'paused' });
  assert.equal(heroTextOf(peak.button), '高峰 3h05m');
  assert.equal(peak.button.props.style.border, '1px solid #d0d3d8', '选中为浅灰边框');
  assert.ok(String(peak.button.props.style.background).includes('--dsw-alias-state-warn-tertiary'), '高峰背景为橙');
  assert.ok(String(peak.button.props.style.color).includes('--dsw-alias-state-warn'), '高峰内部橙色');
  assert.ok(peak.label.includes('已暂停 AI 调用'));
  assert.ok(collectNodes(peak.tree, (node) => node.type === 'circle').length >= 1, '峰用太阳');

  const idle = renderHeroToggle(env.module, env.t, { view: 'idle' });
  assert.equal(heroTextOf(idle.button), '空闲 3h05m');
  assert.equal(idle.button.props.style.border, '1px solid #d0d3d8', '选中为浅灰边框');
  assert.ok(String(idle.button.props.style.background).includes('--dsw-alias-state-success-tertiary'), '空闲背景为绿');
  assert.ok(collectNodes(idle.tree, (node) => node.type === 'path').length >= 2, '谷用月亮+星');

  // 未选中：白款，但内部依旧是「相位 + 倒计时」（同一份显示）。
  const plain = renderHeroToggle(env.module, env.t, { view: 'off' });
  assert.equal(plain.button.props['data-lianggu-enabled'], 'false');
  assert.equal(plain.button.props.style.border, '1px solid #ffffff', '未选中为白色边框');
  assert.ok(String(plain.button.props.style.background).includes('--dsw-alias-state-success-tertiary'), '未选中背景仍按相位（空闲绿）');
  assert.ok(String(plain.button.props.style.color).includes('--dsw-alias-state-success'), '内部空闲绿不变');
  assert.ok(heroTextOf(plain.button).endsWith('3h05m'), '未选中也显示倒计时');
  assert.ok(plain.label.includes('点击设为「空闲会话」'));
});

test('点击：只切换当前会话（不建会话、不导航、不弹提示）', async (t) => {
  const env = await setup();
  t.after(env.restore);
  const rendered = renderHeroToggle(env.module, env.t, { view: 'idle' });
  rendered.button.props.onClick();
  assert.deepEqual(rendered.toggles, [true]);
  assert.equal(
    collectNodes(rendered.tree, (node) => node.props !== undefined && typeof node.props.onDone === 'function').length,
    0
  );

  const { connection, calls } = createConnection();
  const env2 = await setup({ connection });
  t.after(env2.restore);
  const contribution = env2.state.registrations.find((item) => item.entry.id === 'lianggu-hero-toggle');
  const store = contribution.entry.inject('session-src').offpeak;
  await store.toggle();
  assert.deepEqual(calls.map((call) => call.method), ['setEnabled']);
  assert.deepEqual(calls[0].payload, { sessionId: 'session-src', enabled: true });
});

test('隐藏占位：能力停用 / 无 session 都隐藏且保持订阅', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const noCapability = renderHeroToggle(env.module, env.t, { capability: false });
  assert.equal(noCapability.buttons.length, 0);
  assert.equal(
    collectNodes(noCapability.tree, (node) => node.props['data-lianggu-hero-hidden'] === 'disabled').length,
    1
  );

  const noSession = renderHeroToggle(env.module, env.t, { sessionId: '' });
  assert.equal(noSession.buttons.length, 0);
  assert.equal(
    collectNodes(noSession.tree, (node) => node.props['data-lianggu-hero-hidden'] === 'no-session').length,
    1
  );
});
// #endregion

test('子智能体只读：chip 置灰不可点、提示写明继承；hero 开关隐藏', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const inherited = statusOf({
    enabled: true,
    enabledSource: 'parent',
    readOnly: true,
    inheritedFrom: 'parent',
    paused: true,
    idle: false,
    cover: { agent: true, running: false, held: true, interrupted: false, queued: 0 }
  });
  const chip = renderChip(env.module, env.t, snapshotOf({ status: inherited, countdownMs: COUNTDOWN_MS }));
  assert.equal(chip.button.props['data-offpeak-read-only'], 'true');
  assert.equal(chip.button.props.disabled, true, '只读时按钮禁用');
  assert.equal(chip.button.props['data-offpeak-state'], 'paused');
  assert.ok(chip.label.includes('继承自主会话'), `只读提示：${chip.label}`);
  assert.equal(chip.label.includes('不能修改'), true);
  chip.button.props.onClick();
  assert.deepEqual(chip.toggles, [], '只读时点击不应触发 toggle');

  // hero 开关在只读会话里完全不出现。
  const hero = renderHeroToggle(env.module, env.t, { view: 'paused', readOnly: true });
  assert.equal(hero.buttons.length, 0);
  assert.equal(
    collectNodes(hero.tree, (node) => node.props['data-lianggu-hero-hidden'] === 'read-only').length,
    1
  );
});

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
          idle: false,
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
