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
state: closed
labels: feature-plan, feature, complexity:very_complex
-->

> 已在 1.1.0 实现：并入 opencode-publisher 的 `zhihu-publisher` / `toutiao-publisher`（Python + patchright），命令面板提供扫码登录、检查登录、填充草稿、二次确认后自动发布。默认停在发布前。

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

## #51622984 feat: 去 AI 味：本地检测 + AI 改写 + 复检（开发与验证）

<!-- wade
state: closed
labels: feature-plan, feature, test, complexity:complex
-->

## 背景

文章里常见的 AI 味不只在词，还在节奏：宏大开场、套话、黑话、均匀段落、升华结尾。需要一个**本地可检测、可量化、可改写、可复检**的流程，避免只凭感觉改稿。

## 需求

1. 把原 `humanize-writing` 的 `detector.py` 检测逻辑移植为扩展内 JS（`lib/humanize.js`），保持规则、权重、评分与 Python 版本一致。
2. 预览面板新增「去 AI 味」入口：
   - 显示分数 / 等级、词面命中分类、结构指标与惩罚、优先改写建议
   - 根据检测报告生成可编辑 prompt
   - 支持 **全文** 与 **当前选中片段** 两种范围
3. 调用 LLM 改写后自动复检，显示改写前后分数对比。
4. 改写结果可 `应用到文档`（可撤销）或 `另存副本`（`<name>-humanized.md` / `<name>-humanized-selection.md`）。
5. 新增 `smart-publisher.humanize.targetScore` 配置，默认 25，并写入改写 prompt。
6. 检测器纯本地、不联网；只有点「AI 改写」时才把正文发给用户配置的 LLM。

## 验收标准

- [x] `lib/humanize.js` 的 `score / grade / by_category / structure` 与 Python detector 对同一文本输出一致
- [x] 代码围栏内容不参与检测；均匀段落、列表/加粗密度能触发结构惩罚
- [x] 面板可完成：检测 → 编辑 prompt → AI 改写 → 查看 after 分数 → 应用/另存
- [x] 「当前选中」无选区时给出可操作错误；应用前校验选区/文档内容未被修改
- [x] `npm test` 覆盖检测、prompt 生成、整篇与选区应用
- [x] `npm run test:package` 验证打包产物包含运行时资源

## 涉及文件

`lib/humanize.js`、`lib/llm.js`、`extension.js`、`media/panel.html`、`media/panel.css`、`media/panel.js`、`package.json`、`test/humanize.test.js`、`test/host.test.js`

## 验证命令

```bash
npm test
npm run test:package
python3 publishers/humanize-writing/scripts/detector.py <file> --json
```

### Comment — 2026-10-18 16:21 UTC

开发与验证完成（smart-publisher 1.1.0）。

实现：
- 新增 lib/humanize.js：完整移植 detector.py 的规则、权重、评分与结构惩罚
- 新增 lib/llm.js#humanizeMarkdown：按检测报告生成 prompt，保留代码/图片/公式/front matter
- 面板新增「去 AI 味」：检测分数、分类命中、结构指标、优先建议；支持全文与当前选中片段
- AI 改写后自动复检分数，可应用到文档（可撤销）或另存副本
- 新增 config smart-publisher.humanize.targetScore（默认 25）

验证结果：
- npm test ✅（test/humanize.test.js、test/rewrite.test.js、渲染内核、扩展宿主）
- npm run test:bundle ✅
- npm run test:package ✅（VSIX 产物包含 publishers 运行时资源）
- JS 与 Python detector 同文本对比 ✅ score=100、grade=浓厚 AI 味、hits=13、by_category/structure 完全一致
- host test 覆盖整篇检测、整篇应用、选中片段检测与应用

结论：验收标准全部满足，关闭。

## #82336096 feat: 选区 AI 改写：右键润色 / 精简 / 扩写 / 翻译（开发与验证）

<!-- wade
state: closed
labels: feature-plan, feature, test, complexity:medium
-->

## 背景

改稿时经常只需要动一段：一句太啰嗦、一段 AI 味重、一个术语翻译不准。整篇交给模型既慢又容易误改其他内容，需要**只对编辑器选区做 AI 改写**，并在替换前让人看到差异。

## 需求

1. 新增命令 `smart-publisher.aiRewriteSelection`：
   - 编辑器右键菜单（仅 `editorHasSelection` 时显示）
   - 快捷键 `Cmd/Ctrl+Alt+R`
   - 命令面板可搜索
2. 预设改写动作：去 AI 味 / 润色 / 精简 / 扩写 / 更口语 / 更正式 / 修正语法与错别字 / 翻译成英文 / 自定义指令。
3. 调用 LLM 时带上文章标题、选区前后文，保持术语一致；只返回改写后的片段。
4. 结果先打开 **diff**（左原文 / 右改写），再弹窗确认：
   - `替换`：用结果替换原选区
   - `仅复制结果`：写入剪贴板，不改文档
   - 取消：不改动
5. 支持取消请求、超时、未配置 LLM 的可操作错误提示。
6. 替换前校验选区内容未变化，避免用户编辑后错位覆盖。

## 验收标准

- [x] 未选中文字时给出提示，不调用 LLM
- [x] 预设与自定义指令均可用；自定义指令为空时直接退出
- [x] 改写结果在 diff 中可对比，确认后才替换
- [x] 替换后选区更新为新文本，可继续编辑；替换可撤销
- [x] 未配置 LLM 时有明确提示；请求可取消
- [x] `npm test` 验证命令注册、预设完整性与参数校验
- [x] `npm run test:package` 通过

## 涉及文件

`lib/llm.js`（`REWRITE_PRESETS` / `rewriteText`）、`extension.js`（`aiRewriteSelection`）、`package.json`（命令 / 菜单 / 快捷键）、`README.md`、`test/rewrite.test.js`

## 验证命令

```bash
npm test
npm run test:package
```

### Comment — 2026-10-18 16:21 UTC

开发与验证完成（smart-publisher 1.1.0）。

实现：
- 新增 lib/llm.js#REWRITE_PRESETS：去 AI 味 / 润色 / 精简 / 扩写 / 更口语 / 更正式 / 修正语法错别字 / 翻译成英文 / 自定义指令
- 新增 lib/llm.js#rewriteText：带上标题与选区前后文，只返回改写后的片段
- 新增命令 smart-publisher.aiRewriteSelection：右键菜单（editorHasSelection）、Cmd/Ctrl+Alt+R、命令面板
- 结果先打开 diff（原文 ↔ 改写后），确认后替换选区，也可仅复制结果
- 替换前校验选区内容未变化；支持取消、超时与未配置 LLM 的可操作错误

验证结果：
- npm test ✅
- 新增 test/rewrite.test.js：用本地假 OpenAI 兼容服务验证预设完整性、参数校验、prompt 上下文、代码围栏清理
- npm run test:bundle ✅
- npm run test:package ✅
- host test 验证 aiRewriteSelection 命令与相关命令注册

结论：验收标准全部满足，关闭。
