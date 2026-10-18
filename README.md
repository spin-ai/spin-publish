# smart-publisher (VS Code)

[![CI](https://github.com/spin-ai/spin-publish/actions/workflows/ci.yml/badge.svg)](https://github.com/spin-ai/spin-publish/actions/workflows/ci.yml)

> 扩展 ID：`spin.smart-publisher`　·　命令面板搜索 `smart-publisher`

**写一次，发到所有平台。**

写一篇 Markdown，一键复制到 **微信公众号 / 知乎 / 小红书**，导出**小红书 1080×1440 长图**，用 AI 生成**小红书笔记 / Twitter 串推**文案，做**去 AI 味改写**，或者直接**自动发布到知乎 / 今日头条**——全部在一个 VS Code 侧边面板里完成。支持 LaTeX 公式、代码高亮、14 套主题、实时预览。

> 本项目是 [marsggbo/markdown2anything](https://github.com/marsggbo/markdown2anything)（MIT）的 **VS Code 扩展复刻版**：保留其成熟的渲染内核（逐步移植，见 [致谢与许可](#致谢与许可)），重新组织了扩展结构，并聚焦于「预览 + 复制 + 长图 + AI 文案 + 去 AI 味 + 发布」这条最常用的链路。

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 🖥️ 实时预览 | 侧边面板打开 `.md`，边写边渲染；公式（KaTeX）、代码高亮、图片、表格、任务列表全支持 |
| 📋 复制到微信 | 生成内联样式的富文本 HTML，公式转为内联 SVG（mdnice 格式），粘贴到公众号编辑器不掉格式 |
| 📋 复制到知乎 | 公式转知乎图床 `equation?tex=`，代码块用干净 `<pre>`，粘贴即识别 |
| 📋 复制到小红书 | 移动端友好的内联样式长文 |
| 💾 导出 HTML | 生成独立 HTML 文件（KaTeX 字体 base64 内联，离线可开） |
| 📱 小红书长图 | 面板内 html2canvas 渲染，智能在空白行切片为 1080×1440 长图，2× 高清，无需安装浏览器 |
| 🎬 导出 PPT | AI 把长文改写成 **Slidev / Marp** 演示文稿，自动补 front matter，保存为 `<name>-slides.md` / `<name>-marp.md` |
| 🤖 AI 文案 | 小红书笔记 / Twitter 串推；OpenAI 兼容接口（DeepSeek、硅基流动、OpenRouter、Groq、Ollama、OpenAI…） |
| 🧹 去 AI 味 | 内置检测器给文章打分（词面 + 结构），按报告生成可编辑 prompt，AI 改写后自动复检分数；支持**全文**或**当前选中片段** |
| ✂️ AI 改写选中 | 在编辑器里选中一段文字，右键 →「AI 改写选中文字」：去 AI 味 / 润色 / 精简 / 扩写 / 口语化 / 正式化 / 改错别字 / 翻译成英文 / 自定义指令；先看 diff 再替换 |
| 🚀 自动发布 | 内置 `zhihu-publisher` / `toutiao-publisher`（原 opencode-publisher）：Chrome 持久化登录、填充草稿、封面/专栏、默认停在发布前；知乎 / 今日头条 |
| ⚡ 本地提取 | 不调模型也能离线生成标题 + 正文 + 标签（n-gram 关键词 + 导语抽取） |
| 🎨 14 套主题 | 微信经典 / Claude / macOS / 深夜极客 / 知乎 / 极简黑白 / 春日清新 / 学术 / 小红书 / Notion / Claude Pro / Medium / 科技博客 / 简约蓝 |
| 🔗 双向定位 | 光标移动时预览自动滚动到对应段落 |
| 🔒 安全 | API Key 存 VS Code SecretStorage（系统钥匙串），不写入任何文件 |

### 暂未包含

- 小红书 / Twitter 的自动发布（知乎 / 今日头条已支持，见下文「自动发布」）
- PPT（Pandoc PPTX）、Word 导出
- 封面生成

---

## 安装

### 从源码构建 VSIX（本地）

```bash
npm install
npm run package          # 先用 esbuild 打包，再生成 smart-publisher-<version>.vsix
code --install-extension smart-publisher-*.vsix
```

### 开发调试

用 VS Code 打开本目录，按 `F5` 启动「扩展开发宿主」（会自动先 `npm run build`），打开任意 `.md` 文件即可。

```bash
npm run build        # esbuild 打包源码 → dist/extension.js
npm test             # 去 AI 味 / 改写管线 / 渲染内核 / 扩展宿主测试（跑源码）
npm run test:bundle  # 同上，但跑打包后的 dist/extension.js
npm run test:package # 打包 VSIX → 解压 → 对发布产物跑测试（验证 .vscodeignore 没误删资源）
```

---

## 使用

1. 打开任意 `.md` 文件
2. `Cmd+Shift+W`（macOS）/ `Ctrl+Shift+W`（Windows/Linux），或点编辑器右上角预览图标
3. 在右侧面板里选主题、点按钮

### 小红书长图

工具栏 `📱 长图导出` →

- **保留主题样式**：按当前主题渲染，适合有排版风格的文章
- **手机自适应大字**：36px 起的大字体排版，适合纯文字笔记（可调 20–60px）

点「📸 生成预览」，满意后「💾 一键导出全部」，图片保存到 `<文件名>_xhs/` 目录。

### 导出 PPT

工具栏 `PPT` → 选后端（Slidev / Marp）→ 可编辑 prompt → `AI 改写` → 检查/编辑 Markdown → `保存 .md`。

文件写入 md 同目录，并自动补 front matter：

- Slidev → `<name>-slides.md`（`theme: default`）
- Marp → `<name>-marp.md`（`marp: true`、`paginate: true`、16:9）

### AI 文案

1. `⚙️ LLM` → 选预设（DeepSeek / 硅基流动 / OpenRouter / Groq / 本地 Ollama / OpenAI）→ 填 API Key → 保存 → 测试连接
2. `🤖 AI 文案` → 选平台 → 可编辑 prompt → `✨ AI 生成`
3. 生成结果可编辑后一键复制

> 不想用大模型时点 `⚡ 本地提取`，完全不联网。

### 去 AI 味

1. 工具栏点 `🧹 去 AI 味`（或 `Cmd/Ctrl+Alt+H`）
2. 选范围：**全文** / **当前选中**（先在编辑器里选中一段文字）
3. `检测 AI 味` → 查看分数、词面命中、结构问题、优先改写建议
4. 按需编辑改写 prompt → `AI 改写` → 检查结果（会显示改写后的分数）
5. `应用到文档` 直接替换（可撤销），或 `另存副本` 保存为 `<name>-humanized.md`

检测器完全本地运行，不联网；只有点 `AI 改写` 时才会把正文发给你配置的 LLM。

### 选区 AI 改写

在 Markdown 编辑器里选中一段文字，右键 → **AI 改写选中文字**（`Cmd/Ctrl+Alt+R`）：

- 预设：去 AI 味 / 润色 / 精简 / 扩写 / 更口语 / 更正式 / 修正语法与错别字 / 翻译成英文
- 或选「自定义指令…」写自己的要求
- 结果先以 **diff** 打开（左原文 / 右改写），确认后替换选区，也可以只复制结果

### 自动发布（知乎 / 今日头条）

> 需要本机有 **Python 3.9+** 和 **Google Chrome**。首次运行会在 `publishers/` 下自动创建技能虚拟环境并安装 `patchright`（需要几分钟）。

1. 先扫码登录：命令面板 → `smart-publisher: 发布平台：扫码登录`
2. 打开要发布的 `.md`，右键 → `发布到知乎` / `发布到今日头条`
3. 选择：`填充草稿（推荐）` / `只校验 Markdown` / `直接发布（高风险）`
4. 填充草稿模式会在 Chrome 里填好标题、正文、封面、专栏，**停在发布前**，最后一步你自己点；发布完成后在终端按 `Ctrl+C` 结束脚本。

登录态保存在 `~/.smart-publisher/<platform>/`（可用 `smart-publisher.publisher.dataDir` 覆盖，兼容旧的 `~/.opencode-publisher`）。详细参数与安全设计见 [`publishers/README.md`](publishers/README.md)。

---

## 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `smart-publisher.theme` | `claude` | 默认主题 |
| `smart-publisher.outputPath` | `""` | 导出 HTML 目录（相对工作区；空 = md 同目录） |
| `smart-publisher.template` | `wechat` | 微信复制模板名（对应 `templates/<name>.html`，可放工作区 `templates/` 覆盖） |
| `smart-publisher.llm.baseUrl` | `https://api.deepseek.com/v1` | LLM 接口地址 |
| `smart-publisher.llm.model` | `deepseek-chat` | 模型名 |
| `smart-publisher.llm.sendFullText` | `true` | 是否把正文一起发给模型 |
| `smart-publisher.humanize.targetScore` | `25` | 去 AI 味的目标分数（生成改写 prompt 时要求降到该值以下） |
| `smart-publisher.publisher.pythonPath` | `""` | 自动发布用的 Python 解释器路径；留空用 `python3`（Windows 为 `python`） |
| `smart-publisher.publisher.dataDir` | `""` | 知乎 / 今日头条登录态目录；留空用 `~/.smart-publisher` |
| `smart-publisher.xhs.exportMode` | `classic` | 长图默认模式 |
| `smart-publisher.xhs.adaptiveUseTheme` | `true` | 自适应模式是否跟随主题色（否则固定小红书红 `#ff2442`） |

---

## 项目结构

```
extension.js          扩展宿主：命令、面板、消息路由、LLM 配置、文件导出
lib/
  converter.js        Markdown → 平台富文本 / 截图 HTML（移植自上游，MIT）
  themes.js           14 套主题 CSS（移植自上游，MIT）
  llm.js              OpenAI 兼容文案生成 + PPT + 去 AI 味 / 选区改写
  extract.js          本地离线文案提取（移植自上游，MIT）
  humanize.js         去 AI 味检测器（由 humanize-writing 的 detector.py 移植）
  publishers.js       知乎 / 今日头条发布命令适配（Python 解释器、路径、引号）
media/
  panel.html          Webview 模板
  panel.css           Webview 样式（跟随 VS Code 主题变量）
  panel.js            Webview 交互 + html2canvas 长图切片 + 去 AI 味面板
publishers/           内置发布技能（Python + patchright，MIT）
  zhihu-publisher/    知乎：Draft.js 导入、锚点插图、封面/专栏
  toutiao-publisher/  今日头条：ProseMirror 填充、剪贴板插图
  humanize-writing/   去 AI 味的 Python CLI 版本（扩展内已用 JS 重写）
  README.md           命令行用法与安全设计
scripts/
  build.js            esbuild 打包：extension.js + lib/ → dist/extension.js
  verify-package.js   打包 VSIX 并验证发布产物
templates/
  wechat.html         微信复制模板
dist/extension.js     运行时入口（构建产物，已内联 marked/cheerio/juice/mathjax 等）
```

> 依赖拆分：`mathjax-full`/`cheerio`/`juice`/`marked`/`gray-matter` 已被打进 `dist/`，因此放在 devDependencies；只有 `katex`（需 dist CSS+字体）和 `html2canvas`（webview 静态资源）留在 dependencies。vsix 从 3086 个文件 / 6.45 MB 降到 142 个文件 / 3.01 MB。

---

## 开发工作流（WADE）

本项目使用 [WADE](https://github.com/ivanviragine/wade)（`wade-cli`）管理任务与 AI 实现会话：

- 任务源：`ISSUES.md`（Markdown provider，标签需包含 `feature-plan`）
- `wade task list` / `wade task read 2` 查看 backlog
- `wade plan` → `wade 2` → `wade implementation-session done` 完成一个任务

配置见 `.wade.yml`，完整说明见项目根目录的 `WADE.md`。WADE 相关文件不会打进 VSIX。

---

## 致谢与许可

本项目基于 [marsggbo/markdown2anything](https://github.com/marsggbo/markdown2anything)（MIT License，Copyright © marsggbo）的渲染内核重做：

- `lib/converter.js`、`lib/themes.js`、`lib/llm.js`、`lib/extract.js`、`templates/wechat.html` 为上游代码的移植/改编（在文件头已标注来源），并按 MIT 许可保留原始版权声明。
- `extension.js` 与 `media/` 下的 UI 为本项目新写。

`publishers/` 目录整合了两个 MIT 项目与 opencode-publisher：

- `zhihu-publisher`：[ArchAIHarness/agent-workflows](https://github.com/ArchAIHarness/agent-workflows)（MIT）
- `toutiao-publisher`：[guanyang/super-publisher](https://github.com/guanyang/super-publisher)（MIT）
- `humanize-writing`：原 opencode-publisher（MIT），检测逻辑已移植到 `lib/humanize.js`

完整许可见项目根目录的 `LICENSE`（MIT）。
