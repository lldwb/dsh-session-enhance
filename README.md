# 会话增强 · dsh-session-enhance

**一个插件包，五个可单独启停的组件**：会话检视（按 ID 查会话与子代理 + 标题栏复制 ID）、会话分享、中断重试（用户主动停止的一轮可重试）、侧边提问（右侧栏里的临时只读问答：新开会话，按会话 id 查询原会话来回答，关闭即归档、保留即转普通会话）、梁谷（右上角开关：高峰时段暂停会话、空闲时段自动恢复）；第一个组件还带**分级上下文压缩**（自动/手动，设置页可开关）。

> 开源（MIT）。仓库地址：<https://github.com/lldwb/dsh-session-enhance>
>
> **5.0.0 移除了「失败重试」组件（破坏性）**：DSH 0.2.2-rc.2 官方已内置失败恢复
> （composer 的「继续生成」），本插件不再提供失败重试。升级前必读
> [5.0 迁移](#50-移除失败重试组件破坏性)。**5.2.0 起新增的「中断重试」组件只处理用户主动
> 停止**（官方不覆盖的 `aborted` 场景），与已移除的失败重试不是同一个东西，见下方
> 「中断重试（5.2 起）」。
>
> **6.0.0 起第四个组件定名「梁谷」**（5.7.0 的「谷峰会话」是旧名，且那一版把空闲时段错写成
> 每天 00:30–08:30）。现在按 DeepSeek 官方《模型 & 价格》的空闲时段口径实现：
> **北京时间周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00 为高峰，其余时间
> （含午休、夜间、周末、法定节假日全天）都是空闲**。见下方
> [梁谷（6.0.0 起）](#梁谷600-起)。
>
> **4.0.0 起包名/仓库名由 `dsh-session-inspect` 改为 `dsh-session-enhance`，显示名回到「会话增强」**。
> 4.0.0 时这个包是「一包三组件」的会话能力合集（检视 / 分享 / 失败重试）；5.0.0 移除失败重试后
> 是「一包两组件」（检视 / 分享）；5.2.0 新增「中断重试」后回到「一包三组件」
> （检视 / 分享 / 中断重试，第三个与已移除的「失败重试」不是同一个东西）。
> 显示名「会话增强」才是对整体用途的描述；`dsh-session-id`（2.x）只覆盖三组件之一，
> `dsh-session-inspect`（3.x）又只描述检视这一面。改名历史与迁移步骤见下方 [4.0 改名](#40-改名)。
>
> **2.0.0 起拆成三个 Loader 行**：「设置 → 插件 → 会话增强 → 包含的组件」里会看到 3 个
> 组件，每个都有独立开关。1.x 只有一行（三件事捆在一起，只能整体开关）。
> **5.0.0 一度只剩 2 个组件（会话增强 / 会话分享）；5.2.0 起又回到 3 个
> （会话增强 / 会话分享 / 中断重试）；5.7.0 起是 4 个（第四个 6.0.0 起定名「梁谷」）。**
>
> **原「失败重试」插件（`dsh-turn-retry`）已于 1.0.0 并入本插件**：它的目录、profile 行与
> GitHub 仓库都已删除。升级时请先卸载旧的 `dsh-turn-retry`，否则会出现两个重试按钮。
> （以上为历史说明；5.0.0 起本插件自己的失败重试组件也已移除，见
> [5.0 迁移](#50-移除失败重试组件破坏性)。5.2.0 起同名的 `-retry` Loader 行重新出现，但那是
> 新组件「中断重试」——只处理用户主动停止，不是旧的失败重试。）

## 加载方式

加载方式：常驻（理由：UI 类 + 诊断类——5 个界面组件常驻，5 个 `session_*` 诊断工具要求任意模式随时可用；约 6.5k 字符 schema 是"常驻里最贵但确实要随时可用"的一类）

> 加载方式是 DSH 插件开发的**必答项**（工作区约定 §10.0）：按需的必须有 skill 入口与
> `onDemand: false` 退路，常驻的必须写理由。这条标记行供人工审阅与将来做门禁。

## 生效方式（桌面应用没有刷新按钮，但有 F12 重载）

- **Host 半改动**（`index.js` / `lib/**` / Loader 行结构）：**重启 DSH**（桌面版完全退出后重开；
  `dsh web` 场景重启服务）。
- **浏览器半改动**（`client.js`）：桌面应用**界面上没有“刷新”按钮**，但两条路都能重载渲染进程：
  1. **推荐（不重启宿主、不中断会话/子代理）**：窗口有焦点时按 **F12** 打开 DevTools
     （`apps/desktop/src/main.ts` 里注册了 `{ role:'toggleDevTools', visible:false, accelerator:'F12' }`，
     生产环境同样可用），在 Console 执行 `location.reload()`；或让焦点留在 DevTools 里按 Ctrl+R。
     页面重新从磁盘拉 `client.js`，插件 client 改动立即生效，宿主与正在跑的子代理不受影响。
  2. 完全退出应用再重开（托盘常驻时注意彻底退出）。
  `dsh web` 场景直接刷新页面即可，但装/卸插件的 client 清单是服务器启动快照，仍需重启服务。
- 只改文档/词典等纯数据：F12 重载或重开应用后生效。**别按“浏览器刷新页面”验收桌面版。**

## 五个组件

| 组件（界面显示名） | Loader 行 | 提供什么 |
|---|---|---|
| 会话增强 | `dsh-session-enhance` | 会话标题栏复制按钮 + 工具 `session_lookup`（按 id 查会话与全部子代理）+ 官方「上下文已用」面板里的**分级压缩**动作（4.5 起自动/手动）+ 工具 `session_resume_subagents`（恢复子智能体，5.1 起只有工具入口） |
| 会话分享 | `dsh-session-enhance/share` | 标题栏分享按钮 + 工具 `session_share` + 免登录只读页 `/share/<token>` |
| 中断重试 | `dsh-session-enhance/retry`（行 id `dsh-session-enhance-retry`） | 用户主动停止后 composer 右侧的「重试」按钮 + RPC `/dsh-session-enhance-retry`；只补官方「继续生成」不覆盖的中断场景（失败仍交给官方） |
| 侧边提问 | `dsh-session-enhance/sideask`（行 id `dsh-session-enhance-sideask`） | 右侧栏标签（页面型 + guide 入口）、标题栏入口、选中文字的「引用文本 / 侧边提问」合并弹层 + RPC `/dsh-session-enhance-sideask`（probe / create / setPreset / restore / forget）；侧边会话是**新开的只读会话**，按会话 id 查询原会话来回答 |
| 梁谷 | `dsh-session-enhance/offpeak`（行 id `dsh-session-enhance-offpeak`） | 标题栏右上角的「梁谷」开关 + 新建会话页的「梁谷」开关（太阳+梁峰 / 月亮+梁谷+剩余时间，6.3.3）+ Host 的 Agent hold 控制器 + RPC `/dsh-session-enhance-offpeak`（status / setEnabled / diag）；高峰时段暂停模型调用、输入留在队列，空闲时段自动恢复 |

> **为什么第一个组件叫「会话增强」而不是「会话 ID / 会话检视」**：浏览器半（四块界面）只能挂在
> **精确包名**那一行上——`@deepseek-ai/dsh-client-modules` 的 `locatePkgJson()` 只接受
> 精确包名，子路径 specifier 直接返回 `undefined`，那一行就不会有 client 半。所以第一行
> 必须是 `dsh-session-enhance`，它的组件标题只能等于包根 `locale/`（也就是卡片标题「会话增强」）。
> 另四行是子路径，各自有 `share/locale/`、`retry/locale/`、`sideask/locale/`、`offpeak/locale/`，
> 所以能叫「会话分享」「中断重试」「侧边提问」「梁谷」。

五部分互相独立：只装 Host 半也能查会话，只装浏览器半也能复制 id / 分享 / 中断重试 / 侧边提问 / 切梁谷开关。

> **别把「中断重试」和 5.0 移除的「失败重试」搞混**：5.0.0 删掉的是旧的失败重试组件
> （`/dsh-turn-retry` 通道、`data-turn-retry` 选择器、失败后自动覆盖层），失败后请用官方
> 「继续生成」；5.2.0 重新插入的 `dsh-session-enhance/retry` 行是**新组件「中断重试」**，
> 只处理用户主动停止的那一轮。两者场景互斥（见下方「中断重试（5.2 起）」）。

## 侧边提问（6.1.0 起）

在右侧栏里问一个「顺带的问题」，不打断主会话，也不把主会话的上下文搬进新会话。

**三个入口**：

1. 右侧栏标签条「+」→ 引导页里的「侧边提问」卡片；
2. 会话标题栏右侧的「侧边提问」按钮；
3. 在会话里**选中一段文字** → 弹层里并排两个按钮：「引用文本」（等同官方引用，插进主会话
   输入框）与「侧边提问」（把选中文字作为引用，到侧边会话里问）。

**侧边会话不是分支，是「按会话 id 查询」**：它由 `sessionController.create` **新开**一个
普通会话（沿用原会话的工作区与 Agent 预设），并把一段**询问提示词**预填进输入框：

```text
你是一个「侧边提问」临时助手，只读。

参考会话：<原会话 id>（原会话标题）
需要了解上文时，用这些工具按会话 id 查询它：session_overview / session_grep / session_read / session_lookup。
不要假设自己已经读过这个会话。
约束：只读——不要写文件，也不要执行会改动文件的命令；回答直接、简短。

[如果带引用]
用户选中的原文（来自该会话）：
> …

我的问题：
```

因此：侧边会话**不背**原会话的上下文预算，也不继承它的思考/工具轨迹；需要哪些上文由模型
按问题自己检索。提示词是可见、可编辑的（预填不自动发送），用户在其后补上问题即可。

**只读**：Host 侧创建会话后立刻 `permissionPresets.setPreset({ sessionId, preset: 'read-only' })`。
**fail-closed**：只读切不上就把刚建的会话归档并报错，绝不留下一个可写的「临时」会话。只读模式下
写文件 / 跑改文件的命令会被宿主沙箱拒绝；模型请求提权时会走审批，默认拒绝。

**关闭即归档，保留即普通会话**：

| 时机 | 侧边会话状态 |
|---|---|
| 标签打开期间 | 临时、只读；关闭标签默认归档（从会话列表消失） |
| 点「保留」 | 切回原会话当时的权限预设（可写），成为普通会话，关闭标签也不归档 |
| 点「改回临时」 | 再切回只读 |
| 重启宿主 | 标签恢复时自动取消归档；没有标签页的遗留临时会话在启动清扫里归档 |

**为什么接管官方「引用」弹层**：官方 `ctx.uiConversation.interactions` 是独占式的（第一个
`open()` 的插件独占该手势的表面），官方 `message-quotes` 在 selection 上永远 `open()`。
要让「引用文本」和「侧边提问」并排出现在**同一个**弹层里，只能接管它渲染的表面：
`conversation.chat.text-interaction` 是 keyed 槽，同 key `quote` 用更低的 `priority`（-1）
注册即可 shadow 官方实现（最低 priority 渲染）；「引用文本」按钮完整复刻官方行为
（`inputActions.insertQuote`）。另用本组件自己的 key 注册同一组件兜底（官方缺席 / 右键手势）。
组件行被停用时浏览器半会把这些注册全部撤销，官方表面自动恢复。

**为什么标签正文要声明一个私有 session 子槽**：渲染**子会话**的原生会话需要框架注入的
`SessionProvider`，而它只在「本注册声明了非 root 作用域子槽」时提供；随附 `ui-subagent`
已全局声明了 `sidebar.chat.conversation`，第三方再声明会抛 `slot ... is already declared`。
所以声明一个自己命名、只声明不渲染的 session 子槽来触发注入，再用它包住
`renderFactorySlot('conversation.content', { variant: 'embedded', … })`。

**RPC 通道**（`lib/sideask/rpc.mjs`，前缀 `/dsh-session-enhance-sideask`）：
`probe`（可用性探测）、`create`（新开只读会话 + 生成提示词）、`setPreset`（只读 / 恢复）、
`restore`（保留时恢复原预设）、`forget`（标签关闭后清理 Host 登记）。

## 4.0 改名

| 项 | 2.x | 3.x | 4.0.0 |
|---|---|---|---|
| 包名 / 仓库 | `dsh-session-id` | `dsh-session-inspect` | `dsh-session-enhance` |
| 显示名 | 会话增强 | 会话检视 | **会话增强（英文 Session Enhance）** |
| Loader 行 id | `dsh-session-id` / `-share` / `-retry` | `dsh-session-inspect` / `-share` / `-retry` | `dsh-session-enhance` / `-share` / `-retry`（5.0.0 移除 `-retry`，5.2.0 起以「中断重试」重新出现） |
| 分享 RPC 通道 | `/dsh-session-id` | `/dsh-session-inspect` | `/dsh-session-enhance` |
| 分享记录目录 | `<DSH_HOME>/dsh-session-id/` | `<DSH_HOME>/dsh-session-inspect/` | `<DSH_HOME>/dsh-session-enhance/`（旧目录只读回退） |

**升级必须做的**（破坏性，major）：

1. 从 profile 的 `dsh.profile.bundles` 与 `dependencies` 里删掉旧包 `dsh-session-inspect`
   （或更旧的 `dsh-session-id`），删掉 `profiles/<profile>/plugins/<旧包名>/`；
2. 用新包重新 `dsh plugin add dsh-session-enhance`（或本地目录 link），执行 `pnpm install`；
3. 重启 DSH（桌面版完全退出后重开；client 清单是服务器启动时的快照）。

> 4.0.0 时还有第 3 条「如果你曾停用『失败重试』组件，把 `- id: <旧包名>-retry` 改成
> `- id: dsh-session-enhance-retry`」。**5.0.0 起该行被移除，这条不再适用**；而 **5.2.0 起同名行
> 重新用于新组件「中断重试」**——你保留或新写的 `- id: dsh-session-enhance-retry` + `disabled: true`
> 现在表示**停用中断重试**（不是旧的失败重试）。详见 [5.0 迁移](#50-移除失败重试组件破坏性)
> 与下方「中断重试（5.2 起）」。

**4.0.0 改名时刻意保留的兼容标识**（改名不改它们，避免无谓回归与历史断层；5.0.0 起重试相关项已随旧组件移除，5.2.0 起部分随新组件恢复）：

- 分享动作通道仍是 `/dsh-session-enhance`（4.0 起；`/dsh-session-inspect`、`/dsh-session-id` 只作历史）；
- 界面选择器 `data-session-share`（分享 / 复制）；
- `exports` 子路径：`./share`、`./client`、`./locale/*.json` 结构不变；
  **`./retry`、`./retry/locale/*.json`、`./retry/icon` 于 5.0.0 移除**，5.2.0 随「中断重试」
  组件又全部重新出现（`./retry` → `retry/index.js`，`./retry/locale/*.json`，
  `./retry/icon` → `icon.svg`）；
- 5.0.0 移除的旧「失败重试」标识不会回来：RPC 通道 `/dsh-turn-retry`、`RETRY_SOURCE_KIND` 与
  `dsh-session-id-retry-` 消息前缀、界面选择器 `data-turn-retry` / `data-dsh-turn-retry-button`。
  5.2.0 的「中断重试」是另一套：RPC `/dsh-session-enhance-retry`、选择器
  `data-interrupted-retry`（见 [5.0 迁移](#50-移除失败重试组件破坏性) 与下方「中断重试（5.2 起）」）。

分享记录不会丢：新路径没有文件时会按 3.x → 2.x 顺序只读加载历史 `shares.json`；一旦有新写入
就落到新路径，旧文件原样保留（回滚到旧版本也能继续读）。

## 5.0 移除失败重试组件（破坏性）

**5.0.0 起本插件不再包含「失败重试」组件。** 这不是功能缩水，而是官方补齐了同一件事：
DSH 0.2.2-rc.2 已内置失败恢复。

### 为什么移除

- 官方 composer 提供 `retry(failureSeq)`，会话 API 提供 `conversationContinuation` 投影
  （"Eligible latest failed turn/end for an empty prompt"）：一轮以失败结束后，空
  `prompt.content` 在 queue 模式下会为符合条件的失败空闲会话开新一轮，并记录一条
  `source.kind: 'retry'` 的空 user 消息；用户可见的入口就是「继续生成」（`input.continue`）。
- 官方已经覆盖「失败后继续」，本插件再挂一个覆盖层按钮只会和官方按钮抢同一个位置，
  还多维护一套 RPC 与闸门状态机，没有净收益。

### 移除了什么

- Loader 行 `dsh-session-enhance-retry`（组件「失败重试」）：**3 行变 2 行**；
- 目录与模块：`retry/index.js`、`retry/locale/`、`lib/retry/*`、`test/retry/*`；
- `exports`：`./retry`、`./retry/locale/*.json`、`./retry/icon`；
- RPC 通道 `/dsh-turn-retry`；
- 界面：composer 里的重试覆盖层，以及选择器 `data-turn-retry` / `data-dsh-turn-retry-button`。

保留：会话增强（复制会话 ID、`session_lookup`、`session_resume_subagents`、分级上下文压缩）
与会话分享，行为不变。（5.2.0 起新增第三个组件「中断重试」，见下方用法；它不是 5.0 移除的
「失败重试」——`/dsh-turn-retry` 通道与 `data-turn-retry` 选择器不会回来。）

### 用户必须做什么（升级步骤）

1. **处理 profile 补丁层里的 retry 行 override**：如果你在 4.x 曾停用「失败重试」组件，
   profile 的补丁层里会有这样一行：

   ```yaml
   - id: dsh-session-enhance-retry
     disabled: true
   ```

   5.0.0 时这个 Loader 行不存在，应**整条删掉**（不是改名）。**5.2.0 起同 id 行重新用于
   「中断重试」**：删掉这一行 = 启用新组件；保留 `disabled: true` = 停用中断重试。
2. 升级包本身（`dsh plugin add` / 更新本地 link）并执行 `pnpm install`；
3. **重启 DSH**（桌面版完全退出后重开；client 清单是服务器启动时的快照）。重启后
   「设置 → 插件 → 会话增强 → 包含的组件」在 5.0.0 时是 **2 个**（会话增强 / 会话分享）；
   **5.2.0 起是 3 个**（多一个「中断重试」）。

### 边界：官方「继续生成」只覆盖失败，不覆盖主动停止

- 官方入口出现在**一轮以失败结束**之后：`error`，错误码属于 RATE_LIMIT / SERVER / TIMEOUT /
  TRANSPORT / EMPTY_RESPONSE / STREAM_CLOSED，并且有已准入的用户工作。你点了停止的那一轮是
  `aborted`（用户主动停止），官方**不覆盖**，不会出现「继续生成」。
- **5.2.0 起这个空缺由本插件的「中断重试」组件补上**（composer 右侧的「重试」按钮，见下方
  「中断重试（5.2 起）」）；官方本身仍不覆盖主动停止。
- 官方的继续是**新一轮**（会留下一条 `source.kind: 'retry'` 的空 user 消息），不是 4.x
  那种「在同一 turn / step 原地重新调用模型」；「中断重试」同样是新一轮（`agent.followup()`）。
- `CONTEXT_WINDOW_EXCEEDED` 是确定性失败，重发只会再次超长，别指望重试解决——用下面的
  压缩能力（自动 / 手动分级压缩）。

## 停用某个组件之后

浏览器半只有一份（`dsh.client` 是包级声明，不能按行拆），它会跟着第一行一起加载。为了
不让被停用的组件留下"点了没反应"的按钮，浏览器半启动时会在三个子组件的通道上各发一次
**能力探测**请求（分享 `/dsh-session-enhance`、中断重试 `/dsh-session-enhance-retry`、
梁谷 `/dsh-session-enhance-offpeak`）：

- Host 的 RPC 前缀路由只在对应行启用时才注册；
- 组件在 → `POST /dsh-session-enhance`（或 `/dsh-session-enhance-retry` /
  `/dsh-session-enhance-offpeak`）返回 **200**（缺参数的业务信封也是 200）；
- 组件停用 → 请求落到 SPA fallback，返回 **405**。

探测不阻塞 UI 注册、最多退避重试 3 次；判定不了的（网络异常、非 200/405）一律乐观保留，
不会因为一次抖动把按钮永久藏掉。于是：

- 停用**会话分享** → 标题栏分享按钮换成隐藏占位（`data-session-share="disabled"`）；
- 停用**中断重试** → composer 右侧的重试按钮换成隐藏占位（`data-interrupted-retry="hidden"`），
  按钮不渲染；
- 停用**梁谷** → 标题栏右上角的梁谷开关换成隐藏占位（`data-offpeak-hidden="disabled"`，
  不渲染 `data-dsh-offpeak-button`），Host 释放该会话的 hold，会话立即恢复正常运行；
- 停用**会话增强**（第一行）→ 四块界面（分享 / 复制 / 中断重试 / 梁谷开关）随 client 半一起消失，
  `session_lookup` 也不可用；
- 重新启用后（桌面版重开应用 / 浏览器版刷新页面），按钮自动回来（探测只做一次，不写任何持久缓存）。

## 安装

```powershell
git clone https://github.com/lldwb/dsh-session-enhance.git
cd dsh-session-enhance
# 装进当前 profile（例如 desktop）
dsh plugin add .
```

也可以直接把本地目录交给 `dsh plugin add <插件目录>`。

运行时只依赖 `@deepseek-ai/schemastery`（声明配置 schema 用，随 DSH 提供）；默认零配置，
设置页里只有一个「自动压缩」开关（默认关）。**梁谷默认关闭**；它的高峰时段 / 时区 /
法定节假日 /「新会话默认启用」在「设置 → 插件 → 会话增强 → 包含的组件 → 梁谷」的配置页里
可改（默认高峰周一到周五 09:00–12:00、14:00–18:00，`Asia/Shanghai`，内置 2026 年
法定节假日；保存后热更新）。装好后（桌面版重开应用 / 浏览器版刷新页面）即可看到按钮；新会话里即可调用工具。

> **新增 Loader 行（5.7.0 的第四个组件）需要重启 DSH 才会进入 Loader 树**：Loader 树在进程
> 启动时按 profile + 各 bundle 的 patch 合成，运行期只允许「已有行」热更新；重开应用（桌面）或刷新页面（浏览器）只能更新
> 已加载行对应的 client 半。重启后「包含的组件」是 4 个、右上角出现「梁谷」开关。
> **6.0.0 的配置字段变了**：旧的 `offPeakStart` / `offPeakEnd` 已删除，profile 补丁层里
> 如果给这一行写过它们，请改成 `peakWindows` / `timeZone` / `holidays` / `defaultEnabled`。

## 用法

### 会话 ID

会话标题栏右侧、在「⋯」之前多一个复制图标按钮：

- 点击 → 剪贴板里就是当前会话 id，顶部弹 toast「会话 ID 已复制」；
- 鼠标悬停 → `title` 显示完整 id，用来确认"复制的是哪一个"；
- `navigator.clipboard` 被拒（非安全上下文 / 权限关闭）时自动降级到
  `document.execCommand('copy')`；两条都失败才提示失败，不会静默无反应。

拿到 id 后可以直接贴进任何会话问 Agent，例如"用 session_lookup 看看 `<id>`，它有哪些子代理？"

**id 的三种写法都认**（同一个会话，指向同一份日志）：

| 写法 | 从哪来 | 例子 |
|---|---|---|
| `session-<uuid>` | 根会话的真实 id；「复制会话 ID」按钮复制的就是它 | `session-559eb381-39ff-42bf-b3b6-4ae109b37eb1` |
| `<uuid>` | **子代理会话**的真实 id（没有前缀）；也是 `~/.dsh/sessions/…/subagents/<uuid>/` 的目录名 | `1da52432-571f-458c-a8f0-5716e8cf2d59` |
| `dsh-session-session-<uuid>.zip` | 会话导出文件名（用户用 `@` 引用 zip 时就是它）；整条路径、带不带 `.zip` 都行 | `C:\Users\me\Downloads\dsh-session-session-559eb381-….zip` |

归一化的锚点是 **UUID**：精确 id 没命中时，插件会用 `sessionQuery.listSessions()` 按 UUID 回查一次
语料库，命中就把真实 id 用起来，并在摘要里明说「你给的 X 与真实 id Y 是同一个会话」——
不会悄悄改写。命中多个时报「不唯一」而不是随便挑一个；回查本身失败（例如存储不可用）时
把原始错误带出来，不会伪装成「会话不存在」。

> 为什么需要这个（真实事故 2026-11-15）：用户在会话里写 `session-559eb381-…会话提到的…`，
> 模型把前缀丢掉、又粘上了后面的中文，`session_lookup` 拿整串去精确匹配，回「找不到会话」——
> 而那份会话就在本机。精确匹配只该是快路径，不该是唯一路径。

### `session_lookup`

| 参数 | 必填 | 默认 | 含义 |
|---|---|---|---|
| `sessionId` | 否 | 当前会话 | 目标会话 id，三种写法都认（见上）。省略时查调用它的会话本身 |
| `includeMessages` | 否 | `true` | 是否附带最近消息（关掉就只返回元数据，连谱系内容也不读） |
| `messageLimit` | 否 | `10`（上限 200） | 目标会话返回多少条最近消息 |
| `includeNestedMessages` | 否 | `true` | 是否读取**谱系内其他会话**的内容（祖先 + 全部后代） |
| `nestedMessageLimit` | 否 | `2`（上限 10） | 每个谱系会话返回多少条最近消息 |

返回内容（结构 + 一段人可读的 markdown 摘要）：

```
session            目标会话：id / 标题 / workspace / 预设 / 角色 / 父会话 / delegationDepth / live / persisted / 是否当前会话
ancestors          已知父级链（由近到远）；血缘不完整时 complete=false 并给出 unresolvedParentId
subagents          全部后代会话（**递归到孙会话、曾孙会话…**），父在前：id / 标题 / depth / parentId / 创建时间 / 状态
nested             谱系内会话的**内容摘要**（祖先 + 全部后代）：
                     id / 标题 / role / relation(ancestor|descendant) / depth / parentId（它的上级）
                     task（它的第一条用户消息 = 它被交办的事） / messages（最近 N 条） / error（读失败时的原始错误）
nestedTruncated    因单次上限（20 个）没读的谱系会话数
messages           目标会话最近 N 条人对人消息（user / assistant / 压缩摘要）
inheritedEventCount 种子会话从父会话继承的事件数
```

**「顺着会话树读」是默认行为**：
- 目标是根会话 → 摘要里带出每个子会话、子会话的子会话的「任务 + 最近消息」，一眼看清整条链谁在干什么；
- 目标是子会话/孙会话 → 先给祖先链（`subagents` 递归的反向），再给每个上级的「任务 + 最近消息」，
  所以「谁派的它、上级当时在做什么」都是一次调用里拿到的；
- 读取是**按需且有上限**的：`includeNestedMessages=false` 或 `includeMessages=false` 就退回纯元数据；
  谱系会话超过 20 个时只读前 20 个，并在摘要里写明「还有 N 个没读」；
- 某个谱系会话的日志读不出来时**不影响其余**：该节点 `error` 带原始错误，摘要里标「读取失败」，
  不会伪装成「这个子会话什么都没做」。

只读：不创建、不修改、不删除任何会话。

### 长会话怎么读：`session_overview` → `session_grep` → `session_read`

`session_lookup` 是「把整棵树的内容一次读出来」的重工具。会话一长（真实案例：**4468 个事件、
736 次工具调用、2730 分钟跨度**）这条路就不合适了——它只给最后几条、每条截断。
三个补位工具构成一条「先概括、再定位、后精读」的路径：

| 工具 | 一次调用读什么 | 回答什么 |
|---|---|---|
| `session_overview` | 目标会话**一次**整份日志 | 这是什么会话、多大（事件数 / 工具调用 / 回合 / 时间跨度）、任务是什么、最近在做什么、树里有哪些相关会话、下一步该用哪个工具 |
| `session_grep` | 目标会话**一次**日志扫描 | 里面提到 X 的地方在哪：命中 `seq` + 片段 + `nextFromSeq` 翻页 |
| `session_read` | 目标会话**一次**日志读取 | 某个 `seq` 前后到底写了什么（含工具调用/结果、已被 prune 的 shadowed 事件） |

**推荐顺序**（工具描述里也是这么写的）：拿到会话 id 先 `session_overview`；如果
`stats.logEvents` 很大（几百以上），用 `session_grep` 定位，再 `session_read` 精读；
会话不长才直接 `session_lookup` 读全树。

参数：

| 工具 | 参数 | 默认 | 含义 |
|---|---|---|---|
| `session_overview` | `sessionId` / `related` / `recentLimit` | 当前会话 / `true` / `3`（上限 20） | 目标 id；是否列树（只取 header，不读内容）；带出多少条最近消息 |
| `session_grep` | `sessionId` / `query` / `limit` / `fromSeq` / `types` | 当前会话 / 必填 / `20`（上限 50）/ `0` / 全部 | 检索词（**字面、大小写不敏感**，空格分词 AND，最多 5 词）；翻页把上次的 `nextFromSeq` 传回 `fromSeq` |
| `session_read` | `sessionId` / `seq` / `before` / `after` / `tailLimit` | 当前会话 / 省略=读尾部 / `3`（上限 50）/ `3`（上限 50）/ `10`（上限 100） | 窗口模式给 `seq`；尾读模式给 `tailLimit` |

> **为什么检索要自己实现**：官方 `session_event_search` / `session_event_read` 带**工作区授权**
> ——读别的工作区的会话会直接报
> `Error: session target is outside the caller workspace`（`SESSION_QUERY_TOOL_UNAUTHORIZED`）。
> 用户从界面复制来的会话 id 常常属于别的工作区，于是「检索/精读」整条路会被挡住。
> 本插件的四个查询工具都走 `sessionQuery` 服务，没有这层工具级限制，只读、不做任何写操作。
> 授权口径：**id 是用户主动给的**，等价于用户授权读这一份会话。

> **为什么叫 `session_grep` 而不是 `session_search`（5.6.2）**：随附包的
> `@deepseek-ai/dsh-tool-session-query` 已经注册了 `session_search`（跨会话检索）、
> `session_event_search` / `session_event_read` / `session_trace` / `session_event_trace`。
> 工具注册表对**重名是硬失败**，5.6.0 用 `session_search` 这个名字时，官方
> 「会话搜索」插件的「会话历史工具」整行被标成「异常」：
> `tool "session_search" is already registered`。所以本插件的会话内检索叫 `session_grep`
> （语义也更准：字面匹配、不走索引）。`test/entries.test.mjs` 有一条门禁：本插件注册的
> 工具名不得与随附包那五个官方名字重合。

### 会话分享

会话标题栏的**分享按钮**（复制按钮左侧）打开「分享会话」对话框：

- 想分享就点「创建分享链接」→ 得到一个 `http://<host>:<port>/share/<token>` 链接；
- 链接可以「复制」、在浏览器里「打开」、或「下载 HTML」（`?download=1`，存成单文件，
  发给别人直接双击就能看）；
- 「停止分享」两段式确认后立即失效（再访问 404）。

分享页是**只读快照**：标题、创建时间、消息（用户 / 助手 / 压缩摘要）、子代理列表，
不依赖 DSH、不需要登录、不带脚本。它**不展示**会话 id、工作目录、token，也不展示工具
调用参数与结果。

Agent 也能分享：用户明确要求时，工具 `session_share` 支持
`create` / `status` / `revoke` / `list` 四个动作（描述里写明"只有用户明确要求时才调用"）。
`sessionId` 同样接受三种写法（完整 id / 裸 UUID / 导出文件名）；归一化后**分享记录落在真实
id 上**——否则分享页会按记录里的 id 读不到会话。

#### 分享支持到什么程度（重要）

| 场景 | 是否支持 |
|---|---|
| 本机浏览器打开分享链接 | ✅ 开箱即用 |
| 局域网其它机器打开 | ✅ 需要把 DSH web 绑到局域网地址：`dsh web --host <局域网IP>`（或部署时配置） |
| 公网分享链接（像 DeepSeek 网页版那样发出去就能看） | ⚠️ 取决于部署：需要反代 / 内网穿透 / 公网地址 + `--public-url`；DSH 本身默认只监听 `127.0.0.1` |
| 完全离线分享 | ✅ 用「下载 HTML」把单文件发出去 |
| 口令保护 / 有效期 / 访问统计 | ❌ 未实现（token 本身即凭据，可随时撤销） |

链接里的根地址来自 `webApp.getAdvertisedUrl()`（部署配置了对外地址时）或本机监听
origin；两者都拿不到时创建会明确报错，而不是给一个打不开的链接。

### 重试：用官方的「继续生成」（5.0 起）

**5.0.0 起本插件不再提供失败重试按钮**，改用 DSH 0.2.2-rc.2 官方内置的失败恢复
（5.2.0 另有只处理「中断」的「重试」按钮，见下一节「中断重试（5.2 起）」，不冲突）：

- **入口**：一轮以失败结束后，composer 上会出现官方的「继续生成」入口（`input.continue`）；
  点它即由官方 `retry(failureSeq)` 继续这一轮。本插件不再参与，也不会出现额外的覆盖层按钮。
- **官方实现**：会话 API 的 `conversationContinuation` 投影标记「最近一轮失败、会话空闲」的
  状态（"Eligible latest failed turn/end for an empty prompt"）；在 queue 模式下提交空
  `prompt.content` 会为符合条件的失败空闲会话开新一轮，并记录一条 `source.kind: 'retry'`
  的空 user 消息。
- **是新一轮，不是原地重试**：官方的继续会留下上面那条空 user 消息，不同于 4.x 的
  「在同一 turn / step 原地重新调用模型」。
- **停止后官方没有入口**：官方只覆盖「失败」，不覆盖「用户主动停止」。点了停止之后这一轮
  正常结束，没有「继续生成」；**5.2.0 起本插件的「中断重试」组件补这个空缺**（见下一节），
  或者直接在输入框里发一句话（例如「继续」）。
- **上下文溢出不要重试**：`CONTEXT_WINDOW_EXCEEDED` 是确定性失败，重发只会再次超长。
  请用 composer 左侧的「上下文 / 压缩」（见下一节），或启用官方 `dsh-compaction-basic`
  让系统在达到阈值时自动压缩。

> 4.x 的原重试行为（原地重试、停止后 followup、30 分钟可重试记录、错误码提示）已随组件
> 移除，历史实现见 CHANGELOG 的 3.1.0 / 4.1.0 / 5.0.0 条目。

### 中断重试（5.2 起）

官方「继续生成」只覆盖**失败**，不覆盖你主动点「停止」的那一轮（`turn/end` 的 `reason.kind`
是 `aborted` 而不是 `error`）。5.2.0 新增的**「中断重试」组件**专门补这个空缺：

- **触发条件**：你在某轮中途按了停止，Host 收到
  `turn/end { reason: { kind: 'aborted', reason: { kind: 'user' } } }` 时记录一条「可重试」；
  该会话出现新的 `turn/start` 或新的用户消息后，记录立即**作废**（已经继续过了就不再给入口）；
- **按钮位置**：composer 右侧、主按钮之前的「重试」按钮（槽位 `conversation.input.right`），
  不遮挡官方的发送 / 「继续生成」按钮；
- **三态**：`ready`（有可重试记录，按钮可点；每 30 秒向 Host 复查一次，记录没了就自己隐藏）→
  点击后 `busy`（按钮置灰、等待 Host 完成）→ `failed`（这次重试没成功时显示错误码约 3 秒，
  随后隐藏并重新查询——记录还在就回到可点状态）。会话正在跑或挂着子智能体时按钮不显示；
- **点击后做什么（6.3.0 起：官方优先）**：Host **先走官方 continuation**
  （`sessionController.prompt({ content: [] })`，与官方「继续生成」同一条服务路径）；官方可用
  时不注入任何提示词。只有官方不可用 / 抛错（例如该轮不满足官方 continuation 条件）时，才
  回退到 `agent.followup()` 发一条中性的 user 消息
  （「上一轮被用户中断。请从中断处继续完成，不要复述已完成的部分。」）。两条都失败才向界面
  返回错误码。历史里若出现那条中性消息，说明走的是回退路径；
- **30 分钟 TTL**：中断后没人点，记录 30 分钟后过期；期间切到别的会话、重开应用再回来仍能点；
- **边界：Host 重启后记录丢失**：记录只存在内存里（不落盘），DSH 重启后要重新触发一次「停止」
  才会再出现按钮；
- **可单独启停**：停用 `dsh-session-enhance-retry` 行后，浏览器半的能力探测拿到 405，按钮换成
  隐藏占位（`data-interrupted-retry="hidden"`），不会留下"点了没反应"的按钮。

**与官方「继续生成」的分工**：官方 = 失败（`error`，且错误码属于 RATE_LIMIT / SERVER /
TIMEOUT / TRANSPORT / EMPTY_RESPONSE / STREAM_CLOSED，并有已准入的用户工作）；本组件 = 中断
（`aborted` 且是用户主动停止）。两者**互斥**，不会对同一轮同时出现；失败永远交给官方。

> 无需改配置，升级后**重启 DSH** 生效（桌面版完全退出后重开；client 清单是服务器启动时的快照，浏览器版刷新页面也不够）。

### 梁谷（6.0.0 起）

> 5.7.0 里这个组件叫「谷峰会话」，且那一版的空闲时段实现（每天 00:30–08:30）是错的；
> 6.0.0 起定名「梁谷」，并按下面的官方口径重做时间判定。从 5.7 升 6.0 是破坏性变更，
> 见本节末尾的升级说明。

「梁谷」把会话**只在 DeepSeek 空闲时段跑**：高峰时段暂停这个会话的模型调用，此时发出的消息
留在**官方队列**里，空闲时段到了自动释放并续跑。开关在**会话标题栏右上角**，每个会话一份。

**官方口径（本组件按它判断）**：

> 空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）
> 9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天
> 均为空闲时段。

即：**高峰 = 工作日 09:00–12:00、14:00–18:00（法定节假日除外）；午休、夜间、周末、
法定节假日全天都是空闲**。本组件内置 2026 年法定节假日表（元旦 01-01..01-03、春节
02-15..02-23、清明 04-04..04-06、劳动 05-01..05-05、端午 06-19..06-21、中秋
09-25..09-27、国庆 10-01..10-07，来源国务院办公厅 2026 年放假通知）；跨年后请在配置页
更新 `holidays`（或清空表示不豁免节假日）。

- **开关长什么样**（`conversation.session.header.utilities` 槽位，order `-12`，落在分享 / 复制
  按钮左侧；6.3.8 起与新建页开关统一为官方 `Pill` + `Tooltip` 形制）：
  - 关：灰字「梁谷」（太阳图标）；
  - 开 + 高峰：琥珀色「梁谷 2m32s」（弯月+星星图标，倒计时到空闲时段开始；**剩余 > 1 小时
    显示 `3h05m`，≤ 1 小时显示 `12m34s`，不足 1 分钟显示 `0m42s`**）；
  - 开 + 空闲：绿色「梁谷 空闲」；
  - 切换中：置灰「梁谷 …」；失败时 chip 旁弹 Toast（带错误码），状态回退到切换前的值；
  - **尺寸固定（6.3.9 起；6.4.1 收紧到 105px）**：无论开关/状态/文案/倒计时怎么变，chip 都是
    `105×24`，不会跳动；倒计时剩余 ≤60s 时带呼吸动效（`urgent` 1s / `final` 0.45s 加粗，
    见 6.4.1）；
  - 悬浮提示走官方 `Tooltip` 深色气泡（1~2 行）：关=「梁谷：关闭 / 点击开启…」，暂停=「梁谷：
    高峰暂停 / 将在 HH:MM 自动恢复 / 队列中 N 条消息…」，空闲=「梁谷：空闲 / 将在 HH:MM 自动暂停」。
- **新建会话页的「梁谷」开关**（6.3.0 起；6.3.3 起显示重做）：新建会话页「未分组 / 标准模式」
  那一行、**预设下拉框右侧**有一个开关。它与标题栏右上角的「梁谷」chip **是同一个开关**：
  - 点击只切换当前（新建页空白）会话的梁谷开关——**不创建会话、不导航、不弹 Toast**；
  - 开关打开时，这里新建出来的会话**一定就是梁谷会话**（空白会话 id 就是即将创建的会话，
    直接写开关即可，不再由界面代建会话）；
  - 显示（6.3.3）：**关 = 太阳 +「梁峰」**（次要文字色）；**开 = 月亮 + 小星星 +「梁谷」+
    剩余时间（如 `1h12m`）或「空闲」**（暂停琥珀、空闲绿，6.3.7 起月亮右上角带一颗四角星）；
    两种状态都始终显示文字；**尺寸固定为 `105×24`（6.3.9 起，6.4.1 收紧），不随状态变化**；
  - 悬浮提示（6.3.6）：用官方 `Tooltip`（深色气泡、`role="tooltip"`），**不用元素原生
    `title`**（那是系统白底黑框）；文案 1~2 行：关=「梁谷：关闭 / 点击开启…」，暂停=「梁谷：
    高峰暂停 / 将在 HH:MM 自动恢复」，空闲=「梁谷：空闲 / 将在 HH:MM 自动暂停」；
  - 关掉开关后再从这里开始的会话按普通会话处理。
- **重启/关闭应用后自动恢复**（6.3.0 起）：梁谷会话在高峰暂停期间排队（官方 durable inbox）
  的消息，在应用重启、会话重新打开后——若已到空闲时段且队列里有消息，会被**延迟 1.2 秒复查**
  一次：Agent 自己已经续跑就什么都不做（已有历史的会话通常如此）；仍空闲才注入唤醒（官方
  continuation 优先，官方不可用才用「中断重试」的空 retry 消息，历史里可能多一条紧凑的
  「已请求继续生成」）；若仍在高峰则继续暂停。
- **高峰发消息会怎样**：消息被 Host 接收并进入**官方 durable 队列**（暂停中先显示为「待发送」
  气泡；重开应用后出现在 composer 上方的队列条——和平时「会话忙时排队」是同一个 UI，可编辑/
  删除），但**不会开始任何模型调用**；空闲时段开始后按队列顺序逐条执行。
- **高峰开始的那一刻正在跑的一轮**：会被中断（`agent.cancel({kind:'hook'})`，保留队列），
  所以不会继续在高峰烧 token；这一轮在空闲时段会**自动续跑**——聊天里会出现一条紧凑的
  「已请求继续生成」标记（官方 continuation 触发的空 `source.kind: 'retry'` 消息）。
- **子代理也算「该会话」**：沿 `session.header.parentSession` 向上，任一祖先会话启用了梁谷，
  子树里的 live Agent 一并被 hold/cancel；**祖先会话即使已经关闭（没有 live Agent），只要它的
  开关记录仍是启用，子代理也照样被覆盖**（6.2.0 起）；禁用父会话时子树一起释放。
- **开关是即时的**：高峰打开 → 立刻暂停（必要时中断当前轮）；空闲打开 → 不暂停；关闭 →
  立刻释放，队列里压着的消息马上开始跑。
- **配置**（设置 → 插件 → 会话增强 → 包含的组件 → 梁谷，四个字段都是 volatile，保存后热更新）：
  - `peakWindows`：高峰时段，逗号分隔的 `HH:MM-HH:MM`（起点含、终点不含），默认
    `09:00-12:00,14:00-18:00`；
  - `timeZone`：默认 `Asia/Shanghai`；
  - `holidays`：法定节假日日期（`YYYY-MM-DD`，逗号/空白分隔），默认 2026 年表；
    **空串 = 不享受节假日豁免**（只按周末 + 高峰窗口判断）；
  - `defaultEnabled`：新会话默认是否启用，默认关。
  非法值逐字段回退默认并只 warn 一次。
- **持久化**：每个会话的开关状态写 `<DSH_HOME>/dsh-session-enhance/offpeak.json`（原子写、
  容量 500、损坏时备份后从空表继续，写盘失败只让界面提示「重启后可能回落」而不阻止开关）。
  Host 重启后偏好还在；重开会话时按偏好自动 hold。
- **边界（它不管什么）**：它拦的是「Agent 轮次」这条链路（用户提示、继续/目标轮、调度任务、
  子代理、压缩/摘要等经 Agent 的模型请求）。**不经过 Agent 的辅助模型调用**（例如手动点
  「翻译推理」这类直接调 `llm` 的按钮）不在暂停范围内；被中断的那一轮已经执行完的工具调用
  不会回退。没有 `agents` 服务的部署（如 headless）里组件会干净激活但无事可做。
- **可单独启停**：停用 `dsh-session-enhance-offpeak` 行后，浏览器半的能力探测拿到 405，
  开关换成隐藏占位（`data-offpeak-hidden="disabled"`）。停用后该会话立即恢复（不再 hold）。

> **从 5.7.0 升级（破坏性）**：组件名「谷峰会话」→「梁谷」；Config 字段
> `offPeakStart` / `offPeakEnd` 删除，改为 `peakWindows` / `timeZone` / `holidays` /
> `defaultEnabled`；`status` 里的 `window` / `offPeak` 改为 `schedule` / `idle`。
> 升级包后**完全退出应用再重开**（桌面版没有刷新按钮；新代码与新配置字段都要重新加载）。

### 手动压缩：注入官方「上下文已用」面板（4.2 起；4.3 起走官方 `/compact` 命令）

DSH 自带一个官方上下文 meter：composer 下方的小圆环 + 百分比，点开后是 **「上下文已用 N%」**
面板（系统提示词 / 工具定义 / 对话消息三段明细）。本插件**不再另做百分比小部件**，而是把
**「压缩上下文」动作注入这个官方面板的末尾**：

- 面板底部多一行 `压缩上下文        [压缩]`，字号、行高、色板、分隔线都沿用官方
  `ContextMeter` 的 token（`--dsw-alias-label-secondary` / `--dsw-alias-border-l1` /
  `12px/20px`），看起来就是官方面板的一部分；
- **点「压缩」= 执行官方 `/compact` 命令**（4.3 起）：Host 调 `ctx.commands.execute(agent, '/compact', [], signal)`，
  与用户在输入框里打字执行 `/compact` 走**同一条链路**——会写入 `command/run` 与
  `command/done`（带 `sourceEventSeq`），所以聊天记录里会出现官方命令反馈和**压缩摘要卡片**
  （这是 Claude Code 式的手动压缩体验；本插件不再绕过命令直接调服务）。
  只有命令未注册（没启用 `dsh-command-compact`）时才回退到直接调
  `ctx.compaction.compactNow()`；
- 面板那一行先变「压缩中…」，完成后显示「已压缩 N 项，释放约 M tokens」（数字从命令返回文案
  解析；解析不到时显示「压缩完成，详见对话中的压缩摘要」），没有可压缩历史时显示
  「没有可压缩的历史」；失败时按命令返回的文案映射回稳定错误码（`BUSY` / `CANCELLED` /
  `SUMMARY_FAILED` / `COMMIT_FAILED` …）；
- 会话正在跑 / 没有活跃 Agent / 压缩服务未挂载时按钮置灰或给出明确错误码，不会假装成功。

**为什么用 DOM 注入**：这个官方面板由 `dsh-client-ui-conversation` 内置渲染，portal 到
`document.body`，**没有对外 slot**。本插件按**结构特征**识别它，用 `MutationObserver` +
800ms 兜底轮询在面板打开时把动作行挂到末尾；面板关闭/重渲染自动补回，插件卸载时清理
观察器、样式与节点。官方若以后换 DOM 结构，最坏结果是这一行不出现——不会影响官方 meter 本身。

> **判据为什么要严格（5.6.1 修的真实缺陷）**：composer 里不止一个 `role="dialog"` 面板——
> 「本轮用量」「Token 用量」也是 dialog + `<dl>` + 文本里有百分比（缓存命中 99.9%）。
> 早期只查这三条，于是「压缩」行被**同时注入进了那两个用量面板**（用户截图指出那里不该有）。
> 现在的判据同时要求：
>
> 1. **不是**用量面板：`dl` 上带 `data-turn-usage-details`（本轮用量）或
>    `data-session-stats-details`（Token 用量）就排除——这两个 `data` 属性是官方源码里写死的；
> 2. ContextMeter 的 breakdown 结构：`<dl>` 的**直接子元素恰好 3 个 `div` 行**，每行有 `dt`
>    且 `dt` 内有色块 `span`（用量面板是扁平 `dt/dd`，没有行容器与色块）；
> 3. 头部有「~已用 / 窗口」这组数字（如 `~477K / 1M`，与语言无关）。
>
> 任一条不满足就**不注入**——宁可这一行不出现（输入框里还有 `/compact` 命令入口），
> 也绝不出现在错误的窗口里。

**前置条件**：手动/自动压缩依赖官方压缩栈。请在 profile 里启用（`设置 → 插件` 或补丁层）：

- `@deepseek-ai/dsh-compaction-basic`：提供 `ctx.compaction` 服务，并在压力达到阈值时
  **自动压缩**（默认 `thresholdRatio: 0.8`）——这是避免 `CONTEXT_WINDOW_EXCEEDED` 的兜底；
- 可选 `@deepseek-ai/dsh-command-compact`：额外的 `/compact` 打字入口；
- 可选 `@deepseek-ai/dsh-compaction-tool-result-pruner`：压缩时先修剪超大工具输出（L1 的
  批量修剪也复用它，没挂载时 L1 自动跳过、L2 仍可摘要）。

没启用 `compaction-basic` 时，动作行依旧出现但按钮置灰并提示
「压缩不可用：当前部署未启用压缩插件」——不会假装成功。4.5 的自动压缩开关默认关闭；
需要自动分级压缩时到 `设置 → 插件 → 已安装 → 会话增强` 打开。

> 真实事故（2026-11-09，`session-3b342fc5`）：一个 64 轮 / 658 步的会话堆到 128 万 tokens，
> 超过 104 万窗口，提供方直接拒绝；当时 profile 里压缩栈是关闭的，所以只能看到红色失败。
> 启用压缩栈 + 面板里的压缩动作后：阈值内自动摘要，或随时手动压缩，不会再撞窗口。

### 分级上下文压缩（4.5 起：自动 + 手动，批处理单次断点）

4.5 把压缩改造成 **Claude Code 式的分级机制**，并补上自动模式。核心是三级：

| 级 | 名称 | 动作 | 模型调用 | 触发（占**有效窗口**比例） |
|---|---|---|---|---|
| L1 | 微压缩 | **按需**修剪超预算工具结果：从新到旧替换，压力降回阈值以下就停（官方 `toolResultPruner.pruneContent` + 官方替换协议；前提缺失时回退 `pruneSession` 全量修剪） | 否 | ≥ 60%（`pruneRatio`） |
| L2 | 深度压缩 | 官方 `compactIfNeeded('pressure')`：**先修剪全部可剪工具结果，再摘要最旧范围**，同一事务 | 是（1 次摘要） | ≥ 80%（`compactRatio`） |
| L3 | 溢出恢复 | 官方 `compactIfNeeded('context-overflow')`，表层前进后重试该请求 | 是 | 提供方返回 `CONTEXT_WINDOW_EXCEEDED` |

**有效窗口** = 模型窗口 − 输出预留（最近请求头的 `maxTokens`），与 Claude Code 的
"有效上下文窗口"同口径。**触发阈值**与官方 `compaction-basic` 逐字一致：
`min(窗口 × 比例, 窗口 − 输出预留 − headroomTokens 65536)`，不写死 token 数。

**批处理（一次性断点）**：历史替换会让「从第一个被替换 token 起」的前缀缓存失效。所以：

- L2 不自己拆成"先修剪、下轮再摘要"——官方 `compactIfNeeded('pressure')` 在**同一个压缩事务**
  （一次 `compaction/start` … `compaction/end`）里先剪全部、再摘要，只换一次表层；
- L1 **按需修剪**（5.3.0 起）：从新到旧替换超预算工具结果，压力降回阈值以下就停——而不是把
  所有超预算结果一次剪光。剪得越靠前，失效的前缀缓存越多，所以"省够就停"同时降低了不可逆
  损失与缓存代价。前提缺失时自动回退官方全量修剪。
- 自动模式下 L1/L2 都在**同一个 `agent/pre-step`**（下一次请求发出前）完成，下一次请求看到的
  是最终表层，因此只产生一个缓存断点。

**开关**：`设置 → 插件 → 已安装 → 会话增强 → 自动压缩`，**默认关闭**。配置字段
`autoCompact`（volatile，保存后热更新，不需要重启）。

> **5.3.0 起语义变了**：关闭 = **交还官方自动压缩**，而不是「什么都不压」。5.2.0 及以前关闭时
> 守卫会让官方 `compactIfNeeded('pressure')` 返回 `null`，等于把官方 80% 的兜底一起关掉。

三态仲裁（运行期给 compaction 引擎的 `compactIfNeeded` 包一层）：

| 情形 | 行为 |
|---|---|
| 非 `pressure`（溢出恢复 / 手动 / 切模型） | 原样转发 |
| `pressure` + 开关**关** | **转发给官方**（关 = 没装插件） |
| `pressure` + 开关**开** + 官方监听调用 | 返回 `null`（插件独占，避免同一窗口压两次） |
| `pressure` + 开关**开** + 本插件调用 | 放行 |

为什么需要这一层：web 形态下压缩实例在 preset 的隔离组里（`isolate: { compaction, toolResultPruner }`），
profile patch 的 id 定向覆盖打不到它——运行期仲裁是唯一可靠的方式。

**手动压缩也是分级的**：点「压缩」时，**只有压力达到 L1 阈值**才先做批量修剪（不调模型），
紧接着执行官方 `/compact`（L2 摘要）。低于阈值时跳过修剪（结果里 `pruneSkipped: true` +
`pruneReason`）——避免「没有可压缩历史」的会话被白白剪掉工具结果中间段。

**与 DSH 自带压缩的关系**：官方 `dsh-compaction-basic` 默认 `auto: true`，阈值 0.8。开关打开时
本插件接管主动压缩（官方 pre-step 监听让路）；关闭时官方按自己的阈值工作。若想彻底移除官方
自动压缩（包括溢出恢复），请在 profile 补丁里关闭该行（`- id: compaction-basic` +
`config: { auto: false }`），或按官方 web 形态把 host 平面三行保持禁用、由 preset 提供压缩服务。

**阈值公式与官方一致**（5.3.0 起）：`min(窗口 × 比例, 窗口 − 输出预留 − headroomTokens 65536)`。
1M 窗口下两者恰好相等；小窗口下 headroom 会把阈值显著提前（128k 窗口 + 8k 预留 → 54,464 而不是
96,000）。窗口小于压缩余量时返回 `NO_PRESSURE_BUDGET`（官方在同样配置下抛
`TargetPressureConfigError`，不压缩）。

两个比例可配（volatile，改后热更新；设置页只有开关，比例走 profile 补丁）：

```yaml
- id: dsh-session-enhance
  config:
    pruneRatio: 0.7     # L1 阈值（默认 0.6）
    compactRatio: 0.85  # L2 阈值（默认 0.8）
```

`pruneRatio` 会被收敛到不大于 `compactRatio`（否则 L1 永不触发）。

> **为什么不用 `compactRegion` 做"更细的分级"**：官方 `compactRegion` 要求轮次开着、且选区
> 需要工具配对平衡；在 `agent/pre-step` 里自己选范围会与官方事务抢锁并增加断点次数。分级
> 压缩复用官方入口（`compactIfNeeded` + `pruneSession`）才保证一次断点与回放安全。

### 与 Claude Code 五级压缩的对照（4.6 起）

Claude Code 的上下文管理是五级渐进体系（Snip → MicroCompact → Context Collapse →
AutoCompact → Reactive Compact）。本插件按 DSH 的压缩 seam 做了对齐，能做到的做，
做不到的说明原因：

| CC 层级 | CC 的做法 | 本插件 / DSH | 差异与原因 |
|---|---|---|---|
| Snip 历史剪除 | 直接移除远端旧消息，零成本 | **未实现** | DSH 表层只能「替换」不能「删除」；直接写事件（ebbing 方式）会绕过 compaction seam，要自己复刻锁与工具配对，风险大于收益 |
| MicroCompact 微压缩 | 清理旧工具结果（白名单、每轮评估、缓存/时间两条路径） | **L1**：官方 `toolResultPruner` 按需修剪（新到旧、省够就停） | DSH 的 pruner 是官方实现（保留头尾），本插件把它提前到 60% 并按需修剪；CC 的「缓存微压缩/时间微压缩」依赖服务端缓存协议，DSH 没有 |
| Context Collapse 上下文折叠 | 分段折叠、保留细粒度；~90% 开始；启用时跳过 AutoCompact | **未单独实现** | DSH seam 只有「摘要替换」一种写操作；官方 `compactIfNeeded` 本身就是「摘要最旧范围 + 逐字保留近期尾部」，等价于折叠+自动压缩合并 |
| AutoCompact 自动压缩 | 阈值触发；优先复用 Session Memory（0 调用），失败再全量摘要；压缩提示词含 9 要素 + `<analysis>`；压缩后回填最近 5 个文件/技能；连续失败 3 次熔断 | **L2** + **熔断** | 摘要提示词、保留比例与压缩后内容由官方 `compaction-basic` 决定（结构化 8 段检查点），本插件不改；熔断 4.6 补上；DSH 没有 Session Memory 服务，无法做「0 调用复用」 |
| Reactive Compact 响应式压缩 | 413 扣留 → 先 drain 折叠 → 再全量总结 → 仍失败才报错；每轮一次 | **L3** | 官方 compaction-basic 已有 `CONTEXT_WINDOW_EXCEEDED` 恢复；本插件作为兜底，4.6 起与 `autoCompact` 开关解耦（关闭时也生效），每轮最多一次 |
| 多级预警 | 警告 / 自动压缩 / 阻塞三级 buffer | **预警后缀**（4.6） | 动作行在压力 ≥ 有效窗口 90% 时显示「上下文即将用尽」；DSH 没有「阻塞 API 调用」的 seam，因此不阻塞请求 |

几个刻意的差异：

- **阈值按比例而非固定 buffer**：CC 用「窗口 − 输出预留 − 13K」的 token buffer；
  DSH 的窗口随路由模型变化，本插件用官方同款公式
  `min(窗口 × 60%/80%, 窗口 − 输出预留 − 65536)`，阈值随模型自动缩放。
- **微压缩是压力门控的**：CC 每轮评估微压缩（默认构建里常是 no-op）；本插件只在
  压力 ≥ 60% 时按需修剪（新到旧、省够就停），避免无谓的前缀缓存断点。
- **压缩质量**：CC 用 9 要素提示词 + `<analysis>` 先分析再总结；DSH 的官方摘要提示词
  是 8 段结构化检查点（Primary Request / Files / Errors / Pending / Current Work …），
  同样要求保留文件路径、错误与用户原话——这层由官方后端负责，本插件不替换它。



### 恢复子智能体（4.4 起；5.1.0 起只有工具入口）

重启或长任务中断之后，子智能体（`subagent` 工具派生的子会话、Agent Teams 的 teammate）的
会话日志还在，但进程内的 Agent 已经没了。DSH 的规则是：

- 只有**父级**对「直接可继续子级」发送 continuation 消息时才会**冷恢复**它
  （`dsh-subagent` 的 `sendMessage`；0.2.2-rc.2 起 Team 只剩任务板，teammate 就是
  普通 subagent，也走这条通道；rc.1 及更早的 `agentTeams.sendMessage` 仍按存在性兼容）；
- UI 直接打开子会话**不能**把它恢复 —— `dsh-api-session-controller` 会抛
  `ApiSessionSubagentOwnership`（"is a subagent session; use subagent delivery"）。

所以本插件补上这条通道。**5.1.0 起只有工具入口 `session_resume_subagents`**（模型调用）：

> **5.1.0 移除了标题栏「恢复子智能体」按钮**：4.4.0 起的原行为（父会话里有离线子智能体时
> 显示「恢复子智能体（N）」、子会话里父级在线时显示「恢复本子智能体」，点一下发送「继续」
> 并 Toast 报结果）已删除，历史见 CHANGELOG 的 4.4.0 一节。随之删除的还有浏览器半的
> `/dsh-session-enhance-subagent` RPC 通道、界面选择器 `data-session-resume` 与 `resume.*`
> 词典；工具与 Host 侧 handler 保持不变。

**工具 `session_resume_subagents`**

| 参数 | 必填 | 默认 | 含义 |
|---|---|---|---|
| `sessionId` | 否 | 当前会话 | 父会话（root/Lead），或要恢复的子会话 id |
| `targets` | 否 | 全部 | 只恢复这些子会话 id / teammate 名字 |
| `dryRun` | 否 | `false` | 只列出子智能体与状态，不发送恢复消息 |

用法：在父会话里让 Agent 调用工具（省略 `sessionId` 即恢复当前会话的全部离线子智能体；
`dryRun: true` 先看清单）；要恢复某个具体子会话，就把它的 id 传给 `sessionId`。原按钮的
「子会话恢复自己」场景现在也只能由模型调用工具完成，且**父会话必须在线**，否则会提示
`PARENT_NOT_LIVE`（先打开父会话即可）。

**边界**：恢复只发一条「继续」消息，不复制历史、不重建 agent —— preset、工具限制、模型都由
子会话自己的 descriptor 决定（这是官方冷恢复的语义）。一次只可继续的子级才会恢复：外部
（ACP / SDK / Codex / Claude Code）子级与一次性子代理不在可恢复范围内；单个父级下的在线子代理
数量受 `maxActiveSubagents` 限制，超限会返回 `ACTIVATION_LIMIT_REACHED`。

## 设计说明

### 浏览器半的槽位

| 组件 | 槽位 | order |
|---|---|---|
| 梁谷（新建页开关） | `conversation.hero.options`（新建会话行，预设右侧；用注入的 `:has()` 拉回行首方向） | 0 |
| 梁谷（标题栏开关） | `conversation.session.header.utilities`（标题栏右上角） | -12 |
| 分享 | `conversation.session.header.utilities`（标题栏右侧小按钮） | -11 |
| 复制 ID | 同上 | -10 |
| 中断重试 | `conversation.input.right`（composer 右侧，主按钮之前） | 0 |
| 上下文（隐藏会话跟踪） | `conversation.input.left`（不渲染可见 UI，只记"当前会话是谁"） | 0 |
| 设置页（自动压缩开关） | `plugins.bundle.config`（key = 包名，渲染在「设置 → 插件 → 已安装 → 会话增强」详情页） | — |

上下文压缩动作在官方 `ContextMeter` 的 portal 面板里，不走 slot（见上一节「为什么用 DOM 注入」）。

标题栏槽位由 `@deepseek-ai/dsh-client-ui-conversation` 声明，`list` 槽位按 `order` 升序
渲染，所以梁谷 / 分享 / 复制稳定落在「⋯」左边。

槽位注册都包在 `ctx.slots.inject(...)` 里：槽位名属于另一个客户端包，浏览器插件加载顺序
不保证；等槽位声明出来再注册，避免静默不显示。

### 梁谷：为什么用 maintenance hold，而不是拒绝 pre-step

把会话「按住」不让它跑模型，表面上最直接的做法是在 `agent/pre-step` 里返回
`{ kind: 'reject' }`。**这条路本插件没有用**，因为按运行时文档与源码，被 reject 的那一步里
`inbox.claim()` 取走的提示**既不会落 `user/message`、也不会退回 inbox**——用户的消息会凭空
消失（历史里只留下一个 `blocked` 的空轮），要恢复只能靠我们自己另存一份再重放，而且每来
一条消息就多一个空轮。所以采用 `agent.runMaintenance()` 的「维护期挂起」：

1. **hold 层（主）**：对 idle Agent 调 `runMaintenance(async signal => 等释放信号)`。维护期
   `agent.status` 仍是 `idle`（UI 不显示"运行中"），但驱动不会开始新轮；此间 `agent.followup()`
   把消息写进 durable inbox，并给维护相位置 `wakeRequested`。维护期一结束，运行时**自动唤醒**
   排队的输入——这就是"空闲时段自动恢复"。
2. **安全网（次）**：`agent/status: running` 的监听里同步
   `agent.cancel({ kind: 'hook', reason: 'offpeak-pause' }, { keepInbox: true })`。这发生在
   `wakeDriver` 同步派发状态、而 `kick()` 还没 append `turn/start` 的窗口里，所以拐点上的那一轮
   被 abort 在模型调用之前，消息仍留在 inbox（实测：会话日志没有 `turn/start`、没有
   `assistant/*`，只有 inbox splice）。
3. **补齐**：`agent/created` 本身是在创建流程自己的 `runMaintenance` 里派发的，此时再
   `runMaintenance` 会抛 `"already has active work"`；所以创建后只排一次延后 reconcile，由
   `agent/status: idle` 与 1 秒 reconcile 兜底 arm。
4. **续跑**：若高峰时段打断的是**已开始**的轮（`agents.turnBoundaryOf(session).openTurnStartSeq`
   非 null），释放时补一条官方 continuation 形状的空消息（`content: []` +
   `source.kind: 'retry'` + `rpcId`），聊天里渲染成紧凑的「已请求继续生成」；若只是队列里压着
   消息且维护期没置 `wakeRequested`（消息在 arm 前就被 cancel 掉了），同样用这条消息把 inbox
   唤醒。队列消息在维护期写入时 `wakeRequested` 已置位，释放即自动唤醒，不需要额外消息。
5. **时间判定**：`lib/offpeak/window.mjs` 的纯函数——先判周末、再判 `holidays` 日期、最后看
   工作日是否命中 `peakWindows`；边界由「未来日历日的高峰窗口起点/终点」取最近一次切换
   （窗口起点 = `pause`、窗口终点 = `resume`），所以周五 18:00 之后下一次暂停是下周一 09:00、
   连续节假日会自动跳过。
6. **配置热更新**：`peakWindows` / `timeZone` / `holidays` / `defaultEnabled` 是 volatile；
   监听 `app-boot/config-reload` 与 `settings/document-updated`（不存在则静默降级），每次
   reconcile 重读配置并只在边界改变时重建边界定时器。
7. **持久化**：开关状态落在 `offpeak.json`（与 `shares.json` 同目录、同原子写风格）；hold /
   interrupted 是进程内状态，重启后按「高峰时段该暂停」重新推导。

### 会话 id 从哪来

不存在 `window` 全局变量或 URL 路由里。session scope 的槽位贡献者由 renderer 注入
`binding.key`——也就是会话 id：组件 props 上有 `sessionId`，`inject(sessionId)` 也拿得到。
Host 半的 `execute(args, exec)` 则从 `exec.agent.session.id` 取调用方会话 id。

### 子代理怎么识别

`dsh-session` 的会话头里 `origin` 只允许 `'subagent'`（派生会话），`parentSession` 指父会话。
血缘来自 `ctx.sessionQuery.traceSession(id)`：`target` / `ancestors` / `descendants`（嵌套）。
本插件把 `descendants` 递归拍平成"父在前"的列表并带 `depth`，比嵌套 JSON 更省 token 也更好引用。

### 消息为什么只留三种角色

- `system/message`、`developer/message`：Agent 框架指令（实测一条 system 消息 2700+ 字符），
  说明"Agent 被要求怎么工作"，不是"会话在聊什么"；
- `tool/result`：工具输出本身，概览/分享页里复述没有价值；
- 每轮重新注入的 runtime context 与 `<system-reminder>` 虽以 user 角色落盘，
  同样按前缀过滤——实测 4 条消息里 3 条是这类噪音。0.2.2-rc.2 起新写入的
  runtime-context（快照与「清空提醒」）整条包在 `<system-reminder>` 里，前缀匹配与
  `source.kind` 两条路都能滤掉；rc.1 的「清空提醒」是未包装的
  `Current runtime context: none. …`，按冒号前缀兜底。

### 分享为什么是"公开路由 + 随机 token"

`connection` 的路由面向已认证的浏览器会话，而分享链接要能被**任何知道链接的人**打开
（DeepSeek 网页版的会话分享也是这个语义）。所以分享页注册在 `dsh-host-webserver` 的
普通 HTTP 路由上（它不认识 harness 认证），安全边界完全落在 token：24 字节
（192 bit）随机、不可枚举、可撤销、每次请求现读日志（撤销即失效，也不在磁盘上多存一份
会话内容）。

路由级**没有**认证声明可用：rc.5 的 `WebRoute` 只有 `kind` / `path` / `handler`
（`packages/host/webserver/src/index.ts:52`），`webServer.register()` 只做
`table.set(path, route)`（同文件 :445），不会在进入 handler 之前拒掉请求——**路由级
`auth`（`'anonymous'` / `'required'`）、`webserver/authorize` 事件与 `503` 只存在于
master 基线，rc.5 没有**。所以分享页在 rc.5 上天然是公开 HTTP 路由，它的准入边界就是
token 本身（24 字节 / 192 bit 随机、不可枚举、可撤销），不靠 Peer 凭据；旧版本写在本
路由对象上的 `auth: 'anonymous'` 会被 rc.5 的 `register()` 静默忽略，已删除以免误导。

反过来，创建/查询/撤销这些**有副作用**的接口走认证通道：`/dsh-session-enhance`、
`/dsh-session-enhance-retry`、`/dsh-session-enhance-context` 三条路由的 handler 内都调
`connection.admit(req)`——这才是 rc.5 上**唯一**的准入，`PeerAdmission` 只有 `{ peer }`
或 `{ rejection: 401 | 403 }`（没有 503），拒绝时原样写状态码，通过后才执行业务。浏览器半用
`ctx.connection.rpc.call('/dsh-session-enhance', …)` 调用。`test/routes.test.mjs` 把
「注册对象无 auth 字段」与「admit 拒绝不进业务、放行才进业务」两个方向都钉住了，避免以后
被"顺手统一"改坏。

### 存储

`<DSH_HOME>/dsh-session-enhance/shares.json`，只存 `{ sessionId, createdAt, includeDescendants }`。
原子写（临时文件 + rename）。文件损坏时**拒绝写入并报错**而不是覆盖（避免把用户已有的
分享记录清空）；读取时容忍 UTF-8 BOM（Windows 编辑器常见）。2.x 的
`<DSH_HOME>/dsh-session-id/shares.json` 仅作只读回退。

`<DSH_HOME>/dsh-session-enhance/offpeak.json`（5.7 起）：只存每会话的
`{ enabled, updatedAt }`，容量上限 500（按 `updatedAt` 淘汰最旧），原子写。与 `shares.json`
相反，它**损坏时容忍**（备份成 `.corrupt-<时间戳>.bak` 后从空表继续）：这里只是开关偏好，
让用户继续用比锁死更合适；写盘失败只让 RPC 返回 `persisted: false`（界面提示「重启后可能回落」），
不阻止开关在当前进程内生效。

## 验证记录

| 层 | 内容 | 结果 |
|---|---|---|
| 6.4.1 宽度收紧 105px + 倒计时动效 / DSH 0.2.2-rc.5 | 单测 **303/303**（固定尺寸断言改 105px；紧迫级别：60s/59s→`urgent`、10s/9s→`final`、0s/61s/120s→无钩子，chip 与 hero 都覆盖）；真实 UI 沙箱：`梁谷 5m18s` 无钩子、按钮 `105×24`、文本区 `scrollWidth=clientWidth=70` 且「梁谷 60m00s」也不截断；等到 `梁谷 0m37s` 时 `data-offpeak-urgent="urgent"`、`animationName=dsh-offpeak-urgent-throb`、`1s`，宽度仍 `105×24`（`final` 级别由单测覆盖，真实窗口只抓到 urgent）；locale/tool-names 门禁 ✓ | 通过 |
| 6.3.9 梁谷按钮固定尺寸 / DSH 0.2.2-rc.5 | 单测 **302/302**（新增：chip 与 hero 在 off/paused/idle/busy 四态均断言 `112px × 24px`）；真实 UI 沙箱逐态实测：hero off `112×24`、hero idle `112×24`、chip idle `112×24`、hero paused `112×24`（「梁谷 46m43s」）、chip paused `112×24`（「梁谷 46m32s」）——宽高不随状态/文案变化；locale/tool-names 门禁 ✓ | 通过 |
| 6.3.8 梁谷界面统一官方 Pill+Tooltip / DSH 0.2.2-rc.5 | 单测 **301/301**（chip 与 hero 夹具改从 Tooltip 子树取 Pill；两处都断言无原生 `title`、`side='bottom'`、文案/提示逐字匹配）；真实 UI 沙箱：chip 与 hero 均 `height 24px / radius 999px / font-size 12px / hasTitle=false`；hover 分别出现官方深色气泡（chip「梁谷：高峰暂停 / 将在 12:00 自动恢复 / 队列中 1 条消息…」、hero「梁谷：关闭 / 点击开启…」）；截图确认与标题栏官方控件同形制 | 通过 |
| 6.3.7 开态图标 = 弯月 + 小星星 / DSH 0.2.2-rc.5 | 单测 **301/301**（开态 path ≥2 且星星 `fill=currentColor`；关态仍是太阳 `circle`；Tooltip 仍 `side='bottom'`）；真实 UI 沙箱把 SVG 临时放大到 96px 截图：弯月 + 右上四角星与参考图一致，官方 tooltip 气泡正常 | 通过 |
| 6.3.6 悬浮提示改用官方 Tooltip / DSH 0.2.2-rc.5 | 单测 **301/301**（client 23：按钮无 `title`、`Tooltip` 存在且 `side='bottom'`、四态 label 与「自动恢复/暂停 HH:MM」）；真实 UI 沙箱：hover 出现 `role="tooltip"` 深色气泡（关态「梁谷：关闭 / 点击开启…」、开启态「梁谷：高峰暂停 / 将在 12:00 自动恢复」），`button.hasAttribute('title') === false`；截图与官方风格一致；locale/tool-names 门禁 ✓ | 通过 |
| 6.3.3 新建页开关显示重做 / DSH 0.2.2-rc.5 | 单测 **301/301**（client 23：关态文字「梁峰」+ 太阳 `circle`、开态「梁谷 3h05m」+ 月亮 `path`、空闲「梁谷 空闲」、busy「梁谷 …」、点击只 toggle、不弹 Toast）；真实 UI 沙箱：关态「☀ 梁峰」（次要文字色）、点击后「☾ 梁谷 1h12m」（琥珀 pill）、再点可关；`check-plugin-locale.mjs` / `check-tool-names.mjs` ✓ | 通过 |
| 6.3.0 新建页开关语义 / 重启恢复 / 中断重试官方优先 / DSH 0.2.2-rc.5 | 单测 **301/301**（client 23：开关四态、点击只 toggle、不建会话/不导航/不弹 Toast、隐藏占位、图标镜像 `scaleX(-1)`；controller 29：重启延迟复查两例、高峰只 hold、打断场景官方优先/官方忙回退/去重；retry host 14：官方优先/回退/双失败）；真实 UI 沙箱：关=仅图标无文字无 Toast → 点开=`paused` **`9m57s`**（≤1h 分钟秒格式）→ 点关 → 点开；右上角原按钮保留；高峰发消息排队（`paused 暂停 9m45s` 无回复）；关闭服务器→过高峰→重启：延迟 1.2s 复查后注入唤醒，`02:18:27.236Z` 空 retry、`02:18:27.238Z turn/start`、原排队消息被 claim、`02:18:32.9Z` 回复 **RESUME2-OK**；已有历史会话实测官方自己续跑（延迟复查因此不再重复注入）；走 followup 兜底时可能多一条紧凑「已请求继续生成」空 turn（消息不丢，已在文档说明）；`check-plugin-locale.mjs` / `check-tool-names.mjs` ✓ | 通过 |
| 6.2.3 图标镜像 + 成功反馈 / DSH 0.2.2-rc.5 | 单测 **302/302**（新增图标镜像断言：图标容器 `style.transform === 'scaleX(-1)'`；成功提示断言：创建成功后 notice 含「已创建梁谷会话」）；真实 UI 沙箱（真实 Chrome + 真实 `deepseek-flash`）：按钮存在且图标容器带 `scaleX(-1)`（与右上角「打开右侧边栏」按钮一致）、右上角原按钮保留；点击后 **300ms 内**弹出「已创建梁谷会话，正在打开…」且按钮 busy，随后会话行从旧空白会话切到新 `session-49a1801c…`；`workspace.json` 的 default-workspace `sessionIds` 出现该 id；`offpeak.json` 写入 `enabled:true`；在新会话发「按钮最终验证：只回复 FINAL-OK」→ assistant 回复 FINAL-OK、chip「梁谷 空闲」（旧空白会话 0 条消息） | 通过 |
| 6.2.1 修复新建按钮「点了没反应」/ 6.2.0 回归 | 单测 **302/302**（新增 `test/offpeak-create.test.mjs` 7 例：冷会话从 `sessionQuery.traceSession().target.header` 取 cwd、按 `workspace.sessionIds` 成员关系带 `workspaceId`、`resolveByPath` 分支、无工作区回退 cwd、live/header 两条 preset 路径、显式 `attachSession` 兜底、UNAVAILABLE/CREATE_FAILED/无 id 失败且不写开关）；**真实桌面数据取证**：7 个点击创建的会话均已正确挂在 `dsh-plugins` 工作区、全部是空白会话（说明创建/归属成功，缺的是导航）→ 主因是客户端在会话列表刷新前 `openSession` 的竞态；真实 UI 沙箱**复现环境**（同装 `dsh-ungrouped`，页面显示「未分组」）验证修复：点按钮 → 会话行切到新 `session-c888e7a6…`，`workspace.json` 未分组 `sessionIds` 出现该 id，`offpeak.json` 写入 `enabled:true`；在新会话发「按钮验证：只回复 FIX-OK」→ 日志确认用户消息与 assistant 回复都在新会话（旧空白会话 0 条消息），创建/归属/导航三件事成立；`node --check`、locale/tool-names 门禁 ✓ | 通过 |
| 6.2.0 新建梁谷会话按钮 + 倒计时格式 + 子代理范围 / DSH 0.2.2-rc.5 | 单测 **296/296**（倒计时边界：>1h=`3h05m`、59m59s、1h整点=`60m00s`、`0m42s`、非法=`0m00s`；新建按钮渲染/点击流/失败与无连接/隐藏占位；hero slot 注册；Host `coveredOf` 父会话离线但启用 → 子代理仍 hold、离线且无记录 → 不 hold；`createLiangguSession` 端点 6 例）；`node --check`；真实 UI 沙箱（真实 Chrome + 真实 `deepseek-flash`）：新建会话页「标准模式」右侧方形按钮（预设 rect 546–652、按钮 654–682，**间距 2px**，图标与右上角「打开右侧边栏」同款、原按钮保留）；点击 → 新会话 `session-30b463a5…` 创建且 `offpeak.json` 写入 `enabled:true`；首条消息后 chip=`paused`「梁谷 暂停 **1h17m**」（>1h 格式）+ title 含「将在 21:33 自动恢复」「队列中 1 条消息」；会话日志仅 1 条 `agent/inbox/spliced`（20:15:10.097Z），**无 turn/start、无 assistant/message**；≤1h 格式由单测钉住（沙箱未另配 <1h 窗口）；`check-plugin-locale.mjs` / `check-tool-names.mjs` ✓ | 通过 |
| 6.1.0 侧边提问组件 / DSH 0.2.2-rc.5 | 单测 **286/286**（新增 `test/sideask.test.mjs`：提示词（参考会话 id / 工具清单 / 只读约束 / 引用块 / 中英文案）、RPC 信封与参数校验、控制器「沿用工作区与 Agent 预设建新会话 + 立即切只读 + fail-closed（只读切不上归档新会话）」、保留时恢复**权限预设**（不是 Agent 预设）与 catalog 兜底、forget；`test/sideask-client.test.mjs`：bundle 形状、页面型标签 + guide 卡片、标签正文私有 session 子槽、标题栏入口、合并弹层（`quote` key priority -1 shadow + 兜底 key）、405 时撤销全部注册、记录表与引用格式化；`test/entries.test.mjs` 增加第五个入口）；`node --check` 全部改动文件；`check-plugin-locale.mjs` / `check-tool-names.mjs` ✓；devkit web/UI 沙箱（真实 Chrome + 真实 deepseek-flash）：标题栏「侧边提问」按钮 → 新建**只读**会话（权限控件「仅可查看」），输入框预填提示词（含参考会话 id 与 `session_overview / session_grep / session_read / session_lookup`，以「我的问题：」收尾）；在侧边会话提问「幸运数字是多少」→ 模型实调 `session_grep` / `session_overview`（参数为参考会话 id）并答出父会话里的「7391」；点「保留」→ 权限变「工作区内修改」、标签「已保留 · 普通会话」；点「改回临时」→ 回到「仅可查看」；选中文字 → 弹层并排「引用文本」「侧边提问」（同一行 x=403/480）；旧版崩溃点（`React is not defined`）已修（client 半补 `require('react')`）；控制台 0 错误 | 通过 |
| 6.0.0 梁谷 / 官方空闲时段 / DSH 0.2.2-rc.5 | 单测 **268/268**（`offpeak-window` 15 例：工作日 09:00–12:00/14:00–18:00 峰时与边界、午休/夜间空闲、周末全天空闲、2026 法定节假日工作日空闲（01-01 周四、02-23 周一）、节后恢复、周五 18:00 后下一 pause=下周一 09:00、连续节假日跳过、跨时区 DST、非法配置回退；controller/rpc/entries/client 同步新契约）；**独立离线复核 64/64 PASS**（固定时间戳 `isPeakAt` 表、`DEFAULT_HOLIDAYS` 与国务院 2026 通知逐段核对 33 天、`nextBoundary` 跨周末/当日边界）；`node --check`；headless 沙箱 compose **4 行**、任务 exit 0/stderr 空；**真实 UI 沙箱（lead，真实 Chrome + 真实 deepseek-flash）**：`peakWindows 09:00-18:22` 下 18:19 开启 → `paused`「梁谷 暂停 2m51s」+ title「将在 18:22 自动恢复」「队列中 1 条消息」；18:19:04 发消息后日志 **2m56s 只有一条 inbox splice、零 turn/start、零 assistant/message**，18:22:00.012（边界后 12ms）才 `turn/start`、18:22:05 回复 `LIANGGU-QUEUED-OK`，chip 变 `idle`「梁谷 空闲」、下一次 pause 显示次日 09:00；独立 verifier 验插件页「共 4 个 · 4 运行中」第 4 行中文「梁谷」；`check-plugin-locale.mjs` / `check-tool-names.mjs` ✓ | 通过 |
| 5.7.0「谷峰会话」（后被 6.0.0 修正，仅历史） | 单测 **262/262**（新增 `offpeak-window/-store/-controller/-rpc` 与 `offpeak-client` 用例：窗口边界/跨午夜/非法配置、原子写/容量/损坏容忍、创建窗口 arm、首个 prompt 在 arm 前被 cancel、running→cancel keepInbox、队列消息不被误 cancel、释放续跑、子代理覆盖正/负、禁用/dispose、RPC 入参校验、浏览器半注册/词典/状态机/轮询清理）；`node --check` 全部改动文件；devkit headless 沙箱 compose 输出 **4 行**（含 `dsh-session-enhance-offpeak`）、任务 exit 0/stderr 空；**lead 真实 UI 沙箱（真实 Chrome + 真实 `deepseek-flash`）**：15:41 点开关进 `paused`+倒计时并发消息 → 15:41:45.47 inbox splice 之后到 15:53:00.02 之间日志 **0 条 `turn/start` / 0 条 `assistant/message`**，15:53:00.02（窗口起点后 20ms）自动 `turn/start`、15:53:06 回复 `VALLEY-QUEUED-OK`、chip 变 `active`、队列清空；暂停中刷新后 chip 仍 paused、队列条仍在；关开关后发消息立即开始并在 25 秒内完成；**独立 verifier（另一沙箱/会话）**：A–F 全绿，另验「回合运行中切暂停」= `turn/end aborted/hook/offpeak-pause`（该轮无 assistant）→ 边界后 2ms 自动 `turn/start` → 17 秒完成并显示「已请求继续生成」，以及插件页「包含的组件 **共 4 个 · 4 运行中**」第 4 行为中文「谷峰会话」、停用该行后 chip 隐藏且 `POST /dsh-session-enhance-offpeak/status` = **405**、重新启用后 chip 恢复；`offpeak.json` 落盘内容核对；`check-plugin-locale.mjs` / `check-tool-names.mjs` 均 ✓。**注意：该版本的窗口语义（00:30–08:30）是错的，6.0.0 已按官方口径重做并更名「梁谷」** | 通过（机制）；口径已作废 |
| 5.4.0 会话 id 三种写法 / DSH 0.2.2-rc.2 运行时 | 单测 **162/162**（新增 11 例：`sessionUuidOf` 三种写法 + 大小写 + 无 UUID、裸 UUID 归一化、导出文件名（整条路径）、id 粘正文、子代理裸 UUID、精确命中不多列语料库、无 UUID 不回查、同 UUID 不唯一、回查失败带原因、取消原样抛出、分享记录落在真实 id）；`node --check` 改动文件；devkit headless 沙箱（真实 Loader + 真实 `sessionQuery.listSessions()` + 从本机拷入的真实会话日志 `session-31874d86…` / `session-559eb381…`）：裸 UUID → 归一化 + 摘要提示、完整 id → 无提示且其余一致、`C:\…\dsh-session-session-<uuid>.zip` → 归一化、裸 UUID + `includeMessages=true` → 真读到 seq 1327/1329/1341、事故会话裸 UUID → 成功、全零 UUID → 「找不到会话」+ 三种写法提示，全部输出通过运行时 schema 校验（无 `tool returned invalid output`） | 通过 |
| 5.3.2 适配 DSH 0.2.2-rc.3 / DSH 0.2.2-rc.3（checkout `39163dd30f`） | 单测 **150/150**（新增 `test/routes.test.mjs` 3 例：分享页路由 `auth === 'anonymous'`、分享 handler 自身仍只认 token（404/405/200）、三条 RPC 通道保持默认 `required`）；`node --check` 改动文件；核对结果：`webServer.register` 新增 `auth`（默认 `required`，`packages/host/webserver/src/index.ts:123-124,780-788`）→ 分享页显式匿名；`connection.admit` 与 `PeerAdmission` 形状未变（`packages/client/connection/src/rpc.ts:121-123,225`）；`ctx.on` 的 `prepend` 仍在（`vendor/cordis/src/events.ts:111-118`）；`settings.configure` / `tools.register` / `sessionQuery.*` / `subagents.listDescendants` / `agents.turnBoundaryOf` / `compaction.compactNow|compactIfNeeded` / `toolResultPruner.pruneSession` / `tokenMeter.contextPressure` / `session.append` 等均未变；client 半 6 个 ui-primitives 导出与 4 个槽位名、`configForms.get|whileServed`、`SettingsFormModel.bind` 全部仍在；rc.2 向后兼容已核对安装版 `app.asar` 的 `dsh-host-webserver/src/index.ts:445-452`（`register()` 不读 `auth`） | 离线通过；真实 Loader 待 Lead 在目标版本运行时验证 |
| 5.2.0 新增「中断重试」组件 / DSH 0.2.2-rc.2 | 单测 **130/130**（新增 `test/retry/*` 21 例 + entries 三入口 1 例）；`node --check client.js`；devkit headless 沙箱真实 Loader：合成树 3 行（`dsh-session-enhance` / `-share` / `-retry`），任务正常完成（logger 不落 stderr，行激活证据由 UI 沙箱提供）；devkit web/UI 沙箱：`dsh-session-enhance@5.2.0 is loaded`、控制台 0 错误、`[data-interrupted-retry]` 隐藏占位存在（槽位注册成功）、详情页「包含的组件 共 3 个 · 3 运行中」（会话增强 / 会话分享 / 中断重试）、当前版本 5.2.0；页面内 `POST /dsh-session-enhance-retry/pending` 返回 200 业务信封 `{pending:false,recoverable:null}` | 通过 |
| 5.1.0 移除「恢复子智能体」按钮 / DSH 0.2.2-rc.2 | 单测 **108/108**（`SUBAGENT_RPC_CHANNEL` 常量用例改写为「恢复文案稳定」，计数不变）；`node --check client.js`；devkit headless 沙箱真实 Loader：合成树仍 2 行、`session_resume_subagents`（dryRun）实调返回「子智能体共 0 个，可恢复 0 个」；devkit web/UI 沙箱：`dsh-session-enhance@5.1.0 is loaded`、控制台 0 错误、页面无 `[data-session-resume]`、详情页「包含的组件 共 2 个 · 2 运行中」、当前版本 5.1.0（web 沙箱无可用模型、未能创建会话，标题栏按钮未实操；静态确认分享/复制槽位注册仍在） | 通过 |
| 5.0.0 移除失败重试组件 / DSH 0.2.2-rc.2 | 单测 **108/108**（原 167；`test/retry/*` 58 条 + `test/entries` 1 条，共 59 个用例随组件删除）；`node --check client.js`；devkit headless 沙箱真实 Loader：合成树只有 2 行 Loader 行（`dsh-session-enhance` / `dsh-session-enhance-share`）、`session_lookup` 实调返回当前会话摘要；devkit web/UI 沙箱：`dsh-session-enhance@5.0.0 is loaded`、控制台 0 错误、页面无 `[data-turn-retry]` 且 `dataset.dshTurnRetry` 为 undefined、详情页「包含的组件 共 2 个 · 2 运行中」（会话增强 / 会话分享）、当前版本 5.0.0 | 通过 |
| 离线单测 | `node --test`：严格 JSON-Schema 子集、required 覆盖、返回值自校验、消息过滤、血缘拍平、分享存储（幂等/撤销/持久化/损坏文件/BOM/旧目录只读回退）、HTML 转义、分享视图、`session_share` 全流程、分级压缩、子智能体恢复、中断记录与 RPC 端点、三入口形状 | **130/130 通过** |
| headless 沙箱 | 真实 Loader：`session_lookup`（无参数 / 不存在 id）；真实 `subagent` 派生后反查 `role=subagent`、`parentSessionId`；`session_share` 在无 web server 的部署里返回结构化失败 | 通过 |
| 5.3.0 仲裁器三态 / 按需修剪 / 分享页角色 / DSH 0.2.2-rc.2 | 单测 **142/142**（新增：仲裁器三态、`pruneIfNeeded` 跳过与执行、按需修剪「新到旧 + 省够即停」、官方公式对齐 1M 与 128k 两组、`NO_PRESSURE_BUDGET`、`prune≥compact` 收敛、检查点 → summary 角色与去标签、`lastDecision` / `AUTO_OFF`、Config 三个 volatile 字段）；`node --check` 六个改动文件全过；devkit headless 真实 Loader 两组**强制低阈值**回归：**开**（`pruneRatio 0.0001`）→ 会话日志出现 2 条 `compaction/prune` + 2 条 `surface.replace`，工具结果里出现官方 `[... tool result middle pruned ...]` 标记、0 条 `compaction/summary`；**关**（`autoCompact:false` + 官方 `thresholdRatio 0.0001`）→ 出现 `compaction/start` + `compaction/end`，证明守卫已转发给官方（旧版本这里会返回 `null`、什么都不会发生）；devkit web/UI 沙箱：`dsh-session-enhance@5.3.0` client 半进页面清单、0 console 错误、详情页 v5.3.0、自绘设置卡「自动压缩」正常渲染 | 通过 |
| web 沙箱（真实 HTTP） | RPC `share.create` → 公开页 200（约 4.5 KB，含消息与只读徽标）→ `?download=1` 返回 `attachment` → 未知 token 404 → `POST` 405 → 撤销后再访问 404；CSP 头存在 | 通过 |
| UI 沙箱 | 真实浏览器：标题栏分享/复制按钮可见；分享对话框创建/复制/停止全流程；composer 区域正常、无重试覆盖层 | 通过 |
| 2.0.0 拆分回归 | 单测 101/101；headless 真实 Loader 两工具均可用；UI 沙箱「设置 → 插件 → 会话增强」显示**包含的组件 共 3 个 · 3 运行中**，三行标题/描述分别来自包根、`share/locale/`、`retry/locale/` | 通过 |
| 2.1.0 / DSH 0.2.2-rc.1 | 单测 **106/106**；devkit web 沙箱（真实 Chrome + 真实 sub2api/deepseek-flash）：三个 client 半进页面清单、控制台 0 错误；复制会话 ID toast；分享链接 200 且渲染标题+消息；「停止 → 重试」turn 正常完成；`time-context` 注入不再出现在消息里 | 通过 |
| 4.6.1 适配 DSH 0.2.2-rc.2 / DSH 0.2.2-rc.2 | 单测 **167/167**（新增 rc.2 服务形状：`subagents.listDescendants` 直接子节点过滤、`listDirectChildren` 优先新 API 回退旧 API、rc.2 下 teammate 归入 subagent、child 模式名字取自 catalog、diag 两种形状；`agents.roots()` 移除后按 `subagents.rootOf` / 会话头判根并否决子代理；runtime-context 新增 rc.2 三种文本 `<system-reminder>` 包装快照/后续快照/清空提醒的过滤用例）；`node --check`；devkit headless 沙箱真实 Loader：三行合成正确，`session_resume_subagents`（dryRun）真实列出 `subagent` 派生后离线的子代理（`one-plus-one`，kind=subagent、离线、可恢复），`session_lookup` 显示 subagentCount=1 | 通过 |
| 4.6.0 熔断/预警/响应式压缩解耦 / DSH 0.2.2-rc.1 | 单测 **156/156**（新增熔断 3 次→暂停→下一轮重置、成功清零、`autoCompact` 关闭时溢出恢复仍介入、`statusFor`/`effectiveWindowFor`、`get` 新字段）；`node --check` 通过；devkit web/UI 沙箱：client 半加载 0 console 错误、动作行状态后缀与设置页不受影响 | 通过 |
| 4.5.0 分级压缩 + 自动开关 / DSH 0.2.2-rc.1 | 单测 **153/153**（新增 `test/compact.test.mjs` 15 条：阈值边界、有效窗口、volatile 配置读取、L1/L2/L3、异常吞掉、守卫安装/恢复、溢出重试上限、pruneAll/describe/diag；entries 新增 Config 与 `configure({auto:false})` 断言；context 覆盖新的 `get`/`compact`/`diag` 字段）；`node --check index.js client.js`；devkit headless 沙箱真实 Loader：三行合成正确、`session_lookup` 实调通过；devkit web/UI 沙箱：`dsh-session-enhance@4.5.0` client 半进页面清单、0 console 错误、设置 → 插件 → 已安装 → 会话增强详情页出现「自动压缩」开关（默认关）+ 提示 + 保存；点开关 → 保存后沙箱 profile patch 写入 `- id: dsh-session-enhance` + `config: {autoCompact: true}`，刷新页面后开关仍为开并显示「已覆盖」 | 通过 |
| 4.4.0 恢复子智能体 / DSH 0.2.2-rc.1 | 单测 **135/135**（新增 subagent 8 条：父/子 list、父级离线、team+subagent 混合恢复、targets 过滤、PARENT_NOT_LIVE、ALREADY_LIVE、diag）；`node --check` 通过；devkit headless 沙箱真实 Loader 调 `session_resume_subagents`（dryRun）验证工具注册与严格 schema；浏览器按钮随会话状态显示（父会话有离线子代理/子会话父级在线） | 通过 |
| 4.3.0 手动压缩走官方 /compact 命令 / DSH 0.2.2-rc.1 | 单测 **127/127**（命令成功解析、NO_RANGE、失败文案→错误码、命令缺失回退、diag.hasCommand）；`node --check` 通过；devkit web/UI 沙箱：动作行注入成功、点击走 `commands.execute('/compact')`（真实 Loader 返回 SUMMARY_FAILED，属沙箱无模型 key 的预期结果） | 通过 |
| 4.2.0 压缩动作注入官方 ContextMeter 面板 / DSH 0.2.2-rc.1 | 单测 **123/123**；`node --check client.js`；devkit web/UI 沙箱：client 半加载 0 console 错误，模拟官方同形状面板（role=dialog + dl + 62%）时动作行被追加到面板末尾（文案「压缩上下文 / 压缩」、title 正确），点击后 Host 真实执行 compactNow 并回显「没有可压缩的历史」（沙箱无模型 key，预期结果）；修复注入器 MutationObserver 死循环 | 通过 |
| 4.1.0 上下文用量 + 手动压缩 / DSH 0.2.2-rc.1 | 单测 **123/123**（新增 context 12 条 + retry 溢出用例）；devkit web/UI 沙箱：client 半 dsh-session-enhance@4.1.0 is loaded、0 console 错误、dataset.dshTurnRetry=4.1.0、[data-session-context] 小部件注册、启用官方压缩栈后 /dsh-session-enhance-context/diag 真机返回 {hasCompaction:true,hasTokenMeter:true}，点「压缩」真实调用 compactNow 并显示 压缩失败（SUMMARY_FAILED）（沙箱无模型 key，属预期错误路径）；活 profile 启用 compaction-basic/command-compact/tool-result-pruner | 通过 |
| 4.0.0 定名 dsh-session-enhance / DSH 0.2.2-rc.1 | 单测 **110/110**；devkit headless 沙箱：三行 Loader 行名/patch id 正确、session_lookup 实调通过；web/UI 沙箱：dsh-session-enhance@4.0.0 is loaded、控制台 0 错误、dataset.dshTurnRetry=4.0.0、设置→插件卡片「会话增强 v4.0.0」+ 组件「会话增强 / 会话分享 / 失败重试」共 3 个运行中；活 profile：三行 active，POST /dsh-session-enhance 与 /dsh-turn-retry 均 401（已注册），旧 /dsh-session-inspect、/dsh-session-id 均 405 | 通过 |
| 3.1.0 失败后仍可重试 / DSH 0.2.2-rc.1 | 单测 **109/109**；devkit web 沙箱 `retry-repro`：真实模型失败 → 闸门 waiting → 60 秒超时 turn 以 error 结束 → 按钮变「上一轮失败 —— 点击重试」（`recoverable:true`）→ 切走再回来仍在 → 点击 `retry.ok via:followup`、新 turn 启动 | 通过 |
| 3.0.0 改名 / DSH 0.2.2-rc.1 | 单测 **107/107**；devkit headless 沙箱：三行 Loader 行名/patch id 正确，session_lookup 无参与会话不存在两种调用均通过；web/UI 沙箱：client 半进页面清单（dsh-session-inspect@3.0.0 is loaded）、控制台 0 错误、document.documentElement.dataset.dshTurnRetry=3.0.0、设置→插件显示「会话检视 / 会话分享 / 失败重试」共 3 个且运行中；活 profile 升级：POST /dsh-session-inspect 返回 401（路由已注册、认证拒绝）、session_lookup 实调通过；重试行按用户原设置保持停用（/dsh-turn-retry 405） | 通过 |

> 0.2.0 回归里抓到并修掉两个真 bug：`share.create` 拿不到地址时先落盘留下孤儿记录；
> `shares.json` 带 UTF-8 BOM 时被当成损坏文件导致分享功能锁死。
>
> 2.1.0（DSH 0.2.2-rc.1 回归）修掉三处，注意分层：**只有 `time-context` 注入过滤是跟新版组合的适配**
> （该行 0.2.1-alpha.1 起随附组合新增）；另两处是**0.2.1 时代就已存在、本次真实回归才暴露的潜伏缺陷**
> ——`agent.followup()` 的 user 消息漏 `role`（重试必失败 **且**该会话之后读不出来）、
> `SessionTitleObservation.title` 被当成字符串（标题从来没渲染过）。详见 CHANGELOG 的 2.1.0 一节。

## 修复被写坏的会话日志

脚本认两类病因，可以单独或同时出现，修复前都会先备份、默认 dry-run：

**病因 A（5.3.0 及更早的按需修剪）**：在 **turn 之外** append surface 替换事件，DSH 的重放校验因此把整份日志判 corrupt —— 症状是**会话历史读不出来**（`session_lookup` 只显示「没有可读的语义消息」）且**会话无法冷恢复**。5.3.1 起不再写坏，存量用脚本修。

**病因 B（`dsh-commander-mode` ≤ 7.25.0 的退化看门狗，2026-11-20 发现）**：`agent.cancel({kind:'degeneration'})` 传了**封闭 union 之外的 cause**，`agent-loop` 的 `abortedCancelCause()` 走 `assertNever()` 抛错，`finally` 仍 append 出 `turn/end {reason: null}`。这条事件**过得了 `fromRestore`**（重放校验不看 reason），所以 `readSession` 正常，只有**投影层**崩：`continuation.ts:46` 读 `reason.kind` → TypeError → GUI 报「历史加载失败：failed to project session … Cannot read properties of null (reading 'kind')（gateway/internal）」。全库 798 份日志扫出 17 个这样的会话。

```powershell
# 默认 dry-run：报告会改什么 + 跑完五道校验，不写任何文件
node scripts/repair-session-log.mjs "C:\Users\<你>\.dsh\sessions\<工作区>\<会话id>\session.v4.jsonl.zstd"

# 确认无误后写回（先自动备份为 <file>.bak-<时间戳>）
node scripts/repair-session-log.mjs "<同上>" --apply

# 已知确切原因时可以把真实原因写进去（默认是 {"kind":"aborted","reason":{"kind":"legacy"}}）
node scripts/repair-session-log.mjs "<同上>" --apply --cause '{"kind":"aborted","reason":{"kind":"hook","reason":"degeneration"}}'
```

修法 A：整对删除「`compaction/prune` + 它紧跟的 replacement」，保留被修剪的原始 `tool/result` 原样（内容不丢、surface 不残缺），重编号 seq 并重映射**全部** seq 引用（`sourceEventSeqs` / `surfaceOp` / `shadowedSeqs` / `shadowedRange` / `messageSeqs` / `developer/message.headerSeq`），引用到已删事件的从列表剔除并去重。

修法 B：把 `reason` 换成合法值。默认 `{"kind":"aborted","reason":{"kind":"legacy"}}` —— `legacy` 是 DSH 给「原始记录没带 cause 的导入」准备的成员，语义就是「被取消、原因未记录」；客户端 `turn-error.ts` 对 `aborted` + 非 `hook` 只显示「已停止」，不会伪造「进程已退出」那种假告警。

五道门禁（任一不过就中止、不碰原文件）：

1. turn/step 规则 0 违规
2. seq 唯一 + 连续 + 引用无悬空
3. **`turn/end.reason` 结构不变量**：每个 reason 都是对象、`kind` 属于 `TurnEndReasonMap` 已知成员；`aborted` 的 `cause.kind` 属于 `user|parent|hook|disposed|legacy`（`fromRestore` 不看这个字段，挡病因 B 的就是这一道）
4. **DSH 自己的 `Session.fromRestore`**（从 `app.asar` 抽出真实校验器跑）
5. 打包回读逐字节一致

**并发写保护**：读入后如果文件的 `size/mtime` 变了（会话还活着、正在 append），脚本拒绝写回——否则会把并发追加的事件覆盖掉。等会话空闲或重启 DSH 后再跑。

**已知边界**：带「整段压缩摘要」（`surfaceOp: replace` 覆盖很大范围、`sourceEventSeqs` 很长）的会话可能在门禁 4 失败，报 `surface replace: sourceEventSeqs must include every shadowed surface node` —— 删掉 prune 后原节点回到 surface，而摘要的替换范围覆盖它却没引用它。这种要单独处理（把该节点补进摘要的 `sourceEventSeqs`），脚本会拒绝写坏、原文件不动。

## 开发笔记

```
index.js            组件①「会话增强」Host 半：注册 session_lookup（同时是包根导出）
share/index.js      组件②「会话分享」Host 半：session_share + /share 路由 + 分享 RPC
retry/index.js      组件③入口：name/inject/apply，apply 时装配 lib/retry（中断监听 + RPC 通道）
offpeak/index.js    组件④入口：装配 lib/offpeak（hold 控制器 + RPC 通道）；Config 四 volatile 字段
locale/             包根词典：卡片标题与组件①的标题/描述（两者共用这一份）
share/locale/       组件②的标题/描述（子路径 specifier 不读包根 package.json）
retry/locale/       组件③的标题/描述
offpeak/locale/     组件④的标题/描述
lib/build.mjs       四个组件共用的构建戳
scripts/repair-session-log.mjs  存量损坏日志的修复工具（两类病因、五道门禁、默认 dry-run）
lib/service.mjs     会话视图折叠（血缘 / 标题 / 消息 / 失败同一形状），可离线单测
lib/tools.mjs       聚合门面（buildTools 兼容 1.x）+ re-export 两个构建器
lib/tools/lookup.mjs  session_lookup 的参数与输出 schema（手写严格子集）
lib/tools/share.mjs   session_share 的参数与输出 schema
lib/tools/schema.mjs  两个工具共用的 schema 构造器
lib/context/host.mjs  上下文 RPC：用量、手动（分级）压缩、自动压缩开关状态
lib/compact/tiers.mjs 分级决策纯函数（有效窗口、两级阈值、比例格式化）
lib/compact/host.mjs  分级自动压缩驱动：pre-step 的 L1/L2、request-error 的 L3、运行期自动压缩守卫
lib/compact/options.mjs 插件配置读取（兼容 volatile 的 `.get()` 引用与普通值）
lib/shareview.mjs   分享页的数据装载（复用 service 的消息折叠）
lib/render.mjs      自包含只读 HTML（转义、CSP、深浅色、打印友好）
lib/shares.mjs      shares.json 存储（原子写、容忍 BOM、损坏不覆盖、2.x 旧目录只读回退）
lib/rpc.mjs         分享的认证 RPC 通道（/dsh-session-enhance）
lib/public.mjs      免登录的 /share/<token> 只读路由
lib/retry/host.mjs  组件③ Host 侧：session/event 监听（turn/end 中断判定）、followup 驱动、装配 RPC 通道
lib/retry/recovery.mjs 中断后「可重试」记录（RecoveryStore，TTL 30 分钟，仅内存）
lib/retry/rpc.mjs   组件③的 RPC 通道（/dsh-session-enhance-retry，pending / retry / diag）
lib/offpeak/window.mjs  高峰时段纯函数：工作日 09:00–12:00/14:00–18:00、周末/2026 法定节假日空闲、下一次边界、配置归一化
lib/offpeak/store.mjs   组件④的开关存储（offpeak.json，原子写、容量淘汰、损坏容忍）
lib/offpeak/controller.mjs 组件④核心：coveredOf 覆盖判定、hold/cancel/reconcile、边界定时器、续跑
lib/offpeak/rpc.mjs     组件④的 RPC 通道（/dsh-session-enhance-offpeak，status / setEnabled / diag）
client.js           浏览器半：四块界面 + 对话框 + toast + i18n + 设置页卡片
cordis.patch.yml    根作用域 insert 四行（不按 preset 挂载）
test/               分享/会话视图/四入口测试；test/retry/ 是组件③的测试；offpeak-*.test.mjs 是组件④
```

- **严格 schema 是最大的坑**：第三方插件不能 `import defineTool`，参数与返回值都要手写
  注册表接受的子集。`output.schema` 会校验 `execute` 的返回值——少一个字段、多一个
  字段、出现 `null` 都会在运行时变成 `tool returned invalid output`。`test/strict-schema.mjs`
  就是为了在离线阶段抓这类问题（比真实调用失败便宜得多）。
- **浏览器半只能 require 两个说明符**：`react/jsx-runtime` 与
  `@deepseek-ai/dsh-client-ui-primitives`；没有 `useState` 时通过槽位 `hooks` 注入自己的
  快照源（`{ getSnapshot, subscribe }`），renderer 会把它绑成组件 props 上的 `useXxx`。
- **改完必须回归**：`node --test` 看不见"插件没加载 / 槽位没声明 / 返回值过不了校验 / 路由
  被回退吃掉"，得在真实 Loader 与真实浏览器里各跑一遍。
- **浏览器半只能挂在「精确包名」那一行**：`dsh-client-modules` 的 `locatePkgJson()` 对
  `pkg/sub` 这种子路径 specifier 直接返回 `undefined`（`exactPackageSpecifier` 不认），
  于是该行没有 client 半。第一行因此必须写精确包名（2.x 是 `dsh-session-id`，3.x 是
  `dsh-session-inspect`，4.0 起是 `dsh-session-enhance`）——这也是它的组件标题只能等于卡片标题的原因。改 patch 时别把
  第一行换成子路径，否则界面按钮会整体消失。
- **组件行文案走的是另一套逻辑**：`dsh-app-boot` 的 `readPluginMeta()` 对子路径 specifier
  **不读** `specifier/package.json`，标题/描述只来自 `<specifier>/locale/en.json` 的
  `meta`，并且 `exports` 必须暴露 `<子路径>/locale/*.json`（否则静默回退到裸 specifier）。
- **`node_modules` 形态会决定 client 半是否出现**：以 `link:` 指向**源码目录**安装时，
  client 半可能进不了页面清单；要验证 UI 就用 `pnpm pack` 打成 tarball 再装（真实目录）。
- **子智能体列举 API 在 0.2.2-rc.2 变了**：`subagents.listChildren()` 被移除，只剩
  `listDescendants(rootSessionId)`（递归返回全部后代，每行带 `depth` 与
  `kind: 'child' | 'diagnostic'`）。「恢复子智能体」的列举因此改走新 API 并过滤
  `kind === 'child' && depth === 1`，同时保留旧 API 回退——**这类"有 typeof 守卫"的
  软依赖最容易静默失效**：守卫不抛错，只是整条列举路径永远返回空，按钮就再也不出现。
  升级大版本时必须对着随附包源码核对每个软取服务的**方法名**，不能只看服务名还在不在。

## License

MIT，见 [LICENSE](LICENSE)。
