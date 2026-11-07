#!/usr/bin/env python3
"""Create the skill-local virtual environment and install pinned dependencies."""

import hashlib
import subprocess
import sys
import venv
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
VENV_DIR = SKILL_DIR / ".venv"
REQUIREMENTS_FILE = SKILL_DIR / "requirements.txt"
FINGERPRINT_FILE = VENV_DIR / ".requirements.sha256"


def venv_python() -> Path:
    if sys.platform == "win32":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def main() -> int:
    if not VENV_DIR.exists():
        print("Creating virtual environment...")
        venv.create(VENV_DIR, with_pip=True)

    python = venv_python()
    if not python.is_file():
        print(f"Virtual environment python is missing: {python}", file=sys.stderr)
        return 1

    if REQUIREMENTS_FILE.exists():
        print("Installing dependencies...")
        subprocess.run(
            [str(python), "-m", "pip", "install", "-q", "-r", str(REQUIREMENTS_FILE)],
            check=True,
        )
        FINGERPRINT_FILE.write_text(
            hashlib.sha256(REQUIREMENTS_FILE.read_bytes()).hexdigest(),
            encoding="utf-8",
        )

    print("Environment ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
