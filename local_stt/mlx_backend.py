from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np


MODEL_REPOSITORIES = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
}


def cached_models() -> list[str]:
    from huggingface_hub.constants import HF_HUB_CACHE

    models = []
    for name, repository in MODEL_REPOSITORIES.items():
        snapshots = Path(HF_HUB_CACHE) / f"models--{repository.replace('/', '--')}" / "snapshots"
        if snapshots.is_dir() and any(snapshots.iterdir()):
            models.append(name)
    return sorted(models)


class MlxWhisperModel:
    """Adapt MLX's dictionary results to the shared local STT pipeline."""

    def __init__(self, model: str, compute_type: str = "float16") -> None:
        import mlx.core as mx
        from mlx_whisper import transcribe

        if not mx.metal.is_available():
            raise RuntimeError("MLX Metal GPU is unavailable. Use native Apple Silicon Python or YT_TRANSLATOR_STT_DEVICE=cpu.")
        if compute_type not in {"float16", "float32"}:
            raise ValueError("MLX supports float16 or float32; int8 is for the faster-whisper CPU backend.")
        self.repository = MODEL_REPOSITORIES.get(model, model)
        self.fp16 = compute_type == "float16"
        self._mx = mx
        self._transcribe = transcribe

    def transcribe(
        self,
        audio: Any,
        *,
        language: str | None = None,
        vad_filter: bool = False,
        vad_parameters: dict[str, Any] | None = None,
        initial_prompt: str | None = None,
        temperature: float = 0.0,
        no_speech_threshold: float | None = 0.6,
        condition_on_previous_text: bool = False,
        beam_size: int = 1,
        multilingual: bool = False,
        language_detection_segments: int = 1,
    ) -> tuple[list[Any], SimpleNamespace]:
        from faster_whisper.audio import decode_audio
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        waveform = decode_audio(audio, sampling_rate=16000) if isinstance(audio, str) else np.asarray(audio, dtype=np.float32)
        duration = waveform.size / 16000
        if waveform.size == 0:
            return [], SimpleNamespace(language=language, duration=duration)

        clips: list[float] = [0.0, duration]
        if vad_filter:
            speech = get_speech_timestamps(waveform, VadOptions(**(vad_parameters or {})), sampling_rate=16000)
            if not speech:
                return [], SimpleNamespace(language=language, duration=duration)
            clips = [timestamp / 16000 for chunk in speech for timestamp in (chunk["start"], chunk["end"])]

        # ponytail: MLX supports greedy decoding and one language detection per rolling window.
        with self._mx.stream(self._mx.gpu):
            result = self._transcribe(
                waveform,
                path_or_hf_repo=self.repository,
                language=language,
                task="transcribe",
                fp16=self.fp16,
                verbose=None,
                temperature=temperature,
                no_speech_threshold=no_speech_threshold,
                initial_prompt=initial_prompt,
                condition_on_previous_text=condition_on_previous_text,
                clip_timestamps=clips,
            )
            self._mx.synchronize()
        segments = [SimpleNamespace(**segment) for segment in result["segments"]]
        return segments, SimpleNamespace(language=result["language"], duration=duration)
