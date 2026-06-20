from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("YT_TRANSLATOR_STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("YT_TRANSLATOR_STT_PORT", "8765"))
START_TIMEOUT_SECONDS = int(os.environ.get("YT_TRANSLATOR_STT_START_TIMEOUT", "120"))
HEALTH_URL = f"http://{HOST}:{PORT}/health"
LOG_PATH = ROOT / "local_stt_server.log"
ERR_LOG_PATH = ROOT / "local_stt_server.err.log"


def _read_health() -> dict[str, object] | None:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=10) as response:
            body = response.read().decode("utf-8", errors="replace")
            return json.loads(body) if body else {}
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        return None


def _tail(path: Path, lines: int = 20) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    return "\n".join(text.splitlines()[-lines:])


def _creation_flags() -> int:
    if os.name != "nt":
        return 0
    return (
        subprocess.CREATE_NEW_PROCESS_GROUP
        | subprocess.DETACHED_PROCESS
        | getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0)
        | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    )


def main() -> int:
    existing_health = _read_health()
    if existing_health and existing_health.get("ok") is True:
        print(json.dumps({"status": "already-ready", "health": existing_health}, ensure_ascii=False))
        return 0

    command = [
        sys.executable,
        "-m",
        "uvicorn",
        "local_stt.app:app",
        "--host",
        HOST,
        "--port",
        str(PORT),
    ]

    with LOG_PATH.open("ab") as stdout, ERR_LOG_PATH.open("ab") as stderr:
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            creationflags=_creation_flags(),
            close_fds=True,
        )

    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    last_health: dict[str, object] | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            print(f"STT server exited early with code {process.returncode}", file=sys.stderr)
            break

        health = _read_health()
        if health:
            last_health = health
            if health.get("ok") is True:
                print(json.dumps({"status": "ready", "pid": process.pid, "health": health}, ensure_ascii=False))
                return 0

        time.sleep(1)

    if last_health:
        print(json.dumps({"status": "not-ready", "pid": process.pid, "health": last_health}, ensure_ascii=False), file=sys.stderr)
    else:
        print(f"STT server did not answer {HEALTH_URL}", file=sys.stderr)

    err_tail = _tail(ERR_LOG_PATH)
    if err_tail:
        print("\n--- stderr tail ---", file=sys.stderr)
        print(err_tail, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
