# Changelog

本插件的改动都记在这里；版本号遵循 `.` 分段语义（大版本 = 结构性/破坏性，中版本 = 新能力，
小版本 = 修复与文档）。

## 5.3.2 — 2026-11-14

### 修复：免登录分享页在 DSH 0.2.2-rc.3 上会被认证拦掉

DSH 0.2.2-rc.3 给 `webServer.register({ kind, path, handler })` 加了 `auth` 字段，
**默认 `'required'`**：没有已认证 Peer 的请求会在**进入 handler 之前**被拒（无人决策
时 503）。依据：

```ts
// packages/host/webserver/src/index.ts:123-124
/** Defaults to required. Anonymous handlers may receive no Peer. */
auth?: WebAuthenticationRule
// :780-788
private authPolicy(auth, request) { return typeof auth === 'function' ? auth(request) : auth ?? 'required' }
… ?? (policy === 'anonymous' ? { kind: 'allow' } : { kind: 'deny', status: 503 })
```

`lib/public.mjs` 的 `GET /share/<token>` 是**免登录只读**路由（分享给没有 DSH 账号的人），
之前没写 `auth`，于是在 rc.3 上分享链接会在 handler 之前被拒 —— 分享功能整体失效。

**修法**：给这条路由显式加 `auth: 'anonymous'`。

- 匿名只免除**凭据**验证；Connection 的**来源**检查（Host/Origin 栅栏对匿名路由同样生效，
  `packages/client/connection/src/rpc-host.ts:87-95`）保持不变，所以安全语义没有放宽到
  "任何来源都收"。
- 三条有副作用的 RPC 通道（`/dsh-session-enhance`、`/dsh-session-enhance-retry`、
  `/dsh-session-enhance-context`）**保持默认 `required`**，没有顺手改成匿名。
- **向后兼容 rc.2**：已核对本机安装版 `app.asar` 里的
  `dsh-host-webserver/src/index.ts:445-452` —— `register()` 只做重复检查与
  `table.set(path, route)`，不读 `auth`，所以多写这个键在旧运行时上静默无害，
  不需要 feature-detect。

### 核对过但**未改**的部分（目标版本未变）

- `connection.admit()` 与 `PeerAdmission`（`{peer}` | `{rejection: 401|403|503}`）形状未变
  （`packages/client/connection/src/rpc.ts:121-123,225`），三条 RPC 通道里的双保险照旧。
- 分级压缩/按需修剪依赖的落库 API 未变：`session.append(type, data, opts)`、
  `session.eventAt` / `deriveEventMessage` / `surface.nodes` / `requestContext` /
  `requestHeader`（`packages/core/session/src/index.ts:562,745,809,1007,1028,1108`）、
  `agents.turnBoundaryOf(session).openTurnStartSeq`、`pruner.pruneContent`、
  `tokenMeter.measure|estimateMessage`。**本次不动压缩/修剪的落库逻辑**。
- 工具/服务面：`tools.register(definition)`、`settings.configure({auto}, fiber)`、
  `sessionQuery.traceSession|readSurface|readTitleSnapshots`、`sessions.get|flush`、
  `subagents.listDescendants|sendMessage`、`agents.get`、`compaction.compactNow|compactIfNeeded`、
  `commands.execute`、`webServer.getOrigin`、`webApp.getAdvertisedUrl` 全部仍在。
- `ctx.on(..., { prepend: true })` 仍在（`vendor/cordis/src/events.ts:111-118`）；
  无 `ctx.root` 用法；`ctx.get()` 仍返回 `undefined` 而非抛错。
- 浏览器半：`window.__ModuleLoader__.load` 入口不变；`@deepseek-ai/dsh-client-ui-primitives`
  的 `Button`/`Modal`/`Switch`/`Toast`/`SettingsForm`/`SettingsFormModel`（含 `bind`）仍在；
  四个槽位名（`conversation.session.header.utilities`、`conversation.input.right`、
  `conversation.input.left`、`plugins.bundle.config`）、`configForms.get|whileServed`、
  `connection.rpc.call`、`sessions.binding` 仍在；样式用自有 `data-dsh-enhance-*`
  选择器并在 dispose 时 `style.remove()`，不依赖 `data-plugin-css` 或生成的 CSS Module 类名。
- `agentTeams.listMembers` / `agentTeams.sendMessage` 早已在 rc.2 移除（本插件按
  `typeof === 'function'` 存在性兼容，rc.2 形状下 teammate 由 `subagents` 通道恢复），
  本次无需改动。

### 验证

`node --test` **150/150** 通过（新增 `test/routes.test.mjs` 3 例：分享页匿名声明、
分享 handler 自身仍只认 token、三条 RPC 通道保持 `required`）。真实 Loader 回归由
统一适配流程在目标版本运行时执行。


## 5.3.1 — 2026-11-13

修两个真实事故暴露的缺陷。**前者会写坏会话日志，后者会让「日志坏了」看起来像「会话是空的」。**

### 修复 1：修剪落在开放 turn 之外 → 会话日志被判 corrupt（数据损坏）

`lib/compact/host.mjs` 的按需修剪自己 append surface 替换事件：

```js
session.append('compaction/prune', { shadowedSeqs: [seq], ... });
session.append('tool/result', { ...event.data, message },
  { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
```

但没有检查**当前是否有开放的 turn**。DSH 的重放校验器对 surface 替换有硬规则：

```
if (openTurn === null) throw new SessionFormatError('tool/result replacement is outside an open turn')
```

于是只要修剪发生在 `turn/end` 之后（手动压缩 / `/compact`、或 turn 刚被用户取消的尾巴），替换事件就落到 turn 之外，**整份日志永久损坏**：`readSession` / `readSurface` 全部失败，会话历史读不出来，会话也无法冷恢复。

**真实事故（2026-11-13）**：会话 `session-61fde2b3…` 在用户取消 turn 11 之后跑压缩，7 对 prune+replace 落在 `turn/end` 之后（seq 428–441），整份日志被判 corrupt。

**修法**：新增 `isTurnOpen(agent)`，用官方投影 `agents.turnBoundaryOf(session).openTurnStartSeq` 判断；**turn 不开放时一律不剪**（按需路径与官方全量回退都不走，因为两者都 append surface 替换）。服务缺失（老版本 / 离线测试）时回退为「允许」，保持旧行为。

### 修复 2：`readSurface` 失败被静默吞掉 → 历史损坏伪装成「会话为空」

`lib/service.mjs` 的 `lookupSession` 原本 `catch { messages = []; }` —— 错误丢了，用户只看到「没有可读的语义消息」，会以为历史没了。

**修法**：把失败原因带进摘要——`⚠️ **读取会话表层失败**：<原始错误>`，并明确写「这**不是**『会话没有内容』——事件还在磁盘上，但当前读不出来」。表层读取成功但确实没有语义消息时，仍用原来的「可能为空」措辞。两种情形可区分。

### 验证

离线单测 **126/126** 通过。新增回归：

- `turn 已关闭时拒绝修剪`（一条事件都不写、也不回退官方全量修剪）
- `手动修剪 pruneAll 在 turn 已关闭时停手并标记 skippedOutsideTurn`
- `turn 开放时正常修剪`（守卫不误伤）
- `agents 服务缺失时保持旧行为`
- `表层读取失败必须把错误说出来，不能伪装成「会话为空」`
- `表层读成功但无消息时仍用「可能为空」措辞`

### 已知边界

- 本版只**防止**再次写坏，不自动修复已经损坏的日志。已损坏的会话用 `scripts/repair-session-log.mjs` 修（四道门禁、默认 dry-run、`--apply` 才写并先备份）。
- 修剪被跳过时压力仍在，下一次请求可能再次触发；这是有意的——宁可这次不压，也不能写坏日志。

## 5.3.0 — 2026-11-13

### 行为变化（用户需要知道的一条）：`autoCompact` 关闭 = **交还官方自动压缩**

5.2.0 及以前，关闭 `autoCompact` 时插件的守卫会对官方的主动压力压缩返回 `null`，等于
**把官方 80% 的兜底也一起关掉了**，只剩 L3（请求被提供方拒绝后才救）。这是「装插件 +
开关关着」这个中间态最危险的地方：用户以为「维持原样」，实际是「没有任何主动压缩」。

5.3.0 起守卫改成三态仲裁：

| 情形 | 行为 |
|---|---|
| 非 `pressure`（溢出恢复 / 手动 / 切模型） | 原样转发（安全网永不拦） |
| `pressure` 且**关闭** `autoCompact` | **转发给官方**（关 = 没装插件） |
| `pressure` 且**打开** `autoCompact`，调用方是官方监听 | 返回 `null`（插件独占，避免同一窗口压两次） |
| `pressure` 且**打开** `autoCompact`，调用方是本插件 | 放行 |

顺带修掉一条更隐蔽的双压缩：以前开关打开时，插件 `prepend` 先压一次、官方 pre-step 监听
随后**又**调一次 `compactIfNeeded`；当官方阈值低于插件阈值（小窗口）时同一请求窗口会压两次。

### 修复

- **R7：手动压缩不再「先剪后失败」。** 以前 `pruneAll` 在**还不知道有没有可压缩范围**之前
  就执行：对一个没有可压缩历史的会话点压缩，会永久剪掉工具结果中间段、然后返回 `NO_RANGE`
  ——压缩没发生，损失发生了。现在只有压力达到 L1 阈值才修剪（`pruneIfNeeded`），跳过时
  结果里带 `pruneSkipped: true` + `pruneReason`。
- **R9：分享页不再把机器摘要伪装成用户发言。** 压缩检查点落地的是 `user/message`
  （`source.kind === 'compact-checkpoint'`），以前会以 `user` 角色出现在分享页。现在映射成
  `summary` 角色，并剥掉「This is an automatically generated checkpoint…」引导语与
  `<compacted-summary>` 标签（`messagesOf` / `checkpointTextOf`）。
- **R4：阈值公式与官方逐字对齐。** 以前是 `窗口 − 输出预留`，官方是
  `min(窗口 × 比例, 窗口 − 预留 − headroomTokens 65536)`。1M 窗口下两者恰好相等，但小窗口
  下官方会在 ~54k 就压、旧公式要等到 ~96k（等于接管后把兜底阈值推后了）。窗口小于压缩余量
  时返回 `NO_PRESSURE_BUDGET`（官方在同样配置下抛 `TargetPressureConfigError`，不压缩）。

### 新能力

- **按需修剪（L1 从新到旧，省够就停）。** 以前 `pruneSession` 会把**所有**超预算工具结果
  一次换掉，包括很早的节点——表层替换会让从第一个被替换 token 起的前缀缓存全部失效，等于把
  断点推到最前面。现在从新到旧剪、省够目标就停；前提缺失（自定义 pruner / 无 tokenMeter）时
  自动回退官方全量修剪。替换协议与官方一致（`compaction/prune` 影子价格 + `surface.replace`
  + `sourceEventSeqs`）。
- **`pruneRatio` / `compactRatio` 可配**（volatile，改后热更新）。设置页仍只有「自动压缩」开关；
  两个比例通过 profile 补丁设置，例如
  `- id: dsh-session-enhance` + `config: { pruneRatio: 0.7, compactRatio: 0.85 }`。
- **决策可见**：`get` RPC 新增 `lastDecision` / `lastPruned` / `headroomTokens`，动作行
  tooltip 直接显示「最近一次决策：none（AUTO_OFF）」这类信息——「为什么这一轮没压」终于有答案
  （`AUTO_OFF` / `NO_MEASUREMENT` / `NO_WINDOW` / `NO_PRESSURE_BUDGET` / `BELOW_PRUNE_RATIO` /
  `NO_PRUNER` / `NO_COMPACTION` / `BREAKER_OPEN`）。

### 用户需要做什么

- **无需改配置。** 但如果你此前**故意**用「关掉开关」来禁用一切自动压缩：现在关掉开关等于
  交还官方（官方会在 80% 自动压缩）。想彻底不压，需要停用本插件的压缩行或把官方的
  `compaction-basic` 设为 `auto: false`。
- 升级包并**重启 DSH**（client 清单是服务器启动时的快照）。

### 验证

- 单测 **142/142**（新增：仲裁器三态、`pruneIfNeeded` 跳过/执行、按需修剪新到旧与「省够即停」、
  官方公式对齐（1M / 128k 两组）、`NO_PRESSURE_BUDGET`、检查点 → summary 角色与去标签、
  `lastDecision` / `AUTO_OFF`、Config 三个 volatile 字段）；
- `node --check` 通过（index.js / client.js / 三个 lib 文件）；
- devkit headless 沙箱真实 Loader，两组强制低阈值回归：
  - **开**（`autoCompact:true` + `pruneRatio:0.0001`）：会话日志出现 **2 条 `compaction/prune` +
    2 条 `surface.replace`**，被剪的工具结果里出现官方 `[... tool result middle pruned ...]` 标记，
    `compaction/summary` = 0（L2 阈值故意留在 0.99）——证明按需修剪在真实 Loader 里真的执行；
  - **关**（`autoCompact:false` + 官方 `thresholdRatio:0.0001`）：出现 `compaction/start` 与
    `compaction/end`（end 带 `error: summary is not smaller than the shadowed content`，是这个极端
    阈值下官方安全网的预期拒绝）——证明守卫在关闭时**转发**给了官方，而旧版本这里返回 `null`、
    根本不会出现 compaction 事件；
- devkit web/UI 沙箱：`dsh-session-enhance@5.3.0` client 半进页面清单、控制台 0 错误、详情页
  显示 v5.3.0、自绘设置卡「自动压缩」正常渲染。

## 5.2.0 — 2026-11-13

### 新能力：第三个组件「中断重试」（补官方「继续生成」不覆盖的主动停止）

DSH 0.2.2-rc.2 官方的「继续生成」只在**失败**后可继续（`turn/end` 的 `reason.kind === 'error'`，
且错误码属于 RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE / STREAM_CLOSED，并且
有已准入的用户工作）；用户主动点「停止」的一轮是 `aborted`，官方不给入口。5.2.0 新增独立组件
「中断重试」补这个空缺。

- **新 Loader 行** `dsh-session-enhance-retry`（name `dsh-session-enhance/retry`，显示名
  「中断重试」）：Loader 行从 2 行变 3 行，可单独启停；
- **RPC 通道** `/dsh-session-enhance-retry`（端点 `pending` / `retry` / `diag`）；
- **事件判定**：监听 `session/event`，`turn/end` 且 `reason.kind === 'aborted'` 且
  `reason.reason.kind === 'user'` 时记录「可重试」；`turn/start` 或新的用户消息到来即作废；
- **记录只在内存里，TTL 30 分钟**：中断后没人点就过期；Host 重启后记录丢失（需重新触发一次停止）；
- **界面入口**：composer 右侧的「重试」按钮（槽位 `conversation.input.right`，主按钮之前，
  **不遮挡**官方的发送 / 「继续生成」按钮），三态 `ready` / `busy` / `failed`，选择器
  `data-interrupted-retry`；
- **点击后的语义**：Host 用 `agent.followup()` 发一条中性 user 消息（「上一轮被用户中断。
  请从中断处继续完成，不要复述已完成的部分。」）驱动**新的一轮**——历史里会多这条消息，
  不是原地重试；
- **与官方分工**：官方 = 失败，本组件 = 中断（`aborted` + 用户主动停止），两者互斥、不会对
  同一轮同时出现；失败永远交给官方；
- 组件停用后浏览器半的能力探测返回 405，按钮换成隐藏占位（`data-interrupted-retry="hidden"`）。

### 用户需做什么

- **无需改配置**；升级包并**重启 DSH** 生效（client 清单是服务器启动时的快照，刷新页面不够）；
- 注意 `- id: dsh-session-enhance-retry` 在 5.0 被移除后于 5.2 重新用于本组件：profile 补丁层
  里留着的 `disabled: true` 现在表示停用「中断重试」（想启用就删掉该行）。

### 验证

- 单测 **130/130**（新增 `test/retry/*` 21 例 + entries 三入口 1 例）；
- `node --check client.js` 通过；
- devkit headless 沙箱真实 Loader：合成树 3 行（`dsh-session-enhance` / `-share` / `-retry`），
  任务正常完成（logger 不落 stderr，行激活证据由 UI 沙箱提供）；
- devkit web/UI 沙箱：`dsh-session-enhance@5.2.0 is loaded`、控制台 0 错误、
  `[data-interrupted-retry]` 隐藏占位存在（槽位注册成功）、详情页「包含的组件
  共 3 个 · 3 运行中」（会话增强 / 会话分享 / 中断重试）、当前版本 5.2.0；
- web 沙箱（真实 HTTP）：页面内 `POST /dsh-session-enhance-retry/pending` 返回 200 业务信封
  `{pending:false,recoverable:null}`。

## 5.1.0 — 2026-11-12

### 行为变化：移除标题栏「恢复子智能体」按钮（工具保留）

「恢复子智能体」不再有界面入口，恢复只能由模型调用工具 `session_resume_subagents` 完成。

- **移除标题栏按钮**：`conversation.session.header.utilities`（order -12）上的「恢复子智能体」
  覆盖按钮删除——父会话不再显示「恢复子智能体（N）」，子会话也不再显示「恢复本子智能体」；
- **移除浏览器半 RPC 通道** `/dsh-session-enhance-subagent`（Host 侧 `installSubagentChannel`
  一并删除），浏览器端的 `list` / `resume` / `diag` 端点不再存在；
- **界面选择器消失**：`data-session-resume`；
- **词典删除**：`resume.*`（`button` / `self` / `busy` / `done` / `partial` / `failed` /
  `parentOffline` / `none`）；
- **保留且行为不变**：模型工具 `session_resume_subagents`（参数与 `dryRun` 语义不变）、
  `lib/subagent/host.mjs` 的 `createSubagentHandler`；`session_lookup`、复制会话 ID、
  会话分享、分级上下文压缩均不受影响。

### 用户迁移

- **无需改配置**：Loader 行仍是 2 行、没有 profile 补丁变化、没有新增/删除设置项；
- 需要恢复子智能体时，让 Agent 调用工具即可（例如「用 `session_resume_subagents` 先 `dryRun`
  列出离线子代理，再恢复它们」）；
- 浏览器半随包更新后旧按钮自动消失；若仍看到按钮，重启 DSH / 刷新页面（client 清单是
  服务器启动时的快照）。

### 验证

- 单测 **108/108**（`SUBAGENT_RPC_CHANNEL` 常量用例改写为「恢复文案稳定」，计数不变）；
- `node --check client.js` 通过；
- devkit headless 沙箱真实 Loader：合成树仍 2 行，`session_resume_subagents`（`dryRun`）
  实调返回「子智能体共 0 个，可恢复 0 个」；
- devkit web/UI 沙箱：`dsh-session-enhance@5.1.0 is loaded`、控制台 0 错误、页面无
  `[data-session-resume]`、详情页「包含的组件 共 2 个 · 2 运行中」、当前版本 5.1.0
  （web 沙箱无可用模型、未能创建会话，标题栏按钮未实操；静态确认分享/复制槽位注册仍在）。

## 5.0.0 — 2026-11-12

### 破坏性变更：移除「失败重试」组件

DSH 0.2.2-rc.2 官方已内置失败恢复，本插件不再自带重试，因此这是 major。

- **Loader 行从 3 行变 2 行**：`dsh-session-enhance-retry` 行移除，只剩
  `dsh-session-enhance`（会话增强）与 `dsh-session-enhance-share`（会话分享）；
- **`exports` 移除** `./retry`、`./retry/locale/*.json`、`./retry/icon`；
- **RPC 通道 `/dsh-turn-retry` 消失**（含 `pending` / `retry` / `diag` 端点）；
- **界面选择器消失**：`data-turn-retry`、`data-dsh-turn-retry-button`，composer 里不再有
  重试覆盖层；
- 删除模块：`retry/index.js`、`retry/locale/`、`lib/retry/*`、`test/retry/*`；
- 保留且行为不变：会话增强（复制会话 ID、`session_lookup`、`session_resume_subagents`、
  分级上下文压缩）、会话分享。

### 为什么移除

- 官方 composer 的 `retry(failureSeq)` 与会话 API 的 `conversationContinuation` 投影已经覆盖
  「失败后继续」：空 `prompt.content` 在 queue 模式下会为符合条件的失败空闲会话开新一轮，
  并记录一条 `source.kind: 'retry'` 的空 user 消息，用户可见文案是「继续生成」
  （`input.continue`）；
- 再维护一套覆盖层 + `agent/request-error` 闸门 + 独立 RPC，只会和官方按钮抢位置、多一层
  状态机与回归面，没有净收益。

### 用户迁移（必须做）

1. 删除 profile 补丁层里指向已移除行的 override：

   ```yaml
   - id: dsh-session-enhance-retry
     disabled: true
   ```

   该 Loader 行已不存在，**整条删掉**（不是改名）。
2. 更新 / 重装插件并执行 `pnpm install`；
3. **重启 DSH**（client 清单是服务器启动时的快照，刷新页面不够）。重启后
   「设置 → 插件 → 会话增强 → 包含的组件」只剩 **2 个**（会话增强 / 会话分享）。

### 边界

官方「继续生成」只覆盖**失败**，不覆盖**用户主动停止**；官方的继续是新一轮（历史里多一条
`source.kind: 'retry'` 的空 user 消息），不是 4.x 的原地重试。`CONTEXT_WINDOW_EXCEEDED`
是确定性失败，重发只会再次超长，请用压缩能力（自动 / 手动分级压缩）处理。

### 验证

- 单测 **108/108**（原 167；`test/retry/*` 58 条 + `test/entries` 1 条，共 59 个用例随组件删除）；
- devkit headless 沙箱真实 Loader：合成树只剩 2 行 Loader 行（`dsh-session-enhance` /
  `dsh-session-enhance-share`）、`session_lookup` 实调返回当前会话摘要；
- devkit web/UI 沙箱：`dsh-session-enhance@5.0.0 is loaded`、控制台 0 错误、页面无
  `[data-turn-retry]` 且 `dataset.dshTurnRetry` 为 undefined、详情页「包含的组件
  共 2 个 · 2 运行中」（会话增强 / 会话分享）、当前版本 5.0.0。

## 4.6.1 — 2026-11-12

### 修复：适配 DSH 0.2.2-rc.2（恢复子智能体列举在 rc.2 静默失效）

- **`ctx.agents.roots()` 在 0.2.2-rc.2 被移除**（同批移除 `isOwnedBy()`，`enter(agent, owner)`
  改为 `enter(agent)`）：重试闸门用它判断「只给根会话显示重试按钮」，有 `typeof` 守卫不会崩，
  但 `rootsIncludes` 恒为 `null` → `not-root-agent` 否决失效，子代理会话也会出现重试按钮。
  新增 `detectRootAgent()` 按三代信号回退：`agents.roots()`（rc.1）→
  `subagents.rootOf(agent) === agent`（rc.2：rootOf 返回 agent 所在子智能体树的 live root）→
  会话头 `origin !== 'subagent'`（两服务都缺时兜底；fork 会话的 `parentSession` 有值但
  `origin` 不是 subagent，仍算根）。`diag` 的探测快照新增 `rootProbe`（`via` 字段说明走哪一代）。
- **`subagents.listChildren()` 在 0.2.2-rc.2 被移除**，服务上只剩
  `listDescendants(rootSessionId)`（递归返回全部后代，每行带 `depth` 与
  `kind: 'child' | 'diagnostic'`）。「恢复子智能体」的列举原来只在
  `typeof listChildren === 'function'` 时执行——rc.2 下该守卫直接跳过，整条列举路径
  永远返回空，标题栏按钮再也不出现。现在新增 `listDirectChildren()`：优先
  `listDescendants` 并过滤 `kind === 'child' && depth === 1`，再回退旧 `listChildren`。
- **Team 服务在 0.2.2-rc.2 只剩任务板**：`agentTeams` 只暴露
  `isEnabled` / `setEnabled` / `createTask` / `getTask` / `listTasks` / `updateTask`，
  `listMembers` / `sendMessage` 已移除，teammate 就是普通 subagent。列举与恢复改走
  `subagents` 通道；rc.1 的 legacy team 路径按存在性保留兼容。子会话恢复自身时
  `kind` 归为 `subagent`，名字取自父会话 catalog。
- `diag` 端点新增 `subagentListing`（`listDescendants` / `listChildren` / `none`），
  升级后可直接看出走的是哪一代列举 API。
- **运行时上下文过滤**：补 rc.2 精确文本的单测（`<system-reminder>` 包装的首份快照、
  后续快照、`Current runtime context: none.` 清空提醒），并给 rc.1 未包装的清空提醒
  补 `Current runtime context:` 冒号前缀兜底（原前缀是句号，匹配不到）。
- 工具 schema 文案更新：`kind` / `name` 说明 0.2.2-rc.2 起 teammate 就是 subagent。

### 已核对、无需改动

- `session-append-overloads`：本插件不包装 / 替换 `Session.append`（全仓无 `.append =`），
  不涉及。
- `attachment-error-codes`：重试规则只把 `CONTEXT_WINDOW_EXCEEDED` 当确定性失败否决，
  没有把 `UNKNOWN` 当兜底类别；`summarizeFailure` 原样透传 `failure.code`，所以
  `ATTACHMENT_*` / `INVALID_IMAGE` / `IMAGE_TOO_LARGE` 会正常显示，无需 `isAttachmentError`。
- `interrupt_agent` 默认关闭 / Team 工具新形态：本插件文档未教用户使用
  `spawn_teammate` / `interrupt_agent` 等旧工具名，仅概念性提到 teammate。
- `web-search-billing`、`plugin-update-method`（`BundleInfo.updatable`）、
  `package-export-cleanup`、`window-drag-regions`：与本插件无关（后两项已逐个确认）。

### 验证

- 单测 **167/167**（新增 rc.2 服务形状、runtime-context 与 rc.2 判根用例）。
- devkit headless 沙箱真实 Loader 回归（见 README「验证记录」4.6.1 行）。

## 4.6.0 — 2026-11-11

### 新能力：熔断、多级预警，响应式压缩与开关解耦（对齐 Claude Code 五级压缩）

参考 Claude Code 的五级渐进式上下文压缩（Snip → MicroCompact → Context Collapse →
AutoCompact → Reactive Compact）补齐 4.5 的工程缺口：

- **自动压缩熔断**：连续 3 次摘要失败后暂停主动自动压缩（L2），避免「每步重试、
  一轮几十次失败调用」——真实事故里一个会话曾因此打了 160 次失败的摘要请求。
  熔断在下一轮（agent idle）重置；手动压缩成功或溢出恢复成功也会清零。
- **响应式压缩（L3）与开关解耦**：`autoCompact` 关闭时仍处理
  `CONTEXT_WINDOW_EXCEEDED`（先压缩再重试，错误扣留），与 README 里「L3 是安全网」
  的说法一致；每轮最多一次。
- **多级预警**：官方「上下文已用」面板的动作行在压力 ≥ 有效窗口 90% 时显示
  「上下文即将用尽」；熔断打开时显示「自动压缩已暂停」，title 给出失败次数与重试方式。
- `get` 端点新增 `warningRatio` / `effectiveWindow` / `autoFailures` / `breakerOpen`；
  手动压缩成功后重置熔断并刷新面板状态。

### 与 Claude Code 五级压缩的对照（README 有完整表）

| CC | 本插件 / DSH |
|---|---|
| Snip 历史剪除 | 未实现：DSH 表层只能替换不能删除，直接写事件会绕过 compaction seam |
| MicroCompact 微压缩 | L1：官方 `toolResultPruner` 批量修剪（压力 ≥ 60%） |
| Context Collapse 上下文折叠 | 未单独实现：DSH seam 只有摘要替换；官方 `compactIfNeeded` 本身即「摘要最旧范围 + 保留近期尾部」 |
| AutoCompact 自动压缩 | L2 + 4.6 熔断；摘要提示词与压缩后回填由官方后端决定，本插件不改 |
| Reactive Compact 响应式压缩 | L3：`CONTEXT_WINDOW_EXCEEDED` 恢复，4.6 起与开关解耦、每轮一次 |

### 验证

- 单测 **156/156**：新增熔断（3 次失败→暂停→下一轮重置）、成功清零、溢出恢复在
  `autoCompact` 关闭时仍介入、`statusFor`/`effectiveWindowFor`、`get` 新字段。
- `node --check` 通过；README 补充五级对照与未实现项的原因。

## 4.5.0 — 2026-11-11

### 新能力：分级上下文压缩（自动 + 手动，批处理单次断点）

参考 Claude Code 的分级压缩与 `dsh-ebbing-context` 的「批处理（一次性断点）」原则，把
4.1–4.3 的单一手动压缩改造成三级机制：

- **L1 微压缩**：压力 ≥ 有效窗口的 60% 时，调用官方 `ctx.toolResultPruner.pruneSession(session)`，
  一趟扫描把**所有**超预算工具结果一起替换——不调用模型。
- **L2 深度压缩**：压力 ≥ 80% 时，调用官方 `ctx.compaction.compactIfNeeded(agent, 'pressure', signal)`：
  它先修剪全部可剪工具结果、再摘要最旧范围，两者在**同一个压缩事务**里完成（一次
  `compaction/start` … `compaction/end`，只换一次表层）。L1 与 L2 在同一次 `agent/pre-step`
  内完成，下一次请求看到最终表层 ⇒ **只断一次前缀缓存**。
- **L3 溢出恢复**：提供方返回 `CONTEXT_WINDOW_EXCEEDED` 时调用
  `compactIfNeeded(agent, 'context-overflow', signal)`，表层前进后返回 `{kind:'retry'}`
  让请求重试（每轮最多一次）。

**有效窗口** = 模型窗口 − 输出预留（最近 `request/header` 的 `maxTokens`），阈值按比例判定。
服务解析优先 `agentPresets.serviceFor(agent, 'compaction' | 'toolResultPruner')`（标准模式下
压缩实例在 preset 的隔离组里），取不到回退 Host 平面。

### 设置页：「自动压缩」开关（默认关闭）

- Host 半新增 `Config`（schemastery）：`autoCompact: z.boolean().default(false).volatile()`；
  行 id `dsh-session-enhance` 即设置命名空间；`configure({auto:false})` 关掉自动生成页。
- 浏览器半在 `plugins.bundle.config`（key = 包名）注册自绘卡片，用 `SettingsFormModel`
  做「暂存 → 保存」，走官方 configForms → profile patch 热更新，**不需要重启**。
- 默认关闭：关闭时本插件不做 L1/L2 主动自动压缩，手动压缩仍可用；**L3 溢出恢复与切模型
  压缩作为安全网保留**。

### 自动压缩守卫（让开关真正生效）

web 形态下 `compaction-basic` 由 preset 的 `isolate` 组提供，profile patch 的 id 定向覆盖
打不到它。因此驱动在运行期给 agent 可见的 compaction 实例包装 `compactIfNeeded`：开关关闭时
只把 `trigger === 'pressure'`（主动自动压缩）拦成 `null`，`context-overflow` 与 `compactNow`
（手动 `/compact`）不受影响；插件卸载时恢复原方法。

### 手动压缩也分级

点「压缩」时先做 L1 批量修剪（不调模型），紧接着执行官方 `/compact`（L2 摘要）；结果提示
同时报「已清理 N 个工具输出；压缩 M 项，释放约 T tokens」。官方「上下文已用」面板的动作行
还会显示「自动压缩：开/关」与两级阈值。

### 依赖与清单

- 新增依赖 `@deepseek-ai/schemastery`（Host 半声明 Config 用；profile 里没有 `@deepseek-ai/*`，
  必须装进本包 `node_modules`）。
- `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-settings` 与
  `@deepseek-ai/dsh-client-ui-plugin-manager`；client 半 `inject` 增加 `configForms`。

### 验证

- 单测 **152/152**：新增 `test/compact.test.mjs` 15 条（阈值边界、有效窗口、配置读取、
  L1/L2/L3 行为、异常吞掉、守卫安装/恢复、溢出重试上限、pruneAll/describe/diag），
  `test/entries.test.mjs` 新增 Config/设置策略断言，`test/context.test.mjs` 覆盖新的
  `get`/`compact`/`diag` 字段。
- `node --check index.js client.js` 通过；`Config.dict.autoCompact` 实测
  `type=boolean / volatile=true / default=false`，`new Config({}).autoCompact.get() === false`。
- devkit headless/web 沙箱回归见提交说明（真实 Loader 加载、设置页卡片出现、开关保存后
  Host 读到新值）。

## 4.4.0 — 2026-11-10

### 新能力：恢复被终止的子智能体

重启 / 长任务中断之后，子智能体（`subagent` 工具派生的子会话、Agent Teams 的 teammate）
的会话日志还在，但进程内 Agent 已消失。DSH 的恢复规则是：**只有父级**对「直接可继续子级」
发送 continuation 消息才会冷恢复（`dsh-subagent` / `dsh-experimental-agent-team` 的
`sendMessage`）；UI 直接打开子会话会被 `dsh-api-session-controller` 以
`ApiSessionSubagentOwnership` 拒绝。本插件补上这条通道：

- **标题栏按钮**（`conversation.session.header.utilities`）：
  - 父会话里有离线可恢复子智能体时显示「恢复子智能体（N）」→ 逐个冷恢复；
  - 子会话里父级在线时显示「恢复本子智能体」→ 经父会话恢复自己；
  - 恢复中禁用，完成后 Toast 报成功/失败数（含错误码）；无目标不渲染。
- **工具 `session_resume_subagents`**：`sessionId?` / `targets?` / `dryRun?`，让模型也能
  列出并恢复（主会话让 Agent 自主恢复子代理）。
- Host 新 RPC 通道 `/dsh-session-enhance-subagent`（`list` / `resume` / `diag`）：
  - `list` 合并两路发现：`agentTeams.listMembers`（teammate，行含 id/name/status）与
    `subagents.listChildren`（continuable 子会话，行含 id/label/mode），并用 `agents.get`
    标记在线状态；
  - `resume` 父会话模式：`agentTeams.sendMessage(lead, { target: name })` 与
    `subagents.sendMessage(parent, childId, ...)`；子会话模式：读取 `parentSession`，
    由在线父级发送；父级离线 → `PARENT_NOT_LIVE`，已在线 → `ALREADY_LIVE`，
    非可继续目标 → `NOT_RESUMABLE`；
  - 恢复内容是一条中性的「继续」消息（与重试半同文案），preset/工具限制/模型都由子会话
    自己的 descriptor 决定，不复制历史、不重建 agent。
- 服务均为软依赖：`subagents` / `agentTeams` / `sessionQuery` 缺失时对应能力返回明确错误码。

### 验证

- 单测 **135/135**（新增 `test/subagent.test.mjs` 8 条：父/子两种 list、父级离线、
  team+subagent 混合恢复、`targets` 过滤、`PARENT_NOT_LIVE`、`ALREADY_LIVE`、diag）。
- `node --check` 通过。
- devkit headless 沙箱：真实 Loader 里调用 `session_resume_subagents`（dryRun）验证工具注册
  与严格 schema 校验通过（详见提交说明）。

## 4.3.0 — 2026-11-10

### 手动压缩改为执行官方 `/compact` 命令（参考 Claude Code 的 /compact 机制）

4.2.0 的「压缩上下文」按钮直接调 `ctx.compaction.compactNow()`：压缩本身没问题，但它绕过
了官方命令链路，聊天里没有 `command/run` / `command/done`，也就没有命令反馈与
「`sourceEventSeq` → 压缩摘要卡片」的关联。Claude Code 的 `/compact` 是一条命令：执行后
对话里能看到压缩状态与摘要。本版对齐这一机制：

- Host 的 `context.compact` 端点**优先走 `ctx.commands.execute(agent, '/compact', [], signal)`**，
  与用户在输入框里敲 `/compact` 完全同一条链路（command/run → compactNow → command/done）；
  聊天里因此会出现官方命令反馈与压缩摘要卡片（带 `sourceCommandId` 关联）；
- 只有 `/compact` 命令未注册（未启用 `dsh-command-compact`）时，才回退到直接调用
  `ctx.compaction.compactNow()`，行为与 4.2 一致；
- 结果解析：成功文案 `Compacted N history items (~M tokens).` 解析成 `items` / `tokensSaved`
  供面板行显示中文提示；`No compactable history yet.` 映射为 `NO_RANGE`；失败文案按关键短语
  映射回稳定错误码（`BUSY` / `CANCELLED` / `CHANGED` / `SUMMARY_FAILED` / `COMMIT_FAILED` /
  `PERSISTENCE_FAILED`），不会把命令的英文提示当成 code 抛给界面；
- `diag` 增加 `hasCommand` 字段；`get` 的 `canCompact` 现在认可「命令可执行」这一路径
  （不再要求必须有 `compaction` 服务直连）。

### 验证

- 单测 **127/127**（新增：命令成功解析、`NO_RANGE` 识别、失败文案→错误码映射、命令未注册时
  回退服务调用；`diag` 断言补 `hasCommand`）。
- `node --check client.js` / `lib/context/host.mjs` 通过。
- devkit web/UI 沙箱（真实 Loader + 真实浏览器，启用 `compaction-basic` / `command-compact`）：
  验证动作行注入与点击链路（命令路径在沙箱里会因无模型 key 返回 `SUMMARY_FAILED`，属预期的
  业务结果，详见提交说明）。

## 4.2.0 — 2026-11-09

### 手动压缩改到官方「上下文已用」面板里（对齐官方风格）

4.1.0 在 composer 左侧自绘了一个「上下文 42% · 压缩」小部件；但 DSH 0.2.2 起官方
composer 下方自带 ContextMeter（圆环 + 百分比 + 点开的明细面板：系统提示词 / 工具定义 /
对话消息），自己再显示一遍百分比既重复又不像官方。本版：

- **移除**左侧自绘的百分比/压缩小部件；
- 在官方 ContextMeter 面板**末尾注入一行「压缩上下文 [压缩]」动作**，字号 / 行高 / 色板 /
  分隔线全部沿用官方 ContextMeter 的 token（`--dsw-alias-label-secondary`、
  `--dsw-alias-border-l1`、`12px/20px`、`--dsw-radius-sm`），外观与官方 row 一致；
- 点击行为不变：Host `ctx.compaction.compactNow()`（与官方 `/compact` 同一实现）；
  行内先显示「压缩中…」，完成后「已压缩 N 项，释放约 M tokens」，无范围时「没有可压缩的历史」，
  压缩服务缺失时按钮置灰并提示；
- **实现方式**：官方面板由 `dsh-client-ui-conversation` 内置渲染、portal 到 body，
  没有对外 slot，因此按稳定 DOM 特征识别（`role=dialog` + `<dl>` + 文本含百分比），
  用 `MutationObserver` + 800ms 兜底轮询注入；面板关闭/重渲染自动补回，卸载时清理
  观察器 / 样式 / 节点。官方换结构时最坏只是这一行不出现，不影响官方 meter；
- 空会话跟踪：仍在 `conversation.input.left` 挂一个隐藏的 session tracker（记录"当前会话
  是谁"，压缩动作按它发 RPC），但不渲染任何可见内容。

### 修复（开发期踩坑）

- 注入行最初无条件重写 `textContent`，而 `MutationObserver` 观察整棵 body →
  「写 → 观察 → 再写」无限循环，直接把页面主线程卡死（沙箱里实测到 60s 无响应）。
  现在只在值变化时写 DOM，并忽略仅发生在动作行内部的 mutation，观察器可收敛。

### 验证

- 单测 **123/123**；`node --check client.js` 通过。
- devkit web/UI 沙箱：`dsh-session-enhance@4.1.0` 升级后 client 半加载 0 console 错误；
  用与官方同形状的模拟面板（`role=dialog` + `<dl>` + 62%）验证：动作行被追加到面板末尾、
  文案「压缩上下文 / 压缩」、title 正确；点击后 Host 真实执行 `compactNow` 并回显
  「没有可压缩的历史」（沙箱无模型 key，属预期的业务结果）。
- 真实官方面板的外观需要在有 contextPressure 的实机上确认（本版用户截图即该面板）。

## 4.1.0 — 2026-11-09

### 新能力：composer 的「上下文用量 + 手动压缩」

真实事故（`session-3b342fc5`，2026-11-09）：64 轮 / 658 步的会话堆到 128 万 tokens，
超过模型 104 万窗口，提供方直接返回 `CONTEXT_WINDOW_EXCEEDED`，这一轮只能失败；
而"继续/重试"只会把输入变得更长。根因之一是本 profile 的官方压缩栈（
`dsh-compaction-basic` / `dsh-command-compact` / `dsh-compaction-tool-result-pruner`）
一直处于停用状态，且界面上看不到上下文用量。

本版在「会话增强」主组件里新增（无新 Loader 行）：

- **上下文用量**：composer 左侧显示「上下文 42%」，数据来自 Host 的
  `ctx.tokenMeter.contextPressure()`（估算请求输入 / 模型窗口）；≥70% 橙色、≥85% 红色，
  悬停显示 `已用 / 窗口（百分比）`。
- **手动压缩按钮**：点「压缩」调用 `ctx.compaction.compactNow()`（与官方 `/compact`
  同一实现），完成后提示「已压缩 N 项，释放约 M tokens」并刷新用量；会话忙 / 压缩进行中
  置灰，无压缩服务时提示「压缩不可用：当前部署未启用压缩插件」。
- Host 新 RPC 通道 `/dsh-session-enhance-context`（`get` / `compact` / `diag`），
  挂在第一行（会话增强）而不是 share/retry 行；`tokenMeter` / `compaction` 都是软依赖。
- **重试不再处理上下文溢出**：`CONTEXT_WINDOW_EXCEEDED` 是确定性失败，4.1 起既不开闸门、
  也不写 recovery（否则按钮会诱导用户再发一次同样超长的输入）。处理方式是手动压缩或
  开启官方自动压缩。
- README 补充前置条件（启用 `dsh-compaction-basic` 以自动压缩）与事故复盘。

### 验证

- 单测 **122/122**（新增 `test/context.test.mjs` 12 条：用量字段、压缩成功/`NO_RANGE`/
  `COMPACTION_UNAVAILABLE`/错误码映射/无 live agent、RPC 信封与 401/404；retry 新增
  「上下文溢出不给重试/不记 recovery」）。
- devkit web/UI 沙箱：client 半 `dsh-session-enhance@4.1.0 is loaded`、0 console 错误、
  `[data-session-context]` 小部件已注册、`/dsh-session-enhance-context/diag` 真机返回
  `{hasCompaction, hasTokenMeter}`（详见提交说明）。
- 活 profile：启用 `dsh-compaction-basic` + `dsh-command-compact`，使手动/自动压缩可用；
  重启后新 client 半生效。

## 4.0.1 — 2026-11-09

文档与验证记录更新（无行为变更）：README 的 4.0.0 验证表补上实测证据（单测 110/110；
devkit headless 沙箱三行 Loader 行与 `session_lookup`；web/UI 沙箱 client 半清单、
`dshTurnRetry=4.0.0`、「会话增强 v4.0.0」卡片与三组件运行中；活 profile 三条路由状态）。

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
