from __future__ import annotations

import unittest

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
        model = app._load_model(app.DEFAULT_MODEL)
        segments, info, _ = app._transcribe_audio(
            model, np.zeros(16000, dtype=np.float32), "ja", False, model_name=app.DEFAULT_MODEL,
        )
        self.assertEqual(info.language, "ja")
        self.assertEqual(info.duration, 1.0)
        self.assertIsInstance(segments, list)
        print(f"Qwen runtime passed: {app.DEFAULT_MODEL}, {result['device']}/{result['compute_type']}", flush=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
