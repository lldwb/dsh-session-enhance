/**
 * 「新建梁谷会话」Host 实现（`lib/offpeak/create.mjs`）的离线单测。
 *
 * 覆盖关键回归：hero 上的空白会话**可能没有 live Agent**，此时必须从持久化 header 拿到
 * cwd/工作区，并把新会话 attach 到工作区——否则界面无法导航（真实事故：桌面 profile 里
 * 按钮每次创建都变成“未挂工作区的孤儿会话”，看起来就是没反应）。
 *
 * @module dsh-session-enhance/test/offpeak-create
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiangguSession } from '../lib/offpeak/create.mjs';

/**
 * 造一个依赖注入环境。
 *
 * @param {{ services?: Record<string, any>, createResult?: any, createError?: any }} [options] - 覆盖项。
 * @returns {{ getService: (name: string) => any, calls: any[], enabled: string[], controller: any }} 环境。
 */
function makeEnv(options = {}) {
  const calls = [];
  const enabled = [];
  const services = {
    sessionController: {
      create: async (request) => {
        calls.push(request);
        if (options.createError !== undefined) throw options.createError;
        return options.createResult === undefined ? { sessionId: 'session-new' } : options.createResult;
      }
    },
    ...options.services
  };
  return {
    calls,
    enabled,
    controller: {
      setEnabled: (sessionId, value) => {
        enabled.push({ sessionId, value });
        return { enabled: value };
      }
    },
    getService: (name) => services[name]
  };
}

test('冷会话（无 live Agent）：从持久化 header 取 cwd，按工作区成员关系创建并启用', async () => {
  const env = makeEnv({
    services: {
      // 没有 agents，或者 agents.get 返回 undefined —— 模拟 hero 上的空白会话。
      agents: { get: () => undefined },
      sessionQuery: {
        traceSession: async () => ({ target: { header: { id: 'session-src', cwd: 'C:\\ws\\ungrouped' } } })
      },
      workspaceRegistry: {
        list: () => [
          { id: 'ws-other', path: 'C:\\other', sessionIds: [] },
          { id: 'ws-ungrouped', path: 'C:\\ws\\ungrouped', sessionIds: ['session-src'], attachSession: async () => {} }
        ],
        resolveByPath: async () => undefined
      }
    }
  });
  const result = await createLiangguSession({
    sourceSessionId: 'session-src',
    getService: env.getService,
    controller: env.controller
  });
  assert.deepEqual(env.calls, [{ workspaceId: 'ws-ungrouped' }]);
  assert.deepEqual(env.enabled, [{ sessionId: 'session-new', value: true }]);
  assert.deepEqual(result, { sessionId: 'session-new', agentPreset: null, workspaceId: 'ws-ungrouped' });
});

test('冷会话：没有成员关系时按 cwd 调 resolveByPath；解析到工作区就带 workspaceId', async () => {
  const env = makeEnv({
    services: {
      sessionQuery: { traceSession: async () => ({ target: { header: { cwd: 'C:\\ws\\a' } } }) },
      workspaceRegistry: {
        list: () => [],
        resolveByPath: async (path) => (path === 'C:\\ws\\a' ? { id: 'ws-a', path, sessionIds: [] } : undefined)
      }
    }
  });
  await createLiangguSession({ sourceSessionId: 'session-src', getService: env.getService, controller: env.controller });
  assert.deepEqual(env.calls, [{ workspaceId: 'ws-a' }]);
});

test('找不到工作区但有 cwd：退回 cwd 创建，不报错；返回值 workspaceId=null', async () => {
  const env = makeEnv({
    services: {
      agents: { get: () => ({ session: { header: { cwd: 'C:\\loose' } } }) },
      workspaceRegistry: { list: () => [], resolveByPath: async () => undefined }
    }
  });
  const result = await createLiangguSession({
    sourceSessionId: 'session-src',
    getService: env.getService,
    controller: env.controller
  });
  assert.deepEqual(env.calls, [{ cwd: 'C:\\loose' }]);
  assert.equal(result.workspaceId, null);
});

test('live 会话：沿用 header.agentPreset；header 没有时问 agentPresets', async () => {
  const env = makeEnv({
    services: {
      agents: { get: () => ({ session: { header: { cwd: 'C:\\ws\\p', agentPreset: 'commander' } } }) },
      workspaceRegistry: { list: () => [{ id: 'ws-p', path: 'C:\\ws\\p', sessionIds: ['session-src'] }] }
    }
  });
  const result = await createLiangguSession({
    sourceSessionId: 'session-src',
    getService: env.getService,
    controller: env.controller
  });
  assert.deepEqual(env.calls, [{ workspaceId: 'ws-p', agentPreset: 'commander' }]);
  assert.equal(result.agentPreset, 'commander');

  const viaService = makeEnv({
    services: {
      agents: { get: () => ({ session: { header: { cwd: 'C:\\ws\\p' } } }) },
      agentPresets: { presetForSession: () => 'interview' },
      workspaceRegistry: { list: () => [{ id: 'ws-p', path: 'C:\\ws\\p', sessionIds: ['session-src'] }] }
    }
  });
  await createLiangguSession({
    sourceSessionId: 'session-src',
    getService: viaService.getService,
    controller: viaService.controller
  });
  assert.deepEqual(viaService.calls, [{ workspaceId: 'ws-p', agentPreset: 'interview' }]);
});

test('兜底 attach：工作区解析到了但创建时只能走 cwd 分支时，显式 attachSession', async () => {
  const attached = [];
  const env = makeEnv({
    services: {
      agents: { get: () => ({ session: { header: { cwd: 'C:\\ws\\a' } } }) },
      workspaceRegistry: {
        list: () => [],
        resolveByPath: async () => ({
          id: 'ws-a',
          path: 'C:\\ws\\a',
          sessionIds: [],
          attachSession: async (id) => attached.push(id)
        })
      }
    }
  });
  // 让 create 在带 workspaceId 时失败一次，再走 cwd 分支？这里简化为：工作区对象没有 id
  // 时会走 cwd 分支，随后用 attachSession 兜底。
  const noIdWorkspace = makeEnv({
    services: {
      agents: { get: () => ({ session: { header: { cwd: 'C:\\ws\\b' } } }) },
      workspaceRegistry: {
        list: () => [],
        resolveByPath: async () => ({ path: 'C:\\ws\\b', sessionIds: [], attachSession: async (id) => attached.push(id) })
      }
    }
  });
  await createLiangguSession({
    sourceSessionId: 'session-src',
    getService: noIdWorkspace.getService,
    controller: noIdWorkspace.controller
  });
  assert.deepEqual(noIdWorkspace.calls, [{ cwd: 'C:\\ws\\b' }]);
  assert.deepEqual(attached, ['session-new']);
  void env;
});

test('错误路径：缺 sessionController → UNAVAILABLE；create 抛错 → CREATE_FAILED；返回无 id → CREATE_FAILED', async () => {
  const missing = makeEnv({ services: { sessionController: undefined } });
  await assert.rejects(
    createLiangguSession({ sourceSessionId: 's', getService: missing.getService, controller: missing.controller }),
    /session-controller is unavailable/
  );

  const broken = makeEnv({ createError: new Error('workspace not found') });
  await assert.rejects(
    createLiangguSession({ sourceSessionId: 's', getService: broken.getService, controller: broken.controller }),
    /could not create a new session: workspace not found/
  );

  const noId = makeEnv({ createResult: { agentPreset: 'standard' } });
  await assert.rejects(
    createLiangguSession({ sourceSessionId: 's', getService: noId.getService, controller: noId.controller }),
    /returned no session id/
  );
  // 失败时不能写开关。
  assert.deepEqual(noId.enabled, []);
});
