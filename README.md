# smart-publisher (VS Code)

> 扩展 ID：`spin.smart-publisher`　·　命令面板搜索 `smart-publisher`

**写一次，发到所有平台。**

写一篇 Markdown，一键复制到 **微信公众号 / 知乎 / 小红书**，导出**小红书 1080×1440 长图**，用 AI 生成**小红书笔记 / Twitter 串推**文案——全部在一个 VS Code 侧边面板里完成。支持 LaTeX 公式、代码高亮、14 套主题、实时预览。

> 本项目是 [marsggbo/markdown2anything](https://github.com/marsggbo/markdown2anything)（MIT）的 **VS Code 扩展复刻版**：保留其成熟的渲染内核（逐步移植，见 [致谢与许可](#致谢与许可)），重新组织了扩展结构，并聚焦于「预览 + 复制 + 长图 + AI 文案」这条最常用的链路。

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
| 🤖 AI 文案 | 小红书笔记 / Twitter 串推；OpenAI 兼容接口（DeepSeek、硅基流动、OpenRouter、Groq、Ollama、OpenAI…） |
| ⚡ 本地提取 | 不调模型也能离线生成标题 + 正文 + 标签（n-gram 关键词 + 导语抽取） |
| 🎨 14 套主题 | 微信经典 / Claude / macOS / 深夜极客 / 知乎 / 极简黑白 / 春日清新 / 学术 / 小红书 / Notion / Claude Pro / Medium / 科技博客 / 简约蓝 |
| 🔗 双向定位 | 光标移动时预览自动滚动到对应段落 |
| 🔒 安全 | API Key 存 VS Code SecretStorage（系统钥匙串），不写入任何文件 |

### 暂未包含（原项目另有 Electron / 网页版 / CLI 及自动发布）

- Playwright 自动发布到小红书 / 知乎 / Twitter（涉及登录态、验证码、平台风控，稳定性差，本项目默认只做「复制 + 长图」，最后一步由你手动发）
- PPT（Slidev / Marp / Pandoc）、Word 导出
- 封面生成

---

## 安装

### 从源码构建 VSIX（本地）

```bash
npm install
npm run package          # 生成 markdown-anything-1.0.0.vsix
code --install-extension markdown-anything-1.0.0.vsix
```

### 开发调试

用 VS Code 打开本目录，按 `F5` 启动「扩展开发宿主」，打开任意 `.md` 文件即可。

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

### AI 文案

1. `⚙️ LLM` → 选预设（DeepSeek / 硅基流动 / OpenRouter / Groq / 本地 Ollama / OpenAI）→ 填 API Key → 保存 → 测试连接
2. `🤖 AI 文案` → 选平台 → 可编辑 prompt → `✨ AI 生成`
3. 生成结果可编辑后一键复制

> 不想用大模型时点 `⚡ 本地提取`，完全不联网。

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
| `smart-publisher.xhs.exportMode` | `classic` | 长图默认模式 |
| `smart-publisher.xhs.adaptiveUseTheme` | `true` | 自适应模式是否跟随主题色（否则固定小红书红 `#ff2442`） |

---

## 项目结构

```
extension.js          扩展宿主：命令、面板、消息路由、LLM 配置、文件导出
lib/
  converter.js        Markdown → 平台富文本 / 截图 HTML（移植自上游，MIT）
  themes.js           14 套主题 CSS（移植自上游，MIT）
  llm.js              OpenAI 兼容文案生成 + Twitter 串推（移植自上游，MIT）
  extract.js          本地离线文案提取（移植自上游，MIT）
media/
  panel.html          Webview 模板
  panel.css           Webview 样式（跟随 VS Code 主题变量）
  panel.js            Webview 交互 + html2canvas 长图切片
templates/wechat.html 微信复制模板
```

---

## 致谢与许可

本项目基于 [marsggbo/markdown2anything](https://github.com/marsggbo/markdown2anything)（MIT License，Copyright © marsggbo）的渲染内核重做：

- `lib/converter.js`、`lib/themes.js`、`lib/llm.js`、`lib/extract.js`、`templates/wechat.html` 为上游代码的移植/改编（在文件头已标注来源），并按 MIT 许可保留原始版权声明。
- `extension.js` 与 `media/` 下的 UI 为本项目新写。

完整许可见项目根目录的 `LICENSE`（MIT）。
