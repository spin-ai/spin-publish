"""Unit tests for the Zhihu Markdown adapter."""

import sys
import unittest
from pathlib import Path

SKILL_SCRIPTS = (
    Path(__file__).resolve().parent.parent
    / "zhihu-publisher" / "scripts"
)
sys.path.insert(0, str(SKILL_SCRIPTS))

from zhihu_markdown import (  # noqa: E402
    MarkdownValidationError,
    _pick_anchor,
    normalize_match_text,
    prepare_zhihu_article,
)

SAMPLE = """# 我的第一篇文章

这是导语段落，介绍全文主题。

## 第一节 概述

第一节的内容文字。

![图一](./assets/fig1.png)

### 1.1 小节

小节内容。

![图二](assets/fig2.png)

## 第二节 总结

结论文字。

```bash
# 这行是注释，不是标题
echo hello
```
"""


class TestPrepareZhihuArticle(unittest.TestCase):
    def test_title_extraction_and_level_promotion(self):
        article = prepare_zhihu_article(SAMPLE)
        self.assertEqual(article.title, "我的第一篇文章")
        body = article.body_md
        self.assertNotIn("# 我的第一篇文章", body)
        self.assertIn("# 第一节 概述", body)      # ## promoted to #
        self.assertIn("## 1.1 小节", body)         # ### promoted to ##
        self.assertEqual(article.h2_count, 2)      # two '#' lines
        self.assertEqual(article.h3_count, 1)      # one '##' line

    def test_images_stripped_with_anchors(self):
        article = prepare_zhihu_article(SAMPLE)
        self.assertNotIn("![", article.body_md)
        self.assertEqual(len(article.images), 2)
        first, second = article.images
        self.assertTrue(first.path.endswith("fig1.png"))
        self.assertTrue(second.path.endswith("fig2.png"))
        self.assertIn("第一节的内容文字", first.anchor_text)
        self.assertIn("小节内容", second.anchor_text)

    def test_anchor_uniqueness_with_duplicate_paragraphs(self):
        markdown = (
            "# 标题\n\n"
            "重复段落内容完全一样。\n\n![a](a.png)\n\n"
            "中间的其他文字。\n\n"
            "重复段落内容完全一样。\n\n![b](b.png)\n"
        )
        article = prepare_zhihu_article(markdown)
        anchors = [image.anchor_text for image in article.images]
        self.assertEqual(len(anchors), 2)
        occurrences = [image.occurrence for image in article.images]
        self.assertEqual(occurrences, [0, 1])

    def test_explicit_title_overrides_h1(self):
        article = prepare_zhihu_article(SAMPLE, title="自定义标题")
        self.assertEqual(article.title, "自定义标题")

    def test_code_fence_protected(self):
        article = prepare_zhihu_article(SAMPLE)
        self.assertIn("# 这行是注释，不是标题", article.body_md)
        self.assertIn("```bash", article.body_md)

    def test_frontmatter_stripped(self):
        markdown = "---\ntitle: meta\n---\n\n# 正文标题\n\n内容。\n"
        article = prepare_zhihu_article(markdown)
        self.assertEqual(article.title, "正文标题")
        self.assertNotIn("---", article.body_md)

    def test_relative_image_resolved_against_base_dir(self):
        markdown = "# 标题\n\n段落。\n\n![img](pics/a.png)\n"
        article = prepare_zhihu_article(markdown, base_dir="/tmp/base")
        self.assertEqual(article.images[0].path, str(Path("/tmp/base/pics/a.png").resolve()))

    def test_remote_image_rejected(self):
        markdown = "# 标题\n\n段落。\n\n![img](https://example.com/a.png)\n"
        with self.assertRaises(MarkdownValidationError):
            prepare_zhihu_article(markdown)

    def test_empty_content_rejected(self):
        with self.assertRaises(MarkdownValidationError):
            prepare_zhihu_article("   \n\n")

    def test_missing_title_rejected(self):
        with self.assertRaises(MarkdownValidationError):
            prepare_zhihu_article("只有正文没有标题。\n")

    def test_first_sentence(self):
        article = prepare_zhihu_article(SAMPLE)
        self.assertTrue(article.first_sentence)
        self.assertIn("导语", article.first_sentence)

    def test_image_after_code_fence_uses_last_code_line_as_anchor(self):
        markdown = (
            "# 标题\n\n"
            "## 结构\n\n"
            "```text\n"
            "root\n"
            "└─ leaf\n"
            "```\n\n"
            "![图](fig.png)\n\n"
            "后记。\n"
        )
        article = prepare_zhihu_article(markdown)
        image = article.images[0]
        self.assertNotIn("```", image.anchor_text)
        self.assertIn("leaf", image.anchor_text)

    def test_image_after_horizontal_rule_uses_previous_text_anchor(self):
        # Horizontal rules are stripped by the Zhihu import and cannot be
        # located in Draft.js, so they must not become image anchors.
        markdown = (
            "# 标题\n\n"
            "> 如果你只读一段，读这一段。\n\n"
            "---\n\n"
            "![图](fig.png)\n\n"
            "*图注*\n\n"
            "## 下一节\n\n"
            "正文。\n"
        )
        article = prepare_zhihu_article(markdown)
        image = article.images[0]
        self.assertNotEqual(image.anchor_text.strip("-*_ "), "")
        self.assertNotIn("---", image.anchor_text)
        self.assertIn("如果你只读一段", image.anchor_text)

    def test_horizontal_rule_variants_are_not_anchors(self):
        for rule in ("---", "***", "___", "- - -", "* * *"):
            markdown = f"# 标题\n\n段落文字。\n\n{rule}\n\n![图](fig.png)\n"
            with self.subTest(rule=rule):
                article = prepare_zhihu_article(markdown)
                self.assertIn("段落文字", article.images[0].anchor_text)

    def test_anchor_matching_ignores_zero_width_characters(self):
        # Zhihu injects U+200B after inline code/links inside blockquotes.
        editor_block = " 第一篇：\u200bARTICLE-zhihu-multi-agent-terminal.md"
        self.assertEqual(
            normalize_match_text(editor_block),
            "第一篇：ARTICLE-zhihu-multi-agent-terminal.md",
        )
        anchor_text, occurrence = _pick_anchor(
            "第一篇：ARTICLE-zhihu-multi-agent-terminal.md",
            0,
            [editor_block, "其他段落"],
        )
        self.assertEqual(occurrence, 0)
        self.assertTrue(
            "第一篇：ARTICLE-zhihu-multi-agent-terminal.md".startswith(anchor_text)
        )
        self.assertNotIn("\u200b", anchor_text)


if __name__ == "__main__":
    unittest.main()
