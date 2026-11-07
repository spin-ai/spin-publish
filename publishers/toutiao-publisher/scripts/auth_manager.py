"""Authentication manager for the Toutiao publisher.

Persisted login state lives under ~/.smart-publisher/toutiao/ with
owner-only permissions. The scripts never read or print cookie contents.
"""

import contextlib
import json
import shutil
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).parent))

from browser_utils import BrowserFactory
from cli_utils import configure_json_argument_parser
from config import (
    AUTH_COOKIE_DOMAINS,
    AUTH_PROBE_INTERVAL_SECONDS,
    BROWSER_ARGS,
    BROWSER_PROFILE_DIR,
    LOGIN_TIMEOUT_MINUTES,
    LOGIN_URL,
    PUBLISH_URL,
    STATE_FILE,
)

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_INVALID_STATE = 2


def ensure_private_directory(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
    return path


def ensure_private_file(path):
    path = Path(path)
    if path.exists():
        path.chmod(0o600)
    return path


def is_login_url(url: str) -> bool:
    normalized = (url or "").lower()
    return "auth/page/login" in normalized or "sso.toutiao.com" in normalized


def is_authenticated_url(url: str) -> bool:
    if not url or is_login_url(url):
        return False
    parsed = urlparse(url)
    return parsed.hostname == "mp.toutiao.com" and parsed.path.startswith("/profile_v4")


class AuthManager:
    def __init__(self):
        self.browser_profile_dir = BROWSER_PROFILE_DIR
        self.state_file = STATE_FILE
        self.last_status = "unknown"
        ensure_private_directory(self.browser_profile_dir)
        ensure_private_file(self.state_file)

    def is_authenticated(self) -> bool:
        if not self.state_file.exists():
            return False
        try:
            state = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        cookies = state.get("cookies", [])
        return any(
            cookie.get("value")
            and any(domain in cookie.get("domain", "").lower() for domain in AUTH_COOKIE_DOMAINS)
            for cookie in cookies
        )

    def get_auth_info(self) -> dict:
        info = {
            "authenticated": self.is_authenticated(),
            "state_file": str(self.state_file),
            "state_exists": self.state_file.exists(),
        }
        if self.state_file.exists():
            age_hours = (time.time() - self.state_file.stat().st_mtime) / 3600
            info["state_age_hours"] = round(age_hours, 1)
        return info

    def _launch_context(self, playwright, headless: bool):
        return BrowserFactory.launch_persistent_context(
            playwright,
            headless=headless,
            user_data_dir=str(self.browser_profile_dir),
            state_file=str(self.state_file),
            browser_args=BROWSER_ARGS,
        )

    def detect_authenticated_url(self, context, include_network_probe: bool = False):
        for page in context.pages:
            try:
                if is_authenticated_url(page.url):
                    return page.url
            except Exception:
                continue
        if include_network_probe:
            return self._probe_authenticated_session(context)
        return None

    def _probe_authenticated_session(self, context):
        try:
            response = context.request.get(
                PUBLISH_URL, timeout=10000, fail_on_status_code=False
            )
            return response.url if is_authenticated_url(response.url) else None
        except Exception:
            return None

    def save_auth_state(self, context):
        context.storage_state(path=str(self.state_file))
        ensure_private_file(self.state_file)

    def setup_auth(self, timeout_minutes: int = LOGIN_TIMEOUT_MINUTES) -> bool:
        """Interactive login: open Chrome, wait for the user to scan the QR code."""
        print("Starting Toutiao authentication setup...")
        print(f"  Timeout: {timeout_minutes} minutes")

        playwright = None
        context = None
        try:
            from patchright.sync_api import sync_playwright

            playwright = sync_playwright().start()
            context = self._launch_context(playwright, headless=False)

            page = context.new_page()
            page.goto(PUBLISH_URL, wait_until="domcontentloaded")

            detected = self.detect_authenticated_url(context)
            if detected:
                print("  Already authenticated!")
                self.save_auth_state(context)
                self.last_status = "authenticated"
                return True

            if not is_login_url(page.url):
                page.goto(LOGIN_URL, wait_until="domcontentloaded")

            print("\n  Please log in to your Toutiao account (scan QR code)...")
            deadline = time.time() + timeout_minutes * 60
            last_probe = time.time() - AUTH_PROBE_INTERVAL_SECONDS
            while time.time() < deadline:
                detected = self.detect_authenticated_url(context)
                now = time.time()
                if not detected and now - last_probe >= AUTH_PROBE_INTERVAL_SECONDS:
                    detected = self.detect_authenticated_url(
                        context, include_network_probe=True
                    )
                    last_probe = now
                if detected:
                    print(f"  Login detected: {detected}")
                    self.save_auth_state(context)
                    self.last_status = "authenticated"
                    return True
                time.sleep(1)

            print("  Timeout waiting for login.")
            self.last_status = "login_timeout"
            return False
        except Exception as exc:
            print(f"  Authentication error: {exc}")
            self.last_status = "authentication_failed"
            return False
        finally:
            if context:
                with contextlib.suppress(Exception):
                    context.close()
            if playwright:
                with contextlib.suppress(Exception):
                    playwright.stop()

    def validate_auth(self) -> bool:
        """Headless check that the stored session can open the creator console."""
        print("Validating Toutiao authentication...")
        playwright = None
        context = None
        try:
            from patchright.sync_api import sync_playwright

            playwright = sync_playwright().start()
            context = self._launch_context(playwright, headless=True)
            page = context.new_page()
            page.goto(PUBLISH_URL, wait_until="domcontentloaded", timeout=45000)
            if not is_authenticated_url(page.url):
                print("  Authentication is invalid (redirected to login)")
                self.last_status = "not_authenticated"
                return False
            self.save_auth_state(context)
            print("  Authentication is valid")
            self.last_status = "authenticated"
            return True
        except Exception as exc:
            print(f"  Validation failed: {exc}")
            self.last_status = "validation_failed"
            return False
        finally:
            if context:
                with contextlib.suppress(Exception):
                    context.close()
            if playwright:
                with contextlib.suppress(Exception):
                    playwright.stop()

    def clear_auth(self, confirmed: bool = False) -> bool:
        if not confirmed:
            print("Refusing to clear the shared profile without explicit confirmation.")
            print("   Re-run the command with --yes after the user confirms.")
            self.last_status = "confirmation_required"
            return False
        print("Clearing Toutiao authentication data...")
        try:
            if self.state_file.exists():
                self.state_file.unlink()
            state_dir = self.browser_profile_dir.parent
            if state_dir.exists():
                shutil.rmtree(state_dir)
            ensure_private_directory(state_dir)
            ensure_private_directory(self.browser_profile_dir)
            self.last_status = "cleared"
            return True
        except Exception as exc:
            print(f"  Error clearing auth: {exc}")
            self.last_status = "clear_failed"
            return False

    def re_auth(self, confirmed: bool = False, timeout_minutes: int = LOGIN_TIMEOUT_MINUTES) -> bool:
        if not confirmed:
            self.last_status = "confirmation_required"
            return False
        self.clear_auth(confirmed=True)
        return self.setup_auth(timeout_minutes=timeout_minutes)


def _exit_code_for_status(status: str) -> int:
    if status in {"not_authenticated", "login_timeout", "confirmation_required"}:
        return EXIT_INVALID_STATE
    return EXIT_FAILURE


def main(argv=None) -> int:
    cli_argv = list(sys.argv[1:] if argv is None else argv)
    parser_class = configure_json_argument_parser(cli_argv)
    parser = parser_class(description="Manage Toutiao authentication")
    subparsers = parser.add_subparsers(dest="command", parser_class=parser_class)

    setup_parser = subparsers.add_parser("setup", help="Interactive login via QR code")
    setup_parser.add_argument("--timeout", type=float, default=LOGIN_TIMEOUT_MINUTES)
    setup_parser.add_argument("--json", action="store_true")

    status_parser = subparsers.add_parser("status", help="Check stored session")
    status_parser.add_argument("--verify", action="store_true", help="Live check against Toutiao")
    status_parser.add_argument("--json", action="store_true")

    validate_parser = subparsers.add_parser("validate", help="Validate stored session")
    validate_parser.add_argument("--json", action="store_true")

    clear_parser = subparsers.add_parser("clear", help="Clear stored credentials")
    clear_parser.add_argument("--yes", action="store_true")
    clear_parser.add_argument("--json", action="store_true")

    reauth_parser = subparsers.add_parser("reauth", help="Clear + setup")
    reauth_parser.add_argument("--timeout", type=float, default=LOGIN_TIMEOUT_MINUTES)
    reauth_parser.add_argument("--yes", action="store_true")
    reauth_parser.add_argument("--json", action="store_true")

    args = parser.parse_args(cli_argv)
    if not args.command:
        parser.print_help()
        return EXIT_INVALID_STATE

    auth = AuthManager()
    json_output = bool(getattr(args, "json", False))
    json_stream = sys.stdout
    output_context = (
        contextlib.redirect_stdout(sys.stderr) if json_output else contextlib.nullcontext()
    )
    payload = {"ok": False, "command": args.command, "status": "failed"}
    exit_code = EXIT_FAILURE

    with output_context:
        if args.command == "setup":
            ok = auth.setup_auth(timeout_minutes=args.timeout)
            payload.update(ok=ok, status=auth.last_status)
            exit_code = EXIT_OK if ok else _exit_code_for_status(auth.last_status)
        elif args.command == "status":
            live_valid = auth.validate_auth() if args.verify else None
            info = auth.get_auth_info()
            valid = live_valid if args.verify else info["authenticated"]
            status = auth.last_status if args.verify else (
                "authenticated" if valid else "not_authenticated"
            )
            print("\nToutiao authentication status:")
            print(f"  Stored session: {'Yes' if info['authenticated'] else 'No'}")
            if info.get("state_age_hours") is not None:
                print(f"  State age: {info['state_age_hours']} hours")
            if args.verify:
                print(f"  Live check: {'Valid' if live_valid else 'Invalid or expired'}")
            payload.update(
                ok=bool(valid),
                status=status,
                stored_session=bool(info["authenticated"]),
                live_valid=live_valid,
            )
            exit_code = EXIT_OK if valid else _exit_code_for_status(status)
        elif args.command == "validate":
            ok = auth.validate_auth()
            if not ok:
                print("Run: auth_manager.py setup")
            payload.update(ok=ok, status=auth.last_status)
            exit_code = EXIT_OK if ok else _exit_code_for_status(auth.last_status)
        elif args.command == "clear":
            ok = auth.clear_auth(confirmed=args.yes)
            payload.update(ok=ok, status=auth.last_status)
            exit_code = EXIT_OK if ok else _exit_code_for_status(auth.last_status)
        elif args.command == "reauth":
            ok = auth.re_auth(confirmed=args.yes, timeout_minutes=args.timeout)
            payload.update(ok=ok, status=auth.last_status)
            exit_code = EXIT_OK if ok else _exit_code_for_status(auth.last_status)

    if json_output:
        print(json.dumps(payload, ensure_ascii=False), file=json_stream)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
