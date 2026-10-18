# Wade Issues

<!-- Managed by the Wade markdown issue provider. -->

## #1 CI：GitHub Actions 跑测试 + 打包 VSIX

<!-- wade
state: open
labels: feature-plan, ci, complexity:medium
-->

目前所有校验都靠本地手动跑，提交质量没有兜底。

**验收标准**

- 新增 `.github/workflows/ci.yml`，在 `push` 与 `pull_request` 触发
- Node 18 / 20 矩阵；使用 `npm ci`（带 npm 缓存）
- 依次执行 `npm test`、`npm run test:package`
- 把 `smart-publisher-*.vsix` 作为 artifact 上传
- CI 通过后，PR 才允许合并

**涉及**：`.github/workflows/`、`package-lock.json`

---

## #2 导出 PPT（Slidev / Marp）

<!-- wade
state: closed
labels: feature-plan, feature, complexity:complex
-->

把一篇文章变成可演示的 PPT，是当前缺失的高频需求。

**验收标准**

- 面板新增「导出 PPT」入口，可选 Slidev / Marp 两种后端
- 复用 LLM 配置，prompt 明确要求：代码块、图片引用、LaTeX 公式**原样保留**
- 生成 `.md` 到 md 同目录（或 `outputPath`），文件名 `<base>-slides.md`
- Slidev/Marp 的 front matter 由插件补齐
- 出错时给出可操作提示，不静默失败

**参考**：上游 `lib/llm.js` 的 `generatePptMarkdown` 与三套 prompt

---

## #3 导出 Word（Pandoc）

<!-- wade
state: open
labels: feature-plan, feature, complexity:medium
-->

**验收标准**

- 自动检测 pandoc；缺失时提示安装或下载到 VS Code `globalStorage`
- 导出 `.docx`，公式走 OMML（不是图片）
- 面板入口 + 进度提示
- 代码块高亮样式可在导出前选择（github / monokai 等）

**涉及**：新增 `lib/pandoc.js`、`extension.js` 消息路由

---

## #4 平台自动发布（Playwright，可选高风险）

<!-- wade
state: open
labels: feature-plan, feature, complexity:very_complex
-->

把「复制 + 长图」升级为「自动打开浏览器、传图填字」。

**验收标准**

- 支持小红书 / 知乎 / Twitter 至少一个平台跑通端到端
- Cookie 只存本地（SecretStorage / globalStorage），不上传第三方
- 默认 `prepare` 模式：自动填好内容后停下，**不替用户点最后一步发布**
- 失败时可人工接管；headless 可配置
- 文档明确标注平台风控与账号风险

**注意**：需要真实账号与登录态，测试环境使用 mock。

---

## #5 自定义主题：导入 / 导出

<!-- wade
state: open
labels: feature-plan, feature, complexity:medium
-->

目前 14 套主题是内置的，用户无法保存自己的样式。

**验收标准**

- 定义主题 JSON schema：`{ id, name, wrapperBg, css }`
- 面板支持「导入主题」（文件选择 + 校验 + 预览）
- 支持「导出当前主题」为 JSON
- 自定义主题持久化到 `globalState`，并出现在主题下拉里
- 非法 CSS/缺字段时拒绝导入并说明原因

---

## #6 测试补强：边界与回归用例

<!-- wade
state: open
labels: feature-plan, test, complexity:medium
-->

**验收标准**

- 覆盖：空文档、超长文档、front matter、任务列表、宽表格
- 覆盖：本地图片 base64、远程图片下载失败降级、图片超大
- 把 webview 的 jsdom 交互测试纳入 `npm test`（目前是外部临时脚本）
- 打包产物测试（`test:package`）在 CI 中执行（依赖 #1）

---

## #7 发布流水线：vsce publish + 版本自动化

<!-- wade
state: open
labels: feature-plan, release, complexity:easy
-->

**验收标准**

- `package.json` 补 `repository` 字段（vsce 要求）
- 新增 `scripts/release.js`：校验工作区干净 → 升版本 → 更新 CHANGELOG → 打包 → `vsce publish`
- 支持 `patch`/`minor`/`major` 参数
- 可选：打 tag 并在 GitHub Release 附上 vsix
