/**
 * 超限识别的离线测试。
 *
 * 用例里的每一段英文错误文案都来自真实会话日志（`session-8ec2b056` /
 * `session-3b342fc5`），不是编造的措辞——这个模块存在的理由就是它们被记成了
 * 不同 code，只认 `CONTEXT_WINDOW_EXCEEDED` 会漏判。
 *
 * @module dsh-session-enhance/test/overflow
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  describeFailure,
  failureFacts,
  isOverflowDetail,
  isOverflowFailure,
} from '../lib/compact/overflow.mjs';

test('overflow：真实日志里的四种超限文案都识别为超限', () => {
  const details = [
    // 2026-11-27 turn 440（sub2api 网关包装）
    "400 {\"error\":{\"message\":\"Upstream request failed: [invalid_request_error] worker: this model's maximum context length is 1048576 tokens, but the prompt contains 1049641 input tokens (request_id: gw-bfb383e50ed8-2105f2)\",\"type\":\"invalid_request_error\"},\"type\":\"error\"}",
    // 2026-11-23 turn 266（同一网关、另一种措辞 → 被记成 INVALID_REQUEST）
    '400 {"error":{"message":"Upstream request failed: [invalid_request_error] Input too long: model limit 1048576 tokens, requested 1052445 tokens trace_id: b4a8082ad66d0546bf4e39606195d0ae","type":"invalid_request_error"},"type":"error"}',
    // 2026-11-09 Boardmate（Anthropic 官方措辞）
    "This model's maximum context length is 1048576 tokens. However, you requested 1286482 tokens (1030482 in the messages, 256000 in the completion).",
    // 2026-11-09 Boardmate（另一提供方措辞 → INVALID_REQUEST）
    "The input is longer than the model's context length",
  ];
  for (const detail of details) {
    assert.equal(isOverflowDetail(detail), true, detail);
  }
});

test('overflow：常见提供方措辞（OpenAI/Anthropic/网关）都覆盖', () => {
  const details = [
    'prompt is too long: 213462 tokens > 200000 maximum',
    'Your input exceeds the context window of this model',
    "Requested token count exceeds the model's maximum context length of 131072 tokens",
    'Input length (265330) exceeds the model\'s maximum context length (262144).',
    'This model\'s maximum prompt length is 131072 but the request contains 537812 tokens',
    'context_length_exceeded',
    '400 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
    'the request exceeds the available context size, try increasing it',
    'Prompt has 90000 tokens, but the configured context size is 8192 tokens',
  ];
  for (const detail of details) {
    assert.equal(isOverflowDetail(detail), true, detail);
  }
});

test('overflow：限流/配额/认证文案不能被当成超限', () => {
  const details = [
    'ThrottlingException: Too many tokens, please wait before trying again.',
    'rate limit exceeded, please retry later',
    'Too many requests',
    'insufficient quota for this account',
    '429 Too Many Requests',
    '401 Unauthorized: invalid api key',
    'invalid_request_error: tools.0.input_schema is invalid',
  ];
  for (const detail of details) {
    assert.equal(isOverflowDetail(detail), false, detail);
  }
});

test('overflow：规范 code 直接认定，与文案无关', () => {
  assert.equal(isOverflowFailure({ code: CONTEXT_WINDOW_EXCEEDED_CODE }), true);
  assert.equal(isOverflowFailure({ code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'anything' }), true);
});

test('overflow：非规范 code + 超限文案仍然认定（真实日志的 INVALID_REQUEST 场景）', () => {
  const failure = {
    code: 'INVALID_REQUEST',
    status: 400,
    message:
      '400 {"error":{"message":"Upstream request failed: [invalid_request_error] Input too long: model limit 1048576 tokens, requested 1053000 tokens trace_id: 76a0814c8b3d6ad06ef5927dbecd94cd","type":"invalid_request_error"},"type":"error"}',
  };
  assert.equal(isOverflowFailure(failure), true);
  assert.equal(isOverflowFailure({ code: 'HTTP_400', message: 'maximum context length is 1048576 tokens' }), true);
  assert.equal(isOverflowFailure({ code: 'UNKNOWN', message: "this model's maximum context length is 1048576 tokens" }), true);
});

test('overflow：普通失败不认定（认证/配额/工具协议/空响应）', () => {
  assert.equal(isOverflowFailure({ code: 'AUTH', message: '401 Unauthorized' }), false);
  assert.equal(isOverflowFailure({ code: 'RATE_LIMIT', message: 'rate limit' }), false);
  assert.equal(isOverflowFailure({ code: 'INVALID_REQUEST', message: 'arguments is not valid JSON' }), false);
  assert.equal(isOverflowFailure({ code: 'EMPTY_RESPONSE', message: 'model returned no content' }), false);
  assert.equal(isOverflowFailure(undefined), false);
  assert.equal(isOverflowFailure(null), false);
  assert.equal(isOverflowFailure('some string'), false);
});

test('overflow：沿 cause 链与非 Error 抛出值也能识别', () => {
  const inner = new Error("maximum context length is 1048576 tokens, but the prompt contains 1049641 input tokens");
  inner.code = 'CONTEXT_WINDOW_EXCEEDED';
  const wrapper = new Error('fetch failed', { cause: inner });
  assert.equal(isOverflowFailure(wrapper), true);
  assert.equal(isOverflowFailure({ message: 'wrapper', cause: inner }), true);
  // 非 Error 抛出值：message 直读。
  assert.equal(isOverflowFailure({ message: 'prompt is too long' }), true);
});

test('overflow：LlmError 的 failure 自有字段优先（provider 事实在 error.failure 上）', () => {
  const error = new Error('LlmError: request failed');
  error.failure = { code: 'INVALID_REQUEST', message: 'Input too long: model limit 1048576 tokens, requested 1052445 tokens' };
  assert.equal(isOverflowFailure(error), true);
  const facts = failureFacts(error);
  assert.equal(facts.code, 'INVALID_REQUEST');
  assert.match(facts.message, /Input too long/);
});

test('overflow：failureFacts 记录 code/message/status，describeFailure 截断长文案', () => {
  const facts = failureFacts({
    code: 'CONTEXT_WINDOW_EXCEEDED',
    status: 400,
    message: 'x'.repeat(1000),
  });
  assert.equal(facts.code, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(facts.status, 400);
  const described = describeFailure({ code: 'INVALID_REQUEST', status: 400, message: `Input too long ${'y'.repeat(500)}` });
  assert.equal(described.overflow, true);
  assert.equal(described.code, 'INVALID_REQUEST');
  assert.equal(described.status, 400);
  assert.ok(described.message.length <= 301);
  assert.match(described.message, /Input too long/);
});
