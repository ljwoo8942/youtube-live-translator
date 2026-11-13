from __future__ import annotations

import io
import json
import os
import time
import unittest
import wave
from unittest import mock

import numpy as np
from fastapi.testclient import TestClient

from local_stt import app
from local_stt.qwen_backend import MODEL_REPOSITORIES


class QwenRuntimeTests(unittest.TestCase):
    def test_model_load_and_real_inference(self) -> None:
        if app.DEFAULT_MODEL not in MODEL_REPOSITORIES:
            self.skipTest("Set YT_TRANSLATOR_STT_MODEL to qwen3-asr-0.6b or qwen3-asr-1.7b.")
        if app.DEFAULT_DEVICE == "mlx":
            import mlx.core as mx

            if not mx.metal.is_available():
                self.skipTest("Metal GPU is unavailable on this runner.")
        response = TestClient(app.app).get(
            "/health", headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"},
        )
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["loaded_model"], app.DEFAULT_MODEL)
        self.assertTrue(result["backend"].startswith("qwen3-asr-"))
        expected_device = os.environ.get("YT_TRANSLATOR_STT_EXPECT_DEVICE", app.DEFAULT_DEVICE)
        self.assertEqual(result["device"], expected_device, "The runtime must not pass a GPU check by falling back to CPU.")
        model = app._load_model(app.DEFAULT_MODEL)
        segments, info, _ = app._transcribe_audio(
            model, np.zeros(16000, dtype=np.float32), "ja", False, model_name=app.DEFAULT_MODEL,
        )
        self.assertEqual(info.language, "ja")
        self.assertEqual(info.duration, 1.0)
        self.assertIsInstance(segments, list)
        if expected_device == "cuda":
            self._assert_cuda_transports(model)
        print(f"Qwen runtime passed: {app.DEFAULT_MODEL}, {result['device']}/{result['compute_type']}", flush=True)

    def _assert_cuda_transports(self, model) -> None:
        import torch

        self.assertTrue(torch.cuda.is_available())
        self.assertEqual(model.compute_type, "float16")
        self.assertEqual(model._model.dtype, torch.float16)
        self.assertTrue(all(parameter.device.type == "cuda" for parameter in model._model.parameters()))
        generated_calls = 0
        generate = model._model.generate

        def generate_on_cuda(*args, **kwargs):
            nonlocal generated_calls
            tensors = [value for value in kwargs.values() if isinstance(value, torch.Tensor)]
            self.assertTrue(tensors, "The processor must produce real GPU input tensors.")
            self.assertTrue(all(value.device.type == "cuda" for value in tensors))
            output = generate(*args, **kwargs)
            self.assertEqual(output.device.type, "cuda")
            generated_calls += 1
            return output

        sample_rate = 16000
        timeline = np.arange(sample_rate * 2, dtype=np.float32) / sample_rate
        pcm = (np.sin(2 * np.pi * 220 * timeline) * 4000).astype("<i2")
        wav = io.BytesIO()
        with wave.open(wav, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(sample_rate)
            audio.writeframes(pcm.tobytes())
        headers = {"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"}
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
        with mock.patch.object(model._model, "generate", side_effect=generate_on_cuda), mock.patch.object(app, "DEFAULT_VAD", False):
            with TestClient(app.app) as client:
                started = time.perf_counter()
                response = client.post(
                    "/v1/audio/transcriptions", headers=headers,
                    files={"file": ("synthetic.wav", wav.getvalue(), "audio/wav")},
                    data={"model": app.DEFAULT_MODEL, "language": "ja"},
                )
                torch.cuda.synchronize()
                http_ms = round((time.perf_counter() - started) * 1000)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["model"], app.DEFAULT_MODEL)
                self.assertEqual(response.json()["language"], "ja")
                self.assertEqual(response.json()["duration"], 2.0)
                self.assertGreaterEqual(generated_calls, 1, "HTTP must run the model, not return early for silence.")
                previous_calls = generated_calls
                started = time.perf_counter()
                with client.websocket_connect(f"/v1/audio/stream?model={app.DEFAULT_MODEL}&language=ja", headers=headers) as socket:
                    socket.send_bytes(pcm.tobytes())
                    result = socket.receive_json()
                    self.assertIn(result["type"], {"partial", "final", "status"}, result)
                    torch.cuda.synchronize()
                    stream_ms = round((time.perf_counter() - started) * 1000)
                    self.assertGreater(generated_calls, previous_calls, "WebSocket must run real GPU inference.")
        print(json.dumps({
            "model": app.DEFAULT_MODEL, "device": "cuda", "compute_type": model.compute_type,
            "gpu": torch.cuda.get_device_name(), "torch": torch.__version__, "cuda": torch.version.cuda,
            "synthetic_audio_seconds": 2, "http_ms": http_ms, "stream_ms": stream_ms,
            "generation_calls": generated_calls,
            "peak_cuda_allocated_mib": round(torch.cuda.max_memory_allocated() / 1024**2, 1),
        }), flush=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
