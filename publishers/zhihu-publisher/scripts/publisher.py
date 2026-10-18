#!/usr/bin/env python3
"""Zhihu article publisher.

Flow (verified against the Zhihu Draft.js editor by the agent-workflows project):

1. Preprocess Markdown: strip the leading H1 title, promote heading levels
   (Zhihu renders '#' as H2 and '##' as H3), strip image lines into a manifest.
2. Open the persistent-profile Chrome, ensure login.
3. Fill the title input.
4. Import the image-free Markdown through 导入 -> 导入文档 (the only way the
   editor parses structure; pasting leaves raw Markdown).
5. Verify the imported structure (H2/H3 counts, image count, first sentence).
6. Insert each image at its anchor via the editor's resident hidden file input.
7. Open the publish panel, re-upload the cover (re-import resets it), pick the
   column when requested, then either stop (manual mode) or publish (auto mode)
   after which the article URL confirms success.

Exit codes: 0 ok, 1 runtime/browser failure, 2 invalid input / not authenticated.
"""

import argparse
import contextlib
import json
import os
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent))

from browser_utils import BrowserFactory, StealthUtils
from cli_utils import configure_json_argument_parser
from config import (
    BROWSER_ARGS,
    BROWSER_PROFILE_DIR,
    COVER_INPUT_SELECTOR,
    EDITOR_SELECTOR,
    EDITOR_SETTLE_SECONDS,
    IMAGE_INPUT_SELECTOR,
    IMAGE_UPLOAD_TIMEOUT,
    IMPORT_BUTTON_SELECTOR,
    IMPORT_DOC_BUTTON_SELECTOR,
    IMPORT_FILE_INPUT_SELECTOR,
    MODAL_BACKDROP_SELECTOR,
    PAGE_LOAD_TIMEOUT,
    STATE_FILE,
    TITLE_MAX_LENGTH,
    TITLE_SELECTOR,
    WRITE_URL,
)
from zhihu_markdown import MarkdownValidationError, prepare_zhihu_article

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_INVALID_INPUT = 2
PUBLISH_MODES = ("manual", "auto", "validate")
LOCAL_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


class InputValidationError(ValueError):
    pass


@dataclass(frozen=True)
class PreparedArticle:
    title: str
    content: str
    import_file: Path
    cover_image_path: Optional[str]
    column: Optional[str]
    images: list
    h2_count: int
    h3_count: int
    first_sentence: str


@dataclass(frozen=True)
class PublishResult:
    ok: bool
    status: str
    message: str


def _validate_local_image(path, label: str) -> Path:
    image_path = Path(path).expanduser().resolve()
    if not image_path.is_file():
        raise InputValidationError(f"{label} not found: {image_path}")
    if image_path.suffix.lower() not in LOCAL_IMAGE_SUFFIXES:
        raise InputValidationError(f"{label} must be PNG/JPG/JPEG/GIF/WEBP: {image_path}")
    if not os.access(image_path, os.R_OK):
        raise InputValidationError(f"{label} is not readable: {image_path}")
    return image_path


def prepare_article(
    title=None,
    content_file=None,
    content_text=None,
    cover_image_path=None,
    column=None,
    mode="manual",
    headless=False,
) -> PreparedArticle:
    if mode not in PUBLISH_MODES:
        raise InputValidationError(f"Unknown mode: {mode}")
    if headless and mode != "auto":
        raise InputValidationError("--headless is only valid with --mode auto")
    if content_file and content_text is not None:
        raise InputValidationError("Use either --content-file or --content-text, not both")
    if not content_file and not content_text:
        raise InputValidationError("--content-file or --content-text is required")

    if content_file is not None:
        content_path = Path(content_file).expanduser().resolve()
        if not content_path.is_file():
            raise InputValidationError(f"Content file not found: {content_path}")
        content = content_path.read_text(encoding="utf-8")
        base_dir = content_path.parent
    else:
        content = content_text
        base_dir = None

    try:
        article = prepare_zhihu_article(content, base_dir=base_dir, title=title or "")
    except MarkdownValidationError as exc:
        raise InputValidationError(str(exc)) from exc

    normalized_title = article.title.strip()
    if not 2 <= len(normalized_title) <= TITLE_MAX_LENGTH:
        raise InputValidationError(
            f"Zhihu title must contain 2-{TITLE_MAX_LENGTH} characters, got {len(normalized_title)}"
        )

    for image in article.images:
        _validate_local_image(image.path, f"Inline image {image.index + 1}")

    normalized_cover = None
    if cover_image_path:
        normalized_cover = str(_validate_local_image(cover_image_path, "Cover image"))

    import_file = Path(tempfile.mkdtemp(prefix="zhihu-import-")) / "article.zhihu.md"
    import_file.write_text(article.body_md + "\n", encoding="utf-8")

    return PreparedArticle(
        title=normalized_title,
        content=article.body_md,
        import_file=import_file,
        cover_image_path=normalized_cover,
        column=(column or "").strip() or None,
        images=[image.to_dict() for image in article.images],
        h2_count=article.h2_count,
        h3_count=article.h3_count,
        first_sentence=article.first_sentence,
    )


# ---------------------------------------------------------------------------
# Page-level helpers (Draft.js specifics)
# ---------------------------------------------------------------------------

def _editor_stats(page) -> dict:
    return page.evaluate(
        """(selector) => {
            const editor = document.querySelector(selector);
            if (!editor) return null;
            return {
                h2: editor.querySelectorAll('h2').length,
                h3: editor.querySelectorAll('h3').length,
                img: editor.querySelectorAll('img').length,
                blockquote: editor.querySelectorAll('blockquote').length,
                textLength: (editor.textContent || '').trim().length,
            };
        }""",
        EDITOR_SELECTOR,
    )


def _wait_modal_gone(page, timeout=8):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if page.locator(MODAL_BACKDROP_SELECTOR).count() == 0:
                return True
        except Exception:
            pass
        page.keyboard.press("Escape")
        time.sleep(0.6)
    return page.locator(MODAL_BACKDROP_SELECTOR).count() == 0


def _empty_editor(page) -> bool:
    stats = _editor_stats(page)
    if not stats:
        return False
    if stats["textLength"] <= 1 and stats["img"] == 0:
        return True
    print("  Editor is not empty; selecting all and deleting...")
    editor = page.locator(EDITOR_SELECTOR).first
    editor.click()
    modifier = "Meta" if sys.platform == "darwin" else "Control"
    page.keyboard.press(f"{modifier}+A")
    time.sleep(0.3)
    page.keyboard.press("Backspace")
    time.sleep(0.8)
    stats = _editor_stats(page)
    return stats and stats["textLength"] <= 1 and stats["img"] == 0


def _import_markdown(page, import_file: Path) -> bool:
    page.locator(EDITOR_SELECTOR).first.click()
    time.sleep(0.3)

    import_input = page.locator(IMPORT_FILE_INPUT_SELECTOR)
    if import_input.count() == 0:
        print("  Opening toolbar import menu...")
        if not StealthUtils.click_with_fallback(
            page.locator(IMPORT_BUTTON_SELECTOR).first, "导入 button"
        ):
            return False
        time.sleep(0.8)
        if page.locator(IMPORT_DOC_BUTTON_SELECTOR).count() > 0:
            StealthUtils.click_with_fallback(
                page.locator(IMPORT_DOC_BUTTON_SELECTOR).first, "导入文档 menu item"
            )
            time.sleep(0.8)

    import_input = page.locator(IMPORT_FILE_INPUT_SELECTOR).first
    import_input.set_input_files(str(import_file))
    print("  Import file submitted, waiting for the editor to parse...")
    time.sleep(EDITOR_SETTLE_SECONDS + 2)
    return True


def _verify_import(page, article: PreparedArticle) -> bool:
    stats = _editor_stats(page)
    if not stats or stats["textLength"] < 10:
        print(f"  Import verification failed: editor stats {stats}")
        return False
    problems = []
    if stats["img"] != 0:
        problems.append(f"expected 0 images, found {stats['img']}")
    if stats["h2"] != article.h2_count:
        problems.append(f"expected {article.h2_count} H2, found {stats['h2']}")
    if stats["h3"] != article.h3_count:
        problems.append(f"expected {article.h3_count} H3, found {stats['h3']}")

    if article.first_sentence:
        occurrences = page.evaluate(
            """(args) => {
                const editor = document.querySelector(args.editor);
                if (!editor) return -1;
                const text = editor.innerText || editor.textContent || '';
                return text.split(args.sentence).length - 1;
            }""",
            {"editor": EDITOR_SELECTOR, "sentence": article.first_sentence},
        )
        if occurrences != 1:
            problems.append(f"first sentence appears {occurrences} times (expected 1)")

    if problems:
        print("  Import verification failed: " + "; ".join(problems))
        return False
    print(
        f"  Import verified: H2={stats['h2']} H3={stats['h3']} img={stats['img']} "
        f"chars={stats['textLength']}"
    )
    return True


def _place_caret_after_anchor(page, anchor_text: str, occurrence: int) -> bool:
    placed = page.evaluate(
        """(args) => {
            const editor = document.querySelector('.public-DraftEditor-content');
            if (!editor) return false;
            const blocks = editor.querySelectorAll('[data-block="true"]');
            let seen = 0;
            for (const block of blocks) {
                const text = block.textContent || '';
                if (text.includes(args.anchor)) {
                    if (seen === args.occurrence) {
                        block.scrollIntoView({ block: 'center' });
                        const range = document.createRange();
                        range.selectNodeContents(block);
                        range.collapse(false);
                        const selection = window.getSelection();
                        selection.removeAllRanges();
                        selection.addRange(range);
                        editor.focus();
                        return true;
                    }
                    seen += 1;
                }
            }
            return false;
        }""",
        {"anchor": anchor_text, "occurrence": occurrence},
    )
    return bool(placed)


def _insert_images(page, article: PreparedArticle) -> bool:
    if not article.images:
        return True

    print(f"Inserting {len(article.images)} inline image(s)...")
    for index, image in enumerate(article.images, start=1):
        print(f"  [{index}/{len(article.images)}] anchor='{image['anchor_text'][:20]}...'")
        if not _wait_modal_gone(page):
            print("  A modal backdrop is blocking the editor; aborting image insert.")
            return False

        if not _place_caret_after_anchor(page, image["anchor_text"], image["occurrence"]):
            print(f"  Could not locate anchor block for image {index}.")
            return False

        before = _editor_stats(page)["img"]
        page.keyboard.press("Enter")
        time.sleep(0.4)

        image_input = page.locator(IMAGE_INPUT_SELECTOR).first
        image_input.set_input_files(image["path"])

        inserted = False
        deadline = time.time() + IMAGE_UPLOAD_TIMEOUT
        while time.time() < deadline:
            if _editor_stats(page)["img"] > before:
                inserted = True
                break
            time.sleep(1)

        if not inserted:
            print(f"  Image {index} upload was not detected within {IMAGE_UPLOAD_TIMEOUT}s.")
            return False
        print(f"  Image {index} inserted.")
        time.sleep(1.0)

    remaining_failures = page.evaluate(
        """() => {
            const editor = document.querySelector('.public-DraftEditor-content');
            if (!editor) return 0;
            return Array.from(editor.querySelectorAll('[data-block]'))
                .filter((block) => (block.textContent || '').includes('上传失败')).length;
        }"""
    )
    if remaining_failures:
        print(f"  {remaining_failures} image block(s) failed to upload.")
        return False
    return True


def _wait_autosave(page, timeout=60) -> bool:
    print("  Waiting for the draft autosave indicator...")
    deadline = time.time() + timeout
    while time.time() < deadline:
        saved = page.evaluate(
            """() => {
                const text = document.body.innerText || '';
                return /已保存|刚刚\\s*·\\s*草稿|自动保存/.test(text);
            }"""
        )
        if saved:
            print("  Draft autosave detected.")
            return True
        time.sleep(2)
    print("  Autosave indicator not found; continuing anyway.")
    return False


def _open_publish_panel(page) -> bool:
    print("  Opening the publish settings panel...")
    if page.locator(MODAL_BACKDROP_SELECTOR).count() > 0:
        return True  # panel already open
    opened = StealthUtils.click_button_by_text(
        page, ["发布"], "publish (panel) button", timeout_ms=8000
    )
    if not opened:
        return False
    time.sleep(2)
    return page.locator(MODAL_BACKDROP_SELECTOR).count() > 0


def _upload_cover(page, cover_path: str) -> bool:
    print(f"  Uploading cover image: {cover_path}")
    cover_input = page.locator(COVER_INPUT_SELECTOR).first
    if cover_input.count() == 0:
        print("  Cover file input not found in the publish panel.")
        return False
    cover_input.set_input_files(cover_path)
    deadline = time.time() + 20
    while time.time() < deadline:
        ok = page.evaluate(
            """() => {
                const cover = document.querySelector('img[alt="封面图"], img[alt="cover"]');
                if (!cover) return false;
                const src = cover.getAttribute('src') || '';
                return src.length > 0 && !src.includes('data:image/gif');
            }"""
        )
        if ok:
            print("  Cover uploaded.")
            return True
        time.sleep(1)
    print("  Cover upload was not confirmed.")
    return False


def _select_column(page, column: str) -> bool:
    print(f"  Selecting column: {column}")
    selected = page.evaluate(
        """(column) => {
            const label = Array.from(document.querySelectorAll('label, [role="radio"], .Radio'))
                .find((node) => (node.textContent || '').includes('发布到专栏'));
            if (label) label.click();
            return Boolean(label);
        }""",
        column,
    )
    if not selected:
        print("  '发布到专栏' option not found.")
        return False
    time.sleep(0.8)

    picked = page.evaluate(
        """(column) => {
            const nodes = Array.from(document.querySelectorAll('div, span, li, option'));
            const target = nodes.find((node) => (node.textContent || '').trim() === column);
            if (!target) return false;
            target.scrollIntoView({ block: 'center' });
            target.click();
            return true;
        }""",
        column,
    )
    if not picked:
        print(f"  Column '{column}' could not be picked from the dropdown.")
        return False
    time.sleep(0.8)
    confirmed = page.evaluate(
        """(column) => (document.body.innerText || '').includes(column)""",
        column,
    )
    print(f"  Column selection confirmed: {confirmed}")
    return bool(confirmed)


def _publish_from_panel(page) -> bool:
    print("  Clicking the final publish button...")
    clicked = page.evaluate(
        """() => {
            const panels = Array.from(document.querySelectorAll('.Modal, [class*="PublishPanel"], [role="dialog"]'));
            const roots = panels.length ? panels : [document];
            for (const root of roots) {
                const buttons = Array.from(root.querySelectorAll('button, .Button'));
                for (const button of buttons) {
                    const text = (button.textContent || '').trim();
                    if (text === '发布' || text === '确认发布') {
                        button.scrollIntoView({ block: 'center' });
                        button.click();
                        return text;
                    }
                }
            }
            return '';
        }"""
    )
    if not clicked:
        print("  Final publish button not found.")
        return False
    print(f"  Clicked: {clicked}")

    deadline = time.time() + 45
    while time.time() < deadline:
        url = page.url
        if "/p/" in url and "zhuanlan.zhihu.com" in url:
            print(f"  Publish confirmed by article URL: {url}")
            return True
        time.sleep(1)
    print("  Publish was not confirmed by an article URL.")
    return False


# ---------------------------------------------------------------------------
# Main publish flow
# ---------------------------------------------------------------------------

def publish(
    article: PreparedArticle,
    mode="manual",
    headless=False,
    debug_screenshots=False,
    debug_dir=None,
    event_callback=None,
) -> PublishResult:
    from auth_manager import AuthManager, is_write_page_ready
    from patchright.sync_api import sync_playwright

    auth = AuthManager()
    print(f"Launching Zhihu publisher (mode={mode}, headless={headless})...")

    with sync_playwright() as p:
        context = BrowserFactory.launch_persistent_context(
            p,
            headless=headless,
            user_data_dir=str(BROWSER_PROFILE_DIR),
            state_file=str(STATE_FILE),
            browser_args=BROWSER_ARGS,
        )
        page = context.pages[0] if context.pages else context.new_page()
        screenshot = _make_screenshot_taker(page, debug_screenshots, debug_dir)

        try:
            page.goto(WRITE_URL, wait_until="domcontentloaded", timeout=PAGE_LOAD_TIMEOUT)
            time.sleep(EDITOR_SETTLE_SECONDS)

            if not is_write_page_ready(page):
                if headless:
                    return PublishResult(
                        False, "login_required",
                        "Stored login is unavailable; run auth_manager.py setup",
                    )
                print("Not logged in. Please scan the QR code in the Chrome window...")
                if not _wait_for_login(page, context, auth):
                    return PublishResult(False, "login_timeout", "Login timed out")
                page.goto(WRITE_URL, wait_until="domcontentloaded", timeout=PAGE_LOAD_TIMEOUT)
                time.sleep(EDITOR_SETTLE_SECONDS)
                if not is_write_page_ready(page):
                    return PublishResult(
                        False, "login_failed", "Editor page unavailable after login"
                    )

            print("Editor ready.")

            # 1. Title
            print(f"Filling title: {article.title[:24]}...")
            title_input = page.locator(TITLE_SELECTOR).first
            title_input.fill(article.title)
            time.sleep(0.8)
            screenshot("after_title")

            # 2. Empty editor, then import the body
            if not _empty_editor(page):
                return PublishResult(False, "editor_not_empty", "Could not empty the editor")
            if not _import_markdown(page, article.import_file):
                return PublishResult(
                    False, "import_failed", "Could not submit the import file"
                )
            if not _verify_import(page, article):
                return PublishResult(
                    False,
                    "import_verification_failed",
                    "Imported structure did not match the source Markdown",
                )
            screenshot("after_import")

            # 3. Inline images
            if article.images:
                try:
                    if not _insert_images(page, article):
                        return PublishResult(
                            False, "inline_image_failed", "One or more images were not inserted"
                        )
                except Exception as exc:
                    return PublishResult(False, "inline_image_failed", str(exc))
                screenshot("after_images")

            # 4. Autosave before touching the publish panel
            _wait_autosave(page)

            # 5. Publish panel: cover + column
            needs_panel = bool(article.cover_image_path or article.column or mode == "auto")
            if needs_panel:
                if not _open_publish_panel(page):
                    return PublishResult(
                        False, "panel_open_failed", "Could not open the publish settings panel"
                    )
                if article.cover_image_path:
                    if not _upload_cover(page, article.cover_image_path):
                        return PublishResult(False, "cover_upload_failed", "Cover upload failed")
                if article.column:
                    if not _select_column(page, article.column):
                        return PublishResult(
                            False, "column_select_failed", f"Column not selected: {article.column}"
                        )
                screenshot("after_panel")

            # 6. Final gate
            if mode == "auto":
                if not needs_panel:
                    if not _open_publish_panel(page):
                        return PublishResult(
                            False, "panel_open_failed", "Could not open the publish settings panel"
                        )
                if not _publish_from_panel(page):
                    return PublishResult(
                        False, "publish_unconfirmed", "No article URL confirmation after publish"
                    )
                screenshot("final_result")
                return PublishResult(True, "published", "Article URL confirmed")
            else:
                print("Manual review mode: everything is filled and saved as a draft.")
                print("  Review the article in Chrome and click 发布 yourself.")
                if event_callback:
                    event_callback(
                        PublishResult(
                            True, "awaiting_manual_review",
                            "Draft is ready for user review in Chrome",
                        )
                    )
                try:
                    while True:
                        time.sleep(5)
                except KeyboardInterrupt:
                    print("\nManual review finished.")
                return PublishResult(True, "manual_review_finished", "User finished review")

        except Exception as exc:
            import traceback

            traceback.print_exc()
            return PublishResult(False, "publish_failed", str(exc))
        finally:
            if not headless and mode == "auto":
                print("Browser stays open for 30s for inspection...")
                time.sleep(30)
            with contextlib.suppress(Exception):
                context.close()


def _wait_for_login(page, context, auth) -> bool:
    from auth_manager import is_write_page_ready

    print("  Waiting up to 5 minutes for login...")
    deadline = time.time() + 300
    probe = context.new_page()
    while time.time() < deadline:
        for candidate in context.pages:
            try:
                if is_write_page_ready(candidate):
                    auth.save_auth_state(context)
                    return True
            except Exception:
                continue
        try:
            probe.goto(WRITE_URL, wait_until="domcontentloaded", timeout=15000)
            time.sleep(1.5)
            if is_write_page_ready(probe):
                auth.save_auth_state(context)
                return True
        except Exception:
            pass
        time.sleep(2)
    return False


def _make_screenshot_taker(page, enabled: bool, debug_dir):
    if not enabled:
        return lambda name: None
    target_dir = Path(debug_dir or "output/zhihu-publisher-debug") / str(int(time.time()))

    def take_screenshot(name):
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
            filename = target_dir / f"{int(time.time())}_{name}.png"
            page.screenshot(path=str(filename))
            print(f"  Screenshot saved: {filename}")
        except Exception as exc:
            print(f"  Screenshot failed: {exc}")

    return take_screenshot


def _result_payload(result: PublishResult, mode: str) -> dict:
    return {"ok": result.ok, "status": result.status, "message": result.message, "mode": mode}


def main(argv=None) -> int:
    cli_argv = list(sys.argv[1:] if argv is None else argv)
    parser_class = configure_json_argument_parser(cli_argv)
    parser = parser_class(description="Zhihu Article Publisher")
    parser.add_argument("--title", help="Article title (falls back to the leading '# heading')")
    content_group = parser.add_mutually_exclusive_group()
    content_group.add_argument(
        "--content", "--content-file", dest="content_file",
        help="Path to a UTF-8 Markdown file",
    )
    content_group.add_argument("--content-text", help="Article body passed directly")
    parser.add_argument("--cover", help="Path to a cover image (PNG/JPG)")
    parser.add_argument("--column", help="Target Zhihu column name (专栏)")
    parser.add_argument(
        "--mode", choices=PUBLISH_MODES,
        help="manual: fill and wait; auto: publish; validate: preflight only",
    )
    parser.add_argument("--headless", action="store_true", help="Run headless (auto mode only)")
    parser.add_argument(
        "--debug-screenshots", action="store_true",
        help="Save step screenshots under output/zhihu-publisher-debug/",
    )
    parser.add_argument("--debug-dir", help="Directory for debug screenshots")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")

    args = parser.parse_args(cli_argv)
    mode = args.mode or "manual"
    json_stream = sys.stdout
    output_context = (
        contextlib.redirect_stdout(sys.stderr)
        if args.json
        else contextlib.nullcontext()
    )

    def emit_result(result: PublishResult):
        if args.json:
            print(json.dumps(_result_payload(result, mode), ensure_ascii=False), file=json_stream, flush=True)

    with output_context:
        try:
            article = prepare_article(
                title=args.title,
                content_file=args.content_file,
                content_text=args.content_text,
                cover_image_path=args.cover,
                column=args.column,
                mode=mode,
                headless=args.headless,
            )
        except (InputValidationError, UnicodeError, OSError) as exc:
            print(f"Input validation failed: {exc}")
            emit_result(PublishResult(False, "invalid_input", str(exc)))
            return EXIT_INVALID_INPUT

        if mode == "validate":
            message = (
                f"Preflight passed: title={article.title!r}, H2={article.h2_count}, "
                f"H3={article.h3_count}, images={len(article.images)}"
            )
            print(f"Input preflight passed. Browser was not opened.\n{message}")
            if args.json:
                print(
                    json.dumps(
                        {
                            "ok": True,
                            "status": "input_valid",
                            "message": message,
                            "mode": mode,
                            "article": {
                                "title": article.title,
                                "h2_count": article.h2_count,
                                "h3_count": article.h3_count,
                                "first_sentence": article.first_sentence,
                                "images": article.images,
                                "cover": article.cover_image_path,
                                "column": article.column,
                            },
                        },
                        ensure_ascii=False,
                    ),
                    file=json_stream,
                )
            return EXIT_OK

        try:
            result = publish(
                article=article,
                mode=mode,
                headless=args.headless,
                debug_screenshots=args.debug_screenshots,
                debug_dir=args.debug_dir,
                event_callback=emit_result,
            )
        except Exception as exc:
            result = PublishResult(False, "publish_failed", str(exc))
            print(f"Publisher failed: {exc}")

        emit_result(result)
        return EXIT_OK if result.ok else EXIT_FAILURE


if __name__ == "__main__":
    sys.exit(main())
