/**
 * 「侧边提问」的询问提示词（纯函数，可离线单测）。
 *
 * 侧边会话**不继承**原会话的上下文：它是一个普通的新会话，只是被告诉「参考会话 id」，
 * 需要上文时用会话查询工具按 id 去查。提示词里因此要写清三件事：
 *
 * 1. 角色：只读的临时问答助手；
 * 2. 参考会话：会话 id（可选标题）与可用的查询工具名；
 * 3. 约束：只读（不写文件、不跑改动文件的命令），回答简短。
 *
 * 提示词由 Host 生成、浏览器半预填进侧边会话的输入框（不自动发送），用户在其后补上
 * 自己的问题。这样「询问提示词」是可见、可改的，用户知道这次问答能查哪个会话。
 *
 * 语言跟随浏览器半传来的 locale：`zh*` 用中文，其余用英文。
 *
 * @module dsh-session-enhance/lib/sideask/prompt
 */

/** 提示词里列出的会话查询工具（由本插件的工具与随附会话查询工具提供）。 */
export const SIDEASK_SESSION_TOOLS = ['session_overview', 'session_grep', 'session_read', 'session_lookup'];

/** 各语言的提示词文案。 */
export const SIDEASK_PROMPT_DICTS = {
  zh: {
    role: '你是一个「侧边提问」临时助手，只读。',
    reference: (sessionId, title) => `参考会话：${sessionId}${title}`,
    query: (tools) => `需要了解上文时，用这些工具按会话 id 查询它：${tools}。不要假设自己已经读过这个会话。`,
    readonly: '约束：只读——不要写文件，也不要执行会改动文件的命令；回答直接、简短。',
    quoteIntro: '用户选中的原文（来自该会话）：',
    question: '我的问题：',
  },
  en: {
    role: 'You are a temporary "side ask" assistant. This session is read-only.',
    reference: (sessionId, title) => `Referenced session: ${sessionId}${title}`,
    query: (tools) => `When you need context, query that session by its id with these tools: ${tools}. Do not assume you have already read it.`,
    readonly: 'Constraints: read-only — do not write files or run commands that change files. Answer directly and briefly.',
    quoteIntro: 'Text the user selected (from that session):',
    question: 'My question:',
  },
};

/**
 * 选一份提示词文案。
 *
 * @param {unknown} locale - 浏览器 locale id（如 `zh-CN` / `en`）。
 * @returns {{ role: string, reference: Function, query: Function, readonly: string, quoteIntro: string, question: string }} 文案。
 */
export function sideAskPromptDict(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('zh')
    ? SIDEASK_PROMPT_DICTS.zh
    : SIDEASK_PROMPT_DICTS.en;
}

/**
 * 把用户选中的文字转成 Markdown 引用块。
 *
 * @param {unknown} quote - 选中文字。
 * @returns {string} 引用块；空白输入返回空串。
 */
export function formatSideAskQuote(quote) {
  const text = String(quote ?? '').replace(/\r\n?/gu, '\n').trim();
  if (text === '') return '';
  return text
    .split('\n')
    .map(line => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * 生成侧边提问的询问提示词。
 *
 * @param {object} request - 生成参数。
 * @param {string} request.parentSessionId - 被查询的原会话 id。
 * @param {string} [request.parentTitle] - 原会话标题（可选，仅用于人类可读）。
 * @param {string} [request.quote] - 用户选中的原文（可选）。
 * @param {string} [request.locale] - 浏览器 locale id。
 * @returns {string} 预填进侧边会话输入框的提示词。
 */
export function buildAskPrompt({ parentSessionId, parentTitle, quote, locale }) {
  const dict = sideAskPromptDict(locale);
  const title = typeof parentTitle === 'string' && parentTitle.trim() !== ''
    ? ` (${parentTitle.trim()})`
    : '';
  const parts = [
    dict.role,
    '',
    dict.reference(parentSessionId, title),
    dict.query(SIDEASK_SESSION_TOOLS.join(' / ')),
    dict.readonly,
  ];
  const quoted = formatSideAskQuote(quote);
  if (quoted !== '') parts.push('', dict.quoteIntro, quoted);
  parts.push('', dict.question);
  return parts.join('\n');
}
