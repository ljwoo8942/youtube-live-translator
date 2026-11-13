from __future__ import annotations

import platform
import sys
import warnings
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np


MODEL_REPOSITORIES = {
    "qwen3-asr-0.6b": {
        "mlx": "mlx-community/Qwen3-ASR-0.6B-8bit",
        "transformers": "Qwen/Qwen3-ASR-0.6B-hf",
    },
    "qwen3-asr-1.7b": {
        "mlx": "mlx-community/Qwen3-ASR-1.7B-8bit",
        "transformers": "Qwen/Qwen3-ASR-1.7B-hf",
    },
}

LANGUAGE_NAMES = {
    "ar": "Arabic", "yue": "Cantonese", "zh": "Chinese", "cs": "Czech", "da": "Danish",
    "nl": "Dutch", "en": "English", "fil": "Filipino", "fi": "Finnish", "fr": "French",
    "de": "German", "el": "Greek", "hi": "Hindi", "hu": "Hungarian", "id": "Indonesian",
    "it": "Italian", "ja": "Japanese", "ko": "Korean", "mk": "Macedonian", "ms": "Malay",
    "fa": "Persian", "pl": "Polish", "pt": "Portuguese", "ro": "Romanian", "ru": "Russian",
    "es": "Spanish", "sv": "Swedish", "th": "Thai", "tr": "Turkish", "vi": "Vietnamese",
}


def require_supported_platform() -> None:
    if sys.platform == "darwin" and platform.machine() != "arm64":
        raise RuntimeError("Intel Mac is not supported. Use Windows or a native Apple Silicon runtime for Qwen3-ASR.")


def canonical_model_name(model: str) -> str:
    for name, repositories in MODEL_REPOSITORIES.items():
        aliases = [name, *repositories.values(), repositories["transformers"].removesuffix("-hf")]
        if model.lower() in {alias.lower() for alias in aliases}:
            return name
    return model


def model_repository(model: str, device: str) -> str:
    return MODEL_REPOSITORIES[canonical_model_name(model)]["mlx" if device == "mlx" else "transformers"]


def cached_models(device: str) -> list[str]:
    from huggingface_hub.constants import HF_HUB_CACHE

    models = []
    for name in MODEL_REPOSITORIES:
        repository = model_repository(name, device)
        snapshots = Path(HF_HUB_CACHE) / f"models--{repository.replace('/', '--')}" / "snapshots"
        if snapshots.is_dir() and any(snapshots.iterdir()):
            models.append(name)
    return models


class QwenAsrModel:
    """Use Qwen with the same waveform/result contract as the Whisper backends."""

    def __init__(self, model: str, device: str) -> None:
        require_supported_platform()
        self.device = device
        repository = model_repository(model, device)
        if device == "mlx":
            import mlx.core as mx
            from mlx_audio.stt.utils import load_model

            if not mx.metal.is_available():
                raise RuntimeError("Qwen MLX requires an available Metal GPU. Use YT_TRANSLATOR_STT_DEVICE=cpu for CPU.")
            self._mx = mx
            self.backend = "qwen3-asr-mlx"
            self.compute_type = "8bit"
            with mx.stream(mx.gpu):
                self._model = load_model(repository)
        else:
            import torch
            from transformers import AutoModelForMultimodalLM, AutoProcessor

            if device == "cuda" and not torch.cuda.is_available():
                warnings.warn("Qwen CUDA is unavailable in this PyTorch build; using CPU. Install CUDA-enabled PyTorch for GPU inference.")
                self.device = "cpu"
            self._torch = torch
            self.backend = "qwen3-asr-transformers"
            self.compute_type = "float16" if self.device == "cuda" else "float32"
            dtype = torch.float16 if self.device == "cuda" else torch.float32
            self._processor = AutoProcessor.from_pretrained(repository, trust_remote_code=False)
            self._model = AutoModelForMultimodalLM.from_pretrained(
                repository, dtype=dtype, use_safetensors=True, trust_remote_code=False,
            ).to(self.device).eval()

    def transcribe(
        self,
        audio: Any,
        *,
        language: str | None = None,
        vad_filter: bool = False,
        vad_parameters: dict[str, Any] | None = None,
        initial_prompt: str | None = None,
        **_whisper_options: Any,
    ) -> tuple[list[Any], SimpleNamespace]:
        from faster_whisper.audio import decode_audio
        from faster_whisper.vad import VadOptions, collect_chunks, get_speech_timestamps

        waveform = decode_audio(audio, sampling_rate=16000) if isinstance(audio, str) else np.asarray(audio, dtype=np.float32)
        duration = waveform.size / 16000
        if vad_filter and waveform.size:
            speech = get_speech_timestamps(waveform, VadOptions(**(vad_parameters or {})), sampling_rate=16000)
            chunks, _ = collect_chunks(waveform, speech, sampling_rate=16000)
            waveform = chunks[0]
        if waveform.size == 0:
            return [], SimpleNamespace(language=language, duration=duration)

        language_name = LANGUAGE_NAMES.get(language, language)
        if language_name is not None and language_name not in LANGUAGE_NAMES.values():
            raise ValueError(f"Qwen3-ASR does not support language '{language}'.")
        max_tokens = max(64, min(2048, int(waveform.size / 16000 * 32)))
        if self.device == "mlx":
            with self._mx.stream(self._mx.gpu):
                result = self._model.generate(
                    waveform, language=language_name, system_prompt=initial_prompt,
                    max_tokens=max_tokens, temperature=0.0, verbose=False,
                )
                self._mx.synchronize()
            text = result.text.strip()
            detected = result.language[0] if isinstance(result.language, list) and result.language else result.language
        else:
            inputs = self._processor.apply_transcription_request(
                audio=waveform, language=language_name, prompt=initial_prompt,
            ).to(self._model.device, self._model.dtype)
            with self._torch.inference_mode():
                output = self._model.generate(**inputs, max_new_tokens=max_tokens, do_sample=False)
            generated = output[0, inputs["input_ids"].shape[-1]:]
            result = self._processor.decode(generated, return_format="parsed")
            text = result["transcription"].strip()
            detected = result["language"]
        detected = language_name or detected
        language_code = next((code for code, name in LANGUAGE_NAMES.items() if name == detected), language)
        # shortcut: Qwen exposes window text without Whisper scores or word timings; add forced alignment if needed.
        segments = [SimpleNamespace(start=0.0, end=duration, text=text)] if text else []
        return segments, SimpleNamespace(language=language_code, duration=duration)


if __name__ == "__main__":
    from huggingface_hub import snapshot_download
    from local_stt.app import DEFAULT_DEVICE

    require_supported_platform()
    for name in MODEL_REPOSITORIES:
        repository = model_repository(name, DEFAULT_DEVICE)
        print(f"Preparing {name}: {repository}", flush=True)
        snapshot_download(repo_id=repository)
