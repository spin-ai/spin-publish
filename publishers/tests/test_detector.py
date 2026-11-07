"""Unit tests for the humanize-writing AI-flavor detector."""

import sys
import unittest
from pathlib import Path

SKILL_SCRIPTS = (
    Path(__file__).resolve().parent.parent
    / "humanize-writing" / "scripts"
)
sys.path.insert(0, str(SKILL_SCRIPTS))

import detector  # noqa: E402

AI_TEXT = """在当今快速发展的时代，随着人工智能的普及，越来越多的开发者开始关注大模型技术。

首先，大模型极大地提升了开发效率。其次，它显著地降低了使用门槛。最后，它赋能了各行各业。

值得注意的是，选择模型时需要考虑很多情况。众所周知，理解底层逻辑非常重要。

- 要点一：模型规模
- 要点二：数据质量
- 要点三：推理成本

总而言之，在这个AI的时代，让我们一起迎接未来。希望本文对你有帮助！
"""

HUMAN_TEXT = """上周把日志服务从 ELK 迁到了 Loki，省了三分之二的服务器钱。

迁移本身不难，难的是 Grafana 面板。官方文档那套 label 设计我照抄了，结果查询直接超时——查了三小时，最后发现是 label 基数爆炸。

现在稳定跑了两周，偶尔丢几条日志。我忍了，反正老板不看日志。
"""


class TestDetector(unittest.TestCase):
    def test_ai_text_scores_high(self):
        report = detector.build_report(AI_TEXT, "ai.md")
        self.assertGreaterEqual(report["score"], 60)
        self.assertEqual(report["grade"], "浓厚 AI 味")
        categories = set(report["by_category"])
        self.assertIn("开头套话", categories)
        self.assertIn("升华结尾", categories)
        self.assertIn("机械连接词", categories)

    def test_human_text_scores_low(self):
        report = detector.build_report(HUMAN_TEXT, "human.md")
        self.assertLessEqual(report["score"], 10)
        self.assertEqual(report["grade"], "自然（人味合格）")
        self.assertEqual(report["total_hits"], 0)

    def test_line_numbers_in_hits(self):
        report = detector.build_report(AI_TEXT, "ai.md")
        self.assertTrue(all(hit["line"] >= 1 for hit in report["top_suggestions"]))
        first_line_hits = [
            hit for hit in report["top_suggestions"] if hit["line"] == 1
        ]
        self.assertTrue(any("在当今" in hit["excerpt"] for hit in first_line_hits))

    def test_uniform_paragraphs_penalized(self):
        text = "\n\n".join(["这是一段长度完全一致的段落内容，第%d部分。" % i for i in range(6)])
        report = detector.build_report(text, "uniform.md")
        self.assertLess(report["structure"]["paragraph_cv"], 0.25)
        self.assertTrue(report["structure_penalties"])

    def test_score_band_labels(self):
        self.assertEqual(detector.grade(0), "自然（人味合格）")
        self.assertEqual(detector.grade(30), "有 AI 痕迹")
        self.assertEqual(detector.grade(60), "AI 味明显")
        self.assertEqual(detector.grade(90), "浓厚 AI 味")

    def test_code_fence_content_ignored(self):
        text = "```\n首先，这段在代码块里\n总而言之，这是注释\n```\n\n正文一句话。\n"
        report = detector.build_report(text, "code.md")
        self.assertEqual(report["total_hits"], 0)


if __name__ == "__main__":
    unittest.main()
