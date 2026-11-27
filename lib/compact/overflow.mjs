/**
 * 「上下文超限」失败的识别。
 *
 * ## 为什么需要它
 *
 * DSH 的适配器只对**部分**上游文案给出规范错误码 `CONTEXT_WINDOW_EXCEEDED`。
 * 真实日志里同一类「请求比模型窗口还大」的失败至少出现过四种上游文案，
 * 而被记成了两种 code：
 *
 * | 上游文案 | 记录到的 code |
 * |---|---|
 * | `this model's maximum context length is N tokens, but the prompt contains M input tokens` | `CONTEXT_WINDOW_EXCEEDED` |
 * | `This model's maximum context length is N tokens. However, you requested M tokens` | `CONTEXT_WINDOW_EXCEEDED` |
 * | `Input too long: model limit N tokens, requested M tokens` | **`INVALID_REQUEST`** |
 * | `The input is longer than the model's context length` | **`INVALID_REQUEST`** |
 *
 * 只按 `code === 'CONTEXT_WINDOW_EXCEEDED'` 做溢出恢复，会漏掉后两类——而它们
 * 与第一类完全同义：重发同一个请求永远不会成功，必须先压缩再重试。
 *
 * ## 判据
 *
 * 1. `code === 'CONTEXT_WINDOW_EXCEEDED'` → 直接认定；
 * 2. 否则看**文案**：命中「上下文/窗口/输入超长」的明确措辞 → 认定；
 * 3. 明确的限流/配额文案 → 排除（不能把 429/余额不足当成溢出）。
 *
 * 第 2 条不要求 `status === 400`：优先相信文案本身，避免某个提供方把 413/`HTTP_400`
 * 包了别的状态码时漏判；文案措辞都足够具体（含 context length / 窗口 token 数），
 * 误判风险集中在本文件顶部的模式表里，测试会逐条钉住。
 *
 * @module dsh-session-enhance/lib/compact/overflow
 */

/**
 * 明确表示「请求/输入超出模型上下文窗口」的文案。
 *
 * 覆盖面刻意与官方两个分类器对齐（`@deepseek-ai/dsh-llm` 的
 * `isContextWindowExceededError` 与 pi-ai 的 `OVERFLOW_PATTERNS`），
 * 再补上本工作区真实出现过的网关措辞（`Input too long: model limit …`、
 * `prompt contains … input tokens`）。
 */
export const OVERFLOW_PATTERNS = Object.freeze([
  // "context length exceeded" / "context_window_exceeded" / "context-length-limit exceeded"
  /context[\s_-](?:length|window)[\s_-]?(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]?exceeded)/i,
  // "maximum context length" / "max allowed context window"
  /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i,
  // "this model's maximum context length is 1048576 tokens"
  /\bmaximum\s+context\s+length\s+is\s+[\d,]+/i,
  // "This model's maximum prompt length is 131072 but the request contains 537812 tokens"（xAI）
  /\bmaximum\s+prompt\s+length\s+is\s+[\d,]+/i,
  // "the prompt contains 1049641 input tokens"
  /\bprompt\s+contains\s+[\d,]+\s+input\s+tokens\b/i,
  // "Input too long: model limit 1048576 tokens, requested 1052445 tokens"
  /\binput\s+too\s+long\b/i,
  // "The input is longer than the model's context length"
  /\binput\s+is\s+longer\s+than\s+(?:the\s+)?model'?s\s+context\s+length\b/i,
  // "prompt is too long"
  /\bprompt\s+(?:is\s+)?too\s+long\b/i,
  // "request/prompt/input too large for the model's context"
  /\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?(?:model(?:'s)?\s+)?context\b/i,
  // "input/prompt exceeds the model's context length/window"
  /\b(?:input|prompt|request|messages?)\b.{0,40}\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b/i,
  // provider-explicit codes
  /\brequest_too_large\b/i,
  /\bcontext_length_exceeded\b/i,
  /\bmodel_context_window_exceeded\b/i,
  // Anthropic 413 body wording
  /\brequest\s+exceeds\s+the\s+maximum\s+size\b/i,
  // "Prompt has 90000 tokens, but the configured context size is 8192 tokens"（DS4）
  /\bprompt\s+has\s+[\d,]+\s+tokens?,\s+but\s+the\s+configured\s+context\s+size\s+is\s+[\d,]+\s+tokens?/i,
]);

/**
 * 与上下文超限无关的文案（限流、配额、认证）。
 *
 * 命中这里时**绝不**按溢出处理：例如 Bedrock 的
 * `ThrottlingException: Too many tokens, please wait before trying again.`
 * 会命中 pi-ai 的 `too many tokens` 兜底模式，但它属于限流。
 */
const NON_OVERFLOW_DETAIL =
  /rate[\s_-]?limit|too\s+many\s+requests|throttl|insufficient[\s_-]+(?:quota|balance|credits?)|exceed[^\n]{0,20}quota/i;

/** 规范错误码（与 `@deepseek-ai/dsh-llm` 的常量同值）。 */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED';

/**
 * 安全读取一个字符串属性（getter 抛错也不能把识别流程带崩）。
 *
 * @param {unknown} value - 宿主对象。
 * @param {string} key - 属性名。
 * @returns {string | undefined} 字符串值。
 */
function stringField(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const field = /** @type {Record<string, unknown>} */ (value)[key];
    return typeof field === 'string' && field !== '' ? field : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 安全读取一个数字属性。
 *
 * @param {unknown} value - 宿主对象。
 * @param {string} key - 属性名。
 * @returns {number | undefined} 数字值。
 */
function numberField(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const field = /** @type {Record<string, unknown>} */ (value)[key];
    return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把「失败对象 / Error / 任意抛出值」归一成 `{ code, message, status }`。
 *
 * 会沿 `cause` 链最多走 4 层，并把 `failure`（`LlmError` 的自有字段）一起收集：
 * 适配器既可能抛 `LlmError`（`code` 在顶层），也可能抛包装错误（真实原因在
 * `cause` 里），两种都要能被识别。
 *
 * @param {unknown} value - 失败对象、Error 或抛出值。
 * @returns {{ code?: string, message?: string, status?: number }} 归一结果。
 */
export function failureFacts(value) {
  /** @type {{ code?: string, message?: string, status?: number }} */
  const facts = {};
  const seen = new Set();
  let current = value;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || current === undefined || seen.has(current)) break;
    if (typeof current !== 'object') {
      if (facts.message === undefined) facts.message = safeString(current);
      break;
    }
    seen.add(current);
    // LlmError 把 provider 事实放在自有 `failure` 上：优先读它。
    let carrier = current;
    try {
      const nested = /** @type {Record<string, unknown>} */ (current).failure;
      if (nested !== null && typeof nested === 'object') carrier = nested;
    } catch {
      // 读取失败就用当前对象。
    }
    if (facts.code === undefined) facts.code = stringField(carrier, 'code');
    if (facts.message === undefined) facts.message = stringField(carrier, 'message');
    if (facts.status === undefined) facts.status = numberField(carrier, 'status');
    try {
      current = /** @type {Record<string, unknown>} */ (current).cause;
    } catch {
      break;
    }
  }
  return facts;
}

/**
 * 把任意值渲染成短文本（日志用），任何异常都不能冒泡。
 *
 * @param {unknown} value - 任意值。
 * @returns {string} 文本。
 */
function safeString(value) {
  try {
    return String(value);
  } catch {
    return '<unrenderable>';
  }
}

/**
 * 文案本身是否在描述「上下文超限」。
 *
 * @param {unknown} detail - 上游错误文案。
 * @returns {boolean} 是超限文案则 true。
 */
export function isOverflowDetail(detail) {
  if (typeof detail !== 'string' || detail === '') return false;
  if (NON_OVERFLOW_DETAIL.test(detail)) return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(detail));
}

/**
 * 判断一个失败是否属于「上下文超限」（可恢复：压缩后重试）。
 *
 * 接受 `agent/request-error` 的 `failure`（`{ code, message, status }`）、
 * `LlmError`、普通 `Error`、或适配器抛出的包装错误。
 *
 * @param {unknown} value - 失败对象 / Error / 抛出值。
 * @returns {boolean} 属于上下文超限则 true。
 */
export function isOverflowFailure(value) {
  const { code, message } = failureFacts(value);
  if (code === CONTEXT_WINDOW_EXCEEDED_CODE) return true;
  return isOverflowDetail(message);
}

/**
 * 生成一条可读的失败描述（日志/诊断用，截断到 300 字符）。
 *
 * @param {unknown} value - 失败对象 / Error / 抛出值。
 * @returns {{ code: string | null, status: number | null, message: string, overflow: boolean }} 描述。
 */
export function describeFailure(value) {
  const { code, message, status } = failureFacts(value);
  const text = message ?? safeString(value);
  return {
    code: code ?? null,
    status: status ?? null,
    message: text.length > 300 ? `${text.slice(0, 300)}…` : text,
    overflow: isOverflowFailure(value),
  };
}
