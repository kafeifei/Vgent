# Vgent Web 低保真原型

定死三栏布局和 design token 用的静态原型。纯 HTML/CSS/JS，零依赖、零构建、零网络请求，
双击 `index.html` 或 `file://` 打开即可。

| 文件 | 作用 |
| --- | --- |
| `tokens.css` | **产品代码**。token 的唯一来源，之后原样搬到 `apps/web/src/tokens.css` |
| `index.html` / `prototype.css` / `prototype.js` | 主工作台原型（一次性，不进产品） |
| `tokens.html` | token 一览表，对着这页拍板 |
| `cursor3-notes.md` | 参照来源：从 Cursor 3 界面里观察到的模式，纯文字笔记 |

先开 `tokens.html` 定颜色和尺寸，再开 `index.html` 看它们装到真实布局里的样子。
两页共用 `localStorage` 里的主题和密度，切一次两边都生效。

## 已定的决策

### 布局尺寸

- 三栏 CSS grid：左 `240px`（⌘B 缩成 `48px` 图标条）· 中自适应 · 右默认 `0`，⌘J 展开 `380px`。
- 顶部没有大标题栏，只有一条 `36px` 窗口条：品牌标记 + 项目/分支切换 ｜ 密度 · 主题 · ⌘K。
- 中栏三行：任务头（粘顶） / 工作日志（滚动） / composer 区（粘底，含上方常驻工具条）。
  日志正文最大宽 `860px` 居中。
- 设置是独立页面，**入口在左栏底部的用户条上**，不在窗口条里。窗口条只留全局开关。

### 左栏（任务列表）

- 列表按项目分组，组标题是 `owner/repo` 小字弱色；顶部一个「分组 ▾」控件可切
  按项目 / 按状态 / 按更新时间。按状态分组时组名是「进行中 / 待处理 / 已完成」并各带数量。
  切换只重排现有 DOM 节点，不重渲染。
- 每条任务：状态点 + 一行截断标题 + 右侧环境标记（本机无标记，worktree 是分支小图标，
  云任务留了 `#i-cloud` 但这一版只做本机和 worktree）。第二行运行中的显示当前动作 + 耗时，
  已完成的显示相对时间 + `+135 −21` 改动统计（有改动才显示）。
- ⌘B 缩到 `48px` 图标条：只剩「新任务」图标按钮、每条任务的状态点和底部头像，
  完整标题靠原生 `title` 兜底，不做自定义 tooltip。
- 底部用户条：圆形头像色块 + 首字母 + 用户名 + 设置入口。

### 中栏（对话日志）

- **用户消息是圆角盒子**（`--color-bg-elevated` 底 + `--color-border` 边框，圆角和 composer 一致），
  不是左侧竖条；正文里的 `@引用` 渲染成内联 pill（mono + 弱底）。
- 最近一条用户消息 `position: sticky; top: 0` 粘在日志滚动容器顶部；粘住时由 JS 加 `.is-pinned`，
  补一条下边框和一层轻阴影。hover 时右上角出现「回退到此处」（checkpoint 语义，原型里只弹 toast）。
- **工具调用去卡片化**：一行 `--color-fg-muted` 文字，行高 `--spacing-row-tool`，没有边框没有背景；
  路径 / 命令部分 mono。整行可点击展开，只有展开区域才有 inset 底。
  示例：`读取 packages/engine/src/index.ts`、`搜索 "createVgentEngine" · 12 个结果`、
  `$ pnpm build · exit 0 · 3.4s`。
- 文件改动不是文字行而是 chip：`chat.ts +12 −3`（文件名 mono + 绿加红减，弱底圆角）。
  点 chip 会展开右栏、切到「变更」tab 并高亮对应文件。
- 子代理是一行 `子代理 Explore · 查找续流实现 · 运行中`，展开后缩进嵌套三行子工具调用。
- **一轮的收口方式**：一轮结束后该轮所有工具行折进一行 `工作了 5m 38s ▸`，
  折叠行下面是 agent 的 Markdown 总结（「总结」+「测试」两个加粗小标题，测试条目带 ✅ / ⚠️），
  正文里的文件 / 终端引用是可点 chip（`chat.ts:88-120`、`terminal:1-14`）。
  运行中的那一轮不折叠，工具行直接展示，最后一行带 spinner。
- **没有「N 个文件改动 · 全部接受 / 撤销」这种每轮收口条**，它被 composer 上方的常驻工具条取代。
- 审批卡片、提问卡片保持「就地」出现在对话流里——这是 Vgent 自己引擎要的，Cursor 没有对应物。
  审批维持 warning 弱底 + 三按钮；提问改成 Cursor 式：标题「问题 1 / 2」、编号方块选项、
  自由输入框、底部「跳过 / 继续」、右上角 `‹ ›` 翻页。

### composer 区

- **上方一条常驻工具条**：左边 `审查 +1180 −21` pill（点开右栏「变更」tab），
  旁边 `本机 ▾` 运行位置下拉（占位），右端一个 16px 的 context ring（内联 SVG，accent 描边，
  示例 42%），hover 出「系统提示 / 工具 / 对话」三段占比。
- textarea 上方**没有上下文 chip 行**。placeholder 是「规划、构建，/ 输入命令，@ 引用上下文」。
- 底部工具条：圆形 `+`（文件 / 文件夹 / 图片 / 终端输出 / 分支 diff 占位菜单）·
  `Agent ▾` 模式（Agent / Plan / Ask）· 模型 chip `sonnet-4.5 ◑ 快速 ▾` ·
  右端麦克风 + 发送（accent 圆形箭头，运行中变停止方块）。
- **权限模式不在 composer 里**，只在任务头的胶囊上。
- `@` 补全选中后往 textarea 里插纯文本 `@path`。
  产品最终形态应该用 contenteditable 实现内联 pill，本原型简化成纯文本。

### 空状态

顶部一行三个 picker（仓库 ▾ / 运行位置 ▾ ｜ 右端分支 ▾）· 一个和 composer 同样式的大输入框 ·
两个建议按钮「规划一个想法 ⇧Tab」「打开编辑器」。品牌标记和一句话说明保留但字号缩小。

### 右栏

- 顶部是**图标 tab 条**（20px 图标 + `title` tooltip，选中态下划线），五个 tab：
  变更 / 文件 / 终端 / 计划 / 队列。
- 变更：`3 个文件 · +1180 −21` + 右侧 `提交 ▾`（提交 / 提交并开 PR，占位）；
  文件列表按目录树缩进，点开在下方展开 unified diff。
  **diff 头部只有「还原此文件」，没有「接受」**——引擎直接写盘，接受无意义。
- 文件：只读文件树 + 带行号的代码预览占位。
- 终端：最近命令输出。
- 计划：Cursor 式计划文档（标题 + 说明 + 任务清单：已完成打勾变灰、进行中 accent 实心点、
  未开始空心点），右上角 accent 的「构建」按钮（占位）。
- 队列：待审批 + 待回答，点击滚到对话流对应卡片并闪烁高亮。

### token 命名规则

按 Tailwind v4 `@theme` 命名空间起名，搬过去就能直接映射：
`--color-*` `--spacing-*` `--radius-*` `--text-*` `--leading-*` `--font-*` `--shadow-*` `--duration-*`。

颜色分两层，**组件只许引用语义层**：

- 原始色阶：`--neutral-0…1000`、`--amber-*`、`--green-*`、`--yellow-*`、`--red-*`、`--blue-*`（oklch）
- 语义层：`--color-bg` / `-elevated` / `-inset` / `-hover` / `-active` / `-scrim`、
  `--color-border` / `-strong`、`--color-fg` / `-muted` / `-faint`、
  `--color-accent` / `-hover` / `-fg` / `-bg`、
  `--color-success|warning|danger|info` 及各自 `-bg`、
  `--color-diff-add-bg|fg`、`--color-diff-del-bg|fg`、`--color-selection`、`--color-focus-ring`

布局常量也走 `--spacing-*`（`--spacing-sidebar` / `--spacing-rightpane` / `--spacing-topbar` /
`--spacing-row-tool` …），这样 Tailwind 里直接是 `w-sidebar`、`h-row-tool`。

主题：深色优先，深色写在 `:root` 且是默认值，浅色在 `:root[data-theme="light"]` 覆盖语义层，
只有 `localStorage` 里 `vgent.theme` 存过 `light` 时才切浅色，不跟随系统。
**浅色是单独调过的，不是深色反相**——底是暖白不是纯白，accent 下沉到 `--amber-700` 保证白底对比度，
状态色整体沉一到两档、弱底提高不透明度。

### accent 选择理由

**琥珀 amber `oklch(0.80 0.155 72)`，全局只有这一个主色。**

1. 血统对：琥珀是 CRT 单色终端的磷光色，也是"构建中"的传统颜色。Vgent 是编码工作台，
   主色该来自终端而不是来自 SaaS。
2. 不撞同行：开发者工具的主色几乎被蓝/紫/青占满（Vercel、Linear、VS Code、GitHub），
   暖橙在这个品类里是空位，一眼能认出不是 shadcn 默认皮。
3. 不撞 diff：diff 红（色相 ~27）绿（~152）是屏幕上信息量最大的两个颜色，主色必须让开；
   琥珀在 72，两边都有距离，深色底上亮度够高。
4. 为了保住"只有一个主色"，语义状态色（success/warning/danger/info）**刻意压低了彩度**，
   做成安静的颜色——屏幕上只允许 accent 一个响亮的颜色。

accent 的用途被限死在五处：品牌标记、主按钮、焦点环、"运行中"指示、当前选中任务的左侧标记。
其他一律中性色。中性色也带极轻暖调（色相 75、彩度 0.005），和琥珀同族，不发蓝。

### 密度默认值

默认 `comfortable`，但基线就比聊天软件紧：

| token | comfortable | compact |
| --- | --- | --- |
| `--text-body` | 13px | 12.5px |
| `--leading-body` | 1.45 | 1.38 |
| `--spacing-row-tool`（工具卡片行高） | 28px | 24px |
| `--spacing-row-task`（任务列表项） | 46px | 38px |
| `--spacing-topbar` | 36px | 32px |
| `--spacing-block-gap` | 14px | 10px |
| `--spacing-sidebar` | 240px | 212px |

密度只覆盖字号、行高和几个行高类 spacing，**不动色板、不动圆角**。

### 字体

系统栈，不加载外部字体。sans 用 `-apple-system / SF Pro Text / Inter / Segoe UI / system-ui`，
mono 用 `ui-monospace / SF Mono / JetBrains Mono / Menlo / Consolas`。
路径、命令、diff、模型 ID、行号、`+12 −3` 一律 mono。

### 已拍板（2026-09-17）

- **状态点用形状区分，不改色**：等审批 / 等回答改成空心环（2px 描边、中间透明），运行中 / 完成 / 失败
  保持实心圆——warning 和 accent 色相在小尺寸下太接近，形状比色彩更稳地分出"等人" vs "在跑 / 结束"。
- **正文密度默认 13px / 1.45 / 工具行 28px 保留**：已经比聊天软件紧，改了要动一批 `--spacing-row-*`
  联动值，收益不确定。
- **左栏任务项两行保留**：一行放不下标题和文件摘要，两行是当前信息密度下的下限。
- **选中任务左侧 2px accent 条保留**：这是 accent 五处合法用途之一，去掉就少一个"当前停在哪"的锚点。
- **danger 不单独提彩度**：失败态靠文字（"失败"/错误信息）和图标兜底，颜色系统"全局只有一个响亮色"的
  约束不为单个状态破例。

## 参照：Cursor 3 Agents Window（2026-04+）

**第一版原型参照的是 2025 年的侧栏 Composer 形态（窄侧栏挂在编辑器旁边），那套交互已经被 Cursor
官方废弃。** 2026-04 起 Cursor 把它换成了全屏三栏的 Agents Window，本轮重做照这套新形态把信息架构和
交互细节对齐了一遍（token 体系、三栏骨架宽度、深浅色、密度不变，改的是下面这些）：

- 左栏任务列表**按项目（`owner/repo`）分组**，而不是一条不分组的平铺列表；分组方式可切换（按项目 /
  按状态 / 按更新时间）。
- composer 上方是一条**常驻的审查工具条**（`审查 +N −N` pill + 运行位置下拉 + 上下文占用环），
  取代了原来挂在每一轮末尾的"N 个文件改动 · 全部接受 / 撤销"收口条。
- 普通工具调用**去卡片化**：一行 muted 文字（`读取 xxx`、`$ command`），不再是带边框背景的卡片；
  只有文件改动是 chip，点了在右栏开 diff。
- 一轮结束后所有工具行折进 `工作了 Nm Ns ▸` 一行，展开才看到明细；正在跑的那一轮不折叠。
- 用户消息是**圆角盒子**（跟 composer 同源的视觉语言），不是老版的左侧竖条色块；最近一条消息滚动时
  粘在日志顶部，hover 出"回退到此处"。
- 右栏是**图标 tab 条**（变更 / 文件 / 终端 / 计划 / 队列），不是文字 tab；"变更" tab 里只有
  "还原此文件"，没有"接受"——引擎直接写盘，"接受"这个动作本来就不存在。
- 提问用 Cursor 式**编号选项 + 翻页**（`‹ 问题 1/2 ›`），不是一次性把所有问题铺开。
- "计划" tab 是一篇 Cursor 式的**计划文档**（标题 + 说明 + 打勾清单），不是任务卡片列表。
- 空状态是**三个 picker**（仓库 / 运行位置 / 分支）+ 大输入框，而不是一句话 + 单个建议列表。
- 侧栏可以收缩成 **48px 图标条**（只留新任务图标和任务状态点），不是直接收到 0 消失。
- 新增 `/side` **侧聊**入口（任务头 `+` 按钮）：不打断主线程问一句题外话，Cursor 3 独有，原型里只做占位。

审批卡片和提问卡片的"就地"（inline，出现在对话流里）形式保留不变——这是 Vgent 自己引擎需要的东西，
Cursor 没有对应物，不属于这次参照范围。

## 原型里已经做出来的交互

⌘K 命令面板（搜索 + ↑↓ + Enter + Esc，含"切换分组方式""打开侧聊"）· ⌘N 新任务（切空状态）·
⌘J 右栏 · ⌘B 左栏（收缩成 48px 图标条，hover 靠 `title` 出完整标题）·
左栏分组切换（按项目 / 按状态 / 按更新时间，JS 重排 DOM 不重新渲染）·
工具行去卡片化展开 · reasoning 展开 · 胶囊/下拉 popover（选中会改文字，分组下拉额外触发重排）·
审批三按钮（允许后卡片变已执行态、队列条目消失、计数减一）·
提问卡片编号选项 + 翻页（`‹ ›`）+ 跳过 / 继续，提交后折叠成一行 ·
每轮收口成 `工作了 Nm Ns ▸`，总结正文里的文件 / 终端引用渲染成可点 chip（点了在右栏开对应 diff /
切到终端 tab）· 右栏五个图标 tab + 文件展开 diff（只有"还原此文件"，没有"接受"）·
队列跳转（`scrollIntoView` + 闪烁高亮）· composer 上方常驻审查 pill + 运行位置下拉 + 上下文占用环
（hover 出系统提示 / 工具 / 对话三段占比）· composer 的 `@` 文件补全（选中后插入纯文本 `@path`）、
Enter 发送 / Shift+Enter 换行 · 用户消息滚动粘顶（最近一条，粘住时加下边框和轻阴影）、
hover 出"回退到此处"（toast 占位反馈）· 滚动跟随与「↓ 有新内容」浮标（每 8 秒假追加一条工具行来演示）·
主题/密度写 `localStorage`。

所有事件走 `document` 上一个委托，靠 `data-act` 分发。

## 留到实现阶段的东西

- **AI Elements 映射**：原型里手写的工具卡片 / diff / 终端 / 计划 / 审批，实现时换成
  `npx ai-elements add` 拉下来的 Tool、Reasoning、CodeBlock、Terminal、FileTree、Plan、Task、
  Confirmation，外观全部通过 token 和调用层组合改写，不保留默认 shadcn 观感。
- **真实 Markdown 渲染**：原型里 agent 正文是手写 HTML，实现时接 streamdown / react-markdown，
  代码块要语法高亮。
- **虚拟滚动**：长任务日志需要，原型没做。
- **真实 diff 生成与行内字符级高亮**：原型是手搓的静态 diff 结构。
- 空状态、命令面板的数据源（真实任务列表、引擎/模型注册表）。
- 键盘焦点管理与无障碍（roving tabindex、浮层 focus trap）。

## 搬进 `apps/web` 的方式

1. `cp docs/prototype/tokens.css apps/web/src/tokens.css`
2. 在 `apps/web/src/index.css` 里：

```css
@import "tailwindcss";
@import "./tokens.css";

/* 把语义层映射成 Tailwind 工具类。inline 表示直接取变量的值，
   这样 data-theme / data-density 的覆盖在运行时依然生效。 */
@theme inline {
  --color-bg: var(--color-bg);
  --color-bg-elevated: var(--color-bg-elevated);
  --color-bg-inset: var(--color-bg-inset);
  --color-border: var(--color-border);
  --color-border-strong: var(--color-border-strong);
  --color-fg: var(--color-fg);
  --color-fg-muted: var(--color-fg-muted);
  --color-fg-faint: var(--color-fg-faint);
  --color-accent: var(--color-accent);
  --color-accent-fg: var(--color-accent-fg);
  /* 状态、diff、spacing、radius、text、shadow 同理逐条列出 */
}
```

之后组件写 `bg-bg-elevated text-fg-muted border-border rounded-md h-row-tool`，
`prototype.css` 本身不搬。

Review 时按两条硬约束驳回：**组件里出现裸色值 / 裸像素**，或**组件里引用原始色阶**
（`--neutral-*`、`--amber-*` 等）而不是语义层。

## 自查

```bash
# prototype.css 里不许有裸色值，应为 0 命中
grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(' docs/prototype/prototype.css
```
