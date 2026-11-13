from __future__ import annotations

import os
import subprocess
import unittest
from types import SimpleNamespace
from unittest import mock

from local_stt import setup_runtime as setup


class SetupRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env = mock.patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_windows_nvidia_detection_and_explicit_device_override(self) -> None:
        with mock.patch.object(setup.platform, "system", return_value="Windows"), mock.patch.object(setup.subprocess, "run") as run:
            run.return_value = SimpleNamespace(returncode=0, stdout="NVIDIA GeForce RTX 5070\n")
            self.assertTrue(setup.use_cuda())
            run.assert_called_once()
            run.reset_mock()
            with mock.patch.dict(os.environ, {"YT_TRANSLATOR_STT_DEVICE": "cpu"}):
                self.assertFalse(setup.use_cuda())
            with mock.patch.dict(os.environ, {"YT_TRANSLATOR_STT_DEVICE": "cuda"}):
                self.assertTrue(setup.use_cuda())
            run.assert_not_called()

    def test_missing_or_empty_nvidia_runtime_uses_cpu_setup(self) -> None:
        with mock.patch.object(setup.platform, "system", return_value="Windows"), mock.patch.object(setup.subprocess, "run") as run:
            for result in (SimpleNamespace(returncode=1, stdout=""), SimpleNamespace(returncode=0, stdout="")):
                run.return_value = result
                self.assertFalse(setup.use_cuda())
            for error in (FileNotFoundError(), subprocess.TimeoutExpired("nvidia-smi", 10)):
                run.side_effect = error
                self.assertFalse(setup.use_cuda())

    def test_gpu_setup_installs_cuda_before_requirements_then_checks_real_kernels(self) -> None:
        with mock.patch.object(setup.platform, "system", return_value="Windows"), mock.patch.object(setup, "use_cuda", return_value=True), mock.patch.object(setup.subprocess, "run") as run:
            self.assertEqual(setup.main(), 0)
        self.assertEqual(len(run.call_args_list), 3)
        cuda, base, probe = run.call_args_list
        self.assertIn(setup.CUDA_TORCH, cuda.args[0])
        self.assertIn("+cu132", setup.CUDA_TORCH)
        self.assertEqual(cuda.args[0][-2:], ["--index-url", setup.CUDA_INDEX])
        self.assertEqual(base.args[0][-2:], ["-r", str(setup.ROOT / "local_stt" / "requirements.txt")])
        self.assertIn("device='cuda'", probe.args[0][-1])
        self.assertIn("x@x", probe.args[0][-1])
        self.assertIn("torch.cuda.synchronize()", probe.args[0][-1])
        for call in (cuda, base):
            self.assertEqual(call.args[0][3:5], ["--python", str(setup.VENV)])
            self.assertEqual(call.kwargs["cwd"], setup.ROOT)
            self.assertEqual(call.kwargs["env"]["UV_CACHE_DIR"], str(setup.ROOT / ".cache" / "uv"))
            self.assertTrue(call.kwargs["check"])

    def test_explicit_cpu_and_non_nvidia_ci_keep_base_dependencies_only(self) -> None:
        with mock.patch.object(setup.platform, "system", return_value="Windows"), mock.patch.dict(os.environ, {"YT_TRANSLATOR_STT_DEVICE": "cpu"}), mock.patch.object(setup.subprocess, "run") as run:
            self.assertEqual(setup.main(), 0)
        self.assertEqual(run.call_count, 1)
        self.assertNotIn(setup.CUDA_TORCH, run.call_args.args[0])

    def test_apple_silicon_keeps_mlx_setup_without_cuda_wheels(self) -> None:
        with mock.patch.object(setup.platform, "system", return_value="Darwin"), mock.patch.object(setup.platform, "machine", return_value="arm64"), mock.patch.object(setup.subprocess, "run") as run:
            self.assertEqual(setup.main(), 0)
        self.assertEqual(run.call_count, 1)
        self.assertNotIn(setup.CUDA_INDEX, run.call_args.args[0])

    def test_intel_mac_fails_before_installing_anything(self) -> None:
        with mock.patch.object(setup.platform, "system", return_value="Darwin"), mock.patch.object(setup.platform, "machine", return_value="x86_64"), mock.patch.object(setup.subprocess, "run") as run:
            self.assertEqual(setup.main(), 1)
        run.assert_not_called()

    def test_failed_gpu_probe_fails_setup_with_driver_and_cpu_recovery_hint(self) -> None:
        with mock.patch.object(setup.platform, "system", return_value="Windows"), mock.patch.object(setup, "use_cuda", return_value=True), mock.patch.object(setup.subprocess, "run", side_effect=[None, None, subprocess.CalledProcessError(1, "probe")]), mock.patch("builtins.print") as log:
            self.assertEqual(setup.main(), 1)
        self.assertTrue(any("CUDA 13.2-compatible NVIDIA driver" in str(call) for call in log.call_args_list))
        self.assertTrue(any("YT_TRANSLATOR_STT_DEVICE=cpu" in str(call) for call in log.call_args_list))

    def test_explicit_uv_cache_directory_is_preserved(self) -> None:
        with mock.patch.dict(os.environ, {"UV_CACHE_DIR": "custom-cache"}), mock.patch.object(setup.platform, "system", return_value="Windows"), mock.patch.object(setup, "use_cuda", return_value=False), mock.patch.object(setup.subprocess, "run") as run:
            self.assertEqual(setup.main(), 0)
        self.assertEqual(run.call_args.kwargs["env"]["UV_CACHE_DIR"], "custom-cache")


if __name__ == "__main__":
    unittest.main()
