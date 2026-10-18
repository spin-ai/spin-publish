# Changelog

## 1.1.0

### 新功能

- **去 AI 味**：内置检测器（词面规则 + 段落节奏 / 列表 / 加粗密度）给文章打分，面板展示命中项与改写建议；按报告生成可编辑 prompt，AI 改写后自动复检分数
  - 支持**全文**与**当前选中片段**两种范围
  - `应用到文档` 直接替换（可撤销），`另存副本` 保存为 `<name>-humanized.md`
  - 检测器纯本地运行，不联网；检测逻辑由 `humanize-writing` 的 `detector.py` 移植为 `lib/humanize.js`
- **选区 AI 改写**：选中文字后右键 `AI 改写选中文字`（`Cmd/Ctrl+Alt+R`）
  - 预设：去 AI 味 / 润色 / 精简 / 扩写 / 更口语 / 更正式 / 修正语法与错别字 / 翻译成英文 / 自定义指令
  - 结果先打开 **diff**（原文 ↔ 改写后），确认后替换选区，也可只复制
- **内置知乎 / 今日头条自动发布**：原 `opencode-publisher` 技能并入 `publishers/`
  - 命令：`发布到知乎` / `发布到今日头条` / `扫码登录` / `检查登录状态`
  - 默认填充草稿并停在发布前；`直接发布` 需二次确认
  - 登录态默认 `~/.smart-publisher/<platform>/`，兼容旧的 `~/.opencode-publisher`
  - 新增配置：`publisher.pythonPath`、`publisher.dataDir`、`humanize.targetScore`

### 其他

- `.vscodeignore` 锚定开发目录，避免把内置发布技能的 `scripts/` 误排除；同时排除 `.venv`、`__pycache__`、技能测试
- 新增 `test/humanize.test.js`（检测器 / 命令构造）与 `test/rewrite.test.js`（选区改写 / 去 AI 味 LLM 管线），宿主测试覆盖去 AI 味检测与应用
- README 补充去 AI 味、选区改写、自动发布文档

## 1.0.4

### 新功能

- 导出 PPT：把长文交给 LLM 改写成 **Slidev / Marp** 演示文稿
- 面板新增「PPT」入口与侧栏：后端选择、可编辑 prompt、结果可编辑
- 保存时自动补 front matter（Slidev `theme: default`；Marp `marp: true` / 16:9 / 分页）
- 输出 `<name>-slides.md` / `<name>-marp.md`，并剥离 LLM 误带的旧 front matter
- 复用 LLM 多配置；未配置 Key 时给出可操作错误提示

### 开发工作流

- 接入 [WADE](https://github.com/ivanviragine/wade)（`wade-cli 1.2.16`）：AI 驱动工程工作流
- 任务源采用 Markdown provider → `ISSUES.md`（含 7 个 backlog：#1~#7）
- worktree 目录隔离到 `../.worktrees/smart-publisher`；AI 工具检测为 `opencode`
- 新增 `WADE.md` 接入说明；WADE 文件已从 VSIX 排除

## 1.0.3

- 工具栏 / 侧栏图标由 emoji 换成统一线性 SVG（`currentColor`，跟随 VS Code 主题色）
- 图标用内联 sprite（`<symbol>` + `<use>`），不引入外部资源、不增加请求
- 修复按钮忙碌态会覆盖图标的问题（只更新 `.btn-label`）

## 1.0.2

- 面板标签页标题由 `M2A · xxx.md` 改为 `smart-publisher · xxx.md`
- 面板标签页改用专属图标（之前是 VS Code 默认 webview 图标），并标注 `panel.iconPath`
- Webview 工具栏标题前增加品牌小图标（纸飞机）
- 内部存储命名空间 `m2a.*` 改为 `sp.*`（主题与 LLM 配置会重置一次）

## 1.0.1

- 更换扩展图标：翡翠→深青渐变圆角方块 + 白色纸飞机（替换上游的深色 Md 图标），和原项目区分开
- 新增 `npm run icon`：纯 Node 光栅化生成 `media/icon.png` / `icon.svg`，无第三方依赖、可复现
- 新增 `npm run install-ext`：自动定位 `code` CLI，打包并安装到本机 VS Code

## 1.0.0

项目名 `smart-publisher`（上游原始项目为 `markdown2anything`）。

首个版本：基于 [markdown2anything](https://github.com/marsggbo/markdown2anything)（MIT）渲染内核的 VS Code 扩展复刻版。

### 功能

- 侧边 Webview 实时预览（KaTeX 公式、highlight.js 代码高亮、图片、表格、任务列表）
- 一键复制到微信公众号（内联样式 + MathJax 内联 SVG 公式 + macOS 风格代码块）
- 一键复制到知乎（公式走知乎图床、干净 `<pre>` 代码块）
- 一键复制到小红书长文
- 导出独立 HTML 文件（KaTeX 字体 base64 内联）
- 小红书长图导出：webview 内 html2canvas 渲染 + 空白行智能切片，输出 1080×1440、2× 高清
- AI 文案：小红书笔记 / Twitter 串推（OpenAI 兼容接口），多配置管理，API Key 存系统钥匙串
- 本地离线文案提取（不调用模型）
- 14 套主题 + 整体缩放 + 光标跟随定位

### 与上游的差异

- 去掉 Playwright 自动发布、PPT/Word 导出、封面生成、Electron/网页/CLI 形态
- 长图导出改为纯 webview 内 html2canvas，无需下载 Chromium
- 重新实现 Webview UI（跟随 VS Code 主题变量）

### 构建

- 引入 esbuild 打包：`extension.js` + `lib/` + `marked/cheerio/juice/gray-matter/mathjax-full` → 单文件 `dist/extension.js`
- `mathjax-full` 通过 `define(PACKAGE_VERSION)` 旁路其 `eval('__dirname')` 版本探测，得以安全内联
- 只有 `katex`（需 dist CSS+字体）与 `html2canvas`（webview 静态资源）保留在 dependencies；vsix 从 3086 个文件 / 6.45 MB 降到 142 个文件 / 3.01 MB
- 新增 `npm run test:package`：解压 VSIX 后对发布产物跑测试，防止 .vscodeignore 误删运行时资源
