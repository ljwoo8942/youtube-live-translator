from __future__ import annotations

import platform
import sys
import unittest

from local_stt import app


class MlxGpuRuntimeTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "darwin" and platform.machine() == "arm64", "Apple Silicon only")
    def test_health_executes_a_real_metal_model(self) -> None:
        import mlx.core as mx

        if not mx.metal.is_available():
            self.skipTest("Metal GPU is unavailable on this runner; verify on a physical Apple Silicon Mac.")
        self.assertEqual(app.DEFAULT_DEVICE, "mlx")
        result = app.health()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["backend"], "mlx-whisper")
        self.assertEqual(result["device"], "mlx")
        self.assertEqual(result["compute_type"], "float16")


if __name__ == "__main__":
    unittest.main(verbosity=2)
