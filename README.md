# 会话增强 · dsh-session-enhance

**一个插件包，三个可单独启停的组件**：会话检视（按 ID 查会话与子代理 + 标题栏复制 ID）、会话分享、失败重试；第一个组件还带**分级上下文压缩**（自动/手动，设置页可开关）。

> 开源（MIT）。仓库地址：<https://github.com/lldwb/dsh-session-enhance>
>
> **4.0.0 起包名/仓库名由 `dsh-session-inspect` 改为 `dsh-session-enhance`，显示名回到「会话增强」**。
> 这个包是「一包三组件」的会话能力合集（检视 / 分享 / 重试），显示名「会话增强」才是对整体
> 用途的描述；`dsh-session-id`（2.x）只覆盖三组件之一，`dsh-session-inspect`（3.x）又只描述
> 检视这一面。改名历史与迁移步骤见下方 [4.0 改名](#40-改名)。
>
> **2.0.0 起拆成三个 Loader 行**：「设置 → 插件 → 会话增强 → 包含的组件」里会看到 3 个
> 组件，每个都有独立开关。1.x 只有一行（三件事捆在一起，只能整体开关）。
>
> **原「失败重试」插件（`dsh-turn-retry`）已于 1.0.0 并入本插件**：它的目录、profile 行与
> GitHub 仓库都已删除。升级时请先卸载旧的 `dsh-turn-retry`，否则会出现两个重试按钮。

## 三个组件

| 组件（界面显示名） | Loader 行 | 提供什么 |
|---|---|---|
| 会话增强 | `dsh-session-enhance` | 会话标题栏复制按钮 + 工具 `session_lookup`（按 id 查会话与全部子代理）+ 官方「上下文已用」面板里的**分级压缩**动作（4.5 起自动/手动）+ **恢复子智能体**按钮/工具 |
| 会话分享 | `dsh-session-enhance/share` | 标题栏分享按钮 + 工具 `session_share` + 免登录只读页 `/share/<token>` |
| 失败重试 | `dsh-session-enhance/retry` | composer 的「重试」覆盖层 + `agent/request-error` 闸门 |

> **为什么第一个组件叫「会话增强」而不是「会话 ID / 会话检视」**：浏览器半（三块界面）只能挂在
> **精确包名**那一行上——`@deepseek-ai/dsh-client-modules` 的 `locatePkgJson()` 只接受
> 精确包名，子路径 specifier 直接返回 `undefined`，那一行就不会有 client 半。所以第一行
> 必须是 `dsh-session-enhance`，它的组件标题只能等于包根 `locale/`（也就是卡片标题「会话增强」）。
> 另外两行是子路径，各自有 `share/locale/`、`retry/locale/`，所以能叫「会话分享」「失败重试」。

三部分互相独立：只装 Host 半也能查会话，只装浏览器半也能复制 id / 分享 / 重试。

## 4.0 改名

| 项 | 2.x | 3.x | 4.0.0 |
|---|---|---|---|
| 包名 / 仓库 | `dsh-session-id` | `dsh-session-inspect` | `dsh-session-enhance` |
| 显示名 | 会话增强 | 会话检视 | **会话增强（英文 Session Enhance）** |
| Loader 行 id | `dsh-session-id` / `-share` / `-retry` | `dsh-session-inspect` / `-share` / `-retry` | `dsh-session-enhance` / `-share` / `-retry` |
| 分享 RPC 通道 | `/dsh-session-id` | `/dsh-session-inspect` | `/dsh-session-enhance` |
| 分享记录目录 | `<DSH_HOME>/dsh-session-id/` | `<DSH_HOME>/dsh-session-inspect/` | `<DSH_HOME>/dsh-session-enhance/`（旧目录只读回退） |

**升级必须做的**（破坏性，major）：

1. 从 profile 的 `dsh.profile.bundles` 与 `dependencies` 里删掉旧包 `dsh-session-inspect`
   （或更旧的 `dsh-session-id`），删掉 `profiles/<profile>/plugins/<旧包名>/`；
2. 用新包重新 `dsh plugin add dsh-session-enhance`（或本地目录 link），执行 `pnpm install`；
3. **如果你曾停用「失败重试」组件**：profile 补丁层里的 `- id: <旧包名>-retry` 必须改成
   `- id: dsh-session-enhance-retry`，否则新包插入的 retry 行不会被这条 override 命中，
   重试组件会**静默重新启用**；
4. 重启 DSH（client 清单是服务器启动时的快照，刷新页面不够）。

**刻意保留的兼容标识**（改名不改它们，避免无谓回归与历史断层）：

- 重试动作通道仍是 `/dsh-turn-retry`（并入自 `dsh-turn-retry` 时就是旧名）；
- `RETRY_SOURCE_KIND = 'dsh-session-id'` 与 followup 消息 id 前缀 `dsh-session-id-retry-`；
- 界面选择器 `data-session-share` / `data-turn-retry` / `data-dsh-turn-retry-button` 等；
- `exports` 子路径（`./share`、`./retry`、`./client`、`./locale/*.json`）结构不变。

分享记录不会丢：新路径没有文件时会按 3.x → 2.x 顺序只读加载历史 `shares.json`；一旦有新写入
就落到新路径，旧文件原样保留（回滚到旧版本也能继续读）。

## 停用某个组件之后

浏览器半只有一份（`dsh.client` 是包级声明，不能按行拆），它会跟着第一行一起加载。为了
不让被停用的组件留下"点了没反应"的按钮，浏览器半启动时会各发一次**能力探测**请求：

- Host 的 RPC 前缀路由只在对应行启用时才注册；
- 组件在 → `POST /dsh-session-enhance`（或 `/dsh-turn-retry`）返回 **200**（缺参数的业务信封也是 200）；
- 组件停用 → 请求落到 SPA fallback，返回 **405**。

探测不阻塞 UI 注册、最多退避重试 3 次；判定不了的（网络异常、非 200/405）一律乐观保留，
不会因为一次抖动把按钮永久藏掉。于是：

- 停用**会话分享** → 标题栏分享按钮换成隐藏占位（`data-session-share="disabled"`）；
- 停用**失败重试** → 覆盖层换成隐藏占位（`data-turn-retry="disabled"`），按钮不渲染；
- 停用**会话增强**（第一行）→ 三块界面随 client 半一起消失，`session_lookup` 也不可用；
- 重新启用后刷新页面，按钮自动回来（探测只做一次，不写任何持久缓存）。

## 安装

```powershell
git clone https://github.com/lldwb/dsh-session-enhance.git
cd dsh-session-enhance
# 装进当前 profile（例如 desktop）
dsh plugin add .
```

也可以直接把本地目录交给 `dsh plugin add <插件目录>`。

零 npm 依赖、零配置、无设置页。装好后刷新页面即可看到按钮；新会话里即可调用工具。

## 用法

### 会话 ID

会话标题栏右侧、在「⋯」之前多一个复制图标按钮：

- 点击 → 剪贴板里就是当前会话 id，顶部弹 toast「会话 ID 已复制」；
- 鼠标悬停 → `title` 显示完整 id，用来确认"复制的是哪一个"；
- `navigator.clipboard` 被拒（非安全上下文 / 权限关闭）时自动降级到
  `document.execCommand('copy')`；两条都失败才提示失败，不会静默无反应。

拿到 id 后可以直接贴进任何会话问 Agent，例如"用 session_lookup 看看 `<id>`，它有哪些子代理？"

### `session_lookup`

| 参数 | 必填 | 默认 | 含义 |
|---|---|---|---|
| `sessionId` | 否 | 当前会话 | 目标会话 id。省略时查调用它的会话本身 |
| `includeMessages` | 否 | `true` | 是否附带最近消息 |
| `messageLimit` | 否 | `10`（上限 200） | 返回多少条最近消息 |

返回内容（结构 + 一段人可读的 markdown 摘要）：

```
session            目标会话：id / 标题 / workspace / 预设 / 角色 / 父会话 / delegationDepth / live / persisted / 是否当前会话
ancestors          已知父级链（由近到远）；血缘不完整时 complete=false 并给出 unresolvedParentId
subagents          全部后代会话，父在前：id / 标题 / depth / parentId / 创建时间 / 状态
messages           最近 N 条人对人消息（user / assistant / 压缩摘要）
inheritedEventCount 种子会话从父会话继承的事件数
```

只读：不创建、不修改、不删除任何会话。

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

### 失败重试

没有额外的提示条、弹窗或新按钮。**官方那个发送/停止按钮的位置**（composer 卡片右下角）
在下列时刻变成一个圆形「重试」图标（循环箭头）：

| 触发 | 图标提示 | 点击后 |
|---|---|---|
| 模型调用失败（自动重试耗尽） | 「模型调用失败 —— 点击重试」 | `agent-loop` 在**同一 turn / step 重新调用模型**，不产生任何用户消息 |
| 你点了停止 | 「已停止 —— 点击重试」 | Host 用 `agent.followup()` 驱动一次新的 turn（见下方「已知取舍」） |

- 覆盖层是 34×34 正圆、品牌主色，尺寸与位置对齐官方按钮；card 被多行输入/附件撑高时按实际高度重新贴合。
- 点击后图标旋转、按钮置灰；重试会再跑一整轮，期间按钮消失。
- 没有可重试状态时覆盖层不可见，官方按钮原样可用。
- **失败后不会"错过窗口"（3.1.0 起）**：模型失败、turn 以错误结束后，Host 会保留一条
  **30 分钟**的可重试记录。即使你当时切到了别的会话、或者没在 60 秒内点，回到这个会话
  （甚至刷新页面）仍会看到「上一轮失败 —— 点击重试」。点它用 `agent.followup()` 驱动
  新一轮，代价同停止后重试（历史里多一条中性消息）。
- **等待上限 60 秒**（3.1.0 起，原 120 秒）：失败挂起后没人点就自动放行，按原有语义让这一轮以错误结束；此后仍有 30 分钟的「上一轮失败」入口，所以缩短等待不会再丢重试机会。
- **孤儿保护**：开闸后 5 秒内若没有任何浏览器半来查 `pending`（典型：插件刚装、页面还没刷新），
  立刻按原生语义结束，不会白等两分钟。
- 状态**按会话各一份**，两个会话互不影响；只在「看起来可能可重试」时才向 Host 查一次，其余时候零请求。
- 等待期间每 8 秒向 Host 复查一次「闸门还在吗」；Host 已经没有闸门时按钮会立即收起，避免「按钮还在但点了没用」。

> **为什么模型不可用时会"看不到按钮"**（3.0.x 的实际体感，也是 3.1.0 要修的问题）：
> 闸门只在 turn 结束**之前**存在——失败可见时最多等 60 秒，失败发生在你没打开的那个会话时
> 5 秒就被孤儿保护放行；而旧逻辑在 turn 以 error 结束后没有任何可重试入口，所以"回来才看到
> 红色错误、按钮已经没了"。3.1.0 改为在 `turn/end { reason: { kind: 'error' } }` 时也保留
> recovery（30 分钟），回到会话即可重试。

#### 点了重试却没反应？看按钮上的错误码

以前点击失败会把按钮静默藏起来；现在失败会变成**红色的「重试未生效 (错误码)」**，
3 秒后自动消失。错误码直接告诉你卡在哪：

| 错误码 | 含义 | 怎么办 |
|---|---|---|
| `NOT_WAITING` | Host 侧已经没有等待中的闸门（60 秒等待上限已过、Host 重启过） | 1.0.1 起会自动兜底驱动一次新一轮；若仍失败，直接发一句「继续」即可 |
| `NO_LIVE_AGENT` | 这个会话没有活跃 Agent（例如刚重启后打开的历史会话） | 在该会话里随便发一条消息唤醒 Agent，再点重试 |
| `FOLLOWUP_FAILED` | 驱动新一轮时 Agent 内部报错 | 看 DSH 日志里 `followup` 相关错误 |
| `NO_CONNECTION` / `TRANSPORT` | 浏览器半与 Host 的 RPC 通道断了 | 刷新页面；若持续出现，检查 DSH 进程是否还活着 |

**已知取舍**：模型失败后的重试是**原地重发**，历史不变；但用户点「停止」之后这一轮已经
结束，物理上无法原地重试，只能由 Host 用 `agent.followup()` 排一条中性消息
（「上一轮被用户中断。请从中断处继续完成…」）驱动新的一轮 —— 这条消息会进入会话历史，
是 DSH 当前架构下无法回避的代价。

**上下文溢出不给重试**（4.1 起）：`CONTEXT_WINDOW_EXCEEDED` 是确定性失败，重发只会再次
超长；这类收尾不会出现重试按钮，也不会写可重试记录。请用 composer 左侧的「上下文 / 压缩」
（见下一节），或开启官方 `dsh-compaction-basic` 让系统在达到阈值时自动压缩。

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
`document.body`，**没有对外 slot**。本插件按稳定特征识别它（`role="dialog"` + 内含 `<dl>` +
文本含百分比），用 `MutationObserver` + 800ms 兜底轮询在面板打开时把动作行挂到末尾；
面板关闭/重渲染自动补回，插件卸载时清理观察器、样式与节点。官方若以后换 DOM 结构，
最坏结果是这一行不出现——不会影响官方 meter 本身。

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
| L1 | 微压缩 | 一趟扫描把**所有**超预算工具结果批量修剪（官方 `toolResultPruner.pruneSession`） | 否 | ≥ 60%（`pruneRatio`） |
| L2 | 深度压缩 | 官方 `compactIfNeeded('pressure')`：**先修剪全部可剪工具结果，再摘要最旧范围**，同一事务 | 是（1 次摘要） | ≥ 80%（`compactRatio`） |
| L3 | 溢出恢复 | 官方 `compactIfNeeded('context-overflow')`，表层前进后重试该请求 | 是 | 提供方返回 `CONTEXT_WINDOW_EXCEEDED` |

**有效窗口** = 模型窗口 − 输出预留（最近请求头的 `maxTokens`），与 Claude Code 的
"有效上下文窗口"同口径；阈值只按比例判定，不写死 token 数。

**批处理（一次性断点）**：历史替换会让「从第一个被替换 token 起」的前缀缓存失效。所以：

- L2 不自己拆成"先修剪、下轮再摘要"——官方 `compactIfNeeded('pressure')` 在**同一个压缩事务**
  （一次 `compaction/start` … `compaction/end`）里先剪全部、再摘要，只换一次表层；
- L1 只在一次 `pruneSession` 里处理**所有**超预算工具结果，不做碎片化逐条清理；
- 自动模式下 L1/L2 都在**同一个 `agent/pre-step`**（下一次请求发出前）完成，下一次请求看到的
  是最终表层，因此只产生一个缓存断点。

**开关**：`设置 → 插件 → 已安装 → 会话增强 → 自动压缩`，**默认关闭**。配置字段
`autoCompact`（volatile，保存后热更新，不需要重启）。关闭时：

- 本插件不做 L1/L2 主动自动压缩；
- 手动「压缩」按钮仍然可用；
- **L3 溢出恢复与切模型压缩作为安全网保留**（它们不是"主动压缩"，关掉只会让你在溢出时
  直接看到红色报错）；
- 运行期会给官方 compaction 引擎的 `compactIfNeeded('pressure')` 装一个守卫，因此**官方自带的
  主动自动压缩也会真正停手**（web 形态下压缩实例在 preset 的隔离组里，profile patch 打不到它，
  这是唯一可靠的开关方式）。

**手动压缩也是分级的**：点「压缩」时先做 L1 批量修剪（不调模型），紧接着执行官方 `/compact`
（L2 摘要）——两者在同一个空闲窗口内完成，下一次请求看到最终表层。结果提示会同时报
「已清理 N 个工具输出；压缩 M 项，释放约 T tokens」。

**与 DSH 自带压缩的关系**：官方 `dsh-compaction-basic` 默认 `auto: true`，会在自己的阈值
（默认 0.8）自动压缩；本插件不改它的配置，只通过运行期守卫让 `autoCompact` 成为主动自动压缩
的唯一开关。若想彻底移除官方自动压缩（包括溢出恢复），请在 profile 补丁里关闭该行
（`- id: compaction-basic` + `config: { auto: false }`），或按官方 web 形态把 host 平面三行保持
禁用、由 preset 提供压缩服务。

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
| MicroCompact 微压缩 | 清理旧工具结果（白名单、每轮评估、缓存/时间两条路径） | **L1**：官方 `toolResultPruner` 批量修剪 | DSH 的 pruner 是官方实现（保留头尾），本插件把它提前到有效窗口 60% 并保证一次批量；CC 的「缓存微压缩/时间微压缩」依赖服务端缓存协议，DSH 没有 |
| Context Collapse 上下文折叠 | 分段折叠、保留细粒度；~90% 开始；启用时跳过 AutoCompact | **未单独实现** | DSH seam 只有「摘要替换」一种写操作；官方 `compactIfNeeded` 本身就是「摘要最旧范围 + 逐字保留近期尾部」，等价于折叠+自动压缩合并 |
| AutoCompact 自动压缩 | 阈值触发；优先复用 Session Memory（0 调用），失败再全量摘要；压缩提示词含 9 要素 + `<analysis>`；压缩后回填最近 5 个文件/技能；连续失败 3 次熔断 | **L2** + **熔断** | 摘要提示词、保留比例与压缩后内容由官方 `compaction-basic` 决定（结构化 8 段检查点），本插件不改；熔断 4.6 补上；DSH 没有 Session Memory 服务，无法做「0 调用复用」 |
| Reactive Compact 响应式压缩 | 413 扣留 → 先 drain 折叠 → 再全量总结 → 仍失败才报错；每轮一次 | **L3** | 官方 compaction-basic 已有 `CONTEXT_WINDOW_EXCEEDED` 恢复；本插件作为兜底，4.6 起与 `autoCompact` 开关解耦（关闭时也生效），每轮最多一次 |
| 多级预警 | 警告 / 自动压缩 / 阻塞三级 buffer | **预警后缀**（4.6） | 动作行在压力 ≥ 有效窗口 90% 时显示「上下文即将用尽」；DSH 没有「阻塞 API 调用」的 seam，因此不阻塞请求 |

几个刻意的差异：

- **阈值按比例而非固定 buffer**：CC 用「窗口 − 输出预留 − 13K」的 token buffer；
  DSH 的窗口随路由模型变化，本插件用「有效窗口（窗口 − 输出预留）× 60% / 80%」，
  阈值随模型自动缩放。
- **微压缩是压力门控的**：CC 每轮评估微压缩（默认构建里常是 no-op）；本插件只在
  压力 ≥ 60% 时批量修剪，避免无谓的前缀缓存断点。
- **压缩质量**：CC 用 9 要素提示词 + `<analysis>` 先分析再总结；DSH 的官方摘要提示词
  是 8 段结构化检查点（Primary Request / Files / Errors / Pending / Current Work …），
  同样要求保留文件路径、错误与用户原话——这层由官方后端负责，本插件不替换它。



### 恢复子智能体（4.4 起）

重启或长任务中断之后，子智能体（`subagent` 工具派生的子会话、Agent Teams 的 teammate）的
会话日志还在，但进程内的 Agent 已经没了。DSH 的规则是：

- 只有**父级**对「直接可继续子级」发送 continuation 消息时才会**冷恢复**它
  （`dsh-subagent` / `dsh-experimental-agent-team` 的 `sendMessage`）；
- UI 直接打开子会话**不能**把它恢复 —— `dsh-api-session-controller` 会抛
  `ApiSessionSubagentOwnership`（"is a subagent session; use subagent delivery"）。

所以本插件补上这条通道，提供两个入口：

**1. 标题栏按钮**（`conversation.session.header.utilities`，分享按钮左侧）

- 父会话里有离线子智能体时显示「恢复子智能体（N）」：点一下，对每个离线目标发送一条中性的
  「继续」消息，由官方机制冷恢复（team 目标按名字发给 Lead，subagent 目标按会话 id 发给父级）；
- 子会话里父级在线时显示「恢复本子智能体」：点一下，由父会话冷恢复本会话；
- 恢复中按钮禁用；完成后 Toast 报「已恢复 N 个 / 失败 N 个（错误码）」；
- 没有可恢复目标时按钮不渲染。

**2. 工具 `session_resume_subagents`**（模型可用）

| 参数 | 必填 | 默认 | 含义 |
|---|---|---|---|
| `sessionId` | 否 | 当前会话 | 父会话（root/Lead），或要恢复的子会话 id |
| `targets` | 否 | 全部 | 只恢复这些子会话 id / teammate 名字 |
| `dryRun` | 否 | `false` | 只列出子智能体与状态，不发送恢复消息 |

于是"主会话恢复后恢复子会话"和"在子会话里恢复自己"都可以：前者在主会话里点按钮或让 Agent
调用工具；后者打开子会话后点标题栏按钮（父会话必须在线，否则会提示
`PARENT_NOT_LIVE`，先打开父会话即可）。

**边界**：恢复只发一条「继续」消息，不复制历史、不重建 agent —— preset、工具限制、模型都由
子会话自己的 descriptor 决定（这是官方冷恢复的语义）。一次只可继续的子级才会恢复：外部
（ACP / SDK / Codex / Claude Code）子级与一次性子代理不在可恢复范围内；单个父级下的在线子代理
数量受 `maxActiveSubagents` 限制，超限会返回 `ACTIVATION_LIMIT_REACHED`。

## 设计说明

### 浏览器半的槽位

| 组件 | 槽位 | order |
|---|---|---|
| 分享 | `conversation.session.header.utilities`（标题栏右侧小按钮） | -11 |
| 复制 ID | 同上 | -10 |
| 重试 | `conversation.input.overlay`（composer card 内的绝对定位锚点） | 0 |
| 上下文（隐藏会话跟踪） | `conversation.input.left`（不渲染可见 UI，只记"当前会话是谁"） | 0 |
| 设置页（自动压缩开关） | `plugins.bundle.config`（key = 包名，渲染在「设置 → 插件 → 已安装 → 会话增强」详情页） | — |

上下文压缩动作在官方 `ContextMeter` 的 portal 面板里，不走 slot（见上一节「为什么用 DOM 注入」）。

标题栏槽位由 `@deepseek-ai/dsh-client-ui-conversation` 声明，`list` 槽位按 `order` 升序
渲染，所以分享/复制稳定落在「⋯」左边。重试按钮放 overlay 槽位是为了**盖住**官方 submit
按钮（`conversation.input.right` 只能"旁边多一个"）。

两处注册都包在 `ctx.slots.inject(...)` 里：槽位名属于另一个客户端包，浏览器插件加载顺序
不保证；等槽位声明出来再注册，避免静默不显示。

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
- 每轮重新注入的 `Current runtime context.`、`<system-reminder>` 虽以 user 角色落盘，
  同样按前缀过滤——实测 4 条消息里 3 条是这类噪音。

### 分享为什么是"公开路由 + 随机 token"

`connection` 的路由面向已认证的浏览器会话，而分享链接要能被**任何知道链接的人**打开
（DeepSeek 网页版的会话分享也是这个语义）。所以分享页注册在 `dsh-host-webserver` 的
普通 HTTP 路由上（它不认识 harness 认证），安全边界完全落在 token：24 字节
（192 bit）随机、不可枚举、可撤销、每次请求现读日志（撤销即失效，也不在磁盘上多存一份
会话内容）。

创建/查询/撤销这些**有副作用**的接口则走认证通道：`connection.admit(req)` 校验后才会
执行，浏览器半用 `ctx.connection.rpc.call('/dsh-session-enhance', …)` 调用。

### 重试怎么做到"不追加消息"

`@deepseek-ai/dsh-agent-loop` 在最终失败后会走一个 waterfall：

```js
const action = await this.dispatch.waterfall('agent/request-error', payload, () => Promise.resolve(void 0));
if (action?.kind !== 'retry') throw new LlmError(...);
continue;   // ← 回到同一 turn/step 的模型请求
```

监听器返回 `{ kind: 'retry' }`，loop 就在原地重新 dispatch 模型调用。因为用户点击是异步的，
监听器返回一个**尚未 resolve 的 Promise**把这次失败挂住，点击经 RPC 送回后再放行。

两条关键语义（实测踩过）：

1. **先 `await next()` 问下游**：`agent/request-error` 是每次 attempt 失败都触发的 waterfall，
   DSH 自带自动重试挂在它下游。下游说 `{ kind: 'retry' }` 就放行（自动重试期间不打扰用户）；
   只有下游放弃时这次才是"最终失败"，才挂起等用户。
2. **放弃时不能调用 `next()`**：那等于把决定交回自动重试策略，它会继续重试；直接返回
   `undefined` 才是"让这一轮失败"。

另外只拦"有人能看见"的失败：非 root Agent（子代理）不拦、没有活跃浏览器客户端不拦
（`typertGateway.hasLiveClient()`，探测服务缺失时 fail-closed 不挂起）、`signal` 已 abort 不拦。
闸门有 60 秒上限、孤儿保护 5 秒、插件卸载时全部放行，不会把 Agent 永久卡住。

重试半的浏览器动作通道保留旧通道名 `/dsh-turn-retry`（合并前是独立插件，改名只增加回归
风险），Host 侧同样用 `webServer` prefix 路由 + `connection.admit` 认证。

### 存储

`<DSH_HOME>/dsh-session-enhance/shares.json`，只存 `{ sessionId, createdAt, includeDescendants }`。
原子写（临时文件 + rename）。文件损坏时**拒绝写入并报错**而不是覆盖（避免把用户已有的
分享记录清空）；读取时容忍 UTF-8 BOM（Windows 编辑器常见）。2.x 的
`<DSH_HOME>/dsh-session-id/shares.json` 仅作只读回退。

## 验证记录

| 层 | 内容 | 结果 |
|---|---|---|
| 离线单测 | `node --test`：严格 JSON-Schema 子集、required 覆盖、返回值自校验、消息过滤、血缘拍平、分享存储（幂等/撤销/持久化/损坏文件/BOM/旧目录只读回退）、HTML 转义、分享视图、`session_share` 全流程；**并入的重试半 48 个用例**（闸门状态机含孤儿保护、恢复记录 TTL、RPC 信封与两条重试路径、mock-ctx 集成） | **95/95 通过** |
| headless 沙箱 | 真实 Loader：`session_lookup`（无参数 / 不存在 id）；真实 `subagent` 派生后反查 `role=subagent`、`parentSessionId`；`session_share` 在无 web server 的部署里返回结构化失败；重试闸门在无活跃客户端时 fail-closed（不挂起） | 通过 |
| web 沙箱（真实 HTTP） | RPC `share.create` → 公开页 200（约 4.5 KB，含消息与只读徽标）→ `?download=1` 返回 `attachment` → 未知 token 404 → `POST` 405 → 撤销后再访问 404；CSP 头存在 | 通过 |
| UI 沙箱 | 真实浏览器：标题栏分享/复制按钮可见；分享对话框创建/复制/停止全流程；重试覆盖层在无失败态时是隐藏占位（注册成功）、composer 区域正常 | 通过 |
| 2.0.0 拆分回归 | 单测 101/101；headless 真实 Loader 两工具均可用；UI 沙箱「设置 → 插件 → 会话增强」显示**包含的组件 共 3 个 · 3 运行中**，三行标题/描述分别来自包根、`share/locale/`、`retry/locale/` | 通过 |
| 2.1.0 / DSH 0.2.2-rc.1 | 单测 **106/106**；devkit web 沙箱（真实 Chrome + 真实 sub2api/deepseek-flash）：三个 client 半进页面清单、控制台 0 错误；复制会话 ID toast；分享链接 200 且渲染标题+消息；「停止 → 重试」turn 正常完成；`time-context` 注入不再出现在消息里 | 通过 |
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

## 开发笔记

```
index.js            组件①「会话增强」Host 半：注册 session_lookup（同时是包根导出）
share/index.js      组件②「会话分享」Host 半：session_share + /share 路由 + 分享 RPC
retry/index.js      组件③「失败重试」Host 半：agent/request-error 闸门 + 重试 RPC
locale/             包根词典：卡片标题与组件①的标题/描述（两者共用这一份）
share/locale/       组件②的标题/描述（子路径 specifier 不读包根 package.json）
retry/locale/       组件③的标题/描述
lib/build.mjs       三个组件共用的构建戳
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
lib/retry/host.mjs  重试半 Host 侧：agent/request-error 闸门、停止记录、RPC 接线
lib/retry/gate.mjs  重试等待闸门（按会话去重、等待上限、孤儿保护；纯 JS）
lib/retry/recovery.mjs  「停止后可重试」记录（TTL）
lib/retry/rpc.mjs   重试的认证 RPC 通道（/dsh-turn-retry，兼容旧名）
lib/retry/diagnostics.mjs 重试诊断记录（diag 端点）
client.js           浏览器半：三块界面 + 对话框 + toast + i18n（重试半用 IIFE 隔离作用域）+ 设置页卡片
cordis.patch.yml    根作用域 insert 三行（不按 preset 挂载）
test/               分享/会话视图/三入口测试；test/retry/ 是并入的重试半测试
```

- **严格 schema 是最大的坑**：第三方插件不能 `import defineTool`，参数与返回值都要手写
  注册表接受的子集。`output.schema` 会校验 `execute` 的返回值——少一个字段、多一个
  字段、出现 `null` 都会在运行时变成 `tool returned invalid output`。`test/strict-schema.mjs`
  就是为了在离线阶段抓这类问题（比真实调用失败便宜得多）。
- **浏览器半只能 require 两个说明符**：`react/jsx-runtime` 与
  `@deepseek-ai/dsh-client-ui-primitives`；没有 `useState` 时通过槽位 `hooks` 注入自己的
  快照源（`{ getSnapshot, subscribe }`），renderer 会把它绑成组件 props 上的 `useXxx`。
- **两个 bundle 合并时用 IIFE 隔离**：重试半与分享/复制半的顶层标识符大量重名
  （`NS` / `en` / `zh` / `SLOT_NAME` / `BUTTON_STYLE` …），把重试半整体包进
  `const retryHalf = (() => { … })();` 比逐个改名安全得多，也保留了它原有的注释与结构。
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

## License

MIT，见 [LICENSE](LICENSE)。
