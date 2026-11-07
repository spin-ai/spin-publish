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
   For an image that follows a fenced code block the anchor is the last
   non-empty code line, because fence markers never reach the Draft.js editor.
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
# Horizontal rules are not emittable Draft.js blocks after Zhihu import, so they
# must never be used as image anchors. An image that follows a rule should anchor
# to the previous text/code block instead.
HORIZONTAL_RULE_PATTERN = re.compile(r"^\s{0,3}([-*_])(?:\s*\1){2,}\s*$")

ANCHOR_SHORT = 20
ANCHOR_LONG = 45

# Zhihu injects zero-width characters around inline code/links and keeps the
# space after a blockquote marker, so anchor matching must ignore both.
ZERO_WIDTH_PATTERN = re.compile(r"[\u200b\u200c\u200d\ufeff]")
WHITESPACE_PATTERN = re.compile(r"\s+")


def normalize_match_text(text: str) -> str:
    """Normalize editor/source text for anchor comparisons."""
    text = ZERO_WIDTH_PATTERN.sub("", text or "")
    return WHITESPACE_PATTERN.sub(" ", text).strip()


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
    anchor_block = normalize_match_text(anchor_block)
    if not anchor_block:
        return "", 0

    blocks = [normalize_match_text(block) for block in all_blocks]
    for length in (ANCHOR_SHORT, ANCHOR_LONG, len(anchor_block)):
        candidate = anchor_block[:length]
        matches = [i for i, block in enumerate(blocks) if candidate in block]
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

    # Pass 2: collect anchor blocks in document order. Fenced code blocks are
    # collapsed into a single anchor (their last non-empty line), so an image
    # that follows a code fence is inserted after the whole code block rather
    # than before it or after a stray ``` marker. Fence markers themselves are
    # not emittable Draft.js blocks and must never be used as anchors.
    anchor_blocks = []
    image_sources = []  # (alt, raw_path, anchor_index_before_this_image)
    fence_char = None
    fence_len = 0
    code_lines = []
    for kind, *payload in operations:
        if kind == "image":
            image_sources.append((payload[0], payload[1], len(anchor_blocks) - 1))
            continue

        line = payload[0]
        fence_match = FENCE_PATTERN.match(line)
        if fence_match:
            marker = fence_match.group(1)
            if fence_char is None:
                fence_char = marker[0]
                fence_len = len(marker)
            elif marker[0] == fence_char and len(marker) >= fence_len:
                if code_lines:
                    anchor_blocks.append(code_lines[-1].strip())
                    code_lines = []
                fence_char = None
                fence_len = 0
            continue

        if fence_char is not None:
            if line.strip():
                code_lines.append(line)
            continue

        if HORIZONTAL_RULE_PATTERN.match(line):
            continue

        plain = _block_text(line)
        if plain:
            anchor_blocks.append(plain)

    if code_lines:
        anchor_blocks.append(code_lines[-1].strip())

    # Pass 3: build the image manifest from the anchors collected above.
    images = []
    for alt, raw_path, anchor_index in image_sources:
        path = _resolve_image_path(raw_path, base_dir)
        if path.startswith(("http://", "https://", "data:")):
            raise MarkdownValidationError(
                f"Remote images are not supported by the Zhihu flow, "
                f"download it first: {path}"
            )
        anchor_block = anchor_blocks[anchor_index] if anchor_index >= 0 else ""
        anchor_text, occurrence = _pick_anchor(
            anchor_block, anchor_index, anchor_blocks
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

    body_lines = [payload[0] for kind, *payload in operations if kind == "text"]
    body_md = "\n".join(body_lines).strip()
    if not body_md:
        raise MarkdownValidationError("Article body is empty after stripping images")

    h2_count, h3_count = _count_headings_outside_fences(body_lines)
    first_sentence = anchor_blocks[0][:30] if anchor_blocks else ""

    return ZhihuArticle(
        title=final_title,
        body_md=body_md,
        images=images,
        h2_count=h2_count,
        h3_count=h3_count,
        first_sentence=first_sentence,
    )
