/**
 * `dsh-session-enhance` —— 浏览器半：会话标题栏的「分享会话」「复制会话 ID」两个组件。
 *
 * ## 这个 bundle 里有两个组件
 *
 * 1. **会话 ID**：标题栏一键复制 session id，交给 Agent 按 id 查会话、子代理与历史；
 * 2. **会话分享**：标题栏生成只读分享链接（免登录的只读 HTML 页由 Host 半渲染）。
 *
 * 「失败重试」不再由本插件提供：DSH 0.2.2 起官方已内置（composer 的
 * `retry(failureSeq)` + conversationContinuation 投影，用户可见文案「继续生成」），
 * 原先那个把 composer 发送按钮盖成「重试」的组件已整体移除。
 *
 * ## 会话 ID 与分享解决什么问题
 *
 * Web GUI 的会话标题栏右侧原本只有「⋯」（下载 Session 日志 / 反馈）。用户有两个高频
 * 但无处安放的诉求：
 *
 * 1. 把当前会话的 id 交给 Agent —— 让 Agent 按 id 查这个会话、它的子代理或它的历史。
 *    标题栏的 crumbs 只显示标题，URL 里也不总是带着 id，所以这里给一个一键复制按钮；
 * 2. 把一个会话只读地分享给别人看（对标 DeepSeek 网页版的会话分享）。分享页本身由
 *    Host 半生成（免登录只读 HTML），浏览器半只负责「生成 / 复制 / 打开 / 下载 / 停止」
 *    这套交互。
 *
 * 两个按钮都挂在同一个 `conversation.session.header.utilities` list 槽位里：分享 order
 * -11、复制 order -10，所以从左到右是「分享、复制、⋯」—— 分享是更重的动作，放在最左。
 *
 * ## 为什么是手写 bundle（而不是构建产物）
 *
 * `dsh.client` 只要求 `exports["./client"]` 解析出一个 JS 文件，DSH 的模块清单会在
 * `/plugins/dsh-session-enhance/client.js` 上提供它。而 `require` 只能解析 shell 静态模块表
 * 里的两个说明符（见工厂里的注释），所以这里没有 `import`、没有 JSX 语法、没有任何
 * npm 依赖：元素一律用 `jsx`/`jsxs` 工厂函数构造，样式一律内联（CSS 变量 + fallback），
 * 不引任何模块私有 CSS class —— 那些 class 随版本变，且只在浏览器里才会发现它们没了。
 *
 * ## 为什么状态不放在组件里
 *
 * 这个 bundle **拿不到 `react`**（只能 `react/jsx-runtime`），因此没有 `useState`。
 * 所有交互状态（Toast、分享对话框的开合/加载/已分享/错误/两段确认）都由槽位的 `hooks`
 * 注入面承载：本插件在 `inject()` 里为每个 Session 造一个最小的快照源
 * （`{ getSnapshot, subscribe }`），renderer 会把它绑成组件 props 上的
 * `useToast(selector)` / `useShare(selector)`；动作里写快照，组件订阅到变化后重渲染。
 *
 * ## 复制为什么有两条路
 *
 * `navigator.clipboard.writeText` 是正路，但它要求安全上下文（HTTPS / localhost）与
 * 剪贴板权限；DSH 有时通过局域网 IP、反向代理或受限的浏览器配置打开，这时它是被拒绝
 * 的（Promise reject，而不是不存在）。所以失败后降级到「隐藏 textarea +
 * `document.execCommand('copy')`」这条老路；两条都失败才把「复制失败」的 Toast 给
 * 用户 —— 悄悄什么都不发生是最坏的体验。分享链接的「复制链接」复用同一条路径。
 *
 * ## 分享为什么走 RPC、停止为什么要两段式
 *
 * 分享的存储、token 与免登录只读页都在 Host 半（浏览器插件拿到不磁盘、也拿不到
 * webServer 的 origin），所以浏览器半只调 `/dsh-session-enhance` 前缀路由上的
 * `share.status` / `share.create` / `share.revoke`。分享 url 由 Host 拼好返回，
 * 本文件**不拼任何 url**（只有「下载 HTML」按契约追加一个 `download=1` 查询参数）。
 *
 * 「停止分享」是不可撤销的破坏性动作，但 `window.confirm` 会阻塞页面、在自动化验证
 * 里直接卡死，也违反本工作区「不要用 alert/confirm」的约定；所以确认态做在对话框
 * footer 里：第一次点变「确认停止分享」，再点才真正执行，旁边给「取消」。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-enhance',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    // shell 的静态模块表里只有这两个说明符可解析（官方设置页 / 随附 Session 导出插件
    // 用的正是这两个）。引别的会抛
    // `client-modules: require("…") missed the module table`，而且只在浏览器里报，
    // 离线单测与 `node --check` 都发现不了。
    const { jsx, jsxs } = require('react/jsx-runtime');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');

    // #region 词典
    /** 英文文案。 */
    const en = {
      // 复制会话 ID
      'button.copy': 'Copy session ID',
      'toast.copied': 'Session ID copied',
      'toast.copyFailed': 'Could not copy the session ID',

      // 分享会话
      'share.button': 'Share session',
      'share.title': 'Share session',
      'share.close': 'Close',
      'share.cancel': 'Cancel',
      'share.descriptionNew': 'Anyone with the link can view this session read-only.',
      'share.descriptionActive':
        'Anyone with the link can view this session read-only. Stopping the share invalidates the link.',
      'share.loading': 'Reading the share status…',
      'share.emptyBody': 'The link contains the full conversation of this session.',
      'share.create': 'Create share link',
      'share.creating': 'Creating…',
      'share.linkLabel': 'Share link',
      'share.copyLink': 'Copy link',
      'share.openLink': 'Open link',
      'share.downloadHtml': 'Download HTML',
      'share.stop': 'Stop sharing',
      'share.stopConfirm': 'Confirm stop sharing',
      'share.retry': 'Retry',
      'share.unavailable': 'This deployment does not provide session sharing.',
      'share.actionFailed': 'The operation failed.',
      'share.toastCreated': 'Share link created',
      'share.toastCopied': 'Link copied',
      'share.toastRevoked': 'Sharing stopped',
      'share.toastFailed': 'The operation failed.',

      // 上下文用量 + 手动压缩
      'context.label': 'Context',
      'context.compact': 'Compact',
      'context.compactRow': 'Compact context',
      'context.compactTitle': 'Summarize older history now to free context space.',
      'context.compacting': 'Compacting…',
      'context.title': 'Context usage {used} / {window} ({pct}%)\nClick Compact to summarize older history now.',
      'context.compacted': 'Compacted {items} items, freed about {tokens} tokens',
      'context.compactedGeneric': 'Compacted; see the summary card in the conversation',
      'context.noRange': 'No compactable history yet',
      'context.unavailable': 'Compaction is unavailable: the compaction plugin is not mounted',
      'context.busy': 'Session is busy; try again in a moment',
      'context.cancelled': 'Compaction cancelled',
      'context.transport': 'Connection failed; could not compact',
      'context.failed': 'Compaction failed ({code})',
      'context.autoOn': 'auto compaction: on',
      'context.autoOff': 'auto compaction: off',
      'context.autoHint': 'Tiered compaction: prune at {prune} of the effective window, summarize at {compact}.',
      'context.nearLimit': 'context almost full',
      'context.nearLimitTitle': 'Context is close to the window limit — compact now to avoid a context-overflow failure.',
      'context.breakerOpen': 'auto compaction paused',
      'context.breakerTitle':
        'Auto compaction paused after {n} consecutive failures; it retries in the next turn. Use Compact to retry now.',
      'context.compactedPruned': 'Pruned {pruned} tool results; compacted {items} items, freed about {tokens} tokens',
      'context.compactedGenericPruned': 'Pruned {pruned} tool results; compaction finished (see the summary card)',
      'context.prunedOnly': 'Pruned {pruned} tool results; no compactable history yet',

      // 设置页：自动压缩
      'settings.title': 'Session Enhance',
      'settings.summary': 'Tiered context compaction and the auto-compaction toggle.',
      'settings.autoCompact': 'Auto compaction',
      'settings.autoCompactHint':
        'When on, before every model request: at 60% of the effective context window, oversized tool results are pruned in one batch (no model call); at 80%, older history is pruned and summarized in one transaction, so the prefix cache breaks only once. When off, only manual compaction runs.',
      'settings.overridden': 'overridden',
      'settings.reset': 'Reset',
      'settings.readOnly': 'Settings are read-only in this deployment.',
      'settings.unavailable': 'This plugin is not loaded, so it cannot be configured.',
      'settings.save': 'Save',
      'settings.saving': 'Saving…',
      'settings.saveFailed': 'This deployment rejected the values; they are kept for editing.'
    };

    /** 简体中文文案。 */
    const zh = {
      // 复制会话 ID
      'button.copy': '复制会话 ID',
      'toast.copied': '会话 ID 已复制',
      'toast.copyFailed': '复制失败，无法写入剪贴板',

      // 分享会话
      'share.button': '分享会话',
      'share.title': '分享会话',
      'share.close': '关闭',
      'share.cancel': '取消',
      'share.descriptionNew': '任何拿到链接的人都能只读查看这个会话。',
      'share.descriptionActive': '任何拿到链接的人都能只读查看这个会话；停止分享后该链接将失效。',
      'share.loading': '正在读取分享状态…',
      'share.emptyBody': '链接里包含这个会话的完整对话内容。',
      'share.create': '创建分享链接',
      'share.creating': '正在创建…',
      'share.linkLabel': '分享链接',
      'share.copyLink': '复制链接',
      'share.openLink': '打开链接',
      'share.downloadHtml': '下载 HTML',
      'share.stop': '停止分享',
      'share.stopConfirm': '确认停止分享',
      'share.retry': '重试',
      'share.unavailable': '当前部署没有提供分享服务。',
      'share.actionFailed': '操作失败。',
      'share.toastCreated': '分享链接已创建',
      'share.toastCopied': '链接已复制',
      'share.toastRevoked': '已停止分享',
      'share.toastFailed': '操作失败。',

      // 上下文用量 + 手动压缩
      'context.label': '上下文',
      'context.compact': '压缩',
      'context.compactRow': '压缩上下文',
      'context.compactTitle': '立即摘要较早的历史，释放上下文空间',
      'context.compacting': '压缩中…',
      'context.title': '上下文用量 {used} / {window}（{pct}%）\n点击「压缩」立即摘要较早的历史、释放上下文空间。',
      'context.compacted': '已压缩 {items} 项，释放约 {tokens} tokens',
      'context.compactedGeneric': '压缩完成，详见对话中的压缩摘要',
      'context.noRange': '没有可压缩的历史',
      'context.unavailable': '压缩不可用：当前部署未启用压缩插件',
      'context.busy': '会话正忙，稍后再试',
      'context.cancelled': '已取消压缩',
      'context.transport': '连接失败，无法压缩',
      'context.failed': '压缩失败（{code}）',
      'context.autoOn': '自动压缩：开',
      'context.autoOff': '自动压缩：关',
      'context.autoHint': '分级压缩：有效窗口 {prune} 时批量清理工具输出，{compact} 时修剪并摘要历史。',
      'context.nearLimit': '上下文即将用尽',
      'context.nearLimitTitle': '上下文接近窗口上限，建议立即压缩以避免溢出失败。',
      'context.breakerOpen': '自动压缩已暂停',
      'context.breakerTitle':
        '自动压缩连续失败 {n} 次后暂停，下一轮会重新尝试；也可点「压缩」立即重试。',
      'context.compactedPruned': '已清理 {pruned} 个工具输出；压缩 {items} 项，释放约 {tokens} tokens',
      'context.compactedGenericPruned': '已清理 {pruned} 个工具输出；压缩完成，详见对话中的压缩摘要',
      'context.prunedOnly': '已清理 {pruned} 个工具输出；没有可压缩的历史',

      // 设置页：自动压缩
      'settings.title': '会话增强',
      'settings.summary': '分级上下文压缩与自动压缩开关。',
      'settings.autoCompact': '自动压缩',
      'settings.autoCompactHint':
        '开启后，每次模型请求前：有效上下文窗口用到 60% 时，把所有超大工具输出一次性批量清理（不调用模型）；用到 80% 时，先清理再摘要较早历史，两者在同一个事务里完成，只断一次前缀缓存。关闭时只保留手动压缩。',
      'settings.overridden': '已覆盖',
      'settings.reset': '恢复默认',
      'settings.readOnly': '本部署的设置为只读。',
      'settings.unavailable': '该插件当前未加载，暂时无法配置。',
      'settings.save': '保存',
      'settings.saving': '保存中…',
      'settings.saveFailed': '本部署没有接受这些值，已保留供你修改。'
    };
    // #endregion

    // #region 常量
    /**
     * 本插件的词典命名空间。
     *
     * 与 Loader 行 id 同名是刻意的：一个字符串既能当槽位词典键，也便于在开发者工具
     * 里定位。它是 locale 服务里的独立键，不与其他命名空间冲突。
     */
    const NS = 'dsh-session-enhance';

    /**
     * 设置页的 Host 命名空间 = Loader 行 id。
     *
     * 浏览器包不能依赖 Host 包，所以这里与 `index.js` 的 `SETTINGS_NAMESPACE` 重复硬编码；
     * 改行 id 时必须两处一起改，否则设置页会静默消失。
     */
    const SETTINGS_NS = 'dsh-session-enhance';

    /** 自动压缩开关的配置字段名（与 Host 半 `Config` 一致）。 */
    const AUTO_COMPACT_FIELD = 'autoCompact';

    /**
     * 槽位名：会话标题栏右侧那组小按钮（「⋯」也在里面）。
     *
     * 这是个 `list` 槽位，我们用自己的 id 并排新增；复用别人的 id 会顶掉别人的按钮。
     */
    const SLOT_NAME = 'conversation.session.header.utilities';

    /** 复制贡献的 id：同槽位里唯一即可。 */
    const COPY_SLOT_ID = 'session-id-copy';

    /**
     * 复制按钮的槽位顺序：排在「⋯」左边。
     *
     * list 槽位按 order 升序渲染。官方「⋯」没有显式 order（等价于 0），所以这里取
     * 负数稳定落在它前面；显式给值而不是留空，是为了不依赖「未声明 order 的贡献按
     * 加载顺序排」这个没写进契约的行为。
     */
    const COPY_SLOT_ORDER = -10;

    /** 分享贡献的 id（`data-session-share` 定位属性与它同源，便于自动化断言）。 */
    const SHARE_SLOT_ID = 'session-share';

    /** 分享按钮的槽位顺序：比复制更小，所以落在复制按钮左侧。 */
    const SHARE_SLOT_ORDER = -11;

    /**
     * Host 半 `lib/rpc.mjs` 注册的前缀路由。
     *
     * 客户端不能 import Host 包，所以这个字符串在这里重复一遍；改名时必须同时改
     * `lib/rpc.mjs` 里的前缀，否则按钮点了只会报「操作失败」。
     */
    const RPC_CHANNEL = '/dsh-session-enhance';

    /**
     * 图标按钮的样式。
     *
     * 形制对齐官方标题栏按钮（28px 见方、图标 15px、次要文字色），但全部写死在本文件
     * 里：官方那个用的是模块私有 CSS class，随版本变。颜色走 CSS 变量并给 fallback，
     * 深色主题下会跟着外壳的 token 走。
     */
    const BUTTON_STYLE = {
      width: '28px',
      height: '28px',
      minWidth: '28px',
      padding: 0,
      flex: 'none',
      color: 'var(--dsw-alias-label-secondary, currentColor)'
    };

    /** 对话框正文（说明 / 加载 / 空态）。 */
    const DIALOG_TEXT_STYLE = {
      margin: 0,
      fontSize: '13px',
      lineHeight: 1.6,
      color: 'var(--dsw-alias-label-secondary, inherit)'
    };

    /**
     * 对话框里的错误文案。
     *
     * 用主题的 danger 色并带 fallback：拿得到 token 时跟着主题变，拿不到时仍是可读的
     * 红色，而不是「看起来跟正常文案一样」。
     */
    const DIALOG_ERROR_STYLE = {
      ...DIALOG_TEXT_STYLE,
      color: 'var(--dsw-alias-label-danger, #d92d20)'
    };

    /**
     * 分享链接的只读输入框。
     *
     * 用等宽字体：分享链接里 token 很长，等宽更便于用户肉眼比对「复制的是哪一条」；
     * 只读但可聚焦（聚焦时全选，见组件里的 onFocus），这样手快的人可以直接 Ctrl+C。
     */
    const LINK_INPUT_STYLE = {
      width: '100%',
      height: '32px',
      padding: '0 10px',
      boxSizing: 'border-box',
      border: '0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.35))',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      background: 'var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.06))',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12px',
      lineHeight: 1.5,
      color: 'var(--dsw-alias-label-primary, inherit)'
    };

    /** 对话框底部 / 链接操作那一行的布局。 */
    const ACTIONS_STYLE = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: '8px'
    };
    // #endregion

    // #region 快照源
    /**
     * 一个最小快照源，形状正好是 shell 绑定 hook 所需的
     * `{ getSnapshot, subscribe }`（renderer 内部用它喂 `useSyncExternalStore`）。
     *
     * 不引任何 store 库：本插件只有 Toast 与分享对话框两份小状态，用 `Set` 记订阅者
     * 就是全部。`set`/`update` 在值没变时不通知，避免点击与 `onDone` 之间多余的渲染。
     *
     * `update(mutator)` 用「读-改-写」一次完成，是为了让多个动作（刷新状态与写 Toast）
     * 交叉发生时不会互相覆盖快照里的字段。
     *
     * @param {unknown} initial - 初始快照。
     * @returns {{ getSnapshot: () => any, subscribe: (listener: () => void) => () => void, set: (next: any) => void, update: (mutator: (current: any) => any) => void }} 快照源。
     */
    function createSnapshotStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      const publish = (next) => {
        if (Object.is(next, snapshot)) return;
        snapshot = next;
        for (const listener of listeners) listener();
      };
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set: (next) => publish(next),
        update: (mutator) => publish(mutator(snapshot))
      };
    }
    // #endregion

    // #region 组件能力探测
    /**
     * 两个 Host 组件行的启用状态（浏览器半据此决定要不要渲染对应 UI）。
     *
     * ## 为什么需要探测
     *
     * 浏览器半是**包级一份**（`dsh.client` 不能按行拆），只要承载它的第一行还在，
     * 它就一定被加载。而 Host 侧的「会话分享」是独立的一条 Loader 行，可以在
     * 「设置 → 插件 → 会话增强 → 包含的组件」里单独停用。停用之后它注册的
     * RPC 前缀路由不再存在，请求会落到 SPA fallback —— 于是按钮还挂在标题栏上，
     * 点一下却永远失败。这才是"组件拆了但边界没生效"。
     *
     * ## 信号
     *
     * Host 的 prefix 路由只在对应行启用时注册。实测（2026-10-28，真实 Loader）：
     *
     * - 组件在 → `POST /dsh-session-enhance` 返回 **200** + 业务信封；
     * - 组件停用 → 落到 SPA fallback，返回 **405**、空 body。
     *
     * 所以 `200 = 在`、`405 = 停用`。其它状态（401 / 5xx / 网络异常）无法判定，
     * 一律按"在"处理（乐观）——宁可多一个按钮，也不要把正在工作的按钮撤掉。
     */
    const CAPABILITY_INITIAL = { share: true };

    /** 能力快照源：`{ share }` 一个布尔值，分享 UI 订阅它。 */
    const capabilityStore = createSnapshotStore(CAPABILITY_INITIAL);

    /**
     * 探测一个组件的 Host 半是否在。
     *
     * 参数故意留空：探测只关心"这个通道回不回 HTTP 200"，不关心业务结果
     * （缺 sessionId 会返回 `INVALID_REQUEST`/`BAD_REQUEST` 信封，那也是 200）。
     *
     * @param {string} url - 组件注册的 RPC 前缀路径。
     * @param {string} method - 该通道必然认识的端点名。
     * @returns {Promise<boolean>} true = 组件在。
     */
    async function probeComponent(url, method) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // rpcId 只是回显用的关联 id；探测不看结果内容，只看 HTTP 状态。
            body: JSON.stringify({ type: 'client-request', rpcId: `cap-${method}-${attempt}`, method, payload: {} })
          });
          if (response.status === 200) return true;
          if (response.status === 405) return false;
        } catch {
          // 传输层异常：可能是页面刚起来、认证还没就绪，落到下面的重试。
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 400 * (attempt + 1));
        });
      }
      // 三次都判定不了：乐观保留 UI。
      return true;
    }
    // #endregion

    // #region 剪贴板
    /**
     * 把文本写进剪贴板：现代 API 优先，失败降级到 `execCommand`。
     *
     * 注意两个 API 的失败形态不同：`navigator.clipboard.writeText` 返回 Promise，
     * 权限被拒 / 非安全上下文时是 **reject**（`NotAllowedError`），不是「方法不存在」；
     * 所以必须 `await` 并捕获，而不是只判断方法在不在。`execCommand` 则是同步返回
     * 布尔值，并且在某些浏览器里会抛，两种都要收口成 `false`。
     *
     * @param {string} text - 要复制的文本。
     * @returns {Promise<boolean>} 是否成功写入剪贴板。
     */
    async function writeClipboard(text) {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === 'function') {
        try {
          await clipboard.writeText(text);
          return true;
        } catch {
          // 落到下面的 execCommand 分支：拒绝可能是权限，也可能是策略，两者都还能
          // 用旧 API 试一次。
        }
      }
      return writeClipboardLegacy(text);
    }

    /**
     * 老路：隐藏 textarea + `document.execCommand('copy')`。
     *
     * textarea 必须真的在选择里（`select()`），且要留在文档里才能被复制，所以先挂到
     * `body`、复制完再摘掉。固定在视口外而不是 `display:none`：后者在很多浏览器里
     * 选不中。`try/finally` 保证异常时也不留下垃圾节点。
     *
     * @param {string} text - 要复制的文本。
     * @returns {boolean} 是否成功。
     */
    function writeClipboardLegacy(text) {
      if (typeof document === 'undefined' || document.body === null) return false;
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.setAttribute('aria-hidden', 'true');
      area.tabIndex = -1;
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.left = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      try {
        area.select();
        area.setSelectionRange(0, text.length);
        return document.execCommand('copy') === true;
      } catch {
        return false;
      } finally {
        document.body.removeChild(area);
      }
    }
    // #endregion

    // #region 辅助
    /**
     * 任意抛出值 → 展示文案。
     *
     * RPC 的失败信封是普通对象，网络/传输层错误才是真正的异常；两条路都要能变成一行
     * 给用户看的字。
     *
     * @param {unknown} error - 抛出值。
     * @returns {string} 展示文案。
     */
    function messageOf(error) {
      if (error instanceof Error) return error.message;
      if (typeof error === 'string') return error;
      if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    }

    /**
     * 分享链接 + `download=1`。
     *
     * 契约是「同 url 追加 `?download=1`」。这里按 url 里有没有 `?` 选择分隔符：Host 目前
     * 返回的是不带查询串的短链，但一旦以后 url 自己带了参数，硬拼 `?` 会拼出两个问号、
     * Host 收不到 `download` 参数。
     *
     * @param {string} url - Host 返回的分享链接。
     * @returns {string} 下载地址。
     */
    function withDownloadParam(url) {
      const separator = url.indexOf('?') === -1 ? '?' : '&';
      return url + separator + 'download=1';
    }
    // #endregion

    // #region 图标
    /**
     * 复制图标：两张叠放的纸。自绘而不赌 primitives 的图标导出名 —— 图标导出随包名
     * 形如 `IconCopyOutlineRegular`，但那是「可能」，而一个画错的 SVG 是确定的。
     * 用 `currentColor` 描边，颜色由按钮的 `color` 继承。
     *
     * @returns {any} 15×15 的 SVG 元素。
     */
    function copyIcon() {
      return jsxs('svg', {
        width: 15,
        height: 15,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
        children: [
          jsx('rect', { x: '5.75', y: '5.75', width: '7.5', height: '7.5', rx: '1.5' }),
          jsx('path', { d: 'M10.25 5.75V3.75a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h2' })
        ]
      });
    }

    /**
     * 分享图标：一个方框 + 向上的箭头（「把会话交出去」的通用隐喻，与 iOS/macOS 的
     * 分享图标同形）。同样自绘，理由同上。
     *
     * @returns {any} 15×15 的 SVG 元素。
     */
    function shareIcon() {
      return jsxs('svg', {
        width: 15,
        height: 15,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
        children: [
          jsx('path', { d: 'M5.5 6.25H4A1.5 1.5 0 0 0 2.5 7.75v5A1.5 1.5 0 0 0 4 14.25h8a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 12 6.25h-1.5' }),
          jsx('path', { d: 'M8 10.25V2.25' }),
          jsx('path', { d: 'M5.5 4.75 8 2.25l2.5 2.5' })
        ]
      });
    }
    // #endregion

    // #region 复制按钮
    /**
     * 会话标题栏里的复制按钮。
     *
     * 两个 props 来自两处：`sessionId`、`t` 由槽位按 Session scope 自动注入；
     * `useToast`、`copy`、`dismissToast` 来自本插件 contribution 的 `inject()`。
     *
     * 渲染顺序上先调 `useToast` 再提前返回：hooks 必须在每次渲染时以相同顺序调用，
     * 否则「没有 sessionId」的那次渲染会改变调用顺序，React 会报 hook 顺序错误。
     *
     * Toast 用 `sequence` 当 React key：连续点两次时第二次要在视觉上「重新弹一次」，
     * 复用同一个 Toast 实例的话它可能还停在第一次的动画里。`onDone` 也带上 sequence，
     * 只清掉与当前快照同序号的那条，避免旧 Toast 的结束回调把新 Toast 清掉。
     *
     * @param {any} props - 槽位注入的 props。
     * @returns {any} 按钮与（可选的）Toast。
     */
    function SessionIdCopyButton(props) {
      const sessionId = props.sessionId;
      const notice = props.useToast((value) => value);
      if (sessionId === undefined || sessionId === null || String(sessionId) === '') return null;

      const id = String(sessionId);
      const toast =
        notice === null
          ? null
          : jsx(
              P.Toast,
              {
                text: notice.text,
                onDone: () => {
                  props.dismissToast(notice.sequence);
                },
                ...(notice.tone === undefined ? {} : { tone: notice.tone })
              },
              notice.sequence
            );

      return jsxs('span', {
        style: { display: 'inline-flex', alignItems: 'center' },
        children: [
          jsx(P.Button, {
            size: 'sm',
            style: BUTTON_STYLE,
            // title 给完整 id：按钮只有图标，用户想确认「复制的是哪一个」时 hover 就能看，
            // 不必先点一次再去别处对照。
            title: id,
            'aria-label': props.t('button.copy'),
            'data-session-id-copy': '',
            onClick: () => {
              props.copy();
            },
            children: copyIcon()
          }),
          toast
        ]
      });
    }
    // #endregion

    // #region 分享按钮与对话框
    /**
     * 分享对话框的初始快照。
     *
     * `open` 是对话框开关；`loading` 是首屏拉 `share.status`；`busy` 是创建/停止这类
     * 写操作进行中；`share` 是当前分享（Host 返回的 `{token,url,…}` 或 null）；
     * `error` 是展示用错误；`confirmRevoke` 是「停止分享」的两段式确认态；
     * `notice` 是 Toast（`{text,tone,sequence}`）。
     */
    const SHARE_INITIAL = {
      open: false,
      loading: false,
      busy: false,
      share: null,
      error: '',
      confirmRevoke: false,
      notice: null
    };

    /**
     * 对话框按钮的内联样式。
     *
     * 用原生 `button` 而不是 `P.Button`：这里需要三种明确的语义色（主操作 / 危险 /
     * 次要），而 primitives 按钮的 variant 取值集合没有写进可依赖的契约；内联样式可以
     * 精确控制，也避免依赖模块私有 CSS class。
     *
     * @param {'primary'|'danger'|'secondary'} variant - 变体。
     * @param {boolean} disabled - 是否禁用。
     * @returns {Record<string, any>} 内联样式。
     */
    function dialogButtonStyle(variant, disabled) {
      const base = {
        height: '32px',
        padding: '0 14px',
        boxSizing: 'border-box',
        borderRadius: '8px',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer'
      };
      if (variant === 'primary') {
        return {
          ...base,
          border: 'none',
          background: 'var(--dsw-alias-brand-primary, #ff5a1f)',
          color: '#ffffff'
        };
      }
      if (variant === 'danger') {
        return {
          ...base,
          border: '0.5px solid currentColor',
          background: 'transparent',
          color: 'var(--dsw-alias-label-danger, #d92d20)'
        };
      }
      return {
        ...base,
        border: '0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)'
      };
    }

    /**
     * 一个对话框按钮。
     *
     * `id` 同时用作 React key 与 `data-share-action`：CSS 选择器没法按文本定位，自动化
     * 验证（以及将来别的 UI 测试）需要稳定的钩子；用同一份 id 也避免两处字符串漂移。
     *
     * @param {string} id - React key + `data-share-action` 值。
     * @param {string} label - 文案（已本地化）。
     * @param {'primary'|'danger'|'secondary'} variant - 变体。
     * @param {boolean} disabled - 是否禁用。
     * @param {() => void} onClick - 点击动作。
     * @returns {any} 元素。
     */
    function dialogButton(id, label, variant, disabled, onClick) {
      return jsx(
        'button',
        {
          type: 'button',
          'data-share-action': id,
          disabled,
          onClick: () => {
            onClick();
          },
          style: dialogButtonStyle(variant, disabled),
          children: label
        },
        id
      );
    }

    /**
     * 对话框正文：加载中 / 错误 / 未分享 / 已分享四种形态。
     *
     * 已分享时把 url 放进只读输入框（而不是纯文本）：用户可以聚焦后 Ctrl+C，也可以
     * 用浏览器的「复制」菜单；旁边再给显式的「复制链接」按钮，因为输入框全选这件事
     * 不是所有人都知道。
     *
     * @param {any} state - 分享快照。
     * @param {any} actions - 对话框动作（来自 inject）。
     * @param {(key: string) => string} t - 词典读取器。
     * @returns {any} 元素或 null。
     */
    function shareDialogBody(state, actions, t) {
      if (state.loading) {
        return jsx('p', { style: DIALOG_TEXT_STYLE, role: 'status', children: t('share.loading') });
      }
      if (state.error !== '') {
        return jsx('p', { style: DIALOG_ERROR_STYLE, role: 'alert', children: state.error });
      }
      if (state.share === null) {
        return jsx('p', { style: DIALOG_TEXT_STYLE, children: t('share.emptyBody') });
      }
      return jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '10px' },
        children: [
          jsx(
            'input',
            {
              type: 'text',
              readOnly: true,
              value: state.share.url,
              'aria-label': t('share.linkLabel'),
              // 测试与用户都靠它确认「这是链接输入框」，而不是同一个对话框里的其它文本。
              'data-share-url': '',
              spellCheck: false,
              onFocus: (event) => {
                event.target.select();
              },
              style: LINK_INPUT_STYLE
            },
            'share-url'
          ),
          jsxs(
            'div',
            {
              style: { ...ACTIONS_STYLE, justifyContent: 'flex-start' },
              children: [
                dialogButton('copy-link', t('share.copyLink'), 'secondary', state.busy, actions.copyLink),
                dialogButton('open-link', t('share.openLink'), 'secondary', state.busy, actions.openLink),
                dialogButton('download-html', t('share.downloadHtml'), 'secondary', state.busy, actions.downloadHtml)
              ]
            },
            'share-link-actions'
          )
        ]
      });
    }

    /**
     * 对话框底部：按状态给主操作。
     *
     * 关闭对话框不在这里放按钮 —— Modal 自带右上角关闭（`closeLabel`）与点遮罩关闭，
     * 同屏再放一个「关闭」只会制造两个同名控件，让自动化断言与用户都分不清点哪个。
     *
     * @param {any} state - 分享快照。
     * @param {any} actions - 对话框动作（来自 inject）。
     * @param {(key: string) => string} t - 词典读取器。
     * @returns {any} 元素或 undefined。
     */
    function shareDialogFooter(state, actions, t) {
      const buttons = [];
      if (state.loading) {
        // 加载中只允许关掉对话框；没有可执行的动作。
      } else if (state.error !== '') {
        buttons.push(dialogButton('retry', t('share.retry'), 'primary', false, actions.retry));
      } else if (state.share === null) {
        buttons.push(
          dialogButton(
            'create',
            state.busy ? t('share.creating') : t('share.create'),
            'primary',
            state.busy,
            actions.createShare
          )
        );
      } else if (state.confirmRevoke) {
        buttons.push(dialogButton('confirm-revoke', t('share.stopConfirm'), 'danger', state.busy, actions.revokeNow));
        buttons.push(dialogButton('cancel-revoke', t('share.cancel'), 'secondary', state.busy, actions.cancelRevoke));
      } else {
        buttons.push(dialogButton('stop', t('share.stop'), 'danger', state.busy, actions.requestRevoke));
      }
      if (buttons.length === 0) return undefined;
      return jsx('div', { style: ACTIONS_STYLE, children: buttons });
    }

    /**
     * 会话标题栏里的分享按钮与其对话框。
     *
     * 与复制按钮同构：`sessionId`、`t` 由槽位注入，`useShare` 与全部动作来自本插件
     * contribution 的 `inject()`。`useShare` 必须在提前返回之前调用（hooks 顺序）。
     *
     * 对话框在 `open` 为假时仍然被构造（只是 Modal 不渲染 portal），所以关闭时保留的
     * `share` 会留在快照里；再次打开时 `openShare()` 会重新拉一次 `share.status`，
     * 因此不会显示过期链接。
     *
     * @param {any} props - 槽位注入的 props。
     * @returns {any} 按钮、Toast 与对话框。
     */
    function SessionShareButton(props) {
      const sessionId = props.sessionId;
      const state = props.useShare((value) => value);
      // 能力探测：Host 侧的「会话分享」行被停用时，按钮与对话框一并收起。
      // 必须在提前返回之前调用（hooks 顺序不能变）。
      const capability = props.useCapability((value) => value.share);
      if (sessionId === undefined || sessionId === null || String(sessionId) === '') return null;
      if (capability === false) {
        // 与上面的能力探测策略一致：返回隐藏占位而不是 null —— 组件保持挂载，
        // 订阅才不会被拆掉（若之后组件被重新启用，能立刻恢复）。
        return jsx('span', { style: { display: 'none' }, 'data-session-share': 'disabled' });
      }

      const t = props.t;
      const actions = {
        createShare: props.createShare,
        copyLink: props.copyLink,
        openLink: props.openLink,
        downloadHtml: props.downloadHtml,
        requestRevoke: props.requestRevoke,
        cancelRevoke: props.cancelRevoke,
        revokeNow: props.revokeNow,
        retry: props.retry
      };
      const toast =
        state.notice === null
          ? null
          : jsx(
              P.Toast,
              {
                text: state.notice.text,
                onDone: () => {
                  props.dismissNotice(state.notice.sequence);
                },
                ...(state.notice.tone === undefined ? {} : { tone: state.notice.tone })
              },
              state.notice.sequence
            );

      return jsxs('span', {
        style: { display: 'inline-flex', alignItems: 'center' },
        children: [
          jsx(P.Button, {
            size: 'sm',
            style: BUTTON_STYLE,
            title: t('share.button'),
            'aria-label': t('share.button'),
            'data-session-share': '',
            onClick: () => {
              props.openShare();
            },
            children: shareIcon()
          }),
          toast,
          jsx(
            P.Modal,
            {
              open: state.open,
              title: t('share.title'),
              description: state.share === null ? t('share.descriptionNew') : t('share.descriptionActive'),
              closeLabel: t('share.close'),
              onClose: () => {
                props.closeShare();
              },
              footer: shareDialogFooter(state, actions, t),
              children: shareDialogBody(state, actions, t)
            },
            'share-dialog'
          )
        ]
      });
    }
    // #endregion

    // #region 上下文：官方 ContextMeter 面板内的「压缩」动作
    //
    // DSH 0.2.2 起，composer 卡片下方自带一个官方「上下文已用」meter（圆环 + 百分比 +
    // 点击弹出的 panel：系统提示词 / 工具定义 / 对话消息）。它由
    // `dsh-client-ui-conversation` 内置渲染，**没有对外 slot**，所以不能按普通槽位
    // 追加内容。这里改成：监听那个 panel（portal 到 body 的 role=dialog + <dl>），
    // 在 panel 末尾注入一行与官方 `.row` 同字号/同色板的「压缩上下文」动作。
    //
    // 之所以不用自己的百分比小部件：官方 meter 已经展示用量，重复显示反而杂乱；
    // 用户要的是「压缩」这个动作出现在看到用量的地方。
    /** 上下文组件的 RPC 通道（Host 半见 lib/context/host.mjs）。 */
    const CONTEXT_RPC_CHANNEL = '/dsh-session-enhance-context';

    /** 槽位只用来跟踪"当前挂载的会话"（composer 挂载哪个会话，面板动作就操作哪个）。 */
    const CONTEXT_SLOT_NAME = 'conversation.input.left';
    const CONTEXT_SLOT_ID = 'session-context';
    const CONTEXT_SLOT_ORDER = 0;

    /** 当前激活会话 id：由 session tracker 的挂载/卸载维护。 */
    let activeContextSessionId = '';

    /** 面板动作的瞬时状态。 */
    const contextActionState = { busy: false, note: '' };

    /** 动作行/提示的 DOM 标记（只命中本插件自己的节点，不碰官方 DOM）。 */
    const CONTEXT_ACTIONS_ATTR = 'data-dsh-enhance-context-actions';
    const CONTEXT_COMPACT_ATTR = 'data-dsh-enhance-context-compact';
    const CONTEXT_LABEL_ATTR = 'data-dsh-enhance-context-label';

    /** 压缩可用性探测结果：null = 还没探测到。 */
    let contextCanCompact = null;

    /** 自动压缩状态（来自 Host `get`）：null = 还没探测到。 */
    let contextAutoCompact = null;
    let contextPruneRatio = null;
    let contextCompactRatio = null;
    let contextWarningRatio = null;
    let contextPressureTokens = null;
    let contextAutoEffectiveWindow = null;
    let contextAutoFailures = 0;
    let contextBreakerOpen = false;
    let contextAutoProbeSession = '';
    let contextObserver = null;
    let contextInterval = null;
    let contextNoteTimer;

    /**
     * 判断一个 `role=dialog` 元素是不是官方上下文 panel。
     *
     * 特征：内部有 `<dl>`（三行 breakdown）且文本里带 `NN%`。本插件自己的分享对话框
     * 没有 `<dl>`，不会被误判。
     *
     * @param {Element} node - 候选节点。
     * @returns {boolean} 是否官方上下文 panel。
     */
    function isContextPanel(node) {
      if (node === null || node === undefined) return false;
      if (node.getAttribute('role') !== 'dialog') return false;
      if (node.querySelector('dl') === null) return false;
      return /\d+%/.test(node.textContent ?? '');
    }

    /**
     * 找当前打开的官方上下文 panel。
     *
     * @returns {Element | null} panel 或 null。
     */
    function findContextPanel() {
      if (typeof document === 'undefined') return null;
      const dialogs = document.querySelectorAll('[role="dialog"]');
      for (const node of dialogs) {
        if (isContextPanel(node)) return node;
      }
      return null;
    }

    /**
     * 向文档注入一次「压缩」动作行的样式（与官方 ContextMeter 同字号/行高/色板）。
     *
     * 只写本插件自己的 `data-dsh-enhance-*` 选择器，卸载时整条移除。
     *
     * @returns {() => void} 清理函数。
     */
    function installContextActionStyle() {
      if (typeof document === 'undefined') return () => {};
      const style = document.createElement('style');
      style.setAttribute('data-dsh-enhance-context-style', '');
      style.textContent = [
        `[${CONTEXT_ACTIONS_ATTR}]{display:flex;align-items:center;justify-content:space-between;gap:12px;`,
        'margin-top:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);',
        'font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
        `[${CONTEXT_LABEL_ATTR}]{display:inline-flex;align-items:center;gap:6px;min-width:0;}`,
        `[${CONTEXT_COMPACT_ATTR}]{font:inherit;font-size:12px;line-height:20px;padding:1px 8px;`,
        'border:none;border-radius:var(--dsw-radius-sm);background:transparent;',
        'color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;}',
        `[${CONTEXT_COMPACT_ATTR}]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}`,
        `[${CONTEXT_COMPACT_ATTR}]:disabled{opacity:.5;cursor:default;}`,
        `[${CONTEXT_COMPACT_ATTR}][data-busy]{opacity:.6;cursor:default;}`,
        `[data-dsh-enhance-context-note]{color:var(--dsw-alias-label-tertiary);}`
      ].join('');
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    /**
     * token 数的人类可读格式（与官方 ContextMeter 的 `formatTokens` 同口径）。
     *
     * @param {unknown} value - token 数。
     * @returns {string} `12k` / `1.2M` / `—`。
     */
    function formatCompactTokens(value) {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num) || num < 0) return '—';
      if (num >= 1_000_000) {
        const millions = num / 1_000_000;
        return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`;
      }
      if (num >= 1_000) return `${Math.round(num / 1_000)}k`;
      return String(Math.round(num));
    }

    /**
     * 比例 → 百分比文本（与 Host 的阈值展示同口径）。
     *
     * @param {unknown} ratio - 0~1 的比例。
     * @returns {string} 例如 `60%`；非法值返回 `—`。
     */
    function formatCompactRatio(ratio) {
      return typeof ratio === 'number' && Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : '—';
    }

    /**
     * 探测当前会话的自动压缩状态（每个会话一次；结果用于动作行上的状态后缀）。
     *
     * @param {any} ctx - 浏览器插件上下文。
     * @param {(key: string, params?: any) => string} t - 词典绑定。
     * @returns {void}
     */
    function probeContextAuto(ctx, t) {
      if (activeContextSessionId === '') return;
      if (contextAutoProbeSession === activeContextSessionId) return;
      const connection = ctx.connection;
      const rpc = connection !== undefined && connection !== null ? connection.rpc : undefined;
      if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') return;
      const sessionId = activeContextSessionId;
      contextAutoProbeSession = sessionId;
      void rpc
        .call(CONTEXT_RPC_CHANNEL, 'get', { sessionId })
        .then((result) => {
          if (activeContextSessionId !== sessionId) return;
          const value =
            result !== null && typeof result === 'object' && result.ok === true ? result.value : undefined;
          if (value === undefined || value.available !== true) return;
          contextAutoCompact = value.autoCompact === true;
          contextPruneRatio = typeof value.pruneRatio === 'number' ? value.pruneRatio : null;
          contextCompactRatio = typeof value.compactRatio === 'number' ? value.compactRatio : null;
          contextWarningRatio = typeof value.warningRatio === 'number' ? value.warningRatio : null;
          contextPressureTokens = typeof value.pressureTokens === 'number' ? value.pressureTokens : null;
          contextAutoEffectiveWindow =
            typeof value.effectiveWindow === 'number' ? value.effectiveWindow : null;
          contextAutoFailures = typeof value.autoFailures === 'number' ? value.autoFailures : 0;
          contextBreakerOpen = value.breakerOpen === true;
          if (value.canCompact === false) contextCanCompact = false;
          renderContextAction(ctx, t);
        })
        .catch(() => {
          // 探测失败不显示状态后缀，不影响手动压缩。
        });
    }

    /**
     * 按当前状态渲染/更新官方 panel 里的动作行（幂等）。
     *
     * @param {any} ctx - 浏览器插件上下文（用 connection 发 RPC）。
     * @param {(key: string, params?: any) => string} t - 词典绑定。
     * @returns {void}
     */
    function renderContextAction(ctx, t) {
      const panel = findContextPanel();
      if (panel === null) return;
      probeContextAuto(ctx, t);
      let row = panel.querySelector(`[${CONTEXT_ACTIONS_ATTR}]`);
      if (row === null) {
        row = document.createElement('div');
        row.setAttribute(CONTEXT_ACTIONS_ATTR, '');
        const label = document.createElement('span');
        label.setAttribute(CONTEXT_LABEL_ATTR, '');
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute(CONTEXT_COMPACT_ATTR, '');
        button.addEventListener('click', () => {
          void runContextCompact(ctx, t);
        });
        row.append(label, button);
        panel.append(row);
      }
      const label = row.querySelector(`[${CONTEXT_LABEL_ATTR}]`);
      const button = row.querySelector(`[${CONTEXT_COMPACT_ATTR}]`);
      if (label === null || button === null) return;
      // ⚠️ 只在值变化时写 DOM：`textContent =` 每次都会产生新文本节点，而我们的
      // MutationObserver 观察的是整棵 body —— 无条件重写会「写→观察→再写」无限循环，
      // 直接把页面主线程卡死（本次沙箱验证踩到过）。幂等写入才能让观察器收敛。
      const autoText =
        contextAutoCompact === true ? t('context.autoOn') : contextAutoCompact === false ? t('context.autoOff') : '';
      // 「即将用尽」预警（对齐 Claude Code 的多级预警）：压力 ≥ 有效窗口的预警比例时提示。
      const nearLimit =
        contextAutoEffectiveWindow !== null &&
        contextAutoEffectiveWindow > 0 &&
        contextPressureTokens !== null &&
        contextPressureTokens / contextAutoEffectiveWindow >= (contextWarningRatio ?? 0.9);
      const baseLabel = contextActionState.note === '' ? t('context.compactRow') : contextActionState.note;
      const suffix = [];
      if (contextActionState.note === '') {
        if (autoText !== '') suffix.push(autoText);
        if (nearLimit) suffix.push(t('context.nearLimit'));
        if (contextBreakerOpen) suffix.push(t('context.breakerOpen'));
      }
      const nextLabel = suffix.length === 0 ? baseLabel : `${baseLabel} · ${suffix.join(' · ')}`;
      if (label.textContent !== nextLabel) label.textContent = nextLabel;
      const nextButtonText = contextActionState.busy ? t('context.compacting') : t('context.compact');
      if (button.textContent !== nextButtonText) button.textContent = nextButtonText;
      const nextDisabled = contextActionState.busy || contextCanCompact === false;
      if (button.disabled !== nextDisabled) button.disabled = nextDisabled;
      let nextTitle = contextCanCompact === false ? t('context.unavailable') : t('context.compactTitle');
      if (contextCanCompact !== false && contextPruneRatio !== null && contextCompactRatio !== null) {
        nextTitle = `${nextTitle}\n${t('context.autoHint', {
          prune: formatCompactRatio(contextPruneRatio),
          compact: formatCompactRatio(contextCompactRatio),
        })}`;
      }
      if (nearLimit) nextTitle = `${nextTitle}\n${t('context.nearLimitTitle')}`;
      if (contextBreakerOpen) {
        nextTitle = `${nextTitle}\n${t('context.breakerTitle', { n: contextAutoFailures })}`;
      }
      if (button.title !== nextTitle) button.title = nextTitle;
    }

    /** 让动作行在下一帧重新渲染（panel 重渲染把行冲掉时会补回来）。 */
    function scheduleContextActionRender(ctx, t) {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => renderContextAction(ctx, t));
      } else {
        setTimeout(() => renderContextAction(ctx, t), 16);
      }
    }

    /**
     * 调 Host 做一次手动压缩；结果写进动作行（释放 token 数 / 错误码）。
     *
     * @param {any} ctx - 浏览器插件上下文。
     * @param {(key: string, params?: any) => string} t - 词典绑定。
     * @returns {Promise<void>} 完成。
     */
    async function runContextCompact(ctx, t) {
      if (contextActionState.busy) return;
      if (activeContextSessionId === '') {
        setContextNote(t('context.failed', { code: 'NO_LIVE_AGENT' }), ctx, t);
        return;
      }
      const connection = ctx.connection;
      const rpc = connection !== undefined && connection !== null ? connection.rpc : undefined;
      if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') {
        setContextNote(t('context.transport'), ctx, t);
        return;
      }
      contextActionState.busy = true;
      contextActionState.note = '';
      scheduleContextActionRender(ctx, t);
      try {
        const result = await rpc.call(CONTEXT_RPC_CHANNEL, 'compact', { sessionId: activeContextSessionId });
        const value = result !== null && typeof result === 'object' && result.ok === true ? result.value : undefined;
        const pruned = value !== undefined && typeof value.pruned === 'number' ? value.pruned : 0;
        if (value !== undefined && value.compacted === true) {
          const items = value.items;
          const tokens = value.tokensSaved;
          const hasCounts = typeof items === 'number' && typeof tokens === 'number';
          setContextNote(
            pruned > 0
              ? hasCounts
                ? t('context.compactedPruned', { pruned, items, tokens: formatCompactTokens(tokens) })
                : t('context.compactedGenericPruned', { pruned })
              : hasCounts
                ? t('context.compacted', { items, tokens: formatCompactTokens(tokens) })
                : t('context.compactedGeneric'),
            ctx,
            t
          );
        } else if (value !== undefined && value.reason === 'NO_RANGE') {
          setContextNote(
            pruned > 0 ? t('context.prunedOnly', { pruned }) : t('context.noRange'),
            ctx,
            t
          );
        } else {
          const error = result !== null && typeof result === 'object' ? result.error : undefined;
          const code =
            error !== null && typeof error === 'object' && typeof error.code === 'string'
              ? error.code
              : 'FAILED';
          setContextNote(contextNoteForCode(t, code), ctx, t);
        }
      } catch {
        setContextNote(t('context.transport'), ctx, t);
      } finally {
        contextActionState.busy = false;
        // 压缩后重新探测：压力、熔断状态与阈值可能都变了。
        contextAutoProbeSession = '';
        scheduleContextActionRender(ctx, t);
      }
    }

    /**
     * 把错误码转成一句人话（与 Host 的稳定机器码对齐）。
     *
     * @param {(key: string, params?: any) => string} t - 词典绑定。
     * @param {string} code - 错误码。
     * @returns {string} 提示文案。
     */
    function contextNoteForCode(t, code) {
      if (code === 'COMPACTION_UNAVAILABLE') return t('context.unavailable');
      if (code === 'BUSY') return t('context.busy');
      if (code === 'CANCELLED') return t('context.cancelled');
      if (code === 'TRANSPORT') return t('context.transport');
      return t('context.failed', { code });
    }

    /**
     * 写一条动作提示，N 秒后清掉并重渲染。
     *
     * @param {string} note - 提示文本。
     * @param {any} ctx - 浏览器插件上下文。
     * @param {(key: string, params?: any) => string} t - 词典绑定。
     * @returns {void}
     */
    function setContextNote(note, ctx, t) {
      contextActionState.note = note;
      scheduleContextActionRender(ctx, t);
      if (contextNoteTimer !== undefined) clearTimeout(contextNoteTimer);
      contextNoteTimer = setTimeout(() => {
        contextNoteTimer = undefined;
        contextActionState.note = '';
        scheduleContextActionRender(ctx, t);
      }, 6000);
    }

    /**
     * 判断一条 mutation 是否只发生在我们的动作行内部（行内文本/属性变化）。
     *
     * 这类变更不需要触发重渲染：`renderContextAction` 本身是幂等写，重复调用会收敛，
     * 但观察器回调→渲染→再触发观察的链路仍应以“只处理行外变更”为准，避免无谓开销。
     * 注意：行被整体移除/新增要视为“行外变更”，否则 panel 重渲染冲掉行后补不回来。
     *
     * @param {MutationRecord} record - 变更记录。
     * @returns {boolean} 是否仅发生在动作行内部。
     */
    function isInsideContextAction(record) {
      const nodes = [...record.addedNodes, ...record.removedNodes];
      if (nodes.some((node) => node instanceof Element && node.matches(`[${CONTEXT_ACTIONS_ATTR}]`))) {
        return false;
      }
      const target = record.target;
      return target instanceof Element && target.closest(`[${CONTEXT_ACTIONS_ATTR}]`) !== null;
    }

    /**
     * 启动官方 panel 的观察器：panel 打开时注入动作行，关闭后自然消失。
     *
     * 同时探测一次 `context/diag`，判断压缩服务是否在场（不在场就把按钮置灰）。
     *
     * @param {any} ctx - 浏览器插件上下文。
     * @param {(key: string, params?: any) => string} t - 词典绑定。
     * @returns {void}
     */
    function startContextPanelInjector(ctx, t) {
      if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return;
      contextObserver = new MutationObserver((records) => {
        if (records.every((record) => isInsideContextAction(record))) return;
        renderContextAction(ctx, t);
      });
      contextObserver.observe(document.body, { childList: true, subtree: true });
      // 兜底轮询：个别渲染路径不一定触发 childList（例如 panel 内容原地更新）。
      contextInterval = setInterval(() => {
        renderContextAction(ctx, t);
      }, 800);
      // 探测压缩服务是否可用（只探一次；结果用于置灰，不影响动作行出现）。
      const connection = ctx.connection;
      const rpc = connection !== undefined && connection !== null ? connection.rpc : undefined;
      if (rpc !== undefined && rpc !== null && typeof rpc.call === 'function') {
        void rpc
          .call(CONTEXT_RPC_CHANNEL, 'diag', {})
          .then((result) => {
            const value = result !== null && typeof result === 'object' && result.ok === true ? result.value : undefined;
            contextCanCompact = value !== undefined && value.hasCompaction === true;
            renderContextAction(ctx, t);
          })
          .catch(() => {
            contextCanCompact = false;
          });
      }
    }

    /** 停止 panel 观察器并移除已注入的节点。 */
    function stopContextPanelInjector() {
      if (contextObserver !== null) {
        contextObserver.disconnect();
        contextObserver = null;
      }
      if (contextInterval !== null) {
        clearInterval(contextInterval);
        contextInterval = null;
      }
      if (contextNoteTimer !== undefined) {
        clearTimeout(contextNoteTimer);
        contextNoteTimer = undefined;
      }
      if (typeof document !== 'undefined') {
        for (const row of document.querySelectorAll(`[${CONTEXT_ACTIONS_ATTR}]`)) row.remove();
        for (const style of document.querySelectorAll('[data-dsh-enhance-context-style]')) style.remove();
      }
      contextActionState.busy = false;
      contextActionState.note = '';
    }

    /**
     * 每会话一份的「当前会话」跟踪器。
     *
     * 槽位 inject 是按会话缓存的：composer 挂载哪个会话，它的订阅者先出现。第一个
     * 订阅者出现时把 `activeContextSessionId` 指到该会话，最后一个订阅者离开且仍是
     * 它时清空。官方 panel 里的压缩动作据此知道要压缩哪个会话。
     *
     * @param {string} sessionId - 会话 id。
     * @returns {{ getSnapshot: () => number, subscribe: (listener: () => void) => () => void }} 快照源。
     */
    function createContextSessionTracker(sessionId) {
      const store = createSnapshotStore(0);
      let listeners = 0;
      return {
        getSnapshot: store.getSnapshot,
        subscribe: (listener) => {
          listeners += 1;
          if (listeners === 1 && sessionId !== '') activeContextSessionId = sessionId;
          const unsubscribe = store.subscribe(listener);
          return () => {
            unsubscribe();
            listeners -= 1;
            if (listeners === 0 && activeContextSessionId === sessionId) activeContextSessionId = '';
          };
        }
      };
    }

    /**
     * 隐藏的会话跟踪组件：不渲染任何可见 UI（官方 meter 已负责展示用量）。
     *
     * @param {any} props - 槽位注入的 props。
     * @returns {any} 隐藏占位。
     */
    function ContextSessionTracker(props) {
      props.useContextSession((value) => value);
      return jsx('div', { style: { display: 'none' }, 'data-session-context': 'tracker' });
    }
    // #endregion

    // #region 设置页：自动压缩开关
    //
    // 「设置 → 插件 → 已安装 → 会话增强」的配置卡片由本 bundle 自绘：Host 半声明
    // `Config`（autoCompact，volatile），客户端用 SettingsFormModel 做「暂存 → 保存」，
    // 保存链路走 configForms → Host settings → profile patch 并热更新，不需要重启。
    // 之所以自绘而不是用自动生成页：自动页只渲染文本/数字字段，开关需要 Switch 原语。

    /**
     * {@link P.SettingsFormModel} 的布尔字段类型（内置只有文本/数字）。
     *
     * @param {string} field - 配置字段名。
     * @returns {{ field: string, format: (value: unknown) => string, parse: (text: string) => { kind: 'set', value: boolean } }} 字段规格。
     */
    function settingsBooleanField(field) {
      return {
        field,
        format: (value) => (value === false ? 'false' : 'true'),
        parse: (text) => ({ kind: 'set', value: text === 'true' })
      };
    }

    /**
     * 开关行：标签 + 已覆盖标记 + Switch + 提示。
     *
     * @param {any} props - 属性。
     * @returns {any} 元素。
     */
    function AutoCompactToggleRow(props) {
      const { t } = props;
      return jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 0' },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: '12px' },
            children: [
              jsxs('div', {
                style: { flex: '1 1 auto', display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
                children: [
                  jsx('span', {
                    id: props.id,
                    style: { fontSize: '13px', fontWeight: 500 },
                    children: props.label
                  }),
                  props.overridden
                    ? jsxs('span', {
                        style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
                        children: [
                          jsx('span', {
                            style: {
                              fontSize: '11px',
                              padding: '1px 6px',
                              borderRadius: '999px',
                              border: '1px solid currentColor',
                              opacity: 0.65
                            },
                            children: t('settings.overridden')
                          }),
                          jsx('button', {
                            type: 'button',
                            disabled: props.disabled,
                            onClick: props.onReset,
                            style: {
                              fontSize: '11px',
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              color: 'inherit',
                              opacity: props.disabled ? 0.4 : 0.7,
                              cursor: props.disabled ? 'default' : 'pointer',
                              textDecoration: 'underline'
                            },
                            children: t('settings.reset')
                          })
                        ]
                      })
                    : null
                ]
              }),
              jsx(P.Switch, {
                checked: props.checked,
                disabled: props.disabled,
                label: props.label,
                onChange: (next) => props.onEdit(next === true)
              })
            ]
          }),
          jsx('p', {
            style: { margin: 0, fontSize: '12px', opacity: 0.6, lineHeight: 1.5 },
            children: props.hint
          })
        ]
      });
    }

    /**
     * 设置卡片：`summary` 视图返回一句话说明，`page` 视图渲染表单。
     *
     * @param {any} props - 槽位注入的 props。
     * @returns {any} 元素。
     */
    function AutoCompactCard(props) {
      const { t } = props;
      const state = props.useAutoCompactCard((snapshot) => snapshot);
      if (props.view === 'summary') return t('settings.summary');
      return jsx(P.SettingsForm, {
        labels: {
          unavailable: t('settings.unavailable'),
          readOnly: t('settings.readOnly'),
          saveFailed: t('settings.saveFailed'),
          save: t('settings.save'),
          saving: t('settings.saving')
        },
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: jsx(AutoCompactToggleRow, {
          id: 'plugin-config-session-enhance-autocompact',
          t,
          label: t('settings.autoCompact'),
          hint: t('settings.autoCompactHint'),
          checked: state.autoCompact.text !== 'false',
          overridden: state.autoCompact.overridden,
          disabled: !state.writable,
          onEdit: (next) => props.edit(AUTO_COMPACT_FIELD, next ? 'true' : 'false'),
          onReset: () => props.resetField(AUTO_COMPACT_FIELD)
        })
      });
    }

    /** 设置卡片的控制器：SettingsFormModel（暂存→保存）+ 快照 store。 */
    class AutoCompactCardController {
      /**
       * @param {any} scope - 该设置命名空间已绑定的设置作用域。
       */
      constructor(scope) {
        this.form = new P.SettingsFormModel(scope, [settingsBooleanField(AUTO_COMPACT_FIELD)]);
        this.store = this.form.bind(() => this.projection());
      }

      /**
       * 用表单当前读取结果构建页面快照。
       *
       * @returns {object} 快照。
       */
      projection() {
        return { ...this.form.shell(), autoCompact: this.form.field(AUTO_COMPACT_FIELD) };
      }

      /**
       * 构建槽位注册注入的「面孔」。
       *
       * @returns {object} hooks 与表单动作。
       */
      inject() {
        return { hooks: { autoCompactCard: this.store }, ...this.form.actions() };
      }

      /** 释放表单订阅。 */
      dispose() {
        this.form.dispose();
      }
    }
    // #endregion

    // #region 插件入口
    /**
     * 浏览器半用到的服务：槽位（挂按钮）、词典、以及到 Host 的 RPC 通道。
     *
     * `connection` 是 RPC carrier（与其他调用宿主服务的 UI 插件用法一致）；不带它时
     * 分享按钮会一直停在「操作失败」，所以这里是硬依赖。
     */
    // #region 插件入口
    /**
     * 浏览器半用到的服务：槽位（挂按钮）、词典、到 Host 的 RPC 通道、以及设置页表单。
     *
     * `connection` 是 RPC carrier（与其他调用宿主服务的 UI 插件用法一致）；不带它时
     * 分享按钮会一直停在「操作失败」，所以这里是硬依赖。
     * `configForms` 用于「设置 → 插件 → 会话增强」里的自动压缩开关（官方设置页服务）。
     */
    const inject = ['slots', 'locale', 'connection', 'sessions', 'configForms'];

    /**
     * 挂载两个按钮，并把分享对话框的全部状态与动作绑到各自的 Session。
     *
     * 注册包在 `ctx.slots.inject(SLOT_NAME, …)` 里，而不是裸 `ctx.slots.register`：
     * 槽位名属于 `@deepseek-ai/dsh-client-ui-conversation`，浏览器插件之间的加载顺序
     * 不保证。`slots.inject` 等该槽位被声明出来后才回调注册（随附的 Session 导出插件
     * 与官方反馈插件用的都是同一写法），否则注册可能落在一个还不存在的槽位上、静默
     * 不显示。
     *
     * 每个 Session 各有一份 `inject()` 结果（renderer 按 entry × 会话缓存），所以
     * Toast / 分享快照天然是「每个会话一个」—— 两个会话同时打开时，点其中一个的按钮
     * 不会让另一个的标题栏也弹 Toast 或打开对话框。
     *
     * @param {any} ctx - 浏览器插件上下文。
     * @returns {void}
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-enhance: 词典');

      // 组件能力探测：只探测一次，结果写进 capabilityStore；分享 UI 订阅它。
      //
      // 探测**不阻塞**注册：先按"在"渲染，探测出停用后再收起。这样既不会因为
      // 一次网络抖动把按钮永久藏掉，也不会有"闪一下"的问题（正常情况探测结果与
      // 初始值一致，store 的 set 在值没变时不通知）。
      void probeComponent(RPC_CHANNEL, 'share.status').then((share) => {
        if (capabilityStore.getSnapshot().share !== share) capabilityStore.set({ share });
      });

      // 连续点击时让每条 Toast 都有新序号（key 变化 → 重新挂载 → 重新播放动画）。
      let nextSequence = 1;

      /**
       * 调 Host 半的分享 RPC，并把两种失败形态收口成一个异常。
       *
       * 成功信封是 `{ ok:true, value }`，业务失败是 `{ ok:false, error:{code,message} }`；
       * 只有传输层错误才会让 `call` 自己抛。这里把三者统一成 `Error`，调用方只需
       * `try/catch` 一处，并用 `messageOf` 取出可展示的文案。
       *
       * @param {string} method - `share.status` / `share.create` / `share.revoke`。
       * @param {Record<string, any>} payload - 方法参数。
       * @returns {Promise<any>} 成功时的 `value`。
       * @throws {Error} 传输层错误、业务失败或未提供 RPC 通道。
       */
      async function callRpc(method, payload) {
        const connection = ctx.connection;
        const rpc = connection === undefined || connection === null ? undefined : connection.rpc;
        if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') {
          throw new Error(t('share.unavailable'));
        }
        const result = await rpc.call(RPC_CHANNEL, method, payload);
        if (result !== null && typeof result === 'object' && result.ok === true) return result.value;
        const error = result !== null && typeof result === 'object' ? result.error : undefined;
        const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
        const message =
          error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : '';
        if (message !== '' && code !== '') throw new Error(message + '（' + code + '）');
        if (message !== '') throw new Error(message);
        if (code !== '') throw new Error(code);
        throw new Error(t('share.actionFailed'));
      }

      // ---- 复制会话 ID：原有贡献，行为不变 ----
      ctx.slots.inject(SLOT_NAME, () =>
        ctx.slots.register(
          {
            name: SLOT_NAME,
            id: COPY_SLOT_ID,
            order: COPY_SLOT_ORDER,
            locale: NS,
            inject: (sessionId) => {
              const store = createSnapshotStore(null);
              const id = String(sessionId === undefined || sessionId === null ? '' : sessionId);
              return {
                hooks: { toast: store },
                copy: () => {
                  if (id === '') return;
                  void writeClipboard(id).then((ok) => {
                    store.set({
                      tone: ok ? 'success' : undefined,
                      text: ok ? t('toast.copied') : t('toast.copyFailed'),
                      sequence: nextSequence++
                    });
                  });
                },
                // 只在序号仍然匹配时清空：Toast 自己也会超时调 onDone，那时用户可能
                // 已经点了第二次，不该把新的那条一起清掉。
                dismissToast: (sequence) => {
                  const current = store.getSnapshot();
                  if (current !== null && current.sequence === sequence) store.set(null);
                }
              };
            }
          },
          SessionIdCopyButton
        )
      );

      // ---- 分享会话：新增贡献 ----
      ctx.slots.inject(SLOT_NAME, () =>
        ctx.slots.register(
          {
            name: SLOT_NAME,
            id: SHARE_SLOT_ID,
            order: SHARE_SLOT_ORDER,
            locale: NS,
            inject: (sessionId) => {
              const id = String(sessionId === undefined || sessionId === null ? '' : sessionId);
              const store = createSnapshotStore(SHARE_INITIAL);
              // 每个会话一份 Toast 序号，连续操作不会吞掉前一条的动画。
              let sequence = 1;

              /** 合并快照；每次都是新对象，订阅者才会重渲染。 */
              const patch = (partial) => {
                store.update((current) => ({ ...current, ...partial }));
              };

              /** 写一条 Toast；tone 为 undefined 时用中性样式（失败场景）。 */
              const notify = (text, tone) => {
                patch({ notice: { text, tone, sequence: sequence++ } });
              };

              /**
               * 重新拉一次分享状态。
               *
               * 不重置 `open`：用户可能在请求返回前就关掉了对话框，那时不该把对话框
               * 再打开（也不该把状态清掉——关闭后状态保留是契约）。
               */
              const refresh = async () => {
                patch({ loading: true, error: '', confirmRevoke: false });
                try {
                  const value = await callRpc('share.status', { sessionId: id });
                  const shares =
                    value !== null && typeof value === 'object' && Array.isArray(value.shares) ? value.shares : [];
                  patch({ loading: false, share: shares.length > 0 ? shares[0] : null });
                } catch (error) {
                  patch({ loading: false, error: messageOf(error) });
                }
              };

              return {
                hooks: { share: store, capability: capabilityStore },
                openShare: () => {
                  if (id === '') return;
                  patch({ open: true });
                  void refresh();
                },
                // 关闭只收起对话框、清掉两段确认；已分享的链接留在快照里（契约要求
                // 「关闭后状态保留」），再次打开时 refresh 会用 Host 的最新状态覆盖它。
                closeShare: () => {
                  patch({ open: false, confirmRevoke: false });
                },
                retry: () => {
                  void refresh();
                },
                createShare: async () => {
                  patch({ busy: true, error: '', confirmRevoke: false });
                  try {
                    const value = await callRpc('share.create', { sessionId: id });
                    const share = value !== null && typeof value === 'object' ? value.share : undefined;
                    if (share === undefined || share === null || typeof share !== 'object') {
                      throw new Error(t('share.actionFailed'));
                    }
                    patch({ busy: false, share });
                    notify(t('share.toastCreated'), 'success');
                  } catch (error) {
                    patch({ busy: false, error: messageOf(error) });
                    notify(t('share.toastFailed'), undefined);
                  }
                },
                copyLink: () => {
                  const current = store.getSnapshot();
                  if (current.share === null) return;
                  void writeClipboard(current.share.url).then((ok) => {
                    notify(ok ? t('share.toastCopied') : t('toast.copyFailed'), ok ? 'success' : undefined);
                  });
                },
                openLink: () => {
                  const current = store.getSnapshot();
                  if (current.share === null) return;
                  // `noopener`：分享页是 Host 提供的独立页面，不需要拿到本页的 window。
                  // 浏览器拦截弹窗时返回 null，但不算失败（用户仍可手动复制链接）。
                  try {
                    window.open(current.share.url, '_blank', 'noopener');
                  } catch {
                    notify(t('share.toastFailed'), undefined);
                  }
                },
                downloadHtml: () => {
                  const current = store.getSnapshot();
                  if (current.share === null) return;
                  try {
                    // 用 anchor 而不是 window.open：Host 用 Content-Disposition 让浏览器
                    // 直接下载，导航式点击不会留下一个空白标签页。
                    const anchor = document.createElement('a');
                    anchor.href = withDownloadParam(current.share.url);
                    anchor.rel = 'noopener';
                    document.body.appendChild(anchor);
                    anchor.click();
                    document.body.removeChild(anchor);
                  } catch {
                    notify(t('share.toastFailed'), undefined);
                  }
                },
                // 两段式：第一次只切到确认态，第二次才真的调 revoke。
                requestRevoke: () => {
                  patch({ confirmRevoke: true });
                },
                cancelRevoke: () => {
                  patch({ confirmRevoke: false });
                },
                revokeNow: async () => {
                  const current = store.getSnapshot();
                  if (current.share === null) return;
                  patch({ busy: true, error: '' });
                  try {
                    await callRpc('share.revoke', { token: current.share.token });
                    patch({ busy: false, share: null, confirmRevoke: false });
                    notify(t('share.toastRevoked'), 'success');
                  } catch (error) {
                    patch({ busy: false, confirmRevoke: false, error: messageOf(error) });
                    notify(t('share.toastFailed'), undefined);
                  }
                },
                dismissNotice: (value) => {
                  const current = store.getSnapshot();
                  if (current.notice !== null && current.notice.sequence === value) patch({ notice: null });
                }
              };
            }
          },
          SessionShareButton
        )
      );

      // 上下文：官方 ContextMeter 面板里的「压缩」动作。
      //
      // 官方 meter 已经显示用量（系统提示词 / 工具定义 / 对话消息），所以这里不再
      // 重复做一个百分比小部件；只用一个隐藏的 session tracker 记住"当前会话是谁"，
      // 再把「压缩」动作注入官方 panel（panel 是 portal 到 body 的 role=dialog，
      // 没有 slot，只能按 DOM 特征挂载）。
      ctx.slots.inject(CONTEXT_SLOT_NAME, () =>
        ctx.slots.register(
          {
            name: CONTEXT_SLOT_NAME,
            id: CONTEXT_SLOT_ID,
            order: CONTEXT_SLOT_ORDER,
            locale: NS,
            inject: (sessionId) => {
              const tracker = createContextSessionTracker(
                String(sessionId === undefined || sessionId === null ? '' : sessionId)
              );
              return { hooks: { contextSession: tracker }, contextSession: tracker };
            }
          },
          ContextSessionTracker
        )
      );
      // 注入器：官方 panel 打开时追加动作行；卸载时清理观察器/样式/节点。
      ctx.effect(() => {
        const disposeStyle = installContextActionStyle();
        startContextPanelInjector(ctx, t);
        return () => {
          stopContextPanelInjector();
          disposeStyle();
        };
      }, 'dsh-session-enhance: context panel action');

      // 设置页：自绘「会话增强」bundle 的配置卡片（设置 → 插件 → 已安装 → 会话增强）。
      // `whileServed` 保证 Host 真的声明了这个命名空间才挂载；`configForms` 缺失时
      // （例如旧 Host）跳过设置页，不影响其它组件。
      const configForms = ctx.configForms;
      if (configForms !== undefined && configForms !== null && typeof configForms.get === 'function') {
        try {
          const card = new AutoCompactCardController(configForms.get(SETTINGS_NS));
          ctx.effect(() => () => card.dispose(), 'dsh-session-enhance: settings form subscription');
          ctx.effect(
            () =>
              configForms.whileServed([SETTINGS_NS], () =>
                ctx.slots.inject('plugins.bundle.config', () =>
                  ctx.slots.register(
                    {
                      name: 'plugins.bundle.config',
                      key: SETTINGS_NS,
                      locale: NS,
                      inject: () => card.inject()
                    },
                    AutoCompactCard
                  )
                )
              ),
            'dsh-session-enhance: settings page'
          );
        } catch (error) {
          // 设置服务不可用时静默降级：按钮与压缩仍然可用。
          void error;
        }
      }
    }
    // #endregion

    exports.apply = apply;
    exports.inject = inject;
    // 纯函数与组件导出：离线冒烟（没有浏览器、没有真实 renderer）靠它们检查合并后的
    // bundle 形状；不影响运行时。
    exports.ContextSessionTracker = ContextSessionTracker;
    exports.AutoCompactCard = AutoCompactCard;
    exports.AutoCompactToggleRow = AutoCompactToggleRow;
    exports.settingsBooleanField = settingsBooleanField;
    return module.exports;
  }
});
