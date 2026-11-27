/**
 * 分块摘要（map-reduce summary）：压缩请求自身也超窗时的兜底。
 *
 * ## 它解决什么
 *
 * 官方 `compaction-basic` 的摘要请求是「把被压缩范围**整段重放**一遍 + 压缩指令」，
 * 它刻意复用同一前缀以命中提供方缓存。但当会话本身已经贴着/超过窗口时，这个请求
 * **按构造必然再次超窗**——真实事故（问题见 `lib/compact/host.mjs` 头注释）：
 *
 * ```text
 * 400 ... this model's maximum context length is 1048576 tokens,
 *         but the prompt contains 1048988 input tokens ...
 * ```
 *
 * 此时「先剪枝」也救不了：工具结果通常早已被剪过（本工作区实测 457 条工具结果
 * 全部低于 8K 剪枝阈值，剪枝可释放 0 字符），剩余的大头是 assistant/user 对话文本。
 *
 * ## 做法
 *
 * 单次全量摘要失败（或预算预判它一定失败）时，把被压缩的消息转成纯文本 transcript，
 * 按预算切段 → 逐段摘要（小 `maxTokens`、无工具 schema、无 toolHistory）→ 汇总，
 * 最后把「系统提示 + 段摘要」交给**官方原 summarizer** 做一次结构化总摘要，
 * 这样落盘的 checkpoint 仍是官方格式与旁注惯例，整个压缩仍是**一个事务**。
 *
 * 为什么不按「消息」切段：压缩输入里 assistant 的 tool-call 与后续 tool result 必须
 * 配对，按消息切会把一对切开、被提供方拒绝；转成文本 transcript 后不存在协议配对问题。
 *
 * ## 「再遇到同类错误」怎么办
 *
 * 估算（4 字符/token）在中文/JSON 上并不精确，所以段也可能超窗：
 *
 * 1. 段内再超限 → 把该段文本二分重试（深度上限，见 `DEFAULT_MAX_SPLIT_DEPTH`）；
 * 2. 单行（单条消息）就超预算 → 头尾截断（只影响本次摘要输入，不改会话）；
 * 3. 总调用次数超上限 → 抛错失败（**绝不**写半截摘要），与今天的行为一致。
 *
 * @module dsh-session-enhance/lib/compact/summarizer
 */

/** 每段占「可用输入预算」的比例（留一半余量给估算误差与输出预留）。 */
export const DEFAULT_SEGMENT_RATIO = 0.5;

/** 单段 token 下限：低于它分块没有意义。 */
export const DEFAULT_MIN_SEGMENT_TOKENS = 2_048;

/** 单段 token 上限：单次请求过大时提供方延迟/计费都难看。 */
export const DEFAULT_MAX_SEGMENT_TOKENS = 400_000;

/** 每段摘要的输出上限（推理模型的 reasoning 也计入该上限，故不能太小）。 */
export const DEFAULT_MAP_MAX_TOKENS = 8_192;

/** 压缩指令本身预留的 token（官方指令约 1.2K tokens，留 2K 余量）。 */
export const DEFAULT_INSTRUCTION_RESERVE_TOKENS = 2_048;

/** 最多分成多少段（防止一次压缩变成几十次模型调用）。 */
export const DEFAULT_MAX_SEGMENTS = 32;

/** 一次压缩里 map/reduce 模型调用的总上限（含二分重试）。 */
export const DEFAULT_MAX_MAP_CALLS = 48;

/** 段内二分的最大深度（2^6 = 单段最细切到 1/64）。 */
export const DEFAULT_MAX_SPLIT_DEPTH = 6;

/** 交给「总摘要」的每段摘要字符上限（避免 reduce 阶段自己又过大）。 */
export const MAX_PARTIAL_CHARS = 6_000;

/** 估算字符/token 比（官方 tokenMeter 的定点启发式同值）。 */
const CHARS_PER_TOKEN = 4;

/**
 * 段摘要指令。
 *
 * 第一行里的 `condensing one segment` 是稳定片段：本地 E2E 的 mock provider
 * （`test/e2e/mock-anthropic-server.mjs`）靠它区分「分块请求」与「官方全量压缩请求」。
 */
export const SEGMENT_INSTRUCTION = [
  'You are condensing one segment of a longer engineering conversation.',
  'The transcript below is a plain-text rendering of consecutive messages (user, assistant, tool calls, tool results).',
  'Write a terse bullet summary in English preserving: user requests and corrections, decisions and their reasons,',
  'exact file paths, commands, error strings, identifiers, numeric values, and anything still pending.',
  'Do not mention this summarization request or that the conversation was compacted.',
  'Output summary text only; do not call any tool or ask questions.',
].join('\n');

/**
 * 统计一组内容块里 model-visible 的字符数（text / tool-call 参数）。
 *
 * @param {any} content - `Message.content`。
 * @returns {number} 字符数。
 */
export function contentChars(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content.length : 0;
  let chars = 0;
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (typeof block.text === 'string') chars += block.text.length;
    else if (typeof block.arguments === 'string') chars += block.arguments.length;
  }
  return chars;
}

/**
 * 把一条消息渲染成 transcript 的一行（保留角色与工具调用的语义标记）。
 *
 * @param {any} message - 消息（`Message` / 已派生消息）。
 * @returns {string} 一行文本；空消息返回空串。
 */
export function formatMessage(message) {
  if (message === null || typeof message !== 'object') return '';
  const content = Array.isArray(message.content) ? message.content : [];
  const role = typeof message.role === 'string' ? message.role : 'unknown';
  const pieces = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') pieces.push(block.text);
    else if (block.type === 'tool-call' && typeof block.name === 'string') {
      pieces.push(`[tool-call ${block.name}] ${typeof block.arguments === 'string' ? block.arguments : ''}`);
    } else if (block.type === 'image') pieces.push('[image omitted]');
  }
  const text = pieces.join('\n').trim();
  if (text === '') return '';
  const label = role === 'tool' ? 'tool result' : role;
  return `[${label}]\n${text}`;
}

/**
 * 把消息列表转成 transcript 行。
 *
 * @param {readonly any[]} messages - 消息列表（不含 system 头，由调用方剥离）。
 * @returns {{ lines: string[], chars: number }} 行与总字符数。
 */
export function formatTranscript(messages) {
  const lines = [];
  let chars = 0;
  for (const message of messages) {
    const line = formatMessage(message);
    if (line === '') continue;
    lines.push(line);
    chars += line.length;
  }
  return { lines, chars };
}

/**
 * 目标字符数下把行装进若干段（超长单行先截断，避免必然超窗）。
 *
 * @param {string[]} lines - transcript 行。
 * @param {number} maxChars - 单段字符上限。
 * @returns {string[]} 每段文本（保持顺序，段内以换行连接）。
 */
export function planSegments(lines, maxChars) {
  const limit = Math.max(256, Math.floor(maxChars));
  const segments = [];
  let current = [];
  let currentChars = 0;
  const flush = () => {
    if (current.length === 0) return;
    segments.push(current.join('\n\n'));
    current = [];
    currentChars = 0;
  };
  for (const raw of lines) {
    const line = raw.length > limit ? truncateText(raw, limit) : raw;
    const cost = line.length + (current.length === 0 ? 0 : 2);
    if (current.length > 0 && currentChars + cost > limit) flush();
    current.push(line);
    currentChars += cost;
  }
  flush();
  return segments;
}

/**
 * 头尾截断一行/一段文本（保留开头与结尾，中间用标记替换）。
 *
 * @param {string} text - 原文。
 * @param {number} maxChars - 目标字符上限（至少 128）。
 * @returns {string} 截断后的文本。
 */
export function truncateText(text, maxChars) {
  const limit = Math.max(128, Math.floor(maxChars));
  if (typeof text !== 'string' || text.length <= limit) return typeof text === 'string' ? text : '';
  const headChars = Math.max(64, Math.floor(limit * 0.62));
  const tailChars = Math.max(32, Math.floor(limit * 0.28));
  const removed = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n…[${removed} chars truncated for summarization]…\n${text.slice(text.length - tailChars)}`;
}

/**
 * 把一段文本对半切开（优先在换行处切，保证两半都非空）。
 *
 * @param {string} text - 原文。
 * @returns {[string, string]} 左右两半；无法切分时第二项为空串。
 */
export function splitText(text) {
  if (typeof text !== 'string' || text.length < 2) return [text ?? '', ''];
  const middle = Math.floor(text.length / 2);
  let cut = text.lastIndexOf('\n', middle);
  if (cut < Math.floor(text.length * 0.2)) cut = text.indexOf('\n', middle);
  if (cut <= 0 || cut >= text.length - 1) cut = middle;
  const head = text.slice(0, cut).trimEnd();
  const tail = text.slice(cut).trimStart();
  if (head === '' || tail === '') return [text, ''];
  return [head, tail];
}

/**
 * 组装一段的请求文本（指令 + 带序号的 transcript）。
 *
 * @param {string} text - 段文本。
 * @param {{ index?: number, total?: number, truncated?: boolean }} meta - 段元信息。
 * @returns {string} 请求文本。
 */
export function segmentPrompt(text, meta = {}) {
  const index = typeof meta.index === 'number' ? meta.index : 1;
  const total = typeof meta.total === 'number' ? meta.total : 1;
  const note = meta.truncated === true ? ' This part was truncated to fit the window.' : '';
  return `${SEGMENT_INSTRUCTION}\n\n<segment index="${index}" of="${total}">${note}\n${text}\n</segment>`;
}

/**
 * 用注入的逐消息估算器估算消息列表 token（失败时退回字符启发式）。
 *
 * @param {readonly any[]} messages - 消息列表。
 * @param {(message: any) => number} [estimateMessage] - 逐消息估算器（官方 tokenMeter）。
 * @returns {number} token 估算。
 */
export function estimateMessagesTokens(messages, estimateMessage) {
  let total = 0;
  for (const message of messages ?? []) {
    let tokens;
    if (typeof estimateMessage === 'function') {
      try {
        const measured = estimateMessage(message);
        if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0) tokens = measured;
      } catch {
        // 退回字符启发式。
      }
    }
    if (tokens === undefined) {
      const chars = contentChars(message?.content) + 8;
      tokens = Math.ceil(chars / CHARS_PER_TOKEN);
    }
    total += tokens;
  }
  return total;
}

/**
 * 估算工具 schema 的 token（摘要请求会把工具定义一起发出去）。
 *
 * @param {readonly any[] | undefined} tools - 工具 schema 列表。
 * @returns {number} token 估算。
 */
export function estimateToolsTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  try {
    return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

/**
 * 估算一次摘要输入的总 token（消息 + 工具 + 指令）。
 *
 * @param {{ messages: readonly any[], tools?: readonly any[] }} input - 摘要输入。
 * @param {(message: any) => number} [estimateMessage] - 逐消息估算器。
 * @returns {number} token 估算。
 */
export function estimateSummaryInputTokens(input, estimateMessage) {
  return estimateMessagesTokens(input?.messages, estimateMessage)
    + estimateToolsTokens(input?.tools)
    + DEFAULT_INSTRUCTION_RESERVE_TOKENS;
}

/**
 * 由窗口、摘要输出上限与工具体量算出分块预算。
 *
 * @param {{ contextWindow?: unknown, summaryMaxTokens?: unknown, toolsTokens?: unknown }} input - 原始参数。
 * @returns {{ available: number, segmentTokens: number, mapMaxTokens: number, maxSegments: number, maxMapCalls: number, maxSplitDepth: number } | undefined} 预算；不可分块时 undefined。
 */
export function resolveChunkBudget(input = {}) {
  const window = Number(input.contextWindow);
  const summaryMaxTokens = Number(input.summaryMaxTokens);
  const toolsTokens = Number(input.toolsTokens);
  if (!Number.isFinite(window) || window <= 0) return undefined;
  const reserve = Number.isFinite(summaryMaxTokens) && summaryMaxTokens > 0 ? summaryMaxTokens : 0;
  const tools = Number.isFinite(toolsTokens) && toolsTokens > 0 ? toolsTokens : 0;
  const available = Math.floor(window) - reserve - tools - DEFAULT_INSTRUCTION_RESERVE_TOKENS;
  if (available < DEFAULT_MIN_SEGMENT_TOKENS * 2) return undefined;
  const segmentTokens = Math.max(
    DEFAULT_MIN_SEGMENT_TOKENS,
    Math.min(DEFAULT_MAX_SEGMENT_TOKENS, Math.floor(available * DEFAULT_SEGMENT_RATIO)),
  );
  return {
    available,
    segmentTokens,
    mapMaxTokens: DEFAULT_MAP_MAX_TOKENS,
    maxSegments: DEFAULT_MAX_SEGMENTS,
    maxMapCalls: DEFAULT_MAX_MAP_CALLS,
    maxSplitDepth: DEFAULT_MAX_SPLIT_DEPTH,
  };
}

/**
 * 构造一条「由纯文本组成」的 user 消息（不携带任何 id/source，不落库）。
 *
 * @param {string} text - 文本。
 * @returns {{ role: 'user', content: Array<{ type: 'text', text: string }> }} 消息。
 */
function plainUserMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/**
 * 执行一次分块摘要。
 *
 * @param {{
 *   input: { messages: readonly any[], tools?: readonly any[] },
 *   agent: any,
 *   signal?: AbortSignal,
 *   budget: { available: number, segmentTokens: number, mapMaxTokens: number, maxSegments: number, maxMapCalls: number, maxSplitDepth: number },
 *   deps: {
 *     mapSegment: (prompt: string, meta: { index: number, total: number, truncated?: boolean }, signal?: AbortSignal) => Promise<{ text: string }>,
 *     synthesize: (input: { messages: readonly any[], tools?: readonly any[] }, signal?: AbortSignal) => Promise<any>,
 *     isOverflow: (error: unknown) => boolean,
 *     log?: (level: 'debug'|'info'|'warn', message: string) => void,
 *   },
 * }} options - 依赖与输入。
 * @returns {Promise<any>} 官方 `SummaryResult`（去掉 `llmStreamCall` 标记：结果由多次调用合成）。
 */
export async function chunkedSummarize({ input, agent, signal, budget, deps }) {
  const log = typeof deps?.log === 'function' ? deps.log : () => {};
  const isOverflow = typeof deps?.isOverflow === 'function' ? deps.isOverflow : () => false;
  const throwIfAborted = () => {
    if (signal?.aborted === true) throw abortError();
  };
  const counters = { calls: 0 };
  const countCall = () => {
    counters.calls += 1;
    if (counters.calls > budget.maxMapCalls) {
      throw new Error(
        `chunked compaction aborted: exceeded ${budget.maxMapCalls} model calls (${counters.calls})`,
      );
    }
  };

  throwIfAborted();
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const systemMessages = messages.filter((message) => message?.role === 'system');
  const restMessages = messages.filter((message) => message?.role !== 'system');
  const transcript = formatTranscript(restMessages);
  if (transcript.lines.length === 0) {
    // 没有可摘要的正文（只有 system 头）：交给官方摘要，失败就失败。
    log('warn', '[dsh-session-enhance/compact] chunked summary found no non-system messages');
    return deps.synthesize({ messages }, signal);
  }
  let maxChars = Math.max(256, budget.segmentTokens * CHARS_PER_TOKEN);
  let segments = planSegments(transcript.lines, maxChars);
  if (segments.length > budget.maxSegments) {
    maxChars = Math.max(256, Math.ceil(transcript.chars / budget.maxSegments));
    segments = planSegments(transcript.lines, maxChars);
  }
  if (segments.length > budget.maxSegments) {
    throw new Error(
      `chunked compaction aborted: ${segments.length} segments exceed the ${budget.maxSegments}-segment ceiling`,
    );
  }
  log(
    'info',
    `[dsh-session-enhance/compact] chunked summary: ${segments.length} segment(s), `
      + `~${Math.ceil(transcript.chars / CHARS_PER_TOKEN)} tokens, segment≈${Math.ceil(maxChars / CHARS_PER_TOKEN)} tokens, `
      + `available=${budget.available}`,
  );

  /**
   * 摘要一段；段内再超限时二分重试。
   *
   * @param {string} text - 段文本。
   * @param {{ index: number, total: number, truncated?: boolean }} meta - 元信息。
   * @param {number} depth - 二分深度。
   * @returns {Promise<string>} 段摘要文本。
   */
  async function mapWithRecovery(text, meta, depth) {
    throwIfAborted();
    countCall();
    try {
      const result = await deps.mapSegment(segmentPrompt(text, meta), meta, signal);
      return typeof result?.text === 'string' ? result.text : '';
    } catch (error) {
      if (!isOverflow(error)) throw error;
      log(
        'warn',
        `[dsh-session-enhance/compact] segment ${meta.index}/${meta.total} hit context overflow at depth ${depth} `
          + `(${text.length} chars); splitting to fit`,
      );
      if (depth >= budget.maxSplitDepth) {
        const smaller = truncateText(text, Math.max(256, Math.floor(text.length / 2)));
        countCall();
        const retry = await deps.mapSegment(
          segmentPrompt(smaller, { ...meta, truncated: true }),
          { ...meta, truncated: true },
          signal,
        );
        return typeof retry?.text === 'string' ? retry.text : '';
      }
      const [head, tail] = splitText(text);
      if (tail === '') {
        const smaller = truncateText(text, Math.max(256, Math.floor(text.length / 2)));
        countCall();
        const retry = await deps.mapSegment(
          segmentPrompt(smaller, { ...meta, truncated: true }),
          { ...meta, truncated: true },
          signal,
        );
        return typeof retry?.text === 'string' ? retry.text : '';
      }
      const left = await mapWithRecovery(head, meta, depth + 1);
      const right = await mapWithRecovery(tail, meta, depth + 1);
      return `${left}\n\n${right}`;
    }
  }

  /** 段摘要收集（顺序执行，避免并发触发提供方限流）。 */
  const partials = [];
  for (let index = 0; index < segments.length; index += 1) {
    throwIfAborted();
    const text = await mapWithRecovery(segments[index], { index: index + 1, total: segments.length }, 0);
    if (text.trim() === '') {
      throw new Error(`chunked compaction aborted: segment ${index + 1} produced no summary text`);
    }
    partials.push(text.trim());
  }

  /**
   * 把段摘要合并到能一次总摘要为止（段数多、窗口小时可能需要多轮）。
   *
   * @param {string[]} list - 段摘要。
   * @returns {Promise<string>} 合并后的摘要文本。
   */
  async function reducePartials(list) {
    let current = list.map((text) => truncateText(text, MAX_PARTIAL_CHARS));
    let round = 0;
    while (current.length > 1) {
      throwIfAborted();
      round += 1;
      if (round > 12) throw new Error('chunked compaction aborted: reduce rounds exceeded 12');
      const batchChars = Math.max(1_024, Math.floor(maxChars * 0.8));
      /** @type {string[][]} */
      const batches = [];
      let batch = [];
      let batchSize = 0;
      for (const text of current) {
        const cost = text.length + (batch.length === 0 ? 0 : 2);
        if (batch.length > 0 && batchSize + cost > batchChars) {
          batches.push(batch);
          batch = [];
          batchSize = 0;
        }
        batch.push(text);
        batchSize += cost;
      }
      if (batch.length > 0) batches.push(batch);
      if (batches.length === current.length) {
        // 无法合并（每个都单独成批）：强制两两合并，避免死循环。
        batches.length = 0;
        for (let index = 0; index < current.length; index += 2) {
          batches.push(current.slice(index, index + 2));
        }
      }
      const next = [];
      for (let index = 0; index < batches.length; index += 1) {
        const joined = batches[index].join('\n\n');
        if (batches[index].length === 1) {
          next.push(joined);
          continue;
        }
        const text = await mapWithRecovery(
          joined,
          { index: index + 1, total: batches.length },
          0,
        );
        next.push(text.trim() === '' ? joined : text.trim());
      }
      current = next;
    }
    return current[0] ?? '';
  }

  const merged = (() => {
    // 段摘要总字符不多时直接拼给「总摘要」，省掉一次 reduce 调用；只有它自己也放不下
    // 预算时才递归合并（map-reduce 的 reduce 级）。`budget.available` 已经扣过指令预留，
    // 这里不能再加一次，否则小窗口下永远误判「放不下」。
    const systemChars = systemMessages.reduce((sum, message) => sum + contentChars(message?.content) + 8, 0);
    const combinedChars = partials.reduce((sum, text) => sum + text.length + 8, 0);
    const estimatedFinal = Math.ceil((systemChars + combinedChars) / CHARS_PER_TOKEN);
    return estimatedFinal <= budget.available
      ? partials.map((text) => truncateText(text, MAX_PARTIAL_CHARS)).join('\n\n')
      : undefined;
  })();
  const body = merged ?? (await reducePartials(partials));
  const finalText = `Here are the consolidated summaries of the earlier conversation, in order:\n\n${body}`;

  /**
   * 总摘要；若因 system 头过大而超限，依次去掉 system、再截断正文重试。
   *
   * @param {readonly any[]} systemPart - system 消息。
   * @param {string} body - 正文。
   * @param {number} depth - 重试深度。
   * @returns {Promise<any>} 官方 SummaryResult。
   */
  async function synthesizeFinal(systemPart, body, depth) {
    throwIfAborted();
    const messagesToSend = [...systemPart, plainUserMessage(body)];
    try {
      const result = await deps.synthesize({ messages: messagesToSend }, signal);
      if (result !== null && typeof result === 'object') {
        // 结果由多次调用合成，`llmStreamCall: true` 不再成立（官方 seam 支持无标记的 summarizer）。
        const { llmStreamCall: _unmarked, ...rest } = result;
        return rest;
      }
      return result;
    } catch (error) {
      if (!isOverflow(error) || depth >= 2) throw error;
      log('warn', '[dsh-session-enhance/compact] final synthesis hit context overflow; retrying without system/tools');
      if (systemPart.length > 0) return synthesizeFinal([], body, depth + 1);
      return synthesizeFinal([], truncateText(body, Math.max(512, Math.floor(body.length / 2))), depth + 1);
    }
  }

  return synthesizeFinal(systemMessages, finalText, 0);
}

/**
 * 构造一个带 `ABORTED` 码的取消错误（与 LlmError 的码同值）。
 *
 * @returns {Error & { code: string }} 错误。
 */
function abortError() {
  const error = /** @type {Error & { code: string }} */ (new Error('chunked compaction aborted by caller'));
  error.name = 'AbortError';
  error.code = 'ABORTED';
  return error;
}
