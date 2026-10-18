"""Configuration for the Zhihu publisher skill."""

import os
from pathlib import Path

DATA_DIR_ENV_VAR = "PUBLISHER_DATA_DIR"


def resolve_data_dir(subdir: str) -> Path:
    home = Path.home()
    configured = os.getenv(DATA_DIR_ENV_VAR)
    if configured:
        base = Path(configured).expanduser()
        if not base.is_absolute():
            base = home / base
    else:
        base = home / ".smart-publisher"
        # 兼容 opencode-publisher 时期的登录态，避免用户重新扫码
        legacy = home / ".opencode-publisher"
        if not (base / subdir).exists() and (legacy / subdir).exists():
            return legacy / subdir
    return base / subdir


# Paths
DATA_DIR = resolve_data_dir("zhihu")
BROWSER_STATE_DIR = DATA_DIR / "browser_state"
BROWSER_PROFILE_DIR = BROWSER_STATE_DIR / "browser_profile"
STATE_FILE = BROWSER_STATE_DIR / "state.json"
AUTH_INFO_FILE = DATA_DIR / "auth_info.json"

# URLs
WRITE_URL = "https://zhuanlan.zhihu.com/write"
SIGNIN_URL = "https://www.zhihu.com/signin"
HOME_URL = "https://www.zhihu.com/"
AUTH_COOKIE_DOMAINS = ("zhihu.com", "zhuanlan.zhihu.com")

# Browser
BROWSER_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
]

# Timeouts
LOGIN_TIMEOUT_MINUTES = 10
PAGE_LOAD_TIMEOUT = 45000
EDITOR_SETTLE_SECONDS = 3.0
IMAGE_UPLOAD_TIMEOUT = 30

# Editor selectors (Draft.js)
TITLE_SELECTOR = 'textarea[placeholder*="标题"]'
EDITOR_SELECTOR = ".public-DraftEditor-content"
IMPORT_BUTTON_SELECTOR = 'button[aria-label="导入"]'
IMPORT_DOC_BUTTON_SELECTOR = 'button[aria-label="导入文档"]'
IMPORT_FILE_INPUT_SELECTOR = 'input[type=file][accept*=".md"]'
IMAGE_INPUT_SELECTOR = 'input[type=file][accept*="image/webp"]'
COVER_INPUT_SELECTOR = 'input[type=file][accept=".jpeg, .jpg, .png"]'
MODAL_BACKDROP_SELECTOR = ".Modal-backdrop"

TITLE_MAX_LENGTH = 100
