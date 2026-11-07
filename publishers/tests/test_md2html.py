"""Unit tests for the Toutiao Markdown -> HTML converter."""

import sys
import unittest
from pathlib import Path

SKILL_SCRIPTS = (
    Path(__file__).resolve().parent.parent
    / "toutiao-publisher" / "scripts"
)
sys.path.insert(0, str(SKILL_SCRIPTS))

from md2html import convert_with_images  # noqa: E402

SAMPLE = """# Title

Intro paragraph with **bold**.

![first](./img/one.png)

- item 1
- item 2

```python
# not a heading
print("code")
```

![second](img/two.jpg)
"""


class TestConvertWithImages(unittest.TestCase):
    def test_basic_conversion(self):
        converted = convert_with_images("# 标题\n\n正文 **加粗**。\n")
        self.assertIn("<h1>", converted.html)
        self.assertIn("<strong>加粗</strong>", converted.html)
        self.assertEqual(converted.images, [])

    def test_images_replaced_with_placeholders(self):
        converted = convert_with_images(SAMPLE, base_dir="/tmp/base")
        html = converted.html
        self.assertNotIn("<img", html)
        self.assertIn("TTIMGPH_0", html)
        self.assertIn("TTIMGPH_1", html)
        self.assertEqual(len(converted.images), 2)
        self.assertEqual(converted.images[0]["placeholder"], "TTIMGPH_0")
        self.assertEqual(converted.images[0]["alt"], "first")
        self.assertEqual(converted.images[0]["path"], str(Path("/tmp/base/img/one.png").resolve()))
        self.assertEqual(converted.images[1]["path"], str(Path("/tmp/base/img/two.jpg").resolve()))

    def test_image_inside_code_fence_is_untouched(self):
        markdown = '# T\n\n```md\n![keep](a.png)\n```\n'
        converted = convert_with_images(markdown)
        self.assertEqual(converted.images, [])
        self.assertIn("![keep](a.png)", converted.html)

    def test_remote_images_kept_as_url(self):
        converted = convert_with_images("![r](https://example.com/x.png)\n")
        self.assertEqual(converted.images[0]["path"], "https://example.com/x.png")

    def test_lists_and_code_render(self):
        converted = convert_with_images(SAMPLE)
        self.assertIn("<li>", converted.html)
        self.assertIn("<code", converted.html)


if __name__ == "__main__":
    unittest.main()
