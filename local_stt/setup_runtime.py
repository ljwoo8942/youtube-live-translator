from __future__ import annotations

import os
import platform
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VENV = ROOT / ".venv-stt"
CUDA_TORCH = "torch==2.15.0+cu132"
CUDA_INDEX = "https://download.pytorch.org/whl/cu132"


def use_cuda() -> bool:
    if platform.system() != "Windows":
        return False
    device = os.environ.get("YT_TRANSLATOR_STT_DEVICE")
    if device:
        return device == "cuda"
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10, check=False,
        )
        return result.returncode == 0 and bool(result.stdout.strip())
    except (OSError, subprocess.TimeoutExpired):
        return False


def main() -> int:
    if platform.system() == "Darwin" and platform.machine() != "arm64":
        print("Intel Mac is not supported. Use native Apple Silicon Python.", file=sys.stderr)
        return 1

    env = {**os.environ, "UV_CACHE_DIR": os.environ.get("UV_CACHE_DIR") or str(ROOT / ".cache" / "uv")}
    cuda = use_cuda()
    pip = ["uv", "pip", "install", "--python", str(VENV)]
    if cuda:
        # Pin the CUDA local version so an already installed CPU wheel cannot satisfy it.
        subprocess.run([*pip, CUDA_TORCH, "--index-url", CUDA_INDEX], cwd=ROOT, env=env, check=True)
    subprocess.run([*pip, "-r", str(ROOT / "local_stt" / "requirements.txt")], cwd=ROOT, env=env, check=True)

    if cuda:
        python = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        probe = (
            "import torch; "
            "assert torch.cuda.is_available(), 'CUDA-enabled PyTorch could not initialize the GPU'; "
            "x=torch.ones((16,16),device='cuda',dtype=torch.float16); "
            "assert (x@x).sum().item()==4096; torch.cuda.synchronize(); "
            "print(f'Qwen CUDA ready: {torch.__version__}, {torch.cuda.get_device_name(0)}')"
        )
        try:
            subprocess.run([str(python), "-c", probe], cwd=ROOT, env=env, check=True)
        except subprocess.CalledProcessError:
            print(
                "Qwen CUDA setup failed. A CUDA 13.2-compatible NVIDIA driver and a PyTorch-supported GPU "
                "(Turing / sm_75 or newer) are required. "
                "Update the driver, or set YT_TRANSLATOR_STT_DEVICE=cpu and rerun npm run stt:setup.",
                file=sys.stderr,
            )
            return 1
    print(f"Local STT environment prepared: {'Qwen CUDA / Whisper' if cuda else 'platform default / explicit CPU'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
