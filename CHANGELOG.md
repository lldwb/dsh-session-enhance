# Changelog

本插件的改动都记在这里；版本号遵循 `.` 分段语义（大版本 = 结构性/破坏性，中版本 = 新能力，
小版本 = 修复与文档）。

## 6.7.4 — 2026-11-26

### 文档：清理正文中的本机会话 id 与实测计数

- 「会话 ID 的三种写法」示例改用占位形态（`session-<uuid>` / `<uuid>` /
  `dsh-session-session-<uuid>.zip`），不再出现真实会话 UUID；
- 「先概括、再检索、后精读」里「真实案例：N 个事件 / N 次工具调用 / N 分钟跨度」
  改为不含具体计数的现状表述（「几千个事件、几百次工具调用」）。

无代码改动。

## 6.7.3 — 2026-11-26

### 文档：README 整理为只描述当前版本

- README 去掉版本史、验证 / 回归记录、开发笔记与记录日期，只保留「当前是什么 / 怎么装 /
  怎么用 / 怎么配 / 有什么限制」；能力清单按当前版本重写（5 个组件、6 个工具、全部配置
  字段、RPC 通道与存储路径一个不漏），并保留「加载方式」标记行与新人需要的生效方式；
- 核对 `package.json` 的仓库字段：`repository` / `homepage` / `bugs` 三件套与 `license`
  均指向本仓库（§12.2 要求的「About 跟着包走」）。

无代码改动。

## 6.3.9 — 2026-11-26

### 固定梁谷按钮尺寸：任何状态/文案/倒计时下都是 112 × 24，不再跳动

用户要求：无论关闭/开启、空闲/高峰暂停、文案与倒计时怎么变，按钮宽高都不变。

- 两处梁谷开关（标题栏 chip + 新建页开关）统一改为**固定尺寸 `112px × 24px`**
  （`box-sizing:border-box`、`flex:none`），文案区 `flex:1 + text-align:center`，
  超长才省略；
- 宽度按最长文案留余量：图标 15 + gap 4 + 左右 padding 16 + 「梁谷 60m00s」
  （12px 字号约 68）≈ 103，取 112 留安全余量；
- 关态「梁峰」、暂停「梁谷 46m32s」、空闲「梁谷 空闲」、切换中「梁谷 …」都落在同一尺寸。

**验证**：单测 **302/302**（新增「固定尺寸」用例：chip 与 hero 在 off/paused/idle/busy
四态都断言 `width:'112px' / height:'24px'`）；真实 UI 沙箱逐态实测：hero off `112×24`、
hero idle `112×24`、chip idle `112×24`、hero paused `112×24`（「梁谷 46m43s」）、
chip paused `112×24`（「梁谷 46m32s」），宽高完全不随状态变化；`node --check`、locale /
工具名门禁 ✓。

## 6.3.8 — 2026-11-26

### 梁谷组件的界面统一到 DSH 官方形制（官方 `Pill` + `Tooltip`）

两处梁谷开关（标题栏 chip、新建会话页开关）此前各写各的内联样式，且 chip 仍用元素原生
`title`。本版统一到 primitives 的官方组件：

- **形状**：两处都用官方 `Pill`（24px 胶囊、`border-radius:999px`、12px 字号、
  `bg-layer-2`/`active` 变体），语义色仍走主题 token（暂停 warn、空闲 success、关 muted）；
- **提示**：两处都用官方 `Tooltip`（深色气泡、`role="tooltip"`、`side:'bottom'`、
  `delayMs`、`maxWidth:320`），**彻底移除原生 `title`**；chip 的提示额外带队列条数；
- **图标**：两处共用同一套 `offpeakStatusIcon`（关=太阳、开=弯月+小星星）；
- **文案**：chip 简化为「梁谷 2m32s / 梁谷 空闲 / 梁谷 / 梁谷 …」（图标已表达状态，去掉
  “暂停”二字）；hero 保持用户指定的「梁峰 / 梁谷 X」；
- **修一个实现坑**：Tooltip 的锚点必须是原生元素——直接把自定义组件 `Pill` 交给
  Tooltip 克隆时，ref/指针事件不保证落到真实按钮上（实测气泡不出来）；改为
  `Tooltip > span > Pill` 后恢复正常。

**验证**：单测 **301/301**（chip 与 hero 夹具改为从 Tooltip 子树里取 Pill；断言两处都无
`title`、`side='bottom'`、文案与提示逐字匹配）；真实 UI 沙箱（reload 加载新代码）：
chip 与 hero 都是 `height 24px / radius 999px / font-size 12px / hasTitle=false`；hover
分别出现官方深色气泡「梁谷：高峰暂停 / 将在 12:00 自动恢复 / 队列中 1 条消息…」与
「梁谷：关闭 / 点击开启…」；截图确认与标题栏其它官方控件同一形制。

## 6.3.7 — 2026-11-26

### 开启态图标：弯月 + 右上角小星星（按用户参考图）

用户提供参考图：月亮旁边要有一颗小星星。此前开态只有一条弯月 path。

- 开态图标改为 **弯月（stroke）+ 右上角四角星（fill=currentColor）** 两个 path，15px
  viewBox，视觉上就是「月亮 + 星星」；关态仍是太阳；
- 图标是内联 SVG（primitives 只有 `IconSparkleRegular`，与月亮的描边/尺寸不匹配，故手画）。

**验证**：单测 **301/301**（client 23：开态路径 ≥2 且星星为实心 `fill=currentColor`、关态仍是
`circle` 太阳、Tooltip 仍为 `side='bottom'`）；真实 UI 沙箱把 SVG 临时放大到 96px 截图确认：
弯月 + 右上四角星与参考图一致，官方 tooltip 气泡仍正常；`node --check`、locale/tool-names 门禁 ✓。

## 6.3.6 — 2026-11-26

### 新建页梁谷开关的悬浮提示改用官方 `Tooltip`（深色气泡），不再是系统白底提示

用户截图指出：鼠标悬停时出现的是浏览器/系统默认的 `title` 提示框（白底黑框），与 DSH 界面
风格不一致。核对官方实现：DSH 自己的标题栏按钮用 primitives 的 `Tooltip`
（`packages/client/ui-primitives/src/Tooltip.tsx`，深色气泡 + `role="tooltip"`、`side`/`delayMs`/
`maxWidth` 可配、`white-space: pre-line` 支持换行）。

改动：

- hero 开关**去掉元素原生 `title`**，改为 `P.Tooltip` 包裹（`side:'bottom'`、`delayMs:350`、
  `maxWidth:320`），与官方标题栏按钮同款气泡；
- 提示文案缩短为 1~2 行（官方风格），只回答「现在什么状态 / 点了会怎样 / 何时自动变化」，
  不再塞整段高峰时段规则：
  - 关：`梁谷：关闭` + `点击开启：开启后从这里新建的会话就是梁谷会话。`
  - 暂停：`梁谷：高峰暂停` + `将在 HH:MM 自动恢复`
  - 空闲：`梁谷：空闲` + `将在 HH:MM 自动暂停`
  - 切换中：`梁谷：正在切换…`
- `aria-label` 保留（无障碍），`data-*` 钩子不变。

**验证**：单测 **301/301**（client 23：按钮无 `title` 属性、`Tooltip` 存在且 `side='bottom'`、
四态 label 文案与「自动恢复/暂停 HH:MM」断言）；真实 UI 沙箱：hover 时出现
`role="tooltip"` 深色气泡（关态「梁谷：关闭 / 点击开启…」、开启态「梁谷：高峰暂停 / 将在
12:00 自动恢复」），按钮 `hasAttribute('title') === false`；截图确认与官方风格一致。
`node --check`、locale/tool-names 门禁 ✓。

## 6.3.5 — 2026-11-26

### 文档再修正：桌面应用没有刷新按钮，但 F12 能重载渲染进程

6.3.4 写得过绝（“没有刷新页面入口、只能退出重开”）。用户指出桌面版内置了隐藏的 F12
开发者工具，核对 `E:\deepseek-harness\apps\desktop\src\main.ts`：

- 第 295 行 `webPreferences.devTools: true`；
- 第 1229 行 `{ role: 'toggleDevTools', visible: false, accelerator: 'F12' }`（Windows 窗口菜单，
  生产环境也注册），所以 **F12 可打开 DevTools**；
- 在 DevTools Console 执行 `location.reload()`（或焦点在 DevTools 里按 Ctrl+R）只重载渲染
  进程：重新从磁盘拉 `client.js`，**不重启宿主、不中断当前会话与子代理**。

因此浏览器半改动的推荐生效方式是 **F12 → Console → `location.reload()`**；Host 半改动仍需
重启应用。README 的「生效方式」一节已按此改写。

**验证**：`node --test "test/**/*.test.mjs"` **301/301**；locale 门禁 ✓。

## 6.3.4 — 2026-11-26

### 文档修正：桌面应用没有「刷新页面」，client 改动必须退出应用再重开

用户指出：「我是应用，哪里来的刷新页面」。核对桌面宿主代码（`dsh-desktop-host`）确认：

- 桌面应用**没有注册 Ctrl+R / 重载命令**，也没有通用的「重新加载界面」入口；官方的
  「刷新以加载新版本」只在检测到 **Host 版本变化**时出现，插件自身改 `client.js` 不会触发；
- 因此浏览器半改动在桌面版上的生效方式是**完全退出应用再重开**（托盘常驻时注意彻底退出）；
  `dsh web` 场景才是刷新页面。

本版只改文档：
- README 新增「生效方式（桌面应用没有刷新按钮）」一节，分 Host 半 / 浏览器半 / 纯数据三类；
- 把正文与升级说明里 9 处「刷新页面」改为「桌面版重开应用 / 浏览器版刷新页面」的准确表述；
- 组件表里删掉 6.3.0 已移除的 `createLiangguSession` 端点描述，改为新建页「梁谷」开关。

**验证**：`node --test "test/**/*.test.mjs"` **301/301**；locale / 工具名门禁 ✓。

## 6.3.3 — 2026-11-26

### 新建页梁谷开关的显示重做：关=太阳+「梁峰」，开=月亮+「梁谷」+剩余时间/空闲

用户反馈按钮显示仍不对（此前是「面板图标 + 只有数字」）。按要求重做：

- **关（未启用）**：太阳图标 + 文字「梁峰」（次要文字色、无底色）；
- **开（梁谷）**：月亮图标 + 文字「梁谷」，后面跟剩余时间（如 `1h12m`）或「空闲」；
  暂停态琥珀色、空闲态绿色（沿用 chip 的语义色）；
- 两种状态都**始终显示文字**，不再出现“只有数字/只有图标”无法辨识的情况；
- 太阳/月亮是内联 SVG（primitives 没有这两个图标），15px、`currentColor`、1.2 描边；
- 行为不变：点击只 toggle（不建会话、不导航、不弹 Toast）。

**验证**：单测 **301/301**（client 23：关态文字「梁峰」+ 太阳 `circle`、开态「梁谷 3h05m」+
月亮 `path`、空闲「梁谷 空闲」、busy「梁谷 …」）；真实 UI 沙箱：关态截图「☀ 梁峰」、
点击后「☾ 梁谷 1h12m」（琥珀 pill）、再点可关；`node --check`、locale/tool-names 门禁 ✓。

## 6.7.2 — 2026-11-26

### 收紧段间距 + 加宽 2px：`空闲 14h48m` 这类长倒计时不再被省略号折叠

用户截图反馈「空闲 14h51…」被折叠。原因是 106px 宽里两处 4px gap 占掉 8px，倒计时只剩
43px，而 `14h51m` 实测约 43px 且浏览器取整后放不下。

- 段间距（Pill 的 `gap`）从 4px 收到 **2px**（两处，共省 4px）；
- 固定宽度 106 → **108px**（倒计时区从 43px 增到 **47px**；实测 `14h48m` 宽 **43px**，
  47px 有余量、不再折叠）；
- 高度、相位区 24px、图标与相位的 x 坐标都不变（仍满足「图标/相位位置不随状态变化」）。

**验证**：单测 **321/321**（固定尺寸断言 108px；新增「宽度预算」用例：gap 2px、倒计时区
≥47px、倒计时段可伸缩且保留省略号兜底）；真实 UI 沙箱：`空闲 14h48m` 完整显示
（状态区 `scrollWidth = clientWidth = 47`、文本实测 43px、`clipped=false`），按钮 `108×24`，
截图确认；`node --check`、locale / 工具名门禁 ✓。

## 6.7.1 — 2026-11-26

### 降低节假日自动更新的复查频率（6 小时 → 每天检查一次、7 天 TTL）

用户反馈复查太频繁：官方放假安排一年只发布一次，没必要高频请求。

- 缓存 TTL：24 小时 → **7 天**（`HOLIDAY_CACHE_TTL_MS = 7d`）；7 天内不再发任何请求；
- 定时器：每 6 小时 → **每 24 小时一次本地检查**（只比较 `fetchedAt`，不请求；超过 7 天才抓）；
- 启动后 3 秒的那次检查保留（同样受 TTL 约束）；
- 结果：全年真实网络请求从 ~1460 次降到 ~50 次量级。

**验证**：单测 **320/320**（新增「刷新频率」断言：TTL 恰为 7 天且不小于 1 天）；`node --check`、
locale / 工具名门禁 ✓。

## 6.7.0 — 2026-11-26

### 法定节假日表自动更新（插件自己联网，不经过 AI）

用户要求：节假日安排不要每次手动改代码/靠 AI 搜索，改成自动更新。

- 新增 `lib/offpeak/holidays-fetch.mjs`：多源抓取 + 结构校验 + 本地缓存 + 合并规则；
  - 源 1：[timor.tech](https://timor.tech/api/holiday) `/api/holiday/year/<年>/`（免费、无 key，
    只取 `holiday: true` 的休息日，忽略调休补班）；
  - 源 2/3：`holiday-cn`（GitHub `NateScarlet/holiday-cn`，每日抓国务院公告）的
    jsDelivr / raw.githubusercontent 镜像（只取 `isOffDay: true`）；
  - 每个源都校验「年份匹配 + 日期真实存在 + 天数在 10~60 之间」，全部失败返回 `null`
    并保留内置/上次缓存（**失败不改变任何行为**）；
- 缓存：`<DSH_HOME>/dsh-session-enhance/holidays-cache.json`（`{version, fetchedAt, source,
  years}`，24 小时 TTL；损坏/版本不符自动忽略）；启动 3 秒后抓一次、之后每 6 小时复查；
- 合并规则：`autoHolidays`（新配置，默认开）+ `holidays` 仍是内置默认值 → 内置表 ∪ 抓取结果；
  用户**显式改过 `holidays`**（含空串 = 不豁免）→ 只用配置，自动更新不覆盖用户意图；
- 抓取成功后 `controller.refresh()` 立即重算边界与 hold（跨年/节假日翻转当天即时生效）。

**验证**：

- 单测 **319/319**（新增 10 例：timor/holiday-cn 解析、补班日忽略、日期/天数校验、多源回退、
  全失败返回 null、缓存往返与损坏容错、合并规则、HTTP 超时 abort 回退、源清单 HTTPS）；
- 真实 headless 沙箱（`gufeng-auto`）：插件启动后自动抓取成功，缓存文件实际写出
  `source: "timor"`、`2026: 33 天`、`2027: 29 天`（与内置表一致），任务正常运行（AUTO-OK）；
- `node --check`、locale / 工具名门禁 ✓。

## 6.6.4 — 2026-11-26

### 节假日表补上 2027 年（国办发明电〔2026〕10号）

用户要求更新 2027 年假期表。默认节假日表从 2026 单年扩展为 **2026+2027 两年共 62 天**：

- **2027**（依据国务院办公厅 2026-11-05 发布的国办发明电〔2026〕10号，见
  [gov.cn 通知](https://www.gov.cn/zhengce/content/202611/content_7085101.htm)）：
  元旦 01-01..01-03、春节 02-05..02-13、清明 04-03..04-05、劳动 05-01..05-05、
  端午 06-09（单日）、中秋 09-15（单日）、国庆 10-01..10-07，共 29 天；
- 2026 部分保持（33 天），合计 62 天；配置页 `holidays` 默认值随之变长。
- **调休补班日不参与判定**（用户明确）：本插件按官方「周一至周五（不含法定节假日）」口径，
  补班的周六/周日仍是周末 → 空闲；不新增 `workdays` 之类字段。

**验证**：单测 **309/309**（`offpeak-window` 15 例新增 2027 断言：春节 02-05/02-13 空闲、
02-15 恢复高峰、国庆 10-01 空闲 / 10-08 恢复、端午 06-09 与中秋 09-15 单日空闲；默认表 62 天、
最后一天 2027-10-07；`entries`/`controller`/`rpc` 的默认节假日天数同步为 62）；`node --check`、
locale / 工具名门禁 ✓。

## 6.6.3 — 2026-11-26

### 空闲→高峰的倒计时用 ⏳ / ⏰ 体现紧迫感

用户要求：从空闲到高峰的倒计时要参考高峰到空闲的倒计时（同一格式、同样带紧迫动效），
但要体现紧迫感，用 ⏳ 这类 emoji（最后 10 秒改用闹钟 ⏰）。

- **高峰 → 空闲**（即将恢复）：≤60s `🎉`、≤10s `🎊`（节庆感，保持）；
- **空闲 → 高峰**（即将暂停）：≤60s `⏳`、≤10s `⏰`（紧迫感）；
- 两者沿用同一套 `urgent`（1s 呼吸）/ `final`（0.45s 加粗）动效与 `formatOffpeakCountdown` 格式。

**验证**：单测 **309/309**（emoji 断言按相位区分：高峰 37s/9s→`🎉/🎊`，空闲 59s/1s→`⏳/⏰`）；
真实 UI 沙箱构造「空闲→高峰」窗口：`空闲 1m15s` → **`空闲 ⏳ 30s`**（`data-offpeak-urgent="urgent"`、
`animationName=dsh-offpeak-urgent-throb`、`1s`）→ **`空闲 ⏰ 4s`**（`final`、`0.45s`），
说明格式与紧迫感都和高峰→空闲一致；`node --check`、locale / 工具名门禁 ✓。

## 6.6.2 — 2026-11-26

### 谷峰插件悬浮提示改成「状态含义 + 点击行为 + 切换时刻」

用户反馈：胶囊下方黑色提示框「谷峰插件：高峰 / 将在 18:00 切换为空闲」不够直观。现在按
「这个状态对 AI 调用意味着什么 → 点击会怎样 → 何时自动切换」重写：

- **未选中（普通会话）**：「普通会话：不受谷峰限制，AI 调用照常」/「点击设为「空闲会话」：
  高峰暂停、空闲运行」；
- **高峰（选中）**：「高峰时段：已暂停 AI 调用（消息会排队）」/「将在 HH:MM 进入空闲，并自动恢复」/
  「点击可取消「空闲会话」」；
- **空闲（选中）**：「空闲时段：AI 调用正常运行」/「将在 HH:MM 进入高峰，并自动暂停」/
  「点击可取消「空闲会话」」；
- 暂停且有排队时仍追加「队列中 N 条消息，空闲时段开始后自动处理」。

**验证**：单测 **309/309**（词典与三条提示断言更新）；真实 UI 沙箱悬停（页面内派发 mouseenter
让官方 Tooltip 显示，截图确认）：气泡三行 = 「高峰时段：已暂停 AI 调用（消息会排队）」
「将在 18:00 进入空闲，并自动恢复」「点击可取消「空闲会话」」，可读且不溢出；`node --check`、
locale / 工具名门禁 ✓。

## 6.6.1 — 2026-11-26

### 修正谷峰插件按钮配色：背景按相位橙/绿，边框选中浅灰、未选中白色

按用户最终口径修正 6.6.0 的配色：

- **背景**：高峰 = **橙色底**（`warn-tertiary` token，实测 `rgb(254,245,231)`）、空闲 = **绿色底**
  （`success-tertiary`）；内部图标/文字沿用语义色（高峰橙 / 空闲绿），不随选中变化；
- **边框**：选中 = **浅灰**（`#d0d3d8`，实测 `rgb(208,211,216)`）；未选中 = **白色**
  （`#ffffff`，实测 `rgb(255,255,255)`）；
- **未选中也有倒计时**：`offpeakCountdownOf` 去掉 `enabled !== true` 的早退，普通会话同样显示相位
  + 倒计时（用户要求「无论是否选中都应该有倒计时」）。

**验证**：单测 **309/309**（背景按相位 token、边框浅灰/白色、未选中也显示倒计时）；真实 UI 沙箱：
高峰选中 = 背景 `rgb(254,245,231)` + 边框 `rgb(208,211,216)`；高峰未选中 = 同背景 + 边框
`rgb(255,255,255)`，两者文字都显示「高峰 1h41m」；空闲绿色背景由单测覆盖（真实窗口未再切换验证，
如实说明）；`node --check`、locale / 工具名门禁 ✓。

## 6.6.0 — 2026-11-26

### 更名「谷峰插件」；按钮改为「相位 + 倒计时」，点击把会话设为空闲会话；选中只切黑白框

用户重定义了这个组件：

- **组件名**：「梁谷」→ **「谷峰插件」**（locale 标题/描述、界面文案、README 全部更新）；
- **按钮内部**：始终显示「**相位 + 倒计时**」——
  - **高峰**：太阳 +「高峰」+ 倒计时（到空闲开始），**橙色**（沿用原来选中时的 warn 语义色）；
  - **空闲**：弯月+星 +「空闲」+ 倒计时（到高峰开始），**绿色**（success 语义色）；
  - 倒计时 >1h `3h05m`、1min~1h `12m34s`、<1min `37s`；≤60s 加 🎉/🎊 与呼吸动效；
- **点击右上角按钮 = 把当前会话设为「空闲会话」**（再点取消）：语义仍是「高峰暂停、空闲运行」，
  但界面上不再叫开关/启用，而是「空闲会话」；新建会话页开关同理（点击 = 把这个新建会话设为空闲会话）；
- **选中/未选中只切「框」的黑白款**：选中 = 深色边框，未选中 = 浅色边框；**内部相位色
  （高峰橙 / 空闲绿）与内容不随选中变化**（用户明确：内部始终沿用原来选中时的样式）；
- **未选中（普通会话）也显示相位 + 倒计时**：`createOffpeakControl` 的 tick 不再要求 enabled；
- 三段布局保持：图标 + 相位（固定 24px）+ 倒计时（固定起点），尺寸固定 `106×24`；
- 移除不再使用的旧词条（`offpeak.title.*` / `offpeak.chip.off|paused` / `lianggu.*` 等）。

**验证**：

- 单测 **309/309**（新语义：高峰/空闲文案、内部橙/绿、框黑/浅、未选中也显示倒计时、emoji、
  三段布局、紧迫动效、只读继承、失败 Toast）；
- 真实 UI 沙箱四组合：
  - 高峰选中/未选中：内部橙 `rgb(221,134,41)`；边框 `rgb(20,23,26)` / `rgba(0,0,0,.1)`；
  - 空闲选中/未选中：内部绿 `rgb(34,197,94)`；边框同上黑/浅；
  - 四种均 `106×24`，截图确认；
- `node --check`、locale / 工具名门禁 ✓。

## 6.5.3 — 2026-11-26

### 审计新建页开关与标题栏 chip：修「hero 失败无 Toast」与 aria 不一致

用户要求检查两处梁谷按钮的样式与逻辑。逐项核对后确认：尺寸（`106×24`）、圆角、字号、
三段布局、图标/名称/状态文案、emoji、动效、Tooltip、只读规则、capability 隐藏、同一控制器
与去重（`toggling` 防连点）均一致；**发现并修复两处问题**：

1. **新建页开关失败时没有反馈（真 bug）**：`createOffpeakControl.toggle` 失败 / 未落盘时会写
   `notice`，标题栏 chip 会据此弹 Toast，但新建页开关的渲染漏了这一段——用户点了失败什么都
   看不到。现在 hero 与 chip 一样渲染 `P.Toast`（同一 `notice`、`sequence` 当 key、`onDone`
   清对应那条），并补了点击守卫（busy/只读时 early return）。
2. **无障碍名称不一致**：chip 的 `aria-label` 取提示文案首行（如「梁谷：高峰暂停」），
   hero 用的是固定文案。现在统一为提示文案首行。

**核对结果（样式）**：两处都是官方 `Pill` 106×24、`border-radius:999px`、12px 字号、
无原生 `title`；真实 UI 沙箱同一会话实测——新建页 `梁谷3h16m`（106×24）与标题栏
`梁谷3h16m`（106×24）逐项一致。

**核对结果（逻辑）**：两处共用 `createOffpeakControl`（同一次 `setEnabled` RPC、同一轮询/
倒计时、同一防连点）；状态语义一致（关/暂停/空闲/busy）；只读会话 chip 置灰而 hero 隐藏
（有意差异）；组件停用（405）两处都隐藏；失败/未落盘现在两处都有 Toast。

**验证**：单测 **310/310**（新增：hero 失败渲染 Toast + `onDone` 清 notice；既有只读/emoji/
三段布局用例继续覆盖）；真实 UI 沙箱并排核对尺寸与文案；`node --check`、locale / 工具名门禁 ✓。

## 6.5.2 — 2026-11-26

### 倒计时最后 60 秒在状态前加节庆 emoji（🎉 / 🎊）

用户要求：`梁谷 57s` 这种临近结束的状态要加类似新年倒计时的 emoji。

- 暂停态剩余 **≤60s**：状态段显示 `🎉 57s`；剩余 **≤10s**：`🎊 8s`（更喜庆）；
- 其余状态（关/空闲/普通倒计时/busy）一律不加 emoji，保持安静；
- 宽度不变：实测状态区 43px 下 `🎉 57s` = **37.79px**，仍在 43px 内，按钮整体保持
  `106×24`、不截断（`scrollWidth=clientWidth=43`）；
- emoji 与 `urgent`/`final` 呼吸动效同时生效（节庆感 + 倒计时感）。

**验证**：

- 单测 **309/309**（新增「节庆 emoji」用例：37s/59s→`🎉`、9s/1s→`🎊`、61s→`1m01s` 无
  emoji、空闲/关/busy 无 emoji，chip 与 hero 都覆盖）；
- 真实 UI 沙箱：配置高峰到 14:28，`梁谷 🎉 41s`（`data-offpeak-urgent="urgent"`）、按钮
  `106×24`、状态区 `scrollWidth=clientWidth=43` 不截断；窗口结束后恢复 `梁谷 空闲` 无 emoji；
  截图确认 `梁谷 🎉 41s` 显示正常；
- `final`（🎊）级别由单测覆盖，真实窗口只抓到 urgent（如实说明）；
- `node --check`、locale / 工具名门禁 ✓。

## 6.5.1 — 2026-11-26

### 梁谷开关改成「图标 + 名称 + 状态」三段固定布局（图标与名称不随状态移动）

用户要求：按钮里要有图标、文字、状态三段，且**图标和文字的位置不随状态变化**（此前名称与
倒计时拼成一段居中，倒计时/空闲文字变化会让文字左右移动）。

- Pill 内部拆成三段固定结构：**图标（15px）+ 名称（固定 24px，不参与伸缩）+ 状态（固定起点
  的剩余空间，43px，左对齐、等宽数字）**；
- 宽度相应定 **106px**（16 padding + 15 图标 + 4 gap + 24 名称 + 4 gap + 43 状态），
  高度仍 24px；状态文字变化只在最右侧 43px 区域内变化，图标与名称的 x 坐标不变；
- 文案语义：名称段 chip 恒为「梁谷」、hero 关态为「梁峰」/开态「梁谷」；状态段为
  `3h52m` / `空闲` / `…` / 关态空串（不再把「梁谷」重复进状态段）。

**验证**：

- 单测 **308/308**（新增「三段布局」用例：chip 与 hero 四态都断言 children 为
  图标 + 24px 名称 + `flex:1 1 auto` 状态段，且名称段在状态间不变）；
- 真实 UI 沙箱逐态实测（真实 Chrome）：

  | 状态 | 图标 left | 名称 left | 名称宽 | 状态段 left |
  |---|---|---|---|---|
  | 关（梁峰） | 661.5 | 680.5 | 24 | 708.5 |
  | 暂停（梁谷 3h52m） | 661.5 | 680.5 | 24 | 708.5 |
  | 关（再切回） | 661.5 | 680.5 | 24 | 708.5 |
  | 空闲（梁谷 空闲） | 661.5 | 680.5 | 24 | 708.5 |

  即图标与名称位置在四种状态下**完全一致**，按钮整体 `106×24`；
- `node --check`、locale / 工具名门禁 ✓。

## 6.5.0 — 2026-11-26

### 子智能体同步主会话的梁谷状态（只读）；倒计时不足 1 分钟显示 `37s`

**子智能体只读继承（用户要求）**：主智能体设置梁谷后，子智能体**同步该状态且不能修改**。

- Host：`status(sessionId)` 对 `session.header.origin === 'subagent'` 的会话改为**继承判定**——
  沿祖先链找是否有启用者：`enabled` / `paused` 与主会话一致，`enabledSource='parent'`，
  新增 `readOnly:true` 与 `inheritedFrom`（直接父会话 id）；子智能体自己的 store 记录被忽略；
- `setEnabled` 对子智能体会话**不写 store、不下发改动**，返回 `readOnly:true / applied:false`；
  RPC 层转成 `READ_ONLY_INHERITED` 错误（"state is inherited from the parent session and is
  read-only here"）——绕过界面直接调 API 也改不了；
- 客户端：子智能体会话的 chip **置灰不可点**（`data-offpeak-read-only=true`），悬浮提示追加
  「状态继承自主会话，在子智能体会话里不能修改。」；新建页开关在只读会话里直接隐藏；
- 边界：只认 `origin === 'subagent'`（普通 fork 带 `parentSession` 但不锁只读）；判定需要
  同步读到 header（live Agent），读不到时按普通会话处理，不会误锁。

**倒计时格式（用户要求）**：不足 1 分钟**省略 `0m`**，显示 `37s` / `59s`（此前是 `0m37s`）；
1 分钟~1 小时仍是 `12m34s`，1 小时整点 `60m00s`，超过 1 小时 `3h05m`。

**验证**：

- 单测 **307/307**（controller 31：新增「子智能体同步且只读」——继承父启用、忽略自身记录、
  `setEnabled` 返回 applied:false 且 store 不变、父关后同步关闭仍只读；「普通 fork 不受影响」；
  RPC 11：`READ_ONLY_INHERITED` + 普通会话对照组；client 26：只读 chip 置灰/提示/点击不
  toggle、hero 隐藏；倒计时边界 59s/42s/5s→`59s/42s/5s`，0/999ms→`0s`）；
- 真实 UI 沙箱：父会话开启梁谷 → 模型实派子代理（`1 个子智能体`）→ 从页面调 `diag`：
  子会话 `enabled:true / enabledSource:parent / readOnly:true / inheritedFrom:父会话`、
  `covered:true`；`setEnabled(子会话,false)` 返回 **`READ_ONLY_INHERITED`**；`status` 同样只读；
  倒计时实测 `梁谷 1m52s` → `梁谷 57s`（无 `0m`）并带 `urgent` 动效；
- `node --check`、locale / 工具名门禁 ✓。

## 6.4.1 — 2026-11-26

### 梁谷按钮宽度收紧到 105px；倒计时最后 60 秒带动效

**宽度收紧（用户要求）**：在保证「梁谷 60m00s」这类最长文案不截断、不抖动的前提下，把固定
宽度从 112px 收窄。做法是**实测**而不是估算：官方 Pill 字体 12px 下，最长文案
「梁谷 60m00s」= **68.59px**，加图标 15 + gap 4 + 左右 padding 16 = **103.59px**；
取 **105px**（约 1.4px 余量）。真实页面验证：`梁谷 5m18s` 的文本区 `scrollWidth =
clientWidth = 70`，把文本临时改成「梁谷 60m00s」仍是 70px、`clipped=false`；按钮整体
`105×24`。

**倒计时紧迫感（用户要求）**：剩余 **≤60 秒** 时不再静态显示，而是出现「倒计时」的动效：

- 新增 `data-offpeak-urgent` 钩子（两处开关共用）：`urgent`（≤60s）/ `final`（≤10s）；
- 样式：`urgent` 用 1s 呼吸动画（内描边亮/暗 + 透明度 1→0.66 的节奏），`final` 加快到
  0.45s 并加粗数字；数字用 `font-variant-numeric: tabular-nums`，每秒跳动时宽度不抖；
- 只在**暂停态且剩余 > 0** 时生效；关/空闲/普通倒计时完全静态（不干扰）；
- `prefers-reduced-motion: reduce` 下关闭动画，保留静态强调。

**验证**：

- 单测 **303/303**（新增固定尺寸断言改为 105px；新增紧迫级别用例：60s/59s→`urgent`、
  10s/9s→`final`、0s/61s/120s→无钩子；hero 同样覆盖）；
- 真实 UI 沙箱：`梁谷 5m18s` 时无钩子、宽度 `105×24`；等到 `梁谷 0m37s` 时
  `data-offpeak-urgent="urgent"`、`animationName=dsh-offpeak-urgent-throb`、
  `animationDuration=1s`，宽度仍 `105×24`；`final` 级别由单测覆盖（真实窗口只抓到 urgent，
  如实说明）；
- `node --check`、locale / 工具名门禁 ✓。

## 6.4.0 — 2026-11-26

### 侧边提问的界面统一为 DSH 官方风格

侧边提问原先用自写内联样式（独立的分组浮层、自绘图标、自定义状态栏），与官方组件观感不一致。
现在四处界面全部对齐官方实现：

- **选中文字的合并弹层**：两个动作各自是官方 Quote 那种**药丸按钮**（`var(--dsw-alias-button-floating-fill)`
  + `var(--dsw-elevation-panel)` + 999px 圆角 + `var(--dsw-font-xs-13)`），不再自绘分组容器与阴影；
  「侧边提问」带官方图标。
- **标题栏入口**：改成官方标题栏同款 **28px 圆形图标按钮**（`--dsw-alias-label-tertiary` 图标色、
  hover `--dsw-alias-interactive-bg-hover`），不再是带文字的 `P.Button`。
- **标签正文状态栏**：用官方右侧栏 title-row 的底与分隔（`--dsw-specific-sidebar-fill` +
  `0.5px solid var(--dsw-alias-border-l3)` + `--dsw-font-xs-13`），「保留」按钮沿用官方 `Button`。
- **图标**：改用 `@deepseek-ai/dsh-client-ui-primitives` 的官方图标 `IconNewChatOutlineRegular`
  （guide 卡片、标题栏入口、弹层动作三处一致）；部署里没有该导出时回退到内置 SVG。
- 手写 bundle 没有 CSS module，样式按本包既有做法插入一张 `<style>`（`data-dsh-enhance-side-ask-style`），
  卸载时移除；全部颜色/字体都走官方 token，并给了兜底值。

## 6.3.2 — 2026-11-26

### 侧边提问入口不再「按记录隐藏」：弹层始终「引用文本 + 侧边提问」，标题栏始终有按钮

**背景**：6.3.1 查明正文注册失败会中断后续注册，使合并弹层退回官方 message-quotes ——
而官方「引用」的中文文案**恰好就是「引用文本」**，所以现象看起来像「弹层里少了侧边提问」，
其实那一页里我们的文字交互注册根本没执行。

**改动**：

- 去掉「本会话已登记为侧边会话就隐藏提问入口」的规则（`isChild` 不再参与显示判定）。
  记录表在浏览器本地、状态不可见，一旦某个正常会话被记过，它的入口就永久消失——比允许嵌套更糟。
- 标题栏「侧边提问」按钮同样不再隐藏。
- 后果：任何会话（包括侧边会话）都能再发起侧边提问（会新建一个引用它的子会话），行为一致可预期。

## 6.3.1 — 2026-11-26

### 修复：侧边提问标签页显示「这类内容还没有可用的查看方式」

**现象**：右侧栏引导页的「侧边提问」卡片能出现（tab 类型注册成功），但点开后正文是 owner 的
通用 fallback（`tab.unavailable`）；同一页面里选中文字的合并弹层正常（说明其它注册成功）。

**根因**：正文走 `sidebar.right.pane.tab` 这个 **keyed** 槽，右侧栏按
`entryKey = definition?.id ?? tab.kind` 派发。原实现只注册了 `key = 'dsh-session-enhance/side-ask'`，
一旦在位的类型 id 与它不同源（旧标签、组件被重复加载、或类型注册与本模块不同源），派发的 key
就落到 kind，正文 key 命不中 → 显示 fallback。另外该注册只包了一层 `slots.inject`，注册本身
抛错时既不会降级也不会留日志。

**修复**：

- 正文**同时注册两个 key**：`dsh-session-enhance/side-ask`（正常路径）与 `sideask`（kind 兜底），
  任一派发方式都能命中；
- 注册逐步 `try/catch`：带私有 session 子槽（框架据此注入 `SessionProvider`）失败时，**降级为
  不带子槽的同一组件**——显示可读的「本部署没有侧栏会话组件」提示，而不是空白/通用 fallback；
- 注册完成后 `console.info('[dsh-session-enhance] side-ask tab body registered', …)`，
  失败时 `console.error` 带上 key 与原始错误，便于下次直接定位；
- 新增 `test/sideask-client.test.mjs` 覆盖：两个正文 key 都被注册、带 session 子槽声明、
  组件行停用（405）时全部撤销。

## 6.3.0 — 2026-11-26

### 新建页按钮改成「梁谷开关」；重启后自动恢复；中断重试官方优先

**按钮语义修正（用户要求）**：新建会话页「标准模式」右侧那个方形按钮，不再是「点一下创建
会话」的自定义动作，而是**和右上角「梁谷」chip 完全一样的开关**：

- 点击只切换当前（新建页空白）会话的梁谷开关：**不创建会话、不导航、不弹 Toast**；
- 开关打开时，这里新建出来的会话**一定就是梁谷会话**（新建页的空白会话 id 就是即将创建的
  会话，直接写开关即可）；
- 显示与 chip 一致：关闭时只显示图标；开启时显示剩余时间（`2h13m`）或「空闲」；
  图标仍是页面右上角方形按钮的同款镜像图标，右上角原按钮保留；
- 删除了 6.2.x 的 `createLiangguSession` Host 端点与 `lib/offpeak/create.mjs`
  （不再由界面代建会话，避免“先在后台建会话、再想办法导航”这条不可靠路径）。

**重启/关闭应用后自动恢复**：梁谷会话在高峰暂停期间排队（官方 durable inbox）的消息，在
应用重启、会话重新打开（`agent/created`）时：

- 若当前是空闲时段且 inbox 有 pending 输入 → 用**官方 continuation 优先**的方式唤醒
  （`sessionController.prompt({ content: [] })`），官方不可用再回退到「中断重试」的空
  retry 消息（`agent.followup`）；
- 若当前是高峰 → 继续 hold，不唤醒；同一 agent 只唤醒一次，不重复 followup。

**「中断重试」组件优化（用户要求）**：点击重试时**先走官方 continuation**
（`sessionController.prompt` 空 content，即官方「继续生成」语义），官方可用时不注入任何
提示词；只有官方不可用/抛错时才回退到一段提示词（`agent.followup` 现有文案）。两条都失败
才向界面报错。

**验证**：

- 单测 **301/301**（client 23：开关四态渲染、点击只 toggle 且不建会话/不导航/不弹 Toast、
  隐藏占位、图标镜像；controller 29：重启延迟复查「仍空闲→注入官方 continuation」「延迟内
  Agent 自己跑起来→不注入」、高峰只 hold、打断场景官方优先/官方忙回退 followup/重复
  reconcile 不重复唤醒；retry host 14：官方成功不 followup、官方抛错→followup、无服务→
  followup、两者都失败→错误）。
- **真实 UI 沙箱（真实 Chrome + 真实 `deepseek-flash`）**：
  - 开关：关 → 只有镜像图标、无文字、无 Toast；点一下 → `paused` 显示 **`9m57s`**
    （≤1 小时「分钟秒」格式）、无 Toast；再点 → 关；再点 → 开；右上角原按钮全程保留；
  - 新建会话的梁谷归属：开着开关、高峰发消息 → 会话排队（`paused 梁谷 暂停 9m45s`、无回复）；
  - **重启恢复（空白会话首条排队消息）**：关掉沙箱服务器（模拟关闭应用）→ 高峰结束后重启
    → 1.2s 延迟复查确认仍空闲 → 注入唤醒；日志：`02:18:27.236Z` 注入空 retry 消息、
    `02:18:27.238Z turn/start`，原排队消息被 claim（`02:18:27.335Z user/message`），
    `02:18:32.9Z` 回复 **RESUME2-OK**；
  - **真实数据取证（已有历史的会话）**：重启后官方自己续跑排队消息（`turn/start` 早于任何
    控制器动作），6.3.0 首版在这里多注入了一次、产生空的 turn 2；随后改为「延迟复查」后
    只在「仍旧空闲」时注入，避免重复。
  - 如实说明：走 followup 兜底时，历史里会多一条紧凑的空 retry 消息（「已请求继续生成」），
    可能对应一次空转 turn；消息不会丢。已有历史且官方自己续跑的场景不会触发兜底。
- 中断重试的「官方优先」由单测覆盖（真实 UI 沙箱未构造「用户中断 + 官方 continuation
  恰好可用」的场景）。
- 界面文案门禁 ✓、工具名门禁 ✓。

## 6.2.3 — 2026-11-25

### 按钮图标与右上角一致（镜像）+ 创建成功先给可见反馈

用户截图指出：新建按钮的图标和页面右上角那个方形按钮**不一样**。核对官方实现：
`ui-sidebar-right/shell/ExpandButton.module.css` 里 `IconPanelLeftOutlineRegular` 带
`transform: scaleX(-1)`（“the left sidebar's collapse icon mirrored”，分隔线在右），
而我们的按钮用的是未镜像的原图标（分隔线在左）。

- 图标改为同样的 `scaleX(-1)` 镜像（内联 SVG 兜底也一起镜像），与右上角按钮一致；
- 创建成功后先弹一条「已创建梁谷会话，正在打开…」Toast（600ms）再导航。原因是新会话是
  **空白会话**，页面外观和原新建页几乎一样，没有提示时容易被误判成“按钮没反应”；
- 单测新增图标镜像断言与成功提示断言；302/302。

## 6.2.2 — 2026-11-25

### 修正 6.2.1 的归因与验证记录；客户端导航改为多间隔重试

6.2.1 的发布说明把桌面现象归因成「创建成未挂工作区的孤儿会话」。事后按真实数据结构
（`workspace.json` 的 `tables.workspaces`，而不是误读的顶层 `records`）重新核对：
**7 个点击创建的会话其实都挂在 `dsh-plugins` 工作区里，且全部是空白会话**——创建与归属
一直成功，缺的是**客户端导航**（新会话还没进入客户端列表就 `openSession`，异常被兜底吞掉；
空白会话页面又和原页面视觉相同，用户才连续点击）。6.2.1 的代码修复方向不变（客户端
refresh/重试 + Host 冷会话兜底），本版只做两件事：

- **修正文档归因**：CHANGELOG 6.2.1 与 README 验证行改为「导航竞态为主因、Host 冷会话
  隐患为次因」，并如实记录 7 个会话已挂工作区、均为空白；
- **客户端导航加固**：refresh 之后按 `150/400/900ms` 再重试几次 `openSession`（对同一目标
  幂等），进一步降低列表晚到导致不跳转的概率（6.2.1 只在没有 refresh 接口时重试一次）。

纯文档纠正 + 小加固，单测仍 **302/302**。

## 6.2.1 — 2026-11-25

### 修复：「新建梁谷会话」按钮在真实桌面环境点了没反应（导航竞态 + 冷会话兜底）

**现象**：桌面 profile 里点按钮看起来完全没反应。核对真实数据：每次点击其实都**成功创建了
一个空白会话，并正确挂到了当时的工作区**（`workspace.json` 的 `dsh-plugins` 分组里能看到），
但界面**没有跳转到新会话**；而且新空白会话页面和旧页面长得一模一样，于是用户连续点了 7 次
（`offpeak.json` 里 7 个 `enabled:true` 会话、时间集中在 9 秒内）。

**根因（两个层面）**：

1. **主因（客户端导航竞态）**：RPC 返回新会话 id 后立刻调用 `uiWorkspace.openSession(newId)`，
   而新会话可能还没进入客户端会话列表（Host 的列表刷新事件未到）。`openSession` 失败被兜底
   `catch` 吞掉，界面留在原来的空白页——看起来就是“按钮没用”。
2. **次因（Host 冷会话隐患）**：旧实现只从 live Agent 的 header 取 cwd/工作区；如果源会话是
   还没有 live Agent 的空白会话（某些入口会这样），就会退化成“不带 workspaceId 建会话”，
   新会话将**不挂任何工作区**，即使客户端刷新列表也导航不到。本次桌面实测源会话有 live
   Agent，所以没有触发，但这类环境必须防住。

**修复**：

1. **客户端（主修复）**（`client.js`）：创建成功后先 `ctx.sessions.refresh()`（存在时）再
   `uiWorkspace.openSession(newId)`；没有 refresh 接口时补一次 300ms 延迟重试，消除
   “新会话还没进客户端列表就导航”的竞态；
2. **Host 冷会话兜底**（新模块 `lib/offpeak/create.mjs`，从 `offpeak/index.js` 抽出可单测）：
   源会话头 live Agent 优先，其次从持久化读
   `sessionQuery.traceSession(sourceSessionId).target.header`——冷会话/空白会话同样能拿到
   `cwd` 与 `agentPreset`；
3. **工作区归属**：优先按「源会话是否为该工作区成员」（`workspace.sessionIds`）判断，其次按
   cwd 调 `workspaceRegistry.resolveByPath`；找到就带 `workspaceId` 创建，Host 会把新会话
   attach 进工作区；万一走了 cwd 分支再显式 `workspace.attachSession()` 兜底。

**验证**：

- 单测 **302/302**（新增 `test/offpeak-create.test.mjs` 7 例：冷会话经持久化 header
  取 cwd + 成员关系带 workspaceId、resolveByPath 分支、无工作区回退 cwd、live/header
  preset 两条路径、显式 attach 兜底、UNAVAILABLE/CREATE_FAILED/无 id 失败且不写开关）。
- **真实 UI 沙箱复现+验证**（同时装 `dsh-ungrouped` 让页面显示「未分组」，与桌面环境一致）：
  重启后点按钮 → 行从旧空白会话切到新的 `session-c888e7a6…`；`workspace.json` 的
  「未分组」`sessionIds` 里出现该 id；`offpeak.json` 写入 `enabled:true`；在新会话里发
  「按钮验证：只回复 FIX-OK」→ 日志确认该消息与 assistant 回复都落在 `session-c888e7a6…`
  （旧空白会话保持 0 条消息）——创建、归属、导航三件事都成立。
- `node --check` 全部改动文件；界面文案门禁 ✓、工具名门禁 ✓。

> 旧版本点按钮留下的 7 个空白会话没有删除（属于用户数据，都是空会话，且已挂在
> `dsh-plugins` 工作区里），可在侧边栏里自行删除。

## 6.2.0 — 2026-11-25

### 新能力：「新建梁谷会话」按钮；高峰倒计时改成小时-分钟 / 分钟-秒；子代理覆盖补全

> 本版基于 6.1.0（新增「侧边提问」组件）之上，只改梁谷组件。

**新增按钮**：新建会话页（「未分组 / 标准模式」那一行）在**预设下拉框右侧**新增一个方形图标
按钮，图标复用页面右上角那个方形按钮（`IconPanelLeftOutlineRegular`，右上角原按钮保留）。
点击 = 创建一个新的**梁谷会话**：Host 在源会话所在工作区新建空白会话并把该会话的梁谷开关
写为启用，然后浏览器打开新会话；高峰时段会立刻按暂停处理，空闲时段则正常。

- 客户端注册在真实 slot `conversation.hero.options`（list / session scope），并用注入的
  `:has()` 样式把该行的 `heroOptions` 容器从行尾拉回预设右侧；按钮带 `data-dsh-lianggu-new`。
- Host 新增 RPC 端点 `createLiangguSession`（payload `{sessionId}`）：`sessionController.create`
  同一工作区建空白会话（`workspaceRegistry.resolveByPath` 解析工作区、`agentPresets.presetForSession`
  沿用 preset），成功后 `controller.setEnabled(newId, true)`；失败返回 `UNAVAILABLE` /
  `CREATE_FAILED`，界面用 Toast 报错。
- 没有 `sessionController` 的部署里该端点返回 `UNAVAILABLE`（status/setEnabled/diag 不受影响）。

**倒计时格式**（用户要求）：高峰暂停时 chip 上的剩余时间——
- 剩余 **> 1 小时**：`3h05m`（小时 + 两位分钟）；
- 剩余 **≤ 1 小时**：`12m34s`（分钟 + 两位秒；不足 1 分钟显示 `0m42s`）。

**子代理覆盖补全（用户要求「整个会话，含它的子智能体们」）**：`coveredOf` 改为**先检查祖先
会话的启用记录，再看它有没有 live Agent**——父会话已关闭（没有 live Agent）但开关仍写着启用时，
它的子代理也必须被梁谷覆盖；父会话既不在线也没记录时仍不覆盖。新增单测覆盖这两种情况。

**验证**：

- 单测 **296/296**：新增 `formatOffpeakCountdown` 边界（>1h=`3h05m`、59m59s、1h整点=`60m00s`、
  不足1分钟=`0m42s`、非法/负数=`0m00s`）、`LiangguNewSessionButton` 渲染（data 钩子/标题/busy
  禁用/能力停用与无 session 隐藏占位/失败 Toast）、点击流（busy 同步、RPC method+payload、
  成功后 `uiWorkspace.openSession(新id)`、失败码与无连接文案、不误开新会话）、hero slot 注册
  （`conversation.hero.options` / id / order / locale）与词典键集；Host 侧新增
  「父会话离线但启用 → 子代理仍被 hold/cancel」「父会话离线且无记录 → 不 hold」以及
  `createLiangguSession` 端点 6 例。
- **真实 UI 沙箱（真实 Chrome + 真实 `deepseek-flash`，6.2.0）**：
  - 新建会话页「标准模式」右侧出现方形按钮（实测预设 rect `546–652`、按钮 `654–682`，间距
    **2px**），图标与右上角「打开右侧边栏」按钮同款，**右上角原按钮保留**；
  - 点击 → Host 创建新会话 `session-30b463a5…`，`offpeak.json` 写入
    `{"enabled":true}`；新会话第一条消息后 chip=`paused`、文本 **「梁谷 暂停 1h17m」**
    （>1 小时 → 小时+分钟），title 含高峰时段、「将在 21:33 自动恢复」「队列中 1 条消息」；
  - 新会话日志只有一条 `agent/inbox/spliced`（20:15:10.097Z），**无 `turn/start`、无
    `assistant/message`**（按钮建出来的会话确实处于暂停）；
  - 按钮失败/无连接路径由离线单测覆盖（沙箱未构造失败注入）。
- ≤1 小时倒计时格式（`12m34s` / `0m42s` / `60m00s`）由单测钉死；真实沙箱只跑了 >1h 分支
  （时间窗覆盖不足 1 小时的场景没另配一套沙箱）。
- 界面文案门禁 ✓、工具名门禁 ✓。

## 6.1.0 — 2026-11-25

### 新组件「侧边提问」（`dsh-session-enhance/sideask`）

从独立插件 `dsh-side-ask` 合并进来的第五个组件，并按需求重做了问答模型：

- **不再 fork 原会话**：侧边会话用 `sessionController.create` 新开一个普通会话（沿用原会话的
  工作区与 Agent 预设），把原会话 id 写进**询问提示词**，让模型用 `session_overview` /
  `session_grep` / `session_read` / `session_lookup` 按 id 查询需要的内容。侧边会话不背原会话的
  上下文预算，也不继承思考/工具轨迹。
- **只读**：创建后立即切到 `read-only` 权限预设；**fail-closed**——只读切不上就归档刚建的会话
  并报错。模型请求提权时走审批，默认拒绝。
- **保留 = 普通会话**：点「保留」恢复原会话当时的权限预设（可写），关闭标签也不归档；
  「改回临时」再切回只读。
- **三个入口**：右侧栏引导页（guide）卡片、标题栏按钮、选中文字的合并弹层（「引用文本」+
  「侧边提问」并排；接管官方 `quote` 表面，组件停用时自动撤销并恢复官方表面）。
- Host 半提供 RPC `/dsh-session-enhance-sideask`（probe / create / setPreset / restore / forget），
  浏览器半先渲染再探测，行停用即撤下全部界面。
- 新增 `sideask/` 组件行、`lib/sideask/`（prompt / rpc / host）与测试：`test/sideask.test.mjs`
  （提示词、RPC 信封、创建/只读 fail-closed/恢复）、`test/sideask-client.test.mjs`（注册形状、
  探测撤下、记录表、引用格式化）；`test/entries.test.mjs` 增加第五个入口断言。
- 独立插件 `dsh-side-ask` 已并入本包：本地目录与 profile 行移除，GitHub 仓库归档。

## 6.0.0 — 2026-11-25

### 破坏性修正：第四个组件更名「梁谷」，并按 DeepSeek 官方「空闲时段」口径重做时间判定

**用户纠正的两点**：

1. 组件名是 **「梁谷」**（5.7.0 里叫「谷峰会话」是错的）。
2. 我之前把「谷时」实现成每天 00:30–08:30 的单窗口，**这是错的**。官方文档《模型 & 价格》
   对空闲/高峰的定义是：

   > 空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）
   > 9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天
   > 均为空闲时段。

   也就是说：**高峰 = 工作日两个上午/下午时段；午休、夜间、周末、法定节假日全天都是空闲。**

**改动（破坏性：Config 字段与 status 字段都变了）**：

- `lib/offpeak/window.mjs` 重写为「高峰时段」模型：
  - `DEFAULT_PEAK_WINDOWS = '09:00-12:00,14:00-18:00'`；`timeZone` 默认 `Asia/Shanghai`；
  - 判定顺序固定为 **周末 → 法定节假日 → 高峰窗口**：周末全天空闲（即使官方把某个周六
    调成上班日，DeepSeek 口径仍按「周一至周五」）；工作日落在节假日表里也全天空闲；
    其余工作日命中任一高峰窗口才算高峰；
  - `nextBoundary()` 遍历未来日历日的**高峰日窗口起点/终点**取最近一次切换：窗口起点
    → `pause`，窗口终点 → `resume`；于是周五 18:00 之后的下一次暂停是**下周一 09:00**，
    连续节假日会自动跳过去；
  - 内置 **2026 年中国法定节假日**（国务院办公厅 2026 年放假通知：元旦 01-01..01-03、
    春节 02-15..02-23、清明 04-04..04-06、劳动 05-01..05-05、端午 06-19..06-21、
    中秋 09-25..09-27、国庆 10-01..10-07）。周末本来就空闲，列全日期只为便于人工核对；
    跨年后需要更新节假日表（或把 `holidays` 配置成空串表示不享受节假日豁免）。
  - 非法 `peakWindows` / `timeZone` / `holidays` 逐项回退默认并记 `issues`，只在启动时 warn 一次。
- Config 四个 volatile 字段改为：`peakWindows`（默认 `'09:00-12:00,14:00-18:00'`；
  逗号分隔的 `HH:MM-HH:MM`，起点含终点不含）、`timeZone`（默认 `Asia/Shanghai`）、
  `holidays`（默认 2026 日期串；空串=不豁免节假日）、`defaultEnabled`（默认 false）。
  **旧的 `offPeakStart` / `offPeakEnd` 已删除**，profile 补丁层里如果写过会不再生效。
- `status` 契约改为：`{ enabled, enabledSource, paused, idle, schedule:{ peakWindows,
  timeZone, holidaysCount }, serverNow, nextChangeAt, nextChangeKind, cover, persisted,
  build }`；删掉 `window` 与 `offPeak`。`diag.paused` 仍是全局「当前是否高峰」。
- 浏览器半（`client.js`）：所有用户可见文案改为「梁谷 / 空闲时段 / 高峰时段」；chip 四态
  `off` / `paused` / `idle` / `busy`；title 里展示「高峰时段：周一至周五 09:00–12:00、
  14:00–18:00（Asia/Shanghai，法定节假日与周末除外）」与下一次自动切换时间。原有 15 秒
  轮询 / 1 秒倒计时 / 能力探测 405 隐藏 / 失败 Toast 机制不变。
- 组件 locale（`offpeak/locale/{zh,en}.json`）标题改为「梁谷」，描述按官方口径重写。

**行为不变的部分**：峰时「把 Agent 用 maintenance hold 钉住 + running 同步 cancel 兜底」、
排队输入进入 durable inbox、空闲开始自动释放续跑、回合中途被暂停后补 continuation 空消息、
子代理沿祖先链一起覆盖、每会话开关持久化 `offpeak.json`、组件可单独启停——这些都是
5.7.0 已验证过的机制，本次只换时间口径与命名。

**验证**：

- 单测 **268/268**（`offpeak-window` 15 例重写：工作日 09:00–12:00/14:00–18:00 两段峰时与
  边界、午休/夜间空闲、周末全天空闲、2026 节假日工作日空闲（01-01 周四、02-23 周一）、
  节后恢复、周五 18:00 后下一次 pause=下周一 09:00、连续节假日自动跳过、跨时区 DST、
  非法 `peakWindows`/`holidays`/时区回退；controller/rpc/entries/client 同步新契约）。
- 独立离线复核（verifier，不依赖实现的自写断言）：**64/64 PASS**——固定时间戳的
  `isPeakAt` 表（工作日 10:00 峰、12:30/13:59 空闲、14:00 峰、17:59 峰、18:00 空闲、
  周六/周日全天空闲、2026-01-01 周四空闲、2026-02-23 周一空闲、2026-02-24 周二峰）、
  `DEFAULT_HOLIDAYS` 与国务院 2026 通知逐段核对（33 天）、`nextBoundary`
  （11-25 12:30→当日 14:00、11-27 周五 18:30→11-30 周一 09:00）。
- 真实 Loader 冒烟（headless 沙箱）：compose 输出 **4 行**（含 `dsh-session-enhance-offpeak`），
  任务 exit 0、stderr 空。
- **真实 UI 沙箱（lead，真实 Chrome + 真实 deepseek-flash）**：profile patch 把
  `peakWindows` 设为 `09:00-18:22`（当时 18:19 处于高峰、边界 18:22）：
  - 默认 chip 文本「梁谷」、title 含「高峰时段：周一至周五 09:00–18:22（Asia/Shanghai，
    法定节假日与周末除外）」；
  - 18:19:02 点开关 → `paused`、文本「梁谷 暂停 2m51s」、title「将在 18:22 自动恢复」
    「队列中 1 条消息」；18:19:04 发「梁谷验证：只回复 LIANGGU-QUEUED-OK」→ **无回复**；
  - 会话日志：seq20 `agent/inbox/spliced` time=`2026-11-25T10:19:04.159Z`，之后
    **2m56s 内只有这一条 inbox splice，零 `turn/start`、零 `assistant/message`**；
    seq21 `turn/start` time=`2026-11-25T10:22:00.012Z`（**边界 18:22:00 后 12ms**）→
    seq25 `assistant/message` 10:22:05.442Z；chip 变 `idle`「梁谷 空闲」、队列清空、
    title「将在 09:00 自动暂停」（下一次高峰为次日 09:00，与配置一致）。
  - 独立 verifier 另验：插件页「包含的组件 共 4 个 · 4 运行中」第 4 行为中文「梁谷」。
- 界面文案门禁 ✓（包根卡片 + 组件 locale 中文「梁谷」）、工具名门禁 ✓。

> 5.7.0 的条目保留在下面作为历史记录；那一版的时间窗实现（00:30–08:30）**不要使用**，
> 6.0.0 才是按官方口径的实现。

## 5.7.0 — 2026-11-25

> **此版本已被 6.0.0 取代**：组件名「谷峰会话」改为「梁谷」，且这里的空闲时段实现
> （每天 00:30–08:30 单窗口）**不符合官方口径**，不要使用；详见上方 6.0.0。以下为当时记录。

### 新能力：第四个组件「谷峰会话」——峰时暂停、谷时自动恢复

**它是什么**：会话标题栏右上角新增「谷峰」开关。打开后，在 DeepSeek 峰时（默认 = 谷时窗口
00:30–08:30 以外的所有时间）暂停该会话的模型调用：用户发出的提示留在**官方 durable 队列**
（composer 上方的 Queue dock），不会开始任何模型请求；谷时一到自动释放队列并按顺序续跑。
峰时开始的那一刻正在跑的回合会被中断（保留队列），谷时自动补一条官方 continuation 形状的空
消息（聊天里显示「已请求继续生成」）续跑。窗口 / 时区 / 新会话默认启用都可在设置页改；
子代理会话（沿 `session.header.parentSession` 的祖先链）一并覆盖。

**为什么这样做（机制取舍）**：第一直觉是用 `agent/pre-step` 返回 `{kind:'reject'}` 拦住模型
调用。但按运行时文档与源码，被 reject 的那一步里 `inbox.claim()` 取走的提示**既不会落
`user/message`、也不会退回 inbox**——用户消息会凭空消失，历史里只留一个 blocked 空轮。
最终采用三层：

1. **hold（主）**：对 idle Agent 调 `runMaintenance()` 挂起维护相位。`agent.status` 仍是
   `idle`（UI 不显示"运行中"），此间 `agent.followup()` 的消息写进 durable inbox 并置维护相位的
   `wakeRequested`；维护期一结束，运行时**自动唤醒**排队的输入——这就是"谷时自动恢复"。
2. **安全网（次）**：`agent/status: running` 的监听里同步
   `agent.cancel({ kind:'hook', reason:'offpeak-pause' }, { keepInbox: true })`。这发生在
   `wakeDriver` 同步派发状态、`kick()` 还没 append `turn/start` 的窗口里，所以拐点上的回合
   被 abort 在模型调用之前、消息仍留在 inbox（实测会话日志：无 `turn/start`、无 `assistant/*`，
   只有 inbox splice）。
3. **补齐**：`agent/created` 本身在创建流程自己的 `runMaintenance` 里派发，此时再
   `runMaintenance` 会抛 `"already has active work"`；所以创建后只排一次延后 reconcile，由
   `agent/status: idle` 与 1 秒 reconcile 兜底 arm。

**新增**：

- Loader 行 `dsh-session-enhance-offpeak`（`offpeak/index.js`，组件标题「谷峰会话」）；
- `lib/offpeak/window.mjs`：HH:MM / IANA 时区 / 跨午夜窗口 / 下一次边界，纯函数；非法配置逐字段
  回退默认并只 warn 一次；
- `lib/offpeak/store.mjs`：`<DSH_HOME>/dsh-session-enhance/offpeak.json` 每会话开关（原子写、
  容量 500 按 updatedAt 淘汰、损坏时备份成 `.corrupt-<ts>.bak` 后从空表继续、写盘失败只让 RPC
  返回 `persisted:false` 而不阻止开关生效）；
- `lib/offpeak/controller.mjs`：`coveredOf`（本会话或任一 live 祖先会话启用即覆盖）、
  hold / cancel / reconcile、1 秒 tick（只在峰时且有覆盖会话时开）、边界精确 `setTimeout`
  （只在边界变化时重建）、释放后按「队列有消息但没 wakeRequested」或「interrupted」补续跑消息；
- `lib/offpeak/rpc.mjs`：`/dsh-session-enhance-offpeak`（status / setEnabled / diag；admit 认证 +
  prefix 路由，沿用分享 / 中断重试已验证的配方）；
- 浏览器半：标题栏 `conversation.session.header.utilities` 槽位 order `-12` 的「谷峰」chip
  （off / paused+倒计时 / active / busy 四态、失败 Toast、15 秒轮询 + 1 秒倒计时、能力探测
  405 时换隐藏占位）；en/zh 各 18 个 `offpeak.*` 词条；`data-dsh-offpeak-button` /
  `data-offpeak-state` / `data-offpeak-enabled` 测试钩子；
- Config 四个 volatile 字段：`offPeakStart`（默认 00:30）、`offPeakEnd`（默认 08:30）、
  `timeZone`（默认 Asia/Shanghai）、`defaultEnabled`（默认 false）；
- `package.json` 的 exports/files/keywords、`cordis.patch.yml` 第四行、
  `offpeak/locale/{en,zh}.json`。

**行为与边界**：

- `status.paused = enabled && 峰时`（本会话），`diag.paused` = 全局峰时；
- 开关即时生效：峰时打开立即暂停（必要时中断当前轮）；关闭立即释放，队列里的消息马上开始跑；
- 子代理覆盖：沿 live 祖先链判断，禁用父会话时子树 hold 一并释放；
- 不经过 Agent 的辅助模型调用（例如手动「翻译推理」这类直接调 `llm` 的按钮）不在暂停范围内；
  被中断轮次里**已经执行完**的工具调用不会回退；
- 没有 `agents` 服务的部署（headless 等）里组件干净激活但无事可做；Host 重启后开关偏好仍在
  （`offpeak.json`），hold / interrupted 是进程内状态、重启后按「峰时该暂停」重新推导；
- 停用 `dsh-session-enhance-offpeak` 行 → RPC 落 SPA fallback（405）→ chip 换成隐藏占位，
  该会话立即不再暂停。

**验证**：

- 离线：单测 **262/262**（新增 `offpeak-window/-store/-controller/-rpc` 与 `offpeak-client`
  用例：窗口边界/跨午夜/非法配置、原子写/容量/损坏容忍、创建窗口 arm、首个 prompt 在 arm 前被
  cancel、running→cancel keepInbox、队列消息不被误 cancel、释放续跑、子代理覆盖正/负、
  禁用/dispose、RPC 端点与入参校验、浏览器半注册/词典/状态机/轮询清理）；`node --check` 全部
  改动文件；
- 真实 Loader 合成（headless 沙箱）：`devkit_sandbox_compose` 输出 **4 行**（含
  `id: dsh-session-enhance-offpeak` / `name: dsh-session-enhance/offpeak`），headless 跑任务
  exit 0、stderr 空（无 `did not activate`）；
- **真实 UI 沙箱端到端（主链路，lead 复核）**：web 沙箱、真实 Chrome、真实 `deepseek-flash`；
  profile patch 把谷时窗口设为 15:53 开始，15:41 点开关（`paused` + 倒计时 11m24s）并发
  「只回复 VALLEY-QUEUED-OK」：
  - 会话日志 seq34 `agent/inbox/spliced` time=`1795592505.47`（15:41:45.47）之后 **8m48s 内
    只有这一条 inbox splice，没有任何 `turn/start` / `user/message` / `assistant/message`**
    ——暂停期 0 次模型调用；
  - seq35 `turn/start` time=`1795593180.02`（**15:53:00.02，窗口起点后 20ms**）→ seq42
    `assistant/message` 15:53:06.66；UI 回复 `VALLEY-QUEUED-OK`、chip 变 `active`、队列清空；
  - 暂停中刷新页面：chip 仍 `paused`、队列条仍显示那条消息（状态来自 Host，不是前端内存）；
  - 关开关后发「只回复 DIRECT-OK」→ 立即进入「深度求索中」并 25 秒完成（对照组成立）。
- **独立验证（verifier，另一沙箱 + 另一模型会话）**：A–F 全绿，另加「回合运行中切暂停」e2e：
  seq39 `turn/start` 15:51:58.698 → 点暂停 → seq47 `turn/end`
  `reason:{kind:"aborted",reason:{kind:"hook",reason:"offpeak-pause"}}` 15:51:59.756（该轮
  **无** `assistant/message`）→ seq49 `turn/start` 15:54:00.002（窗口起点后 2ms）→ seq54
  `assistant/message` 15:54:17.017；UI 依次显示「已停止」「已请求继续生成」「已完成」。
  同一验证里确认：暂停期 15:27:11.773（inbox splice）→ 15:36:00.008（`turn/start`）之间
  **零** `turn/start` / `assistant/message`；`offpeak.json` 落盘为
  `{"version":1,"sessions":{"<id>":{"enabled":true,...}}}`；插件页「包含的组件 **共 4 个 ·
  4 运行中**」第 4 行是中文「谷峰会话」（不是包名/子路径）；停用该行后 chip 换成
  `data-offpeak-hidden="disabled"`、`POST /dsh-session-enhance-offpeak/status` 返回 **405**，
  重新启用后 chip 恢复；
- 界面文案门禁：`check-plugin-locale.mjs` ✓（卡片标题/描述中文化）；工具名门禁：
  `check-tool-names.mjs` ✓（本组件不注册工具）。

## 5.6.6 — 2026-11-25

### 文档：README 补「加载方式」标记（devkit 约定 §10.0）

纯文档改动，无行为变化：按约定 §10.0 判定本包为 **常驻（UI + 诊断）**，并在 README 顶部写明。
标记行原文：

```text
加载方式：常驻（理由：UI 类 + 诊断类——3 个界面组件常驻，5 个 `session_*` 诊断工具要求任意模式随时可用；约 6.5k 字符 schema 是"常驻里最贵但确实要随时可用"的一类）
```


## 5.6.5 — 2026-11-20

### 记录 5.6.4 的终局验证方法：用 asar 里的**官方投影定义**跑双向对照

5.6.4 的门禁 4 是 `Session.fromRestore`，而它**不校验** `turn/end.reason`——挡病因 B 的是门禁 3。
为了证明「修完之后用户真的能打开历史」，5.6.4 交付时又做了一次**投影层**验证，方法留档：

1. 从 `app.asar` 抽出三个文件/包（`app.asar` 头部 12B 处读 header JSON 长度，文件内容在
   `8 + headerSectionSize + offset`；本次 592 个 zod 文件 + `@deepseek-ai/dsh-brand` +
   `@deepseek-ai/dsh-api-session-controller/src/continuation.ts`）。
2. 把 `zod` 与 `dsh-brand` 放到 `node_modules/`，`continuation.ts` 直接 `import`——Node ≥22.18
   默认剥离类型，`import type` 会被擦除，只需要 `brandNumber` 与 `z` 两个真实运行时依赖。
3. 对整份日志逐事件 `def.apply(state, event)`，最后取 `def.wire.view(state)`。

**结果（双向对照）**：

- 修复后（含修复后新追加的事件，1732 条）：`ok: true`，`view: null`（可继续，无失败回合）。
- 修复前的 `.bak-` 备份：**一字不差复现用户看到的错误**——
  `TypeError: Cannot read properties of null (reading 'kind')` at `continuation.ts:46:42`。

> ⚠️ 这条没有内置进脚本：它依赖 asar 内部路径（`src/continuation.ts`、`@deepseek-ai/dsh-brand`），
> 跨 DSH 版本可能变。**门禁是否内置，判断标准是「路径变了会不会静默放过」**——会，所以先留手工步骤；
> 将来若要内置，必须「抽不到就明确报错/要求 --allow-missing-projection」，不能静默跳过。

## 5.6.4 — 2026-11-20

### `repair-session-log.mjs` 新增病因 B：修 `turn/end.reason === null`（DSH 投影层崩溃）+ 并发写保护

**背景**：用户报「历史加载失败：failed to project session `session-01916ad6` … Cannot read
properties of null (reading 'kind')（gateway/internal）」。`session_lookup` / `readSession` 都正常，
只有 GUI 打不开历史——说明坏在**投影层**而不是重放校验。

**病因**（运行时源码 + 日志双向确证）：`dsh-commander-mode` ≤ 7.25.0 的退化看门狗调用
`agent.cancel({ kind: 'degeneration' }, { keepInbox: true })`，而 `AgentCancelCause` 是**封闭 union**
（`user | parent | hook | disposed`）。`agent-loop/src/agent.ts:94-109` 的 `abortedCancelCause()`
用 exhaustive switch 归一化，未知成员走 `assertNever()` 抛错；异常发生在 `finally` 之前，
`turnEnds` 仍是 `null`，`finally`（同文件 428 行）照样
`append('turn/end', { turn, reason: turnEnds! })` → 持久化出
`{"type":"turn/end","data":{"turn":N,"reason":null}}`。

这条事件能过 `Session.fromRestore`（只校验信封 / seq / surface / header），但投影层必崩：
`api/session-controller/src/continuation.ts:46` 读 `event.data.reason.kind` → TypeError
（`history/controller.ts:172` 用 `projectionMode: 'all'` 调 `observeSession`）。服务端另有
`subagent/src/projection.ts:93` 与 `lifecycle.ts:83`、`core/agent/src/consumed-work.ts:43` 读同一
字段，客户端十余处也是同样写法。

**改动**：

- `scripts/repair-session-log.mjs`：
  - 新增「病因 B」识别与修复：`turn/end.data.reason` 为 `null` / 缺失 / 非对象时，改写为合法值。
    默认 `{"kind":"aborted","reason":{"kind":"legacy"}}`（DSH 给「原始记录没带 cause 的导入」
    准备的成员；客户端只显示「已停止」，不会伪造「进程已退出」）；新增 `--cause <JSON>` 可写入
    已知确切原因。
  - 新增**门禁 3**：`turn/end.reason` 结构不变量（对象 + `kind` ∈ `TurnEndReasonMap` 已知成员 +
    `aborted.cause.kind` ∈ `user|parent|hook|disposed|legacy` + `error` 必须有 `error.code`）。
    这道门禁是专门挡病因 B 的——`fromRestore` **不校验**该字段。
  - 新增**并发写保护**：读入后若文件 `size/mtime` 变化（会话仍活着、正在 append）就拒绝写回，
    避免覆盖并发追加的事件。
  - 主流程改为两类病因可并存：没有可修项才退出；有病因 A 时仍按原逻辑删事件 + 重编号 + 重映射。
- `README.md`：该节改写为两类病因、五道门禁、`--cause` 用法与并发写保护。

**验证**：

- 单测 `node --test` 全绿。
- 真实数据：全库 **798 份**会话日志扫描出 **17 个** `turn/end.reason === null` 的会话
  （跨 3 个工作区；15 个紧跟在「退化输出看门狗」通知之后，2 个是 0.8.x Worker Session 时代
  的旧代码）。17 份全部：dry-run 五道门禁通过 → `--apply` 写回（各自 `.bak-<时间戳>` 备份）→
  复核「已无可修项」；再全库重扫 **0 个残留**。
- 目标会话 `session-01916ad6`：1708 事件、`fromRestore` 通过（surface 576 节点）、
  重打包回读一致。

## 5.6.3 — 2026-11-19

### 适配 DSH 0.2.2-rc.5：删除路由上的 master-only `auth` 键，准入由 handler 内 `connection.admit` 保证

**背景**：上一轮适配按 master 基线（checkout `39163dd30f`）写了「DSH 0.2.2-rc.3 起
`webServer.register()` 路由默认 `auth: 'required'`、未登录请求会在进入 handler 前被拒（503），
所以分享页必须显式 `auth: 'anonymous'`」。该机制**只存在于 master**：rc.5 的 `WebRoute`
只有 `kind` / `path` / `handler`（`packages/host/webserver/src/index.ts:52`），`register()`
只做 `table.set(path, route)`（同文件 :445），没有路由级认证，也没有 `webserver/authorize`
事件或 503。

**改动**：

- `lib/public.mjs`：删除分享页路由对象上的 `auth: 'anonymous'`；注释改写为 rc.5 事实
  （rc.5 无路由级 auth 字段，本路由的准入边界是 URL 里的随机 token；旧版 `auth` 键在 rc.5
  被静默忽略，本次删除以免误导）。
- `test/routes.test.mjs`：重写为「四条路由注册对象都无 `auth` 字段」+「分享页 handler 行为
  （未知 token 404 / 非 GET·HEAD 405 / 合法 token 200）」+「三条 RPC 路由仍以
  `connection.admit` 为准入（拒绝 401/403 不进业务、放行才进业务）」。
- `README.md`：分享路由一节改写为 rc.5 事实（路由级 `auth` 只在 master 存在，rc.5 没有
  该字段；三条 RPC 的唯一准入是 handler 内 `connection.admit`）。
- **保留**三处 handler 内的 `connection.admit(req)`：rc.5 上它是 RPC 通道的**唯一**准入，
  且 `PeerAdmission` 只有 `{ peer }` / `{ rejection: 401 | 403 }`（没有 503）。
- 并删除 `subagents.listChildren` / `agentTeams.listMembers` 两处旧版死 fallback：
  `lib/subagent/host.mjs` 的 `listDirectChildren` 不再探测 `listChildren`（rc.5 只有
  `listDescendants`，没有该 API 时返回 `[]`）、`childIdentityOf` 不再探测 `listMembers`
  （rc.5 的 Team 只剩任务板），`diag` 的 `subagentListing` 也不再报 `listChildren`。

**验证**：

- 单测 `node --test`：**189/189** 通过（`test/routes.test.mjs` 由 3 例重写为 4 例；
  `test/subagent.test.mjs` 的夹具与两处用例按 rc.5 语义改写，数量不变）。
- 断言有效性做过变异验证：把 `auth` 键加回、把分享 RPC 的 `admit` 绕开、把
  `listChildren` fallback 加回，三处改动分别让对应用例失败（不是恒真断言）。
- `node --check` 改动文件全过。
- 依据：`git -C E:\deepseek-harness show dsh-v0.2.2-rc.5:packages/host/webserver/src/index.ts`
  → `export interface WebRoute { kind; path; handler }`（第 52 行）、
  `register(route: WebRoute | WebResourceRoute)` 仅 `table.set`（第 445 行），全文件无
  `503` / `authorize`；`packages/client/connection/src/rpc.ts:119` →
  `PeerAdmission = { peer } | { rejection: 401 | 403 }`；`subagents` / `agentTeams`
  服务方法表在 rc.5 没有 `listChildren` / `listMembers`。

## 5.6.2 — 2026-11-17

### 修复：工具名 `session_search` 与随附包撞名，导致官方「会话搜索」插件整行报异常

**现象**（用户截图）：「设置 → 插件 → 实验性插件 → 会话搜索」页里，「包含的组件」下的
**会话历史工具**（`optional-tool-session-query` / `@deepseek-ai/dsh-tool-session-query`）
显示 **异常**，原因：

```
tool "session_search" is already registered (for a per-agent variant, register
through that agent's `agent.ctx` instead)
```

**是我 5.6.0 引入的回归**：那一版新增的「会话内检索」工具取名 `session_search`，而随附包的
`dsh-tool-session-query` 注册的五个工具里第一个就是 `session_search`（另外四个是
`session_event_search` / `session_event_read` / `session_trace` / `session_event_trace`，
抄自 `app.asar` 的 `dsh-tool-session-query/src/index.ts`）。工具注册表对重名**硬失败**，
于是后注册的那一侧整行激活失败——官方那行被标成「异常」，它的五个工具（含跨会话检索）
全部不可用。

**修法**：

- 本插件的会话内检索改名 **`session_search` → `session_grep`**（语义也更准：字面匹配、
  大小写不敏感、不走 FTS 索引）。`session_lookup` / `session_overview` / `session_read` /
  `session_resume_subagents` / `session_share` 与官方名字不冲突，保持不变。
- 新增门禁测试「工具名不得与随附包的官方工具重名」：把官方那五个名字抄成常量清单
  （注明版本与来源文件），注册出来的每个工具名与之相交就失败——下次再撞名会先在单测里红掉，
  而不是让用户在插件页看到红字。升级 DSH 后需复核该清单。

**验证**：

- 单测 **189/189**（新增重名门禁 1 例；工具名断言改为 `session_grep`）。
- 归因证据：`git show <5.6.1>:lib/tools/search.mjs` 里正是 `name: 'session_search'`；
  全工作区扫描确认**没有其它插件**注册这个名字（其余命中只是测试夹具）。
- devkit headless 沙箱（真实 Loader + 真实注册表）：用一次性探针插件在运行时打印
  `ctx.tools.schemas()` 的全部工具名（`process.stderr` 输出，不依赖模型自述）——
  官方 `@deepseek-ai/dsh-tool-session-query` 行与本插件**同时装载**时，注册表里共有
  **11 个 `session_*` 工具并存**：

  ```
  session_event_read, session_event_search, session_event_trace,   ← 官方
  session_grep, session_lookup, session_overview, session_read,
  session_resume_subagents, session_share,                        ← 本插件
  session_search, session_trace                                   ← 官方
  ```

  修复前官方的 `session_search` 会因重名注册失败（整行异常、五个工具全不可用），
  修复后它与本插件的 `session_grep` 并存。

**用户要做什么**：重启 DSH 后，官方「会话搜索」那一行会恢复「运行中」，跨会话检索
（`session_search` / `session_event_*`）重新可用；本插件的会话内检索改用 `session_grep`。

## 5.6.1 — 2026-11-16

### 修复：「压缩」动作被注入进了错误的用量面板

**现象**（用户截图指出）：「压缩上下文 · 自动压缩：开 ｜ 压缩」这一行同时出现在三个面板里——

- **本轮用量**（composer 上方那枚数据库图标点开，`2,692,918 tok` + 提供方/缓存命中/输出）→ 不该有；
- **Token 用量**（会话统计 pill 点开，`129,393,100 tok`）→ 不该有；
- **上下文已用 45% ~477K / 1M**（官方 ContextMeter，系统提示词/工具定义/对话消息）→ 只该这里显示。

**根因**：面板识别判据太松。旧判据是「`role="dialog"` + 内含 `<dl>` + 文本含 `NN%`」，
而两个用量面板同样是 dialog、同样有 `<dl>`、文本里同样有百分比（缓存命中 99.9% / 94%），
于是被误判成 ContextMeter，动作行被注入了三个面板。**症状不是"多了个按钮"，而是"按钮出现在
语义不对的地方"**——用户一眼就看出来了。

**修法**（`client.js` 的 `isContextPanel` / `findContextPanel`）——三条独立判据同时成立才注入：

1. **排除用量面板**：其 `<dl>` 带官方源码里写死的 `data` 属性——`data-turn-usage-details`
   （`dsh-client-ui-chat/src/client/chat/TurnUsagePanel.tsx`）与
   `data-session-stats-details`（同包 `StatsPills.tsx`）；
2. **ContextMeter 的 breakdown 结构**：`<dl>` 的直接子元素**恰好 3 个 `div` 行**，每行有 `dt`
   且 `dt` 内有色块 `span`（依据 `dsh-client-ui-conversation/src/client/skeleton/ContextMeter.tsx`；
   用量面板是扁平 `dt/dd`，没有行容器与色块）；
3. **头部「~已用 / 窗口」比值**（如 `~477K / 1M`，与界面语言无关）。

另外 `findContextPanel()` 优先挑带内联 `position-anchor: --dsh-context-…` 的那个（官方用
CSS anchor positioning 定位该面板），浏览器不支持该属性时退回结构判据。

**边界（刻意的失败方向）**：任一条不满足就不注入 → 最坏情况是这一行不出现；手动压缩在
输入框里还有官方 `/compact` 命令入口，不会因此失去能力。**绝不能**再出现在错误的面板里。

**验证**（devkit web/UI 沙箱，真实 Chrome + 真实 client 半）：

- 按两个官方组件的源码结构**还原三种面板 DOM**，放进真实页面，让插件的
  `MutationObserver` 走真实代码路径：
  - 上下文已用面板 → 注入 **1** 行（`压缩上下文 · 自动压缩：关 ｜ 压缩`），样式与官方
    `.row` 同字号/分隔线；
  - 本轮用量面板 → **0** 行；Token 用量面板 → **0** 行；
  - 对照实验：**旧判据**对「本轮用量」夹具返回 `true`（证明夹具能复现原缺陷），新判据返回 0 行；
- 截图目视确认：三个面板并排时，只有最右边「上下文已用 45% ~477K / 1M」底部多出那一行。
- 单测 **188/188** 仍全绿（client.js 无单测，本项由 UI 沙箱覆盖）；`node --check client.js` 通过。

## 5.6.0 — 2026-11-16

### 新能力：会话「先概括、再定向读」三件套（overview / search / read）

**诉求**（用户原话）：「就是拿到会话 id 时可以知道整个会话的概括情况，然后再决定怎么读取，
这些都需要整成工具，并且对应长会话还需要有对应的检索工具。你可以看看
`session-aa989be9` 会话的情况，取会话信息很艰难。」

**先看真实卡点**（不是凭感觉加工具）：把 `aa989be9` 的完整日志解开统计——**4468 个事件、
736 次工具调用、680 条助手消息、2730 分钟跨度**。用 `session_lookup` 读这种会话只能拿到
「最后 10 条、每条截断 800 字符」，既慢又看不出全貌。更硬的限制来自官方工具：在
`session-aa989be9` 的日志里（seq 32）真实出现过

```
Error: session target is outside the caller workspace
SESSION_QUERY_TOOL_UNAUTHORIZED
```

——官方 `session_event_search` / `session_event_read` **按工作区授权**，用户粘来的会话 id
常常属于别的工作区（本次就是 `E:\顺灵 Boardmate`），于是「检索/精读」整条路被挡住。本插件
走 `ctx.get('sessionQuery')` 服务，没有这层工具级限制，所以把检索与精读补在这里。

**三个新工具**（都只读、都跨工作区可用）：

| 工具 | 一次调用读什么 | 回答什么 |
|---|---|---|
| `session_overview` | 目标会话**一次**整份日志（`readSession`）+ 语料库列举 | 这是什么会话、多大（事件数/工具调用/回合/跨度）、被交办什么、最近在做什么、树长什么样、下一步该用哪个工具 |
| `session_search` | 目标会话**一次**日志扫描（`filterEvents`） | 里面提到 X 的地方在哪（seq + 片段 + `nextFromSeq` 翻页） |
| `session_read` | 目标会话**一次**日志读取（`readEvent` 窗口 / `readSurface` 尾部） | 某个 seq 前后到底写了什么（含 log-only / shadowed 事件） |

实现要点（都在 `lib/inspect.mjs`）：

- **统计必须用原始日志，不能用当前表层**——真实回归踩到：`tool/call`、`turn/start`、
  `session/title` 都是 **log-only** 事件，按表层算会得出「工具调用 0 次、回合 0 次、标题为空」
  这种明显错误的概览。改用 `sessionQuery.readSession()`（一次读整份日志）后：
  工具调用 755、回合 13、标题正确。老部署没有 `readSession` 时降级为表层口径，并在摘要里
  明说「log-only 事件可能缺失」。
- 用户消息一律用 `isInjectedUserEvent` 过滤（注入的 runtime-context 不算「用户说了什么」）。
- 检索走 `filterEvents` 的**字面扫描**而不是 FTS 索引：不依赖 sqlite 索引能否建起来
  （真实遇到过 `SESSION_QUERY_PERSISTENCE_FAILED`），语义可预测（大小写不敏感、多词 AND、
  seq 升序 + `nextFromSeq` 翻页）。
- 失败语义与 `session_lookup` 共用 `resolveFailureSummary`（不唯一列候选、回查失败带原始错误、
  三种 id 写法提示），四个工具口径一致。

**验证**：

- 单测 **188/188**（新增 `test/inspect.test.mjs` 18 例：`eventRoleOf` / `eventTextOf` /
  `titleOfEvents` / `taskOfEvents` / `statsOfEvents` / 概览（含祖先、长会话提示、
  readSession 缺失降级、读失败不整体失败）/ 检索（AND、翻页、无命中、引擎报错、terms 收口）/
  读取（窗口、尾部、seq 不存在、缺 readEvent），每个输出都过运行时 schema 校验）。
- devkit headless 沙箱 + **真实会话日志**（拷入 `session-aa989be9` 与另一工作区的
  `session-062eb97a`）：
  - `session_overview` → 4468 事件 / user 17 / assistant 700 / 工具调用 755 / 回合 13 /
    跨度 2730 分钟，标题正确；
  - `session_search`（**跨工作区**，query=`commander-plan`）→ 命中 seq 176/180/181，
    带 `shadowed` / `log-only` 标记与片段，并给出「下一页从 seq 182 开始」；
  - `session_read`（seq 1，before=1，after=2）→ 正确返回 seq 0–3 并标出目标事件。

## 5.5.0 — 2026-11-16

### 新能力：顺着会话树读——子会话、子会话的子会话、以及（目标是子会话时的）上级会话

**诉求**（用户原话）：「通过会话 id 读取会话文件，还需要读取到对应会话的子会话和子会话的子会话，
如果是子会话需要知道他的上级会话。」

**现状核对**（先量真实语料，再动手）：
- 元数据早就有了：`traceSession` 的 `descendants` 是**递归**的（父在前、带 depth/parentId），
  祖先链也一直返回。实测根会话 `session-bc656a36` 有 11 个后代，其中 4 个是 d2（孙会话），
  输出里 `- [d2]` 缩进正确；子会话 `09d62f1a` 的祖先链是 2 层。全量扫描：526 个会话里
  89 个根、400 个 d1、**37 个 d2**——孙会话是真实存在的形态。
- 真正缺的是**内容**：嵌套会话只有「id + 标题 + 时间」，读不到它被交办了什么、最后做到哪。

**做法**（`lib/service.mjs`）：
- `nestedDigestOf()`：一次遍历算出「任务 + 最近 N 条消息」。任务 = 第一条用户消息（它的交办），
  最近消息用环形缓冲，不保留整段历史。
- `readNestedSession()`：逐个读谱系会话（祖先 + 全部后代，深度递归由 `flattenDescendants` 给出），
  单条失败只写进该节点的 `error`，**不让整次查询失败**（真实出现过某份日志损坏）。
- 读取范围与上限：默认 **开**（`includeNestedMessages`），每会话 **2 条**（`nestedMessageLimit`，
  上限 10），单次最多读 **20 个**谱系会话（`NESTED_SESSION_CAP`），超出部分记
  `nestedTruncated` 并在摘要里写「还有 N 个没读」。顺序读而不是并发读：每份日志都要整读一次
  （解压 + 重放校验），并发只会在 IO/内存上打尖峰，拿到的还是同一批数据。
- 摘要渲染：新增「### 谱系内会话内容」一节，每节 `#### [祖先 k] / [后代 dk] id · 标题` +
  「上级会话」+「任务」+「最近消息」；读失败的节点显示原始错误。
- 两个新参数写进工具描述（模型看得到「默认会读整棵树的摘要」）。

**验证**：
- 单测 **170/170**（新增 8 例：`nestedDigestOf` 的任务/最近消息语义、`clampNestedMessageLimit`、
  根会话读 d1+d2 内容、孙会话读祖先内容、`includeNestedMessages=false` 不读其他日志、
  `includeMessages=false` 不读谱系、超过 20 个的上限与 `nestedTruncated`、单节点读失败不影响其余，
  全部输出过运行时 schema 校验）。
- devkit headless 沙箱（真实 Loader + 真实 `sessionQuery` + 从本机拷入的真实三层谱系日志
  `session-bc656a36 → 477902f9/72d0ec01 → 09d62f1a/967b89b9/b7aec2bc/a0aec7e9`）：
  - 根会话 → 6 个后代的「任务 + 最近消息」全部读出（含 4 个 d2 孙会话），d2 节点带「上级会话」；
  - 孙会话 `09d62f1a` → 祖先链 2 层 + 两个祖先的「任务 + 最近消息」（`[祖先 1]`/`[祖先 2]`）。

## 5.4.0 — 2026-11-15

### 新增能力：会话 id 三种写法都认（修「按 id 读取不到」）

**现象**（真实事故，会话 `session-31874d86-f141-4c7c-962c-6ca39014bbb8` 的 seq 2699/2700）：

```
用户 seq 2690：session-559eb381-39ff-42bf-b3b6-4ae109b37eb1会话提到的 `dsh-desktop-control` 插件…
调用 seq 2699：session_lookup {"sessionId":"559eb381-39ff-42bf-b3b6-4ae109b37eb1"}
结果 seq 2700：❌ 找不到会话 `559eb381-39ff-42bf-b3b6-4ae109b37eb1`
```

**根因**：`session_lookup` 把 `sessionId` 原样交给 `sessionQuery.traceSession()`，而后者是
**精确匹配**（`tracing.ts` 里 `byId.get(sessionId)` 未命中就抛
`SESSION_QUERY_SESSION_NOT_FOUND`）。同一个会话在用户与模型手里有三种合法写法，指向同一份
日志，但字符串各不相同：

| 写法 | 从哪来 |
|---|---|
| `session-<uuid>` | 根会话在 header 里的真实 id；「复制会话 ID」复制的内容 |
| `<uuid>` | **子代理会话**的真实 id（`origin: "subagent"` 的会话没有前缀）；也是 `subagents/<uuid>/` 目录名 |
| `dsh-session-session-<uuid>.zip` | 会话导出文件名（`@` 引用 zip 时就是它） |

事故里模型把 `session-` 前缀丢了、还粘上了后面的中文（用户原话里 id 与正文之间没有分隔符），
于是整串精确匹配失败。**模型丢前缀是高频行为，工具却只接受唯一一种字符串**——这是工具的问题。

**修法**（`lib/service.mjs`）：

- 新增 `sessionUuidOf()`：从任意写法里取出 UUID（容忍路径、`.zip`、`session-` / `dsh-session-`
  前缀、以及 id 后面粘着的正文；大小写不敏感）。
- 新增 `matchSessionId()`：精确 id 未命中时，用 `sessionQuery.listSessions()` 按 UUID 回查语料库。
  返回 `found` / `ambiguous`（同一 UUID 命中多个会话时**报不唯一**，不随便挑一个）/
  `none` / `unavailable`（回查本身失败，把原因带出去）。
- 新增 `traceSessionById()`：**精确匹配仍是快路径**（不多付 listing）；只有
  `SESSION_QUERY_SESSION_NOT_FOUND` 才回查并重试。归一化成功时在摘要里明说
  「你给的 `X` 与真实 id `Y` 是同一个会话」，不悄悄改写。
- `lookupSession()` 改用 `traceSessionById()`，且后续 `readSurface()` 用**归一化后的 id**
  （否则元信息读到了、消息仍读不到）。
- `session_share` 的 `create` / `status` 同样归一化；分享记录落在**真实 id** 上，
  否则分享页按记录里的 id 读不到会话。
- 找不到时的提示补上三种写法的说明；回查失败时附上原始错误（「存储不可用」不再伪装成
  「会话不存在」）。
- 两个工具的 `sessionId` 参数描述写明接受三种写法（模型看到的就是它）。

**边界**：`session_resume_subagents` 没动——它查的是**在线 Agent**（不是历史），语义不同，
失败信息也不同。取消信号（`AbortError`）在回查里原样抛出，不会被记成「会话不存在」。

**验证**：

- 单测 **162/162**（新增 11 条：`sessionUuidOf` 三种写法 / 裸 UUID 归一化 / 导出文件名 /
  id 粘正文 / 子代理裸 UUID / 快路径不多列语料库 / 无 UUID 不回查 / 不唯一 / 回查失败 /
  取消原样抛出 / 分享记录落在真实 id）。
- devkit headless 沙箱（真实 Loader + 真实 `sessionQuery` + 从本机拷进去的真实会话日志）：
  - 裸 UUID → 归一化并带提示；完整 id → 无提示，两者其余内容一致；
  - `C:\…\dsh-session-session-<uuid>.zip` → 归一化成功；
  - 裸 UUID + `includeMessages=true` → 真的读到该会话最近消息（seq 1327/1329/1341），
    证明 `readSurface` 用的是归一化后的 id；
  - 事故会话 `31874d86` 的裸 UUID → 成功；
  - 全零 UUID → 「找不到会话」+ 三种写法提示，输出仍通过运行时 schema 校验。

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
