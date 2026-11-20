#!/usr/bin/env node
/**
 * 修复被写坏的会话日志。目前认两类病因，可单独或同时出现。
 *
 * ## 病因 A：turn 之外的 surface 替换（5.3.0 及更早）
 *
 * 5.3.0 及更早的按需修剪在 turn 之外 append `compaction/prune` + `tool/result(surfaceOp: replace)`。
 * DSH 的重放校验器对 surface 替换有硬规则：
 *
 *     if (openTurn === null) throw new SessionFormatError('tool/result replacement is outside an open turn')
 *
 * 于是整份日志被判 corrupt：`readSession` / `readSurface` 全部失败 —— 会话历史读不出来、
 * 会话也无法冷恢复。5.3.1 起已不再写坏（修剪前先问 `isTurnOpen`），本脚本负责**修存量**。
 *
 * 修法：整对删除（`compaction/prune` + 它紧跟的 replacement），保留被修剪的原始 `tool/result`
 * 原样（内容不丢、surface 不残缺），再重编号 seq 并**重映射全部引用**
 * （`sourceEventSeqs` / `surfaceOp.startSeq|endSeq` / `shadowedSeqs` / `shadowedRange` /
 * `messageSeqs` / `developer/message.headerSeq`）。引用到已删事件的值从列表里剔除并去重。
 *
 * ## 病因 B：`turn/end.data.reason === null`（dsh-commander-mode ≤ 7.25.0 的退化看门狗）
 *
 * 看门狗调用 `agent.cancel({ kind: 'degeneration' })`，而 `AgentCancelCause` 是**封闭 union**
 * （`user | parent | hook | disposed`）。`agent-loop` 的 `abortedCancelCause()` 用 exhaustive
 * switch 归一化，未知成员走 `assertNever()` 抛错；该异常发生在 `finally` 之前，`turnEnds` 仍是
 * null，`finally` 照样 `append('turn/end', { turn, reason: null })`。
 *
 * 这条事件的**可怕之处是它过得了 `fromRestore`**（重放校验只看信封 / seq / surface / header），
 * 所以 `readSession` / `session_lookup` 都正常，只有**投影层**崩：
 * `api/session-controller/src/continuation.ts:46` 读 `event.data.reason.kind` → TypeError →
 * GUI「历史加载失败：failed to project session … Cannot read properties of null (reading 'kind')」
 * （`history/controller.ts:172` 用 `projectionMode: 'all'`）。服务端另有 `subagent` 的投影
 * 与 `epochStopReason()` 读同一个字段，所以这不是单点。
 *
 * 修法：把 `reason` 换成**合法的封闭 union 值**。默认
 * `{"kind":"aborted","reason":{"kind":"legacy"}}` —— `legacy` 是 DSH 给「原始记录没有携带 cause
 * 的导入」准备的成员，语义就是「被取消，但原因未记录」，客户端 `turn-error.ts` 对
 * `aborted` + 非 `hook` 只显示「已停止」，不会伪造「进程已退出」那种假告警。已知确切原因时可用
 * `--cause '{"kind":"aborted","reason":{"kind":"hook","reason":"degeneration"}}'` 写入真实原因。
 *
 * ## 校验门禁（任一不过就中止，不碰原文件）
 *
 * 1. turn/step 规则 0 违规
 * 2. seq 唯一 + 连续 + 引用无悬空
 * 3. **reason 结构不变量**：每个 `turn/end.data.reason` 都是对象、`kind` 属于
 *    `TurnEndReasonMap` 的已知成员；`aborted` 的 cause.kind 属于
 *    `user|parent|hook|disposed|legacy`（这条专门挡「修完还是 null」与拼错 kind）
 * 4. **DSH 自己的 `Session.fromRestore`**（从 app.asar 抽出的真实校验器）
 * 5. 打包回读一致
 *
 * 边界（诚实说明）：`fromRestore` **不校验** `turn/end.reason`，所以门禁 4 挡不住病因 B；
 * 挡它的是门禁 3。投影层本身要用真实投影跑，脚本不重实现——修复后请在真实 GUI / 新进程里
 * 打开一次该会话做端到端确认。
 *
 * ## 用法
 *
 *     node scripts/repair-session-log.mjs <session.v4.jsonl.zstd> [--apply] [--asar <路径>] [--cause <JSON>]
 *
 * 默认 dry-run：只报告会改什么、并跑完校验，**不写任何文件**。
 * `--apply` 才写回（先备份为 `<file>.bak-<时间戳>`）。
 *
 * @module dsh-session-enhance/scripts/repair-session-log
 */

import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DEFAULT_ASAR = 'C:\\Users\\32471\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar';

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const asarIndex = argv.indexOf('--asar');
const asarPath = asarIndex === -1 ? DEFAULT_ASAR : argv[asarIndex + 1];
const causeIndex = argv.indexOf('--cause');
const causeJson = causeIndex === -1 ? undefined : argv[causeIndex + 1];
const target = argv.find((a, i) => !a.startsWith('--')
  && (asarIndex === -1 || i !== asarIndex + 1)
  && (causeIndex === -1 || i !== causeIndex + 1));
if (target === undefined) {
  console.error('用法: node scripts/repair-session-log.mjs <session.v4.jsonl.zstd> [--apply] [--asar <路径>] [--cause <JSON>]');
  process.exit(2);
}

/** 修复 `turn/end.reason` 时写入的合法值（默认：被取消、原因未记录）。 */
const DEFAULT_REASON = { kind: 'aborted', reason: { kind: 'legacy' } };
let replacementReason = DEFAULT_REASON;
if (causeJson !== undefined) {
  let parsed;
  try {
    parsed = JSON.parse(causeJson);
  } catch (error) {
    console.error(`--cause 不是合法 JSON：${String(error?.message ?? error)}`);
    process.exit(2);
  }
  replacementReason = parsed;
}
/** `TurnEndReasonMap` 的已知成员（合并可扩展，但这些之外的值会让读取方走 default）。 */
const KNOWN_REASON_KINDS = new Set([
  'completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked',
]);
/** `TurnEndCancelCause` 的已知成员。 */
const KNOWN_CANCEL_KINDS = new Set(['user', 'parent', 'hook', 'disposed', 'legacy']);

// ── zstd 多帧 ───────────────────────────────────────────────────────────────
/** 解出全部帧并拼接（DSH 的会话日志是「每次 append 一帧」）。 */
function decodeFrames(buf) {
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 1;
  }
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
    } catch {
      // 尾部半帧（写入中断）跳过
    }
  }
  return parts.join('');
}

/** 一行一帧打包（与 DSH 自己的 append 形态一致；首帧只装 header）。 */
function packPerLine(jsonl) {
  return Buffer.concat(
    jsonl
      .split('\n')
      .filter(Boolean)
      .map((line) => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))),
  );
}

// ── 检测 + 修复 ─────────────────────────────────────────────────────────────
const isReplace = (value) => {
  const op = value?.surfaceOp;
  return op !== null && typeof op === 'object' && op.op === 'replace';
};

/** 找出「落在开放 turn 之外」的 replacement，返回要删除的 seq 集合。 */
function findDoomed(events) {
  const doomed = new Set();
  let openTurn = null;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.type === 'turn/start') openTurn = event.data?.turn ?? 0;
    else if (event.type === 'turn/end') openTurn = null;
    else if (event.type === 'tool/result' && isReplace(event) && openTurn === null) {
      doomed.add(event.seq);
      const prev = events[i - 1];
      if (prev?.type === 'compaction/prune') doomed.add(prev.seq);
    }
  }
  return doomed;
}

/** 删掉 doomed、重编号 seq、重映射全部引用。 */
function repair(events, doomed) {
  const surviving = events.filter((e) => !(typeof e.seq === 'number' && doomed.has(e.seq)));
  const remap = new Map();
  let next = 0;
  for (const e of surviving) if (typeof e.seq === 'number') remap.set(e.seq, next++);

  const mapSeq = (v) => (typeof v === 'number' && remap.has(v) ? remap.get(v) : v);
  /** 被删的引用剔除 + 按原顺序去重（校验器要求 sourceEventSeqs 无重复）。 */
  const mapSeqList = (list) => {
    const out = [];
    const seen = new Set();
    for (const s of list) {
      if (doomed.has(s)) continue;
      const mapped = mapSeq(s);
      if (seen.has(mapped)) continue;
      seen.add(mapped);
      out.push(mapped);
    }
    return out;
  };

  for (const e of surviving) {
    if (typeof e.seq === 'number') e.seq = remap.get(e.seq);
    if (Array.isArray(e.sourceEventSeqs)) e.sourceEventSeqs = mapSeqList(e.sourceEventSeqs);
    const op = e.surfaceOp;
    if (op && typeof op === 'object' && op.op === 'replace') {
      op.startSeq = mapSeq(op.startSeq);
      op.endSeq = mapSeq(op.endSeq);
    }
    const d = e.data ?? {};
    if (Array.isArray(d.shadowedSeqs)) d.shadowedSeqs = mapSeqList(d.shadowedSeqs);
    if (d.shadowedRange) {
      d.shadowedRange.start = mapSeq(d.shadowedRange.start);
      d.shadowedRange.end = mapSeq(d.shadowedRange.end);
    }
    if (Array.isArray(d.messageSeqs)) d.messageSeqs = mapSeqList(d.messageSeqs);
    if (d.headerSeq !== undefined) d.headerSeq = mapSeq(d.headerSeq);
  }
  return { surviving, remap };
}

/** `turn/end` 的 reason 是否是「读取方一碰就炸」的形状（null / 缺失 / 非对象 / 数组）。 */
function isBrokenReason(reason) {
  return reason === null || reason === undefined || typeof reason !== 'object' || Array.isArray(reason);
}

/**
 * 找出所有 `turn/end.data.reason` 形状非法的**事件**（病因 B）。
 *
 * 只认「形状坏」——`{kind:'某个插件自定义值'}` 这种**合法但未知**的 kind 不碰：
 * 读取方的 switch/if 都有 default 分支，改它反而会篡改语义。
 *
 * @param events - 全部事件（已重编号后的）。
 * @returns 需要改写 reason 的事件数组。
 */
function findBadTurnEnds(events) {
  return events.filter((e) => e.type === 'turn/end' && isBrokenReason(e.data?.reason));
}

/**
 * 把坏掉的 `turn/end.reason` 换成合法值（默认「被取消、原因未记录」）。
 *
 * @param events - 事件数组（原地修改）。
 * @returns 被改写的事件描述（供报告）。
 */
function repairBrokenReasons(events) {
  const changed = [];
  for (const e of events) {
    if (e.type !== 'turn/end' || !isBrokenReason(e.data?.reason)) continue;
    const before = e.data.reason;
    e.data.reason = structuredClone(replacementReason);
    changed.push({ seq: e.seq, turn: e.data.turn, before });
  }
  return changed;
}

/** 门禁：每个 turn/end 的 reason / aborted.cause 都必须落在已知封闭 union 里。 */
function checkReasons(events) {
  const problems = [];
  for (const e of events) {
    if (e.type !== 'turn/end') continue;
    const reason = e.data?.reason;
    if (isBrokenReason(reason)) {
      problems.push(`seq ${e.seq}: reason 不是对象（${String(reason)}）`);
      continue;
    }
    if (!KNOWN_REASON_KINDS.has(reason.kind)) {
      problems.push(`seq ${e.seq}: reason.kind=${JSON.stringify(reason.kind)} 不在 TurnEndReasonMap 已知成员内`);
      continue;
    }
    if (reason.kind === 'aborted') {
      const cause = reason.reason;
      if (cause === null || typeof cause !== 'object' || !KNOWN_CANCEL_KINDS.has(cause.kind)) {
        problems.push(`seq ${e.seq}: aborted.reason.kind=${JSON.stringify(cause?.kind)} 不是合法 AgentCancelCause`);
      } else if (cause.kind === 'hook' && typeof cause.reason !== 'string') {
        problems.push(`seq ${e.seq}: aborted.reason.kind=hook 但 reason 不是字符串`);
      }
    }
    if (reason.kind === 'error') {
      const failure = reason.error;
      if (failure === null || typeof failure !== 'object' || typeof failure.code !== 'string') {
        problems.push(`seq ${e.seq}: error.reason 缺少 error.code`);
      }
    }
  }
  return problems;
}

// ── 从 app.asar 抽 DSH 校验器（依赖闭包） ────────────────────────────────────
function extractValidatorClosure(asar, outDir) {
  const fd = fs.openSync(asar, 'r');
  const sizeBuf = Buffer.alloc(16);
  fs.readSync(fd, sizeBuf, 0, 16, 0);
  const headerSectionSize = sizeBuf.readUInt32LE(4);
  const jsonLength = sizeBuf.readUInt32LE(12);
  const headerBuf = Buffer.alloc(jsonLength);
  fs.readSync(fd, headerBuf, 0, jsonLength, 16);
  const header = JSON.parse(headerBuf.toString('utf8'));
  const dataStart = 8 + headerSectionSize;

  const files = new Map();
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (value.files) walk(value, path);
      else files.set(path, { size: Number(value.size ?? 0), offset: Number(value.offset ?? 0) });
    }
  };
  walk(header, '');

  const readInner = (inner) => {
    const entry = files.get(inner);
    if (entry === undefined) return undefined;
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, dataStart + entry.offset);
    return buf;
  };

  const packageOf = (spec) => {
    const parts = spec.split('/');
    return spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  };

  const queue = ['@deepseek-ai/dsh-session'];
  const done = new Set();
  while (queue.length > 0) {
    const pkg = queue.shift();
    if (done.has(pkg)) continue;
    done.add(pkg);
    const prefix = `dsh/node_modules/${pkg}/`;
    for (const [inner] of files) {
      if (!inner.startsWith(prefix)) continue;
      const rel = inner.slice(prefix.length);
      if (!/^(lib\/.*\.(js|mjs|cjs)|package\.json)$/.test(rel)) continue;
      const dest = join(outDir, 'node_modules', pkg, rel.replaceAll('/', '\\'));
      fs.mkdirSync(dirname(dest), { recursive: true });
      fs.writeFileSync(dest, readInner(inner));
    }
    const base = join(outDir, 'node_modules', pkg);
    const scan = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
          continue;
        }
        if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        for (const m of text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
          const spec = m[1];
          if (spec.startsWith('.') || spec.startsWith('node:')) continue;
          const dep = packageOf(spec);
          if (!done.has(dep) && !queue.includes(dep)) queue.push(dep);
        }
      }
    };
    scan(base);
  }
  fs.closeSync(fd);
  return join(outDir, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
}

/** 用 DSH 自己的 `Session.fromRestore` 校验一份事件日志。 */
async function validateWithDsh(header, events, entry) {
  const { Session } = await import(`file:///${entry.replaceAll('\\', '/')}`);
  const session = Session.fromRestore(header.id, events, header, 0, 'detached');
  const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : [];
  return { surfaceNodes: session.surface?.nodes?.length ?? 0, messages: messages.length };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const statAtRead = fs.statSync(target);
const original = fs.readFileSync(target);
const jsonl = decodeFrames(original);
const all = jsonl
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const header = all.find((e) => e.type === 'session');
const events = all.filter((e) => e.type !== 'session');
console.log(`会话 ${header?.id ?? '?'}：${events.length} 条事件（原始 ${original.length} B）`);

const doomed = findDoomed(events);
const badReasonsBefore = findBadTurnEnds(events);
if (doomed.size === 0 && badReasonsBefore.length === 0) {
  console.log('✅ 没有「turn 之外的 surface 替换」，也没有「turn/end.reason 形状非法」，无需修复。');
  process.exit(0);
}

let surviving = events;
if (doomed.size > 0) {
  console.log(`[病因 A] 发现 ${doomed.size} 条需删除（seq: ${[...doomed].sort((a, b) => a - b).join(', ')}）`);
  ({ surviving } = repair(events, doomed));
  console.log(`[病因 A] 修复后 ${surviving.length} 条，seq 0..${surviving.length - 1}`);
}

if (badReasonsBefore.length > 0) {
  console.log(`[病因 B] 发现 ${badReasonsBefore.length} 条 turn/end 的 reason 非法`
    + `（seq: ${badReasonsBefore.map((e) => e.seq).join(', ')}），将改写为 ${JSON.stringify(replacementReason)}`);
  const changed = repairBrokenReasons(surviving);
  for (const item of changed) {
    console.log(`  - turn ${item.turn}（seq ${item.seq}）：${JSON.stringify(item.before)} → ${JSON.stringify(replacementReason)}`);
  }
}

// 门禁 1：turn 规则
let openTurn = null;
let turnViolations = 0;
for (const e of surviving) {
  if (e.type === 'turn/start') openTurn = e.data?.turn ?? 0;
  else if (e.type === 'turn/end') openTurn = null;
  else if (e.type === 'tool/result' && isReplace(e) && openTurn === null) turnViolations += 1;
}
console.log(`[门禁 1] turn 规则违规: ${turnViolations}`);
if (turnViolations !== 0) {
  console.error('❌ 仍有违规，中止');
  process.exit(1);
}

// 门禁 2：seq 与引用完整性
const seqSet = new Set(surviving.map((e) => e.seq));
let dangling = 0;
const checkList = (list) => {
  for (const s of list ?? []) if (!seqSet.has(s)) dangling += 1;
};
for (const e of surviving) {
  checkList(e.sourceEventSeqs);
  if (isReplace(e)) checkList([e.surfaceOp.startSeq, e.surfaceOp.endSeq]);
  checkList(e.data?.shadowedSeqs);
  if (e.data?.shadowedRange) checkList([e.data.shadowedRange.start, e.data.shadowedRange.end]);
  checkList(e.data?.messageSeqs);
}
const contiguous = surviving.every((e, i) => e.seq === i);
console.log(`[门禁 2] 悬空引用 ${dangling}，seq 连续=${contiguous}`);
if (dangling !== 0 || !contiguous) {
  console.error('❌ 引用完整性未通过，中止（原文件未改动）');
  process.exit(1);
}

// 门禁 3：turn/end.reason 结构（病因 B 的专用门禁；fromRestore 不看这个字段）
const reasonProblems = checkReasons(surviving);
console.log(`[门禁 3] turn/end.reason 结构问题: ${reasonProblems.length}`);
if (reasonProblems.length !== 0) {
  for (const problem of reasonProblems.slice(0, 10)) console.error(`  - ${problem}`);
  console.error('❌ reason 结构不变量未通过，中止（原文件未改动）');
  process.exit(1);
}

// 门禁 4：DSH 真实重放校验
const cacheDir = join(tmpdir(), 'dsh-session-repair-validator');
let entry;
try {
  entry = extractValidatorClosure(asarPath, cacheDir);
} catch (error) {
  console.error(`❌ 无法从 ${asarPath} 抽出校验器：${String(error?.message ?? error)}`);
  process.exit(1);
}
try {
  const result = await validateWithDsh(header, surviving, entry);
  console.log(`[门禁 4] DSH fromRestore: 通过（surface ${result.surfaceNodes} 节点，deriveMessages ${result.messages} 条）`);
} catch (error) {
  console.error(`[门禁 4] DSH fromRestore 失败：${String(error?.message ?? error)}`);
  console.error('❌ 中止（原文件未改动）。这通常意味着该会话还有别的结构问题（例如整段压缩摘要的 sourceEventSeqs 不变量）。');
  process.exit(1);
}

// 门禁 5：打包回读一致
const repairedJsonl = `${JSON.stringify(header)}\n${surviving.map((e) => JSON.stringify(e)).join('\n')}\n`;
const packed = packPerLine(repairedJsonl);
if (decodeFrames(packed) !== repairedJsonl) {
  console.error('❌ 打包回读不一致，中止');
  process.exit(1);
}
console.log(`[门禁 5] 重打包 ${packed.length} B，回读一致`);

if (!apply) {
  console.log('\n🧪 dry-run：以上全部校验通过，但未写任何文件。加 --apply 才会写回（会先备份）。');
  process.exit(0);
}

// 并发写保护：日志可能属于一个还活着的会话（DSH 每次 append 都会改 size/mtime）。
// 读入之后如果文件又被追加过，写回就会把新事件覆盖掉 —— 这里宁可不修。
const statBeforeWrite = fs.statSync(target);
if (statBeforeWrite.size !== statAtRead.size || statBeforeWrite.mtimeMs !== statAtRead.mtimeMs) {
  console.error('❌ 文件在本次修复期间被写入过（size/mtime 变化），为避免丢失并发追加的事件，中止（原文件未改动）。');
  console.error('   该会话可能仍在运行：等它空闲（或重启 DSH）后再跑一次。');
  process.exit(1);
}

const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
fs.writeFileSync(target, packed);
console.log(`\n✅ 已写回。备份: ${backup}（${original.length} B）`);
