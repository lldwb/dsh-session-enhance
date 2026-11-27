/**
 * `dsh-session-enhance` —— 浏览器半：会话标题栏的「梁谷」「分享会话」「复制会话 ID」
 * 与 composer 右侧的「中断重试」四个组件。
 *
 * ## 这个 bundle 里有四个组件
 *
 * 1. **会话 ID**：标题栏一键复制 session id，交给 Agent 按 id 查会话、子代理与历史；
 * 2. **会话分享**：标题栏生成只读分享链接（免登录的只读 HTML 页由 Host 半渲染）；
 * 3. **中断重试**：用户主动停止（`turn/end` 的 `aborted` + `reason.user`）后，在 composer
 *    右侧给一个「重试」圆钮，点一下让 Host 接着跑被中断的上一轮；
 * 4. **梁谷**：标题栏一个 chip，开启后本会话在高峰时段被 Host 挂起、空闲时段自动恢复，
 *    chip 上带「还要暂停多久」的倒计时。
 *
 * 「失败重试」组件（5.0.0 移除的那个，把 composer 发送按钮盖成「重试」）不再由本插件
 * 提供：DSH 0.2.2 起官方已内置模型失败重试（composer 的 `retry(failureSeq)` +
 * conversationContinuation 投影，用户可见文案「继续生成」）。第 3 个组件只补官方覆盖
 * 不到的「用户主动停止」场景，两者互斥、不重叠。
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
 * 标题栏那两个按钮都挂在同一个 `conversation.session.header.utilities` list 槽位里：
 * 分享 order -11、复制 order -10，所以从左到右是「分享、复制、⋯」—— 分享是更重的动作，
 * 放在最左。中断重试按钮不在这里：它挂在 composer 的 `conversation.input.right` 槽位
 * （主发送按钮之前），只在「上一轮被用户中断」时出现。
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
 *
 * ## 梁谷：状态由 Host 定，浏览器只做倒计时与一次点击
 *
 * 标题栏最左的 chip 是会话级「模式开关」：开启后，高峰时段由 Host 半把本会话的 agent
 * 挂起 —— 提示词留在持久化收件箱里排队、不发起任何模型调用；进入空闲时段后自动恢复。
 * 高峰时段按官方口径：北京时间周一至周五（不含法定节假日）09:00–12:00、14:00–18:00；
 * 其余时间（含周末与法定节假日全天）都是空闲时段。
 * 浏览器半只做三件事：显示状态、每秒走倒计时、把点击变成一次 `setEnabled` 调用。
 *
 * **高峰/空闲的判定一律以 Host 返回为准**（`paused`）：客户端本地算时段会和服务端的
 * 节假日表、时区配置、跨午夜规则三处对不上，一旦显示不一致，用户只会怀疑功能坏了。
 * 展示用的 idle 由 `enabled && !paused` 推出（Host 的 `idle` 是全局相位，未启用时也是
 * true）。本地只在两次轮询（15 秒）之间把倒计时走得顺滑，并以「收到响应时的本地时刻」当
 * 锚点抵消两端时钟偏差（`nextChangeAt - serverNow - 本地已过去的时间`）。
 * `status.schedule` 只用于在 title 里拼「高峰时段：周一至周五 …」，不参与判定。
 *
 * 切换失败时**保留旧状态**并弹一条 Toast（与复制按钮同款：`sequence` 当 React key）：
 * 状态以服务端为准，点击只是请求 —— 请求没成功就不该让界面先假装成功。
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
    // 侧边提问组件的标签正文用 React hooks（useState / useEffect）；`react` 也在 shell 的
    // 平台模块表里，与 jsx runtime 同源，不会引入第二份 React。
    const React = require('react');
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

      // 中断重试（composer 右侧）
      'retry.button': 'Retry',
      'retry.hint': 'Previous turn was interrupted — click to retry',
      'retry.busy': 'Retrying…',
      'retry.failed': 'Retry did not take effect ({code})',

      // 谷峰插件（标题栏 chip）：相位 + 倒计时 + 提示
      'offpeak.chip.busy': '…',
      'offpeak.queued': '{n} message(s) queued; they start when the idle window begins',
      'offpeak.toast.failed': 'Could not switch GuFeng ({code})',
      'offpeak.toast.notPersisted': 'GuFeng changed, but the setting could not be saved; it may reset after a restart',
      'offpeak.toast.noConnection': 'Not connected to the host; GuFeng did not change',
      'offpeak.readOnlyHint': 'Inherited from the parent session; it cannot be changed in a subagent session.',

      // 谷峰插件：相位 / 倒计时 / 悬浮提示（标题栏 chip 与新建页开关共用）
      'offpeak.phase.peak': 'Peak',
      'offpeak.phase.idle': 'Idle',
      'offpeak.countdown.unknown': '--',
      'offpeak.tipNormal': 'Normal session: no GuFeng limit, AI calls run as usual',
      'offpeak.tipSetIdle': 'Click to make it an "idle session": pauses at peak, runs when idle',
      'offpeak.tipPeak': 'Peak hours: AI calls are paused (messages queue up)',
      'offpeak.tipIdle': 'Idle hours: AI calls run normally',
      'offpeak.tipResumeAt': 'Enters idle at {time} and resumes automatically',
      'offpeak.tipPauseAt': 'Enters peak at {time} and pauses automatically',
      'offpeak.tipCancel': 'Click to cancel the "idle session" setting',
      'offpeak.tipBusy': 'Switching GuFeng state…',

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
      'context.decisionHint': 'Last decision: {tier} ({reason}).',
      'context.decisionPruned': 'Last decision: {tier} ({reason}); {n} tool results pruned so far.',
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
      'settings.saveFailed': 'This deployment rejected the values; they are kept for editing.',

      // 侧边提问（组件 dsh-session-enhance/sideask）
      'sideAsk.tab.title': 'Side ask',
      'sideAsk.tab.temporary': 'Temporary · read-only · archived when this tab closes',
      'sideAsk.tab.kept': 'Kept · ordinary session · stays in the session list after closing',
      'sideAsk.tab.keep': 'Keep',
      'sideAsk.tab.unkeep': 'Make temporary',
      'sideAsk.tab.keepHint': 'Keep as an ordinary session: restores the referenced session permissions (file writes allowed) and stays in the session list after closing.',
      'sideAsk.tab.creating': 'Creating the side session…',
      'sideAsk.tab.unavailable': 'This deployment has no sidebar conversation slot (sidebar.chat.conversation is unavailable).',
      'sideAsk.guide.title': 'Side ask',
      'sideAsk.guide.description': 'Create a temporary read-only session that answers by querying the referenced session through its id; the tab archives when closed.',
      'sideAsk.header.open': 'Side ask',
      'sideAsk.header.hint': 'Open a temporary read-only side session that can query this conversation by its id.',
      'sideAsk.selection.quote': 'Quote text',
      'sideAsk.selection.ask': 'Side ask',
      'sideAsk.selection.askHint': 'Ask in a read-only side session that can query this conversation by its id.',
      'sideAsk.prompt.question': 'My question:',
      'sideAsk.error.unavailable': 'Side ask is unavailable in this deployment.'
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

      // 中断重试（composer 右侧）
      'retry.button': '重试',
      'retry.hint': '上一轮被中断 —— 点击重试',
      'retry.busy': '正在重试…',
      'retry.failed': '重试未生效（{code}）',

      // 谷峰插件（标题栏 chip）：相位 + 倒计时 + 提示
      'offpeak.chip.busy': '…',
      'offpeak.queued': '队列中 {n} 条消息，空闲时段开始后自动处理',
      'offpeak.toast.failed': '切换谷峰插件失败（{code}）',
      'offpeak.toast.notPersisted': '已切换谷峰插件，但状态没能写入磁盘，重启后可能回落',
      'offpeak.toast.noConnection': '未连接到 Host，无法切换谷峰插件',
      'offpeak.readOnlyHint': '状态继承自主会话，在子智能体会话里不能修改。',

      // 谷峰插件：相位 / 倒计时 / 悬浮提示（标题栏 chip 与新建页开关共用）
      'offpeak.phase.peak': '高峰',
      'offpeak.phase.idle': '空闲',
      'offpeak.countdown.unknown': '--',
      'offpeak.tipNormal': '普通会话：不受谷峰限制，AI 调用照常',
      'offpeak.tipSetIdle': '点击设为「空闲会话」：高峰暂停、空闲运行',
      'offpeak.tipPeak': '高峰时段：已暂停 AI 调用（消息会排队）',
      'offpeak.tipIdle': '空闲时段：AI 调用正常运行',
      'offpeak.tipResumeAt': '将在 {time} 进入空闲，并自动恢复',
      'offpeak.tipPauseAt': '将在 {time} 进入高峰，并自动暂停',
      'offpeak.tipCancel': '点击可取消「空闲会话」',
      'offpeak.tipBusy': '正在切换谷峰状态…',

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
      'context.decisionHint': '最近一次决策：{tier}（{reason}）。',
      'context.decisionPruned': '最近一次决策：{tier}（{reason}）；累计已清理 {n} 个工具输出。',
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
      'settings.saveFailed': '本部署没有接受这些值，已保留供你修改。',

      // 侧边提问（组件 dsh-session-enhance/sideask）
      'sideAsk.tab.title': '侧边提问',
      'sideAsk.tab.temporary': '临时 · 只读 · 关闭标签后归档',
      'sideAsk.tab.kept': '已保留 · 普通会话 · 关闭标签后仍在会话列表',
      'sideAsk.tab.keep': '保留',
      'sideAsk.tab.unkeep': '改回临时',
      'sideAsk.tab.keepHint': '保留为普通会话：恢复参考会话的权限（可写文件），关闭标签后仍留在会话列表。',
      'sideAsk.tab.creating': '正在创建侧边会话…',
      'sideAsk.tab.unavailable': '当前部署没有可用的侧栏会话组件（sidebar.chat.conversation 席位不可用）。',
      'sideAsk.guide.title': '侧边提问',
      'sideAsk.guide.description': '开一个临时只读会话，通过会话 id 查询参考会话来回答提问；关闭标签后默认归档。',
      'sideAsk.header.open': '侧边提问',
      'sideAsk.header.hint': '在右侧栏开一个临时只读会话，可按会话 id 查询当前会话。',
      'sideAsk.selection.quote': '引用文本',
      'sideAsk.selection.ask': '侧边提问',
      'sideAsk.selection.askHint': '在只读侧边会话里提问，可让模型按会话 id 查询当前会话。',
      'sideAsk.prompt.question': '我的问题：',
      'sideAsk.error.unavailable': '当前部署不支持侧边提问。'
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
     * 梁谷 chip 的槽位 id / 顺序。
     *
     * order -12 比分享的 -11 更小，所以渲染在最左：它是「会话级模式开关」，与分享/复制
     * 这类一次性动作不是一个量级的东西，放在最左更容易被认成状态而不是普通按钮。
     */
    const OFFPEAK_SLOT_ID = 'session-offpeak';

    /** 梁谷 chip 的槽位顺序（list 槽位按 order 升序渲染）。 */
    const OFFPEAK_SLOT_ORDER = -12;

    /**
     * 「新建梁谷会话」按钮的槽位：新建会话页（hero）那一行。
     *
     * 官方 `ConversationContent` 把 `conversation.hero.options` 渲染在 workspace chip 与
     * preset 之后的 `heroOptions` 容器里，但官方 CSS 用 `margin-left:auto` 把它推到行尾；
     * 本插件注入一条 `:has()` 样式，在按钮存在时把容器拉回 preset 右侧（见
     * `installLiangguNewStyle`）。
     */
    const LIANGGU_NEW_SLOT_NAME = 'conversation.hero.options';

    /** 开关的贡献 id（`data-dsh-lianggu-hero` 定位属性与它同源）。 */
    const LIANGGU_NEW_SLOT_ID = 'lianggu-hero-toggle';

    /** 该槽位目前只有本插件一个贡献，order 0 即可。 */
    const LIANGGU_NEW_SLOT_ORDER = 0;

    /**
     * 两处谷峰开关的尺寸与排布（用户 2026-11-27：既固定又紧凑）。
     *
     * **固定 103px** = padding 16 + 图标 15 + gap 2 + 相位 24 + gap 2 + 倒计时槽 44：
     * 槽宽按**最长文案**定（`14h48m` / `59m59s` 实测 43px，留 1px 余量）；更短的倒计时
     * （`1h23m` ≈ 37px）在槽内**居中**，左右各只差约 3px —— 既不像左对齐那样把 6px 全堆
     * 在右侧，也不像右对齐那样堆在相位与倒计时之间，肉眼几乎看不出空档。
     *
     * 高度固定 24px；相位区固定 24px，所以图标/相位位置也不随状态变化。
     */
    const OFFPEAK_PILL_WIDTH = '103px';
    const OFFPEAK_PILL_HEIGHT = '24px';
    const OFFPEAK_NAME_WIDTH = '24px';
    /** 段间间距：2px（比官方的 4px 紧）。 */
    const OFFPEAK_PILL_GAP = '2px';

    /** 倒计时进入「紧迫」的阈值：剩余 ≤ 60s 起有动效，≤ 10s 更急促。 */
    const OFFPEAK_URGENT_MS = 60_000;
    const OFFPEAK_FINAL_MS = 10_000;

    /**
     * 中断重试按钮的槽位名：官方 composer 右侧、主发送按钮之前。
     *
     * 这是官方 `conversation.input.right` slot（session scope，按会话注入），所以按钮
     * 天然落在输入框那一行、不会挡住发送；不是标题栏槽位，别和上面三个混用。
     */
    const RETRY_SLOT_NAME = 'conversation.input.right';

    /** 中断重试贡献的 id（`data-interrupted-retry` 定位属性与它不同源，这里只做槽位标识）。 */
    const RETRY_SLOT_ID = 'session-interrupted-retry';

    /** 该槽位目前只有本插件一个贡献，order 0 即可（不抢别人的位置）。 */
    const RETRY_SLOT_ORDER = 0;

    /**
     * Host 半 `lib/rpc.mjs` 注册的前缀路由。
     *
     * 客户端不能 import Host 包，所以这个字符串在这里重复一遍；改名时必须同时改
     * `lib/rpc.mjs` 里的前缀，否则按钮点了只会报「操作失败」。
     */
    const RPC_CHANNEL = '/dsh-session-enhance';

    /**
     * 中断重试的 Host 通道（`lib/retry/rpc.mjs` 注册）。
     *
     * 与分享通道分开：分享走 `/dsh-session-enhance`，中断重试走这里（端点
     * `pending` / `retry` / `diag`）。改名时必须与 Host 半一起改，否则按钮点了只会
     * 显示「重试未生效」。
     */
    const RETRY_RPC_CHANNEL = '/dsh-session-enhance-retry';

    /**
     * 梁谷会话的 Host 通道（Host 半见 `lib/offpeak/rpc.mjs`）。
     *
     * 与分享/中断重试一样：客户端不能 import Host 包，这个字符串在这里重复一遍；改名时
     * 必须与 Host 半一起改，否则 chip 点了只会报「切换梁谷会话失败」。
     */
    const OFFPEAK_RPC_CHANNEL = '/dsh-session-enhance-offpeak';

    /**
     * 梁谷状态的轮询间隔（毫秒）。
     *
     * 1 秒 tick 只负责让 chip 上的倒计时走得顺滑；「现在到底是高峰时段还是空闲时段」由 Host
     * 判定，所以每 15 秒向 Host 对齐一次（外加到点 `nextChangeAt` 时的即时对齐）。
     */
    const OFFPEAK_POLL_INTERVAL = 15_000;

    /** 倒计时 tick 间隔（毫秒）。 */
    const OFFPEAK_TICK_INTERVAL = 1_000;

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
     * 三个 Host 组件行（会话分享 / 中断重试 / 梁谷会话）的启用状态（浏览器半据此决定
     * 要不要渲染对应 UI）。
     *
     * ## 为什么需要探测
     *
     * 浏览器半是**包级一份**（`dsh.client` 不能按行拆），只要承载它的第一行还在，
     * 它就一定被加载。而 Host 侧的「会话分享」「中断重试」「梁谷会话」是三条独立的
     * Loader 行，可以在「设置 → 插件 → 会话增强 → 包含的组件」里单独停用。停用之后
     * 它们注册的 RPC 前缀路由不再存在，请求会落到 SPA fallback —— 于是按钮还挂在
     * 标题栏 / composer 上，点一下却永远失败。这才是"组件拆了但边界没生效"。
     *
     * ## 信号
     *
     * Host 的 prefix 路由只在对应行启用时注册。实测（2026-10-28，真实 Loader）：
     *
     * - 组件在 → `POST /dsh-session-enhance`（分享）/ `POST /dsh-session-enhance-retry`
     *   （中断重试）/ `POST /dsh-session-enhance-offpeak`（梁谷会话）返回 **200** +
     *   业务信封；
     * - 组件停用 → 落到 SPA fallback，返回 **405**、空 body。
     *
     * 所以 `200 = 在`、`405 = 停用`。其它状态（401 / 5xx / 网络异常）无法判定，
     * 一律按"在"处理（乐观）——宁可多一个按钮，也不要把正在工作的按钮撤掉。
     */
    const CAPABILITY_INITIAL = { share: true, retry: true, offpeak: true };

    /**
     * 能力快照源：`{ share, retry, offpeak }` 三个布尔值，分享 UI、中断重试 UI 与梁谷
     * chip 各订阅自己那一路（`value.share` / `value.retry` / `value.offpeak`）。
     */
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

    // #region 中断重试
    /**
     * 「重试」图标：一对顺时针循环箭头（被中断 = 上一轮半途停下，重试就是接着跑）。
     *
     * 与复制/分享图标同样的自绘路线（不赌 primitives 的图标导出名），`currentColor`
     * 描边、颜色由按钮继承；`busy` 时的旋转由文档级样式表里的 keyframes 驱动。
     *
     * @param {boolean} busy - 是否正在重试。
     * @returns {any} 17×17 的 SVG 元素。
     */
    function retryIcon(busy) {
      return jsxs('svg', {
        width: 17,
        height: 17,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: {
          display: 'block',
          ...(busy === true ? { animation: 'dsh-interrupted-retry-spin 900ms linear infinite' } : {})
        },
        children: [
          jsx('path', { d: 'M4.1 7.9a6.2 6.2 0 0 1 10.9-1.6' }),
          jsx('path', { d: 'M15.2 2.9v2.7h-2.7' }),
          jsx('path', { d: 'M15.9 12.1a6.2 6.2 0 0 1-10.9 1.6' }),
          jsx('path', { d: 'M4.8 17.1v-2.7h2.7' })
        ]
      });
    }

    /**
     * 中断重试按钮的文档级样式：旋转动画 + 本插件选择器的 hover/disabled 规则。
     *
     * 只写 `[data-dsh-interrupted-retry-button]`（不碰官方 CSS class）；按钮的尺寸、
     * 色板与圆角仍走内联样式。卸载时整条移除，不在页面里留垃圾。
     *
     * @returns {() => void} 清理函数。
     */
    function installInterruptedRetryStyle() {
      if (typeof document === 'undefined') return () => {};
      const style = document.createElement('style');
      style.setAttribute('data-dsh-enhance-retry-style', '');
      style.textContent = [
        '@keyframes dsh-interrupted-retry-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
        '[data-dsh-interrupted-retry-button]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.14));}',
        '[data-dsh-interrupted-retry-button]:disabled{opacity:.4;cursor:default;}'
      ].join('');
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    /**
     * 每个会话一份的「中断重试」快照源，状态为
     * `{ kind: 'hidden'|'ready'|'busy'|'failed', code? }`。
     *
     * 只在「上一轮被用户主动中断」时显示按钮：
     *
     * - 会话正在跑（`session.running === true`）或挂着子智能体时一律隐藏 —— 这两种
     *   状态下不存在"被中断的上一轮"可重试；
     * - 否则问 Host 的 `pending`：有可重试记录 → ready，没有 → hidden。
     *
     * `session/event` 与 session 快照的订阅让按钮跟着事件流即时出现/消失；Host 的内存
     * 记录会因重启丢失，所以 ready 时每 30 秒再查一次自愈。
     *
     * @param {any} ctx - 浏览器插件上下文。
     * @param {string} sessionId - 当前会话 id。
     * @returns {any} `{ getSnapshot, subscribe, retry, dispose }`。
     */
    function createInterruptedRetry(ctx, sessionId) {
      const hidden = Object.freeze({ kind: 'hidden' });
      const base = createSnapshotStore(hidden);
      let listeners = 0;
      let binding;
      let unsubscribeEvents;
      let unsubscribeSession;
      let recheckTimer;
      let failTimer;
      let inflight = false;
      let disposed = false;

      /**
       * 调 Host 的 retry 通道。
       *
       * 没连上时返回 undefined（调用方按 NO_CONNECTION 收口）；传输层异常照抛，
       * 调用方按 TRANSPORT 收口。`connection` 缺失是合法状态（设置页/旧 Host），
       * 不该让按钮炸掉。
       */
      const call = async (method, payload) => {
        const connection = ctx.connection;
        if (connection === undefined || connection === null) return undefined;
        const rpc = connection.rpc;
        if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') return undefined;
        return rpc.call(RETRY_RPC_CHANNEL, method, payload);
      };

      /** 从 RPC 信封里取 value（失败返回 undefined）。 */
      const valueOf = (result) =>
        result !== null && typeof result === 'object' && result.ok === true ? result.value : undefined;

      /** 从失败的 RPC 信封里取错误码。 */
      const codeOf = (result) => {
        const error = result !== null && typeof result === 'object' ? result.error : undefined;
        return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined;
      };

      const emit = (next) => base.set(next);

      const clearRecheck = () => {
        if (recheckTimer !== undefined) {
          clearTimeout(recheckTimer);
          recheckTimer = undefined;
        }
      };

      /** ready 时每 30 秒复查一次：Host 重启丢了记录时按钮要能自己消失。 */
      const scheduleRecheck = () => {
        if (disposed || recheckTimer !== undefined) return;
        recheckTimer = setTimeout(() => {
          recheckTimer = undefined;
          if (disposed) return;
          if (base.getSnapshot().kind === 'ready') void refresh();
        }, 30_000);
      };

      /** 读当前会话快照（拿不到时返回 undefined，按"不确定"处理）。 */
      const sessionSnapshot = () => {
        if (binding === undefined || binding === null) return undefined;
        const session = binding.session;
        if (session === undefined || session === null || typeof session.getSnapshot !== 'function') return undefined;
        try {
          return session.getSnapshot();
        } catch {
          return undefined;
        }
      };

      /**
       * 重查一次「有没有可重试的中断」。
       *
       * 先看本地的运行态再问 Host：会话在跑 / 挂着子智能体时直接隐藏，不发请求。
       * `inflight` 防并发重入（事件流可能密集触发）。
       */
      const refresh = async () => {
        if (disposed || inflight || sessionId === '') return;
        const session = sessionSnapshot();
        const running = session !== null && session !== undefined && typeof session === 'object' ? session.running : undefined;
        const subagent = session !== null && session !== undefined && typeof session === 'object' ? session.subagent : undefined;
        if (running === true || (subagent !== undefined && subagent !== null)) {
          emit(hidden);
          clearRecheck();
          return;
        }
        inflight = true;
        try {
          const value = valueOf(await call('pending', { sessionId }));
          if (disposed) return;
          const recoverable = value !== null && typeof value === 'object' ? value.recoverable : undefined;
          if (recoverable !== null && typeof recoverable === 'object') {
            const current = base.getSnapshot();
            // 正在重试的请求还没回来时不要把它打回 ready（否则按钮会闪一下）。
            emit(current.kind === 'busy' ? current : { kind: 'ready', turn: recoverable.turn });
            scheduleRecheck();
          } else {
            emit(hidden);
            clearRecheck();
          }
        } catch {
          // 传输抖动不改状态：宁可保留当前按钮，也不要闪一下；下一次事件会再查。
        } finally {
          inflight = false;
        }
      };

      /** 点一下「重试」：把记录交给 Host，由 Host 发一条中性消息驱动新的一轮。 */
      const retry = async () => {
        if (disposed) return;
        const current = base.getSnapshot();
        if (current.kind !== 'ready') return;
        if (failTimer !== undefined) {
          clearTimeout(failTimer);
          failTimer = undefined;
        }
        emit({ kind: 'busy' });
        /** 失败态展示 3 秒，然后回 hidden 并重查（记录此时可能已被 Host 取走/过期）。 */
        const showFailure = (code) => {
          if (disposed) return;
          emit({ kind: 'failed', code });
          failTimer = setTimeout(() => {
            failTimer = undefined;
            if (disposed) return;
            emit(hidden);
            void refresh();
          }, 3_000);
        };
        try {
          const result = await call('retry', { sessionId });
          if (disposed) return;
          if (result === undefined) {
            showFailure('NO_CONNECTION');
            return;
          }
          if (valueOf(result) !== undefined) {
            // 成功：先隐藏。Host 用掉了记录（pending 会回到 null），新的一轮开始
            // 时事件流会重新判定；这里不主动 refresh，避免旧记录残留导致闪回。
            emit(hidden);
            clearRecheck();
            return;
          }
          showFailure(codeOf(result) ?? 'UNKNOWN');
        } catch {
          showFailure('TRANSPORT');
        }
      };

      /** 事件流很密（每个 token 都有事件），但这个回调只做一次本地判断，开销可忽略。 */
      const onChange = () => {
        void refresh();
      };

      const start = () => {
        const sessions = ctx.sessions;
        if (sessions !== undefined && sessions !== null && typeof sessions.binding === 'function') {
          try {
            binding = sessions.binding(sessionId);
          } catch {
            binding = undefined;
          }
          if (binding !== undefined && binding !== null) {
            if (
              binding.eventSource !== undefined &&
              binding.eventSource !== null &&
              typeof binding.eventSource.subscribe === 'function'
            ) {
              unsubscribeEvents = binding.eventSource.subscribe(onChange);
            }
            if (binding.session !== undefined && binding.session !== null && typeof binding.session.subscribe === 'function') {
              unsubscribeSession = binding.session.subscribe(onChange);
            }
          }
        }
        void refresh();
      };

      const stop = () => {
        if (unsubscribeEvents !== undefined) {
          unsubscribeEvents();
          unsubscribeEvents = undefined;
        }
        if (unsubscribeSession !== undefined) {
          unsubscribeSession();
          unsubscribeSession = undefined;
        }
        clearRecheck();
        if (failTimer !== undefined) {
          clearTimeout(failTimer);
          failTimer = undefined;
        }
        binding = undefined;
      };

      return {
        getSnapshot: base.getSnapshot,
        subscribe: (listener) => {
          listeners += 1;
          // 首个订阅者出现才启动：renderer 卸载按钮后没必要继续订阅事件流。
          if (listeners === 1) start();
          const unsubscribe = base.subscribe(listener);
          return () => {
            unsubscribe();
            listeners -= 1;
            if (listeners === 0) stop();
          };
        },
        retry,
        dispose: () => {
          disposed = true;
          stop();
        }
      };
    }

    /**
     * composer 右侧的「中断重试」圆钮。
     *
     * hooks 顺序固定：先读状态、再读能力探测，两者都在提前 return 之前调用。
     * 隐藏时返回隐藏占位而不是 null —— 组件保持挂载，订阅才不会被拆掉（用户点停止后
     * Host 的记录经事件流到达，按钮要能立刻出现）。
     *
     * @param {any} props - 槽位注入的 props。
     * @returns {any} 按钮或隐藏占位。
     */
    function InterruptedRetryButton(props) {
      const state = props.useInterruptedRetry((value) => value);
      const capability = props.useCapability((value) => value.retry);
      const t = props.t;
      const kind = state === null || state === undefined ? 'hidden' : state.kind;
      if (capability === false || kind === 'hidden' || kind === undefined) {
        return jsx('span', { style: { display: 'none' }, 'data-interrupted-retry': 'hidden' });
      }
      const busy = kind === 'busy';
      const failed = kind === 'failed';
      const code = failed && state.code !== undefined ? String(state.code) : '';
      const title = failed
        ? t('retry.failed', { code: code === '' ? 'UNKNOWN' : code })
        : busy
          ? t('retry.busy')
          : t('retry.hint');
      return jsx('button', {
        type: 'button',
        'data-dsh-interrupted-retry-button': '',
        'data-interrupted-retry': kind,
        ...(failed ? { 'data-retry-failed': '' } : {}),
        title,
        'aria-label': title,
        disabled: busy,
        style: {
          width: '28px',
          height: '28px',
          minWidth: '28px',
          padding: 0,
          flex: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRadius: '999px',
          background: 'transparent',
          cursor: busy ? 'default' : 'pointer',
          color: failed ? 'var(--dsw-alias-label-danger, #d92d20)' : 'var(--dsw-alias-label-secondary, currentColor)'
        },
        onClick: () => {
          void props.interruptedRetry.retry();
        },
        children: retryIcon(busy)
      });
    }
    // #endregion

    // #region 梁谷（标题栏 chip）
    //
    // 「梁谷」是会话级的模式开关：开启后，高峰时段由 Host 半把本会话的 agent 挂起 ——
    // 提示词留在持久化收件箱里排队、不会发起任何模型调用；空闲时段自动恢复。
    // 高峰时段按官方口径：北京时间周一至周五（不含法定节假日）09:00–12:00、
    // 14:00–18:00；其余时间（含周末与法定节假日全天）都是空闲时段。
    //
    // 浏览器半只做三件事：显示当前状态、每秒走一次倒计时、把点击变成一次 `setEnabled`
    // 调用。
    //
    // 为什么状态不自己算：高峰/空闲的判定、排队条数、以及"agent 是否真的被挂起"都在
    // Host（它才是能 hold 住 agent 的那一侧，也只有它知道法定节假日表）。客户端本地算
    // 时段会和节假日表、时区配置、跨午夜规则三处对不上，用户看到不一致时只会怀疑功能
    // 坏了 —— 所以 `paused` 一律以 Host 返回为准；展示用的 idle 由 `enabled && !paused`
    // 推出（Host 的 `idle` 是全局相位，未启用时也是 true，不能直接拿来决定 chip 状态）。
    // 本地只负责在两次轮询之间把倒计时走得顺滑。
    //
    // 倒计时为什么以「收到响应时的本地时刻」为锚点：`serverNow` 与 `nextChangeAt` 都是
    // 服务端时钟的绝对毫秒，直接拿本地 `Date.now()` 去减会掺进两端时钟偏差（差几分钟
    // 就显示成「马上恢复」或「还要 3 小时」）。用
    // `nextChangeAt - serverNow - 本地已过去的时间` 才把偏差抵消掉。
    //
    // `status.schedule` 只用于展示（title 里拼「高峰时段：周一至周五 …」），不参与判定。

    /**
     * 梁谷快照的初始值。
     *
     * - `status`：Host 最近一次返回的原样对象（null = 还没读到）；
     * - `busy`：切换请求进行中（chip 显示「…」并禁用）；
     * - `notice`：失败 Toast（与复制按钮同款 `{text,tone,sequence}`）；
     * - `countdownMs`：本地每秒重算的「距下一次自动变化还有多久」，只用于展示。
     */
    const OFFPEAK_INITIAL = Object.freeze({
      status: null,
      busy: false,
      notice: null,
      countdownMs: null
    });

    /**
     * 相位图标（标题栏 chip 与新建页开关共用）：**高峰 = 太阳；空闲 = 弯月 + 小星星**。
     *
     * primitives 里没有太阳/月亮导出，所以用内联 SVG（15px、currentColor、1.2 描边）。
     *
     * @param {'peak'|'idle'} phase - 相位。
     * @returns {any} 15×15 的 SVG 元素。
     */
    function offpeakStatusIcon(phase) {
      if (phase !== 'idle') {
        const rays = [];
        for (let index = 0; index < 8; index += 1) {
          const angle = (Math.PI / 4) * index;
          rays.push(
            jsx('line', {
              x1: 8 + Math.cos(angle) * 5.6,
              y1: 8 + Math.sin(angle) * 5.6,
              x2: 8 + Math.cos(angle) * 7.2,
              y2: 8 + Math.sin(angle) * 7.2,
              stroke: 'currentColor',
              strokeWidth: 1.2,
              strokeLinecap: 'round'
            })
          );
        }
        return jsxs('svg', {
          width: 15,
          height: 15,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          children: [jsx('circle', { cx: 8, cy: 8, r: 3.2, stroke: 'currentColor', strokeWidth: 1.2 }), ...rays]
        });
      }
      // 弯月 + 右上角小星星（用户指定：月亮旁边有一颗四角星）。
      return jsxs('svg', {
        width: 15,
        height: 15,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        children: [
          jsx('path', {
            d: 'M10.9 9.6A4.9 4.9 0 0 1 5.5 4.2a4.9 4.9 0 1 0 5.4 5.4Z',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinejoin: 'round'
          }),
          jsx('path', {
            d: 'M12.5 3.1l.55 1.35 1.35.55-1.35.55-.55 1.35-.55-1.35-1.35-.55 1.35-.55z',
            fill: 'currentColor',
            stroke: 'none'
          })
        ]
      });
    }

    /**
     * 梁谷 chip 的文档级样式：hover / disabled 与暂停态的 hover 底色。
     *
     * 尺寸、圆角与状态色仍走内联样式；这里只写本插件自己的
     * `[data-dsh-offpeak-button]` 选择器，不碰官方 CSS class。卸载时整条移除。
     *
     * @returns {() => void} 清理函数。
     */
    function installOffpeakStyle() {
      if (typeof document === 'undefined') return () => {};
      const style = document.createElement('style');
      style.setAttribute('data-dsh-enhance-offpeak-style', '');
      style.textContent = [
        '[data-dsh-offpeak-button]{transition:background-color .12s ease,color .12s ease;}',
        '[data-dsh-offpeak-button]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));}',
        '[data-dsh-offpeak-button][data-offpeak-state="paused"]:hover:not(:disabled){background:var(--dsw-alias-state-warn-tertiary,rgba(245,158,11,.18));}',
        '[data-dsh-offpeak-button]:disabled{opacity:.55;cursor:default;}'
      ].join('');
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    /**
     * 倒计时的「紧迫级别」：剩余 ≤60s 起给 Pill 加动效钩子（高峰/空闲、选中/未选中都生效）。
     *
     * @param {any} snapshot - 控制器快照。
     * @returns {''|'urgent'|'final'} 级别。
     */
    function offpeakUrgency(snapshot) {
      const ms = snapshot === null || snapshot === undefined ? undefined : snapshot.countdownMs;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
      if (ms <= OFFPEAK_FINAL_MS) return 'final';
      if (ms <= OFFPEAK_URGENT_MS) return 'urgent';
      return '';
    }

    /**
     * 倒计时紧迫感的样式（两处开关共用，只注入一次）：
     * 平时完全静态；剩余 ≤60s 开始呼吸闪烁（内描边 + 轻微透明变化），≤10s 加快并加粗数字。
     * 数字用 `tabular-nums` 等宽，避免每秒跳动时文本宽度变化。
     *
     * @returns {() => void} 卸载函数。
     */
    function installOffpeakMotionStyle() {
      if (typeof document === 'undefined') return () => {};
      const style = document.createElement('style');
      style.setAttribute('data-dsh-enhance-offpeak-motion', '');
      style.textContent = [
        '[data-offpeak-urgent]{font-variant-numeric:tabular-nums;}',
        '@keyframes dsh-offpeak-urgent-throb{0%,100%{box-shadow:inset 0 0 0 1px currentColor;opacity:1;}50%{box-shadow:inset 0 0 0 1px transparent;opacity:.66;}}',
        '[data-offpeak-urgent="urgent"]{animation:dsh-offpeak-urgent-throb 1s ease-in-out infinite;}',
        '[data-offpeak-urgent="final"]{animation:dsh-offpeak-urgent-throb .45s ease-in-out infinite;font-weight:600;}',
        '@media (prefers-reduced-motion: reduce){[data-offpeak-urgent]{animation:none;}}'
      ].join('');
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    /**
     * 把剩余毫秒格式化成 chip / 开关里的短倒计时。
     *
     * 口径（用户指定）：
     * - 剩余 **> 1 小时** → `3h05m`（小时 + 两位分钟）；
     * - 1 分钟 ~ 1 小时 → `12m34s`（分钟 + 两位秒）；1 小时整点是 `60m00s`；
     * - 不足 1 分钟 → `37s`（**省略 `0m`**，用户 2026-11-26 明确要求）。
     * 负数与非法值一律按 0 处理（显示 `0s`），服务端时钟刚过界时宁可显示 `0s`。
     *
     * @param {unknown} ms - 剩余毫秒。
     * @returns {string} 例如 `3h05m` / `12m34s` / `0m42s` / `0m00s`。
     */
    function formatOffpeakCountdown(ms) {
      const totalSeconds = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
      const pad = (value) => String(value).padStart(2, '0');
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      if (totalSeconds > 3600) return `${hours}h${pad(minutes)}m`;
      // ≤ 1 小时按「分钟秒」；不足 1 分钟时省略「0m」，直接显示 `37s`。
      if (totalSeconds < 60) return `${seconds}s`;
      return `${Math.floor(totalSeconds / 60)}m${pad(seconds)}s`;
    }

    /** 官方高峰时段（展示兜底；Host 正常会在 `status.schedule.peakWindows` 里给出）。 */
    const DEFAULT_PEAK_WINDOWS = Object.freeze(['09:00-12:00', '14:00-18:00']);

    /**
     * 把 Host 的 `schedule.peakWindows`（`['09:00-12:00', '14:00-18:00']`）拼成 title 里的
     * 时段文本：分隔连字符统一成 en dash `–`、小时补零，再用调用方给的连接符（zh「、」/
     * en「, 」）连起来。
     *
     * 空数组 / 非数组 / 全是空串时退回 {@link DEFAULT_PEAK_WINDOWS}：title 里少一段说明
     * 比显示「高峰时段：」后面空着好。
     *
     * @param {unknown} peakWindows - Host 返回的时段数组（`'HH:MM-HH:MM'`）。
     * @param {unknown} joiner - 连接符（随语言）。
     * @returns {string} 例如 `09:00–12:00、14:00–18:00`。
     */
    function formatPeakWindowList(peakWindows, joiner) {
      const separator = typeof joiner === 'string' ? joiner : '、';
      const source = Array.isArray(peakWindows) && peakWindows.length > 0 ? peakWindows : DEFAULT_PEAK_WINDOWS;
      const normalizeClock = (value) => {
        const parts = String(value).split(':');
        if (parts.length !== 2) return String(value);
        const hour = Number(parts[0]);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) return String(value);
        return `${String(hour).padStart(2, '0')}:${parts[1]}`;
      };
      const formatOne = (entry) => {
        if (typeof entry !== 'string') return '';
        const text = entry.trim();
        if (text === '') return '';
        const match = /^(\d{1,2}:\d{2})\s*[-–~～]\s*(\d{1,2}:\d{2})$/.exec(text);
        if (match === null) return text;
        return `${normalizeClock(match[1])}–${normalizeClock(match[2])}`;
      };
      const parts = [];
      for (const entry of source) {
        const formatted = formatOne(entry);
        if (formatted !== '') parts.push(formatted);
      }
      if (parts.length === 0) {
        return DEFAULT_PEAK_WINDOWS.map((entry) => formatOne(entry)).join(separator);
      }
      return parts.join(separator);
    }

    /**
     * 把绝对毫秒按配置时区格式化成 `HH:MM`（title 里的「将在 … 自动恢复」用）。
     *
     * `hourCycle: 'h23'` 是刻意写的：只写 `hour12: false` 时部分 locale 会输出
     * `24:30` 而不是 `00:30`。时区非法 / Intl 不可用时退到本机时区：宁可时间偏一点，
     * 也不要整条提示消失。
     *
     * @param {unknown} epochMs - 绝对毫秒（`nextChangeAt` 就是这种）。
     * @param {unknown} timeZone - IANA 时区名（来自 Host 的 `window.timeZone`）。
     * @returns {string} 例如 `08:30`；非法输入返回空串。
     */
    function formatOffpeakClock(epochMs, timeZone) {
      if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '';
      const date = new Date(epochMs);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      try {
        const formatter = new Intl.DateTimeFormat('en-GB', {
          ...(typeof timeZone === 'string' && timeZone !== '' ? { timeZone } : {}),
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23'
        });
        return formatter.format(date);
      } catch {
        return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      }
    }

    /**
     * 由快照得出 chip 的四个状态之一：`off` / `paused` / `idle` / `busy`。
     *
     * 纯函数（不读时间、不碰 DOM），既给组件用也给离线单测用。判据只有 Host 返回的
     * `enabled` / `paused` 两个字段 —— 客户端不自己判断「现在是不是高峰时段」：
     * 启用且暂停 = paused，启用且未暂停 = idle（空闲时段正常运行）。
     *
     * @param {unknown} snapshot - 控制器快照（`{ status, busy, ... }`）。
     * @returns {'off'|'paused'|'idle'|'busy'} 状态。
     */
    function offpeakViewState(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return 'off';
      if (snapshot.busy === true) return 'busy';
      const status = snapshot.status;
      if (status === null || typeof status !== 'object') return 'off';
      if (status.enabled !== true) return 'off';
      return status.paused === true ? 'paused' : 'idle';
    }

    /**
     * 本地剩余时间 = `nextChangeAt - serverNow - 收到响应后本地已过去的毫秒`。
     *
     * @param {unknown} status - Host 状态。
     * @param {number} receivedAt - 收到该响应的本地时刻（`Date.now()`）。
     * @param {number} now - 当前本地时刻。
     * @returns {number|null} 剩余毫秒；未启用 / 字段缺失时 null。
     */
    function offpeakCountdownOf(status, receivedAt, now) {
      if (status === null || typeof status !== 'object') return null;
      // 未选中（普通会话）也要显示相位倒计时，所以这里不再要求 enabled。
      const nextChangeAt = status.nextChangeAt;
      const serverNow = status.serverNow;
      if (typeof nextChangeAt !== 'number' || !Number.isFinite(nextChangeAt)) return null;
      if (typeof serverNow !== 'number' || !Number.isFinite(serverNow)) return null;
      const elapsed = typeof receivedAt === 'number' ? Math.max(0, now - receivedAt) : 0;
      return nextChangeAt - serverNow - elapsed;
    }

    /**
     * 每个会话一份的「梁谷会话」控制器：状态、倒计时、轮询与切换动作。
     *
     * 订阅者（renderer 的 `useSyncExternalStore`）归零时停表：标题栏卸载后没必要继续
     * 每秒 tick / 每 15 秒轮询。再次出现订阅者时立即重拉一次状态，所以切回会话、刷新
     * 页面都不会停在上一次的快照上。
     *
     * 控制器**不判断**高峰时段/空闲时段，只负责把 Host 的结论搬进快照；RPC 失败只影响 Toast，
     * 不影响聊天本身 —— 即使整条通道不可用，会话照旧能用，只是 chip 显示不了状态。
     *
     * @param {any} ctx - 浏览器插件上下文（用 `connection.rpc` 发请求）。
     * @param {string} sessionId - 当前会话 id（空串 = 不发请求）。
     * @param {(key: string, params?: any) => string} t - 词典绑定（Toast 文案）。
     * @returns {{ getSnapshot: () => any, subscribe: (listener: () => void) => () => void, toggle: () => Promise<void>, refresh: () => Promise<void>, dismissNotice: (sequence: number) => void, dispose: () => void }} 控制器。
     */
    function createOffpeakControl(ctx, sessionId, t) {
      const base = createSnapshotStore(OFFPEAK_INITIAL);
      let listeners = 0;
      let pollTimer;
      let tickTimer;
      let receivedAt = 0;
      let inflight = false;
      let toggling = false;
      let disposed = false;
      let crossed = false;
      let sequence = 1;

      /** 调 Host 的梁谷通道；没连上时返回 undefined（调用方按 NO_CONNECTION 收口）。 */
      const call = async (method, payload) => {
        const connection = ctx.connection;
        if (connection === undefined || connection === null) return undefined;
        const rpc = connection.rpc;
        if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') return undefined;
        return rpc.call(OFFPEAK_RPC_CHANNEL, method, payload);
      };

      /** 从 RPC 信封里取 value（失败返回 undefined）。 */
      const valueOf = (result) =>
        result !== null && typeof result === 'object' && result.ok === true ? result.value : undefined;

      /** 从失败的 RPC 信封里取错误码。 */
      const codeOf = (result) => {
        const error = result !== null && typeof result === 'object' ? result.error : undefined;
        return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined;
      };

      /** 展示用倒计时：负数截成 0，避免 chip 上出现 `-1s`。 */
      const displayCountdown = (raw) => (raw === null ? null : Math.max(0, raw));

      /** 写一条失败 Toast。成功不弹：状态本身已经是反馈，多一条只会吵。 */
      const notifyFailure = (code) => {
        const text =
          code === 'NO_CONNECTION' || code === 'TRANSPORT'
            ? t('offpeak.toast.noConnection')
            : t('offpeak.toast.failed', { code: code === undefined || code === '' ? 'UNKNOWN' : code });
        base.update((current) => ({ ...current, notice: { text, sequence: sequence++ } }));
      };

      /**
       * 写入一次 Host 状态，并把倒计时锚点一起更新。
       *
       * `crossed`（「已经到点、已向 Host 对齐过」）只在「新 deadline 还在未来」时才
       * 复位：服务端时钟比本地慢时，可能连续几次都返回「仍是暂停、同一个已过期的
       * nextChangeAt」，若无条件复位就会退化成每秒重拉一次。
       *
       * @param {any} status - Host 返回的状态对象。
       * @param {number} at - 收到响应的本地时刻。
       * @returns {void}
       */
      const applyStatus = (status, at) => {
        const previous = base.getSnapshot().status;
        const sameDeadline =
          previous !== null &&
          typeof previous === 'object' &&
          status !== null &&
          typeof status === 'object' &&
          previous.nextChangeAt === status.nextChangeAt &&
          previous.paused === status.paused;
        receivedAt = at;
        // 只有「新 deadline 还在未来」才允许复位：服务端时钟偏慢时会连续几次返回
        // 「仍是高峰时段、同一个已过期的 nextChangeAt」，若按「deadline 变了」复位，
        // 就会退化成每秒重拉一次。
        const fresh = offpeakCountdownOf(status, at, at);
        if (!sameDeadline && fresh !== null && fresh > 0) crossed = false;
        const countdown = displayCountdown(offpeakCountdownOf(status, receivedAt, at));
        base.update((current) => ({ ...current, status, countdownMs: countdown }));
      };

      /**
       * 重读一次状态。
       *
       * 失败（传输异常 / 空 value）**不改状态**：宁可让界面停在旧状态，也不要闪一下
       * 「关闭」；下一次轮询或点按会再对齐。
       *
       * @returns {Promise<void>} 完成。
       */
      const refresh = async () => {
        if (disposed || inflight || sessionId === '') return;
        inflight = true;
        try {
          const value = valueOf(await call('status', { sessionId }));
          if (disposed || value === undefined) return;
          applyStatus(value, Date.now());
        } catch {
          // 传输抖动不改状态：保留上一次的显示，15 秒后自动重试。
        } finally {
          inflight = false;
        }
      };

      /**
       * 每秒 tick：更新「到下一次相位切换」的倒计时；到点立刻向 Host 对齐。
       *
       * 现在高峰/空闲两个状态都显示倒计时，且**未选中（普通会话）也照常显示**当前相位，
       * 所以 tick 不再以 `enabled` 为前提。
       *
       * @returns {void}
       */
      const tick = () => {
        if (disposed) return;
        const current = base.getSnapshot();
        const status = current.status;
        if (status === null || typeof status !== 'object') return;
        const remaining = offpeakCountdownOf(status, receivedAt, Date.now());
        if (remaining !== null) {
          const display = displayCountdown(remaining);
          if (display !== current.countdownMs) {
            base.update((state) => ({ ...state, countdownMs: display }));
          }
        }
        if (remaining !== null && remaining <= 0 && !crossed) {
          crossed = true;
          void refresh();
        }
      };

      /**
       * 点一下 chip：先 busy，再按服务端返回更新；失败保留旧状态并弹 Toast。
       *
       * 目标值取**服务端上次说的** `enabled` 取反，而不是本地缓存的点击次数 —— 这样即使
       * 用户在别处（另一个标签页）改过开关，点一下也不会把状态点回反方向。
       *
       * @returns {Promise<void>} 完成。
       */
      const toggle = async () => {
        if (disposed || toggling || sessionId === '') return;
        const current = base.getSnapshot();
        const status = current.status;
        const desired = !(status !== null && typeof status === 'object' && status.enabled === true);
        toggling = true;
        base.update((state) => ({ ...state, busy: true }));
        try {
          const result = await call('setEnabled', { sessionId, enabled: desired });
          if (disposed) return;
          const value = valueOf(result);
          if (value === undefined) {
            if (result === undefined) notifyFailure('NO_CONNECTION');
            else notifyFailure(codeOf(result) ?? 'UNKNOWN');
            return;
          }
          applyStatus(value, Date.now());
          // 开关生效、但状态没落盘：Host 明确要求界面提示「重启后可能回落」。
          if (value !== null && typeof value === 'object' && value.persisted === false) {
            base.update((state) => ({
              ...state,
              notice: { text: t('offpeak.toast.notPersisted'), sequence: sequence++ }
            }));
          }
        } catch {
          if (!disposed) notifyFailure('TRANSPORT');
        } finally {
          toggling = false;
          if (!disposed) base.update((state) => ({ ...state, busy: false }));
        }
      };

      const start = () => {
        // 没有会话 id 就没有可查的状态：不建定时器（否则一个空 id 的隐藏占位也会
        // 每秒 tick、每 15 秒打一次注定失败的请求）。
        if (disposed || sessionId === '') return;
        void refresh();
        pollTimer = setInterval(() => {
          void refresh();
        }, OFFPEAK_POLL_INTERVAL);
        tickTimer = setInterval(tick, OFFPEAK_TICK_INTERVAL);
      };

      const stop = () => {
        if (pollTimer !== undefined) {
          clearInterval(pollTimer);
          pollTimer = undefined;
        }
        if (tickTimer !== undefined) {
          clearInterval(tickTimer);
          tickTimer = undefined;
        }
      };

      return {
        getSnapshot: base.getSnapshot,
        subscribe: (listener) => {
          listeners += 1;
          // 首个订阅者出现才启动：renderer 卸载 chip 后没必要继续轮询/倒计时。
          if (listeners === 1) start();
          const unsubscribe = base.subscribe(listener);
          return () => {
            unsubscribe();
            listeners -= 1;
            if (listeners === 0) stop();
          };
        },
        toggle,
        refresh,
        dismissNotice: (value) => {
          const current = base.getSnapshot();
          if (current.notice !== null && current.notice.sequence === value) {
            base.update((state) => ({ ...state, notice: null }));
          }
        },
        dispose: () => {
          disposed = true;
          stop();
        }
      };
    }

    /**
     * 当前相位：`'peak'`（高峰）或 `'idle'`（空闲）。状态未加载时按高峰处理，避免闪「空闲」。
     *
     * @param {any} snapshot - 控制器快照。
     * @returns {'peak'|'idle'} 相位。
     */
    function offpeakPhaseOf(snapshot) {
      const status = snapshot === null || snapshot === undefined ? null : snapshot.status;
      if (status === null || typeof status !== 'object') return 'peak';
      // `paused`（= 高峰时暂停）比 `idle` 更权威：两者同时为 true 的夹具/边界时刻按高峰算。
      if (status.paused === true) return 'peak';
      return status.idle === true ? 'idle' : 'peak';
    }

    /**
     * 相位名称（高峰 / 空闲）。
     *
     * @param {'peak'|'idle'} phase - 相位。
     * @param {(key: string, params?: any) => string} t - 词典读取器。
     * @returns {string} 名称。
     */
    function offpeakPhaseLabel(phase, t) {
      return phase === 'idle' ? t('offpeak.phase.idle') : t('offpeak.phase.peak');
    }

    /**
     * 倒计时的 emoji 前缀（用户要求：体现「即将切换」的紧迫感）：
     * - **高峰 → 空闲**（即将恢复）：≤60s `🎉`、≤10s `🎊`（节庆感）；
     * - **空闲 → 高峰**（即将暂停）：≤60s `⏳`、≤10s `⏰`（紧迫感，最后 10 秒用闹钟）。
     *
     * @param {any} snapshot - 控制器快照。
     * @param {'peak'|'idle'} phase - 当前相位（决定用哪套 emoji）。
     * @returns {string} emoji 或空串。
     */
    function offpeakStateEmoji(snapshot, phase) {
      const ms = snapshot === null || snapshot === undefined ? undefined : snapshot.countdownMs;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
      const final = ms <= OFFPEAK_FINAL_MS;
      if (ms > OFFPEAK_URGENT_MS) return '';
      if (phase === 'idle') return final ? '⏰' : '⏳';
      return final ? '🎊' : '🎉';
    }

    /**
     * 倒计时文字（到下一次相位切换）。高峰/空闲、选中/未选中都显示。
     *
     * @param {any} snapshot - 控制器快照。
     * @param {(key: string, params?: any) => string} t - 词典读取器。
     * @returns {string} 例如 `3h05m` / `🎉 57s` / `⏳ 45s` / `…`。
     */
    function offpeakCountdownLabel(snapshot, t) {
      if (snapshot !== null && typeof snapshot === 'object' && snapshot.busy === true) return t('offpeak.chip.busy');
      const countdown = snapshot === null || snapshot === undefined ? undefined : snapshot.countdownMs;
      const text =
        typeof countdown === 'number' && Number.isFinite(countdown)
          ? formatOffpeakCountdown(countdown)
          : t('offpeak.countdown.unknown');
      const emoji = offpeakStateEmoji(snapshot, offpeakPhaseOf(snapshot));
      return emoji === '' ? text : `${emoji} ${text}`;
    }

    /**
     * 按钮配色（用户最终口径）：
     * - **背景**按相位着色：**高峰橙**（warn tertiary）、**空闲绿**（success tertiary）；
     * - **边框**只切黑白款：**选中 = 浅灰边框**，**未选中 = 白色边框**；
     * - **内部**图标/文字颜色沿用原来的语义色（高峰橙、空闲绿），与选中无关。
     *
     * @param {'peak'|'idle'} phase - 相位。
     * @param {boolean} selected - 是否选中（已设为空闲会话）。
     * @returns {{ color: string, background: string, border: string }} 配色。
     */
    function offpeakPillPalette(phase, selected) {
      const idle = phase === 'idle';
      return {
        color: idle
          ? 'var(--dsw-alias-state-success-primary, #067647)'
          : 'var(--dsw-alias-state-warn-label, #b45309)',
        background: idle
          ? 'var(--dsw-alias-state-success-tertiary, rgba(6, 118, 71, 0.12))'
          : 'var(--dsw-alias-state-warn-tertiary, rgba(245, 158, 11, 0.14))',
        border: selected ? '1px solid #d0d3d8' : '1px solid #ffffff'
      };
    }

    /**
     * 会话标题栏的「梁谷会话」chip。
     *
     * 与另外两个标题栏控件同构：`sessionId`、`t` 由槽位注入，`useOffpeak` 读快照、
     * `useCapability` 读能力探测结果、`offpeak.toggle()` 是动作 —— 全部来自本插件
     * contribution 的 `inject()`。
     *
     * hooks 顺序固定：先读状态、再读能力探测，两者都在任何提前 return 之前调用（否则
     * 「Host 组件被停用」的那次渲染会改变调用顺序，React 直接报 hook 顺序错误）。
     * 隐藏时返回隐藏占位而不是 null —— 组件保持挂载，订阅才不会被拆掉（组件被重新
     * 启用时能立刻恢复，不必等刷新）。
     *
     * @param {any} props - 槽位注入的 props。
     * @returns {any} chip（可能带 Toast）或隐藏占位。
     */
    function OffpeakButton(props) {
      const state = props.useOffpeak((value) => value);
      const capability = props.useCapability((value) => value.offpeak);
      const sessionId = props.sessionId;
      const t = props.t;
      if (sessionId === undefined || sessionId === null || String(sessionId) === '') {
        return jsx('span', { style: { display: 'none' }, 'data-offpeak-hidden': 'no-session' });
      }
      if (capability === false) {
        // 与分享按钮同策略：返回隐藏占位而不是 null —— 组件保持挂载，订阅才不会被拆掉。
        return jsx('span', { style: { display: 'none' }, 'data-offpeak-hidden': 'disabled' });
      }
      const snapshot = state !== null && typeof state === 'object' ? state : OFFPEAK_INITIAL;
      const view = offpeakViewState(snapshot);
      const status = snapshot.status;
      const enabled = status !== null && typeof status === 'object' && status.enabled === true;
      const queued =
        status !== null && typeof status === 'object' && status.cover !== null && typeof status.cover === 'object' &&
        typeof status.cover.queued === 'number'
          ? status.cover.queued
          : undefined;
      const label = offpeakStatusTooltip(snapshot, t, { queued });
      const urgency = offpeakUrgency(snapshot);
      const phase = offpeakPhaseOf(snapshot);
      const readOnly = status !== null && typeof status === 'object' && status.readOnly === true;
      const toast =
        snapshot.notice === null || snapshot.notice === undefined
          ? null
          : jsx(
              P.Toast,
              {
                text: snapshot.notice.text,
                onDone: () => {
                  props.offpeak.dismissNotice(snapshot.notice.sequence);
                },
                ...(snapshot.notice.tone === undefined ? {} : { tone: snapshot.notice.tone })
              },
              snapshot.notice.sequence
            );
      // 官方 `Pill`（24px 胶囊、12px 字号）+ 官方 `Tooltip`（深色气泡）：
      // 与新建页开关、以及 DSH 自己的 chip 完全同一套形制；语义色仍走主题 token。
      // 子代理会话只读：状态继承自主会话，按钮置灰且不响应点击。
      const pillLabel = readOnly ? `${label}\n${t('offpeak.readOnlyHint')}` : label;
      const pill = jsx(P.Pill, {
        active: enabled,
        // 稳定测试钩子：自动化验证按这三个属性定位/断言，不依赖文案（文案随语言变，`data-*` 不会）。
        'data-dsh-offpeak-button': '',
        'data-offpeak-state': view,
        'data-offpeak-enabled': enabled ? 'true' : 'false',
        'data-offpeak-read-only': readOnly ? 'true' : 'false',
        ...(urgency === '' ? {} : { 'data-offpeak-urgent': urgency }),
        'aria-label': pillLabel.split('\n')[0],
        disabled: view === 'busy' || readOnly,
        onClick: () => {
          if (readOnly) return;
          void props.offpeak.toggle();
        },
        style: {
          ...offpeakPillPalette(phase, enabled),
          flex: 'none',
          width: OFFPEAK_PILL_WIDTH,
          height: OFFPEAK_PILL_HEIGHT,
          maxWidth: 'none',
          boxSizing: 'border-box',
          gap: OFFPEAK_PILL_GAP,
          justifyContent: 'center'
        },
        children: [
          offpeakStatusIcon(phase),
          // 相位段（高峰/空闲）：固定 24px，位置不随状态变化。
          jsx('span', {
            style: {
              width: OFFPEAK_NAME_WIDTH,
              flex: 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              textAlign: 'left',
              whiteSpace: 'nowrap'
            },
            children: offpeakPhaseLabel(phase, t)
          }),
          // 倒计时段：固定槽内居中（44px 槽按最长文案定，短文案左右各差约 3px，看不出空档）。
          jsx('span', {
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              textAlign: 'center',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap'
            },
            children: offpeakCountdownLabel(snapshot, t)
          })
        ]
      });
      // Tooltip 包一层原生 span 作锚点：`Pill` 是自定义组件，直接当锚点时
      // Tooltip 的 ref / 指针事件不保证落到真实 DOM 按钮上（实测气泡不出来）。
      const anchor = jsx('span', { style: { display: 'inline-flex' }, children: pill });
      return jsxs('span', {
        style: { display: 'inline-flex', alignItems: 'center' },
        children: [
          jsx(P.Tooltip, { label: pillLabel, side: 'bottom', align: 'center', delayMs: 300, maxWidth: 320, children: anchor }),
          toast
        ]
      });
    }
    // #endregion

    // #region 新建会话页的「梁谷」开关（hero 行，预设右侧）
    /**
     * 谷峰插件的悬浮提示（标题栏 chip 与新建页开关共用，官方 `Tooltip` 风格）：
     * 回答「当前相位 / 点击会怎样 / 何时自动切换」，1~2 行；chip 额外带队列条数。
     *
     * @param {any} snapshot - 控制器快照。
     * @param {(key: string, params?: any) => string} t - 词典读取器。
     * @param {{ queued?: number }} [options] - chip 传队列条数；hero 开关不传。
     * @returns {string} 提示文本（多行用 \n，官方 tooltip 是 pre-line）。
     */
    function offpeakStatusTooltip(snapshot, t, options = {}) {
      if (snapshot !== null && typeof snapshot === 'object' && snapshot.busy === true) return t('offpeak.tipBusy');
      const status = snapshot === null || snapshot === undefined ? null : snapshot.status;
      const selected = status !== null && typeof status === 'object' && status.enabled === true;
      const phase = offpeakPhaseOf(snapshot);
      const schedule =
        status !== null && typeof status === 'object' && status.schedule !== null && typeof status.schedule === 'object'
          ? status.schedule
          : {};
      const timeZone =
        typeof schedule.timeZone === 'string' && schedule.timeZone !== '' ? schedule.timeZone : 'Asia/Shanghai';
      const nextAt = status !== null && typeof status === 'object' ? formatOffpeakClock(status.nextChangeAt, timeZone) : '';
      const queued = typeof options.queued === 'number' && options.queued > 0
        ? `\n${t('offpeak.queued', { n: options.queued })}`
        : '';

      if (!selected) {
        // 未选中 = 普通会话：说明「现在不受限 + 点击后会怎样」。
        return `${t('offpeak.tipNormal')}\n${t('offpeak.tipSetIdle')}`;
      }
      const cancel = `\n${t('offpeak.tipCancel')}`;
      if (phase === 'idle') {
        const head = nextAt === ''
          ? t('offpeak.tipIdle')
          : `${t('offpeak.tipIdle')}\n${t('offpeak.tipPauseAt', { time: nextAt })}`;
        return `${head}${cancel}${queued}`;
      }
      const head = nextAt === ''
        ? t('offpeak.tipPeak')
        : `${t('offpeak.tipPeak')}\n${t('offpeak.tipResumeAt', { time: nextAt })}`;
      return `${head}${cancel}${queued}`;
    }
    /**
     * 新建会话页的「梁谷」开关。
     *
     * 与标题栏右上角的「梁谷」chip **同一个控制器、同一套行为**：点击只切换当前会话的
     * 梁谷开关——不创建会话、不导航、不弹 Toast。新建页上的空白会话就是即将创建的会话，
     * 因此开关打开时，**新建出来的会话一定是梁谷会话**；按钮始终显示名称与状态：
     * 关 = 太阳 +「梁峰」；开 = 月亮 +「梁谷」+ 剩余时间/「空闲」。
     *
     * @param {any} props - 槽位注入的 props。
     * @returns {any} 开关（或隐藏占位）。
     */
    function LiangguHeroToggle(props) {
      const snapshot = props.useOffpeak((value) => value);
      const capability = props.useCapability((value) => value.offpeak);
      const sessionId = props.sessionId;
      const t = props.t;
      if (sessionId === undefined || sessionId === null || String(sessionId) === '') {
        return jsx('span', { style: { display: 'none' }, 'data-lianggu-hero-hidden': 'no-session' });
      }
      if (capability === false) {
        // 与 chip 同策略：返回隐藏占位而不是 null，保持订阅不被拆掉。
        return jsx('span', { style: { display: 'none' }, 'data-lianggu-hero-hidden': 'disabled' });
      }
      const state =
        snapshot !== null && typeof snapshot === 'object'
          ? snapshot
          : { status: null, busy: false, notice: null, countdownMs: null };
      // 子代理会话只读：不在新建页展示可切换的开关（状态由主会话决定）。
      if (state.status !== null && typeof state.status === 'object' && state.status.readOnly === true) {
        return jsx('span', { style: { display: 'none' }, 'data-lianggu-hero-hidden': 'read-only' });
      }
      const view = offpeakViewState(state);
      const enabled = view !== 'off';
      const phase = offpeakPhaseOf(state);
      const label = offpeakStatusTooltip(state, t);
      const urgency = offpeakUrgency(state);
      const readOnly = state.status !== null && typeof state.status === 'object' && state.status.readOnly === true;
      // 选中 = 黑款边框；未选中 = 白款边框。内部颜色只看相位（高峰橙/空闲绿），两款一致。
      const palette = offpeakPillPalette(phase, enabled);
      // 与标题栏 chip 同一个官方 `Pill` + `Tooltip` 形制。
      const pill = jsx(P.Pill, {
        active: enabled,
        'data-dsh-lianggu-hero': '',
        'data-lianggu-state': view,
        'data-lianggu-enabled': enabled ? 'true' : 'false',
        ...(urgency === '' ? {} : { 'data-offpeak-urgent': urgency }),
        'aria-label': label.split('\n')[0],
        disabled: view === 'busy' || readOnly,
        onClick: () => {
          if (view === 'busy' || readOnly) return;
          void props.offpeak.toggle();
        },
        style: {
          ...palette,
          flex: 'none',
          width: OFFPEAK_PILL_WIDTH,
          height: OFFPEAK_PILL_HEIGHT,
          maxWidth: 'none',
          boxSizing: 'border-box',
          gap: OFFPEAK_PILL_GAP,
          justifyContent: 'center'
        },
        children: [
          offpeakStatusIcon(phase),
          // 相位段（高峰/空闲）固定 24px：图标与相位位置不随选中/相位变化。
          jsx('span', {
            style: {
              width: OFFPEAK_NAME_WIDTH,
              flex: 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              textAlign: 'left',
              whiteSpace: 'nowrap'
            },
            children: offpeakPhaseLabel(phase, t)
          }),
          // 倒计时段固定槽内居中（同 chip）。
          jsx('span', {
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              textAlign: 'center',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap'
            },
            children: offpeakCountdownLabel(state, t)
          })
        ]
      });
      // 与 chip 一致：切换失败 / 未落盘时在开关旁弹 Toast（此前 hero 漏了这一步，
      // 失败时界面毫无反馈）。
      const toast =
        state.notice === null || state.notice === undefined
          ? null
          : jsx(
              P.Toast,
              {
                text: state.notice.text,
                onDone: () => {
                  props.offpeak.dismissNotice(state.notice.sequence);
                },
                ...(state.notice.tone === undefined ? {} : { tone: state.notice.tone })
              },
              state.notice.sequence
            );
      // 同 chip：Tooltip 锚点用原生 span，不直接把自定义组件交给 Tooltip 克隆。
      return jsxs('span', {
        style: { display: 'inline-flex', alignItems: 'center' },
        children: [
          jsx(P.Tooltip, {
            label,
            side: 'bottom',
            align: 'center',
            delayMs: 350,
            maxWidth: 320,
            children: jsx('span', { style: { display: 'inline-flex' }, children: pill })
          }),
          toast
        ]
      });
    }

    /**
     * hero 开关的悬停/禁用样式 + heroOptions 回拉。
     *
     * 官方 `heroOptions` 用 `margin-left:auto` 把它推到新建会话行的行尾；按需求开关要紧挨
     * 预设下拉框右侧，所以只在「本插件开关存在」时把容器拉回来（`:has` 同时保证不会影响
     * 没有本开关的其它构建）。类名兜底那条是防 CSS Modules 哈希前缀变化。
     *
     * @returns {() => void} 卸载函数。
     */
    function installLiangguNewStyle() {
      // 离线冒烟（没有 DOM）里直接跳过：样式只影响真实浏览器。
      if (typeof document === 'undefined') return () => {};
      const style = document.createElement('style');
      style.setAttribute('data-dsh-enhance-lianggu-hero-style', '');
      style.textContent = [
        'div:has(> [data-slot="conversation.hero.options"]):has([data-dsh-lianggu-hero]){margin-left:0 !important;}',
        '[class*="heroOptions"]:has([data-dsh-lianggu-hero]){margin-left:0 !important;}',
        '[data-dsh-lianggu-hero]{transition:background-color .12s ease,color .12s ease;}',
        '[data-dsh-lianggu-hero]:hover:not(:disabled){filter:brightness(.96);}',
        '[data-dsh-lianggu-hero]:disabled{opacity:.55;cursor:default;}'
      ].join('');
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
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
    let contextLastDecision = null;
    let contextLastPruned = 0;
    let contextAutoProbeSession = '';
    let contextObserver = null;
    let contextInterval = null;
    let contextNoteTimer;

    /**
     * 判断一个 `role=dialog` 元素是不是官方 **ContextMeter（「上下文已用」）** 面板。
     *
     * ⚠️ 这个判据必须严格：composer 里还有**两个用量面板**（「本轮用量」/「Token 用量」），
     * 它们同样是 `role="dialog"` + 含 `<dl>` + 文本里有 `NN%`（缓存命中 99.9%）。早期判据
     * 只查这三条，于是「压缩」动作被注入进了那两个面板——用户截图指出那里不该有压缩按钮。
     *
     * 官方 ContextMeter 的结构（随附包源码 `dsh-client-ui-conversation/src/client/
     * skeleton/ContextMeter.tsx`）：
     *
     *   <div role="dialog" aria-label="上下文已用">
     *     <div class=header>… 45% … ~477K / 1M …</div>      ← 已用 / 窗口这组数字
     *     <div class=bar><div style="width:45%"/>…</div>     ← 分段进度条
     *     <dl class=rows>
     *       <div class=row><dt><span class=swatch/>系统提示词</dt><dd>~10.3K</dd></div>
     *       … 恰好三行（系统提示词 / 工具定义 / 对话消息）
     *
     * 而「本轮用量」面板（`dsh-client-ui-chat/src/client/chat/TurnUsagePanel.tsx`）的
     * `<dl data-turn-usage-details>` 是**扁平的 dt/dd**，没有行容器、没有色块。
     *
     * 因此判据 = 三条同时成立：`dl` 的直接子元素恰好 3 个 div 行、每行都有 `dt` 且 `dt`
     * 内含色块 `span`、面板文本里有「~已用 / 窗口」这组数字（与语言无关）。
     * 任何一条不满足就**不注入**：宁可按钮不出现（composer 里还有别的手动压缩入口），
     * 也绝不能出现在错误的窗口里。
     *
     * @param {Element} node - 候选节点。
     * @returns {boolean} 是否官方上下文 panel。
     */
    function isContextPanel(node) {
      if (node === null || node === undefined) return false;
      if (node.getAttribute('role') !== 'dialog') return false;
      // 显式排除两个用量面板：它们的 dl 带源码里写死的 data 属性，是最稳的判据。
      // - 「本轮用量」→ `dsh-client-ui-chat/src/client/chat/TurnUsagePanel.tsx` 的 `data-turn-usage-details`
      // - 「Token 用量」→ 同包 `StatsPills.tsx` 的 `data-session-stats-details`
      if (node.querySelector('[data-turn-usage-details]') !== null) return false;
      if (node.querySelector('[data-session-stats-details]') !== null) return false;
      const list = node.querySelector('dl');
      if (list === null) return false;
      const rows = list.querySelectorAll(':scope > div');
      if (rows.length !== 3) return false;
      for (const row of rows) {
        if (row.querySelector('dt') === null) return false;
        // 每行 dt 里有一个色块 span（图例）。用量面板没有。
        if (row.querySelector('dt span') === null) return false;
      }
      // 头部「~已用 / 窗口」（例如 `~477K / 1M`）：用量面板显示的是 `2,692,918 tok`，没有这个比值。
      return /~?\d[\d.,]*\s*[KMB]?\s*\/\s*~?\d[\d.,]*\s*[KMB]?/i.test(node.textContent ?? '');
    }

    /**
     * 找当前打开的官方上下文 panel。
     *
     * 官方用 CSS anchor positioning 定位面板（内联 `position-anchor: --dsh-context-…`），
     * 带这个样式的那个一定是 ContextMeter；浏览器不支持该属性时退回结构判据的结果。
     *
     * @returns {Element | null} panel 或 null。
     */
    function findContextPanel() {
      if (typeof document === 'undefined') return null;
      const dialogs = document.querySelectorAll('[role="dialog"]');
      let fallback = null;
      for (const node of dialogs) {
        if (!isContextPanel(node)) continue;
        const style = typeof node.getAttribute === 'function' ? (node.getAttribute('style') ?? '') : '';
        if (style.includes('position-anchor')) return node;
        if (fallback === null) fallback = node;
      }
      return fallback;
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
          contextLastDecision =
            value.lastDecision !== null && typeof value.lastDecision === 'object' ? value.lastDecision : null;
          contextLastPruned = typeof value.lastPruned === 'number' ? value.lastPruned : 0;
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
      // 最近一次分级决策：回答「为什么这一轮没压」（关着 / 没测量 / 未到阈值 / 熔断）。
      const decisionTier =
        contextLastDecision !== null && typeof contextLastDecision.tier === 'string'
          ? contextLastDecision.tier
          : '';
      const decisionReason =
        contextLastDecision !== null && typeof contextLastDecision.reason === 'string'
          ? contextLastDecision.reason
          : '';
      if (decisionTier !== '') {
        nextTitle = `${nextTitle}\n${
          contextLastPruned > 0
            ? t('context.decisionPruned', {
                tier: decisionTier,
                reason: decisionReason === '' ? '—' : decisionReason,
                n: contextLastPruned,
              })
            : t('context.decisionHint', {
                tier: decisionTier,
                reason: decisionReason === '' ? '—' : decisionReason,
              })
        }`;
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

    // #region 侧边提问（组件 dsh-session-enhance/sideask）
    //
    // 侧边会话**不是**原会话的分支：Host 半创建一个新的只读会话，并把「询问提示词」
    // 预填进它的输入框——提示词里写明参考会话 id，让模型用会话查询工具按 id 去查。
    // 浏览器半只负责界面：右侧栏标签（页面型 + guide 入口）、标题栏入口、选中文字的
    // 合并弹层（「引用文本」+「侧边提问」并排），以及「保留 / 归档」的状态管理。

    /** 侧边提问的标签类型（页面型）。 */
    const SIDEASK_KIND = 'sideask';
    /** 本实现的标签类型 id：内容与 guide 卡片都注册在它下面。 */
    const SIDEASK_TAB_ID = 'dsh-session-enhance/side-ask';
    /** guide 卡片 id。 */
    const SIDEASK_GUIDE_ID = 'side-ask';
    /** Host 半的 RPC 通道（`lib/sideask/rpc.mjs`）。 */
    const SIDEASK_RPC_CHANNEL = '/dsh-session-enhance-sideask';
    /** 浏览器存储键：侧边会话的「保留 / 已归档」状态与「原会话 → 子会话」绑定。 */
    const SIDEASK_STORAGE_KEY = 'dsh-session-enhance.side-ask.v1';
    /**
     * 私有占位子槽：只声明、不渲染。
     *
     * 框架只在「注册声明了非 root 作用域子槽」时给组件注入 `SessionProvider`
     * （`ui-renderer` 的 `standardProps` 分支），而随附 `ui-subagent` 已经全局声明了
     * `sidebar.chat.conversation`，第三方再声明会抛 `slot ... is already declared`。
     * 所以这里声明一个自己命名的 session 子槽来触发 Provider 注入。
     */
    const SIDEASK_SESSION_SEAT = 'dsh-session-enhance.side-ask.session';
    /** 启动清扫延迟（等布局恢复与标签挂载先跑完）。 */
    const SIDEASK_SWEEP_MS = 5000;
    /** 临时侧边会话的只读权限预设（DSH base bundle 内置）。 */
    const SIDEASK_READ_ONLY_PRESET = 'read-only';

    /**
     * 规范化侧边会话记录表；坏记录直接丢弃。
     *
     * @param {unknown} raw - 解析后的 JSON。
     * @returns {{ version: 1, records: Record<string, object> }} 安全状态。
     */
    function normalizeSideAskStore(raw) {
      const empty = { version: 1, records: {} };
      if (raw === null || typeof raw !== 'object') return empty;
      const source = raw.records;
      if (source === null || typeof source !== 'object') return empty;
      const records = {};
      for (const [key, value] of Object.entries(source)) {
        if (value === null || typeof value !== 'object') continue;
        const childSessionId = typeof value.childSessionId === 'string' ? value.childSessionId : key;
        const parentSessionId = typeof value.parentSessionId === 'string' ? value.parentSessionId : '';
        if (childSessionId === '' || parentSessionId === '') continue;
        records[childSessionId] = {
          childSessionId,
          parentSessionId,
          kept: value.kept === true,
          archived: value.archived === true,
          createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0
        };
      }
      return { version: 1, records };
    }

    /**
     * 建侧边会话的浏览器存储。
     *
     * @param {{ getItem(key: string): string | null, setItem(key: string, value: string): void } | undefined} storage - localStorage。
     * @returns {object} 存储操作。
     */
    function createSideAskStore(storage) {
      /** @returns {{ version: 1, records: Record<string, object> }} */
      function read() {
        if (storage === undefined || storage === null) return normalizeSideAskStore(undefined);
        try {
          const raw = storage.getItem(SIDEASK_STORAGE_KEY);
          if (raw === null || raw === '') return normalizeSideAskStore(undefined);
          return normalizeSideAskStore(JSON.parse(raw));
        } catch {
          return normalizeSideAskStore(undefined);
        }
      }
      /** @param {{ version: 1, records: Record<string, object> }} state */
      function write(state) {
        if (storage === undefined || storage === null) return;
        try {
          storage.setItem(SIDEASK_STORAGE_KEY, JSON.stringify(state));
        } catch { /* 忽略：状态非关键 */ }
      }
      return {
        list() { return Object.values(read().records); },
        get(childSessionId) { return read().records[String(childSessionId)]; },
        /**
         * 原会话当前绑定的、未归档的侧边会话（有多个时取最新）。
         *
         * @param {string} parentSessionId - 原会话 id。
         * @returns {object | undefined} 记录。
         */
        childOf(parentSessionId) {
          const rows = Object.values(read().records)
            .filter(record => record.parentSessionId === String(parentSessionId) && record.archived !== true)
            .sort((a, b) => b.createdAt - a.createdAt);
          return rows[0];
        },
        upsert(childSessionId, parentSessionId) {
          const state = read();
          const existing = state.records[childSessionId];
          state.records[childSessionId] = {
            childSessionId,
            parentSessionId,
            kept: existing === undefined ? false : existing.kept,
            archived: false,
            createdAt: existing === undefined ? Date.now() : existing.createdAt
          };
          write(state);
          return state.records[childSessionId];
        },
        setKept(childSessionId, kept) {
          const state = read();
          const record = state.records[childSessionId];
          if (record === undefined) return;
          record.kept = kept === true;
          write(state);
        },
        markArchived(childSessionId) {
          const state = read();
          const record = state.records[childSessionId];
          if (record === undefined) return;
          record.archived = true;
          write(state);
        },
        markActive(childSessionId) {
          const state = read();
          const record = state.records[childSessionId];
          if (record === undefined) return;
          record.archived = false;
          write(state);
        },
        isChild(sessionId) { return read().records[String(sessionId)] !== undefined; }
      };
    }

    /**
     * 把选中文字转成 Markdown 引用块（用于「复用已打开的侧边会话」时追加引用）。
     *
     * @param {unknown} text - 选中文字。
     * @returns {string} 引用块；空白输入返回空串。
     */
    function formatSideAskQuoteText(text) {
      const normalized = String(text ?? '').replace(/\r\n?/gu, '\n').trim();
      if (normalized === '') return '';
      return normalized
        .split('\n')
        .map(line => (line === '' ? '>' : '> ' + line))
        .join('\n');
    }

    /**
     * 侧边提问的小图标：对话框 + 右侧栏。
     *
     * @returns {object} React 元素。
     */
    /**
     * 取官方图标组件（`@deepseek-ai/dsh-client-ui-primitives` 的 icons 导出）。
     *
     * @returns {{ size?: number } => object} 图标组件；部署里没有该导出时返回兜底 SVG 组件。
     */
    function sideAskIconComponent() {
      let official = null;
      try {
        const glyph = P === null || P === undefined ? undefined : P.IconNewChatOutlineRegular;
        if (typeof glyph === 'function') official = glyph;
      } catch { /* 忽略：走兜底 */ }
      if (official !== null) return official;
      return function SideAskFallbackIcon(props) {
        const size = props !== null && typeof props === 'object' && typeof props.size === 'number'
          ? props.size
          : 16;
        return jsx('svg', {
          viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
          children: jsx('path', {
            d: 'M3.5 3h9a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H8l-3 2.2v-2.2H3.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round'
          })
        });
      };
    }

    /**
     * 「侧边提问」的样式表：全部走 DSH 官方 token，与官方同款组件对齐。
     *
     * - 浮层动作沿用官方 Quote 动作（`button-floating-fill` + `elevation-panel` + 999px 圆角）；
     * - 标题栏入口沿用官方 28px 圆形 icon 按钮（`label-tertiary` / `interactive-bg-hover`）；
     * - 标签正文的顶部状态栏沿用右侧栏 title-row（`specific-sidebar-fill` + hairline 分隔）。
     *
     * 手写 bundle 没有 CSS module，所以按本包既有做法插入一张 `<style>`（卸载时移除）。
     *
     * @returns {() => void} 撤销函数。
     */
    function installSideAskStyle() {
      if (typeof document === 'undefined' || document.head === null) return () => {};
      const style = document.createElement('style');
      style.setAttribute('data-dsh-enhance-side-ask-style', '');
      style.textContent = [
        '[data-dsh-side-ask-bar]{box-sizing:border-box;display:flex;align-items:center;',
        'justify-content:space-between;gap:8px;flex:0 0 auto;min-width:0;padding:4px 10px;',
        'background:var(--dsw-specific-sidebar-fill);border-bottom:0.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l1));',
        'color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13,13px/18px var(--dsw-font-family,system-ui));}',
        '[data-dsh-side-ask-bar-label]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '[data-dsh-side-ask-body]{box-sizing:border-box;display:flex;flex-direction:column;flex:1 1 auto;',
        'min-width:0;min-height:0;}',
        '[data-dsh-side-ask-root]{box-sizing:border-box;display:flex;flex-direction:column;',
        'width:100%;height:100%;min-width:0;min-height:0;}',
        '[data-dsh-side-ask-actions]{display:inline-flex;align-items:center;gap:6px;}',
        '[data-dsh-side-ask-action]{display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border:0;',
        'border-radius:999px;background:var(--dsw-alias-button-floating-fill,var(--dsw-alias-bg-overlay,#fff));',
        'box-shadow:var(--dsw-elevation-panel,0 6px 20px rgba(0,0,0,.16));',
        'color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13,13px/18px var(--dsw-font-family,system-ui));',
        'cursor:pointer;white-space:nowrap;}',
        '[data-dsh-side-ask-action]:hover,[data-dsh-side-ask-action]:focus-visible{',
        'background:var(--dsw-alias-button-floating-hover,var(--dsw-alias-bg-overlay,#fff));}',
        '[data-dsh-side-ask-trigger]{display:inline-flex;align-items:center;justify-content:center;',
        'width:28px;height:28px;padding:0;border:0;border-radius:28px;background:transparent;',
        'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer;}',
        '[data-dsh-side-ask-trigger]:hover,[data-dsh-side-ask-trigger]:focus-visible{',
        'color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);}',
        '[data-dsh-side-ask-trigger] svg{display:block;flex:none;}',
        '[data-dsh-side-ask-note]{padding:14px 16px;color:var(--dsw-alias-label-secondary);',
        'font:var(--dsw-font-xs-13,13px/18px var(--dsw-font-family,system-ui));}',
        '[data-dsh-side-ask-note] pre{margin:8px 0 0;white-space:pre-wrap;word-break:break-word;',
        'font:inherit;opacity:.75;}'
      ].join('');
      document.head.appendChild(style);
      return () => { style.remove(); };
    }

    /**
     * 侧边提问标签页正文：一行状态栏 + 原生会话。
     *
     * @param {object} props - 槽位运行时 props 与本组件注入面。
     * @returns {object} React 元素。
     */
    function SideAskTab(props) {
      const { sessionId, SessionProvider, renderFactorySlot, t, sideAsk } = props;
      const initialChild = sideAsk.childOf(sessionId);
      const [childSessionId, setChildSessionId] = React.useState(initialChild);
      const [reference, setReference] = React.useState(null);
      const [kept, setKept] = React.useState(() => (
        initialChild === undefined ? false : sideAsk.isKept(initialChild)
      ));
      // 从 guide 入口打开时标签里还没有子会话：挂载时为本会话创建一个（有绑定则复用）。
      // 创建动作会由 Host 生成询问提示词并预填进它的输入框。
      React.useEffect(() => {
        let cancelled = false;
        const existing = sideAsk.childOf(sessionId);
        if (existing !== undefined) {
          setChildSessionId(existing);
          setKept(sideAsk.isKept(existing));
          return () => { cancelled = true; };
        }
        Promise.resolve(sideAsk.ensureChild(sessionId)).then((childId) => {
          if (cancelled || typeof childId !== 'string') return;
          setChildSessionId(childId);
          setKept(sideAsk.isKept(childId));
        }).catch((error) => {
          console.warn('dsh-session-enhance: could not create the side session', error);
        });
        return () => { cancelled = true; };
      }, [sessionId]);
      // 为子会话持有一个引用（Provider 与输入框都靠它）；卸载时释放。
      React.useEffect(() => {
        if (childSessionId === undefined) { setReference(null); return; }
        let next = null;
        try { next = sideAsk.retain(childSessionId); } catch (error) {
          console.warn('dsh-session-enhance: could not retain the side session', error);
        }
        setReference(next);
        sideAsk.onTabOpen(childSessionId);
        return () => { if (next !== null) sideAsk.release(next); };
      }, [childSessionId]);
      const toggle = () => {
        if (childSessionId === undefined) return;
        const next = !kept;
        sideAsk.setKept(childSessionId, next);
        setKept(next);
      };
      // 原生会话内容：`conversation.content` 工厂（与主会话同一套渲染）。不传 `slots`
      // 时默认 views 就是 `renderSlot('conversation.session')`。
      const content = renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase: 'active',
        hero: false,
        onWorkspaceSelected: (workspaceId, adopt) => sideAsk.openWorkspace(workspaceId, adopt)
      });
      let body;
      if (reference === null) {
        body = jsx('div', { 'data-dsh-side-ask-note': '', children: t('sideAsk.tab.creating') });
      } else if (typeof SessionProvider !== 'function') {
        // 降级正文：主 key 的注册失败（或被撤下）时，kind 兜底 key 会渲染到这里。
        // 显示可读提示 + 注册失败摘要，用户可直接截图，不必开 DevTools。
        body = jsxs('div', {
          'data-dsh-side-ask-note': '',
          children: [
            jsx('div', { children: t('sideAsk.tab.unavailable') }),
            typeof sideAskBodyFailure === 'string' && sideAskBodyFailure !== ''
              ? jsx('pre', { children: sideAskBodyFailure })
              : null
          ]
        });
      } else {
        body = jsx(SessionProvider, { session: reference, children: content });
      }
      const statusLabel = kept ? t('sideAsk.tab.kept') : t('sideAsk.tab.temporary');
      return jsxs('div', {
        'data-dsh-side-ask-root': '',
        children: [
          jsxs('div', {
            'data-dsh-side-ask-bar': '',
            children: [
              jsx('span', {
                'data-dsh-side-ask-bar-label': '',
                title: statusLabel,
                children: statusLabel
              }),
              childSessionId === undefined
                ? null
                : jsx(P.Button, {
                  size: 'sm',
                  onClick: toggle,
                  title: t('sideAsk.tab.keepHint'),
                  'aria-pressed': kept,
                  children: kept ? t('sideAsk.tab.unkeep') : t('sideAsk.tab.keep')
                })
            ]
          }),
          jsx('div', { 'data-dsh-side-ask-body': '', children: body })
        ]
      });
    }

    /**
     * 侧边提问的标题栏入口。
     *
     * @param {object} props - `onOpen` / `hidden` / `t`。
     * @returns {object | null} React 元素或 null。
     */
    function SideAskHeaderButton(props) {
      const { onOpen, hidden, t } = props;
      if (hidden === true) return null;
      const Icon = sideAskIconComponent();
      // 与官方标题栏图标按钮同款：28px 圆形、透明底、label-tertiary 图标色、hover 出底色。
      return jsx('button', {
        type: 'button',
        'data-dsh-side-ask-trigger': '',
        title: t('sideAsk.header.hint'),
        'aria-label': t('sideAsk.header.open'),
        onClick: onOpen,
        children: jsx(Icon, { size: 16 })
      });
    }

    /**
     * 选中文字的合并操作条：「引用文本」与「侧边提问」并排。
     *
     * 通过 shadow 官方 `quote` 表面（更低 priority）接管官方「引用」弹层，因此「引用文本」
     * 必须完整复刻官方行为：`inputActions.insertQuote(text)` + 清选区 + 关弹层。
     * 侧边会话里只显示「引用文本」（不再递归开侧边会话）。
     *
     * @param {object} props - 槽位运行时 props 与本组件注入面。
     * @returns {object | null} React 元素或 null。
     */
    function SideAskTextActions(props) {
      const {
        readText, clearSelection, dismiss, inputActions, useSession, sessionId, onAsk, t
      } = props;
      const enabled = useSession(state => state !== undefined && !state.removed
        && (state.subagent === null || state.subagent.address.mode === 'continuable'));
      React.useEffect(() => {
        if (!enabled) dismiss();
      }, [enabled, dismiss]);
      if (!enabled) return null;
      const canQuote = inputActions !== undefined && typeof inputActions.insertQuote === 'function';
      // 「侧边提问」**始终可用**。早先按「本会话是否登记为侧边会话」隐藏（避免嵌套），但那让
      // 任何被记录过的会话永久失去入口，且记录表在浏览器本地、状态不可见——比嵌套本身更糟。
      const canAsk = true;
      const runQuote = () => {
        const text = readText();
        if (text === null) { dismiss(); return; }
        if (!inputActions.insertQuote(text)) return;
        clearSelection();
        dismiss();
      };
      const runAsk = () => {
        const text = readText();
        if (text === null) { dismiss(); return; }
        clearSelection();
        dismiss();
        onAsk(sessionId, text);
      };
      const children = [];
      if (canQuote) {
        children.push(jsx('button', {
          key: 'quote',
          type: 'button',
          'data-dsh-side-ask-action': '',
          'aria-label': t('sideAsk.selection.quote'),
          onPointerDown: (event) => { event.preventDefault(); },
          onClick: runQuote,
          children: t('sideAsk.selection.quote')
        }));
      }
      if (canAsk) {
        const Icon = sideAskIconComponent();
        children.push(jsx('button', {
          key: 'ask',
          type: 'button',
          'data-dsh-side-ask-action': '',
          'aria-label': t('sideAsk.selection.askHint'),
          title: t('sideAsk.selection.askHint'),
          onPointerDown: (event) => { event.preventDefault(); },
          onClick: runAsk,
          children: [
            jsx(Icon, { key: 'icon', size: 14 }),
            jsx('span', { key: 'label', children: t('sideAsk.selection.ask') })
          ]
        }));
      }
      return jsx('span', { 'data-dsh-side-ask-actions': '', children });
    }

    /**
     * 安装「侧边提问」组件的浏览器半。
     *
     * 先注册界面、再探测 Host 组件行：探测到该行被停用（405）时把界面全部撤掉，
     * 官方「引用」表面随之恢复原样。
     *
     * @param {any} ctx - 浏览器插件上下文。
     * @param {(key: string) => string} t - 本包词典的翻译函数。
     * @returns {void}
     */
    /**
     * 最近一次侧边提问正文注册失败的原因（降级正文会显示它）。
     *
     * @type {string | null}
     */
    let sideAskBodyFailure = null;

    function installSideAsk(ctx, t) {
      // 官方 token 样式（浮层动作 / 标题栏图标按钮 / 面板状态栏）：插入一张 <style>，卸载时移除。
      try {
        const disposeStyle = installSideAskStyle();
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => disposeStyle, 'dsh-session-enhance: side-ask styles');
        }
      } catch (error) {
        console.warn('dsh-session-enhance: could not install side-ask styles', error);
      }
      let storage;
      try { storage = window.localStorage; } catch { storage = undefined; }
      const store = createSideAskStore(storage);
      /** childSessionId → SessionReference：预填提示词用的持有，标签关闭时释放。 */
      const holds = new Map();
      /** parentSessionId → 创建中的 Promise，避免重复建会话。 */
      const creating = new Map();
      const localeId = (() => {
        try {
          const snapshot = ctx.locale.getSnapshot();
          if (typeof snapshot?.active === 'string') return snapshot.active;
          if (typeof snapshot?.id === 'string') return snapshot.id;
          return 'zh';
        } catch { return 'zh'; }
      })();

      /** 释放一个预填持有。 */
      function releaseHold(childSessionId) {
        const reference = holds.get(childSessionId);
        if (reference === undefined) return;
        holds.delete(childSessionId);
        try { reference.release(); } catch { /* 忽略 */ }
      }

      /** 持有一个侧边会话引用（已有则复用）。 */
      function holdChild(childSessionId) {
        const existing = holds.get(childSessionId);
        if (existing !== undefined) return existing;
        try {
          const reference = ctx.sessions.retain(childSessionId, {
            source: 'sideAsk',
            facets: { conversation: true }
          });
          holds.set(childSessionId, reference);
          return reference;
        } catch (error) {
          console.warn('dsh-session-enhance: could not retain the side session', error);
          return null;
        }
      }

      /** 调 Host 半的侧边提问 RPC。 */
      async function callSideAskRpc(method, payload) {
        const connection = ctx.connection;
        const rpc = connection === undefined || connection === null ? undefined : connection.rpc;
        if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') {
          throw new Error(t('sideAsk.error.unavailable'));
        }
        const result = await rpc.call(SIDEASK_RPC_CHANNEL, method, payload);
        if (result !== null && typeof result === 'object' && result.ok === true) return result.value;
        const error = result !== null && typeof result === 'object' ? result.error : undefined;
        const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
          ? error.message
          : '';
        const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
        throw new Error(message !== '' ? (code !== '' ? message + '（' + code + '）' : message) : (code !== '' ? code : t('sideAsk.error.unavailable')));
      }

      /** 把提示词预填进侧边会话输入框（不自动发送）。 */
      function prefillPrompt(binding, text) {
        if (typeof text !== 'string' || text.trim() === '') return;
        try {
          ctx.conversation.input.requestDraftInitialization(binding, {
            prompt: text,
            whenDraftExists: 'append'
          });
        } catch (error) {
          console.warn('dsh-session-enhance: could not prefill the side-ask prompt', error);
        }
      }

      /**
       * 确保原会话有一个可用的侧边会话：有绑定复用，否则请 Host 建一个新的只读会话。
       * 新会话的询问提示词由 Host 生成并在这里预填。
       *
       * @param {string} parentSessionId - 原会话。
       * @param {string} [quote] - 用户选中的原文。
       * @returns {Promise<string>} 侧边会话 id。
       */
      function ensureChild(parentSessionId, quote) {
        const existing = store.childOf(parentSessionId);
        if (existing !== undefined) {
          if (typeof quote === 'string' && quote.trim() !== '') {
            const reference = holdChild(existing.childSessionId);
            const quoted = formatSideAskQuoteText(quote);
            if (reference !== null && quoted !== '') {
              prefillPrompt(reference.binding, quoted + '\n\n' + t('sideAsk.prompt.question'));
            }
          }
          return Promise.resolve(existing.childSessionId);
        }
        const running = creating.get(parentSessionId);
        if (running !== undefined) return running;
        const task = (async () => {
          const value = await callSideAskRpc('create', {
            parentSessionId,
            ...(typeof quote === 'string' && quote.trim() !== '' ? { quote } : {}),
            locale: localeId
          });
          const childSessionId = value !== null && typeof value === 'object' ? value.sessionId : undefined;
          if (typeof childSessionId !== 'string' || childSessionId === '') {
            throw new Error('side ask create returned no session id');
          }
          store.upsert(childSessionId, parentSessionId);
          const reference = holdChild(childSessionId);
          if (reference !== null && typeof value.prompt === 'string') prefillPrompt(reference.binding, value.prompt);
          void ctx.sessions.refresh().catch(() => {});
          return childSessionId;
        })().finally(() => { creating.delete(parentSessionId); });
        creating.set(parentSessionId, task);
        return task;
      }

      /**
       * 打开（或聚焦）侧边提问标签。
       *
       * @param {string} parentSessionId - 发起提问的原会话。
       * @param {string} [quote] - 选中并要引用的文字。
       * @returns {Promise<void>}
       */
      async function openSideAsk(parentSessionId, quote) {
        if (typeof parentSessionId !== 'string' || parentSessionId === '') return;
        try {
          await ensureChild(parentSessionId, quote);
          ctx.sidebarRight.openTab(SIDEASK_KIND);
        } catch (error) {
          console.warn('dsh-session-enhance: side ask unavailable', error);
        }
      }

      /**
       * 按「保留 / 临时」切换侧边会话的权限：保留 = 恢复原会话预设，临时 = 只读。
       *
       * @param {string} childSessionId - 侧边会话 id。
       * @param {boolean} kept - 是否保留为持久会话。
       * @returns {Promise<void>}
       */
      async function applySideAskMode(childSessionId, kept) {
        try {
          if (kept) await callSideAskRpc('restore', { sessionId: childSessionId });
          else await callSideAskRpc('setPreset', { sessionId: childSessionId, preset: SIDEASK_READ_ONLY_PRESET });
        } catch (error) {
          console.warn('dsh-session-enhance: could not switch the side-ask permission', error);
        }
      }

      /** Host 侧的临时登记清理（标签关闭后）。 */
      function forgetSideAsk(childSessionId) {
        void callSideAskRpc('forget', { sessionId: childSessionId }).catch(() => {});
      }

      /** 归档一个侧边会话（尽力而为）。 */
      function archiveSideAsk(childSessionId) {
        try {
          ctx.uiWorkspace.archiveSession(childSessionId, { stopActivity: true }).catch((error) => {
            console.warn('dsh-session-enhance: could not archive the side session', error);
          });
        } catch (error) {
          console.warn('dsh-session-enhance: could not archive the side session', error);
        }
      }

      /** 是否还有别的分栏在显示本组件的标签。 */
      function hasOtherSideAskTab(sessionId, tabId) {
        try {
          return ctx.sidebarRight.tabsIn(sessionId)
            .some(candidate => candidate.kind === SIDEASK_KIND && candidate.id !== tabId);
        } catch { return false; }
      }

      /** 启动清扫：上次运行遗留、未保留、也没有标签页的侧边会话归档掉。 */
      function sweep() {
        try {
          for (const record of store.list()) {
            if (record.kept === true || record.archived === true) continue;
            let open = false;
            try {
              open = ctx.sidebarRight.tabsIn(record.parentSessionId)
                .some(candidate => candidate.kind === SIDEASK_KIND);
            } catch { open = false; }
            if (open) continue;
            store.markArchived(record.childSessionId);
            archiveSideAsk(record.childSessionId);
          }
        } catch (error) {
          console.warn('dsh-session-enhance: side-ask startup sweep failed', error);
        }
      }

      /** 注册侧边提问的全部界面席位；返回撤销函数。 */
      function registerUi() {
        const disposers = [];
        const add = (disposer) => {
          if (typeof disposer === 'function') disposers.push(disposer);
        };

        add(ctx.sidebarRightTabs.register({
          id: SIDEASK_TAB_ID,
          kind: SIDEASK_KIND,
          priority: 'extension',
          title: () => t('sideAsk.tab.title'),
          guide: [{
            id: SIDEASK_GUIDE_ID,
            order: 30,
            title: () => t('sideAsk.guide.title'),
            description: () => t('sideAsk.guide.description'),
            icon: sideAskIconComponent()
          }]
        }));

        // 正文注册。右侧栏按 `entryKey = definition?.id ?? tab.kind` 派发 `sidebar.right.pane.tab`：
        // 正常路径命中 SIDEASK_TAB_ID；若在位的类型不是本实现（旧标签、组件被重复加载、
        // 或类型注册与本模块不同源），派发的 key 会退化成 kind。**两个 key 都注册**，
        // 任一种情况都能渲染出正文，不会退回 owner 的通用「没有可用的查看方式」。
        const sideAskFace = () => ({
          sideAsk: {
            childOf: parentSessionId => {
              const record = store.childOf(parentSessionId);
              return record === undefined ? undefined : record.childSessionId;
            },
            ensureChild: parentSessionId => ensureChild(parentSessionId),
            isKept: childSessionId => {
              const record = store.get(childSessionId);
              return record !== undefined && record.kept === true;
            },
            setKept: (childSessionId, kept) => {
              store.setKept(childSessionId, kept);
              void applySideAskMode(childSessionId, kept);
            },
            retain: childSessionId => ctx.sessions.retain(childSessionId, {
              source: 'sideAsk',
              facets: { conversation: true }
            }),
            release: reference => reference.release(),
            onTabOpen: (childSessionId) => {
              const record = store.get(childSessionId);
              if (record !== undefined && record.archived === true) {
                store.markActive(childSessionId);
                try {
                  ctx.uiWorkspace.unarchiveSession(childSessionId).catch((error) => {
                    console.warn('dsh-session-enhance: could not restore the side session', error);
                  });
                } catch (error) {
                  console.warn('dsh-session-enhance: could not restore the side session', error);
                }
              }
            },
            openWorkspace: (workspaceId, adopt) => ctx.uiWorkspace.openWorkspace(workspaceId, adopt)
          }
        });
        // 注册一个正文 key。**只有主 key 声明私有 session 子槽**：框架据「注册声明了非 root
        // 作用域子槽」注入 `SessionProvider`（渲染原生会话必需）；而同一个子槽 key 只能被声明
        // 一次，第二个注册再声明会抛 `slot ... is already declared`。所以：
        // - 主 key（正常派发路径）带子槽 → 完整正文；
        // - kind 兜底 key 不带子槽 → 同一组件渲染时 `SessionProvider` 缺席，显示可读提示 +
        //   失败摘要（而不是 owner 的通用 fallback）。
        const registerSideAskBody = (key, withChild) => {
          const entry = { name: 'sidebar.right.pane.tab', key, locale: NS, inject: sideAskFace };
          try {
            add(ctx.slots.register(withChild
              ? { ...entry, children: { [SIDEASK_SESSION_SEAT]: { kind: 'single', scope: 'session' } } }
              : entry, SideAskTab));
            return withChild ? 'session' : 'plain';
          } catch (error) {
            sideAskBodyFailure = String(error?.message ?? error);
            console.error('[dsh-session-enhance] side-ask body registration failed', key, error);
            return 'failed';
          }
        };
        if (typeof ctx.slots.inject === 'function') {
          const injectDisposer = ctx.slots.inject('sidebar.right.pane.tab', () => {
            const bodyModes = [registerSideAskBody(SIDEASK_TAB_ID, true), registerSideAskBody(SIDEASK_KIND, false)];
            console.info('[dsh-session-enhance] side-ask tab body registered', {
              tabId: SIDEASK_TAB_ID,
              kind: SIDEASK_KIND,
              bodyModes,
              failure: sideAskBodyFailure
            });
            return () => {};
          });
          if (typeof injectDisposer === 'function') disposers.push(injectDisposer);
        }

        add(ctx.sidebarRight.registerCloseHandler(SIDEASK_KIND, (sessionId, tab) => {
          const record = store.childOf(sessionId);
          if (record === undefined) return;
          const childSessionId = record.childSessionId;
          const other = hasOtherSideAskTab(sessionId, tab.id);
          if (!other) releaseHold(childSessionId);
          const current = store.get(childSessionId);
          if (current !== undefined && current.kept === true) { forgetSideAsk(childSessionId); return; }
          if (other) return;
          if (current !== undefined && current.archived === true) { forgetSideAsk(childSessionId); return; }
          store.markArchived(childSessionId);
          archiveSideAsk(childSessionId);
          forgetSideAsk(childSessionId);
        }));

        add(ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'side-ask',
          order: -20,
          locale: NS,
          inject: sessionId => ({
            onOpen: () => { void openSideAsk(sessionId); }
          })
        }, SideAskHeaderButton)));

        const textActionsInjected = () => ({
          onAsk: (sessionId, text) => { void openSideAsk(sessionId, text); }
        });
        // 接管官方「引用」表面：同 key 'quote' 用更低 priority 注册即可 shadow。
        add(ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({
          name: 'conversation.chat.text-interaction',
          key: 'quote',
          priority: -1,
          locale: NS,
          inject: textActionsInjected
        }, SideAskTextActions)));
        // 兜底表面：官方 message-quotes 不在、或右键手势时使用本组件自己的 key。
        add(ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({
          name: 'conversation.chat.text-interaction',
          key: SIDEASK_KIND,
          locale: NS,
          inject: textActionsInjected
        }, SideAskTextActions)));
        // 手势准入：selection 上官方先注册（先 open 者赢），这里只在官方缺席时兜底；
        // contextmenu 官方明确不处理，由这里打开同一个合并操作条。
        add(ctx.uiConversation.interactions.register({
          id: SIDEASK_KIND,
          onInteraction(request) {
            const text = request.readText();
            if (text === null || text.trim() === '') return;
            const binding = ctx.sessions.binding(request.sessionId);
            if (binding === undefined) return;
            const session = binding.session.getSnapshot();
            if (session.removed) return;
            if (session.subagent !== null && session.subagent.address.mode !== 'continuable') return;
            request.open();
          }
        }));

        const timer = window.setTimeout(sweep, SIDEASK_SWEEP_MS);
        disposers.push(() => window.clearTimeout(timer));

        return () => {
          for (const disposer of disposers.reverse()) {
            try { disposer(); } catch { /* 忽略 */ }
          }
        };
      }

      let disposeUi = null;
      try {
        disposeUi = registerUi();
      } catch (error) {
        console.warn('dsh-session-enhance: side-ask UI registration failed', error);
        return;
      }
      // Host 组件行被停用时（界面已按「在」渲染），把界面全部撤掉。
      void probeComponent(SIDEASK_RPC_CHANNEL, 'probe').then((available) => {
        if (available) return;
        console.info('dsh-session-enhance: side-ask component is disabled; sidebar UI removed');
        if (disposeUi !== null) {
          try { disposeUi(); } catch { /* 忽略 */ }
          disposeUi = null;
        }
      });
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
    const inject = [
      'slots', 'locale', 'connection', 'sessions', 'configForms',
      'conversation', 'uiConversation', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace'
    ];

    /**
     * 挂载标题栏的「梁谷会话」「分享」「复制」三个控件与 composer 右侧的中断重试按钮，
     * 并把分享对话框 / 梁谷 chip / 中断重试的全部状态与动作绑到各自的 Session。
     *
     * 注册包在 `ctx.slots.inject(SLOT_NAME, …)` 里，而不是裸 `ctx.slots.register`：
     * 槽位名属于 `@deepseek-ai/dsh-client-ui-conversation`，浏览器插件之间的加载顺序
     * 不保证。`slots.inject` 等该槽位被声明出来后才回调注册（随附的 Session 导出插件
     * 与官方反馈插件用的都是同一写法），否则注册可能落在一个还不存在的槽位上、静默
     * 不显示。
     *
     * 每个 Session 各有一份 `inject()` 结果（renderer 按 entry × 会话缓存），所以
     * Toast / 分享快照 / 中断重试快照天然是「每个会话一个」—— 两个会话同时打开时，
     * 点其中一个的按钮不会让另一个的标题栏也弹 Toast 或打开对话框。
     *
     * @param {any} ctx - 浏览器插件上下文。
     * @returns {void}
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-enhance: 词典');

      // 组件能力探测：只探测一次，结果写进 capabilityStore；分享/中断重试/梁谷三个 UI
      // 各订阅自己那一路。
      //
      // 探测**不阻塞**注册：先按"都在"渲染，探测出停用后再收起。这样既不会因为
      // 一次网络抖动把按钮永久藏掉，也不会有"闪一下"的问题（正常情况探测结果与
      // 初始值一致，store 的 set 在值没变时不通知）。
      void Promise.all([
        probeComponent(RPC_CHANNEL, 'share.status'),
        probeComponent(RETRY_RPC_CHANNEL, 'pending'),
        probeComponent(OFFPEAK_RPC_CHANNEL, 'status')
      ]).then(([share, retry, offpeak]) => {
        const current = capabilityStore.getSnapshot();
        if (current.share !== share || current.retry !== retry || current.offpeak !== offpeak) {
          capabilityStore.set({ share, retry, offpeak });
        }
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

      // ---- 梁谷会话：标题栏的模式 chip（暂停倒计时 + 切换 + 失败 Toast）----
      //
      // 与分享/复制挂在同一个 `conversation.session.header.utilities` list 槽位，
      // order -12 落在最左：它是会话级的「模式开关」，与分享/复制这类一次性动作不是一个
      // 量级；放在最左也最容易被一眼认成状态而不是普通按钮。
      ctx.slots.inject(SLOT_NAME, () =>
        ctx.slots.register(
          {
            name: SLOT_NAME,
            id: OFFPEAK_SLOT_ID,
            order: OFFPEAK_SLOT_ORDER,
            locale: NS,
            inject: (sessionId) => {
              const store = createOffpeakControl(
                ctx,
                String(sessionId === undefined || sessionId === null ? '' : sessionId),
                t
              );
              return { hooks: { offpeak: store, capability: capabilityStore }, offpeak: store };
            }
          },
          OffpeakButton
        )
      );
      // chip 的 hover/disabled 规则（选择器只命中本插件自己的按钮，卸载时移除）。
      ctx.effect(() => installOffpeakStyle(), 'dsh-session-enhance: offpeak chip style');
      // 倒计时 ≤60s / ≤10s 的紧迫动效（两处开关共用，只注入一次）。
      ctx.effect(() => installOffpeakMotionStyle(), 'dsh-session-enhance: offpeak countdown motion');

      // ---- 梁谷：新建会话页的「梁谷」开关（hero 行，预设右侧）----
      //
      // 与标题栏右上角的「梁谷」chip 是同一个控制器、同一套行为：点击只切换当前
      // （空白）会话的梁谷开关——不创建会话、不导航、不弹 Toast。新建页上的空白会话
      // 就是即将创建的会话，所以开关打开时，新建出来的会话一定是梁谷会话。
      // 官方把 `conversation.hero.options` 渲染在 workspace chip 与 preset 之后的
      // `heroOptions` 容器里，但用 `margin-left:auto` 推到行尾；`installLiangguNewStyle`
      // 在开关存在时把容器拉回预设右侧。
      ctx.slots.inject(LIANGGU_NEW_SLOT_NAME, () =>
        ctx.slots.register(
          {
            name: LIANGGU_NEW_SLOT_NAME,
            id: LIANGGU_NEW_SLOT_ID,
            order: LIANGGU_NEW_SLOT_ORDER,
            locale: NS,
            inject: (sessionId) => {
              const store = createOffpeakControl(
                ctx,
                String(sessionId === undefined || sessionId === null ? '' : sessionId),
                t
              );
              return { hooks: { offpeak: store, capability: capabilityStore }, offpeak: store };
            }
          },
          LiangguHeroToggle
        )
      );
      ctx.effect(() => installLiangguNewStyle(), 'dsh-session-enhance: lianggu hero toggle style');

      // ---- 中断重试：官方「继续生成」覆盖不到的「用户主动停止」场景 ----
      //
      // 挂在官方 composer 的 `conversation.input.right` 槽位（session scope）：渲染在
      // 输入框右侧、主发送按钮之前，所以不会挡住发送；按钮只在「上一轮被用户中断」时
      // 出现（与官方「继续生成」互斥：官方只在模型失败时出现）。
      ctx.slots.inject(RETRY_SLOT_NAME, () =>
        ctx.slots.register(
          {
            name: RETRY_SLOT_NAME,
            id: RETRY_SLOT_ID,
            order: RETRY_SLOT_ORDER,
            locale: NS,
            inject: (sessionId) => {
              const store = createInterruptedRetry(
                ctx,
                String(sessionId === undefined || sessionId === null ? '' : sessionId)
              );
              return {
                hooks: { interruptedRetry: store, capability: capabilityStore },
                interruptedRetry: store
              };
            }
          },
          InterruptedRetryButton
        )
      );
      // 旋转动画与 hover/disabled 规则（选择器只命中本插件自己的按钮，卸载时移除）。
      ctx.effect(() => installInterruptedRetryStyle(), 'dsh-session-enhance: interrupted retry style');

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

      // 侧边提问组件（Loader 行 dsh-session-enhance/sideask）：右侧栏标签、标题栏入口、
      // 选中文字的合并弹层。Host 行被停用时它会自己把界面撤掉。
      installSideAsk(ctx, t);
    }
    // #endregion

    exports.apply = apply;
    exports.inject = inject;
    // 纯函数与组件导出：离线冒烟（没有浏览器、没有真实 renderer）靠它们检查合并后的
    // bundle 形状；不影响运行时。
    exports.ContextSessionTracker = ContextSessionTracker;
    exports.InterruptedRetryButton = InterruptedRetryButton;
    exports.OffpeakButton = OffpeakButton;
    exports.LiangguHeroToggle = LiangguHeroToggle;
    // 梁谷 chip 的纯函数：离线冒烟测试用它验证状态判定、倒计时格式化、时段文本与时区换算，
    // 不需要浏览器（与 `settingsBooleanField` 同一条路线）。
    exports.offpeakViewState = offpeakViewState;
    exports.formatOffpeakCountdown = formatOffpeakCountdown;
    exports.formatOffpeakClock = formatOffpeakClock;
    exports.formatPeakWindowList = formatPeakWindowList;
    exports.AutoCompactCard = AutoCompactCard;
    exports.AutoCompactToggleRow = AutoCompactToggleRow;
    exports.settingsBooleanField = settingsBooleanField;
    // 侧边提问组件的纯函数与组件（离线冒烟用；不影响运行时）。
    exports.createSideAskStore = createSideAskStore;
    exports.formatSideAskQuoteText = formatSideAskQuoteText;
    exports.SideAskTab = SideAskTab;
    exports.SideAskHeaderButton = SideAskHeaderButton;
    exports.SideAskTextActions = SideAskTextActions;
    return module.exports;
  }
});
