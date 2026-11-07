#!/usr/bin/env python3
"""Toutiao article publisher.

Flow (verified against the mp.toutiao.com ProseMirror editor by the
super-publisher project):

1. Convert Markdown to HTML; inline images become ``TTIMGPH_<n>`` placeholders.
2. Open the persistent-profile Chrome on the graphic publish page, ensure login.
3. Fill the title textarea and paste the HTML into the ProseMirror editor via
   ``execCommand('insertHTML')``.
4. Replace each placeholder with the real image pasted from the OS clipboard.
5. Upload a cover when there are no inline images (Toutiao picks the first
   inline image otherwise), then either stop (manual mode) or run the two-step
   publish flow and wait for the platform success indicator (auto mode).

Exit codes: 0 ok, 1 runtime/browser failure, 2 invalid input / not authenticated.
"""

import argparse
import contextlib
import html as html_lib
import json
import os
import platform
import shutil
import subprocess
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
    PAGE_LOAD_TIMEOUT,
    PUBLISH_URL,
    STATE_FILE,
    TITLE_MAX_LENGTH,
    TITLE_MIN_LENGTH,
)
from auth_manager import AUTH_PROBE_INTERVAL_SECONDS, AuthManager, is_login_url
from md2html import convert_with_images

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
    cover_image_path: Optional[str]
    html: str
    images: list


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
    mode="manual",
    headless=False,
    no_cover=False,
    raw=False,
) -> PreparedArticle:
    if mode not in PUBLISH_MODES:
        raise InputValidationError(f"Unknown mode: {mode}")
    if headless and mode != "auto":
        raise InputValidationError("--headless is only valid with --mode auto")
    if content_file and content_text is not None:
        raise InputValidationError("Use either --content-file or --content-text, not both")
    if no_cover and cover_image_path:
        raise InputValidationError("Use either --no-cover or --cover, not both")

    has_article_input = any(
        value is not None for value in (title, content_file, content_text, cover_image_path)
    )
    if mode in {"auto", "validate"} or has_article_input:
        if title is None:
            raise InputValidationError("--title is required for article input")
        if content_file is None and content_text is None:
            raise InputValidationError("--content-file or --content-text is required")

    normalized_title = title.strip() if title is not None else None
    if normalized_title is not None and not TITLE_MIN_LENGTH <= len(normalized_title) <= TITLE_MAX_LENGTH:
        raise InputValidationError(
            f"Toutiao title must contain {TITLE_MIN_LENGTH}-{TITLE_MAX_LENGTH} characters"
        )

    content = None
    content_base_dir = Path.cwd()
    if content_file is not None:
        content_path = Path(content_file).expanduser().resolve()
        if not content_path.is_file():
            raise InputValidationError(f"Content file not found: {content_path}")
        if not os.access(content_path, os.R_OK):
            raise InputValidationError(f"Content file is not readable: {content_path}")
        content = content_path.read_text(encoding="utf-8")
        content_base_dir = content_path.parent
    elif content_text is not None:
        content = content_text

    if content is not None and not content.strip():
        raise InputValidationError("Article content must not be empty")

    normalized_cover = None
    if cover_image_path:
        normalized_cover = str(_validate_local_image(cover_image_path, "Cover image"))

    converted_html = ""
    images = []
    if content:
        if raw:
            converted_html = "<p>" + html_lib.escape(content).replace("\n", "<br>\n") + "</p>"
        else:
            converted = convert_with_images(content, base_dir=content_base_dir)
            converted_html = converted.html
            images = converted.images
            for image in images:
                image_path = image["path"]
                if image_path.startswith(("http://", "https://", "data:")):
                    raise InputValidationError(f"Inline image must be a local file: {image_path}")
                _validate_local_image(image_path, "Inline image")

    return PreparedArticle(
        title=normalized_title,
        content=content,
        cover_image_path=normalized_cover,
        html=converted_html,
        images=images,
    )


# ---------------------------------------------------------------------------
# OS clipboard helpers
# ---------------------------------------------------------------------------

def _run_command(command, args, input_data=None) -> bool:
    result = subprocess.run(
        [command, *args],
        input=input_data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.returncode == 0


def copy_image_to_clipboard(image_path) -> bool:
    system = platform.system()
    image_path = str(Path(image_path).resolve())

    if system == "Darwin":
        swift_source = """
import AppKit
import Foundation

let inputPath = CommandLine.arguments[1]
let pasteboard = NSPasteboard.general
pasteboard.clearContents()

guard let image = NSImage(contentsOfFile: inputPath) else {
  FileHandle.standardError.write("Failed to load image\\n".data(using: .utf8)!)
  exit(1)
}

if !pasteboard.writeObjects([image]) {
  FileHandle.standardError.write("Failed to write image to clipboard\\n".data(using: .utf8)!)
  exit(1)
}
"""
        with tempfile.TemporaryDirectory(prefix="toutiao-clipboard-") as temp_dir:
            swift_path = Path(temp_dir) / "clipboard.swift"
            swift_path.write_text(swift_source, encoding="utf-8")
            return _run_command("swift", [str(swift_path), image_path])

    if system == "Linux":
        mime = "image/png"
        ext = Path(image_path).suffix.lower()
        if ext in {".jpg", ".jpeg"}:
            mime = "image/jpeg"
        elif ext == ".gif":
            mime = "image/gif"
        elif ext == ".webp":
            mime = "image/webp"
        if shutil.which("wl-copy"):
            with open(image_path, "rb") as image_file:
                return _run_command("wl-copy", ["--type", mime], image_file.read())
        if shutil.which("xclip"):
            return _run_command("xclip", ["-selection", "clipboard", "-t", mime, "-i", image_path])
        print("  No clipboard tool found. Install wl-copy or xclip.")
        return False

    if system == "Windows":
        escaped = image_path.replace("'", "''")
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "Add-Type -AssemblyName System.Drawing;"
            f"$img = [System.Drawing.Image]::FromFile('{escaped}');"
            "[System.Windows.Forms.Clipboard]::SetImage($img);"
            "$img.Dispose()"
        )
        return _run_command("powershell.exe", ["-NoProfile", "-Sta", "-Command", ps])

    print(f"  Unsupported clipboard platform: {system}")
    return False


def paste_from_clipboard(page) -> bool:
    system = platform.system()
    if system == "Darwin":
        if _run_command(
            "osascript",
            [
                "-e",
                'tell application "Google Chrome" to activate',
                "-e",
                'tell application "System Events" to keystroke "v" using command down',
            ],
        ):
            return True
    elif system == "Linux":
        if shutil.which("xdotool") and _run_command("xdotool", ["key", "ctrl+v"]):
            return True
    elif system == "Windows":
        ps = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"
        if _run_command("powershell.exe", ["-NoProfile", "-Command", ps]):
            return True

    try:
        modifier = "Meta" if system == "Darwin" else "Control"
        page.keyboard.press(f"{modifier}+V")
        return True
    except Exception as exc:
        print(f"  Failed to send paste keystroke: {exc}")
        return False


# ---------------------------------------------------------------------------
# Editor interaction (ProseMirror)
# ---------------------------------------------------------------------------

def select_placeholder(page, placeholder: str, retries: int = 3) -> bool:
    for attempt in range(1, retries + 1):
        selected = page.evaluate(
            """(placeholder) => {
                const editor = document.querySelector('.ProseMirror');
                if (!editor) return false;

                const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
                let node;
                while ((node = walker.nextNode())) {
                    const text = node.textContent || '';
                    let searchStart = 0;
                    let idx;
                    while ((idx = text.indexOf(placeholder, searchStart)) !== -1) {
                        const afterIdx = idx + placeholder.length;
                        const charAfter = text[afterIdx];
                        if (charAfter === undefined || !/\\d/.test(charAfter)) {
                            node.parentElement?.scrollIntoView({ block: 'center' });
                            const range = document.createRange();
                            range.setStart(node, idx);
                            range.setEnd(node, afterIdx);
                            const selection = window.getSelection();
                            selection.removeAllRanges();
                            selection.addRange(range);
                            editor.focus();
                            return true;
                        }
                        searchStart = afterIdx;
                    }
                }
                return false;
            }""",
            placeholder,
        )
        if selected:
            selected_text = page.evaluate("window.getSelection()?.toString() || ''")
            if selected_text.strip() == placeholder:
                return True
        if attempt < retries:
            time.sleep(0.5)
    return False


def insert_content_images(page, images) -> bool:
    if not images:
        return True

    print(f"Inserting {len(images)} inline image(s)...")
    success = True

    for index, image in enumerate(images, start=1):
        placeholder = image["placeholder"]
        image_path = image["path"]
        print(f"  [{index}/{len(images)}] Replacing {placeholder}...")

        if not os.path.exists(image_path):
            print(f"  Image file not found: {image_path}")
            success = False
            continue
        if not copy_image_to_clipboard(image_path):
            print("  Failed to copy image to clipboard.")
            success = False
            continue
        if not select_placeholder(page, placeholder):
            print(f"  Could not select placeholder: {placeholder}")
            success = False
            continue

        before_count = page.locator(".ProseMirror img").count()
        page.keyboard.press("Backspace")
        time.sleep(0.3)

        if not paste_from_clipboard(page):
            print("  Failed to paste image.")
            success = False
            continue

        inserted = False
        deadline = time.time() + 20
        while time.time() < deadline:
            if page.locator(".ProseMirror img").count() > before_count:
                inserted = True
                break
            time.sleep(1)

        print("  Image inserted." if inserted else "  Image insertion was not detected.")
        success = success and inserted

    remaining = page.evaluate(
        """() => {
            const text = document.querySelector('.ProseMirror')?.innerText || '';
            return Array.from(text.matchAll(/TTIMGPH_\\d+/g)).map((match) => match[0]);
        }"""
    )
    if remaining:
        print(f"  Remaining image placeholders: {', '.join(remaining)}")
        success = False
    return success


def click_button_by_text(page, texts, description: str, timeout_ms: int = 5000) -> bool:
    return StealthUtils.click_button_by_text(page, texts, description, timeout_ms)


def should_upload_cover(cover_image_path=None, content_images=None) -> bool:
    return bool(cover_image_path) and not bool(content_images)


def detect_publish_success(page, timeout_seconds: int = 20, poll_interval: float = 0.5):
    success_selectors = (
        ".byte-message-success",
        ".byte-notification-success",
        "[role='alert']",
    )
    deadline = time.time() + timeout_seconds
    while True:
        for selector in success_selectors:
            try:
                messages = page.locator(selector)
                for index in range(messages.count()):
                    message = messages.nth(index)
                    if not message.is_visible():
                        continue
                    text = (message.inner_text() or "").strip()
                    if "发布成功" in text or "主页查看" in text:
                        return text
            except Exception:
                continue
        if time.time() >= deadline:
            return None
        time.sleep(poll_interval)


def make_screenshot_taker(page, enabled: bool, debug_dir=None):
    if not enabled:
        return lambda name: None
    target_dir = Path(debug_dir or "output/toutiao-publisher-debug") / str(int(time.time()))

    def take_screenshot(name):
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
            filename = target_dir / f"{int(time.time())}_{name}.png"
            page.screenshot(path=str(filename))
            print(f"  Screenshot saved: {filename}")
        except Exception as exc:
            print(f"  Screenshot failed: {exc}")

    return take_screenshot


def _dismiss_overlays(page):
    try:
        for selector in (".byte-drawer-mask", ".ai-assistant-drawer", ".byte-modal-mask"):
            if page.locator(selector).is_visible():
                print(f"  Dismissing overlay: {selector}")
                page.locator(selector).click(force=True, position={"x": 10, "y": 10})
                page.evaluate(f"document.querySelector('{selector}')?.remove()")
                time.sleep(1)
    except Exception as exc:
        print(f"  Overlay handling error: {exc}")


# ---------------------------------------------------------------------------
# Main publish flow
# ---------------------------------------------------------------------------

def publish(
    article: PreparedArticle,
    mode="manual",
    headless=False,
    no_cover=False,
    debug_screenshots=False,
    debug_dir=None,
    event_callback=None,
) -> PublishResult:
    from patchright.sync_api import sync_playwright

    auth_manager = AuthManager()
    print(f"Launching Toutiao publisher (mode={mode}, headless={headless})...")

    with sync_playwright() as p:
        context = BrowserFactory.launch_persistent_context(
            p,
            headless=headless,
            user_data_dir=str(auth_manager.browser_profile_dir),
            state_file=str(auth_manager.state_file),
            browser_args=BROWSER_ARGS,
        )
        page = context.pages[0] if context.pages else context.new_page()
        take_screenshot = make_screenshot_taker(page, debug_screenshots, debug_dir)

        try:
            print(f"Navigating to {PUBLISH_URL}...")
            try:
                page.goto(PUBLISH_URL, timeout=PAGE_LOAD_TIMEOUT)
                page.wait_for_load_state("domcontentloaded")
            except Exception as exc:
                print(f"Navigation warning (proceeding anyway): {exc}")

            if is_login_url(page.url):
                print("Redirected to login page.")
                if headless:
                    return PublishResult(
                        False, "login_required",
                        "Stored login is unavailable; run auth_manager.py setup",
                    )
                print("Waiting for user login (5 mins)... scan the QR code in Chrome.")
                deadline = time.time() + 300
                last_probe = time.time() - AUTH_PROBE_INTERVAL_SECONDS
                logged_in = False
                while time.time() < deadline:
                    try:
                        detected = auth_manager.detect_authenticated_url(context)
                        now = time.time()
                        if (
                            not detected
                            and now - last_probe >= AUTH_PROBE_INTERVAL_SECONDS
                        ):
                            detected = auth_manager.detect_authenticated_url(
                                context, include_network_probe=True
                            )
                            last_probe = now
                        if detected:
                            print(f"Login detected: {detected}")
                            auth_manager.save_auth_state(context)
                            logged_in = True
                            break
                    except Exception:
                        pass
                    time.sleep(1)

                if not logged_in:
                    return PublishResult(False, "login_timeout", "Login timed out")
                if PUBLISH_URL not in page.url:
                    page.goto(PUBLISH_URL, timeout=PAGE_LOAD_TIMEOUT)
                    page.wait_for_load_state("domcontentloaded")

            print("Publish page loaded.")
            time.sleep(3)
            _dismiss_overlays(page)

            # 1. Title
            if article.title:
                print(f"Filling title: {article.title[:20]}...")
                try:
                    title_input = page.locator("textarea").first
                    if title_input.count() > 0:
                        title_input.fill(article.title)
                    else:
                        title_by_placeholder = page.get_by_placeholder("标题", exact=False)
                        if title_by_placeholder.count() > 0:
                            title_by_placeholder.first.fill(article.title)
                        else:
                            return PublishResult(
                                False, "title_fill_failed", "Could not identify the title input"
                            )
                except Exception as exc:
                    return PublishResult(False, "title_fill_failed", str(exc))
                take_screenshot("after_title")

            # 2. Body
            if article.html:
                print("Filling article content with HTML paste...")
                try:
                    try:
                        page.wait_for_selector(".ProseMirror", timeout=5000)
                    except Exception:
                        print("  Timeout waiting for .ProseMirror")

                    editor = page.locator(".ProseMirror").first
                    if editor.count() == 0:
                        return PublishResult(
                            False, "content_fill_failed", "ProseMirror editor was not found"
                        )

                    editor.click()
                    editor.clear()
                    filled = page.evaluate(
                        """(data) => {
                            const editor = document.querySelector('.ProseMirror');
                            if (!editor) return false;
                            editor.focus();
                            const success = document.execCommand('insertHTML', false, data.html);
                            if (!success) {
                                const clipboardData = new DataTransfer();
                                clipboardData.setData('text/html', data.html);
                                const pasteEvent = new ClipboardEvent('paste', {
                                    bubbles: true,
                                    cancelable: true,
                                    clipboardData: clipboardData,
                                });
                                editor.dispatchEvent(pasteEvent);
                            }
                            return true;
                        }""",
                        {"html": article.html},
                    )
                    if not filled:
                        return PublishResult(
                            False, "content_fill_failed", "ProseMirror rejected the article content"
                        )

                    time.sleep(3)
                    print("Content pasted.")

                    print("  Checking save status...")
                    saved = False
                    for _ in range(10):
                        if page.get_by_text("保存失败").is_visible():
                            print("  Alert: 'Save Failed' detected!")
                            take_screenshot("save_failed")
                            save_btn = page.get_by_text("保存草稿")
                            if save_btn.is_visible():
                                save_btn.click()
                            else:
                                editor.type(" ")
                            time.sleep(3)
                        if page.get_by_text("草稿已保存").is_visible():
                            print("  Draft saved successfully.")
                            saved = True
                            break
                        time.sleep(1)
                    if not saved and mode == "auto":
                        return PublishResult(
                            False, "draft_not_saved", "Toutiao did not confirm the draft was saved"
                        )
                except Exception as exc:
                    return PublishResult(False, "content_fill_failed", str(exc))
                take_screenshot("after_content")

                if article.images:
                    try:
                        if not insert_content_images(page, article.images):
                            return PublishResult(
                                False,
                                "inline_image_failed",
                                "One or more inline images were not inserted",
                            )
                    except Exception as exc:
                        return PublishResult(False, "inline_image_failed", str(exc))
                    take_screenshot("after_inline_images")

            # 3. Cover
            if article.cover_image_path and article.images:
                print("Article has inline images; skipping explicit cover upload.")

            if should_upload_cover(article.cover_image_path, article.images):
                print(f"Uploading cover image: {article.cover_image_path}...")
                try:
                    add_cover = page.locator("div.article-cover-add").first
                    if add_cover.is_visible():
                        add_cover.click()
                    else:
                        page.locator("div, span").filter(has_text="添加封面").last.click()
                    time.sleep(1)

                    upload_tab = page.locator("div.btn-upload-handle.upload-handler").first
                    if upload_tab.is_visible():
                        StealthUtils.click_with_fallback(upload_tab, "Upload Local button")
                    else:
                        StealthUtils.click_with_fallback(
                            page.locator("div, span").filter(has_text="本地上传").last,
                            "本地上传 button",
                        )
                    time.sleep(1)

                    file_input = page.locator("input[type='file']").first
                    file_input.set_input_files(article.cover_image_path)

                    confirm_btn = page.locator("button[data-e2e='imageUploadConfirm-btn']")
                    try:
                        confirm_btn.wait_for(state="visible", timeout=30000)
                        time.sleep(2)
                        if not StealthUtils.click_with_fallback(confirm_btn, "upload confirm button"):
                            raise RuntimeError("upload confirm click failed")
                        print("  Cover image uploaded and confirmed.")
                    except Exception as exc:
                        print(f"  Confirm button issue: {exc}")
                        if not click_button_by_text(page, ["确定", "确认"], "fallback confirm button"):
                            raise
                    time.sleep(2)
                    take_screenshot("cover_uploaded")
                except Exception as exc:
                    return PublishResult(False, "cover_upload_failed", str(exc))
            elif no_cover:
                print("Selecting 'No Cover' mode...")
                try:
                    no_cover_loc = page.locator("div, span, label").filter(has_text="无封面").last
                    if no_cover_loc.is_visible():
                        no_cover_loc.click()
                    else:
                        page.locator("input[type='radio'][value='0']").click()
                    time.sleep(2)
                    take_screenshot("cover_mode_selected")
                except Exception as exc:
                    return PublishResult(False, "cover_mode_failed", str(exc))

            # 4. Final publish step
            if mode == "auto":
                print("Submitting article (final step)...")
                try:
                    take_screenshot("before_publish_click")
                    initial_btn = page.locator("button").filter(has_text="预览并发布").last
                    if not initial_btn.is_visible():
                        initial_btn = page.locator("button").filter(has_text="发布").last
                    if initial_btn.is_visible() and initial_btn.is_enabled():
                        initial_btn.click()
                        print("  Initial publish button clicked.")
                    else:
                        page.evaluate("document.querySelector('.publish-btn')?.click()")

                    print("  Waiting for interface response (10s)...")
                    time.sleep(10)

                    final_btn = page.locator(".publish-btn-last").first
                    if final_btn.is_visible():
                        final_btn.click()
                    else:
                        modal_confirm = (
                            page.locator(".byte-modal .byte-btn-primary")
                            .filter(has_text="确定")
                            .or_(
                                page.locator(".byte-modal .byte-btn-primary").filter(
                                    has_text="确认发布"
                                )
                            )
                            .last
                        )
                        if modal_confirm.is_visible():
                            modal_confirm.click()
                        else:
                            return PublishResult(
                                False,
                                "publish_failed",
                                "Could not find the final confirmation button",
                            )

                    success_text = detect_publish_success(page, timeout_seconds=20)
                    take_screenshot("final_result")
                    if success_text:
                        return PublishResult(
                            True, "published",
                            f"Confirmed by Toutiao success indicator: {success_text}",
                        )
                    return PublishResult(
                        False,
                        "publish_unconfirmed",
                        "Final button was clicked but no success indicator was found",
                    )
                except Exception as exc:
                    return PublishResult(False, "publish_failed", str(exc))
            else:
                print("Manual review mode: skipping the final publish click.")
                print("  Review the article in Chrome and click Publish manually.")
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
                return PublishResult(
                    True, "manual_review_finished", "User ended the manual review session"
                )
        except Exception as exc:
            import traceback

            traceback.print_exc()
            return PublishResult(False, "publish_failed", str(exc))
        finally:
            if not headless and mode == "auto":
                print("Browser stays open for inspection. Closing in 60s...")
                time.sleep(60)
            with contextlib.suppress(Exception):
                context.close()


def _result_payload(result: PublishResult, mode: str) -> dict:
    return {"ok": result.ok, "status": result.status, "message": result.message, "mode": mode}


def main(argv=None) -> int:
    cli_argv = list(sys.argv[1:] if argv is None else argv)
    parser_class = configure_json_argument_parser(cli_argv)
    parser = parser_class(description="Toutiao Article Publisher")
    parser.add_argument("--title", help="Article title (2-30 characters)")
    content_group = parser.add_mutually_exclusive_group()
    content_group.add_argument(
        "--content", "--content-file", dest="content_file",
        help="Path to a UTF-8 Markdown file",
    )
    content_group.add_argument("--content-text", help="Article body passed directly")
    parser.add_argument("--cover", help="Path to a cover image")
    parser.add_argument(
        "--mode", choices=PUBLISH_MODES,
        help="manual: fill and wait; auto: publish; validate: preflight only",
    )
    parser.add_argument("--headless", action="store_true", help="Run headless (auto mode only)")
    parser.add_argument("--no-cover", action="store_true", help="Select the 'No Cover' option")
    parser.add_argument("--raw", action="store_true", help="Paste content as raw text")
    parser.add_argument(
        "--debug-screenshots", action="store_true",
        help="Save step screenshots under output/toutiao-publisher-debug/",
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
            print(
                json.dumps(_result_payload(result, mode), ensure_ascii=False),
                file=json_stream,
                flush=True,
            )

    with output_context:
        try:
            article = prepare_article(
                title=args.title,
                content_file=args.content_file,
                content_text=args.content_text,
                cover_image_path=args.cover,
                mode=mode,
                headless=args.headless,
                no_cover=args.no_cover,
                raw=args.raw,
            )
        except (InputValidationError, UnicodeError, OSError) as exc:
            print(f"Input validation failed: {exc}")
            emit_result(PublishResult(False, "invalid_input", str(exc)))
            return EXIT_INVALID_INPUT

        if mode == "validate":
            message = f"Preflight passed with {len(article.images)} inline image(s)"
            print("Input preflight passed. Browser was not opened.")
            emit_result(PublishResult(True, "input_valid", message))
            return EXIT_OK

        try:
            result = publish(
                article=article,
                mode=mode,
                headless=args.headless,
                no_cover=args.no_cover,
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
