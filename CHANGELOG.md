# Changelog

本插件的改动都记在这里；版本号遵循 `.` 分段语义（大版本 = 结构性/破坏性，中版本 = 新能力，
小版本 = 修复与文档）。

## 4.0.0 — 2026-11-09

**破坏性改名（major）**：包名/仓库名 `dsh-session-inspect` → `dsh-session-enhance`，
显示名回到 **「会话增强」**（英文 Session Enhance）。三个组件与工具名不变。

### 为什么改

这个包是「一包三组件」的会话能力合集：会话检视（按 ID 查会话/子代理 + 复制 ID）、会话分享、
失败重试。3.0 按"唯一有使用痕迹的能力"改成了 `dsh-session-inspect` /「会话检视」，
但它是按**组件**命名、丢掉了包整体的定位；用户明确要求名称应是「会话增强」——即按
**包**的用途命名，三个组件都算在内。所以 4.0 用 `dsh-session-enhance` /「会话增强」。

### 变更（结构性）

- 包名/仓库名改为 `dsh-session-enhance`；三个 Loader 行 `id`/`name` 同步改为
  `dsh-session-enhance` / `dsh-session-enhance/share` / `dsh-session-enhance/retry`。
- 分享 RPC 前缀 `/dsh-session-inspect` → `/dsh-session-enhance`；重试通道 `/dsh-turn-retry`
  **刻意保留旧名**。
- 浏览器半模块 id、locale 命名空间、卡片标题（包根「会话增强」/ Session Enhance）同步。
- 分享记录目录改为 `<DSH_HOME>/dsh-session-enhance/`；按 **3.x → 2.x** 顺序只读回退历史
  `shares.json`，首次写入复制到新路径、旧文件原样保留。
- 构建戳 `2026-11-09.3`，`CLIENT_VERSION=4.0.0`。

### 用户要做什么

1. 从 profile 的 `dsh.profile.bundles` 与 `dependencies` 删掉旧包 `dsh-session-inspect`
   （或更旧的 `dsh-session-id`），删除 `profiles/<profile>/plugins/<旧包名>/`；
2. 用新包重新 `dsh plugin add dsh-session-enhance`（或本地目录 link）后 `pnpm install`；
3. 曾停用「失败重试」组件的：补丁层里的 `- id: dsh-session-inspect-retry` 要改成
   `- id: dsh-session-enhance-retry`（本机当前是启用状态，无此 override）；
4. 重启 DSH（client 清单是服务器启动时的快照）。

### 保留兼容（刻意不改）

- 重试 RPC 前缀 `/dsh-turn-retry`；`RETRY_SOURCE_KIND = 'dsh-session-id'`；followup 消息 id
  前缀 `dsh-session-id-retry-`；界面 `data-*` 选择器；`exports` 子路径结构。
- 历史 CHANGELOG 条目（2.x / 3.x 的包名与显示名）保持原样，作为当时的事实记录。

## 3.1.0 — 2026-11-09

### 修「模型不可用/失败之后看不到重试按钮」

**症状（用户实测）**：模型不可用导致一轮失败后，界面只剩红色错误，没有「重试」入口，
所以重试组件被停用。真实日志指纹：11-07 的 4 个错误 turn 都在最后失败后 **≈5.02 秒**
结束（闸门孤儿保护），11-06 可见会话的那次则挂满 **120,009ms** 后结束——即闸门只在
turn 结束**之前**存在，turn 一结束就没有任何重试入口了（切走/后台的会话尤其明显）。

**根因**：recovery（可重试记录）此前只在「用户点停止」时写入；模型失败路径只有闸门，
闸门一旦超时/孤儿保护放行，turn 以 error 收尾，浏览器半再问 `pending` 也只能得到空。

**修复**：

- Host：`turn/end { reason: { kind: 'error' } }` 时也写一条 recovery（TTL 30 分钟）。
  用户之后随时回到该会话、甚至刷新页面，覆盖层都会显示「上一轮失败 —— 点击重试」；
  点击用 `agent.followup()` 驱动新一轮（代价同停止后重试：历史多一条中性消息）。
- 浏览器半：`pending` 的 `recoverable` 从布尔改为对象（携带 `causeKind`），据此显示
  「上一轮失败」或「已停止」；`recheck` 的判空同步修正。
- **等待上限 120 秒 → 60 秒**：现在 turn 结束后仍有 30 分钟兜底入口，缩短原地等待
  不会再丢重试机会，同时消除"失败后界面卡两分钟"的体感。

### 验证

- 单测 **109/109**（新增：error 收尾写 recovery / pending 带 causeKind / 新 turn 清掉旧记录）。
- devkit web 沙箱 `retry-repro`（真实 Chrome + DSH 0.2.2-rc.1，模型走必然失败的未配置路由）：
  真实失败 → 闸门 waiting（`pending:true`）→ 60 秒超时、turn 以 error 结束 → 按钮变为
  「上一轮失败 —— 点击重试」（`pending:false, recoverable:true`）→ 切到新会话再切回，
  按钮仍在 → 点击后 `retry.ok via:followup`，新 turn 启动、续写消息出现。
- 活 profile：junction 指向源码，重启后生效。

## 3.0.1 — 2026-11-09

文档与验证记录更新（无行为变更）：README 的 3.0.0 验证表补上实测证据（单测 107/107；headless 沙箱三行
Loader 行与 session_lookup；web/UI 沙箱 client 半清单、dshTurnRetry=3.0.0、设置页三组件运行中；
活 profile 升级后 /dsh-session-inspect 路由 401、session_lookup 实调通过；重试行按用户设置保持停用）。

## 3.0.0 — 2026-11-09

**破坏性改名（major）**：包名/仓库名 `dsh-session-id` → `dsh-session-inspect`，
显示名「会话增强」→「会话检视」。三个组件与 `session_lookup` / `session_share` 工具名不变。

### 为什么改

按真实使用盘点（2026-11-04 → 11-09，157 个会话日志、47,411 帧、15,291 次 tool/call、
0 解压错误、0 坏行）：

- `session_lookup` **13 次 / 7 个会话**——三个工具能力里唯一有使用痕迹的；
- `session_share` **0 次**，`<DSH_HOME>/dsh-session-id/shares.json` **从未创建**（分享全时间零使用）；
- 失败重试组件被用户单独停用，157 会话里 0 条重试注入消息；
- 「复制 ID → 粘贴 → 问 Agent」闭环：全部 user/message 中没有出现会话 id。

旧名只覆盖三个组件之一，且只描述"拿到 id"这个手段；显示名「会话增强」是零信息量占位词。
新名对齐实际用途：**按 ID 检视会话与它的全部子代理**（复制 ID 是它的入口，附件是分享与重试）。

### 变更（结构性）

- 包名/仓库名改为 `dsh-session-inspect`；三个 Loader 行 `id`/`name` 同步改为
  `dsh-session-inspect` / `dsh-session-inspect/share` / `dsh-session-inspect/retry`。
- 分享 RPC 前缀 `/dsh-session-id` → `/dsh-session-inspect`；重试通道 `/dsh-turn-retry`
  **刻意保留旧名**（并入自 `dsh-turn-retry`，改名零收益、纯回归风险）。
- 浏览器半的模块 id、locale 命名空间、卡片标题/描述、`client.js` 版本戳同步。
- 卡片/组件文案：包根「会话检视 / Session Inspector」，`share/locale/` 与 `retry/locale/`
  仍叫「会话分享」「失败重试」。
- 分享记录目录改为 `<DSH_HOME>/dsh-session-inspect/`；新文件不存在时**只读回退** 2.x 的
  `<DSH_HOME>/dsh-session-id/shares.json`，首次写入把记录复制到新文件、旧文件原样保留
  （回滚到 2.x 仍可读）。本机该文件此前不存在，无迁移数据。
- 构建戳对齐：`BUILD`/`RETRY_BUILD` = `2026-11-09.1`，`CLIENT_VERSION` = `3.0.0`。
  2.1.0 改了重试行为却没有递增构建戳（违反 `lib/build.mjs` 自己的约定，导致"活进程跑的是
  哪一版"只能靠 SHA256 比对），本次一并修正。

### 用户要做什么

1. 从 profile 的 `dsh.profile.bundles` 与 `dependencies` 删除 `dsh-session-id`，
   删除 `profiles/<profile>/plugins/dsh-session-id/`；
2. 用新包重新 `dsh plugin add dsh-session-inspect`（或本地目录 link）后 `pnpm install`；
3. **曾停用「失败重试」组件的**：profile 补丁层里的 `- id: dsh-session-id-retry` 必须改成
   `- id: dsh-session-inspect-retry`，否则新行不会被 override 命中、重试会静默重新启用；
4. 重启 DSH（client 清单是服务器启动时的快照，刷新页面不够）。

### 保留兼容（刻意不改）

- 重试 RPC 前缀 `/dsh-turn-retry`；`RETRY_SOURCE_KIND = 'dsh-session-id'`；followup 消息 id
  前缀 `dsh-session-id-retry-`；界面 `data-*` 选择器；`exports` 子路径结构。

### 顺带修掉的重试问题（接 2.1.0）

- 活 profile 此前一直跑 **2.0.2 拷贝**（2.1.0 的 `agent.followup()` `role:'user'` 修复从未安装），
  本次升级把修复带进实际运行环境；重试组件在活 profile 中被用户停用的状态**尊重原设置**保留
  （新 id 的 `disabled: true` override 同步改写）。
- 诊断要点记在 README「失败重试」与本次提交说明：模型失败闸门在会话不可见时会 5 秒孤儿放行，
  可见时会等待最多 120 秒——两者都是设计取舍，不是本次改名的行为变化。

## 2.1.0 — 2026-11-06

本轮工作在 DSH **0.2.2-rc.1** 的真实 Loader + 真实浏览器里做了完整回归，结果是两层改动，
**别混为一谈**：

1. **适配 0.2.2-rc.1（跟新版组合的行为变化）**：随附组合自 `0.2.1-alpha.1` 起新增了一行
   `time-context`，它把「本轮时间采样」作为一条 `user/message` 注入（文本首行
   `Time sampled while preparing turn N, step M: …`）。本插件的注入过滤表不认识它，于是它出现在
   「最近消息」与分享页里（每条上千字符的框架噪音）。现在**优先按 `data.source.kind` 过滤**
   （`runtime-context` / `skill-catalog` / `time-context`），文本前缀只作为**没有 source 的老日志**兜底。
2. **顺带修掉的潜伏缺陷（0.2.1 时代就已存在，本次真实回归才暴露）**：下面两条**不是 0.2.2 引入的
   回归**，也不是 0.2.2 改了协议 —— 是插件长期违反随附包契约，这一版按 0.2.2 源码的类型与校验对齐。

> 为什么这次才抓到：这两条在「离线单测全绿 + 只点一下按钮」的验证里都看不出来，必须真的跑
> 「停止 → 重试 → 分享」整条链路，且要有真实凭据让重试真的发出去（无凭据时提供方先报缺 key，
> 轮不到 `missing field 'role'` 这一层）。

### 修复（潜伏缺陷 ①：`agent.followup()` 的 user 消息漏 `role`）

`agent.followup(input)` 的声明一直是 `UserMessage`（`{ id, role: 'user', content, source }`，
`@deepseek-ai/dsh-llm/message`；`dsh-session` 的 `MESSAGE_ROLE_BY_TYPE` 校验在 `0.2.1-rc.5` 的
`packages/core/session/src/index.ts` 里就已存在），原实现只给了 `id` / `content` / `source`。
后果有两层：

1. 请求里的这条消息没有 role → 提供方直接 400（实测 sub2api：
   `Failed to deserialize the JSON body … missing field 'role'`），即**「停止后重试」必然失败**，
   界面显示成「模型调用失败」；
2. 它已经落进会话日志 → 该日志在 seed/load 边界被 `dsh-session` 拒绝
   （`seed user/message at index N message must have role "user"`）→ **这条会话此后再也读不出来**：
   `sessionQuery.readSurface()` 与 `readTitleSnapshots()` 走同一条日志校验，于是分享页显示
   「0 条消息」、标题退回「会话分享」，`session_lookup` 里消息与标题同样为空。

修复：消息形状由导出的 `createRetryUserMessage()` 统一构造，单测直接钉住（含 `id` 每次唯一 ——
inbox 按 `message.id` 去重）。

### 修复（潜伏缺陷 ②：标题从来没渲染过）

`sessionQuery.readTitleSnapshots()` 返回的 `SessionTitleObservation.title` 是
**`SessionTitleSnapshot` 对象**（`{ title, messageSeqs, source, eventSeq, updatedAt }`），不是字符串
（`0.2.1-rc.5` 的 `packages/session-query/session-query/src/index.ts` 即如此）。旧代码按
`typeof value.title === 'string'` 读 → **所有标题都被丢掉**：分享页 h1 永远是「会话分享」、
`session_lookup` 永远显示「（尚未生成标题）」。现在按 0.2.2 的形状取 `value.title.title`
（同时容忍已经是字符串的观察）。

### 验证

- 单测：`npm test` → **106/106**（2.0.3 为 101；新增 5 条：标题对象形状、`source.kind` 过滤、
  无 source 日志的前缀兜底、`createRetryUserMessage` 形状与 id 唯一性、停止后重试的 followup 载荷断言）。
- devkit **web 沙箱** `uib-ui`（web 模板 + headless Chrome；沙箱 `DSH_HOME` 内放真实凭据 store，
  真跑 sub2api/deepseek-flash）：
  - 三个 client 半都进页面清单（`dsh-session-id@2.1.0 is loaded`），**控制台 0 错误**；
  - 「复制会话 ID」→ toast「会话 ID 已复制」（`aria-label="复制会话 ID"` 的 title 即会话 id）；
  - 「分享会话」→ 创建链接 → `GET /share/<token>` 返回 200，页面渲染**标题 + 消息**；
  - 「停止生成」→ 覆盖层按钮 `重试 — 已停止 —— 点击重试` → 点击后 turn 3 正常完成（800 字回答），
    修复前这次重试会被提供方 400 拒掉并显示「模型调用失败」；
  - 修完后重跑「停止 → 重试 → 分享」：分享页标题「地球到月球的平均距离」、5 条消息、
    `time-context` 噪音消失。
- 复现与定位用的原始证据（修复前）：分享页 `0 条消息`；会话日志里
  `user/message seq=36 {"content":[…],"source":{"kind":"user"}}`——**没有 `role` 键**。

## 2.0.2 — 2026-10-28

修「停止后重试」会**弄崩官方消息队列 dock** 的问题（界面报 `slot entry crashed in
'conversation.input.dock'`）。

### 修复

- **`agent.followup()` 的 input 改成完整的 inbox 消息结构**。它会被
  `agent-loop` 原样塞进 `inbox["next-turn"]`（`followup(input) { this.send(input, "next-turn", true) }`），
  而官方的队列 dock（`dsh-client-conversation` 的 `QueueDock`）会把它当"排队中的一条消息"
  渲染，读 `row.id` / `row.content[].text` / `row.source.kind`。原来只传
  `{ content, source: { kind: 'dsh-session-id' } }`：
  - 缺 `id` → inbox 投影按 `message.id` 去重时会拿到 undefined；
  - `source.kind` 不是 `user` → 队列 dock 走非用户分支，读 `source.text` 时崩
    （`Cannot read properties of null (reading 'text')`）。
  现在传 `{ id: <uuid>, content: [...], source: { kind: 'user' } }`，并把
  `source.kind` 统一为 `user`（followup 的语义本来就是"排一条用户消息"）。
- 新增导出 `createRetryMessageId()`（`node:crypto` 的 `randomUUID`），生产唯一消息 id。
- `RETRY_SOURCE_KIND` 保留导出但不再用于 followup（旧的会话记录仍能对上号）。

### 已验证

真机 UI 沙箱矩阵（`model-overlay` 里的 `fake-unreachable` 供应商制造真实
`MISSING_CREDENTIAL` 失败）：

| 场景 | 结果 |
|---|---|
| 模型失败 | 按钮 `waiting`「模型调用失败 —— 点击重试」 |
| 点击重试（闸门） | `user-retry via:"gate"` + `gate-closed reason:"retry"`，原地重跑 |
| 用户停止 | 按钮变「已停止 —— 点击重试」+ `stop-recorded` |
| 停止后重试 | `user-retry via:"followup" outcome:true`，新 turn 启动，**控制台 0 错误** |
| 三行全开 | `[data-turn-retry="hidden"]`；分享/复制按钮都在 |
| 停用 retry 行 | `[data-turn-retry="disabled"]`，无按钮，通道 405 |
| 停用 share 行 | `[data-session-share="disabled"]`，标题栏只剩复制按钮 |
| 停用第一行 | client 半不进页面清单，三块 UI 全部消失 |
| 分享端到端 | 创建 → 公开页 200（CSP 在）→ `?download=1` 返回 attachment → 两段式停止 → 撤销后 404 |

## 2.0.1 — 2026-10-28

修 2.0.0 的组件边界漏洞：**停用「会话分享」或「失败重试」组件后，浏览器半的对应 UI 仍然在。**

### 修复

- **浏览器半新增组件能力探测**。浏览器半是包级一份（`dsh.client` 不能按行拆），只要
  第一行还在它就一定被加载；而 Host 侧的分享/重试是两条独立的 Loader 行，停用后它们
  注册的 RPC 前缀路由不再存在，请求会落到 SPA fallback —— 于是按钮还挂着、点了永远失败。
  现在 client 启动时各发一次探测请求，按 HTTP 状态判定：
  - `200` = 组件在（缺参数的业务信封也是 200）；
  - `405` = 已停用（SPA fallback）；
  - 其它状态与网络异常一律**乐观保留** UI（宁可多一个按钮，也不撤掉正在工作的按钮）。
  探测不阻塞注册、最多退避重试 3 次（400/800/1200ms）。
  - 停用「会话分享」→ 标题栏分享按钮换成隐藏占位 `data-session-share="disabled"`；
  - 停用「失败重试」→ 覆盖层换成隐藏占位 `data-turn-retry="disabled"`。
- `retryHalf` 导出 `RPC_CHANNEL`，探测复用同一个通道名常量（避免字符串写两遍）。
- 两个 UI 贡献的 `inject()` 新增 `hooks: { capability }`。

### 已验证

- 单测 101/101；`node --check client.js` 通过。
- UI 沙箱（tarball 安装）：
  - 三行启用：占位是 `[data-turn-retry="hidden"]`；`diag` 端点返回
    `hasLiveClient=true`、`waitMs=120000`（闸门条件正常，按钮该出现时会出现）；
  - 在 profile patch 里写 `- id: dsh-session-id-retry` + `disabled: true` 并重启：
    修复前同一场景下 `[data-turn-retry="hidden"]`、重试样式表与加载标记**全部还在**
    （复现 bug）；修复后返回 `[data-turn-retry="disabled"]`，按钮不再渲染。

## 2.0.0 — 2026-10-28

**结构性变更**：「一个插件三件事」拆成**三个可单独启停的组件**（三个 Loader 行）。

### 为什么

界面上每个 Loader 行就是一个「组件」，带独立开关。1.x 只有一行，用户只能整体启用/停用
「会话增强」，没法"只留复制 ID、关掉分享和重试"。拆开后「设置 → 插件 → 会话增强 →
包含的组件」显示 **3 个组件**，每个都能单独停用。

### 变更（结构性）

- `cordis.patch.yml` 由 insert 一行改为 **三行**：

  | 行 id | Loader name | 组件 |
  |---|---|---|
  | `dsh-session-id` | `dsh-session-id` | 会话增强（= 会话 ID + 浏览器半） |
  | `dsh-session-id-share` | `dsh-session-id/share` | 会话分享 |
  | `dsh-session-id-retry` | `dsh-session-id/retry` | 失败重试 |

- `index.js` 只保留会话 ID 组件的 Host 半（`session_lookup`）；分享与重试分别搬到
  `share/index.js`、`retry/index.js`。
- `lib/tools.mjs` 拆成 `lib/tools/{lookup,share,schema}.mjs`；`buildTools()` 保留为
  兼容门面（仍一次返回两个工具，行为与 1.x 一致，离线单测零改动）。
- 新增 `lib/build.mjs`：三个组件共用的构建戳。
- 新增 `share/locale/`、`retry/locale/` 与对应 `exports`：组件行的标题/描述来自
  **各自子路径**的 locale——`dsh-app-boot` 的 `readPluginMeta()` 对子路径 specifier
  **不读** `package.json`，只读 `<specifier>/locale/en.json`。
- `exports` 新增 `./share`、`./retry`、`./share/locale/*.json`、`./retry/locale/*.json`、
  `./share/icon`、`./retry/icon`。

### 注意（升级要知道的）

- **浏览器半仍是包级一份**，只能挂在**精确包名**那一行：`dsh-client-modules` 的
  `locatePkgJson()` 对子路径 specifier 直接返回 `undefined`。所以三块界面都挂在第一行
  `dsh-session-id` 上，并因此：
  - 停用「会话分享」→ 分享按钮仍在，点击提示「当前部署没有提供分享服务」；
  - 停用「失败重试」→ 重试覆盖层因 `pending` 调不通而保持隐藏；
  - 停用第一行「会话增强」→ 三块界面一起消失（client 半随该行卸载）。
- 第一行的组件显示名是「会话增强」（与卡片同名），因为它的标题只能来自包根 `locale/`；
  另外两行才叫「会话分享」「失败重试」。
- 从 1.x 升级：`dsh plugin add` 后 patch 自动变三行。旧的 `dsh-turn-retry` 仍需卸载，
  否则会出现两个重试按钮。

### 已验证

- 离线单测 **101/101**（原 97 + 新增 4：三入口形状与 name、各入口注册物、分享存储路径）。
- headless 沙箱真实 Loader：`session_lookup` 与 `session_share` 均可调用（三行都加载成功）。
- UI 沙箱（tarball 安装，非 link）：`dsh-session-id@2.0.0 is loaded: its client half is in
  the page's manifest`；「包含的组件 **共 3 个 · 3 运行中**」，三行标题/描述分别来自包根、
  `share/locale/`、`retry/locale/`；重试覆盖层占位 `[data-turn-retry]` 存在（第三块 UI 注册成功）。
- 拆分经过一次真实返工：最初三行都写成子路径，UI 沙箱直接报 "client half is absent from the
  page's manifest"——这就是上面「精确包名」那条约束的来源。

## 1.0.3 — 2026-10-27

### 变更

- **插件图标改为手绘 SVG，对齐 dsh 官方插件图标的矢量语言**（36×36、透明底、官方蓝色渐变、
  同一描边与留白）：`icon` 与 `files` 里的 `icon.png` 改回 `icon.svg`，旧 PNG 删除；不涉及任何代码逻辑。

## 1.0.2 — 2026-10-27

### 变更

- **插件图标换成 gpt-image-2.5 生成的 PNG 图标**（256×256，圆角透明）：`icon` 与 `files` 里的
  `icon.svg` 改为 `icon.png`，旧 SVG 删除；不涉及任何代码逻辑。

## 1.0.1 — 2026-10-26

修「点击重试按钮没有生效」。

### 修复

- **失败不再静默**：以前点击重试后，只要 Host 返回失败（或传输层报错），浏览器半就只是把
  按钮藏起来 —— 用户看到的是「按钮消失、什么都没发生」。现在按钮进入明确的失败态
  （`data-turn-retry="failed"`），`title` / `aria-label` 里显示错误码（`NOT_WAITING` /
  `NO_LIVE_AGENT` / `FOLLOWUP_FAILED` …），3 秒后自动隐藏。
- **等待期间定期复查**：以前进入「可重试」状态后前端不再问 Host，而 Host 的闸门有
  120 秒等待上限（超时即删除记录）—— 上限过后按钮仍挂在界面上，点击必然无效。现在
  等待期间每 8 秒复查一次，Host 没有闸门就立即收起按钮（上限 20 次 / 160 秒）。
- **Host 侧 `retry` 端点新增兜底路径**：闸门已超时或被清掉、但用户仍然点了重试时，
  不再直接返回 `NOT_WAITING`，而是用 `agent.followup()` 驱动一次新的 turn（按钮只会
  在「失败挂起」或「停止后可重试」两种状态出现，这两种状态下这一轮都已结束，这是唯一
  还能真的重试的路径）；失败时把真实原因透出给界面，而不是吞掉。

### 已验证

- 离线单测 **97/97**（原 95 + 新增 2：闸门已不在时 followup 兜底成功 / 兜底失败透出
  `NO_LIVE_AGENT`）。
- 说明：重试本身的「原地重发」语义没有变（`{ kind: 'retry' }` 交回 agent-loop）；兜底
  路径只在前端状态与 Host 状态不同步时触发。

## 1.0.0 — 2026-10-26

**合并插件**：「失败重试」（原 `dsh-turn-retry`）并入「会话增强」，一个插件三个组件。

### 变更（结构性）

- **新增组件「失败重试」**：模型调用失败（自动重试耗尽）或用户点停止后，composer 右下角
  官方按钮变成圆形「重试」图标；点击后失败路径在**同一 turn/step 原地重新调用模型**
  （不追加用户消息），停止路径用 `agent.followup()` 驱动新一轮。
  - Host 半：`lib/retry/{host,gate,recovery,rpc,diagnostics}.mjs`；
  - 浏览器半：`conversation.input.overlay` 槽位上的 34×34 覆盖层（IIFE 隔离作用域并入
    `client.js`）；
  - 闸门语义保留：先 `await next()` 问下游自动重试、放弃时不调 `next()`、120 秒等待上限、
    5 秒孤儿保护、非 root Agent / 无活跃客户端 / 已 abort 都不挂起；
  - 重试 RPC 通道保留旧名 `/dsh-turn-retry`（仅插件内部，避免无谓回归）。
- **`dsh-turn-retry` 插件已删除**：本地目录、profile 行与 GitHub 仓库都不再存在。
  升级本插件前请先卸载旧的 `dsh-turn-retry`（`dsh plugin remove dsh-turn-retry`），
  否则会出现两个重试按钮。
- 插件描述/显示名/locale 更新为三组件（会话 ID、会话分享、失败重试）。

### 已验证

- 离线单测 **95/95**：原 47（会话/分享）+ 并入的 48（闸门状态机含孤儿保护、恢复记录 TTL、
  RPC 信封与两条重试路径、`installTurnRetry` mock-ctx 集成）。
- headless 真实 Loader：会话查询/分享失败降级仍通过；重试闸门在无活跃客户端时 fail-closed。
- UI 沙箱真实浏览器：标题栏分享/复制按钮 + 分享对话框全流程仍通过；重试覆盖层在无失败态时
  为 `[data-turn-retry="hidden"]` 隐藏占位（证明第三个组件注册成功），composer 正常。

## 0.2.0 — 2026-10-26

会话增强。

### 新增

- **会话分享**（参考 DeepSeek 网页版的会话分享）：
  - 浏览器半：标题栏新增「分享会话」按钮（复制按钮左侧），对话框内可创建链接、复制、
    打开、下载单文件 HTML、两段式停止分享；
  - Host 半：免登录只读路由 `GET /share/<token>`——24 字节随机 token、每次请求现读
    会话日志（撤销即 404）、严格 CSP、页面不含会话 id / cwd / token / 工具参数；
    `?download=1` 存成单文件 HTML 直接发给别人；
  - 认证 RPC 通道 `/dsh-session-id`（`connection.admit` 校验）：`share.status` /
    `share.create` / `share.revoke`；
  - 新工具 `session_share`（create / status / revoke / list）：让 Agent 在用户明确要求
    时也能分享；描述里写明"只在用户明确要求时调用"；
  - 分享记录存 `<DSH_HOME>/dsh-session-id/shares.json`，只存
    `{ sessionId, createdAt, includeDescendants }`，不存会话内容。
- **插件显示名改为「会话增强」**（`meta.title` 与 locale）。包名 / 仓库名保留
  `dsh-session-id`，避免已有安装路径与链接失效。

### 修复（真实回归暴露）

- `share.create` 在拿不到分享地址时先写记录再报错，会留下打不开的孤儿分享；现在先校验
  origin 与会话存在性，再落盘。
- `shares.json` 带 UTF-8 BOM（Windows 编辑器 / `Set-Content` 常见）时被当作损坏文件，
  导致分享功能整体拒绝写入；现在读取时容忍 BOM。

### 已验证

- 离线单测 47/47：新增分享存储（幂等/撤销/持久化/损坏文件/BOM）、HTML 转义、分享视图、
  `session_share` 全流程、`presentShare` 拼 URL、公开路由 token 解析。
- headless 真实 Loader：`session_share` 在无 web server 的部署里返回结构化失败（不崩）；
  `session_lookup` 与真实子代理发现仍通过。
- web 沙箱真实 HTTP 端到端：`share.create` → 公开页 200（约 4.5 KB，含消息与只读徽标）→
  下载返回 `attachment` 文件名 → 未知 token 404 → `POST` 405 → 撤销后再访问 404；
  CSP 头存在。
- UI 沙箱真实浏览器（沙箱 Web GUI + 无头 Chrome，真实鼠标事件）：分享按钮 28×28 位于复制
  按钮左侧 → 打开「分享会话」对话框 → 「创建分享链接」得到真实链接（origin + `/share/` +
  32 位 token）→ 「复制链接」toast「链接已复制」→ 两段式「停止分享 / 确认停止分享」→ 回到
  未分享态并 toast「已停止分享」；分享期间 `fetch(url)` 返回 200（标题「会话分享」），撤销后
  同一 url 返回 404；全程控制台 0 错误。
- **说明**：分享页 HTML 里若出现会话 id，是消息正文本身包含它（用户/助手在对话里写了 id），
  不是模板渲染泄漏；`cwd`、token、工具参数均不进入页面。
- 已知限制（写进 README）：分享页需要部署可被访问（DSH 默认只监听 `127.0.0.1`；局域网用
  `--host`，公网需反代/内网穿透/`--public-url`）；离线分享用「下载 HTML」；暂无口令与有效期。

## 0.1.2 — 2026-10-25

### 变更

- **撤回** 0.1.1 的「提交作者邮箱改用 GitHub noreply 地址」做法：开源不改变作者身份，
  真实提交邮箱本来就在账号公开 profile 上，脱敏属于多此一举。仓库历史已重写——全部提交的
  author/committer 邮箱恢复为当时的真实邮箱（作者名与提交日期不变，文件树零变化；该地址已从
  本仓库历史与本文档中移除），并强推 `main`；本地 `user.email` 也不再覆盖为 noreply。
- 纯提交元数据/文档改动，无代码行为变化。

## 0.1.1 — 2026-10-22

开源（MIT）。

### 变更

- 许可证：`UNLICENSED` → `MIT`，补 `LICENSE` 文件，仓库转为公开。
- 公开前脱敏：移除 README 里的本机绝对路径与开发工具名；移除测试辅助文件里对内部
  开发工具/文档的引用；提交作者邮箱使用 GitHub noreply 地址。
- 无代码行为变化。

## 0.1.0 — 2026-10-22

首个版本。

### 新增

- **浏览器半**：会话标题栏 `conversation.session.header.utilities` 槽位新增「复制会话 ID」
  按钮（`order: -10`，落在「⋯」左边）。点击写入剪贴板并弹 toast；`navigator.clipboard`
  被拒时降级到 `document.execCommand('copy')`，两条都失败才提示失败。中英文词典齐备。
- **Host 半**：新工具 `session_lookup`，按会话 id 返回标题、工作区、预设、父级链、
  全部子代理（父在前、带 depth / parentId）、最近消息与继承事件数。省略 `sessionId`
  时查当前会话；失败（找不到 / 缺服务 / 空 id）与成功返回同一形状，均通过自身 output
  schema 校验。
- 零 npm 依赖、无 Config、无设置页；`cordis.patch.yml` 在根作用域 insert，任何模式
  都可用。

### 已验证

- 离线单测 28/28：严格 JSON-Schema 子集、`required` 覆盖全部 `properties`、返回值按
  自身 schema 校验、消息角色过滤、血缘拍平、失败分支形状。
- headless 沙箱（真实 Loader）：
  - `session_lookup`（无参数）识别当前会话、标题缺失、无子代理；不存在 id 返回可读失败；
  - 用 `subagent` 真的派生一个子代理后，无参数调用在 `subagents` 里发现它（depth 1），
    再用子代理 id 反查得到 `role=subagent`、`parentSessionId` 指向父会话、祖先链正确。
- 首轮 headless 回归暴露两个真实问题并已修复：一是消息里混入 2700+ 字符的 system 指令，
  二是每轮注入的 runtime context / system-reminder 以 user 角色占满列表。现在按角色与
  注入前缀双重过滤，实测「4 条消息里 3 条噪音」降为只留真实用户消息。
- UI 沙箱（web template，真实非 blank 会话）：
  - 插件客户端半进入页面清单（notes 原文 `client half is in the page's manifest`），
    控制台 0 条错误；
  - 按钮真实渲染：`<BUTTON>` 28×28、可见，位于「⋯」左侧；
  - 真实鼠标点击后 toast「会话 ID 已复制」出现并位于标题栏下方中央；
  - 失败路径：强制 `navigator.clipboard.writeText` reject 且 `document.execCommand('copy')`
    返回 false 后点击，toast 显示「复制失败，无法写入剪贴板」；
  - 两条路径的截图均已目视确认（标题栏按钮位置 + 成功 toast）。
