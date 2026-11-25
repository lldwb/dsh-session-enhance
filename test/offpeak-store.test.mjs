/**
 * 「谷峰会话」状态存储。
 *
 * 钉住四件事：原子写（不留临时文件）、容量上限按 `updatedAt` 淘汰最旧、损坏文件
 * 容忍（不抛错、`corrupt` 可见、写前备份）、`defaultEnabled` 只对无显式记录的会话生效。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MAX_ENTRIES,
  STORE_VERSION,
  createOffpeakStore,
  offpeakStateFilePath,
} from '../lib/offpeak/store.mjs';

/**
 * 造一个临时目录与其中的状态文件路径。
 *
 * @returns {{ dir: string, file: string, cleanup: () => void }} 夹具。
 */
function tempStoreFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-offpeak-store-'));
  return {
    dir,
    file: path.join(dir, 'dsh-session-enhance', 'offpeak.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('状态文件路径：<DSH_HOME>/dsh-session-enhance/offpeak.json', () => {
  const file = offpeakStateFilePath(path.join('C:', 'home', '.dsh'));
  assert.match(file.replaceAll('\\', '/'), /\/\.dsh\/dsh-session-enhance\/offpeak\.json$/u);
  assert.equal(DEFAULT_MAX_ENTRIES, 500);
  assert.equal(STORE_VERSION, 1);
});

test('空存储：size 0、无错误、查询回落到 defaultEnabled', () => {
  const fixture = tempStoreFile();
  try {
    const store = createOffpeakStore({ storeFile: fixture.file });
    assert.equal(store.size, 0);
    assert.equal(store.corrupt, false);
    assert.equal(store.error(), null);
    assert.equal(store.get('s1'), undefined);
    assert.equal(store.isEnabled('s1', false), false);
    assert.equal(store.isEnabled('s1', true), true, '无记录时用默认值');
    assert.equal(store.sourceOf('s1'), 'default');
    assert.deepEqual(store.list(), []);
    assert.equal(fs.existsSync(fixture.file), false, '纯读取不落盘');
  } finally {
    fixture.cleanup();
  }
});

test('setEnabled 落盘 → 新实例能读回；显式记录覆盖 defaultEnabled', () => {
  const fixture = tempStoreFile();
  try {
    const now = () => 1_700_000_000_000;
    const store = createOffpeakStore({ storeFile: fixture.file, now });
    const outcome = store.setEnabled('session-a', true);
    assert.equal(outcome.persisted, true);
    assert.deepEqual(outcome.evicted, []);

    const raw = JSON.parse(fs.readFileSync(fixture.file, 'utf8'));
    assert.deepEqual(raw, {
      version: STORE_VERSION,
      sessions: { 'session-a': { enabled: true, updatedAt: 1_700_000_000_000 } },
    });

    // 重新加载（模拟重启）。
    const reloaded = createOffpeakStore({ storeFile: fixture.file, now });
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.isEnabled('session-a', false), true, '显式 true 压过 defaultEnabled=false');
    assert.equal(reloaded.sourceOf('session-a'), 'session');
    assert.equal(reloaded.get('session-a').updatedAt, 1_700_000_000_000);

    // 显式 false 也要能压过 defaultEnabled=true。
    reloaded.setEnabled('session-b', false);
    const again = createOffpeakStore({ storeFile: fixture.file, now });
    assert.equal(again.isEnabled('session-b', true), false);
    assert.equal(again.error(), null);
  } finally {
    fixture.cleanup();
  }
});

test('原子写：不留 .tmp 临时文件', () => {
  const fixture = tempStoreFile();
  try {
    const store = createOffpeakStore({ storeFile: fixture.file });
    store.setEnabled('s1', true);
    store.setEnabled('s2', false);
    const dir = path.dirname(fixture.file);
    const files = fs.readdirSync(dir);
    assert.deepEqual(files, ['offpeak.json'], `不该留下临时文件：${files.join(',')}`);
  } finally {
    fixture.cleanup();
  }
});

test('容量上限：按 updatedAt 淘汰最旧，超出的不会写进文件', () => {
  const fixture = tempStoreFile();
  try {
    let clock = 1_000;
    const store = createOffpeakStore({ storeFile: fixture.file, now: () => clock, maxEntries: 3 });
    store.setEnabled('s1', true); // updatedAt 1000
    clock = 2_000;
    store.setEnabled('s2', true);
    clock = 3_000;
    store.setEnabled('s3', true);

    clock = 4_000;
    const outcome = store.setEnabled('s4', true);
    assert.deepEqual(outcome.evicted, ['s1'], '最旧的 s1 被淘汰');
    assert.equal(store.size, 3);
    assert.equal(store.get('s1'), undefined);
    assert.ok(store.get('s2') && store.get('s3') && store.get('s4'));

    // 更新一个已存在的会话会刷新 updatedAt，从而不再是"最旧"。
    clock = 5_000;
    store.setEnabled('s2', false);
    clock = 6_000;
    const next = store.setEnabled('s5', true);
    assert.deepEqual(next.evicted, ['s3']);

    const reloaded = createOffpeakStore({ storeFile: fixture.file, now: () => clock, maxEntries: 3 });
    assert.deepEqual(reloaded.list().map((record) => record.sessionId).sort(), ['s2', 's4', 's5']);
  } finally {
    fixture.cleanup();
  }
});

test('损坏文件：不抛错、corrupt 可见、写盘前备份坏文件、之后能正常读写', () => {
  const fixture = tempStoreFile();
  try {
    fs.mkdirSync(path.dirname(fixture.file), { recursive: true });
    fs.writeFileSync(fixture.file, '{ this is not json', 'utf8');

    const store = createOffpeakStore({ storeFile: fixture.file, now: () => 9_999 });
    assert.equal(store.corrupt, true);
    assert.equal(store.size, 0, '坏文件按空表继续，不崩');
    assert.equal(store.get('s1'), undefined);
    const error = store.error();
    assert.ok(error instanceof Error);
    assert.match(error.message, /无法解析/);

    // 写入应成功，并且写之前把坏文件备份下来。
    const outcome = store.setEnabled('s1', true);
    assert.equal(outcome.persisted, true);
    const backup = `${fixture.file}.corrupt-9999.bak`;
    assert.ok(fs.existsSync(backup), '坏文件应被备份');
    assert.equal(fs.readFileSync(backup, 'utf8'), '{ this is not json', '备份内容是原始坏文件');
    const reloaded = createOffpeakStore({ storeFile: fixture.file, now: () => 9_999 });
    assert.equal(reloaded.isEnabled('s1', false), true);
    assert.equal(reloaded.corrupt, false);
    assert.equal(reloaded.error(), null);
  } finally {
    fixture.cleanup();
  }
});

test('文件里的坏条目被清洗，好条目保留', () => {
  const fixture = tempStoreFile();
  try {
    fs.mkdirSync(path.dirname(fixture.file), { recursive: true });
    fs.writeFileSync(
      fixture.file,
      JSON.stringify({
        version: STORE_VERSION,
        sessions: {
          good: { enabled: true, updatedAt: 5 },
          '  ': { enabled: true, updatedAt: 1 },
          badBoolean: { enabled: 'yes', updatedAt: 2 },
          badShape: 'nope',
          missingTime: { enabled: false },
        },
      }),
      'utf8',
    );
    const store = createOffpeakStore({ storeFile: fixture.file, now: () => 777 });
    assert.deepEqual(store.list().map((record) => record.sessionId).sort(), ['good', 'missingTime']);
    assert.equal(store.get('missingTime').updatedAt, 777, '缺失 updatedAt 用当前时间补');
    assert.equal(store.isEnabled('badBoolean', false), false, '非法条目被丢弃，回落到默认');
  } finally {
    fixture.cleanup();
  }
});

test('setEnabled 的非法 sessionId 抛错（由调用方转成 BAD_REQUEST）', () => {
  const fixture = tempStoreFile();
  try {
    const store = createOffpeakStore({ storeFile: fixture.file });
    assert.throws(() => store.setEnabled('', true), /sessionId/u);
    assert.throws(() => store.setEnabled(undefined, true), /sessionId/u);
  } finally {
    fixture.cleanup();
  }
});

test('写盘失败不抛错：persisted=false 且 error() 可见', () => {
  // 用一个"父路径是文件"的路径强制 mkdir/rename 失败（跨平台的稳定做法）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-offpeak-store-fail-'));
  try {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x', 'utf8');
    const storeFile = path.join(blocker, 'offpeak.json');
    const store = createOffpeakStore({ storeFile });
    const outcome = store.setEnabled('s1', true);
    assert.equal(outcome.persisted, false);
    assert.ok(outcome.error instanceof Error);
    assert.equal(store.error() instanceof Error, true);
    // 内存状态仍然生效（开关不会因为磁盘失败而"点了没反应"）。
    assert.equal(store.isEnabled('s1', false), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
