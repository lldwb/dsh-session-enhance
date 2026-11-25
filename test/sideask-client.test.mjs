/**
 * `dsh-session-enhance` 浏览器半里「侧边提问」组件的离线冒烟测试。
 *
 * 覆盖四件事（都不需要浏览器、不联网、不调模型）：
 *
 * 1. **bundle 形状**：`client.js` 仍通过 `window.__ModuleLoader__.load({ id, factory })`
 *    注册，`inject` 里包含侧边提问用到的服务；工厂导出本组件的纯函数；
 * 2. **界面注册**：`apply(mockCtx)` 在右侧栏注册页面型标签（带 guide 卡片）、
 *    标签正文（声明私有 session 子槽）、标题栏入口，以及合并弹层的两个 key
 *    （官方 `quote` 用更低 priority shadow + 自己的兜底 key）；
 * 3. **能力探测**：Host 组件行被停用（405）时，注册项被全部撤销（官方引用表面恢复）；
 * 4. **纯函数**：记录表（childOf / kept / archived）与引用块格式化。
 *
 * harness 与 `offpeak-client.test.mjs` 同一套：import 前摆好 window，import 后手动调
 * factory（每调一次等价于刷新一次页面），`jsx` 用测试替身，定时器用不调度的替身。
 *
 * @module dsh-session-enhance/test/sideask-client
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

/** client.js 的绝对 URL。 */
const CLIENT_URL = new URL('../client.js', import.meta.url).href;

/** 本插件的词典命名空间。 */
const NS = 'dsh-session-enhance';

/** import 之后由 `window.__ModuleLoader__.load` 交出的 definition。 */
let capturedDefinition = null;

/** 内存 localStorage（侧边会话记录表）。 */
const memoryStorage = (() => {
  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); }
  };
})();

// ⚠️ 必须在 `import('../client.js')` **之前**摆好 window：bundle 顶层就调用
// `window.__ModuleLoader__.load(...)`，晚一步就是 "window is not defined"。
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      capturedDefinition = definition;
    }
  },
  localStorage: memoryStorage,
  // 启动清扫的定时器：只记录不调度，测试进程不会多等 5 秒。
  setTimeout() { return 1; },
  clearTimeout() {}
};

await import(CLIENT_URL);

/** 极简 `jsx` 替身。 */
function jsx(type, props, key) {
  return { type, props: props === undefined ? {} : props, key };
}

/** 与 {@link jsx} 同形。 */
const jsxs = jsx;

/** primitives 占位组件缓存。 */
const primitiveComponents = new Map();

/**
 * 取一个 primitives 占位组件。
 * @param {string} name - 导出名。
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

/** `@deepseek-ai/dsh-client-ui-primitives` 的替身。 */
const primitives = new Proxy({}, {
  get(target, key) {
    if (typeof key !== 'string') return undefined;
    return primitiveOf(key);
  }
});

/** factory 用到的说明符。 */
const requiredSpecifiers = [];

/**
 * 工厂的 `require` 替身。
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
 * @returns {any} 模块导出。
 */
function loadModule() {
  assert.notEqual(capturedDefinition, null, 'client.js 必须调用 window.__ModuleLoader__.load({ factory })');
  return capturedDefinition.factory(fakeRequire);
}

/** 推进事件循环（flush 微任务 + 一轮 setImmediate）。 */
async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 造一个够用的浏览器插件上下文（含侧边提问用到的全部服务面）。
 *
 * @param {{ sideAskStatus?: number, rpc?: any }} [options] - 探测状态码与 RPC 替身。
 * @returns {{ ctx: any, state: any, fetchCalls: any[] }} 上下文与记录。
 */
function createMockCtx(options = {}) {
  const state = {
    dictionaries: {},
    localeRegisters: [],
    registrations: [],
    injections: [],
    interactions: [],
    tabTypes: [],
    closeHandlers: [],
    openedTabs: [],
    disposed: 0,
    effectLabels: []
  };
  const ctx = {
    connection: options.rpc === undefined ? { rpc: { call: async () => ({ ok: true, value: {} }) } } : options.rpc,
    configForms: undefined,
    locale: {
      bind: () => (key) => (state.dictionaries[key] === undefined ? key : state.dictionaries[key]),
      register: (namespace, dictionaries) => {
        state.localeRegisters.push({ namespace, dictionaries });
        Object.assign(state.dictionaries, dictionaries.zh === undefined ? {} : dictionaries.zh);
        return () => {};
      },
      getSnapshot: () => ({ active: 'zh-CN' })
    },
    slots: {
      inject: (name, callback) => {
        state.injections.push(name);
        return callback();
      },
      register: (entry, component) => {
        const record = { entry, component, revoked: false };
        state.registrations.push(record);
        return () => { record.revoked = true; state.disposed += 1; };
      }
    },
    effect: (factory, label) => {
      state.effectLabels.push(label);
      const disposer = factory();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    conversation: {
      input: {
        requestDraftInitialization() { return 'applied'; }
      }
    },
    uiConversation: {
      interactions: {
        register(definition) {
          const record = { definition, revoked: false };
          state.interactions.push(record);
          return () => { record.revoked = true; state.disposed += 1; };
        }
      }
    },
    sidebarRightTabs: {
      register(definition) {
        const record = { definition, revoked: false };
        state.tabTypes.push(record);
        return () => { record.revoked = true; state.disposed += 1; };
      }
    },
    sidebarRight: {
      registerCloseHandler(kind, handler) {
        state.closeHandlers.push({ kind, handler });
        return () => { state.disposed += 1; };
      },
      tabsIn() { return []; },
      openTab(kind) { state.openedTabs.push(kind); }
    },
    uiWorkspace: {
      archiveSession() { return Promise.resolve(); },
      unarchiveSession() { return Promise.resolve(); },
      openWorkspace() { return Promise.resolve(); }
    },
    sessions: {
      retain() { return { binding: {}, release() {} }; },
      binding() { return undefined; },
      refresh() { return Promise.resolve(); }
    }
  };
  return { ctx, state };
}

/**
 * 起一个「已 apply 的模块」：装好 fetch 替身（能力探测用）、执行 apply。
 *
 * @param {{ sideAskStatus?: number, rpc?: any }} [options] - 探测状态码与 RPC 替身。
 * @returns {Promise<any>} 环境句柄（含 restore）。
 */
async function setup(options = {}) {
  const fetchCalls = [];
  const previousFetch = globalThis.fetch;
  const sideAskStatus = options.sideAskStatus === undefined ? 200 : options.sideAskStatus;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    if (url === '/dsh-session-enhance-sideask') return { status: sideAskStatus };
    return { status: 200 };
  };
  const { ctx, state } = createMockCtx(options);
  const module = loadModule();
  module.apply(ctx);
  await flushAsync();
  return {
    module,
    ctx,
    state,
    fetchCalls,
    restore: () => {
      if (previousFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = previousFetch;
    }
  };
}

test('bundle 形状：只 require 平台模块表里的说明符，inject 含侧边提问的服务', async () => {
  const env = await setup();
  try {
    assert.deepEqual([...new Set(requiredSpecifiers)].sort(), [
      '@deepseek-ai/dsh-client-ui-primitives',
      'react',
      'react/jsx-runtime'
    ]);
    for (const service of ['conversation', 'uiConversation', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace']) {
      assert.ok(env.module.inject.includes(service), `inject 必须包含 ${service}`);
    }
    assert.equal(typeof env.module.createSideAskStore, 'function');
    assert.equal(typeof env.module.formatSideAskQuoteText, 'function');
  } finally {
    env.restore();
  }
});

test('界面注册：页面型标签 + guide 卡片、标签正文（私有 session 子槽）、标题栏入口', async () => {
  const env = await setup();
  try {
    const tabTypeRecord = env.state.tabTypes.find((item) => item.definition.kind === 'sideask');
    assert.notEqual(tabTypeRecord, undefined, '必须注册 sideask 页面型标签');
    const tabType = tabTypeRecord.definition;
    assert.equal(tabType.id, 'dsh-session-enhance/side-ask');
    assert.equal(tabType.guide.length, 1, 'guide 里必须有一张「侧边提问」卡片');
    assert.equal(tabType.guide[0].id, 'side-ask');

    const body = env.state.registrations.find((item) => item.entry.name === 'sidebar.right.pane.tab'
      && item.entry.key === 'dsh-session-enhance/side-ask');
    assert.notEqual(body, undefined, '必须注册标签正文');
    const seat = Object.keys(body.entry.children)[0];
    assert.equal(body.entry.children[seat].scope, 'session', '必须声明 session 子槽换取 SessionProvider');
    const face = body.entry.inject();
    assert.equal(typeof face.sideAsk.childOf, 'function');
    assert.equal(typeof face.sideAsk.ensureChild, 'function');
    assert.equal(typeof face.sideAsk.setKept, 'function');

    const header = env.state.registrations.find((item) => item.entry.name === 'conversation.session.header.utilities'
      && item.entry.id === 'side-ask');
    assert.notEqual(header, undefined, '必须注册标题栏入口');
    assert.equal(header.entry.order, -20);

    assert.deepEqual(env.state.closeHandlers.map((item) => item.kind), ['sideask']);
  } finally {
    env.restore();
  }
});

test('合并弹层：官方 quote 表面被更低 priority 的 shadow 接管，并有自己的兜底 key', async () => {
  const env = await setup();
  try {
    const entries = env.state.registrations
      .filter((item) => item.entry.name === 'conversation.chat.text-interaction');
    const shadow = entries.find((item) => item.entry.key === 'quote');
    const fallback = entries.find((item) => item.entry.key === 'sideask');
    assert.notEqual(shadow, undefined, '必须 shadow 官方 quote 表面');
    assert.equal(shadow.entry.priority, -1, 'shadow 必须用更低 priority');
    assert.notEqual(fallback, undefined, '必须有自己 key 的兜底表面');
    assert.equal(env.state.interactions.length, 1);
    assert.equal(env.state.interactions[0].definition.id, 'sideask');
  } finally {
    env.restore();
  }
});

test('能力探测：Host 组件行停用（405）时撤销全部注册，官方引用表面恢复', async () => {
  const env = await setup({ sideAskStatus: 405 });
  try {
    assert.ok(env.state.disposed > 0, '探测到停用后必须撤销注册');
    for (const record of env.state.tabTypes) assert.equal(record.revoked, true, '标签类型必须被撤销');
    // 只断言侧边提问自己的注册（apply 里还有复制/分享/重试/梁谷的注册，它们不受影响）。
    const sideAskRegistrations = env.state.registrations.filter((item) => (
      (item.entry.name === 'sidebar.right.pane.tab' && item.entry.key === 'dsh-session-enhance/side-ask')
      || (item.entry.name === 'conversation.session.header.utilities' && item.entry.id === 'side-ask')
      || (item.entry.name === 'conversation.chat.text-interaction'
        && (item.entry.key === 'quote' || item.entry.key === 'sideask'))
    ));
    assert.ok(sideAskRegistrations.length >= 4, '侧边提问应注册标签正文 / 标题栏 / 两个文字交互表面');
    for (const record of sideAskRegistrations) assert.equal(record.revoked, true, '侧边提问的槽位注册必须被撤销');
    for (const record of env.state.interactions) assert.equal(record.revoked, true, '手势注册必须被撤销');
  } finally {
    env.restore();
  }
});

test('记录表：childOf 只返回未归档的最新绑定，kept / archived 可切换', async () => {
  const env = await setup();
  try {
    const store = env.module.createSideAskStore(memoryStorage);
    store.upsert('session-child-1', 'session-parent');
    assert.equal(store.childOf('session-parent').childSessionId, 'session-child-1');
    store.setKept('session-child-1', true);
    assert.equal(store.get('session-child-1').kept, true);
    store.markArchived('session-child-1');
    assert.equal(store.childOf('session-parent'), undefined, '已归档的绑定不再被 childOf 返回');
    store.upsert('session-child-2', 'session-parent');
    assert.equal(store.childOf('session-parent').childSessionId, 'session-child-2');
    assert.equal(store.isChild('session-child-1'), true);
    store.markActive('session-child-1');
    assert.equal(store.get('session-child-1').archived, false);
  } finally {
    env.restore();
  }
});

test('引用块格式化：多行逐行加 >、空行保留、空白输入为空', async () => {
  const env = await setup();
  try {
    const format = env.module.formatSideAskQuoteText;
    assert.equal(format('第一行\n第二行\n\n第三行'), '> 第一行\n> 第二行\n>\n> 第三行');
    assert.equal(format('a\r\nb'), '> a\n> b');
    assert.equal(format('   '), '');
    assert.equal(format(null), '');
  } finally {
    env.restore();
  }
});
