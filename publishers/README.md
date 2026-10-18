# publishers — 知乎 / 今日头条自动发布 + 去 AI 味

这套技能原先位于 `opencode-publisher`，现已并入 **smart-publisher**，并接进
VS Code 命令面板。浏览器自动化脚本保持原样，仍然可以脱离 VS Code 单独运行。

| 技能 | 用途 |
|---|---|
| `zhihu-publisher` | Markdown → 知乎专栏：导入文档、锚点插图、封面/专栏、发布门禁 |
| `toutiao-publisher` | Markdown → 头条号：HTML 填充、剪贴板插图、两步发布确认 |
| `humanize-writing` | 发布前去 AI 味：检测打分 → 按手法改写 → 复检 |

> `humanize-writing` 的检测逻辑已用 JavaScript 重写进扩展（`lib/humanize.js`），
> 面板里的「去 AI 味」不依赖 Python。这里的 Python 版本保留给命令行 / OpenCode 使用。

## 在 VS Code 里使用（推荐）

1. 打开任意 `.md` 文件
2. 命令面板搜索 `smart-publisher`，或右键 Markdown 文件：

| 命令 | 说明 |
|---|---|
| `smart-publisher.humanize` | 打开「去 AI 味」面板（全文 / 选中片段） |
| `smart-publisher.aiRewriteSelection` | 选中文字后用 AI 改写（润色/精简/扩写/翻译…） |
| `smart-publisher.publishZhihu` | 发布到知乎（填充草稿 / 自动发布） |
| `smart-publisher.publishToutiao` | 发布到今日头条（填充草稿 / 自动发布） |
| `smart-publisher.publisherLogin` | 扫码登录 / 更新登录态 |
| `smart-publisher.publisherStatus` | 检查登录状态 |

发布命令会在 VS Code 终端里运行 Python 脚本，并在首次运行时自动创建技能本地
`.venv`、安装 `patchright`（需要几分钟）。填充草稿完成后脚本会停留在发布前；
在 Chrome 里点完发布后，回到终端按 `Ctrl+C` 结束。

### 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `smart-publisher.publisher.pythonPath` | `""` | Python 解释器路径；留空用 `python3`（Windows 为 `python`） |
| `smart-publisher.publisher.dataDir` | `""` | 登录态目录；留空用 `~/.smart-publisher` |
| `smart-publisher.humanize.targetScore` | `25` | 去 AI 味的目标分数 |

登录态默认保存在 `~/.smart-publisher/<platform>/`（权限 0600/0700）。如果检测到
旧的 `~/.opencode-publisher/<platform>/`，脚本会继续沿用，避免重新扫码。

## 安全设计

- **发布门禁**：默认「填充草稿」，只填好标题/正文/封面并停在发布前；
  「直接发布」必须在 VS Code 弹窗里二次确认。
- **凭证隔离**：Cookie / 浏览器 Profile 只存本地，脚本不读取、不打印任何
  Cookie 或密码内容。
- **成功以平台确认为准**：自动发布只有检测到知乎文章 URL / 头条「发布成功」
  提示才算成功，点击按钮本身不算。
- **退出码**：`0` 成功；`1` 运行时/浏览器/发布失败；`2` 输入非法或未登录。

## 命令行使用

```bash
SKILL=publishers/zhihu-publisher

# 1. 首次登录（弹出 Chrome，扫码）
python3 "$SKILL/scripts/run.py" auth_manager.py setup --json

# 2. 只校验 Markdown（不打开浏览器）
python3 "$SKILL/scripts/run.py" publisher.py \
  --mode validate --title "标题" --content-file article.md --json

# 3. 填充草稿并停在发布前（推荐）
python3 "$SKILL/scripts/run.py" publisher.py \
  --mode manual --content-file article.md --cover cover.png \
  --column "我的专栏" --json

# 4. 明确授权后自动发布
python3 "$SKILL/scripts/run.py" publisher.py \
  --mode auto --content-file article.md --headless --json
```

今日头条把 `SKILL` 换成 `publishers/toutiao-publisher` 即可。头条标题要求 2–30 字；
正文有图片时可以不单独上传封面。更多参数见各技能目录下的 `SKILL.md`。

### 去 AI 味（命令行）

```bash
python3 publishers/humanize-writing/scripts/detector.py article.md
python3 publishers/humanize-writing/scripts/detector.py article.md --json --threshold 30
```

## 在 OpenCode 里使用（可选）

如果仍想在 OpenCode 中直接对话调用这些技能：

```bash
./publishers/install.sh          # 软链到 ~/.config/opencode/skills/
./publishers/install.sh --remove # 卸载
```

## 环境要求

- Python 3.9+
- Google Chrome
- macOS / Linux（Windows 未做端到端验证）
- 首次运行 `run.py` 会自动创建技能本地 `.venv` 并安装依赖

## 测试

```bash
./publishers/tests/run_tests.sh
```

## 来源与许可

- `zhihu-publisher`：整合自 [ArchAIHarness/agent-workflows](https://github.com/ArchAIHarness/agent-workflows)（MIT）的知乎 Draft.js 领域知识
- `toutiao-publisher`：整合自 [guanyang/super-publisher](https://github.com/guanyang/super-publisher)（MIT）的头条 ProseMirror 发布流程
- `humanize-writing`：原 opencode-publisher 技能（MIT）

各目录内的 `SKILL.md`、脚本与依赖保持原有 MIT 许可。
