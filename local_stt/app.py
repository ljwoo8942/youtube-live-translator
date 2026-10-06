from __future__ import annotations

import os
import platform
import re
import sys
import tempfile
import threading
import time
import wave
import asyncio
from collections import deque
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse


def _candidate_cuda_dll_dirs() -> list[Path]:
    if sys.platform != "win32":
        return []
    candidates: list[Path] = []

    explicit = os.environ.get("YT_TRANSLATOR_CUDA_DLL_DIR")
    if explicit:
        candidates.extend(Path(path) for path in explicit.split(os.pathsep) if path)

    candidates.extend(Path("C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA").glob("v*/bin"))
    candidates.extend((Path.home() / "AppData/Local/Programs/Python").glob("Python*/Lib/site-packages/torch/lib"))
    candidates.extend((Path.home() / "AppData/Local/uv/cache/archive-v0").glob("*/torch/lib"))
    candidates.extend((Path.home() / "AppData/Local/uv/cache/archive-v0").glob("*/ctranslate2"))
    return [path for path in candidates if path.exists()]


CUDA_DLL_DIRS = _candidate_cuda_dll_dirs()
for dll_dir in CUDA_DLL_DIRS:
    os.environ["PATH"] = f"{dll_dir}{os.pathsep}{os.environ.get('PATH', '')}"
    if hasattr(os, "add_dll_directory"):
        os.add_dll_directory(str(dll_dir))

APP_NAME = "YouTube Live Translator Local STT"


def _default_device() -> str:
    if sys.platform == "darwin":
        return "mlx" if platform.machine() == "arm64" else "cpu"
    from ctranslate2 import get_cuda_device_count

    return "cuda" if get_cuda_device_count() > 0 else "cpu"


DEFAULT_DEVICE = os.environ.get("YT_TRANSLATOR_STT_DEVICE") or _default_device()
DEFAULT_COMPUTE_TYPE = os.environ.get(
    "YT_TRANSLATOR_STT_COMPUTE_TYPE",
    "float16" if DEFAULT_DEVICE in {"cuda", "mlx"} else "int8",
)
DEFAULT_BEAM_SIZE = int(os.environ.get("YT_TRANSLATOR_STT_BEAM_SIZE", "1"))
DEFAULT_VAD = os.environ.get("YT_TRANSLATOR_STT_VAD", "1") not in {"0", "false", "False"}
LYRICS_BEAM_SIZE = int(os.environ.get("YT_TRANSLATOR_STT_LYRICS_BEAM_SIZE", "5"))
LIVE_BEAM_SIZE = int(os.environ.get("YT_TRANSLATOR_STT_LIVE_BEAM_SIZE", "3"))
BASE_MODEL_BEAM_SIZE = int(os.environ.get("YT_TRANSLATOR_STT_BASE_BEAM_SIZE", "5"))
SMALL_MODEL_BEAM_SIZE = int(os.environ.get("YT_TRANSLATOR_STT_SMALL_BEAM_SIZE", "5"))
DECODE_TEMPERATURE = float(os.environ.get("YT_TRANSLATOR_STT_TEMPERATURE", "0.0"))
STRICT_MODEL = os.environ.get("YT_TRANSLATOR_STT_STRICT_MODEL", "0") in {"1", "true", "True"}
MAX_UPLOAD_BYTES = max(1, int(os.environ.get("YT_TRANSLATOR_STT_MAX_UPLOAD_BYTES", str(16 * 1024 * 1024))))
MAX_STREAM_CHUNK_BYTES = max(1, int(os.environ.get("YT_TRANSLATOR_STT_MAX_STREAM_CHUNK_BYTES", str(256 * 1024))))
MAX_DECODED_AUDIO_SECONDS = max(1, int(os.environ.get("YT_TRANSLATOR_STT_MAX_AUDIO_SECONDS", "60")))
CHROME_EXTENSION_ORIGIN = re.compile(r"^chrome-extension://[a-p]{32}$")
EMPTY_RETRY_NO_VAD = os.environ.get("YT_TRANSLATOR_STT_EMPTY_RETRY_NO_VAD", "0") not in {"0", "false", "False"}
ALLOW_HEAVY_CACHED_FALLBACK = os.environ.get("YT_TRANSLATOR_STT_ALLOW_HEAVY_FALLBACK", "0") in {"1", "true", "True"}
LIVE_VAD_THRESHOLD = float(os.environ.get("YT_TRANSLATOR_STT_LIVE_VAD_THRESHOLD", "0.4"))
LIVE_VAD_MIN_SILENCE_MS = int(os.environ.get("YT_TRANSLATOR_STT_LIVE_VAD_MIN_SILENCE_MS", "500"))
LIVE_VAD_SPEECH_PAD_MS = int(os.environ.get("YT_TRANSLATOR_STT_LIVE_VAD_SPEECH_PAD_MS", "400"))
STREAM_SAMPLE_RATE = 16000
STREAM_WINDOW_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_STREAM_WINDOW_SECONDS", "6.0"))
STREAM_DECODE_INTERVAL_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_STREAM_DECODE_INTERVAL_SECONDS", "1.1"))
STREAM_MIN_AUDIO_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_STREAM_MIN_AUDIO_SECONDS", "1.6"))
STREAM_FINAL_INTERVAL_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_STREAM_FINAL_INTERVAL_SECONDS", "2.4"))
STREAM_OVERLAP_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_STREAM_OVERLAP_SECONDS", "0.75"))
LIVE_STREAM_WINDOW_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_LIVE_STREAM_WINDOW_SECONDS", "8.0"))
LIVE_STREAM_DECODE_INTERVAL_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_LIVE_STREAM_DECODE_INTERVAL_SECONDS", "1.3"))
LIVE_STREAM_MIN_AUDIO_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_LIVE_STREAM_MIN_AUDIO_SECONDS", "2.1"))
LIVE_STREAM_FINAL_INTERVAL_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_LIVE_STREAM_FINAL_INTERVAL_SECONDS", "2.7"))
LIVE_STREAM_OVERLAP_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_LIVE_STREAM_OVERLAP_SECONDS", "1.5"))
LYRICS_STREAM_WINDOW_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_LYRICS_STREAM_WINDOW_SECONDS", "14.0"))
LYRICS_STREAM_DECODE_INTERVAL_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_LYRICS_STREAM_DECODE_INTERVAL_SECONDS", "1.2"))
LYRICS_STREAM_MIN_AUDIO_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_LYRICS_STREAM_MIN_AUDIO_SECONDS", "2.4"))
LYRICS_STREAM_FINAL_INTERVAL_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_LYRICS_STREAM_FINAL_INTERVAL_SECONDS", "3.0"))
LYRICS_STREAM_OVERLAP_SECONDS = float(os.environ.get("YT_TRANSLATOR_STT_LYRICS_STREAM_OVERLAP_SECONDS", "3.0"))
DEFAULT_LYRICS_INITIAL_PROMPT = "日本語の歌詞。ボーカロイドの早口、英語フック、擬音、ラララ、ああ、wow、yeah、baby。"
LYRICS_INITIAL_PROMPT = os.environ.get("YT_TRANSLATOR_STT_LYRICS_INITIAL_PROMPT", "").strip() or DEFAULT_LYRICS_INITIAL_PROMPT
LIVE_INITIAL_PROMPT = os.environ.get("YT_TRANSLATOR_STT_LIVE_INITIAL_PROMPT", "").strip() or None
LYRICS_NO_SPEECH_THRESHOLD = float(os.environ.get("YT_TRANSLATOR_STT_LYRICS_NO_SPEECH_THRESHOLD", "0.92"))
LIVE_NO_SPEECH_THRESHOLD = float(os.environ.get("YT_TRANSLATOR_STT_LIVE_NO_SPEECH_THRESHOLD", "0.72"))
SEGMENT_NO_SPEECH_DROP_THRESHOLD = float(os.environ.get("YT_TRANSLATOR_STT_SEGMENT_NO_SPEECH_DROP_THRESHOLD", "0.88"))
SEGMENT_LOW_LOGPROB_DROP_THRESHOLD = float(os.environ.get("YT_TRANSLATOR_STT_SEGMENT_LOW_LOGPROB_DROP_THRESHOLD", "-1.25"))
SEGMENT_COMPRESSION_RATIO_DROP_THRESHOLD = float(os.environ.get("YT_TRANSLATOR_STT_SEGMENT_COMPRESSION_RATIO_DROP_THRESHOLD", "3.0"))
SILENCE_RMS_THRESHOLD = float(os.environ.get("YT_TRANSLATOR_STT_SILENCE_RMS_THRESHOLD", "0.0018"))
SILENCE_PEAK_THRESHOLD = float(os.environ.get("YT_TRANSLATOR_STT_SILENCE_PEAK_THRESHOLD", "0.012"))
PROBABLE_HALLUCINATION_KEYS = {
    "you",
    "youyou",
    "youyouyou",
    "youyouyouyou",
    "thankyou",
    "thanks",
    "thankyouverymuch",
    "pleasedonottrythisathome",
    "pleasedonotreuploadthisvideo",
    "thankyouforwatching",
    "thanksforwatching",
    "pleasesubscribe",
    "subscribe",
    "dontforgettosubscribe",
    "dontforgettolikeandsubscribe",
    "dontforgettolikecommentandsubscribe",
    "likeandsubscribe",
    "likecommentandsubscribe",
    "hitthesubscribebutton",
    "subscribetomychannel",
    "remembertosubscribe",
    "구독",
    "구독잊지마세요",
    "구독잊지마십시오",
    "구독부탁드립니다",
    "좋아요구독",
    "좋아요와구독",
    "좋아요와구독부탁드립니다",
    "시청감사합니다",
    "시청해주셔서감사합니다",
    "시청해줘서감사합니다",
    "시청해줘서고마워요",
    "끝까지봐주셔서감사합니다",
    "ご視聴ありがとうございました",
    "ご視聴ありがとうございます",
    "ご清聴ありがとうございました",
    "詳細は概要欄にリンクを貼っています",
    "チャンネル登録",
    "チャンネル登録お願いします",
    "高評価とチャンネル登録",
    "字幕by",
    "字幕提供",
    "字幕視聴",
    "字幕をご覧いただきありがとうございます",
    "中文字幕",
    "中文字幕中文字幕",
    "中文字幕中文字幕中文字幕",
    "字幕组",
    "字幕組",
    "字幕翻译",
    "字幕翻譯",
    "字幕制作",
    "字幕製作",
    "请不吝点赞订阅转发打赏支持明镜与点点栏目",
}
PROMPT_LEAK_KEY_PARTS = {
    "transcribesungvocals",
    "transcribethemasheard",
    "donotforcetheminto",
    "standardenglishspelling",
    "vocaloid",
    "ボーカロイド",
    "早口",
    "preserveeachheardphrase",
    "pronunciationadaptedenglish",
    "katakanaenglish",
    "waseieigo",
    "japanglish",
    "donottranslate",
    "ignoreinstruments",
    "livestreamspeech",
    "livestreamconversation",
    "clearlyaudiblespokenvoices",
    "ignoremusicgamesounds",
    "backgroundnoise",
    "englishandkoreanlyrics",
    "koreanandenglishlyrics",
    "englishkoreanlyrics",
    "koreanenglishlyrics",
    "lyricsinenglishandkorean",
    "lyricsinkoreanandenglish",
    "영어와한국어가사",
    "한국어와영어가사",
    "영어한국어가사",
    "한국어영어가사",
    "영어와한국어의가사",
    "한국어와영어의가사",
    "그대로듣고녹음",
    "그대로받아쓰",
    "표준영어",
    "표준영어철자",
    "표준영어스펠",
    "강제하지마",
    "강제로하지마",
    "번역하지마",
    "번역하지마세요",
    "들리는보컬",
    "각언어그대로",
    "カタカナ英語",
    "和製英語",
    "ジャパングリッシュ",
    "標準英語",
    "翻訳しない",
    "聞こえた歌声",
    "请按听到的原语言",
    "不要翻译",
    "日本語の歌詞",
    "日本語のライブ配信聞こえる会話",
}
CREDIT_HALLUCINATION_KEY_PARTS = {
    "transcribedby",
    "translatedby",
    "captionedby",
    "captioningby",
    "captionsby",
    "subtitledby",
    "subtitlesby",
    "subtitleby",
    "subtitlesprovidedby",
    "subtitlescreatedby",
    "subtitleseditedby",
    "createdby",
    "텍스트기록",
    "자막제작",
    "자막번역",
    "번역완료",
    "문자기록",
    "文字起こし",
    "字幕作成",
    "翻訳",
    "转录",
    "中文字幕",
    "字幕组",
    "字幕組",
    "字幕翻译",
    "字幕翻譯",
    "字幕制作",
    "字幕製作",
    "翻译",
}


def _cached_faster_whisper_models() -> list[str]:
    hub_dir = Path.home() / ".cache/huggingface/hub"
    models: list[str] = []

    for model_dir in hub_dir.glob("models--Systran--faster-whisper-*"):
        snapshots_dir = model_dir / "snapshots"
        if not snapshots_dir.exists() or not any(snapshots_dir.iterdir()):
            continue
        model_name = model_dir.name.removeprefix("models--Systran--faster-whisper-")
        if model_name:
            models.append(model_name)

    return sorted(set(models))


def _cached_models() -> list[str]:
    if DEFAULT_DEVICE == "mlx":
        from local_stt.mlx_backend import cached_models

        return cached_models()
    return _cached_faster_whisper_models()


def _default_model() -> str:
    explicit = os.environ.get("YT_TRANSLATOR_STT_MODEL")
    if explicit:
        return explicit

    return "small"


DEFAULT_MODEL = _default_model()


app = FastAPI(title=APP_NAME)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=CHROME_EXTENSION_ORIGIN.pattern,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def _allowed_browser_origin(origin: str | None) -> bool:
    return origin is not None and CHROME_EXTENSION_ORIGIN.fullmatch(origin) is not None


@app.middleware("http")
async def restrict_browser_origins(request: Request, call_next: Any) -> Any:
    if not _allowed_browser_origin(request.headers.get("origin")):
        return JSONResponse(status_code=403, content={"detail": "Browser origin is not allowed."})
    return await call_next(request)

_model_lock = threading.Lock()
# ponytail: one inference worker bounds CPU/GPU work; use a queue if parallel throughput is needed.
_inference_lock = threading.Lock()
_model: Any = None
_model_name: str | None = None
_model_error: str | None = None
_model_error_name: str | None = None
_runtime_checked_model: str | None = None
_runtime_error: str | None = None


def _server_config() -> dict[str, Any]:
    return {
        "model": DEFAULT_MODEL,
        "device": DEFAULT_DEVICE,
        "backend": "mlx-whisper" if DEFAULT_DEVICE == "mlx" else "faster-whisper",
        "compute_type": DEFAULT_COMPUTE_TYPE,
        "beam_size": 1 if DEFAULT_DEVICE == "mlx" else DEFAULT_BEAM_SIZE,
        "lyrics_beam_size": 1 if DEFAULT_DEVICE == "mlx" else LYRICS_BEAM_SIZE,
        "live_beam_size": 1 if DEFAULT_DEVICE == "mlx" else LIVE_BEAM_SIZE,
        "base_model_beam_size": 1 if DEFAULT_DEVICE == "mlx" else BASE_MODEL_BEAM_SIZE,
        "small_model_beam_size": 1 if DEFAULT_DEVICE == "mlx" else SMALL_MODEL_BEAM_SIZE,
        "temperature": DECODE_TEMPERATURE,
        "vad_filter": DEFAULT_VAD,
        "empty_retry_no_vad": EMPTY_RETRY_NO_VAD,
        "live_profile": {
            "vad_filter": DEFAULT_VAD,
            "lyrics_fallback_on_empty": True,
            "stream_window_seconds": LIVE_STREAM_WINDOW_SECONDS,
            "stream_min_audio_seconds": LIVE_STREAM_MIN_AUDIO_SECONDS,
            "stream_decode_interval_seconds": LIVE_STREAM_DECODE_INTERVAL_SECONDS,
            "stream_final_interval_seconds": LIVE_STREAM_FINAL_INTERVAL_SECONDS,
            "stream_overlap_seconds": LIVE_STREAM_OVERLAP_SECONDS,
            "no_speech_threshold": LIVE_NO_SPEECH_THRESHOLD,
            "vad_threshold": LIVE_VAD_THRESHOLD,
            "vad_min_silence_ms": LIVE_VAD_MIN_SILENCE_MS,
            "vad_speech_pad_ms": LIVE_VAD_SPEECH_PAD_MS,
        },
        "lyrics_profile": {
            "vad_filter": False,
            "stream_window_seconds": LYRICS_STREAM_WINDOW_SECONDS,
            "stream_min_audio_seconds": LYRICS_STREAM_MIN_AUDIO_SECONDS,
            "stream_decode_interval_seconds": LYRICS_STREAM_DECODE_INTERVAL_SECONDS,
            "stream_final_interval_seconds": LYRICS_STREAM_FINAL_INTERVAL_SECONDS,
            "stream_overlap_seconds": LYRICS_STREAM_OVERLAP_SECONDS,
            "no_speech_threshold": LYRICS_NO_SPEECH_THRESHOLD,
        },
        "strict_model": STRICT_MODEL,
        "allow_heavy_cached_fallback": ALLOW_HEAVY_CACHED_FALLBACK,
        "loaded_model": _model_name,
        "cached_models": _cached_models(),
        "cuda_dll_dirs": [str(path) for path in CUDA_DLL_DIRS],
    }


def _health_hint(error: str | None, model_name: str | None = None) -> str | None:
    if not error:
        return None

    target_model = model_name or DEFAULT_MODEL
    lowered = error.lower()
    if "cached snapshot" in lowered or "offline" in lowered or "cannot find" in lowered:
        cached_models = _cached_models()
        cached = ", ".join(cached_models) if cached_models else "없음"
        return (
            f"STT 모델 '{target_model}'이 로컬 캐시에 없습니다. 인터넷이 가능한 터미널에서 npm run stt:start를 한 번 실행해 "
            f"'{target_model}' 모델을 내려받거나, YT_TRANSLATOR_STT_MODEL로 로컬 모델 경로를 지정하세요. "
            f"현재 캐시된 모델: {cached}. 무거운 캐시 모델을 의도적으로 쓰려면 YT_TRANSLATOR_STT_ALLOW_HEAVY_FALLBACK=1을 설정하세요."
        )

    if "cuda" in lowered or "cudnn" in lowered or "cublas" in lowered:
        return "CUDA/cuDNN/CTranslate2 런타임을 확인하세요. GPU 런타임 DLL 경로가 PATH에 있어야 합니다."
    if DEFAULT_DEVICE == "mlx" and ("mlx" in lowered or "metal" in lowered):
        return "macOS 14 이상과 Apple Silicon용 Python이 필요합니다. npm run stt:setup으로 MLX를 설치하세요. CPU로 실행하려면 YT_TRANSLATOR_STT_DEVICE=cpu를 지정하세요."

    return None


def _requested_model_name(model: str | None = None) -> str:
    requested = (model or "").strip()
    if not requested or requested == "whisper-1":
        return DEFAULT_MODEL
    if requested != DEFAULT_MODEL and requested not in _cached_models():
        raise ValueError(f"STT model '{requested}' is not configured or cached locally.")
    return requested


def _is_lyrics_mode(content_mode: str | None) -> bool:
    return (content_mode or "").strip().lower() in {"lyrics", "song", "music"}


def _is_live_mode(content_mode: str | None) -> bool:
    return (content_mode or "").strip().lower() in {"live", "livestream", "stream", "noisy"}


def _profile_name(content_mode: str | None) -> str:
    if _is_lyrics_mode(content_mode):
        return "lyrics"
    if _is_live_mode(content_mode):
        return "live"
    return "spoken"


def _is_small_model(model_name: str | None) -> bool:
    normalized = (model_name or "").strip().lower().replace("\\", "/").rstrip("/")
    return normalized == "small" or normalized.endswith("/faster-whisper-small")


def _is_base_model(model_name: str | None) -> bool:
    normalized = (model_name or "").strip().lower().replace("\\", "/").rstrip("/")
    return normalized == "base" or normalized.endswith("/faster-whisper-base")


def _is_compact_model(model_name: str | None) -> bool:
    return _is_base_model(model_name) or _is_small_model(model_name)


def _beam_size_for_mode(content_mode: str | None, model_name: str | None = None) -> int:
    if DEFAULT_DEVICE == "mlx":
        return 1
    if _is_lyrics_mode(content_mode):
        beam_size = max(DEFAULT_BEAM_SIZE, LYRICS_BEAM_SIZE)
    elif _is_live_mode(content_mode):
        beam_size = max(DEFAULT_BEAM_SIZE, LIVE_BEAM_SIZE)
    else:
        beam_size = DEFAULT_BEAM_SIZE
    if _is_base_model(model_name):
        return max(beam_size, BASE_MODEL_BEAM_SIZE)
    if _is_small_model(model_name):
        return max(beam_size, SMALL_MODEL_BEAM_SIZE if _is_lyrics_mode(content_mode) or _is_live_mode(content_mode) else 3)
    return beam_size


def _stream_profile_for_model(content_mode: str | None, model_name: str | None) -> tuple[float, float, float, float, float]:
    if _is_lyrics_mode(content_mode):
        profile = (
            LYRICS_STREAM_WINDOW_SECONDS,
            LYRICS_STREAM_DECODE_INTERVAL_SECONDS,
            LYRICS_STREAM_MIN_AUDIO_SECONDS,
            LYRICS_STREAM_FINAL_INTERVAL_SECONDS,
            LYRICS_STREAM_OVERLAP_SECONDS,
        )
        if _is_base_model(model_name):
            return (12.0, profile[1], 2.8, 3.4, 2.6)
        if _is_small_model(model_name):
            return (max(profile[0], 15.0), profile[1], max(profile[2], 3.5), max(profile[3], 4.0), max(profile[4], 3.5))
        return profile
    if _is_live_mode(content_mode):
        profile = (
            LIVE_STREAM_WINDOW_SECONDS,
            LIVE_STREAM_DECODE_INTERVAL_SECONDS,
            LIVE_STREAM_MIN_AUDIO_SECONDS,
            LIVE_STREAM_FINAL_INTERVAL_SECONDS,
            LIVE_STREAM_OVERLAP_SECONDS,
        )
        if _is_base_model(model_name):
            return (9.0, profile[1], 2.2, 3.0, 1.8)
        if _is_small_model(model_name):
            return (max(profile[0], 10.0), profile[1], max(profile[2], 2.5), max(profile[3], 3.2), max(profile[4], 2.0))
        return profile
    profile = (
        STREAM_WINDOW_SECONDS,
        STREAM_DECODE_INTERVAL_SECONDS,
        STREAM_MIN_AUDIO_SECONDS,
        STREAM_FINAL_INTERVAL_SECONDS,
        STREAM_OVERLAP_SECONDS,
    )
    if _is_base_model(model_name):
        return (max(profile[0], 7.5), profile[1], max(profile[2], 1.9), max(profile[3], 2.6), max(profile[4], 1.2))
    if _is_small_model(model_name):
        return (max(profile[0], 8.0), profile[1], max(profile[2], 2.0), max(profile[3], 2.8), max(profile[4], 1.25))
    return profile


def _startup_stream_timing(
    content_mode: str | None,
    min_audio_seconds: float,
    final_interval_seconds: float,
) -> tuple[float, float]:
    if _is_lyrics_mode(content_mode):
        return min(min_audio_seconds, 1.6), min(final_interval_seconds, 2.4)
    if _is_live_mode(content_mode):
        return min(min_audio_seconds, 1.3), min(final_interval_seconds, 2.0)
    return min(min_audio_seconds, 1.2), min(final_interval_seconds, 1.8)


def _vad_for_mode(content_mode: str | None) -> bool:
    return False if _is_lyrics_mode(content_mode) else DEFAULT_VAD


def _normalized_language(language: str | None) -> str | None:
    normalized = (language or "").strip().lower()
    if not normalized or normalized == "auto":
        return None
    aliases = {
        "jpn": "ja",
        "japanese": "ja",
        "kor": "ko",
        "korean": "ko",
        "eng": "en",
        "english": "en",
        "zho": "zh",
        "chi": "zh",
        "chinese": "zh",
        "zh-cn": "zh",
        "zh-tw": "zh",
    }
    return aliases.get(normalized, normalized)


def _initial_prompt_for_mode(content_mode: str | None, language: str | None) -> str | None:
    if _is_lyrics_mode(content_mode):
        return LYRICS_INITIAL_PROMPT
    if _is_live_mode(content_mode):
        return LIVE_INITIAL_PROMPT
    return None


def _effective_language_for_mode(language: str | None, content_mode: str | None) -> str | None:
    return _normalized_language(language)


def _multilingual_for_mode(language: str | None, content_mode: str | None) -> bool:
    return _is_lyrics_mode(content_mode) and _normalized_language(language) is None


def _vad_parameters_for_mode(content_mode: str | None) -> dict[str, float | int] | None:
    if not _is_live_mode(content_mode):
        return None
    return {
        "threshold": LIVE_VAD_THRESHOLD,
        "min_silence_duration_ms": LIVE_VAD_MIN_SILENCE_MS,
        "speech_pad_ms": LIVE_VAD_SPEECH_PAD_MS,
    }


def _no_speech_threshold_for_mode(content_mode: str | None, model_name: str | None = None) -> float | None:
    if _is_lyrics_mode(content_mode):
        threshold = LYRICS_NO_SPEECH_THRESHOLD
    elif _is_live_mode(content_mode):
        threshold = LIVE_NO_SPEECH_THRESHOLD
    else:
        threshold = 0.6
    if _is_base_model(model_name):
        return max(threshold, 0.92 if _is_lyrics_mode(content_mode) else 0.82 if _is_live_mode(content_mode) else 0.72)
    if _is_small_model(model_name):
        return max(threshold, 0.9 if _is_lyrics_mode(content_mode) else 0.8 if _is_live_mode(content_mode) else 0.7)
    return threshold


def _prepare_audio_for_mode(audio: Any, content_mode: str | None) -> Any:
    if not _is_lyrics_mode(content_mode) and not _is_live_mode(content_mode):
        return audio

    audio_array = np.asarray(audio, dtype=np.float32)
    if audio_array.size == 0:
        return audio

    audio_array = audio_array - float(np.mean(audio_array))
    peak = float(np.max(np.abs(audio_array)))
    rms = float(np.sqrt(np.mean(np.square(audio_array))))
    if peak < 0.01 or rms < 0.002:
        return audio_array

    target_rms = 0.09 if _is_lyrics_mode(content_mode) else 0.07
    gain = min(4.0, max(1.0, target_rms / max(rms, 1e-6)))
    normalized = audio_array * gain
    normalized_peak = float(np.max(np.abs(normalized)))
    if normalized_peak > 0.96:
        normalized = normalized / normalized_peak * 0.96
    return np.clip(normalized, -1.0, 1.0).astype(np.float32)


def _load_model(model: str | None = None) -> Any:
    global _model, _model_name, _model_error, _model_error_name, _runtime_checked_model, _runtime_error

    target_model = _requested_model_name(model)
    with _inference_lock, _model_lock:
        if _model is not None and _model_name == target_model:
            return _model

        try:
            if DEFAULT_DEVICE == "mlx":
                from local_stt.mlx_backend import MlxWhisperModel

                loaded_model = MlxWhisperModel(target_model, compute_type=DEFAULT_COMPUTE_TYPE)
            else:
                from faster_whisper import WhisperModel

                loaded_model = WhisperModel(
                    target_model,
                    device=DEFAULT_DEVICE,
                    compute_type=DEFAULT_COMPUTE_TYPE,
                )
            _model = loaded_model
            _model_name = target_model
            _model_error = None
            _model_error_name = None
            _runtime_checked_model = None
            _runtime_error = None
            return _model
        except Exception as exc:  # noqa: BLE001 - expose startup failures in /health.
            _model_error = str(exc)
            _model_error_name = target_model
            print(f"local STT model load failed for {target_model}: {exc}", file=sys.stderr, flush=True)
            raise


def _write_probe_wav(path: Path) -> None:
    sample_rate = 16000
    duration_seconds = 1
    frames = b"\x00\x00" * sample_rate * duration_seconds

    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(frames)


def _probe_runtime(model: Any, model_name: str) -> None:
    global _runtime_checked_model, _runtime_error

    if _runtime_checked_model == model_name:
        if _runtime_error:
            raise RuntimeError(_runtime_error)
        return

    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_file:
        temp_path = Path(temp_file.name)

    try:
        _write_probe_wav(temp_path)
        with _inference_lock:
            segments, _ = model.transcribe(
                str(temp_path),
                beam_size=DEFAULT_BEAM_SIZE,
                vad_filter=False if DEFAULT_DEVICE == "mlx" else DEFAULT_VAD,
                condition_on_previous_text=False,
            )
            list(segments)
        _runtime_error = None
    except Exception as exc:  # noqa: BLE001 - health should expose CUDA runtime failures.
        _runtime_error = str(exc)
        raise
    finally:
        _runtime_checked_model = model_name
        temp_path.unlink(missing_ok=True)


def _segment_text(segment_list: list[Any], preserve_turns: bool = False) -> str:
    separator = "\n" if preserve_turns else " "
    return separator.join(segment.text.strip() for segment in segment_list if segment.text.strip()).strip()


def _audio_stats(audio: Any) -> tuple[float, float]:
    audio_array = np.asarray(audio, dtype=np.float32)
    if audio_array.size == 0:
        return 0.0, 0.0
    peak = float(np.max(np.abs(audio_array)))
    rms = float(np.sqrt(np.mean(np.square(audio_array))))
    return peak, rms


def _validate_audio_length(audio: Any) -> None:
    if getattr(audio, "size", 0) > STREAM_SAMPLE_RATE * MAX_DECODED_AUDIO_SECONDS:
        raise HTTPException(status_code=413, detail="Decoded audio is too long.")


def _append_stream_samples(
    chunks: deque[np.ndarray],
    buffered_samples: int,
    samples: np.ndarray,
    max_samples: int,
) -> int:
    chunks.append(samples)
    buffered_samples += int(samples.size)
    excess_samples = buffered_samples - max_samples
    while excess_samples > 0:
        oldest = chunks[0]
        if oldest.size <= excess_samples:
            chunks.popleft()
            buffered_samples -= int(oldest.size)
            excess_samples -= int(oldest.size)
            continue
        chunks[0] = oldest[excess_samples:].copy()
        buffered_samples -= excess_samples
        excess_samples = 0
    return buffered_samples


def _join_stream_samples(chunks: deque[np.ndarray]) -> np.ndarray:
    if not chunks:
        return np.empty(0, dtype=np.float32)
    if len(chunks) == 1:
        return chunks[0].copy()
    return np.concatenate(tuple(chunks))


def _looks_silent(audio: Any) -> bool:
    peak, rms = _audio_stats(audio)
    return peak < SILENCE_PEAK_THRESHOLD and rms < SILENCE_RMS_THRESHOLD


def _normalize_text(value: str) -> str:
    return " ".join(value.lower().split())


def _safe_log_text(value: str, limit: int) -> str:
    return ascii(value[:limit])


def _speech_key(value: str) -> str:
    return "".join(character for character in value.casefold() if character.isalnum())


def _has_excessive_repetition(text: str) -> bool:
    normalized = _normalize_text(text)
    if not normalized:
        return False

    tokens = re.findall(r"[\w가-힣ぁ-んァ-ン一-龯]+", normalized, flags=re.UNICODE)
    if len(tokens) >= 3 and len(set(tokens)) == 1:
        return True
    if len(tokens) >= 4:
        token_counts = {token: tokens.count(token) for token in set(tokens)}
        if max(token_counts.values()) / len(tokens) >= 0.75:
            return True

    key = _speech_key(text)
    for unit_length in range(2, max(2, len(key) // 2) + 1):
        if len(key) % unit_length == 0:
            unit = key[:unit_length]
            if len(unit) >= 2 and unit * (len(key) // unit_length) == key:
                return True
    if len(key) >= 8 and len(set(key)) <= 2:
        return True

    return False


LYRIC_HOOK_TOKENS = {
    "ah",
    "baby",
    "hey",
    "la",
    "na",
    "oh",
    "ooh",
    "uh",
    "wow",
    "yeah",
    "ラ",
    "ら",
    "あ",
    "ア",
}


def _is_intentional_lyric_refrain(text: str) -> bool:
    normalized = _normalize_text(text)
    if not normalized or _is_probable_hallucination(normalized):
        return False

    tokens = re.findall(r"[\w가-힣ぁ-んァ-ン一-龯]+", normalized, flags=re.UNICODE)
    if 2 <= len(tokens) <= 8 and len(set(tokens)) == 1:
        return len(tokens[0]) <= 12
    if 2 <= len(tokens) <= 10:
        token_counts = {token: tokens.count(token) for token in set(tokens)}
        if any(count >= 2 and token.casefold() in LYRIC_HOOK_TOKENS for token, count in token_counts.items()):
            return True

    key = _speech_key(normalized)
    for unit_length in range(1, min(8, len(key) // 2) + 1):
        if len(key) % unit_length:
            continue
        repeats = len(key) // unit_length
        unit = key[:unit_length]
        if 2 <= repeats <= 8 and unit and unit * repeats == key:
            return True
    return False


def _is_probable_credit_hallucination(key: str) -> bool:
    if len(key) <= 96 and re.fullmatch(
        r"(?:transcription|translation|transcript|caption(?:ing|s)?|subtitles?)(?:provided|created|edited)?by[\w가-힣ぁ-んァ-ン一-龯]+",
        key,
        flags=re.UNICODE,
    ):
        return True
    if any(part in key for part in CREDIT_HALLUCINATION_KEY_PARTS):
        if any(token in key for token in ("by", "의해", "완료", "제작", "기록", "번역", "による", "作成", "翻訳", "制作")):
            return True
    if ("transcribed" in key or "translated" in key) and "by" in key:
        return True
    if "텍스트기록" in key and ("의해" in key or "완료" in key):
        return True
    if "번역" in key and "의해" in key and ("완료" in key or "기록" in key):
        return True
    return False


def _is_probable_hallucination(text: str) -> bool:
    key = _speech_key(text)
    if not key:
        return False
    if key in PROBABLE_HALLUCINATION_KEYS:
        return True
    if "中文字幕" in key or "字幕组" in key or "字幕組" in key:
        return True
    if any(part in key for part in PROMPT_LEAK_KEY_PARTS):
        return True
    if _is_probable_credit_hallucination(key):
        return True
    if "subscribe" in key and any(token in key for token in ("dontforget", "please", "like", "channel", "button", "remember")):
        return True
    if "구독" in key and any(token in key for token in ("잊지마세요", "잊지마십시오", "부탁", "눌러", "해주세요", "좋아요", "알림")):
        return True
    if "チャンネル登録" in key and any(token in key for token in ("お願い", "高評価", "よろしく")):
        return True
    if "시청" in key and "감사" in key:
        return True
    return False


def _float_attr(segment: Any, name: str, default: float = 0.0) -> float:
    value = getattr(segment, name, default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _is_low_confidence_segment(segment: Any, content_mode: str | None, model_name: str | None = None) -> bool:
    text = (getattr(segment, "text", "") or "").strip()
    if not text:
        return True
    if _is_probable_hallucination(text):
        return True

    key = _speech_key(text)
    no_speech_prob = _float_attr(segment, "no_speech_prob")
    avg_logprob = _float_attr(segment, "avg_logprob")
    compression_ratio = _float_attr(segment, "compression_ratio", 1.0)
    lyrics_mode = _is_lyrics_mode(content_mode)

    lyric_refrain = lyrics_mode and _is_intentional_lyric_refrain(text)
    confident_lyric_refrain = lyric_refrain and no_speech_prob < 0.75 and avg_logprob > -1.55
    confident_lyrics_segment = lyrics_mode and no_speech_prob < 0.62 and avg_logprob > -1.15
    compact_no_speech_cutoff = 0.86 if _is_base_model(model_name) else 0.74
    compact_logprob_cutoff = -1.05 if _is_base_model(model_name) else -0.82
    if _is_compact_model(model_name) and no_speech_prob >= compact_no_speech_cutoff and avg_logprob <= compact_logprob_cutoff and len(key) <= 24:
        return True
    no_speech_drop_threshold = max(SEGMENT_NO_SPEECH_DROP_THRESHOLD, 0.94) if lyrics_mode else SEGMENT_NO_SPEECH_DROP_THRESHOLD
    if no_speech_prob >= no_speech_drop_threshold and len(key) <= (56 if lyrics_mode else 32):
        return True
    low_logprob_threshold = min(SEGMENT_LOW_LOGPROB_DROP_THRESHOLD, -1.55) if lyrics_mode else SEGMENT_LOW_LOGPROB_DROP_THRESHOLD
    if avg_logprob <= low_logprob_threshold and len(key) <= (48 if lyrics_mode else 48):
        return True
    if compression_ratio >= SEGMENT_COMPRESSION_RATIO_DROP_THRESHOLD and not confident_lyric_refrain and not confident_lyrics_segment:
        return True
    if _has_excessive_repetition(text) and not confident_lyric_refrain and not confident_lyrics_segment:
        return True
    return False


def _filter_transcription_segments(
    segment_list: list[Any],
    content_mode: str | None,
    model_name: str | None = None,
) -> list[Any]:
    filtered: list[Any] = []
    for segment in segment_list:
        text = (getattr(segment, "text", "") or "").strip()
        if _is_low_confidence_segment(segment, content_mode, model_name):
            if text:
                print(f"filtered low-confidence STT segment text={_safe_log_text(text, 80)}", flush=True)
            continue
        filtered.append(segment)
    return filtered


def _empty_transcription_response(
    language: str | None,
    model: str | None,
    duration_ms: int,
    vad_used: bool = DEFAULT_VAD,
    decode_error: str | None = None,
) -> dict[str, Any]:
    return {
        "text": "",
        "language": None if not language or language == "auto" else language,
        "model": _requested_model_name(model),
        "requested_model": model,
        "vad_filter_used": vad_used,
        "duration": 0,
        "processing_ms": duration_ms,
        "decode_error": decode_error,
        "segments": [],
    }


def _transcribe_audio(
    whisper_model: Any,
    audio: Any,
    language: str | None,
    vad_filter: bool,
    beam_size: int = DEFAULT_BEAM_SIZE,
    initial_prompt: str | None = None,
    no_speech_threshold: float | None = 0.6,
    content_mode: str | None = None,
    model_name: str | None = None,
) -> tuple[list[Any], Any, bool]:
    normalized_language = _normalized_language(language)
    with _inference_lock:
        segments, info = whisper_model.transcribe(
            audio,
            language=normalized_language,
            beam_size=beam_size,
            vad_filter=vad_filter,
            vad_parameters=_vad_parameters_for_mode(content_mode) if vad_filter else None,
            initial_prompt=initial_prompt,
            condition_on_previous_text=False,
            temperature=DECODE_TEMPERATURE,
            no_speech_threshold=no_speech_threshold,
            multilingual=_multilingual_for_mode(normalized_language, content_mode),
            language_detection_segments=(6 if _is_base_model(model_name) else 5 if _is_small_model(model_name) else 3)
            if normalized_language is None
            else 1,
        )
        return list(segments), info, vad_filter


def _transcribe_live_lyrics_fallback(
    whisper_model: Any,
    audio: Any,
    language: str | None,
    preserve_turns: bool = False,
    model_name: str | None = None,
) -> tuple[str, list[Any], Any, bool, int]:
    """Probe sung vocals only after the low-latency live-speech pass is empty."""
    lyrics_audio = _prepare_audio_for_mode(audio, "lyrics")
    lyrics_beam_size = _beam_size_for_mode("lyrics", model_name)
    segment_list, info, vad_used = _transcribe_audio(
        whisper_model,
        lyrics_audio,
        _effective_language_for_mode(language, "lyrics"),
        _vad_for_mode("lyrics"),
        lyrics_beam_size,
        _initial_prompt_for_mode("lyrics", language),
        _no_speech_threshold_for_mode("lyrics", model_name),
        "lyrics",
        model_name,
    )
    segment_list = _filter_transcription_segments(segment_list, "lyrics", model_name)
    text = _segment_text(segment_list, preserve_turns)
    return text, segment_list, info, vad_used, lyrics_beam_size


def _stream_transcribe_text(
    whisper_model: Any,
    audio: Any,
    language: str | None,
    content_mode: str | None,
    preserve_turns: bool = False,
    model_name: str | None = None,
) -> tuple[str, bool, int]:
    prepared_audio = _prepare_audio_for_mode(audio, content_mode)
    beam_size = _beam_size_for_mode(content_mode, model_name)
    initial_prompt = _initial_prompt_for_mode(content_mode, language)
    effective_language = _effective_language_for_mode(language, content_mode)
    no_speech_threshold = _no_speech_threshold_for_mode(content_mode, model_name)
    vad_filter = _vad_for_mode(content_mode)
    if _looks_silent(prepared_audio):
        return "", vad_filter, beam_size
    segment_list, _info, vad_used = _transcribe_audio(
        whisper_model,
        prepared_audio,
        effective_language,
        vad_filter,
        beam_size,
        initial_prompt,
        no_speech_threshold,
        content_mode,
        model_name,
    )
    segment_list = _filter_transcription_segments(segment_list, content_mode, model_name)
    text = _segment_text(segment_list, preserve_turns)
    if not text and _is_live_mode(content_mode):
        text, _segments, _info, vad_used, beam_size = _transcribe_live_lyrics_fallback(
            whisper_model,
            audio,
            language,
            preserve_turns,
            model_name,
        )
    elif not text and vad_filter:
        segment_list, _info, vad_used = _transcribe_audio(
            whisper_model,
            prepared_audio,
            effective_language,
            False,
            beam_size,
            initial_prompt,
            no_speech_threshold,
            content_mode,
            model_name,
        )
        segment_list = _filter_transcription_segments(segment_list, content_mode, model_name)
        text = _segment_text(segment_list, preserve_turns)
    return text, vad_used, beam_size


@app.get("/health")
def health() -> dict[str, Any]:
    status = "ready"
    error = _model_error

    try:
        model = _load_model(DEFAULT_MODEL)
        _probe_runtime(model, DEFAULT_MODEL)
    except Exception as exc:  # noqa: BLE001
        status = "error"
        error = str(exc)

    return {
        "ok": status == "ready",
        "status": status,
        "server": APP_NAME,
        **_server_config(),
        "error": error,
        "hint": _health_hint(error, _model_error_name or DEFAULT_MODEL),
    }


@app.get("/v1/models")
def models() -> dict[str, Any]:
    model_ids = list(dict.fromkeys([DEFAULT_MODEL, *_cached_models()]))
    return {
        "object": "list",
        "data": [
            {
                "id": model_id,
                "object": "model",
                "owned_by": "local-mlx-whisper" if DEFAULT_DEVICE == "mlx" else "local-faster-whisper",
            }
            for model_id in model_ids
        ],
    }


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str | None = Form(default=None),
    language: str | None = Form(default=None),
    content_mode: str | None = Form(default=None),
    response_format: str | None = Form(default="json"),
) -> dict[str, Any] | str:
    try:
        requested_model = _requested_model_name(model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if STRICT_MODEL and requested_model != DEFAULT_MODEL:
        raise HTTPException(status_code=400, detail=f"Configured STT model is {DEFAULT_MODEL}, not {requested_model}.")

    suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    started_at = time.perf_counter()

    audio_bytes = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(audio_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Audio upload is too large.")

    try:
        whisper_model = _load_model(requested_model)
    except Exception as exc:  # noqa: BLE001
        hint = _health_hint(str(exc), requested_model)
        detail = f"local STT model '{requested_model}' is not ready: {exc}"
        if hint:
            detail = f"{detail} {hint}"
        raise HTTPException(status_code=503, detail=detail) from exc

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        temp_path = Path(temp_file.name)
        temp_file.write(audio_bytes)

    try:
        try:
            try:
                from faster_whisper.audio import decode_audio

                audio = decode_audio(str(temp_path), sampling_rate=16000)
                _validate_audio_length(audio)
            except Exception as exc:  # noqa: BLE001 - short browser chunks can occasionally be undecodable.
                duration_ms = round((time.perf_counter() - started_at) * 1000)
                print(f"audio decode failed: {exc}", file=sys.stderr, flush=True)
                return _empty_transcription_response(language, requested_model, duration_ms, decode_error=str(exc))

            if getattr(audio, "size", 0) < 1600:
                duration_ms = round((time.perf_counter() - started_at) * 1000)
                return _empty_transcription_response(language, requested_model, duration_ms)

            prepared_audio = _prepare_audio_for_mode(audio, content_mode)
            if _looks_silent(prepared_audio):
                duration_ms = round((time.perf_counter() - started_at) * 1000)
                return _empty_transcription_response(language, requested_model, duration_ms)

            beam_size = _beam_size_for_mode(content_mode, requested_model)
            initial_prompt = _initial_prompt_for_mode(content_mode, language)
            effective_language = _effective_language_for_mode(language, content_mode)
            no_speech_threshold = _no_speech_threshold_for_mode(content_mode, requested_model)
            vad_filter = _vad_for_mode(content_mode)
            segment_list, info, vad_used = _transcribe_audio(
                whisper_model,
                prepared_audio,
                effective_language,
                vad_filter,
                beam_size,
                initial_prompt,
                no_speech_threshold,
                content_mode,
                requested_model,
            )
            segment_list = _filter_transcription_segments(segment_list, content_mode, requested_model)
            text = _segment_text(segment_list)
            if not text and _is_live_mode(content_mode):
                text, segment_list, info, vad_used, beam_size = _transcribe_live_lyrics_fallback(
                    whisper_model,
                    audio,
                    language,
                    model_name=requested_model,
                )
            elif not text and vad_filter and EMPTY_RETRY_NO_VAD:
                segment_list, info, vad_used = _transcribe_audio(
                    whisper_model,
                    prepared_audio,
                    effective_language,
                    False,
                    beam_size,
                    initial_prompt,
                    no_speech_threshold,
                    content_mode,
                    requested_model,
                )
                segment_list = _filter_transcription_segments(segment_list, content_mode, requested_model)
                text = _segment_text(segment_list)
            if _is_probable_hallucination(text):
                print(f"filtered probable STT hallucination text={_safe_log_text(text, 80)}", flush=True)
                text = ""
                segment_list = []
        except Exception as exc:  # noqa: BLE001
            print(f"local STT transcription failed: {exc}", file=sys.stderr, flush=True)
            raise HTTPException(status_code=503, detail=f"local STT transcription failed: {exc}") from exc
    finally:
        temp_path.unlink(missing_ok=True)

    duration_ms = round((time.perf_counter() - started_at) * 1000)

    if response_format == "text":
        return text

    return {
        "text": text,
        "language": info.language,
        "model": requested_model,
        "requested_model": model,
        "content_mode": content_mode or "auto",
        "beam_size_used": beam_size,
        "vad_filter_used": vad_used,
        "duration": getattr(info, "duration", None),
        "processing_ms": duration_ms,
        "segments": [
            {
                "id": index,
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
            }
            for index, segment in enumerate(segment_list)
        ],
    }


@app.websocket("/v1/audio/stream")
async def audio_stream(websocket: WebSocket) -> None:
    if not _allowed_browser_origin(websocket.headers.get("origin")):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    model = websocket.query_params.get("model")
    language = websocket.query_params.get("language")
    content_mode = websocket.query_params.get("content_mode") or websocket.query_params.get("mode")
    preserve_turns = websocket.query_params.get("speaker_turns", "").strip().lower() in {"1", "true", "yes", "on"}
    try:
        requested_model = _requested_model_name(model)
    except ValueError as exc:
        await websocket.send_json({"type": "error", "text": str(exc)})
        await websocket.close(code=1008)
        return
    profile = _profile_name(content_mode)
    print(f"stream connected model={requested_model} language={language or 'auto'} profile={profile}", flush=True)
    if STRICT_MODEL and requested_model != DEFAULT_MODEL:
        await websocket.send_json({"type": "error", "text": f"Configured STT model is {DEFAULT_MODEL}, not {requested_model}."})
        await websocket.close(code=1011)
        return

    try:
        whisper_model = _load_model(requested_model)
    except Exception as exc:  # noqa: BLE001
        hint = _health_hint(str(exc), requested_model)
        await websocket.send_json({"type": "error", "text": f"local STT model '{requested_model}' is not ready: {exc} {hint or ''}".strip()})
        await websocket.close(code=1011)
        return

    buffer_chunks: deque[np.ndarray] = deque()
    buffered_samples = 0
    (
        stream_window_seconds,
        stream_decode_interval_seconds,
        stream_min_audio_seconds,
        stream_final_interval_seconds,
        stream_overlap_seconds,
    ) = _stream_profile_for_model(content_mode, requested_model)
    startup_min_audio_seconds, startup_final_interval_seconds = _startup_stream_timing(
        content_mode,
        stream_min_audio_seconds,
        stream_final_interval_seconds,
    )
    max_samples = max(STREAM_SAMPLE_RATE, int(STREAM_SAMPLE_RATE * stream_window_seconds))
    min_samples = max(1, int(STREAM_SAMPLE_RATE * stream_min_audio_seconds))
    startup_min_samples = max(1, int(STREAM_SAMPLE_RATE * startup_min_audio_seconds))
    overlap_samples = max(0, int(STREAM_SAMPLE_RATE * stream_overlap_seconds))
    total_samples = 0
    sequence = 0
    last_decode_at = 0.0
    last_partial = ""
    last_final = ""
    partial_started_at: float | None = None
    empty_decode_count = 0
    last_status_at = 0.0
    last_receive_log_at = 0.0

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            chunk = message.get("bytes")
            if chunk:
                if len(chunk) > MAX_STREAM_CHUNK_BYTES:
                    await websocket.close(code=1009)
                    return
                if len(chunk) % 2:
                    chunk = chunk[:-1]
                samples = np.frombuffer(chunk, dtype="<i2").astype(np.float32) / 32768.0
                if samples.size:
                    buffered_samples = _append_stream_samples(
                        buffer_chunks,
                        buffered_samples,
                        samples,
                        max_samples,
                    )
                    total_samples += int(samples.size)
                    now_for_log = time.perf_counter()
                    if now_for_log - last_receive_log_at >= 5.0:
                        last_receive_log_at = now_for_log
                        print(
                            f"stream audio received total={round(total_samples / STREAM_SAMPLE_RATE, 1)}s "
                            f"buffer={round(buffered_samples / STREAM_SAMPLE_RATE, 1)}s",
                            flush=True,
                        )

            text_message = message.get("text")
            if text_message == "reset":
                buffer_chunks.clear()
                buffered_samples = 0
                total_samples = 0
                last_decode_at = 0.0
                last_partial = ""
                last_final = ""
                partial_started_at = None
                empty_decode_count = 0
                last_status_at = 0.0
                continue
            if text_message == "flush":
                last_decode_at = 0.0

            now = time.perf_counter()
            required_samples = startup_min_samples if not last_final else min_samples
            if buffered_samples < required_samples or now - last_decode_at < stream_decode_interval_seconds:
                continue
            last_decode_at = now

            recent = _join_stream_samples(buffer_chunks)
            try:
                text, vad_used, beam_size = await asyncio.to_thread(
                    _stream_transcribe_text,
                    whisper_model,
                    recent,
                    language,
                    content_mode,
                    preserve_turns,
                    requested_model,
                )
            except Exception as exc:  # noqa: BLE001
                print(f"streaming transcription failed: {exc}", file=sys.stderr, flush=True)
                await websocket.send_json({"type": "error", "text": f"streaming transcription failed: {exc}"})
                continue

            normalized = _normalize_text(text)
            if _is_probable_hallucination(text):
                print(f"stream filtered probable hallucination text={_safe_log_text(text, 80)}", flush=True)
                normalized = ""
                text = ""
            if not normalized:
                empty_decode_count += 1
                if now - last_status_at >= 3.0:
                    last_status_at = now
                    seconds = round(buffered_samples / STREAM_SAMPLE_RATE, 1)
                    print(
                        f"stream empty decode count={empty_decode_count} buffer={seconds}s vad_used={vad_used}",
                        flush=True,
                    )
                    await websocket.send_json(
                        {
                            "type": "status",
                            "text": f"오디오 수신 중... STT 인식 대기 ({profile}, {seconds}s buffer, empty {empty_decode_count})",
                            "vad_filter_used": vad_used,
                            "beam_size_used": beam_size,
                            "seq": sequence,
                        }
                    )
                continue
            empty_decode_count = 0

            if partial_started_at is None:
                partial_started_at = now
            should_finalize = (
                normalized
                and normalized != last_final
                and bool(last_partial)
                and (
                    normalized == last_partial
                    or now - partial_started_at
                    >= (startup_final_interval_seconds if not last_final else stream_final_interval_seconds)
                )
            )
            if should_finalize:
                message_type = "final"
                last_final = normalized
                partial_started_at = None
            else:
                message_type = "partial"
            last_partial = normalized

            sequence += 1
            end_ms = round(total_samples * 1000 / STREAM_SAMPLE_RATE)
            start_ms = max(0, end_ms - round(recent.size * 1000 / STREAM_SAMPLE_RATE))
            print(f"stream {message_type} seq={sequence} chars={len(text)}", flush=True)
            await websocket.send_json(
                {
                    "type": message_type,
                    "text": text,
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "seq": sequence,
                    "model": requested_model,
                    "content_mode": profile,
                    "vad_filter_used": vad_used,
                    "beam_size_used": beam_size,
                }
            )
            if message_type == "final" and buffered_samples > overlap_samples:
                buffer_chunks.clear()
                if overlap_samples > 0:
                    overlap = recent[-overlap_samples:].copy()
                    buffer_chunks.append(overlap)
                    buffered_samples = int(overlap.size)
                else:
                    buffered_samples = 0
                last_partial = ""
    except WebSocketDisconnect:
        print("stream disconnected", flush=True)
        return
    finally:
        print("stream closed", flush=True)
