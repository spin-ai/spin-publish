#!/usr/bin/env python3
"""Universal runner: execute skill scripts with the skill-local virtualenv."""

import hashlib
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPTS_DIR.parent


def venv_python() -> Path:
    if os.name == "nt":
        return SKILL_DIR / ".venv" / "Scripts" / "python.exe"
    return SKILL_DIR / ".venv" / "bin" / "python"


def requirements_current() -> bool:
    requirements = SKILL_DIR / "requirements.txt"
    marker = SKILL_DIR / ".venv" / ".requirements.sha256"
    if not requirements.exists():
        return True
    try:
        return marker.read_text(encoding="utf-8").strip() == hashlib.sha256(
            requirements.read_bytes()
        ).hexdigest()
    except OSError:
        return False


def ensure_venv(json_mode: bool):
    python = venv_python()
    ready = python.is_file() and os.access(python, os.X_OK) and requirements_current()
    if ready:
        return python

    output = sys.stderr if json_mode else sys.stdout
    print("Preparing the skill virtual environment...", file=output)
    result = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "setup_environment.py")],
        stdout=None if json_mode else None,
        stderr=None,
    )
    if result.returncode != 0 or not python.is_file():
        print("Failed to set up the skill environment.", file=sys.stderr)
        raise SystemExit(1)
    return python


def normalize_returncode(returncode: int) -> int:
    return 128 + abs(returncode) if returncode < 0 else returncode


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python3 run.py <script_name> [args...]")
        print("\nAvailable scripts:")
        for path in sorted(SCRIPTS_DIR.glob("*.py")):
            if path.name not in {"run.py", "setup_environment.py"}:
                print(f"  {path.name}")
        return 1

    script_name = sys.argv[1].removeprefix("scripts/")
    if not script_name.endswith(".py"):
        script_name += ".py"
    script_path = SCRIPTS_DIR / script_name
    if not script_path.exists():
        print(f"Script not found: {script_path}", file=sys.stderr)
        return 1

    python = ensure_venv(json_mode="--json" in sys.argv[2:])

    try:
        process = subprocess.Popen(
            [str(python), str(script_path), *sys.argv[2:]],
            start_new_session=os.name != "nt",
        )
        return normalize_returncode(process.wait())
    except KeyboardInterrupt:
        print("\nInterrupt received; waiting for the skill process...")
        if os.name != "nt":
            process.send_signal(signal.SIGINT)
        try:
            return normalize_returncode(process.wait(timeout=30))
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait()
            return 130


if __name__ == "__main__":
    sys.exit(main())
