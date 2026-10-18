"""Configuration for the Toutiao publisher skill."""

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
DATA_DIR = resolve_data_dir("toutiao")
BROWSER_STATE_DIR = DATA_DIR / "browser_state"
BROWSER_PROFILE_DIR = BROWSER_STATE_DIR / "browser_profile"
STATE_FILE = BROWSER_STATE_DIR / "state.json"
AUTH_INFO_FILE = DATA_DIR / "auth_info.json"

# URLs
LOGIN_URL = "https://mp.toutiao.com/auth/page/login"
PUBLISH_URL = "https://mp.toutiao.com/profile_v4/graphic/publish"
HOME_URL = "https://mp.toutiao.com/"
AUTH_COOKIE_DOMAINS = ("toutiao.com", "bytedance.com", "snssdk.com")

# Browser
BROWSER_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
]

# Timeouts
LOGIN_TIMEOUT_MINUTES = 10
PAGE_LOAD_TIMEOUT = 60000
DEFAULT_TIMEOUT = 30000
AUTH_PROBE_INTERVAL_SECONDS = 3

TITLE_MIN_LENGTH = 2
TITLE_MAX_LENGTH = 30
