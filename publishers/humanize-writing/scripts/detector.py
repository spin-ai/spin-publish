#!/usr/bin/env python3
"""AI-flavor detector for Chinese articles.

Scores how "AI-written" a piece of Markdown feels by matching lexical
fingerprints (cliché openings, buzzwords, filler phrases, grand endings,
clickbait titles) and structural signals (uniform paragraph rhythm, list
overuse, bold overuse). Pure standard library.

Exit codes: 0 report produced; 1 score exceeded --threshold.
"""

import argparse
import json
import re
import sys
from pathlib import Path

# (compiled_pattern, category, severity, suggestion)
RULES = [
    # --- Openings: grand background before the actual point ---
    (re.compile(r"在当今.{0,8}(快速发展|飞速发展|日新月异|瞬息万变)"), "开头套话", "high", "删掉宏大背景，第一句直接进入正题"),
    (re.compile(r"随着.{2,24}的(普及|发展|进步|推广|浪潮|深入|不断演进|广泛应用)"), "开头套话", "high", "删掉“随着…”式背景铺垫"),
    (re.compile(r"(近年来|当下|如今)，?.{0,10}(AI|人工智能|大模型|GPT)"), "开头套话", "medium", "AI 话题开场几乎必是模板，换成具体问题或场景"),
    # --- Endings: grand summary / engagement bait ---
    (re.compile(r"在这个.{2,16}的(时代|今天|背景下)"), "升华结尾", "high", "删掉时代感慨，用一句实在话收尾"),
    (re.compile(r"让我们(一起|来|共同)(期待|努力|迎接|探索)"), "升华结尾", "high", "删掉“让我们”句式"),
    (re.compile(r"(希望|相信)(本文|这篇|以上|这篇文章?)(对你|对大家|对各位|对你有所)?帮?助?"), "客套结尾", "high", "换成资源链接，或直接删"),
    (re.compile(r"(总而言之|综上所述|总的来说|由此可见|综合来看)"), "总结套话", "medium", "删掉，直接给结论"),
    # --- Filler / hedging ---
    (re.compile(r"(值得注意的是|值得一提的是|不得不说|需要指出的是|更重要的是|更重要的是)"), "填充语", "medium", "删掉提示语，直接陈述事实"),
    (re.compile(r"(众所周知|毋庸置疑|不言而喻|显然)"), "套话", "medium", "删掉；真的人尽皆知就无需说"),
    (re.compile(r"(简单来说|换句话说|也就是说)[，,]"), "解释填充", "low", "偶尔可以，连续出现就是模板感"),
    # --- Mechanical connectives ---
    (re.compile(r"(首先|其次|再次|最后)[，,、]"), "机械连接词", "medium", "去掉序号词，用内容自然衔接"),
    (re.compile(r"(一方面|另一方面)[，,]"), "机械连接词", "low", "拆开写，别成对出现"),
    (re.compile(r"不仅.{2,36}[，,](而且|还)"), "排比结构", "low", "拆成两句，或只留一半"),
    # --- Buzzwords ---
    (re.compile(r"(赋能|抓手|闭环|颗粒度|打法|沉淀|拉通|底层逻辑|顶层设计|组合拳|方法论|心智|壁垒|护城河)"), "黑话", "medium", "换成大白话"),
    # --- Clickbait ---
    (re.compile(r"(深度解析|深度剖析|全面解析|深入探讨|一文读懂|一文吃透|一文搞懂|保姆级|手把手|小白也能|看这一篇就够了)"), "标题党", "high", "换成朴素、具体的标题"),
    (re.compile(r"(干货|精华|宝藏|绝了|yyds|吊打|碾压)"), "营销腔", "medium", "删掉或换成对内容的客观描述"),
    # --- Vague intensifiers ---
    (re.compile(r"(极大地|显著地|有效地|充分地|大幅(度)?(提升|提高|优化|降低))"), "空泛程度词", "medium", "用具体数字替代（快了 40%？省了 3 倍？）"),
    (re.compile(r"(非常|十分|极其|相当|超级)"), "程度副词", "low", "删掉或换成具体程度"),
    (re.compile(r"(很多|大量|不少)(情况|时候|场景)下?"), "模糊量化", "medium", "换成具体条件（在 5 万 QPS 以上时？）"),
    # --- Emoji ---
    (re.compile(r"[\U0001F300-\U0001FAFF\u2705\u274C\u2728\u2753\u2757\u2714\u2716\u2B50]"), "emoji", "low", "按目标平台规范删减；正文堆 emoji 是强 AI 信号"),
]

WEIGHTS = {"high": 3, "medium": 2, "low": 1}
GRADE_BANDS = (
    (25, "自然（人味合格）"),
    (50, "有 AI 痕迹"),
    (75, "AI 味明显"),
    (101, "浓厚 AI 味"),
)

BULLET_PATTERN = re.compile(r"^\s*([-*+]|\d+[.)])\s")
PARAGRAPH_SKIP_PREFIXES = ("#", "-", "*", ">", "|", "```", "!")


def grade(score: int) -> str:
    for threshold, label in GRADE_BANDS:
        if score < threshold:
            return label
    return GRADE_BANDS[-1][1]


FENCE_LINE = re.compile(r"^\s*(`{3,}|~{3,})")


def scan_hits(text: str) -> list:
    hits = []
    fence_char = None
    fence_len = 0
    for lineno, line in enumerate(text.split("\n"), start=1):
        fence_match = FENCE_LINE.match(line)
        if fence_match:
            marker = fence_match.group(1)
            if fence_char is None:
                fence_char = marker[0]
                fence_len = len(marker)
            elif marker[0] == fence_char and len(marker) >= fence_len:
                fence_char = None
            continue
        if fence_char is not None:
            continue  # code fences are quoted material, not the author's voice
        for pattern, category, severity, suggestion in RULES:
            for match in pattern.finditer(line):
                hits.append(
                    {
                        "line": lineno,
                        "category": category,
                        "severity": severity,
                        "excerpt": match.group(0)[:40],
                        "suggestion": suggestion,
                    }
                )
    return hits


def analyze_structure(text: str) -> dict:
    lines = text.split("\n")
    nonempty = [line for line in lines if line.strip()]
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    prose_lengths = [
        len(p) for p in paragraphs if not p.startswith(PARAGRAPH_SKIP_PREFIXES)
    ]

    structure = {
        "bullet_ratio": 0.0,
        "paragraph_cv": None,
        "bold_count": len(re.findall(r"\*\*[^*\n]+\*\*", text)),
    }
    if nonempty:
        bullet_lines = sum(1 for line in nonempty if BULLET_PATTERN.match(line))
        structure["bullet_ratio"] = round(bullet_lines / len(nonempty), 3)
    if len(prose_lengths) >= 4:
        mean = sum(prose_lengths) / len(prose_lengths)
        std = (sum((x - mean) ** 2 for x in prose_lengths) / len(prose_lengths)) ** 0.5
        structure["paragraph_cv"] = round(std / mean, 3) if mean else 0.0
    return structure


def compute_score(hits: list, char_count: int, structure: dict) -> dict:
    if char_count == 0:
        return {"score": 0, "density": 0.0, "penalties": []}

    weighted = sum(WEIGHTS[hit["severity"]] for hit in hits)
    density = weighted / (char_count / 1000)
    score = density * 6
    penalties = []

    if structure["paragraph_cv"] is not None and structure["paragraph_cv"] < 0.25:
        score += 8
        penalties.append("段落长度过于均匀（变异系数 < 0.25），像模板生成")
    if structure["bullet_ratio"] > 0.4:
        score += 5
        penalties.append(f"列表行占比 {structure['bullet_ratio']:.0%}，过高")
    if structure["bold_count"] > char_count / 200:
        score += 4
        penalties.append(f"加粗 {structure['bold_count']} 处，密度过高")

    return {
        "score": min(100, round(score)),
        "density": round(density, 2),
        "penalties": penalties,
    }


def build_report(text: str, source: str) -> dict:
    char_count = len(re.sub(r"\s", "", text))
    hits = scan_hits(text)
    structure = analyze_structure(text)
    scoring = compute_score(hits, char_count, structure)

    by_category = {}
    for hit in hits:
        entry = by_category.setdefault(
            hit["category"], {"count": 0, "severity": hit["severity"]}
        )
        entry["count"] += 1

    top_suggestions = sorted(hits, key=lambda h: (WEIGHTS[h["severity"]] * -1, h["line"]))[:8]

    return {
        "source": source,
        "char_count": char_count,
        "score": scoring["score"],
        "grade": grade(scoring["score"]),
        "density_per_1000": scoring["density"],
        "total_hits": len(hits),
        "by_category": by_category,
        "structure": structure,
        "structure_penalties": scoring["penalties"],
        "top_suggestions": top_suggestions,
    }


def render_text_report(report: dict) -> str:
    lines = [
        f"AI 味检测报告: {report['source']}",
        f"分数: {report['score']}/100（{report['grade']}）",
        f"正文 {report['char_count']} 字，加权命中密度 {report['density_per_1000']}/千字，命中 {report['total_hits']} 处",
        "",
        "分类命中:",
    ]
    for category, entry in sorted(
        report["by_category"].items(),
        key=lambda kv: (WEIGHTS[kv[1]["severity"]] * -1, kv[1]["count"] * -1),
    ):
        lines.append(f"  {category}: {entry['count']} 处 [{entry['severity']}]")
    lines.append("")
    lines.append("结构指标:")
    structure = report["structure"]
    cv = structure["paragraph_cv"]
    lines.append(
        f"  段落长度变异系数: {cv if cv is not None else '样本不足'}"
        + ("（过于均匀）" if cv is not None and cv < 0.25 else "")
    )
    lines.append(
        f"  列表行占比: {structure['bullet_ratio']:.0%}"
        + ("（过高）" if structure["bullet_ratio"] > 0.4 else "")
    )
    lines.append(f"  加粗: {structure['bold_count']} 处")
    for penalty in report["structure_penalties"]:
        lines.append(f"  ⚠ {penalty}")
    if report["top_suggestions"]:
        lines.append("")
        lines.append("优先改写建议:")
        for index, hit in enumerate(report["top_suggestions"], start=1):
            lines.append(
                f"  {index}. 第 {hit['line']} 行 “{hit['excerpt']}” → {hit['suggestion']}"
            )
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="AI-flavor detector")
    parser.add_argument("file", help="Path to a UTF-8 Markdown file")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    parser.add_argument(
        "--threshold", type=int, default=None,
        help="Exit with code 1 when the score exceeds this value (CI gate)",
    )
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    path = Path(args.file).expanduser()
    if not path.is_file():
        print(f"File not found: {path}", file=sys.stderr)
        return 2
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        print("File is empty", file=sys.stderr)
        return 2

    report = build_report(text, str(path))
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        print(render_text_report(report))

    if args.threshold is not None and report["score"] > args.threshold:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
