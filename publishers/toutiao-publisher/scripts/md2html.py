"""Markdown -> HTML conversion that preserves inline image positions.

Inline images are replaced with ``TTIMGPH_<n>`` placeholders in the HTML; the
publisher later replaces each placeholder with the real image pasted from the
clipboard.
"""

import re
from dataclasses import dataclass
from pathlib import Path

import markdown as markdown_lib

IMAGE_PATTERN = re.compile(
    r"!\[([^\]]*)\]\(\s*"
    r"(?:<([^>]+)>|((?:\\.|[^()\s]|\([^)]*\))+))"
    r"(?:\s+[\"'][^\"']*[\"'])?\s*\)"
)
FENCE_PATTERN = re.compile(r"^\s*(`{3,}|~{3,})")


@dataclass
class ConvertedMarkdown:
    html: str
    images: list


def _resolve_image_path(raw_path, base_dir):
    cleaned = raw_path.strip().strip("<>").strip("\"'")
    if cleaned.startswith(("http://", "https://", "data:")):
        return cleaned
    path = Path(cleaned)
    if not path.is_absolute() and base_dir is not None:
        path = Path(base_dir) / path
    return str(path.resolve())


def _replace_markdown_images(line, images, base_dir):
    def replace(match):
        placeholder = f"TTIMGPH_{len(images)}"
        raw_path = match.group(2) or match.group(3)
        images.append(
            {
                "placeholder": placeholder,
                "path": _resolve_image_path(raw_path, base_dir),
                "alt": match.group(1).strip(),
            }
        )
        return placeholder

    return IMAGE_PATTERN.sub(replace, line)


def _extract_images(text, base_dir):
    images = []
    converted_lines = []
    fence_character = None
    fence_length = 0

    for line in text.splitlines():
        fence_match = FENCE_PATTERN.match(line)
        if fence_match:
            marker = fence_match.group(1)
            if fence_character is None:
                fence_character = marker[0]
                fence_length = len(marker)
            elif marker[0] == fence_character and len(marker) >= fence_length:
                fence_character = None
                fence_length = 0
            converted_lines.append(line)
            continue
        converted_lines.append(
            line
            if fence_character is not None
            else _replace_markdown_images(line, images, base_dir)
        )

    return "\n".join(converted_lines), images


def convert_with_images(text, base_dir=None):
    prepared_text, images = _extract_images(text, base_dir)
    html = markdown_lib.markdown(
        prepared_text,
        extensions=["extra", "sane_lists"],
        output_format="html5",
    )
    return ConvertedMarkdown(html=html, images=images)


def convert(text):
    return convert_with_images(text).html
