# WADE 集成说明

本项目已接入 [WADE](https://github.com/ivanviragine/wade)（`wade-cli`）作为 **AI 驱动的工程工作流**：任务源、计划、隔离 worktree、AI 实现会话、PR 全部由 WADE 串联。

> WADE 是开发期工具，**不进入扩展产物**（`.wade.yml` / `ISSUES.md` / 本文件均已在 `.vscodeignore` 中排除）。

---

## 已完成

| 项 | 值 |
| --- | --- |
| CLI | `wade 1.2.16`（通过 `uv tool install wade-cli` 安装） |
| 配置文件 | `.wade.yml`（已提交） |
| 任务源 | **Markdown provider** → `ISSUES.md` |
| AI 工具 | `opencode`（`wade init` 自动检测） |
| issue label | `feature-plan`（WADE 的任务过滤标签） |
| worktree 目录 | `../.worktrees/smart-publisher`（仓库外，避免污染工作区） |
| 初始 backlog | `ISSUES.md` 中 #1 ~ #7 |

---

## 前置条件

- **`gh auth login`**：WADE 的 PR / review 流程依赖 GitHub CLI。未登录时 `task list` / `task read` 正常，但 `plan` / `implement` 的 PR 步骤会失败。
- **AI 工具**：当前检测到 `opencode`。也可在 `.wade.yml` 的 `ai.default_tool` 换成 `claude` / `codex` / `copilot` 等（需自行安装）。

---

## 常用命令

```bash
# 查看 / 读取任务
wade task list
wade task read 2

# 校验配置
wade check-config

# 计划：把目标拆成计划文件 + 轻量任务 + 草稿 PR（需要 gh）
wade plan

# 开始任务 2：创建隔离 worktree、加载完整上下文、启动 AI 会话
wade 2

# 并行做多个任务
wade implement-batch 1 2 3

# 会话收尾（合并 main、写 PR 描述、标记 ready）
wade implementation-session done

# 查看 / 清理 worktree
wade worktree list
wade worktree remove <name>
```

> 简写：`wade <数字>` 会根据该任务的 PR 状态自动路由到「实现」或「评审」。

---

## 任务源格式（`ISSUES.md`）

WADE 的 Markdown provider 以 `## #<id> <标题>` 为一节，元数据放在 `<!-- wade ... -->` 注释里：

```markdown
## #8 新增 XX 功能

<!-- wade
state: open
labels: feature-plan, feature, complexity:medium
-->

背景与验收标准写在这里。
```

- `state`：`open` / `closed`
- `labels`：逗号分隔；**必须包含 `feature-plan`**，否则 `wade task list` 不会显示
- `complexity`：`easy` / `medium` / `complex` / `very_complex`，用于自动选模型

新增任务也可以直接用 CLI（会写回 `ISSUES.md`）：

```bash
wade task create --title "新增 XX 功能" --labels feature-plan,feature
```

---

## 注意事项

- `.wade/` 是 WADE 的内部状态目录（SQLite / 审计日志 / 受管清单），自带 `.gitignore`（内容为 `*`），**不要提交**。
- 需要提交的只有 `.wade.yml`、`ISSUES.md`、本文件。
- 没有 `gh auth` 时，建议先用 `wade task list/read` 管理 backlog；等 `gh auth login` 后再跑 `wade plan` / `wade <N>`。
- 若不想再用 WADE：`wade deinit`（会移除 `.wade.yml` 与 `.wade/`）。
