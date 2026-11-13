#!/usr/bin/env node
/**
 * 修复被 5.3.0 及更早版本写坏的会话日志。
 *
 * ## 病因
 *
 * 5.3.0 及更早的按需修剪在 turn 之外 append `compaction/prune` + `tool/result(surfaceOp: replace)`。
 * DSH 的重放校验器对 surface 替换有硬规则：
 *
 *     if (openTurn === null) throw new SessionFormatError('tool/result replacement is outside an open turn')
 *
 * 于是整份日志被判 corrupt：`readSession` / `readSurface` 全部失败 —— 会话历史读不出来、
 * 会话也无法冷恢复。5.3.1 起已不再写坏（修剪前先问 `isTurnOpen`），本脚本负责**修存量**。
 *
 * ## 修法
 *
 * 整对删除（`compaction/prune` + 它紧跟的 replacement），保留被修剪的原始 `tool/result`
 * 原样（内容不丢、surface 不残缺），再重编号 seq 并**重映射全部引用**
 * （`sourceEventSeqs` / `surfaceOp.startSeq|endSeq` / `shadowedSeqs` / `shadowedRange` /
 * `messageSeqs` / `developer/message.headerSeq`）。引用到已删事件的值从列表里剔除并去重。
 *
 * ## 校验门禁（任一不过就中止，不碰原文件）
 *
 * 1. turn/step 规则 0 违规
 * 2. seq 唯一 + 连续 + 引用无悬空
 * 3. **DSH 自己的 `Session.fromRestore`**（从 app.asar 抽出的真实校验器）
 * 4. 打包回读一致
 *
 * ## 用法
 *
 *     node scripts/repair-session-log.mjs <session.v4.jsonl.zstd> [--apply] [--asar <路径>]
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
const target = argv.find((a, i) => !a.startsWith('--') && (asarIndex === -1 || i !== asarIndex + 1));
if (target === undefined) {
  console.error('用法: node scripts/repair-session-log.mjs <session.v4.jsonl.zstd> [--apply] [--asar <路径>]');
  process.exit(2);
}

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
if (doomed.size === 0) {
  console.log('✅ 没有「turn 之外的 surface 替换」，无需修复。');
  process.exit(0);
}
console.log(`发现 ${doomed.size} 条需删除（seq: ${[...doomed].sort((a, b) => a - b).join(', ')}）`);

const { surviving } = repair(events, doomed);
console.log(`修复后 ${surviving.length} 条，seq 0..${surviving.length - 1}`);

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

// 门禁 3：DSH 真实重放校验
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
  console.log(`[门禁 3] DSH fromRestore: 通过（surface ${result.surfaceNodes} 节点，deriveMessages ${result.messages} 条）`);
} catch (error) {
  console.error(`[门禁 3] DSH fromRestore 失败：${String(error?.message ?? error)}`);
  console.error('❌ 中止（原文件未改动）。这通常意味着该会话还有别的结构问题（例如整段压缩摘要的 sourceEventSeqs 不变量）。');
  process.exit(1);
}

// 门禁 4：打包回读一致
const repairedJsonl = `${JSON.stringify(header)}\n${surviving.map((e) => JSON.stringify(e)).join('\n')}\n`;
const packed = packPerLine(repairedJsonl);
if (decodeFrames(packed) !== repairedJsonl) {
  console.error('❌ 打包回读不一致，中止');
  process.exit(1);
}
console.log(`[门禁 4] 重打包 ${packed.length} B，回读一致`);

if (!apply) {
  console.log('\n🧪 dry-run：以上全部校验通过，但未写任何文件。加 --apply 才会写回（会先备份）。');
  process.exit(0);
}

const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
fs.writeFileSync(target, packed);
console.log(`\n✅ 已写回。备份: ${backup}（${original.length} B）`);
