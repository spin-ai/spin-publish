# Changelog

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
