/**
 * 「侧边提问」组件的离线单测。
 *
 * 覆盖三层（都不需要浏览器、不联网、不调模型）：
 *
 * 1. **询问提示词**（`lib/sideask/prompt.mjs`）：参考会话 id、可用工具、只读约束、
 *    引用块、中英两套文案、`我的问题：` 收尾；
 * 2. **RPC 端点**（`lib/sideask/rpc.mjs`）：信封形状（成功 `{ok:true,value}` / 失败
 *    `{ok:false,error:{code,message,details:{}}}`）、参数校验、未知端点；
 * 3. **Host 控制器**（`lib/sideask/host.mjs`）：沿用原会话工作区与预设创建新会话、
 *    立即切只读（fail-closed：只读切不上就归档新会话并报错）、保留时恢复原预设、
 *    登记表与 forget。
 *
 * @module dsh-session-enhance/test/sideask
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAskContext, buildAskPrompt, formatSideAskQuote, SIDEASK_SESSION_TOOLS } from '../lib/sideask/prompt.mjs';
import { createSideAskHandler } from '../lib/sideask/rpc.mjs';
import { createSideAskController, SIDEASK_CONTEXT_NAME, SIDEASK_FALLBACK_PRESET, SIDEASK_READ_ONLY_PRESET } from '../lib/sideask/host.mjs';

/** 一个活会话的替身。 */
const PARENT_ID = 'session-parent';
const CHILD_ID = 'session-child';

/**
 * 造一个够用的 mock 服务面。
 *
 * @param {object} [options] - 覆盖项。
 * @param {boolean} [options.live] - 原会话是否存在。
 * @param {string | null} [options.preset] - 原会话的 Agent 预设。
 * @param {boolean} [options.readOnlyFails] - 切只读是否抛错。
 * @param {string} [options.defaultPreset] - catalog 的默认预设。
 * @param {boolean} [options.hasWorkspace] - 原会话是否属于工作区。
 * @returns {object} mock 控制器依赖与调用记录。
 */
function mockServices(options = {}) {
  const calls = { created: [], commandLines: [], archived: [], promptContexts: [] };
  const services = {
    sessions: {
      get(id) {
        if (id !== PARENT_ID) return undefined;
        if (options.live === false) return undefined;
        return { header: { id: PARENT_ID, cwd: 'C:\\work', title: '被参考的会话' } };
      },
    },
    agents: {
      get(id) {
        // 真实 Agent 上挂着自己的 scope（agent.ctx）：侧边提问把「参考会话」系统上下文
        // 注册在这个 scope 里，只影响该会话。`noSystemPrompt` 用来覆盖降级路径。
        const effect = (factory) => {
          const dispose = factory();
          return typeof dispose === 'function' ? dispose : () => {};
        };
        const systemPrompt = options.noSystemPrompt === true
          ? undefined
          : { context: (definition) => { calls.promptContexts.push({ sessionId: id, definition }); return () => {} } };
        return { session: { header: { id } }, ctx: { effect, systemPrompt } };
      },
    },
    commands: {
      async execute(agent, line) {
        calls.commandLines.push({ sessionId: agent.session.header.id, line });
        if (options.readOnlyFails === true && line.includes(SIDEASK_READ_ONLY_PRESET)) {
          return { commandId: 'command-1', result: { kind: 'error', text: 'read-only is unavailable' } };
        }
        return { commandId: 'command-1', result: { kind: 'success', text: line } };
      },
    },
    sessionController: {
      async create(request) {
        calls.created.push(request);
        return { sessionId: CHILD_ID, agentPreset: request.agentPreset };
      },
    },
    permissionPresets: {
      current(session) {
        if (options.parentPermission === null) return 'custom';
        return options.parentPermission ?? 'workspace-write';
      },
      catalog() {
        return { defaultPreset: options.defaultPreset ?? 'workspace-write' };
      },
    },
    agentPresets: {
      presetForSession() {
        return options.preset === undefined ? 'cordis' : options.preset;
      },
    },
    workspaceRegistry: {
      list() {
        if (options.hasWorkspace === false) return [];
        return [{ id: 'ws-1', sessionIds: [PARENT_ID] }];
      },
      async archiveSession(sessionId, archiveOptions) {
        calls.archived.push({ sessionId, options: archiveOptions });
      },
    },
  };
  return { services, calls };
}

test('询问提示词：包含参考会话 id、查询工具、只读约束与问题占位', () => {
  const prompt = buildAskPrompt({ parentSessionId: PARENT_ID, parentTitle: '被参考的会话', locale: 'zh-CN' });
  assert.match(prompt, /临时助手/);
  assert.ok(prompt.includes(PARENT_ID), '必须包含参考会话 id');
  assert.ok(prompt.includes('被参考的会话'));
  for (const tool of SIDEASK_SESSION_TOOLS) assert.ok(prompt.includes(tool), `提示词要列出 ${tool}`);
  assert.match(prompt, /只读/);
  assert.ok(prompt.trimEnd().endsWith('我的问题：'), '以「我的问题：」收尾供用户补问题');
  assert.ok(!prompt.includes('session_search'), '不要点名官方跨会话检索工具（有工作区授权限制）');
});

test('询问提示词：引用块 + 英文文案', () => {
  const prompt = buildAskPrompt({
    parentSessionId: PARENT_ID,
    parentTitle: 'Parent',
    quote: '第一行\n第二行\n\n第四行',
    locale: 'en-US',
  });
  assert.match(prompt, /read-only/i);
  assert.ok(prompt.includes('> 第一行\n> 第二行\n>\n> 第四行'), '多行引用要逐行加 >、空行保留');
  assert.ok(prompt.trimEnd().endsWith('My question:'));
  assert.ok(!prompt.includes('我的问题：'));
});

test('引用格式化：空白输入返回空串', () => {
  assert.equal(formatSideAskQuote(''), '');
  assert.equal(formatSideAskQuote('   \n  '), '');
  assert.equal(formatSideAskQuote(null), '');
  assert.equal(formatSideAskQuote('a\r\nb'), '> a\n> b');
});

test('Host 控制器：沿用原会话的工作区与预设创建新会话，并立即切只读', async () => {
  const { services, calls } = mockServices();
  const controller = createSideAskController(services);
  const result = await controller.create({ parentSessionId: PARENT_ID, quote: '选中的文字' });

  assert.equal(result.ok, true);
  assert.equal(result.value.sessionId, CHILD_ID);
  assert.equal(result.value.restorePreset, 'workspace-write', '记录的是父会话的权限预设（不是 Agent 预设）');
  assert.ok(result.value.prompt.includes(PARENT_ID));
  assert.ok(result.value.prompt.includes('> 选中的文字'));
  assert.deepEqual(calls.created, [{ workspaceId: 'ws-1', agentPreset: 'cordis' }], '应沿用工作区与预设');
  assert.deepEqual(calls.commandLines, [{ sessionId: CHILD_ID, line: '/permission read-only' }]);
  assert.equal(controller.size, 1);
});

test('Host 控制器：把参考会话注入侧边会话自己的系统上下文（不依赖客户端预填）', async () => {
  const { services, calls } = mockServices();
  const controller = createSideAskController(services);
  const result = await controller.create({ parentSessionId: PARENT_ID, locale: 'zh-CN' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.contextRegistered, { registered: true }, '必须报告系统上下文注册成功');
  assert.equal(calls.promptContexts.length, 1, '必须且只注册一份系统上下文');
  const [registered] = calls.promptContexts;
  assert.equal(registered.sessionId, CHILD_ID, '必须注册在侧边会话自己的 agent scope');
  assert.equal(registered.definition.name, SIDEASK_CONTEXT_NAME);
  assert.equal(registered.definition.required, true, '参考会话是必需上下文，不能因运行时上下文开关被丢掉');
  assert.equal(registered.definition.interpolate, false, '文本含会话 id，不能被模板插值改写');
  assert.ok(registered.definition.text.includes(PARENT_ID), '系统上下文必须带参考会话 id');
  for (const tool of SIDEASK_SESSION_TOOLS) assert.ok(registered.definition.text.includes(tool));
});

test('Host 控制器：部署没有 systemPrompt 时安静降级，并如实报告原因', async () => {
  const { services, calls } = mockServices({ noSystemPrompt: true });
  const controller = createSideAskController(services);
  const result = await controller.create({ parentSessionId: PARENT_ID });

  assert.equal(result.ok, true, '降级不应让整个创建失败');
  assert.equal(result.value.contextRegistered.registered, false);
  assert.equal(result.value.contextRegistered.reason, 'SYSTEM_PROMPT_UNAVAILABLE');
  assert.equal(calls.promptContexts.length, 0);
});

test('询问上下文：与预填提示词同源，含会话 id / 工具 / 只读约束', () => {
  const context = buildAskContext({ parentSessionId: PARENT_ID, parentTitle: '被参考的会话', locale: 'zh-CN' });
  assert.ok(context.includes(PARENT_ID));
  assert.ok(context.includes('被参考的会话'));
  for (const tool of SIDEASK_SESSION_TOOLS) assert.ok(context.includes(tool));
  assert.match(context, /只读/);
  assert.ok(!context.includes('我的问题：'), '系统上下文不需要「我的问题」占位（那是输入框的事）');

  const english = buildAskContext({ parentSessionId: PARENT_ID, locale: 'en-US' });
  assert.match(english, /read-only/i);
});

test('Host 控制器：原会话不在工作区时退回 cwd 创建', async () => {
  const { services, calls } = mockServices({ hasWorkspace: false });
  const controller = createSideAskController(services);
  const result = await controller.create({ parentSessionId: PARENT_ID });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.created, [{ cwd: 'C:\\work', agentPreset: 'cordis' }]);
});

test('Host 控制器：原会话不存在 → SESSION_NOT_FOUND，不创建任何会话', async () => {
  const { services, calls } = mockServices({ live: false });
  const controller = createSideAskController(services);
  const result = await controller.create({ parentSessionId: 'session-missing' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SESSION_NOT_FOUND');
  assert.deepEqual(calls.created, []);
});

test('Host 控制器：只读切不上 → fail-closed（归档新会话并报错，不返回可用会话）', async () => {
  const { services, calls } = mockServices({ readOnlyFails: true });
  const controller = createSideAskController(services);
  const result = await controller.create({ parentSessionId: PARENT_ID });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'READ_ONLY_UNAVAILABLE');
  assert.deepEqual(calls.archived.map(item => item.sessionId), [CHILD_ID], '必须归档刚建的会话');
  assert.equal(controller.size, 0, '失败不应留下登记');
});

test('Host 控制器：保留时恢复原预设；不认识该会话时退回 catalog 默认', async () => {
  const first = mockServices();
  const controller = createSideAskController(first.services);
  await controller.create({ parentSessionId: PARENT_ID });
  const restored = await controller.restore({ sessionId: CHILD_ID });
  assert.equal(restored.ok, true);
  assert.equal(restored.value.preset, 'workspace-write');
  assert.deepEqual(first.calls.commandLines.at(-1), { sessionId: CHILD_ID, line: '/permission workspace-write' });

  // 父会话权限读不出（custom）时，保留退回 catalog 默认。
  const custom = mockServices({ parentPermission: null, defaultPreset: 'danger-full-access' });
  const customController = createSideAskController(custom.services);
  const createdCustom = await customController.create({ parentSessionId: PARENT_ID });
  assert.equal(createdCustom.value.restorePreset, null);
  const customRestored = await customController.restore({ sessionId: CHILD_ID });
  assert.equal(customRestored.value.preset, 'danger-full-access');
  assert.deepEqual(custom.calls.commandLines.at(-1), { sessionId: CHILD_ID, line: '/permission danger-full-access' });

  const second = mockServices({ defaultPreset: 'danger-full-access' });
  const other = createSideAskController(second.services);
  const fallback = await other.restore({ sessionId: 'session-unknown' });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.value.preset, 'danger-full-access');

  const third = mockServices({ defaultPreset: '' });
  const bare = createSideAskController(third.services);
  const fixed = await bare.restore({ sessionId: 'session-unknown' });
  assert.equal(fixed.value.preset, SIDEASK_FALLBACK_PRESET);
});

test('Host 控制器：setPreset 透传与 forget 清理登记', async () => {
  const { services, calls } = mockServices();
  const controller = createSideAskController(services);
  await controller.create({ parentSessionId: PARENT_ID });
  const switched = await controller.setPreset({ sessionId: CHILD_ID, preset: SIDEASK_READ_ONLY_PRESET });
  assert.equal(switched.ok, true);
  assert.deepEqual(calls.commandLines.at(-1), { sessionId: CHILD_ID, line: '/permission read-only' });
  assert.deepEqual(controller.forget({ sessionId: CHILD_ID }), { forgotten: true });
  assert.deepEqual(controller.forget({ sessionId: CHILD_ID }), { forgotten: false });
  controller.dispose();
  assert.equal(controller.size, 0);
});

test('RPC 端点：probe / create / setPreset / restore / forget 的成功信封', async () => {
  const { services } = mockServices();
  const controller = createSideAskController(services);
  const handle = createSideAskHandler({ controller, build: 'test-build' });

  const probe = await handle('probe', {});
  assert.deepEqual(probe, { ok: true, value: { available: true, build: 'test-build' } });

  const created = await handle('create', { parentSessionId: PARENT_ID, quote: '引用', locale: 'zh-CN' });
  assert.equal(created.ok, true);
  assert.equal(created.value.sessionId, CHILD_ID);
  assert.ok(created.value.prompt.includes(PARENT_ID));

  const preset = await handle('setPreset', { sessionId: CHILD_ID, preset: SIDEASK_READ_ONLY_PRESET });
  assert.equal(preset.ok, true);

  const restored = await handle('restore', { sessionId: CHILD_ID });
  assert.equal(restored.ok, true);
  assert.equal(restored.value.preset, 'workspace-write');

  const forgotten = await handle('forget', { sessionId: CHILD_ID });
  assert.deepEqual(forgotten, { ok: true, value: { forgotten: true } });
});

test('RPC 端点：参数校验、未知端点与失败信封的 details 是对象', async () => {
  const { services } = mockServices();
  const controller = createSideAskController(services);
  const handle = createSideAskHandler({ controller });

  const missingParent = await handle('create', {});
  assert.equal(missingParent.ok, false);
  assert.equal(missingParent.error.code, 'BAD_REQUEST');
  assert.deepEqual(missingParent.error.details, {});

  const notFound = await handle('create', { parentSessionId: 'session-missing' });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error.code, 'SESSION_NOT_FOUND');

  const missingPreset = await handle('setPreset', { sessionId: CHILD_ID });
  assert.equal(missingPreset.ok, false);
  assert.equal(missingPreset.error.code, 'BAD_REQUEST');

  const unknown = await handle('nope', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'UNKNOWN_METHOD');

  const missingRestore = await handle('restore', {});
  assert.equal(missingRestore.ok, false);
  assert.equal(missingRestore.error.code, 'BAD_REQUEST');
});
