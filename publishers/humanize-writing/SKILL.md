---
name: humanize-writing
description: Remove the AI flavor from Chinese articles before publishing. Use for requests like 去AI味、人味改写、改得像人写的、去机器味、自然文风润色、降AI痕迹. Scores the draft with a detector script, rewrites cliché openings, buzzwords, filler phrases, uniform paragraph rhythm and grand endings toward a natural human voice, then re-checks the score — without fabricating details or changing technical facts.
license: MIT
compatibility: opencode
metadata:
  task: rewrite
  language: chinese
---

# Humanize Writing（去 AI 味改写）

把一篇文章改得像人写的。Resolve the directory containing this `SKILL.md`
first and set its absolute path as `SKILL_DIR`.

## 红线（先读这个）

1. **不改事实**：技术内容、数据、结论、代码、术语一律不改变含义，只动表达方式。
2. **不编造**：所有新增的“人味细节”（具体数字、经历、踩坑）必须来自原文或用户；缺素材时写 `[待补：真实细节——比如具体版本号/耗时/报错]` 让用户填，绝不替用户编。
3. **保留作者的术语和口癖**：作者本来怎么说就怎么说，改写不是统一腔调。
4. **不确定就问**：拿不准某段是作者本意还是 AI 生成时，先问用户。

## 工作流

### 第 1 步：检测

```bash
python3 "$SKILL_DIR/scripts/detector.py" "/absolute/path/article.md" --json
```

纯标准库，无需虚拟环境。记录 `score`、`by_category`、`structure_penalties`
和 `top_suggestions`，作为改写清单。

### 第 2 步：按下面的手法改写

先处理 high 命中，再处理结构惩罚，最后顺手清 low 命中。

### 第 3 步：复检

把改写稿存到新文件（如 `article.humanized.md`），再次跑 detector，对比分数。
目标：score 降到 25 以下，且无 high 级命中残留。

### 第 4 步：输出报告

向用户汇报：改了哪些类别、分数变化（前 → 后）、仍标记 `[待补]` 的位置清单。

## 改写手法对照表

| AI 味 | 人味 |
|---|---|
| 在当今快速发展的时代 / 随着 AI 的普及… | 直接删。第一句进入正题：具体问题、场景或结论 |
| 值得注意的是 / 需要指出的是 | 删掉提示语，直接陈述 |
| 众所周知 / 毋庸置疑 | 删。人尽皆知就不用写 |
| 首先…其次…最后… | 去掉序号词，让内容自己衔接；或干脆拆成小标题 |
| 不仅 X 而且 Y | 拆成两句，或只留重要的那一半 |
| 极大地提升了效率 | 快了 40%（用原文/用户给的真实数字） |
| 在很多情况下 | 在 5 万 QPS 以上时（换成具体触发条件） |
| 赋能 / 抓手 / 闭环 / 底层逻辑 / 方法论 | 大白话：帮上了什么忙、卡在哪、怎么绕过去 |
| 深度解析 / 一文吃透 / 保姆级 / 手把手 | 朴素标题：《把服务迁到 k8s 踩的三个坑》 |
| 总而言之 / 综上所述 | 删，或直接给最后一条实在信息 |
| 在这个 AI 的时代，让我们一起… | 删。用一句实在话收尾：完整代码在 repo，自取 |
| 希望本文对你有帮助 | 删，或换资源链接 |
| 正文 emoji 成串（✨💡🚀） | 按目标平台删减；知乎正文基本全删 |

## 节奏与结构规则

AI 文章最暴露的不是词，是**节奏太均匀**。改写时：

1. **段落要有长短起伏**。detector 的 `paragraph_cv < 0.25` 报警时，把几个中庸段落合并成一段长的、再拆出一个一句话的短段落。一句话成段不是错误。
2. **列表降密度**。`bullet_ratio > 40%` 时，把一部分 bullet 展开成连贯段落；列表只留真正的枚举（配置项、命令、版本号）。
3. **少加粗**。加粗是 AI 的口癖。每屏最多一处，或全删。
4. **允许不完美**。口语、插入语、破折号打断句（“其实——算了，这个不重要”）都是人味。偶尔用短句收尾。“嗯”式的迟疑可以有一点，别过量。
5. **删空洞段落**。每段问一句：删掉它读者损失什么？损失不了就整段删。AI 文章普遍长 20-30%，删比改更有效。

## 观点与细节（人味的核心）

- **有倾向**：删掉两边讨好的表述（“各有优劣，视情况选择”）。作者有立场就写明白：“我就是觉得 YAML 缩进反人类”。
- **有过程**：把结论展开成时间线——“查了三小时，先怀疑 A，排除；再看日志发现 B”。AI 只给结论，人写踩坑。
- **有数字**：版本号、耗时、金额、QPS、行数。所有“很多/大量/显著”都尝试替换成具体量（先查原文有没有，没有就标 `[待补]`）。
- **有取舍**：人会说“这个方案也有问题，但我还是选它，因为…”。承认缺点的推荐才可信。

## 平台适配（可选）

- 与 `zhihu-publisher` / `toutiao-publisher` 技能联动时：先完成本技能改写并复检达标，再调用发布技能。
- 知乎：可以保留一点口语和第一人称；标题保守。
- 头条：句子更短，段落更碎，标题可以具体但别标题党（标题党规则命中会拉高分数）。

## 检测脚本参考

- `score`：0-24 自然；25-49 有 AI 痕迹；50-74 AI 味明显；75+ 浓厚。
- `--threshold N`：分数超过 N 时退出码 1，可当流水线门禁。
- 检测器只认特征模式，低分不等于写得好；它管“像不像人”，好不好读由你和用户判断。
