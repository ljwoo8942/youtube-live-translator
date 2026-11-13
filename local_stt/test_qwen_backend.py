from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np
from fastapi.testclient import TestClient

from local_stt import app, qwen_backend as qwen


class QwenModelSelectionTests(unittest.TestCase):
    def test_cuda_runtime_check_rejects_a_successful_cpu_fallback(self) -> None:
        from local_stt.test_qwen_runtime import QwenRuntimeTests

        response = mock.Mock(status_code=200)
        response.json.return_value = {
            "ok": True, "loaded_model": "qwen3-asr-0.6b",
            "backend": "qwen3-asr-transformers", "device": "cpu", "compute_type": "float32",
        }
        case = QwenRuntimeTests("test_model_load_and_real_inference")
        with (
            mock.patch.object(app, "DEFAULT_MODEL", "qwen3-asr-0.6b"),
            mock.patch.object(app, "DEFAULT_DEVICE", "cuda"),
            mock.patch.dict("os.environ", {"YT_TRANSLATOR_STT_EXPECT_DEVICE": "cuda"}),
            mock.patch("local_stt.test_qwen_runtime.TestClient") as client,
            mock.patch.object(app, "_load_model") as load_model,
        ):
            client.return_value.get.return_value = response
            with self.assertRaisesRegex(AssertionError, "falling back to CPU"):
                case.test_model_load_and_real_inference()
        load_model.assert_not_called()

    def test_intel_mac_is_explicitly_excluded(self) -> None:
        with (
            mock.patch.object(qwen.sys, "platform", "darwin"),
            mock.patch.object(qwen.platform, "machine", return_value="x86_64"),
        ):
            with self.assertRaisesRegex(RuntimeError, "Intel Mac is not supported"):
                qwen.require_supported_platform()

    def test_aliases_resolve_only_the_two_supported_models(self) -> None:
        for name, repositories in qwen.MODEL_REPOSITORIES.items():
            for value in (name.upper(), *repositories.values()):
                self.assertEqual(qwen.canonical_model_name(value), name)
        self.assertEqual(qwen.canonical_model_name("other/Qwen3-ASR-0.6B"), "other/Qwen3-ASR-0.6B")

    def test_requests_cannot_download_unprepared_models(self) -> None:
        with mock.patch.object(app, "_cached_models", return_value=[]):
            for name in qwen.MODEL_REPOSITORIES:
                with self.assertRaisesRegex(ValueError, "stt:qwen:download"):
                    app._requested_model_name(name)
            with self.assertRaises(ValueError):
                app._requested_model_name("attacker/model")

    def test_cached_qwen_is_selectable_for_both_transports(self) -> None:
        with mock.patch.object(app, "_cached_models", return_value=list(qwen.MODEL_REPOSITORIES)):
            for name in qwen.MODEL_REPOSITORIES:
                self.assertEqual(app._requested_model_name(name), name)
                self.assertEqual(app._beam_size_for_mode("live", name), 1)
                self.assertIn(name, [model["id"] for model in app.models()["data"]])

    def test_cache_list_is_specific_to_the_selected_engine(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = qwen.model_repository("qwen3-asr-0.6b", "mlx")
            snapshot = Path(directory) / f"models--{repository.replace('/', '--')}" / "snapshots" / "revision"
            snapshot.mkdir(parents=True)
            with mock.patch("huggingface_hub.constants.HF_HUB_CACHE", directory):
                self.assertEqual(qwen.cached_models("mlx"), ["qwen3-asr-0.6b"])
                self.assertEqual(qwen.cached_models("cpu"), [])

    def test_health_does_not_replace_the_selected_model_with_whisper(self) -> None:
        model = SimpleNamespace(device="cpu", compute_type="float32")
        with (
            mock.patch.object(app, "_model", model),
            mock.patch.object(app, "_model_name", "qwen3-asr-1.7b"),
            mock.patch.object(app, "DEFAULT_DEVICE", "cpu"),
            mock.patch.object(app, "_load_model", return_value=model) as load_model,
            mock.patch.object(app, "_probe_runtime"),
            mock.patch.object(app, "_cached_models", return_value=[]),
        ):
            response = app.health()
        load_model.assert_called_once_with("qwen3-asr-1.7b")
        self.assertTrue(response["ok"])
        self.assertEqual(response["backend"], "qwen3-asr-transformers")
        self.assertEqual(response["compute_type"], "float32")


class QwenMlxTests(unittest.TestCase):
    def setUp(self) -> None:
        self.model = mock.Mock()
        self.model.generate.return_value = SimpleNamespace(text="青い風の中で", language=["Japanese"])
        self.loader = mock.Mock(return_value=self.model)
        self.mx = SimpleNamespace(
            gpu="gpu", metal=SimpleNamespace(is_available=mock.Mock(return_value=True)),
            stream=mock.Mock(side_effect=lambda device: nullcontext()), synchronize=mock.Mock(),
        )
        modules = mock.patch.dict(sys.modules, {
            "mlx": SimpleNamespace(core=self.mx), "mlx.core": self.mx,
            "mlx_audio.stt.utils": SimpleNamespace(load_model=self.loader),
        })
        modules.start()
        self.addCleanup(modules.stop)
        platform = mock.patch.object(qwen, "require_supported_platform")
        platform.start()
        self.addCleanup(platform.stop)
        self.backend = qwen.QwenAsrModel("qwen3-asr-0.6b", "mlx")

    def test_both_mlx_models_load_their_matching_repository(self) -> None:
        self.loader.assert_called_once_with("mlx-community/Qwen3-ASR-0.6B-8bit")
        qwen.QwenAsrModel("qwen3-asr-1.7b", "mlx")
        self.loader.assert_called_with("mlx-community/Qwen3-ASR-1.7B-8bit")

    def test_results_keep_the_window_contract_without_inventing_confidence(self) -> None:
        segments, info = self.backend.transcribe(np.zeros(32000, dtype=np.float32), language="ja")
        self.assertEqual(segments[0].text, "青い風の中で")
        self.assertEqual((segments[0].start, segments[0].end), (0.0, 2.0))
        self.assertFalse(hasattr(segments[0], "avg_logprob"))
        self.assertEqual(info.language, "ja")
        self.assertEqual(self.model.generate.call_args.kwargs["language"], "Japanese")
        self.mx.synchronize.assert_called_once()

    def test_vad_silence_skips_inference(self) -> None:
        with mock.patch("faster_whisper.vad.get_speech_timestamps", return_value=[]):
            segments, info = self.backend.transcribe(np.zeros(32000, dtype=np.float32), vad_filter=True)
        self.assertEqual(segments, [])
        self.assertEqual(info.duration, 2.0)
        self.model.generate.assert_not_called()

    def test_vad_trims_input_but_keeps_original_window_duration(self) -> None:
        with mock.patch("faster_whisper.vad.get_speech_timestamps", return_value=[{"start": 16000, "end": 24000}]):
            segments, info = self.backend.transcribe(np.zeros(32000, dtype=np.float32), vad_filter=True)
        self.assertEqual(self.model.generate.call_args.args[0].size, 8000)
        self.assertEqual(segments[0].end, info.duration)
        self.assertEqual(info.duration, 2.0)

    def test_missing_gpu_fails_instead_of_claiming_mlx_success(self) -> None:
        self.mx.metal.is_available.return_value = False
        with self.assertRaisesRegex(RuntimeError, "Metal GPU"):
            qwen.QwenAsrModel("qwen3-asr-0.6b", "mlx")

    def test_unsupported_language_fails_before_generation(self) -> None:
        with self.assertRaisesRegex(ValueError, "does not support language"):
            self.backend.transcribe(np.zeros(16000, dtype=np.float32), language="uk")
        self.model.generate.assert_not_called()

    def test_http_and_websocket_dispatch_to_qwen(self) -> None:
        with (
            mock.patch.object(app, "DEFAULT_VAD", False),
            mock.patch.object(app, "_cached_models", return_value=list(qwen.MODEL_REPOSITORIES)),
            mock.patch.object(app, "_model", None),
            mock.patch.object(app, "_model_name", None),
            mock.patch.object(app, "DEFAULT_DEVICE", "mlx"),
            mock.patch.object(app, "_decode_audio", return_value=np.full(32000, 0.1, dtype=np.float32)),
        ):
            client = TestClient(app.app)
            headers = {"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"}
            response = client.post(
                "/v1/audio/transcriptions", headers=headers,
                files={"file": ("audio.wav", b"audio", "audio/wav")},
                data={"model": "qwen3-asr-0.6b", "language": "ja"},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["text"], "青い風の中で")
            self.assertEqual(response.json()["beam_size_used"], 1)
            with client.websocket_connect("/v1/audio/stream?model=qwen3-asr-1.7b&language=ja", headers=headers) as socket:
                socket.send_bytes(np.full(32000, 6000, dtype="<i2").tobytes())
                result = socket.receive_json()
                self.assertEqual(result["type"], "partial")
                self.assertEqual(result["text"], "青い風の中で")
                self.assertEqual(result["model"], "qwen3-asr-1.7b")


@unittest.skipUnless(importlib.util.find_spec("torch"), "PyTorch is not installed")
class QwenTransformersTests(unittest.TestCase):
    def setUp(self) -> None:
        import torch

        self.torch = torch
        self.processor = mock.Mock()
        inputs = {"input_ids": torch.tensor([[1, 2]])}
        self.processor.apply_transcription_request.return_value = mock.Mock(
            to=mock.Mock(return_value=inputs),
        )
        self.processor.decode.return_value = {"language": "Japanese", "transcription": "青い風の中で"}
        self.model = mock.Mock(device=torch.device("cpu"), dtype=torch.float32)
        self.model.to.return_value = self.model
        self.model.eval.return_value = self.model
        self.model.generate.return_value = torch.tensor([[1, 2, 3, 4]])
        self.loader = mock.Mock(return_value=self.model)
        for patch in (
            mock.patch("transformers.AutoProcessor.from_pretrained", return_value=self.processor),
            mock.patch("transformers.AutoModelForMultimodalLM.from_pretrained", self.loader),
            mock.patch.object(qwen, "require_supported_platform"),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def test_cpu_uses_float32_and_decodes_only_generated_tokens(self) -> None:
        backend = qwen.QwenAsrModel("qwen3-asr-0.6b", "cpu")
        segments, info = backend.transcribe(np.zeros(32000, dtype=np.float32), language="ja")
        self.assertEqual(backend.compute_type, "float32")
        self.assertEqual(info.language, "ja")
        self.assertEqual(segments[0].text, "青い風の中で")
        decoded_tokens = self.processor.decode.call_args.args[0]
        self.assertTrue(self.torch.equal(decoded_tokens, self.torch.tensor([3, 4])))
        self.assertFalse(self.model.generate.call_args.kwargs["do_sample"])
        self.model.to.assert_called_once_with("cpu")
        self.assertEqual(self.loader.call_args.kwargs["dtype"], self.torch.float32)

    def test_cuda_uses_float16_and_moves_model_and_processor_inputs_to_gpu(self) -> None:
        self.model.device = self.torch.device("cuda")
        self.model.dtype = self.torch.float16
        for name in qwen.MODEL_REPOSITORIES:
            with self.subTest(model=name), mock.patch("torch.cuda.is_available", return_value=True):
                self.model.reset_mock()
                self.processor.reset_mock()
                backend = qwen.QwenAsrModel(name, "cuda")
                segments, info = backend.transcribe(np.zeros(16000, dtype=np.float32), language="ja")
                self.assertEqual((backend.device, backend.compute_type), ("cuda", "float16"))
                self.assertEqual(info.language, "ja")
                self.assertEqual(segments[0].text, "青い風の中で")
                self.model.to.assert_called_once_with("cuda")
                self.processor.apply_transcription_request.return_value.to.assert_called_once_with(self.model.device, self.torch.float16)
                self.assertEqual(self.loader.call_args.args[0], qwen.MODEL_REPOSITORIES[name]["transformers"])
                self.assertEqual(self.loader.call_args.kwargs["dtype"], self.torch.float16)
                self.assertFalse(self.loader.call_args.kwargs["trust_remote_code"])
                self.assertTrue(self.loader.call_args.kwargs["use_safetensors"])

    def test_explicit_cpu_is_preserved_when_cuda_is_available(self) -> None:
        with mock.patch("torch.cuda.is_available", return_value=True):
            backend = qwen.QwenAsrModel("qwen3-asr-1.7b", "cpu")
        self.assertEqual((backend.device, backend.compute_type), ("cpu", "float32"))
        self.model.to.assert_called_once_with("cpu")

    def test_unavailable_cuda_is_reported_as_cpu(self) -> None:
        with mock.patch("torch.cuda.is_available", return_value=False):
            with self.assertWarnsRegex(UserWarning, "using CPU"):
                backend = qwen.QwenAsrModel("qwen3-asr-1.7b", "cuda")
        self.assertEqual(backend.device, "cpu")
        self.assertEqual(backend.compute_type, "float32")


if __name__ == "__main__":
    unittest.main()
