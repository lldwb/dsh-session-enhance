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

/**
 * 取 hero 开关的文字（按钮里承载倒计时/空闲的那个 span；关态为空串）。
 * @param {any} button - 按钮元素。
 * @returns {string} 文案。
 */
function heroTextOf(button) {
  const texts = collectNodes(button, (node) => node.type === 'span' && typeof node.props.children === 'string');
  return texts.map((node) => node.props.children).join('');
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
  const capability = options.capability === undefined ? true : options.capability;
  const view = options.view === undefined ? 'off' : options.view;
  const snapshot = snapshotOf({
    status: statusOf({ enabled: view !== 'off', paused: view === 'paused' }),
    busy: view === 'busy',
    countdownMs: view === 'paused' ? COUNTDOWN_MS : null
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
      }
    }
  };
  const tree = module.LiangguHeroToggle(props);
  // Tooltip 占位组件：node.props 里有 label，children 是按钮元素。
  const tooltip = collectNodes(
    tree,
    (node) => node.props !== undefined && typeof node.props.label === 'string' && node.props.children?.type === 'button'
  )[0];
  const button = tooltip === undefined ? undefined : tooltip.props.children;
  const buttons = button === undefined ? [] : [button];
  return { tree, tooltip, button, buttons, toggles, label: tooltip === undefined ? undefined : tooltip.props.label };
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

test('词典：offpeak.* 在 en/zh 键集一致，中文文案是「梁谷/空闲时段/高峰时段」', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const zhKeys = Object.keys(env.zh).filter((key) => key.startsWith('offpeak.'));
  const enKeys = Object.keys(env.en).filter((key) => key.startsWith('offpeak.'));
  assert.ok(zhKeys.length >= 10, `offpeak 词条太少：${zhKeys.length}`);
  assert.deepEqual(zhKeys.slice().sort(), enKeys.slice().sort(), 'en/zh 的 offpeak 键必须一一对应');

  // 命名纠正的硬门禁：旧名「谷峰」「谷时」一个残留都不能有。
  for (const key of zhKeys) {
    assert.ok(!env.zh[key].includes('谷峰'), `词条 ${key} 仍含旧名谷峰：${env.zh[key]}`);
    assert.ok(!env.zh[key].includes('谷时'), `词条 ${key} 仍含旧名谷时：${env.zh[key]}`);
  }

  assert.equal(env.zh['offpeak.chip.off'], '梁谷');
  assert.equal(env.zh['offpeak.chip.paused'], '梁谷 暂停 {countdown}');
  assert.equal(env.zh['offpeak.chip.idle'], '梁谷 空闲');
  assert.equal(env.zh['offpeak.chip.busy'], '…');
  assert.equal(env.zh['offpeak.title.paused'], '梁谷：已暂停');
  assert.ok(env.zh['offpeak.title.pausedBody'].includes('不会发起任何 AI 调用'));
  assert.ok(env.zh['offpeak.peakHours'].includes('高峰时段'));
  assert.ok(env.zh['offpeak.peakHours'].includes('周一至周五'));
  assert.ok(env.zh['offpeak.peakHours'].includes('法定节假日'));
  assert.ok(env.zh['offpeak.resumeAt'].includes('自动恢复'));
  assert.ok(env.zh['offpeak.pauseAt'].includes('自动暂停'));
  assert.ok(env.zh['offpeak.queued'].includes('{n}'));
  assert.equal(env.zh['offpeak.windowJoiner'], '、');
  for (const key of zhKeys) {
    assert.ok(env.en[key].length > 0, `en 词条 ${key} 不能为空`);
  }

  // 6.3.0 hero 开关词条：键集一致、中文文案齐全。
  const zhNewKeys = Object.keys(env.zh).filter((key) => key.startsWith('lianggu.'));
  const enNewKeys = Object.keys(env.en).filter((key) => key.startsWith('lianggu.'));
  assert.ok(zhNewKeys.length >= 3, `lianggu 词条太少：${zhNewKeys.length}`);
  assert.deepEqual(zhNewKeys.slice().sort(), enNewKeys.slice().sort(), 'en/zh 的 lianggu 键必须一一对应');
  assert.equal(env.zh['lianggu.heroOff'], '梁峰');
  assert.equal(env.zh['lianggu.heroName'], '梁谷');
  assert.equal(env.zh['lianggu.heroIdle'], '空闲');
  assert.ok(env.zh['lianggu.tipOff'].includes('梁谷'));
  assert.ok(env.zh['lianggu.tipOffBody'].includes('梁谷会话'));
  assert.ok(env.zh['lianggu.tipResumeAt'].includes('{time}'));
  assert.ok(env.zh['lianggu.tipPauseAt'].includes('{time}'));
  assert.ok(env.zh['lianggu.heroAria'].includes('梁谷'));
});
// #endregion

// #region 纯函数
test('formatOffpeakCountdown：>1h 小时分钟；≤1h 分钟秒（含不足 1 分钟与 1 小时整点）', () => {
  const { formatOffpeakCountdown } = loadModule();
  assert.equal(formatOffpeakCountdown(COUNTDOWN_MS), '3h05m');
  assert.equal(formatOffpeakCountdown(12 * 60 * 1000 + 34 * 1000), '12m34s');
  assert.equal(formatOffpeakCountdown(59 * 60 * 1000 + 59 * 1000), '59m59s');
  assert.equal(formatOffpeakCountdown(60 * 1000), '1m00s');
  assert.equal(formatOffpeakCountdown(59 * 1000), '0m59s');
  assert.equal(formatOffpeakCountdown(42 * 1000), '0m42s');
  // 1 小时整点严格按「不超过 1 小时 = 分钟秒」。
  assert.equal(formatOffpeakCountdown(3600 * 1000), '60m00s');
  assert.equal(formatOffpeakCountdown(3601 * 1000), '1h00m');
  assert.equal(formatOffpeakCountdown(0), '0m00s');
  assert.equal(formatOffpeakCountdown(-5000), '0m00s');
  assert.equal(formatOffpeakCountdown(Number.NaN), '0m00s');
  assert.equal(formatOffpeakCountdown('not-a-number'), '0m00s');
  assert.equal(formatOffpeakCountdown(undefined), '0m00s');
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

// #region 组件渲染
test('渲染：关闭态是 muted「梁谷」，title 写明高峰时段与点击开启', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const off = renderChip(
    env.module,
    env.t,
    snapshotOf({ status: statusOf({ enabled: false, paused: false, idle: true }) })
  );
  assert.notEqual(off.button, undefined);
  assert.equal(off.button.props['data-dsh-offpeak-button'], '');
  assert.equal(off.button.props['data-offpeak-state'], 'off');
  assert.equal(off.button.props['data-offpeak-enabled'], 'false');
  assert.equal(off.button.props.disabled, false);
  assert.equal(chipTextOf(off.button), '梁谷');
  const offTitle = off.button.props.title;
  // 逐字钉住任务书的文案：off 必须包含标题 / 一句机制 / 由 schedule.peakWindows 拼的
  // 高峰时段清单（含时区与节假日说明）/ 点击提示，四行、顺序固定。
  assert.equal(
    offTitle,
    [
      '梁谷：关闭',
      '开启后，在高峰时段暂停本会话，空闲时段自动恢复运行。',
      '高峰时段：周一至周五 09:00–12:00、14:00–18:00（Asia/Shanghai，法定节假日与周末除外）',
      '点击开启。'
    ].join('\n'),
    `关闭态 title 不符合约定：${offTitle}`
  );
  // 还没读到状态时也要能渲染（title 用不带时段的那条）。
  const unknown = renderChip(env.module, env.t, snapshotOf());
  assert.equal(unknown.button.props['data-offpeak-state'], 'off');
  assert.ok(unknown.button.props.title.includes('梁谷：关闭'));
});

test('渲染：暂停态是 amber「梁谷 暂停 3h05m」，title 写明自动恢复与排队条数', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const pausedStatus = statusOf({
    paused: true,
    idle: false,
    nextChangeKind: 'resume',
    cover: { agent: true, running: false, held: true, interrupted: false, queued: 2 }
  });
  const paused = renderChip(env.module, env.t, snapshotOf({ status: pausedStatus, countdownMs: COUNTDOWN_MS }));
  assert.equal(paused.button.props['data-offpeak-state'], 'paused');
  assert.equal(paused.button.props['data-offpeak-enabled'], 'true');
  assert.equal(chipTextOf(paused.button), '梁谷 暂停 3h05m');
  const title = paused.button.props.title;
  assert.equal(
    title,
    [
      '梁谷：已暂停',
      '当前是高峰时段，不会发起任何 AI 调用。',
      '高峰时段：周一至周五 09:00–12:00、14:00–18:00（Asia/Shanghai，法定节假日与周末除外）',
      '将在 08:30 自动恢复',
      '队列中 2 条消息，空闲时段开始后自动处理'
    ].join('\n'),
    `暂停态 title 不符合约定：${title}`
  );
  // 颜色走主题 token（暂停 = warn），并带 fallback。
  assert.ok(String(paused.button.props.style.color).includes('--dsw-alias-state-warn'));
});

test('渲染：空闲时段是 green「梁谷 空闲」，title 写明自动暂停；busy 是「…」且禁用', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const idle = renderChip(
    env.module,
    env.t,
    snapshotOf({ status: statusOf({ paused: false, idle: true }), countdownMs: COUNTDOWN_MS })
  );
  assert.equal(idle.button.props['data-offpeak-state'], 'idle');
  assert.equal(idle.button.props['data-offpeak-enabled'], 'true');
  assert.equal(chipTextOf(idle.button), '梁谷 空闲');
  const idleTitle = idle.button.props.title;
  assert.equal(
    idleTitle,
    [
      '梁谷：空闲时段运行中',
      '当前不在高峰时段，调用正常进行。',
      '将在 08:30 自动暂停'
    ].join('\n'),
    `空闲态 title 不符合约定：${idleTitle}`
  );
  assert.ok(String(idle.button.props.style.color).includes('--dsw-alias-state-success'));

  const busy = renderChip(
    env.module,
    env.t,
    snapshotOf({ status: statusOf({ paused: true, idle: false }), busy: true, countdownMs: COUNTDOWN_MS })
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

  const notice = { text: '切换梁谷失败（BAD_REQUEST）', sequence: 7 };
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

// #region 新建会话页的「梁谷」开关
test('渲染：关=太阳+「梁峰」；开=月亮+「梁谷」+倒计时/空闲；busy 禁用', async (t) => {
  const env = await setup();
  t.after(env.restore);

  const off = renderHeroToggle(env.module, env.t);
  assert.equal(off.buttons.length, 1);
  assert.equal(off.button.props['data-dsh-lianggu-hero'], '');
  assert.equal(off.button.props['data-lianggu-state'], 'off');
  assert.equal(off.button.props['data-lianggu-enabled'], 'false');
  assert.equal(off.button.props.disabled, false);
  // 关：太阳 + 「梁峰」。
  assert.equal(heroTextOf(off.button), '梁峰');
  assert.ok(
    collectNodes(off.tree, (node) => node.type === 'svg' || typeof node.type === 'function').length >= 1,
    '开关必须渲染图标（primitives 图标或内联 svg）'
  );
  assert.ok(collectNodes(off.tree, (node) => node.type === 'circle').length >= 1, '关态应是太阳（circle + 光芒）');
  // 提示改用官方 Tooltip（primitives），不要元素原生 title——原生 title 是系统白底黑框。
  assert.equal('title' in off.button.props, false, '开关不要用原生 title');
  assert.ok(off.tooltip !== undefined, '开关应包在官方 Tooltip 里');
  assert.equal(off.tooltip.props.side, 'bottom');
  assert.ok(off.label.includes('梁谷'), `关态提示应出现「梁谷」：${off.label}`);
  assert.ok(off.label.includes('点击开启'), `关态提示应说明点击开启：${off.label}`);

  const paused = renderHeroToggle(env.module, env.t, { view: 'paused' });
  assert.equal(paused.button.props['data-lianggu-state'], 'paused');
  assert.equal(paused.button.props['data-lianggu-enabled'], 'true');
  assert.equal(heroTextOf(paused.button), '梁谷 3h05m');
  assert.ok(paused.label.includes('高峰暂停'), `暂停态提示：${paused.label}`);
  assert.ok(/将在 \d{2}:\d{2} 自动恢复/.test(paused.label), `暂停态应给恢复时刻：${paused.label}`);
  assert.ok(
    collectNodes(paused.tree, (node) => node.type === 'path').length >= 2,
    '开态应是月亮 + 小星星（两个 path）'
  );
  assert.ok(
    collectNodes(paused.tree, (node) => node.type === 'path' && node.props.fill === 'currentColor').length >= 1,
    '星星应是实心（fill=currentColor）'
  );

  const idle = renderHeroToggle(env.module, env.t, { view: 'idle' });
  assert.equal(idle.button.props['data-lianggu-state'], 'idle');
  assert.equal(idle.button.props['data-lianggu-enabled'], 'true');
  assert.equal(heroTextOf(idle.button), '梁谷 空闲');
  assert.ok(idle.label.includes('空闲'), `空闲态提示：${idle.label}`);
  assert.ok(/将在 \d{2}:\d{2} 自动暂停/.test(idle.label), `空闲态应给暂停时刻：${idle.label}`);

  const busy = renderHeroToggle(env.module, env.t, { view: 'busy' });
  assert.equal(busy.button.props.disabled, true);
  assert.equal(heroTextOf(busy.button), '梁谷 …');
  assert.ok(busy.label.includes('切换'), `busy 提示：${busy.label}`);
});

test('点击：只切换当前会话的梁谷开关（不建会话、不导航、不弹提示）', async (t) => {
  const env = await setup();
  t.after(env.restore);
  const rendered = renderHeroToggle(env.module, env.t, { view: 'idle' });
  rendered.button.props.onClick();
  assert.deepEqual(rendered.toggles, [true]);
  // 不渲染 Toast：树里没有带 onDone 的 P.Toast 元素。
  assert.equal(
    collectNodes(rendered.tree, (node) => node.props !== undefined && typeof node.props.onDone === 'function').length,
    0
  );

  // 真实控制器：toggle 只发 setEnabled，不发任何“创建会话”请求。
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
