"""Markdown adaptation for the Zhihu Draft.js editor.

Zhihu quirks handled here (verified by the agent-workflows project):

1. The article title goes into a separate input, so the leading ``# H1`` line is
   stripped from the body.
2. Zhihu maps imported ``#`` to H2 and ``##`` to H3, so heading levels are
   promoted by one to preserve the section / sub-section hierarchy.
3. Images must be uploaded separately through the editor's resident file input,
   so image lines are stripped from the import file and collected into an
   ordered manifest. Each manifest entry carries an ``anchor_text`` (a short,
   preferably unique substring of the block that should immediately precede the
   image) plus an ``occurrence`` index used to disambiguate duplicate anchors.
"""

import re
from dataclasses import dataclass, field
from pathlib import Path

FRONTMATTER_PATTERN = re.compile(r"\A---\s*\n.*?\n---\s*\n?", re.DOTALL)
HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(.*)$")
IMAGE_LINE_PATTERN = re.compile(
    r"^\s*!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+[\"'][^\"']*[\"'])?\s*\)\s*$"
)
FENCE_PATTERN = re.compile(r"^\s*(`{3,}|~{3,})")

ANCHOR_SHORT = 20
ANCHOR_LONG = 45


class MarkdownValidationError(ValueError):
    pass


@dataclass
class ZhihuImage:
    index: int
    path: str
    alt: str
    anchor_text: str
    occurrence: int = 0

    def to_dict(self):
        return {
            "index": self.index,
            "path": self.path,
            "alt": self.alt,
            "anchor_text": self.anchor_text,
            "occurrence": self.occurrence,
        }


@dataclass
class ZhihuArticle:
    title: str
    body_md: str
    images: list = field(default_factory=list)
    h2_count: int = 0  # expected H2 blocks after import ('#' lines in body)
    h3_count: int = 0  # expected H3 blocks after import ('##' lines in body)
    first_sentence: str = ""

    def to_dict(self):
        return {
            "title": self.title,
            "h2_count": self.h2_count,
            "h3_count": self.h3_count,
            "first_sentence": self.first_sentence,
            "images": [image.to_dict() for image in self.images],
        }


def strip_frontmatter(markdown: str) -> str:
    return FRONTMATTER_PATTERN.sub("", markdown, count=1)


def _block_text(line: str) -> str:
    """Plain text of a markdown block, for anchor matching purposes."""
    text = line.strip()
    text = re.sub(r"[*_`]{1,3}([^*_`]+)[*_`]{1,3}", r"\1", text)
    text = re.sub(r"^\s*(?:>|[-*+]|\d+[.)])\s+", "", text)
    text = re.sub(r"^#{1,6}\s+", "", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    return text.strip()


def _promote_heading(line: str) -> str:
    match = HEADING_PATTERN.match(line)
    if not match:
        return line
    level = len(match.group(1))
    return "#" * max(1, level - 1) + " " + match.group(2)


def _resolve_image_path(raw_path: str, base_dir) -> str:
    if raw_path.startswith(("http://", "https://", "data:")):
        return raw_path
    path = Path(raw_path)
    if not path.is_absolute() and base_dir is not None:
        path = Path(base_dir) / path
    return str(path.resolve())


def _count_headings_outside_fences(lines) -> tuple:
    """Count '#' (-> H2) and '##' (-> H3) lines, skipping code fences."""
    h2 = 0
    h3 = 0
    fence_char = None
    fence_len = 0
    for line in lines:
        fence_match = FENCE_PATTERN.match(line)
        if fence_match:
            marker = fence_match.group(1)
            if fence_char is None:
                fence_char = marker[0]
                fence_len = len(marker)
            elif marker[0] == fence_char and len(marker) >= fence_len:
                fence_char = None
                fence_len = 0
            continue
        if fence_char is not None:
            continue
        if re.match(r"^#\s", line):
            h2 += 1
        elif re.match(r"^##\s", line):
            h3 += 1
    return h2, h3


def _pick_anchor(anchor_block: str, anchor_index: int, all_blocks) -> tuple:
    """Return (anchor_text, occurrence) for an anchor block, preferring uniqueness."""
    anchor_block = anchor_block.strip()
    if not anchor_block:
        return "", 0

    for length in (ANCHOR_SHORT, ANCHOR_LONG, len(anchor_block)):
        candidate = anchor_block[:length]
        matches = [i for i, block in enumerate(all_blocks) if candidate in block]
        if len(matches) == 1:
            return candidate, 0
        if anchor_index in matches:
            return candidate, matches.index(anchor_index)

    return anchor_block[:ANCHOR_SHORT], 0


def prepare_zhihu_article(markdown: str, base_dir=None, title: str = "") -> ZhihuArticle:
    """Convert generic blog Markdown into a Zhihu-ready import body + image manifest."""
    text = strip_frontmatter(markdown).replace("\r\n", "\n").strip()
    if not text:
        raise MarkdownValidationError("Article content is empty")

    lines = text.split("\n")

    # Pass 1: split into operations, strip the leading H1 (it becomes the title).
    derived_title = ""
    body_start = 0
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        match = HEADING_PATTERN.match(line)
        if match and len(match.group(1)) == 1:
            derived_title = match.group(2).strip()
            body_start = index + 1
        break
    lines = lines[body_start:]

    operations = []  # ("image", alt, raw_path) | ("text", line)
    fence_char = None
    fence_len = 0
    for line in lines:
        fence_match = FENCE_PATTERN.match(line)
        if fence_match:
            marker = fence_match.group(1)
            if fence_char is None:
                fence_char = marker[0]
                fence_len = len(marker)
            elif marker[0] == fence_char and len(marker) >= fence_len:
                fence_char = None
                fence_len = 0
            operations.append(("text", line))
            continue

        if fence_char is not None:
            operations.append(("text", line))
            continue

        image_match = IMAGE_LINE_PATTERN.match(line)
        if image_match:
            operations.append(("image", image_match.group(1).strip(), image_match.group(2)))
            continue

        operations.append(("text", _promote_heading(line)))

    final_title = (title or derived_title).strip()
    if not final_title:
        raise MarkdownValidationError(
            "No title provided and the article has no leading '# heading'"
        )

    # Pass 2: collect block plain-texts for anchor uniqueness checks.
    block_texts = []
    for kind, *payload in operations:
        if kind != "text":
            continue
        plain = _block_text(payload[0])
        if plain:
            block_texts.append(plain)

    # Pass 3: build the image manifest using the preceding block as anchor.
    # block_cursor walks block_texts in lockstep (both passes see the same
    # text operations in the same order), so the anchor of an image is the
    # block at index block_cursor - 1.
    images = []
    last_block_text = ""
    last_block_index = -1
    block_cursor = 0
    for kind, *payload in operations:
        if kind == "image":
            alt, raw_path = payload
            path = _resolve_image_path(raw_path, base_dir)
            if path.startswith(("http://", "https://", "data:")):
                raise MarkdownValidationError(
                    f"Remote images are not supported by the Zhihu flow, "
                    f"download it first: {path}"
                )
            anchor_text, occurrence = _pick_anchor(
                last_block_text, last_block_index, block_texts
            )
            images.append(
                ZhihuImage(
                    index=len(images),
                    path=path,
                    alt=alt,
                    anchor_text=anchor_text,
                    occurrence=occurrence,
                )
            )
            continue
        plain = _block_text(payload[0])
        if plain:
            last_block_text = plain
            last_block_index = block_cursor
            block_cursor += 1

    body_lines = [payload[0] for kind, *payload in operations if kind == "text"]
    body_md = "\n".join(body_lines).strip()
    if not body_md:
        raise MarkdownValidationError("Article body is empty after stripping images")

    h2_count, h3_count = _count_headings_outside_fences(body_lines)
    first_sentence = block_texts[0][:30] if block_texts else ""

    return ZhihuArticle(
        title=final_title,
        body_md=body_md,
        images=images,
        h2_count=h2_count,
        h3_count=h3_count,
        first_sentence=first_sentence,
    )
