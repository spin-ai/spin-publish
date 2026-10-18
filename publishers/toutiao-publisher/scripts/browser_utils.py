"""Browser launch utilities for the publisher skills."""

import json
import random
import time
from pathlib import Path

from patchright.sync_api import BrowserContext, Page, Playwright


class BrowserFactory:
    """Launch persistent, low-fingerprint Chrome contexts."""

    @staticmethod
    def launch_persistent_context(
        playwright: Playwright,
        headless: bool,
        user_data_dir: str,
        state_file: str,
        browser_args=None,
    ) -> BrowserContext:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=user_data_dir,
            channel="chrome",
            headless=headless,
            no_viewport=True,
            ignore_default_args=["--enable-automation"],
            args=browser_args or [],
        )
        # Workaround for Playwright bug #36139: session cookies (expires=-1)
        # do not persist into user_data_dir automatically.
        BrowserFactory._inject_cookies(context, state_file=state_file)
        return context

    @staticmethod
    def _inject_cookies(context: BrowserContext, state_file):
        state_file = Path(state_file)
        if not state_file.exists():
            return
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
            cookies = state.get("cookies", [])
            if cookies:
                context.add_cookies(cookies)
        except (OSError, ValueError) as exc:
            print(f"  Could not load stored cookies: {exc}")


class StealthUtils:
    """Small human-like interaction helpers."""

    @staticmethod
    def random_delay(min_ms: int = 100, max_ms: int = 400):
        time.sleep(random.uniform(min_ms / 1000, max_ms / 1000))

    @staticmethod
    def click_with_fallback(locator, description: str, timeout_ms: int = 4000) -> bool:
        for attempt in (
            lambda: locator.click(timeout=timeout_ms),
            lambda: locator.click(force=True, timeout=timeout_ms),
            lambda: locator.evaluate("(el) => el.click()"),
        ):
            try:
                attempt()
                return True
            except Exception as exc:
                print(f"  Click fallback for {description}: {exc}")
        return False

    @staticmethod
    def click_button_by_text(
        page: Page, texts, description: str, timeout_ms: int = 5000
    ) -> bool:
        import time as _time

        deadline = _time.time() + timeout_ms / 1000
        while _time.time() < deadline:
            matched = page.evaluate(
                """(texts) => {
                    const nodes = Array.from(
                        document.querySelectorAll('button, [role="button"], .Button')
                    );
                    for (const node of nodes) {
                        const text = (node.textContent || '').trim();
                        if (texts.some((item) => text.includes(item))) {
                            node.scrollIntoView({ block: 'center' });
                            node.click();
                            return text || 'clicked';
                        }
                    }
                    return '';
                }""",
                list(texts),
            )
            if matched:
                print(f"  Clicked {description}: {matched}")
                return True
            _time.sleep(0.5)
        print(f"  Could not find {description}.")
        return False
