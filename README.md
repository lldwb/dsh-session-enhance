# 会话增强 · dsh-session-enhance

**一个插件包，五个可单独启停的组件**，补齐 DSH 里「会话」这一层的能力：按 ID 查看任意会话与它的整棵子代理树、对长会话做概览 / 检索 / 定点精读、把会话分享成免登录只读链接、用户主动停止的一轮可以重试、在右侧栏开一个临时只读的「侧边提问」会话、以及按 DeepSeek 官方空闲 / 高峰时段自动暂停与恢复的「谷峰插件」。第一个组件还带**分级上下文压缩**（自动 / 手动，设置页可开关）。

给谁用：在 DSH（DeepSeek Harness）里跑长任务、需要复盘历史会话、需要把会话发给别人看、或想让会话只在空闲时段跑的人。

- 仓库：<https://github.com/lldwb/dsh-session-enhance>（公开，MIT）
- 要求：Node ≥ 20；在 DSH 0.2.2 系列（0.2.2-rc.5）上验证
- 变更历史见 [CHANGELOG.md](CHANGELOG.md)

## 加载方式

加载方式：常驻（理由：UI 类 + 诊断类——5 个界面组件常驻，5 个 `session_*` 诊断工具要求任意模式随时可用；约 6.5k 字符 schema 是"常驻里最贵但确实要随时可用"的一类）

界面 / 设置页本身不占模型 schema；五个查询工具是「用户从界面复制一个会话 id 就要能立刻查」的诊断能力，藏到技能门控后面反而会被漏用，所以常驻。

## 五个组件

| 组件（界面显示名） | Loader 行 id | Loader name | 提供什么 |
|---|---|---|---|
| 会话增强 | `dsh-session-enhance` | `dsh-session-enhance` | 标题栏「复制会话 ID」按钮；五个查询工具（`session_overview` / `session_grep` / `session_read` / `session_lookup` / `session_resume_subagents`）；官方「上下文已用」面板里的分级压缩动作 + 分级自动压缩；**浏览器半（全部界面）都挂在这一行** |
| 会话分享 | `dsh-session-enhance-share` | `dsh-session-enhance/share` | 标题栏分享按钮 + 工具 `session_share` + 免登录只读页 `/share/<token>` + RPC `/dsh-session-enhance` |
| 中断重试 | `dsh-session-enhance-retry` | `dsh-session-enhance/retry` | 用户主动停止后 composer 右侧的「重试」按钮 + RPC `/dsh-session-enhance-retry`（pending / retry / diag） |
| 侧边提问 | `dsh-session-enhance-sideask` | `dsh-session-enhance/sideask` | 右侧栏标签（页面型 + guide 卡片）、标题栏入口、选中文字后的「引用文本 / 侧边提问」合并弹层 + RPC `/dsh-session-enhance-sideask`（probe / create / setPreset / restore / forget） |
| 谷峰插件 | `dsh-session-enhance-offpeak` | `dsh-session-enhance/offpeak` | 标题栏右上角的相位开关 + 新建会话页的开关 + Host 的 Agent hold 控制器 + RPC `/dsh-session-enhance-offpeak`（status / setEnabled / diag） |

五个组件互相独立：只装 Host 半也能查会话；只装浏览器半也能复制 ID / 分享 / 中断重试 / 侧边提问 / 切谷峰开关。

**为什么第一行必须是精确包名**：浏览器半由 `@deepseek-ai/dsh-client-modules` 按 Loader 行收集，`locatePkgJson()` 只接受精确包名——`pkg/sub` 这种子路径 specifier 直接返回 `undefined`，那一行就不会有 client 半。所以携带 `client.js` 的那一行只能写 `dsh-session-enhance`；这也是唯一一行组件标题等于包根 `locale/`（即卡片标题「会话增强」）的原因。另外四行是子路径，各自有 `share/locale/`、`retry/locale/`、`sideask/locale/`、`offpeak/locale/`，所以能叫「会话分享」「中断重试」「侧边提问」「谷峰插件」。

## 安装

```powershell
git clone https://github.com/lldwb/dsh-session-enhance.git
cd dsh-session-enhance
dsh plugin add .
```

也可以直接把本地目录交给 `dsh plugin add <插件目录>`。运行时只依赖 `@deepseek-ai/schemastery`（声明配置 schema，随 DSH 提供），默认零配置即可用。

装完 / 换版本后**重启 DSH**（Loader 树在进程启动时按 profile 与各 bundle 的 patch 合成，新增 Loader 行与 Host 半改动都只在重启后生效）。之后「设置 → 插件 → 会话增强 → 包含的组件」里能看到 5 个组件，每个都有独立开关。

## 生效方式（改了代码或字典之后）

- **Host 半**（`index.js` / `lib/**` / Loader 行结构）：重启 DSH（桌面版完全退出后重开；`dsh web` 场景重启服务）。
- **浏览器半**（`client.js`）：桌面版界面上没有「刷新」按钮，但窗口有焦点时按 **F12** 打开 DevTools，在 Console 执行 `location.reload()`（或焦点留在 DevTools 里按 Ctrl+R）即可从磁盘重拉 `client.js`，不重启宿主、不中断会话与子代理。`dsh web` 场景直接刷新页面。
- 只改词典 / 纯数据：重载或重开应用后生效。

## 会话 ID 的三种写法

同一个会话有三种合法写法，五个查询工具与 `session_share` 都认：

| 写法 | 从哪来 | 例子 |
|---|---|---|
| `session-<uuid>` | 根会话的真实 id；「复制会话 ID」按钮复制的就是它 | `session-<uuid>` |
| `<uuid>` | **子代理会话**的真实 id（没有前缀）；也是 `~/.dsh/sessions/…/subagents/<uuid>/` 的目录名 | `<uuid>` |
| `dsh-session-session-<uuid>.zip` | 会话导出文件名（用 `@` 引用 zip 时就是它）；整条路径、带不带 `.zip` 都行 | `C:\Users\me\Downloads\dsh-session-session-<uuid>.zip` |

归一化的锚点是 **UUID**：精确 id 没命中时，插件会用 `sessionQuery.listSessions()` 按 UUID 回查语料库，命中后把真实 id 用起来，并在摘要里明说「你给的 X 与真实 id Y 是同一个会话」——不会悄悄改写。命中多个时报「不唯一」而不是随便挑；回查本身失败（例如存储不可用）会把原始错误带出来，不伪装成「会话不存在」。后续读取与分享记录都落在归一化后的真实 id 上。

## 工具

五个组件一共注册 6 个工具。`session_lookup` 属于「会话增强」组件；`session_share` 属于「会话分享」组件；其余四个都在「会话增强」组件里。

### 先概括、再检索、后精读：`session_overview` / `session_grep` / `session_read`

`session_lookup` 是「把整棵树一次读出来」的重工具。会话很长时（几千个事件、几百次工具调用）它只给最后几条、每条截断，不合适。三个补位工具构成一条「先概括、再定位、后精读」的路径：

| 工具 | 一次调用读什么 | 回答什么 |
|---|---|---|
| `session_overview` | 目标会话**一次**整份日志 | 这是什么会话、多大（事件数 / 工具调用 / 回合 / 时间跨度）、任务是什么、最近在做什么、树里有哪些相关会话、下一步该用哪个工具 |
| `session_grep` | 目标会话**一次**日志扫描 | 里面提到 X 的地方在哪：命中 `seq` + 片段 + `nextFromSeq` 翻页 |
| `session_read` | 目标会话**一次**日志读取 | 某个 `seq` 前后到底写了什么（含工具调用 / 结果、已被 prune 的 shadowed 事件） |

推荐顺序：拿到会话 id 先 `session_overview`；若 `stats.logEvents` 很大（几百以上），用 `session_grep` 定位，再 `session_read` 精读；会话不长才直接 `session_lookup` 读全树。

| 工具 | 参数 | 默认 | 含义 |
|---|---|---|---|
| `session_overview` | `sessionId` / `related` / `recentLimit` | 当前会话 / `true` / `3`（上限 20） | 目标 id；是否列树（只取 header，不读内容）；带出多少条最近消息 |
| `session_grep` | `sessionId` / `query` / `limit` / `fromSeq` / `types` | 当前会话 / 必填 / `20`（上限 50）/ `0` / 全部 | 检索词（**字面、大小写不敏感**，空格分词 AND，最多 5 词）；翻页把上次的 `nextFromSeq` 传回 `fromSeq` |
| `session_read` | `sessionId` / `seq` / `before` / `after` / `tailLimit` | 当前会话 / 省略=读尾部 / `3`（上限 50）/ `3`（上限 50）/ `10`（上限 100） | 窗口模式给 `seq`；尾读模式给 `tailLimit` |

> **为什么检索要自己实现**：官方 `session_event_search` / `session_event_read` 带**工作区授权**——读别的工作区的会话会直接报 `Error: session target is outside the caller workspace`（`SESSION_QUERY_TOOL_UNAUTHORIZED`）。用户从界面复制来的会话 id 常常属于别的工作区，整条「检索 / 精读」路会被挡住。本插件的查询工具都走 `sessionQuery` 服务，没有这层工具级限制，只读、不做任何写操作。授权口径：**id 是用户主动给的**，等价于用户授权读这一份会话。

> **为什么检索叫 `session_grep` 而不是 `session_search`**：随附包的 `@deepseek-ai/dsh-tool-session-query` 已经注册了 `session_search`（跨会话检索）等五个工具，工具注册表对**重名是硬失败**（后来注册的那一行整行激活失败）。`session_grep` 语义也更准：字面匹配、不走索引。

### `session_lookup`

按 id 读一个会话以及它的**整棵**会话树：递归到孙会话、曾孙会话，并带上祖先链。

| 参数 | 必填 | 默认 | 含义 |
|---|---|---|---|
| `sessionId` | 否 | 当前会话 | 目标会话 id，三种写法都认（见上）。省略时查调用它的会话本身 |
| `includeMessages` | 否 | `true` | 是否附带最近消息（关掉就只返回元数据，连谱系内容也不读） |
| `messageLimit` | 否 | `10`（上限 200） | 目标会话返回多少条最近消息 |
| `includeNestedMessages` | 否 | `true` | 是否读取**谱系内其他会话**的内容（祖先 + 全部后代） |
| `nestedMessageLimit` | 否 | `2`（上限 10） | 每个谱系会话返回多少条最近消息 |

返回内容（结构 + 一段人可读的 markdown 摘要）：

```text
session             目标会话：id / 标题 / workspace / 预设 / 角色 / 父会话 / delegationDepth / live / persisted / 是否当前会话
ancestors           已知父级链（由近到远）；血缘不完整时 complete=false 并给出 unresolvedParentId
subagents           全部后代会话（递归到孙会话、曾孙会话…），父在前：id / 标题 / depth / parentId / 创建时间 / 状态
nested              谱系内会话的内容摘要（祖先 + 全部后代）：
                       id / 标题 / role / relation(ancestor|descendant) / depth / parentId
                       task（它的第一条用户消息 = 它被交办的事） / messages（最近 N 条） / error（读失败时的原始错误）
nestedTruncated     因单次上限（20 个）没读的谱系会话数
messages            目标会话最近 N 条人对人消息（user / assistant / 压缩摘要）
inheritedEventCount 种子会话从父会话继承的事件数
```

「顺着会话树读」是默认行为：目标是根会话时给出每个子会话、子会话的子会话的「任务 + 最近消息」；目标是子会话 / 孙会话时先给祖先链，再给每个上级的「任务 + 最近消息」，所以「谁派的它、上级当时在做什么」一次调用就能拿到。读取按需且有上限：`includeNestedMessages=false` 或 `includeMessages=false` 退回纯元数据；谱系会话超过 20 个时只读前 20 个并写明「还有 N 个没读」；某个谱系会话日志读不出来只标该节点的 `error`，不影响其余部分。

只读：不创建、不修改、不删除任何会话。适合中短会话或已确定要看全树时；长会话用上面三个工具。

### `session_share`

Agent 侧的分享入口，四个动作：

| 动作 | 作用 |
|---|---|
| `create` | 创建（或返回已存在的）分享链接 |
| `status` | 列出一个会话的分享状态 |
| `revoke` | 按 token 撤销分享 |
| `list` | 列出所有分享 |

`sessionId` 同样接受三种写法；归一化后分享记录落在真实 id 上。工具描述里写明**只有用户明确要求时才调用**。

### `session_resume_subagents`

重启或长任务中断之后，子智能体（`subagent` 工具派生的子会话、Agent Teams 的 teammate）的会话日志还在，但进程内的 Agent 已经没了。DSH 只允许**父级**对「直接可继续子级」发送 continuation 消息时冷恢复它；UI 直接打开子会话会被 `ApiSessionSubagentOwnership` 拒绝。本工具把这条通道交给模型。

| 参数 | 必填 | 默认 | 含义 |
|---|---|---|---|
| `sessionId` | 否 | 当前会话 | 父会话（root / Lead），或要恢复的子会话 id |
| `targets` | 否 | 全部 | 只恢复这些子会话 id / teammate 名字 |
| `dryRun` | 否 | `false` | 只列出子智能体与状态，不发送恢复消息 |

在父会话里调用（省略 `sessionId` 即恢复当前会话的全部离线子智能体；`dryRun: true` 先看清单）；要恢复某个具体子会话就把它的 id 传给 `sessionId`。**父会话必须在线**，否则返回 `PARENT_NOT_LIVE`（先打开父会话即可）。

边界：恢复只发一条「继续」消息，不复制历史、不重建 agent——preset、工具限制、模型都由子会话自己的 descriptor 决定（这是官方冷恢复的语义）；外部（ACP / SDK / Codex / Claude Code）子级与一次性子代理不在可恢复范围内；单个父级下的在线子代理数量受 `maxActiveSubagents` 限制，超限返回 `ACTIVATION_LIMIT_REACHED`。

## 会话分享（界面与分享页）

会话标题栏的**分享按钮**（复制按钮左侧）打开「分享会话」对话框：

- 点「创建分享链接」→ 得到 `http://<host>:<port>/share/<token>`；可以「复制」、在浏览器里「打开」、或「下载 HTML」（`?download=1`，存成单文件，发给别人双击就能看）；
- 「停止分享」两段式确认后立即失效（再访问 404）。

分享页是**只读快照**：标题、创建时间、消息（用户 / 助手 / 压缩摘要）、子代理列表，不依赖 DSH、不需要登录、不带脚本。它**不展示**会话 id、工作目录、token，也不展示工具调用参数与结果。

| 场景 | 是否支持 |
|---|---|
| 本机浏览器打开分享链接 | ✅ 开箱即用 |
| 局域网其它机器打开 | ✅ 需要把 DSH web 绑到局域网地址：`dsh web --host <局域网IP>` |
| 公网分享链接 | ⚠️ 取决于部署：需要反代 / 内网穿透 / 公网地址 + `--public-url`；DSH 默认只监听 `127.0.0.1` |
| 完全离线分享 | ✅ 用「下载 HTML」把单文件发出去 |
| 口令保护 / 有效期 / 访问统计 | ❌ 未实现（token 本身即凭据，可随时撤销） |

链接里的根地址来自 `webApp.getAdvertisedUrl()`（部署配置了对外地址时）或本机监听 origin；两者都拿不到时创建会明确报错，而不是给一个打不开的链接。

**安全模型**：分享页注册在 `dsh-host-webserver` 的普通 HTTP 路由上，准入边界完全落在 token——24 字节（192 bit）随机、不可枚举、可撤销、每次请求现读日志（撤销即失效，磁盘上不多存一份会话内容）。反过来，创建 / 查询 / 撤销这些**有副作用**的接口走认证通道：`/dsh-session-enhance`、`/dsh-session-enhance-retry`、`/dsh-session-enhance-context` 三条路由的 handler 内都调 `connection.admit(req)`，拒绝时原样写状态码（401 / 403），通过后才执行业务。浏览器半用 `ctx.connection.rpc.call('/dsh-session-enhance', …)` 调用。

## 中断重试

官方「继续生成」只覆盖**失败**（`turn/end` 的 `reason.kind` 是 `error`），不覆盖你主动点「停止」的那一轮（`aborted`），也不覆盖**应用被关闭/电脑重启**导致的中断。「中断重试」组件专门补这个空缺，两类「没做完」的轮次都能重试：

- **触发条件**：
  - **用户点停止** → `turn/end { reason: { kind: 'aborted', reason: { kind: 'user' } } }` 时记录；
  - **应用被关闭 / 电脑重启 / 关机** → 优雅退出是 `aborted + disposed`；被强制结束时 DSH 重启重放日志会补写 `{ kind: 'interrupted' }`；连 `turn/end` 都没有的情况（硬断电）由 **Host 启动扫描**兜底：读最近 72 小时内更新过的会话，找「最后一轮没闭合」或「以 interrupted 结束」的回合，补一条可重试记录（最多读 60 份日志，单份读失败跳过）。
  - 该会话出现新的 `turn/start` 或新的用户消息后记录立即**作废**（已经继续过了就不再给入口）。
- **按钮位置**：composer 右侧、主按钮之前的「重试」按钮（槽位 `conversation.input.right`），不遮挡官方的发送 / 「继续生成」按钮。
- **三态**：`ready`（有可重试记录，按钮可点；每 30 秒向 Host 复查一次，记录没了就自己隐藏）→ 点击后 `busy`（置灰、等待 Host）→ `failed`（显示错误码约 3 秒，随后隐藏并重新查询，记录还在就回到可点状态）。会话正在跑或挂着子智能体时按钮不显示。
- **点击后做什么**：Host **先走官方 continuation**（`sessionController.prompt({ content: [] })`，与官方「继续生成」同一条服务路径），官方可用时不注入任何提示词；只有官方不可用 / 抛错时才回退到 `agent.followup()` 发一条中性的 user 消息（「上一轮因应用被关闭或中断而没有完成。请从中断处继续完成，不要复述已完成的部分。」）。两条都失败才返回错误码。
- **30 分钟 TTL**：中断后没人点，记录 30 分钟后过期；期间切到别的会话、重开应用再回来仍能点。
- **边界**：记录只在内存里（不落盘）；Host 重启后由**启动扫描**从会话日志重建（最近 72 小时、最多 60 份日志），所以「关掉应用 / 重启电脑」后的未完成轮次同样能看到按钮。
- **可单独启停**：停用 `dsh-session-enhance-retry` 行后，浏览器半的能力探测拿到 405，按钮换成隐藏占位（`data-interrupted-retry="hidden"`）。

**与官方「继续生成」的分工**：官方 = 失败（错误码属于 RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE / STREAM_CLOSED，且有已准入的用户工作）；本组件 = 用户主动停止 + 应用被关闭/重启打断。两者互斥，不会对同一轮同时出现；失败永远交给官方。

`CONTEXT_WINDOW_EXCEEDED` 是确定性失败，重发只会再次超长——用下面的压缩能力解决。

## 侧边提问

在右侧栏里问一个「顺带的问题」，不打断主会话，也不把主会话的上下文搬进新会话。

**三个入口**：

1. 右侧栏标签条「+」→ 引导页里的「侧边提问」卡片；
2. 会话标题栏右侧的「侧边提问」按钮；
3. 在会话里**选中一段文字** → 弹层里并排两个按钮：「引用文本」（等同官方引用，插进主会话输入框）与「侧边提问」（把选中文字作为引用，到侧边会话里问）。

**侧边会话不是分支，是「按会话 id 查询」**：它由 `sessionController.create` **新开**一个普通会话（沿用原会话的工作区与 Agent 预设），并把一段**询问提示词**预填进输入框：

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

所以侧边会话**不背**原会话的上下文预算，也不继承它的思考 / 工具轨迹；需要哪些上文由模型按问题自己检索。提示词可见、可编辑（预填不自动发送），用户在其后补上问题即可。

**只读**：Host 侧创建会话后立刻 `permissionPresets.setPreset({ sessionId, preset: 'read-only' })`。**fail-closed**：只读切不上就把刚建的会话归档并报错，绝不留下一个可写的「临时」会话。只读模式下写文件 / 跑改文件的命令会被宿主沙箱拒绝；模型请求提权时走审批，默认拒绝。

**关闭即归档，保留即普通会话**：

| 时机 | 侧边会话状态 |
|---|---|
| 标签打开期间 | 临时、只读；关闭标签默认归档（从会话列表消失） |
| 点「保留」 | 切回原会话当时的权限预设（可写），成为普通会话，关闭标签也不归档 |
| 点「改回临时」 | 再切回只读 |
| 重启宿主 | 标签恢复时自动取消归档；没有标签页的遗留临时会话在启动清扫里归档 |

## 上下文压缩

把「压缩上下文」做成**分级**能力：手动一键压缩，或在压力达到阈值时自动分级处理。依赖官方压缩栈（见下方前置条件）。

### 手动压缩：官方「上下文已用」面板里的动作

DSH 自带官方上下文 meter（composer 下方的小圆环 + 百分比），点开是「上下文已用 N%」面板（系统提示词 / 工具定义 / 对话消息三段明细）。本插件**不另做百分比小部件**，而是把「压缩上下文」动作注入这个官方面板的末尾：

- 面板底部多一行 `压缩上下文        [压缩]`，字号、行高、色板、分隔线都沿用官方 `ContextMeter` 的 token，看起来就是官方面板的一部分；
- **点「压缩」= 执行官方 `/compact` 命令**：Host 调 `ctx.commands.execute(agent, '/compact', [], signal)`，与用户打字执行 `/compact` 走**同一条链路**——会写入 `command/run` 与 `command/done`（带 `sourceEventSeq`），聊天记录里会出现官方命令反馈和**压缩摘要卡片**。只有命令未注册（没启用 `dsh-command-compact`）时才回退到直接调 `ctx.compaction.compactNow()`；
- 那一行先变「压缩中…」，完成后显示「已压缩 N 项，释放约 M tokens」（数字从命令返回文案解析；解析不到时显示「压缩完成，详见对话中的压缩摘要」），没有可压缩历史时显示「没有可压缩的历史」；失败时按命令返回的文案映射回稳定错误码（`BUSY` / `CANCELLED` / `SUMMARY_FAILED` / `COMMIT_FAILED` …）；
- 会话正在跑 / 没有活跃 Agent / 压缩服务未挂载时按钮置灰或给出明确错误码，不会假装成功。

手动压缩也是分级的：**只有压力达到 L1 阈值**才先做批量修剪（不调模型），紧接着执行官方 `/compact`（L2 摘要）；低于阈值时跳过修剪（结果里 `pruneSkipped: true` + `pruneReason`），避免把「没有可压缩历史」的会话白白剪掉工具结果中间段。

**为什么用 DOM 注入**：这个官方面板由 `dsh-client-ui-conversation` 内置渲染，portal 到 `document.body`，**没有对外 slot**。本插件按结构特征识别它，用 `MutationObserver` + 800ms 兜底轮询在面板打开时把动作行挂到末尾；面板关闭 / 重渲染自动补回，插件卸载时清理观察器、样式与节点。官方若以后换 DOM 结构，最坏结果是这一行不出现——不会影响官方 meter 本身。

判据必须严格，因为 composer 里不止一个 `role="dialog"` 面板（「本轮用量」「Token 用量」也是 dialog + `<dl>` + 文本里有百分比）。现在的判据同时要求：**不是**用量面板（`dl` 上带 `data-turn-usage-details` / `data-session-stats-details` 就排除，这两个 `data` 属性是官方源码里写死的）；`<dl>` 的**直接子元素恰好 3 个 `div` 行**、每行有 `dt` 且 `dt` 内有色块 `span`；头部有「~已用 / 窗口」这组数字（如 `~477K / 1M`，与语言无关）。任一条不满足就不注入——宁可这一行不出现（输入框里还有 `/compact` 入口），也绝不出现在错误的窗口里。

### 分级自动压缩：L1 / L2 / L3

| 级 | 名称 | 动作 | 模型调用 | 触发（占**有效窗口**比例） |
|---|---|---|---|---|
| L1 | 微压缩 | **按需**修剪超预算工具结果：从新到旧替换，压力降回阈值以下就停（官方 `toolResultPruner.pruneContent` + 官方替换协议；前提缺失时回退 `pruneSession` 全量修剪） | 否 | ≥ 60%（`pruneRatio`） |
| L2 | 深度压缩 | 官方 `compactIfNeeded('pressure')`：**先修剪全部可剪工具结果，再摘要最旧范围**，同一事务 | 是（1 次摘要） | ≥ 80%（`compactRatio`） |
| L3 | 溢出恢复 | 官方 `compactIfNeeded('context-overflow')`，表层前进后重试该请求 | 是 | 提供方返回 `CONTEXT_WINDOW_EXCEEDED` |

**有效窗口** = 模型窗口 − 输出预留（最近请求头的 `maxTokens`）。**触发阈值**与官方 `compaction-basic` 逐字一致：`min(窗口 × 比例, 窗口 − 输出预留 − headroomTokens 65536)`，不写死 token 数。1M 窗口下两者恰好相等；小窗口下 headroom 会把阈值显著提前（128k 窗口 + 8k 预留 → 54,464 而不是 96,000）。窗口小于压缩余量时返回 `NO_PRESSURE_BUDGET`（官方在同样配置下抛 `TargetPressureConfigError`，不压缩）。

**批处理（一次性断点）**：历史替换会让「从第一个被替换 token 起」的前缀缓存失效。所以 L2 不拆成「先修剪、下轮再摘要」——官方 `compactIfNeeded('pressure')` 在**同一个压缩事务**（一次 `compaction/start` … `compaction/end`）里先剪全部、再摘要，只换一次表层；L1 按需修剪，从新到旧替换、省够就停（剪得越靠前，失效的前缀缓存越多，「省够就停」同时降低不可逆损失与缓存代价）；自动模式下 L1 / L2 都在**同一个 `agent/pre-step`**（下一次请求发出前）完成，下一次请求看到的是最终表层，因此只产生一个缓存断点。

**动作行的预警后缀**：压力 ≥ 有效窗口 90% 时，面板那一行显示「上下文即将用尽」。

### 开关与阈值

- `autoCompact`：分级自动压缩总开关，**默认关闭**。在「设置 → 插件 → 已安装 → 会话增强 → 自动压缩」里切换，volatile（保存后热更新，不需要重启）。**关闭 = 交还官方自动压缩**（官方 80% 兜底照常工作），不是「什么都不压」。
- `pruneRatio`（默认 `0.6`）/ `compactRatio`（默认 `0.8`）：两级阈值，volatile；设置页只提供开关，比例走 profile 补丁：

```yaml
- id: dsh-session-enhance
  config:
    pruneRatio: 0.7     # L1 阈值（默认 0.6）
    compactRatio: 0.85  # L2 阈值（默认 0.8）
```

`pruneRatio` 会被收敛到不大于 `compactRatio`（否则 L1 永不触发）。

三态仲裁（运行期给 compaction 引擎的 `compactIfNeeded` 包一层）：

| 情形 | 行为 |
|---|---|
| 非 `pressure`（溢出恢复 / 手动 / 切模型） | 原样转发 |
| `pressure` + 开关**关** | **转发给官方**（关 = 没装插件） |
| `pressure` + 开关**开** + 官方监听调用 | 返回 `null`（插件独占，避免同一窗口压两次） |
| `pressure` + 开关**开** + 本插件调用 | 放行 |

为什么需要这一层：web 形态下压缩实例在 preset 的隔离组里（`isolate: { compaction, toolResultPruner }`），profile patch 的 id 定向覆盖打不到它——运行期仲裁是唯一可靠的方式。L3 是**被动安全网**，与 `autoCompact` 开关无关，每轮最多一次。

### 前置条件：官方压缩栈

手动 / 自动压缩都依赖官方压缩栈。请在 profile 里启用：

- `@deepseek-ai/dsh-compaction-basic`：提供 `ctx.compaction` 服务，并在压力达到阈值时**自动压缩**（默认 `thresholdRatio: 0.8`）——这是避免 `CONTEXT_WINDOW_EXCEEDED` 的兜底；
- 可选 `@deepseek-ai/dsh-command-compact`：额外的 `/compact` 打字入口；
- 可选 `@deepseek-ai/dsh-compaction-tool-result-pruner`：压缩时先修剪超大工具输出（L1 的批量修剪也复用它，没挂载时 L1 自动跳过、L2 仍可摘要）。

没启用 `compaction-basic` 时，动作行依旧出现但按钮置灰并提示「压缩不可用：当前部署未启用压缩插件」。若想彻底移除官方自动压缩（包括溢出恢复），在 profile 补丁里关闭该行（`- id: compaction-basic` + `config: { auto: false }`），或按官方 web 形态把 host 平面三行保持禁用、由 preset 提供压缩服务。

### 已知边界

- **没有「Snip 历史剪除」**：DSH 表层只能「替换」不能「删除」；直接写事件会绕过 compaction seam，要自己复刻锁与工具配对，风险大于收益。
- **没有单独的「上下文折叠」**：DSH 的 seam 只有「摘要替换」一种写操作；官方 `compactIfNeeded` 本身就是「摘要最旧范围 + 逐字保留近期尾部」。
- **不阻塞请求**：DSH 没有「阻塞 API 调用」的 seam，所以预警只显示提示，不会拦下请求。
- **摘要内容由官方决定**：摘要提示词、保留比例与压缩后内容由官方 `compaction-basic` 负责（结构化 8 段检查点，保留文件路径、错误与用户原话），本插件不替换它；插件只负责「什么时候压、压哪一级」。

## 谷峰插件

把会话**只在 DeepSeek 空闲时段跑**：高峰时段暂停这个会话的模型调用，此时发出的消息留在**官方队列**里，空闲时段到了自动释放并续跑。开关在**会话标题栏右上角**，每个会话一份。

**官方口径（本组件按它判断）**：

> 空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。

即：高峰 = 工作日 09:00–12:00、14:00–18:00（法定节假日除外）；午休、夜间、周末、法定节假日全天都是空闲（调休补班的周六 / 周日仍按周末算空闲，官方口径就是「周一至周五」）。组件内置两年（2026 + 2027）法定节假日表：元旦 01-01..01-03、春节 02-15..02-23、清明 04-04..04-06、劳动 05-01..05-05、端午 06-19..06-21、中秋 09-25..09-27、国庆 10-01..10-07 等。跨年后不需要改代码：`autoHolidays`（默认开）会自动抓取次年安排并缓存；也可以手动在配置页更新 `holidays`（或清空表示不豁免节假日）。

**标题栏开关**（槽位 `conversation.session.header.utilities`，order `-12`，落在分享 / 复制按钮左侧；官方 `Pill` + `Tooltip` 形制）：

- 内部始终显示**相位 + 倒计时**：高峰 = 太阳 +「高峰」+ 倒计时（橙色），空闲 = 弯月 + 星 +「空闲」+ 倒计时（绿色）；
- 倒计时口径：>1h `3h05m`、1min~1h `12m34s`、<1min `37s`（省略 `0m`）；剩余 ≤60s 加 emoji 并带呼吸动效——高峰→空闲（即将恢复）用 `🎉 57s` / ≤10s `🎊 8s`，空闲→高峰（即将暂停）用 `⏳ 57s` / ≤10s `⏰ 8s`；
- **背景按相位着色**（高峰橙底 / 空闲绿底），**边框只切黑白款**：选中（会话已设为空闲会话）= 浅灰边框，未选中（普通会话）= 白色边框；未选中也显示相位 + 倒计时；
- 三段排列（图标 + 相位 24px + 倒计时），段间距 2px、高度固定 24px、**宽度固定 `103×24`**：
  宽度按最长文案（`14h48m` / `59m59s` 约 43px）定，倒计时在槽内居中，短文案
  时左右各只差约 3px——既固定尺寸，又不会在某一侧留下明显空档；
- 点击 = 把当前会话设为「空闲会话」（再点取消，回到普通会话）；
- 悬浮提示走官方 `Tooltip` 深色气泡，写清「状态含义 + 点击行为 + 何时切换」；有排队消息时追加「队列中 N 条消息，空闲时段开始后自动处理」。

**新建会话页的开关**（槽位 `conversation.hero.options`，预设下拉框右侧）：与标题栏按钮**同一个控制器**。点击 = 把这个新建（空白）会话设为「空闲会话」（再点取消）——不创建会话、不导航、不弹成功提示；新建出来的会话就是该设置对应的会话。内部同样显示相位 + 倒计时、切黑白边框、尺寸 `106×24`。

**高峰发消息会怎样**：消息被 Host 接收并进入**官方 durable 队列**（暂停中先显示为「待发送」气泡；重开应用后出现在 composer 上方的队列条，可编辑 / 删除），但**不会开始任何模型调用**；空闲时段开始后按队列顺序逐条执行。

**高峰开始的那一刻正在跑的一轮**：会被中断（`agent.cancel({kind:'hook'})`，保留队列），所以不会继续在高峰烧 token；这一轮在空闲时段会**自动续跑**——聊天里出现一条紧凑的「已请求继续生成」标记（官方 continuation 触发的空 `source.kind: 'retry'` 消息）。

**重启 / 关闭应用后自动恢复**：空闲会话在高峰暂停期间排队（官方 durable inbox）的消息，在应用重启、会话重新打开后——若已到空闲时段且队列里有消息，会被**延迟 1.2 秒复查**一次：Agent 自己已经续跑就什么都不做；仍空闲才注入唤醒（官方 continuation 优先，官方不可用才用空 retry 消息）。

**子代理也算「该会话」**：沿 `session.header.parentSession` 向上，任一祖先会话启用了谷峰，子树里的 live Agent 一并被 hold / cancel；祖先会话即使已经关闭（没有 live Agent），只要它的开关记录仍是启用，子代理也照样被覆盖；禁用父会话时子树一起释放。子智能体的开关是**只读**的（`session.header.origin === 'subagent'` 的会话同步主会话状态，`enabledSource: 'parent'`、`inheritedFrom` 指向直接父会话，chip 置灰不可点，直接调 `setEnabled` 会返回 `READ_ONLY_INHERITED`）；普通 fork（有 `parentSession` 但不是 `origin: subagent`）不受影响。

**开关是即时的**：高峰打开 → 立刻暂停（必要时中断当前轮）；空闲打开 → 不暂停；关闭 → 立刻释放，队列里压着的消息马上开始跑。

**持久化**：每个会话的开关状态写 `<DSH_HOME>/dsh-session-enhance/offpeak.json`（原子写、容量 500、损坏时备份后从空表继续，写盘失败只让界面提示「重启后可能回落」而不阻止开关）。Host 重启后偏好还在；重开会话时按偏好自动 hold。

**边界（它不管什么）**：它拦的是「Agent 轮次」这条链路（用户提示、继续 / 目标轮、调度任务、子代理、压缩 / 摘要等经 Agent 的模型请求）。**不经过 Agent 的辅助模型调用**（例如手动点「翻译推理」这类直接调 `llm` 的按钮）不在暂停范围内；被中断的那一轮已经执行完的工具调用不会回退。没有 `agents` 服务的部署（如 headless）里组件会干净激活但无事可做。

## 停用某个组件之后

浏览器半只有一份（`dsh.client` 是包级声明，不能按行拆），它会跟着第一行一起加载。为了不让被停用的组件留下「点了没反应」的按钮，浏览器半启动时会在三个子组件的通道上各发一次**能力探测**（分享 `/dsh-session-enhance`、中断重试 `/dsh-session-enhance-retry`、谷峰 `/dsh-session-enhance-offpeak`）：Host 的 RPC 前缀路由只在对应行启用时才注册，组件在 → 返回 **200**（缺参数的业务信封也是 200），组件停用 → 请求落到 SPA fallback，返回 **405**。探测不阻塞 UI 注册、最多退避重试 3 次；判定不了的（网络异常、非 200/405）一律乐观保留，不会因为一次抖动把按钮永久藏掉。

- 停用**会话分享** → 标题栏分享按钮换成隐藏占位（`data-session-share="disabled"`）；
- 停用**中断重试** → composer 右侧的重试按钮换成隐藏占位（`data-interrupted-retry="hidden"`）；
- 停用**谷峰插件** → 标题栏开关换成隐藏占位（`data-offpeak-hidden="disabled"`，不渲染 `data-dsh-offpeak-button`），Host 释放该会话的 hold，会话立即恢复正常运行；
- 停用**会话增强**（第一行）→ 浏览器半的四块界面（分享 / 复制 / 中断重试 / 谷峰开关）随 client 半一起消失，五个查询工具也不可用；
- 重新启用后（桌面版重开应用 / 浏览器版刷新页面），按钮自动回来（探测只做一次，不写任何持久缓存）。

## 配置

### 「会话增强」行（设置 → 插件 → 已安装 → 会话增强）

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoCompact` | `false` | 分级自动压缩总开关（volatile，保存后热更新） |
| `pruneRatio` | `0.6` | L1 微压缩阈值（占有效窗口） |
| `compactRatio` | `0.8` | L2 深度压缩阈值 |

### 「谷峰插件」行（设置 → 插件 → 会话增强 → 包含的组件 → 谷峰插件）

五个字段都是 volatile，保存后热更新：

| 字段 | 默认 | 说明 |
|---|---|---|
| `peakWindows` | `09:00-12:00,14:00-18:00` | 高峰时段，逗号分隔的 `HH:MM-HH:MM`（起点含、终点不含） |
| `timeZone` | `Asia/Shanghai` | 判定用的时区 |
| `holidays` | 内置两年法定节假日表 | 法定节假日日期（`YYYY-MM-DD`，逗号 / 空白分隔）；**空串 = 不享受节假日豁免** |
| `autoHolidays` | `true` | 自动更新节假日表。开启且 `holidays` 仍是默认值时，插件启动 3 秒后检查一次（不阻塞激活），之后**每天**做一次本地检查；只有缓存超过 **7 天**才真正发网络请求。数据源 `timor.tech`，备用 `holiday-cn` 的 jsDelivr / GitHub 镜像，结果缓存在 `<DSH_HOME>/dsh-session-enhance/holidays-cache.json`。抓取失败不影响任何行为；用户改过 `holidays`（含空串）时不再覆盖 |
| `defaultEnabled` | `false` | 新会话默认是否启用（无显式记录的会话按它走） |

非法值逐字段回退默认并只 warn 一次。

## 存储与数据

| 文件 | 内容 | 容错 |
|---|---|---|
| `<DSH_HOME>/dsh-session-enhance/shares.json` | `{ sessionId, createdAt, includeDescendants }` | 原子写（临时文件 + rename）；损坏时**拒绝写入并报错**而不是覆盖（避免清空已有分享记录）；读取容忍 UTF-8 BOM；旧包名目录下的记录只读回退 |
| `<DSH_HOME>/dsh-session-enhance/offpeak.json` | 每会话 `{ enabled, updatedAt }`，容量 500（按 `updatedAt` 淘汰最旧） | 原子写；**损坏时容忍**（备份成 `.corrupt-<时间戳>.bak` 后从空表继续）；写盘失败只让 RPC 返回 `persisted: false`，不阻止开关在当前进程内生效 |
| `<DSH_HOME>/dsh-session-enhance/holidays-cache.json` | 自动抓取的节假日表 + 抓取时间 + 来源 | 抓取失败 / 缓存过期都继续用内置或上次缓存 |

## 修复被写坏的会话日志

包内带一个修复工具 `scripts/repair-session-log.mjs`，用于两类会让会话「打不开」的日志损坏。修复前自动备份、默认 dry-run：

- **损坏 A：turn 之外写了 surface 替换事件**。症状是会话历史读不出来（`session_lookup` 只显示「没有可读的语义消息」）且会话无法冷恢复。
- **损坏 B：`turn/end.reason` 为 `null`**。某类非法的 agent cancel cause 会让运行时抛错，而 `finally` 仍 append `turn/end` 且 `reason` 为 null。这类日志过得了重放校验（`readSession` 正常），崩的是**投影层**，GUI 报「历史加载失败：failed to project session … Cannot read properties of null (reading 'kind')」。

```powershell
# 默认 dry-run：报告会改什么 + 跑完五道校验，不写任何文件
node scripts/repair-session-log.mjs "C:\Users\<你>\.dsh\sessions\<工作区>\<会话id>\session.v4.jsonl.zstd"

# 确认无误后写回（先自动备份为 <file>.bak-<时间戳>）
node scripts/repair-session-log.mjs "<同上>" --apply

# 已知确切原因时可以把真实原因写进去（默认是 {"kind":"aborted","reason":{"kind":"legacy"}}）
node scripts/repair-session-log.mjs "<同上>" --apply --cause '{"kind":"aborted","reason":{"kind":"hook","reason":"degeneration"}}'
```

修法 A：整对删除「`compaction/prune` + 它紧跟的 replacement」，保留被修剪的原始 `tool/result`（内容不丢、surface 不残缺），重编号 seq 并重映射**全部** seq 引用（`sourceEventSeqs` / `surfaceOp` / `shadowedSeqs` / `shadowedRange` / `messageSeqs` / `developer/message.headerSeq`），引用到已删事件的从列表剔除并去重。

修法 B：把 `reason` 换成合法值。默认 `{"kind":"aborted","reason":{"kind":"legacy"}}`——`legacy` 是 DSH 给「原始记录没带 cause 的导入」准备的成员，语义就是「被取消、原因未记录」；客户端对 `aborted` + 非 `hook` 只显示「已停止」，不会伪造「进程已退出」那种假告警。

五道门禁（任一不过就中止、不碰原文件）：

1. turn / step 规则 0 违规；
2. seq 唯一 + 连续 + 引用无悬空；
3. **`turn/end.reason` 结构不变量**：每个 reason 都是对象、`kind` 属于 `TurnEndReasonMap` 已知成员；`aborted` 的 `cause.kind` 属于 `user | parent | hook | disposed | legacy`（`fromRestore` 不看这个字段，挡损坏 B 的就是这一道）；
4. **DSH 自己的 `Session.fromRestore`**（从 `app.asar` 抽出真实校验器跑）；
5. 打包回读逐字节一致。

**并发写保护**：读入后如果文件的 `size` / `mtime` 变了（会话还活着、正在 append），脚本拒绝写回——否则会把并发追加的事件覆盖掉。等会话空闲或重启 DSH 后再跑。

**已知边界**：带「整段压缩摘要」（`surfaceOp: replace` 覆盖很大范围、`sourceEventSeqs` 很长）的会话可能在门禁 4 失败，报 `surface replace: sourceEventSeqs must include every shadowed surface node`——删掉 prune 后原节点回到 surface，而摘要的替换范围覆盖它却没引用它。这种要单独处理（把该节点补进摘要的 `sourceEventSeqs`）；脚本会拒绝写坏、原文件不动。

## 仓库结构与开发

```text
index.js                组件①「会话增强」Host 半：五个查询工具 + 上下文 RPC + 分级压缩驱动
share/index.js          组件②「会话分享」Host 半：session_share + /share 路由 + 分享 RPC
retry/index.js          组件③入口：中断监听 + RPC 通道
offpeak/index.js        组件④入口：hold 控制器 + RPC 通道 + 节假日自动更新；Config 五字段
sideask/index.js        组件⑤入口：创建只读会话 + 权限预设恢复 + RPC 通道
locale/                 包根词典（卡片标题与组件①共用）；share|retry|offpeak|sideask/locale/ 是各组件的
lib/                    业务实现：tools/（各工具 schema）、compact/（分级压缩）、offpeak/（时段与存储）、
                        retry/、sideask/、shares.mjs、render.mjs、public.mjs、rpc.mjs、service.mjs
client.js               浏览器半：全部界面 + 对话框 + toast + i18n + 设置页卡片
cordis.patch.yml        根作用域 insert 五行（不按 preset 挂载）
scripts/repair-session-log.mjs   存量损坏日志修复工具
test/                   单测（node --test）
```

```powershell
node --test "test/**/*.test.mjs"   # 单测；离线、无模型
```

改这个包时最容易踩的几点：

- **严格 schema**：第三方插件不能 `import defineTool`，参数与返回值都要手写注册表接受的子集；`output.schema` 会校验 `execute` 的返回值——少一个字段、多一个字段、出现 `null` 都会在运行时变成 `tool returned invalid output`。`test/strict-schema.mjs` 就是在离线阶段抓这类问题。
- **浏览器半只能 require 两个说明符**：`react/jsx-runtime` 与 `@deepseek-ai/dsh-client-ui-primitives`；没有 `useState` 时通过槽位 `hooks` 注入自己的快照源（`{ getSnapshot, subscribe }`），renderer 会把它绑成组件 props 上的 `useXxx`。
- **工具名不得与随附包撞名**：注册表对重名是硬失败，且失败的是后来注册的那一行（会把官方插件行整行标成异常）。改工具名时先跑工作区的 `check-tool-names.mjs` 门禁。
- **组件行文案走另一套逻辑**：`dsh-app-boot` 的 `readPluginMeta()` 对子路径 specifier **不读** `specifier/package.json`，标题 / 描述只来自 `<specifier>/locale/en.json` 的 `meta`，并且 `exports` 必须暴露 `<子路径>/locale/*.json`（否则静默回退到裸 specifier）。
- **`node_modules` 形态会决定 client 半是否出现**：以 `link:` 指向源码目录安装时，client 半可能进不了页面清单；要验证 UI 就用 `pnpm pack` 打成 tarball 再装（真实目录）。
- **改完必须回归**：`node --test` 看不见「插件没加载 / 槽位没声明 / 返回值过不了校验 / 路由被回退吃掉」，要在真实 Loader 与真实浏览器里各跑一遍。

## 安全提示

- **分享链接是免登录的**：任何拿到链接的人都能读那份会话快照。不要分享含密钥 / 隐私内容的会话；撤销后立即失效。
- **侧边会话是只读档位**：fail-closed；但「保留」会把它切成可写的普通会话，此时它就是一条普通会话。
- **自动压缩会改写历史表层**：L1 / L2 通过官方替换协议改写旧的工具结果与消息（不可逆），关闭 `autoCompact` 即交还官方策略。
- **修复脚本会写会话日志**：默认 dry-run，`--apply` 才写且先备份；有并发写入时拒绝写回。先 dry-run 复核报告再 `--apply`。

## 仓库与许可

- 仓库：<https://github.com/lldwb/dsh-session-enhance>（公开）
- 许可证：MIT，见 [LICENSE](LICENSE)
- 变更历史见 [CHANGELOG.md](CHANGELOG.md)
