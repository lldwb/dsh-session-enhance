/**
 * 分块摘要（map-reduce）的离线测试。
 *
 * 这些用例不碰真实 DSH 运行时：只验证「预算 → 切段 → 段内再超限 → 汇总 →
 * 交给官方 summarizer」的决策链与失败语义。真实 Loader 的端到端在
 * `test/e2e/` 与沙箱回归里做。
 *
 * @module dsh-session-enhance/test/summarizer
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isOverflowFailure } from '../lib/compact/overflow.mjs';
import {
  DEFAULT_INSTRUCTION_RESERVE_TOKENS,
  chunkedSummarize,
  contentChars,
  estimateMessagesTokens,
  estimateSummaryInputTokens,
  estimateToolsTokens,
  formatMessage,
  formatTranscript,
  planSegments,
  resolveChunkBudget,
  segmentPrompt,
  splitText,
  truncateText,
} from '../lib/compact/summarizer.mjs';

/**
 * 造一条纯文本消息。
 *
 * @param {string} role - 角色。
 * @param {string} text - 文本。
 * @returns {any} 消息。
 */
function textMessage(role, text) {
  return { role, content: [{ type: 'text', text }] };
}

/**
 * 造一个预算（测试用小数，便于切多段）。
 *
 * @param {object} [overrides] - 覆盖项。
 * @returns {any} 预算。
 */
function makeBudget(overrides = {}) {
  return {
    available: 1_000,
    segmentTokens: 100,
    mapMaxTokens: 64,
    maxSegments: 8,
    maxMapCalls: 20,
    maxSplitDepth: 3,
    ...overrides,
  };
}

/**
 * 造一组注入依赖并记录调用。
 *
 * @param {object} [overrides] - 覆盖 mapSegment / synthesize / isOverflow / log。
 * @returns {{ calls: { map: any[], synthesize: any[] }, deps: any }} 夹具。
 */
function makeHarness(overrides = {}) {
  const calls = { map: [], synthesize: [] };
  const deps = {
    mapSegment: async (prompt, meta) => {
      calls.map.push({ prompt, meta });
      return { text: `part-${calls.map.length}` };
    },
    synthesize: async (input) => {
      calls.synthesize.push(input);
      return {
        summary: [{ type: 'text', text: 'final summary' }],
        rawOutput: [{ type: 'text', text: 'final summary' }],
        provider: 'test',
        model: 'test-model',
        maxTokens: 64,
        llmStreamCall: true,
      };
    },
    isOverflow: () => false,
    log: () => {},
    ...overrides,
  };
  return { calls, deps };
}

test('summarizer：contentChars 只数 model-visible 正文与工具参数', () => {
  assert.equal(contentChars([{ type: 'text', text: 'abcd' }, { type: 'tool-call', name: 'x', arguments: '{"a":1}' }]), 11);
  assert.equal(contentChars('plain'), 5);
  assert.equal(contentChars(undefined), 0);
});

test('summarizer：formatMessage 保留角色与工具语义', () => {
  assert.equal(formatMessage(textMessage('user', 'hi')), '[user]\nhi');
  assert.match(
    formatMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'thinking' }, { type: 'tool-call', name: 'pwsh', arguments: '{"command":"ls"}' }],
    }),
    /\[assistant\][\s\S]*thinking[\s\S]*\[tool-call pwsh\][\s\S]*"command":"ls"/,
  );
  assert.equal(formatMessage({ role: 'tool', content: [{ type: 'text', text: 'ok' }] }), '[tool result]\nok');
  assert.equal(formatMessage(textMessage('user', '   ')), '');
  assert.equal(formatMessage({ role: 'assistant', content: [{ type: 'image', ref: 'x' }] }), '[assistant]\n[image omitted]');
});

test('summarizer：formatTranscript 跳过空消息并统计字符', () => {
  const transcript = formatTranscript([
    textMessage('user', 'aaa'),
    textMessage('assistant', '   '),
    textMessage('assistant', 'bbb'),
  ]);
  assert.equal(transcript.lines.length, 2);
  assert.equal(transcript.chars, '[user]\naaa'.length + '[assistant]\nbbb'.length);
});

test('summarizer：truncateText 保留头尾并标注截断量', () => {
  const text = 'a'.repeat(500) + 'b'.repeat(500);
  const truncated = truncateText(text, 200);
  assert.ok(truncated.length <= 260);
  assert.match(truncated, /truncated for summarization/);
  assert.equal(truncateText('short', 100), 'short');
  assert.equal(truncateText('#'.repeat(100), 100), '#'.repeat(100));
});

test('summarizer：splitText 对半切且两半都非空', () => {
  const [head, tail] = splitText('line1\nline2\nline3\nline4');
  assert.notEqual(head, '');
  assert.notEqual(tail, '');
  assert.ok(head.length >= 5);
  assert.equal(`${head}\n${tail}`.replaceAll('\n', ''), 'line1line2line3line4');
  assert.deepEqual(splitText('x'), ['x', '']);
});

test('summarizer：planSegments 按字符预算装段，超长单行先截断', () => {
  const lines = ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(1200)];
  const segments = planSegments(lines, 400);
  assert.equal(segments.length, 3);
  for (const segment of segments) assert.ok(segment.length <= 460, `segment ${segment.length}`);
  // 1200 字符的单行被截断到 ~400，而不是独占一个 1200 字符的段。
  assert.match(segments[2], /truncated for summarization/);
});

test('summarizer：segmentPrompt 带序号、指令与稳定片段', () => {
  const prompt = segmentPrompt('body', { index: 2, total: 5 });
  assert.match(prompt, /condensing one segment/);
  assert.match(prompt, /index="2" of="5"/);
  assert.match(prompt, /<segment index="2" of="5">\nbody\n<\/segment>/);
  assert.match(segmentPrompt('body', { index: 1, total: 2, truncated: true }), /truncated to fit the window/);
});

test('summarizer：estimateMessagesTokens / estimateToolsTokens / estimateSummaryInputTokens', () => {
  const messages = [textMessage('user', 'a'.repeat(40)), textMessage('assistant', 'b'.repeat(40))];
  // 无注入估算器时退回字符启发式（40+8)/4 = 12 每条约。
  assert.equal(estimateMessagesTokens(messages), 24);
  // 注入估算器优先。
  assert.equal(estimateMessagesTokens(messages, () => 7), 14);
  // 估算器抛错时退回启发式。
  assert.equal(estimateMessagesTokens(messages, () => { throw new Error('boom'); }), 24);
  assert.equal(estimateToolsTokens(undefined), 0);
  assert.equal(estimateToolsTokens([{ name: 'x' }]), Math.ceil(JSON.stringify([{ name: 'x' }]).length / 4));
  assert.equal(
    estimateSummaryInputTokens({ messages, tools: [{ name: 'x' }] }),
    24 + Math.ceil(JSON.stringify([{ name: 'x' }]).length / 4) + DEFAULT_INSTRUCTION_RESERVE_TOKENS,
  );
});

test('summarizer：resolveChunkBudget 窗口太小/缺窗口时返回 undefined', () => {
  assert.equal(resolveChunkBudget({}), undefined);
  assert.equal(resolveChunkBudget({ contextWindow: 0 }), undefined);
  assert.equal(resolveChunkBudget({ contextWindow: 4_000, summaryMaxTokens: 1_000 }), undefined);
});

test('summarizer：resolveChunkBudget 按窗口扣预留与工具后取一半', () => {
  const budget = resolveChunkBudget({ contextWindow: 100_000, summaryMaxTokens: 10_000, toolsTokens: 5_000 });
  assert.ok(budget !== undefined);
  const expectedAvailable = 100_000 - 10_000 - 5_000 - DEFAULT_INSTRUCTION_RESERVE_TOKENS;
  assert.equal(budget.available, expectedAvailable);
  assert.equal(budget.segmentTokens, Math.floor(expectedAvailable * 0.5));
  assert.equal(budget.mapMaxTokens > 0, true);
  assert.equal(budget.maxSplitDepth > 0, true);
});

test('summarizer：单段（预算内）仍走一次 map + 一次官方总摘要，并去掉 llmStreamCall 标记', async () => {
  const { calls, deps } = makeHarness();
  const input = { messages: [textMessage('system', 'S'.repeat(40)), textMessage('user', 'u'.repeat(120))] };
  const result = await chunkedSummarize({ input, agent: {}, signal: undefined, budget: makeBudget(), deps });
  assert.equal(calls.map.length, 1);
  assert.equal(calls.synthesize.length, 1);
  const synthesized = calls.synthesize[0];
  assert.equal(synthesized.messages[0].role, 'system');
  assert.match(synthesized.messages[1].content[0].text, /consolidated summaries/);
  assert.match(synthesized.messages[1].content[0].text, /part-1/);
  assert.equal('llmStreamCall' in result, false);
  assert.deepEqual(result.summary, [{ type: 'text', text: 'final summary' }]);
});

test('summarizer：多段时逐段摘要、按顺序汇总、只做一次总摘要', async () => {
  const { calls, deps } = makeHarness();
  const messages = [textMessage('system', 'S'.repeat(40))];
  for (let index = 0; index < 5; index += 1) messages.push(textMessage('user', `m${index}-` + 'x'.repeat(300)));
  const result = await chunkedSummarize({
    input: { messages },
    agent: {},
    signal: undefined,
    budget: makeBudget(),
    deps,
  });
  assert.equal(calls.map.length, 5);
  assert.equal(calls.synthesize.length, 1);
  const body = calls.synthesize[0].messages[1].content[0].text;
  for (let index = 1; index <= 5; index += 1) assert.match(body, new RegExp(`part-${index}`));
  assert.equal('llmStreamCall' in result, false);
});

test('summarizer：段内再次超限 → 二分重试并合并两半摘要', async () => {
  const { calls, deps } = makeHarness({
    // 段正文里 X 超过 300 个就抛超限（模拟提供方再次 400）。
    mapSegment: async (prompt, meta) => {
      calls.map.push({ prompt, meta });
      const count = (prompt.match(/X/g) ?? []).length;
      if (count > 300) {
        const error = new Error('maximum context length is 1048576 tokens, but the prompt contains 1049641 input tokens');
        error.code = 'CONTEXT_WINDOW_EXCEEDED';
        throw error;
      }
      return { text: `part-${calls.map.length}` };
    },
    isOverflow: isOverflowFailure,
  });
  const input = { messages: [textMessage('system', 'S'.repeat(40)), textMessage('user', 'X'.repeat(900))] };
  const result = await chunkedSummarize({ input, agent: {}, signal: undefined, budget: makeBudget(), deps });
  assert.ok(calls.map.length >= 3, `expected split retries, got ${calls.map.length}`);
  const body = calls.synthesize[0].messages[1].content[0].text;
  assert.match(body, /part-2/);
  assert.match(body, /part-3/);
  assert.equal('llmStreamCall' in result, false);
});

test('summarizer：段内一直超限且到深度上限 → 截断重试后失败（绝不写半截）', async () => {
  const { calls, deps } = makeHarness({
    mapSegment: async (prompt, meta) => {
      calls.map.push({ prompt, meta });
      const error = new Error('prompt is too long');
      error.code = 'CONTEXT_WINDOW_EXCEEDED';
      throw error;
    },
    isOverflow: isOverflowFailure,
  });
  const input = { messages: [textMessage('user', 'x'.repeat(900))] };
  await assert.rejects(
    () => chunkedSummarize({ input, agent: {}, signal: undefined, budget: makeBudget({ maxSplitDepth: 1 }), deps }),
    /prompt is too long/,
  );
  assert.equal(calls.synthesize.length, 0);
});

test('summarizer：模型调用次数超上限 → 直接失败', async () => {
  const { calls, deps } = makeHarness({
    mapSegment: async (prompt, meta) => {
      calls.map.push({ prompt, meta });
      const error = new Error('prompt is too long');
      error.code = 'CONTEXT_WINDOW_EXCEEDED';
      throw error;
    },
    isOverflow: isOverflowFailure,
  });
  await assert.rejects(
    () =>
      chunkedSummarize({
        input: { messages: [textMessage('user', 'x'.repeat(900))] },
        agent: {},
        signal: undefined,
        budget: makeBudget({ maxSplitDepth: 0, maxMapCalls: 2 }),
        deps,
      }),
    /exceeded 2 model calls|prompt is too long/,
  );
  assert.equal(calls.map.length, 2);
});

test('summarizer：非超限错误原样抛出（认证/配额不会被分块掩盖）', async () => {
  const { deps } = makeHarness({
    mapSegment: async () => {
      const error = new Error('401 Unauthorized');
      error.code = 'AUTH';
      throw error;
    },
    isOverflow: isOverflowFailure,
  });
  await assert.rejects(
    () => chunkedSummarize({ input: { messages: [textMessage('user', 'hello')] }, agent: {}, signal: undefined, budget: makeBudget(), deps }),
    /401 Unauthorized/,
  );
});

test('summarizer：总摘要本身超限时优先去掉 system 再重试', async () => {
  const { calls, deps } = makeHarness({
    synthesize: async (input) => {
      calls.synthesize.push(input);
      if (input.messages[0]?.role === 'system') {
        const error = new Error("this model's maximum context length is 1048576 tokens");
        error.code = 'CONTEXT_WINDOW_EXCEEDED';
        throw error;
      }
      return {
        summary: [{ type: 'text', text: 'final summary' }],
        rawOutput: [{ type: 'text', text: 'final summary' }],
        provider: 'test',
        model: 'test-model',
        maxTokens: 64,
        llmStreamCall: true,
      };
    },
    isOverflow: isOverflowFailure,
  });
  const result = await chunkedSummarize({
    input: { messages: [textMessage('system', 'S'.repeat(40)), textMessage('user', 'x'.repeat(120))] },
    agent: {},
    signal: undefined,
    budget: makeBudget(),
    deps,
  });
  assert.equal(calls.synthesize.length, 2);
  assert.equal(calls.synthesize[0].messages[0].role, 'system');
  assert.equal(calls.synthesize[1].messages[0].role, 'user');
  assert.equal('llmStreamCall' in result, false);
});

test('summarizer：取消信号在进入时立刻生效', async () => {
  const { deps } = makeHarness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      chunkedSummarize({
        input: { messages: [textMessage('user', 'hello')] },
        agent: {},
        signal: controller.signal,
        budget: makeBudget(),
        deps,
      }),
    (error) => error.code === 'ABORTED',
  );
});

test('summarizer：真实事故规模（1M 窗口 / 2,008,140 字符正文）切 2 段即可', () => {
  // 取自 session-8ec2b056 失败现场：surface 1,401 节点 / 2,106,389 字符，其中
  // system 头 98,249 字符；167 个工具 schema 约 34K tokens；compaction-basic 默认 maxTokens 65,536。
  const budget = resolveChunkBudget({
    contextWindow: 1_048_576,
    summaryMaxTokens: 65_536,
    toolsTokens: 34_000,
  });
  assert.ok(budget !== undefined);
  // 用「多行」模拟 374 条 user + 568 条 assistant + 457 条工具结果的 transcript。
  const lines = [];
  const lineCount = 1_399;
  const perLine = Math.ceil(2_008_140 / lineCount);
  for (let index = 0; index < lineCount; index += 1) lines.push('x'.repeat(perLine));
  const segments = planSegments(lines, budget.segmentTokens * 4);
  assert.equal(segments.length, 2);
  // 每段请求（段文本 + 8K 输出 + 指令）都落在 1M 窗口内。
  for (const segment of segments) {
    const estimated = Math.ceil(segment.length / 4) + budget.mapMaxTokens + DEFAULT_INSTRUCTION_RESERVE_TOKENS;
    assert.ok(estimated < 1_048_576, `segment estimate ${estimated} exceeds the window`);
  }
});

test('summarizer：段摘要放得下时跳过 reduce；放不下时才逐级合并', async () => {
  // 段摘要很短：5 段直接拼给总摘要，不多花一次调用。
  const small = makeHarness();
  const fewMessages = [];
  for (let index = 0; index < 5; index += 1) fewMessages.push(textMessage('user', `m${index}-` + 'y'.repeat(300)));
  await chunkedSummarize({
    input: { messages: fewMessages },
    agent: {},
    signal: undefined,
    budget: makeBudget(),
    deps: small.deps,
  });
  assert.equal(small.calls.map.length, 5);
  assert.equal(small.calls.synthesize.length, 1);

  // 段摘要很长：必须 reduce（否则总摘要请求自己就超预算）。
  const large = makeHarness({
    mapSegment: async (_prompt, meta) => {
      large.calls.map.push({ meta });
      return { text: 'z'.repeat(900) };
    },
  });
  const manyMessages = [];
  for (let index = 0; index < 6; index += 1) manyMessages.push(textMessage('user', `m${index}-` + 'y'.repeat(300)));
  await chunkedSummarize({
    input: { messages: manyMessages },
    agent: {},
    signal: undefined,
    budget: makeBudget({ maxMapCalls: 60 }),
    deps: large.deps,
  });
  assert.ok(large.calls.map.length > 6, `expected reduce calls, got ${large.calls.map.length}`);
  assert.equal(large.calls.synthesize.length, 1);
});
