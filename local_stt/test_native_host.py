import io
import json
import os
import socket
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

from local_stt import native_host


class NativeHostTests(unittest.TestCase):
    def test_disconnect_and_stop_release_the_server(self):
        model = "qwen3-asr-1.7b"
        for stop in (False, True):
            with self.subTest(stop=stop):
                source, output = io.BytesIO(), io.BytesIO()
                native_host.write_message(source, {"action": "start", "model": model})
                if stop:
                    native_host.write_message(source, {"action": "stop"})
                source.seek(0)
                events = []

                @contextmanager
                def run_server(selected):
                    events.append(("start", selected))
                    try:
                        yield {"model": selected, "device": "cuda", "computeType": "float16"}
                    finally:
                        events.append(("stop", selected))

                with patch.object(native_host, "run_server", run_server):
                    native_host.serve(source, output)

                output.seek(0)
                self.assertEqual(events, [("start", model), ("stop", model)])
                reply = native_host.read_message(output)
                self.assertTrue(reply["ok"])
                self.assertEqual(reply["model"], model)
                if stop:
                    self.assertEqual(native_host.read_message(output), {"ok": True, "state": "stopped"})
                self.assertIsNone(native_host.read_message(output))

    def test_malformed_or_unapproved_requests_never_start_any_process(self):
        source_cases = [io.BytesIO(native_host.FRAME_HEADER.pack(4097))]
        for request in (
            {"action": "stop"},
            {"action": "start", "model": "other/model"},
            {"action": "start", "model": "qwen3-asr-0.6b", "port": 8888},
            {"action": "start", "model": ["qwen3-asr-0.6b"]},
        ):
            source = io.BytesIO()
            native_host.write_message(source, request)
            source.seek(0)
            source_cases.append(source)

        with patch.object(native_host, "run_server") as run_server:
            for source in source_cases:
                output = io.BytesIO()
                native_host.serve(source, output)
                output.seek(0)
                self.assertFalse(native_host.read_message(output)["ok"])
            run_server.assert_not_called()

    def test_existing_listener_is_not_stopped(self):
        with socket.socket() as listener:
            listener.bind((native_host.HOST, 0))
            listener.listen()
            port = listener.getsockname()[1]
            with patch.object(native_host, "PORT", port):
                with self.assertRaisesRegex(RuntimeError, "포트를 열 수 없습니다"):
                    with native_host.run_server("qwen3-asr-0.6b"):
                        self.fail("A second server was started on the occupied port")
            with socket.create_connection((native_host.HOST, port), timeout=1):
                connection, _ = listener.accept()
                connection.close()

    def test_installer_rejects_non_extension_ids_before_writing(self):
        for invalid_id in ("*", "a" * 31, "z" * 32, "a" * 32 + "/"):
            with self.subTest(extension_id=invalid_id):
                with self.assertRaises(ValueError):
                    native_host.install_host(invalid_id)

    def test_registration_is_scoped_to_one_extension(self):
        for system, interpreter in (("Windows", "Scripts/python.exe"), ("Darwin", "bin/python")):
            with self.subTest(system=system), tempfile.TemporaryDirectory() as temp:
                root = Path(temp) / "프로젝트 폴더"
                python = root / ".venv-stt" / interpreter
                python.parent.mkdir(parents=True)
                python.touch()
                registry = MagicMock()
                extension_id = "b" * 32
                with (
                    patch.object(native_host, "ROOT", root),
                    patch.object(native_host.platform, "system", return_value=system),
                    patch.object(native_host.platform, "machine", return_value="arm64"),
                    patch.object(Path, "home", return_value=Path(temp)),
                    patch.dict("sys.modules", {"winreg": registry}),
                ):
                    manifest_path = native_host.install_host(extension_id)
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                self.assertEqual(manifest["allowed_origins"], [f"chrome-extension://{extension_id}/"])
                launcher = Path(manifest["path"])
                self.assertTrue(launcher.is_file())
                if system == "Windows":
                    self.assertIn(b'%~dp0', launcher.read_bytes())
                    self.assertEqual(registry.SetValueEx.call_args.args[-1], str(manifest_path))
                else:
                    self.assertEqual(launcher.suffix, ".sh")
                    self.assertIn("exec ", launcher.read_text(encoding="utf-8"))
                    if os.name != "nt":
                        self.assertTrue(launcher.stat().st_mode & 0o100)
                    registry.CreateKeyEx.assert_not_called()


if __name__ == "__main__":
    unittest.main()
