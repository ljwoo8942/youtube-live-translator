from __future__ import annotations

import json
import os
import platform
import re
import shlex
import socket
import struct
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO

ROOT = Path(__file__).resolve().parents[1]
HOST_NAME = "com.yt_live_translator.stt"
HOST = "127.0.0.1"
PORT = 8765
FRAME_HEADER = struct.Struct("=I")


def install_host(extension_id: str) -> Path:
    if not re.fullmatch(r"[a-p]{32}", extension_id):
        raise ValueError("Chrome 확장 관리 화면에 표시되는 32자 확장 ID를 입력하세요.")

    system = platform.system()
    if system != "Windows" and (system != "Darwin" or platform.machine() != "arm64"):
        raise ValueError("Windows와 Apple Silicon용 Python을 지원합니다.")

    host_dir = ROOT / ".cache" / "native-stt"
    python = ROOT / ".venv-stt" / ("Scripts/python.exe" if system == "Windows" else "bin/python")
    if not python.is_file():
        raise ValueError("먼저 npm run stt:setup을 실행하세요.")
    if system == "Windows" and any(char in str(host_dir) for char in "%!"):
        raise ValueError("Windows Native Messaging 실행 경로에 % 또는 !를 사용할 수 없습니다.")
    host_dir.mkdir(parents=True, exist_ok=True)
    if system == "Windows":
        launcher = host_dir / "launch.cmd"
        # Keep the batch file ASCII even when the project directory is not.
        launcher.write_bytes(
            b'@echo off\r\nsetlocal DisableDelayedExpansion\r\n'
            b'"%~dp0..\\..\\.venv-stt\\Scripts\\python.exe" -I -B -u "%~dp0..\\..\\local_stt\\native_host.py"\r\n'
        )
        manifest_path = host_dir / f"{HOST_NAME}.json"
    else:
        launcher = host_dir / "launch.sh"
        launcher.write_text(
            f"#!/bin/sh\nexec {shlex.quote(str(python))} -I -B -u {shlex.quote(str(Path(__file__).resolve()))}\n",
            encoding="utf-8",
        )
        launcher.chmod(0o700)
        manifest_path = (
            Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts" / f"{HOST_NAME}.json"
        )
        manifest_path.parent.mkdir(parents=True, exist_ok=True)

    manifest_path.write_text(
        json.dumps({
            "name": HOST_NAME,
            "description": "YouTube Live Translator local Qwen STT",
            "path": str(launcher),
            "type": "stdio",
            "allowed_origins": [f"chrome-extension://{extension_id}/"],
        }, indent=2) + "\n",
        encoding="utf-8",
    )
    if system == "Windows":
        import winreg

        with winreg.CreateKeyEx(
            winreg.HKEY_CURRENT_USER, rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}",
            access=winreg.KEY_SET_VALUE | winreg.KEY_WOW64_32KEY,
        ) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest_path))
    return manifest_path


def read_message(source: BinaryIO) -> dict | None:
    header = source.read(FRAME_HEADER.size)
    if not header:
        return None
    if len(header) != FRAME_HEADER.size:
        raise ValueError("메시지 헤더가 잘렸습니다.")
    (size,) = FRAME_HEADER.unpack(header)
    if not 0 < size <= 4096:
        raise ValueError("잘못된 메시지 크기입니다.")
    payload = source.read(size)
    if len(payload) != size:
        raise ValueError("메시지 본문이 잘렸습니다.")
    message = json.loads(payload.decode("utf-8"))
    if not isinstance(message, dict):
        raise ValueError("잘못된 메시지 형식입니다.")
    return message


def write_message(output: BinaryIO, message: dict) -> None:
    payload = json.dumps(message, ensure_ascii=False).encode("utf-8")
    output.write(FRAME_HEADER.pack(len(payload)) + payload)
    output.flush()


@contextmanager
def run_server(model: str):
    import uvicorn
    from local_stt.qwen_backend import cached_models, require_supported_platform

    require_supported_platform()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        if os.name == "nt":
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind((HOST, PORT))
            listener.listen()
        except OSError as exc:
            raise RuntimeError(f"{HOST}:{PORT} 포트를 열 수 없습니다. 이미 실행 중인 서버가 있는지 확인하세요.") from exc

        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["YT_TRANSLATOR_STT_MODEL"] = model
        from local_stt import app as stt

        if model not in cached_models(stt.DEFAULT_DEVICE):
            raise RuntimeError(f"{model}이 준비되지 않았습니다. npm run stt:qwen:download를 실행하세요.")
        health = stt.health()
        if not health["ok"] or health["loaded_model"] != model:
            raise RuntimeError(health.get("error") or f"{model} 모델을 불러오지 못했습니다.")

        server = uvicorn.Server(uvicorn.Config(
            stt.app, workers=1, access_log=False, proxy_headers=False, timeout_graceful_shutdown=2,
        ))
        runner = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        runner.start()
        try:
            deadline = time.monotonic() + 8
            while not server.started and runner.is_alive() and time.monotonic() < deadline:
                time.sleep(0.05)
            if not server.started:
                raise RuntimeError("Qwen STT 서버가 시작되지 않았습니다.")
            yield {"model": model, "device": health["device"], "computeType": health["compute_type"]}
        finally:
            server.should_exit = True
            runner.join(timeout=5)
            if runner.is_alive():
                raise RuntimeError("Qwen STT 서버가 정상 종료에 응답하지 않아 프로세스를 종료합니다.")


def serve(source: BinaryIO, output: BinaryIO) -> None:
    try:
        request = read_message(source)
        if request is None:
            return
        from local_stt.qwen_backend import MODEL_REPOSITORIES

        model = request.get("model")
        if (
            set(request) != {"action", "model"} or request["action"] != "start" or
            not isinstance(model, str) or model not in MODEL_REPOSITORIES
        ):
            raise ValueError("Qwen 0.6B 또는 1.7B 서버 시작만 지원합니다.")
        with run_server(model) as running:
            write_message(output, {"ok": True, "state": "running", **running})
            request = read_message(source)
            if request is None:
                return
            if request != {"action": "stop"}:
                raise ValueError("잘못된 서버 중지 메시지입니다.")
        write_message(output, {"ok": True, "state": "stopped"})
    except BrokenPipeError:
        return
    except Exception as exc:
        try:
            write_message(output, {"ok": False, "error": str(exc)})
        except BrokenPipeError:
            pass


def main() -> int:
    if sys.argv[1:2] == ["--install"]:
        if len(sys.argv) != 3:
            print("사용법: npm run stt:native:install -- <Chrome 확장 ID>", file=sys.stderr)
            return 1
        try:
            print(f"Chrome Native Messaging 호스트를 등록했습니다. {install_host(sys.argv[2])}")
            return 0
        except (OSError, ValueError) as exc:
            print(str(exc), file=sys.stderr)
            return 1

    sys.path.insert(0, str(ROOT))
    if os.name == "nt":
        import msvcrt

        msvcrt.setmode(0, os.O_BINARY)
        msvcrt.setmode(1, os.O_BINARY)
    # Preserve Chrome's protocol pipe and redirect any model or server stdout.
    with os.fdopen(os.dup(1), "wb") as output, open(os.devnull, "wb") as quiet:
        os.dup2(quiet.fileno(), 1)
        serve(sys.stdin.buffer, output)
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["--install"]:
        raise SystemExit(main())
    # An in-flight inference thread cannot keep the dedicated host alive after disconnect.
    os._exit(main())
