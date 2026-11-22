from __future__ import annotations

import unittest
import asyncio
import io
import threading
import wave
from collections import deque
from contextlib import nullcontext
from types import SimpleNamespace
from unittest import mock

import ctranslate2
import numpy as np
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from local_stt import app
from local_stt.mlx_backend import MlxWhisperModel


def wav_bytes(seconds: float) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(np.full(int(16000 * seconds), 3000, dtype="<i2").tobytes())
    return output.getvalue()


class FakeWhisperModel:
    def __init__(self) -> None:
        self.kwargs: dict[str, object] = {}

    def transcribe(self, _audio: object, **kwargs: object) -> tuple[list[object], SimpleNamespace]:
        self.kwargs = kwargs
        return [], SimpleNamespace(language=kwargs.get("language"))


class PlatformConfigurationTests(unittest.TestCase):
    def test_apple_silicon_uses_mlx_without_querying_cuda(self) -> None:
        with (
            mock.patch.object(app.sys, "platform", "darwin"),
            mock.patch.object(app.platform, "machine", return_value="arm64"),
            mock.patch.object(ctranslate2, "get_cuda_device_count") as cuda_count,
        ):
            self.assertEqual(app._default_device(), "mlx")
            self.assertEqual(app._candidate_cuda_dll_dirs(), [])
        cuda_count.assert_not_called()

    def test_cuda_is_used_only_when_available(self) -> None:
        with mock.patch.object(app.sys, "platform", "win32"):
            with mock.patch.object(ctranslate2, "get_cuda_device_count", return_value=1):
                self.assertEqual(app._default_device(), "cuda")
            with mock.patch.object(ctranslate2, "get_cuda_device_count", return_value=0):
                self.assertEqual(app._default_device(), "cpu")


class ModeConfigurationTests(unittest.TestCase):
    def setUp(self) -> None:
        device = mock.patch.object(app, "DEFAULT_DEVICE", "cpu")
        device.start()
        self.addCleanup(device.stop)

    def test_browser_origins_are_limited_to_chrome_extensions(self) -> None:
        self.assertFalse(app._allowed_browser_origin(None))
        self.assertTrue(app._allowed_browser_origin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"))
        self.assertFalse(app._allowed_browser_origin("https://example.com"))
        response = TestClient(app.app).get(
            "/missing",
            headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"},
        )
        self.assertEqual(response.status_code, 404)

    def test_untrusted_http_origin_is_rejected_before_model_loading(self) -> None:
        with mock.patch.object(app, "_load_model") as load_model:
            response = TestClient(app.app).get("/health", headers={"Origin": "https://example.com"})
            missing_origin = TestClient(app.app).get("/health")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(missing_origin.status_code, 403)
        load_model.assert_not_called()

    def test_loopback_extension_http_requests_can_omit_origin(self) -> None:
        client = TestClient(app.app, base_url="http://127.0.0.1:8765")
        headers = {"X-YT-Translator-Local-STT": "1"}
        self.assertEqual(client.get("/missing", headers=headers).status_code, 404)
        self.assertEqual(client.post("/v1/audio/transcriptions", headers=headers).status_code, 422)
        self.assertEqual(client.get("/missing", headers={**headers, "Origin": "https://example.com"}).status_code, 403)
        self.assertEqual(TestClient(app.app).get("/missing", headers=headers).status_code, 403)
        self.assertEqual(client.options("/health", headers={
            "Origin": "https://example.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "X-YT-Translator-Local-STT",
        }).status_code, 403)

    def test_requested_models_must_be_configured_or_cached(self) -> None:
        with mock.patch.object(app, "_cached_models", return_value=["medium"]):
            self.assertEqual(app._requested_model_name("medium"), "medium")
            with self.assertRaises(ValueError):
                app._requested_model_name("attacker/model")

    def test_oversized_upload_is_rejected_before_model_loading(self) -> None:
        with (
            mock.patch.object(app, "MAX_UPLOAD_BYTES", 4),
            mock.patch.object(app, "_load_model") as load_model,
        ):
            response = TestClient(app.app).post(
                "/v1/audio/transcriptions",
                files={"file": ("audio.webm", b"12345", "audio/webm")},
                headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"},
            )

        self.assertEqual(response.status_code, 413)
        load_model.assert_not_called()

    def test_decoded_audio_duration_is_bounded(self) -> None:
        with mock.patch.object(app, "MAX_DECODED_AUDIO_SECONDS", 1):
            with self.assertRaises(app.HTTPException) as raised:
                app._validate_audio_length(np.zeros(app.STREAM_SAMPLE_RATE + 1, dtype=np.float32))

        self.assertEqual(raised.exception.status_code, 413)

    def test_request_limit_rejects_known_and_chunked_bodies_before_multipart_parsing(self) -> None:
        for encoding in ("known", "chunked", "misdeclared"):
            with (
                self.subTest(encoding=encoding),
                mock.patch.object(app, "MAX_UPLOAD_BYTES", 1024),
                mock.patch("starlette.formparsers.SpooledTemporaryFile") as spool,
                mock.patch.object(app, "_load_model") as load_model,
            ):
                data = b"x" * (66 * 1024)
                headers = {
                    "Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
                    "Content-Type": "multipart/form-data; boundary=example",
                }
                if encoding == "misdeclared":
                    headers["Content-Length"] = "1"
                response = TestClient(app.app).post(
                    "/v1/audio/transcriptions",
                    content=iter([data[:33000], data[33000:]]) if encoding == "chunked" else data,
                    headers=headers,
                )
                self.assertEqual(response.status_code, 413)
                spool.assert_not_called()
                load_model.assert_not_called()

    def test_decoded_limit_returns_413_and_valid_audio_still_transcribes(self) -> None:
        model = FakeWhisperModel()
        with (
            mock.patch.object(app, "MAX_DECODED_AUDIO_SECONDS", 1),
            mock.patch.object(app, "_load_model", return_value=model),
        ):
            client = TestClient(app.app)
            for seconds, status in ((2, 413), (0.5, 200)):
                with self.subTest(seconds=seconds):
                    response = client.post(
                        "/v1/audio/transcriptions",
                        files={"file": ("test.wav", wav_bytes(seconds), "audio/wav")},
                        headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"},
                    )
                    self.assertEqual(response.status_code, status)
                    if status == 413:
                        self.assertFalse(model.kwargs)
                    else:
                        self.assertEqual(response.json()["text"], "")
                        self.assertTrue(model.kwargs)

    def test_malformed_short_audio_keeps_empty_success_response(self) -> None:
        with mock.patch.object(app, "_load_model", return_value=FakeWhisperModel()):
            response = TestClient(app.app).post(
                "/v1/audio/transcriptions",
                files={"file": ("test.webm", b"undecodable", "audio/webm")},
                headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["text"], "")
        self.assertTrue(response.json()["decode_error"])

    def test_decoder_checks_resampled_frames_before_allocating_arrays_including_flush(self) -> None:
        for overflow_in_flush in (False, True):
            with self.subTest(overflow_in_flush=overflow_in_flush):
                first = SimpleNamespace(
                    samples=16000 if overflow_in_flush else 16001,
                    to_ndarray=mock.Mock(return_value=np.zeros((1, 16000), dtype=np.int16)),
                )
                tail = SimpleNamespace(samples=1, to_ndarray=mock.Mock())
                resampler = SimpleNamespace(resample=mock.Mock(side_effect=[[first], [tail]]))
                container = SimpleNamespace(decode=mock.Mock(return_value=iter([SimpleNamespace(pts=1)])))
                with (
                    mock.patch.object(app, "MAX_DECODED_AUDIO_SECONDS", 1),
                    mock.patch("av.open", return_value=nullcontext(container)),
                    mock.patch("av.audio.resampler.AudioResampler", return_value=resampler),
                ):
                    with self.assertRaises(app.HTTPException) as raised:
                        app._decode_audio("test.wav")
                self.assertEqual(raised.exception.status_code, 413)
                self.assertEqual(first.to_ndarray.call_count, 1 if overflow_in_flush else 0)
                tail.to_ndarray.assert_not_called()

    def test_untrusted_websocket_origin_is_rejected(self) -> None:
        with self.assertRaises(WebSocketDisconnect) as raised:
            with TestClient(app.app).websocket_connect(
                "/v1/audio/stream",
                headers={"Origin": "https://example.com"},
            ):
                pass

        self.assertEqual(raised.exception.code, 1008)

    def test_oversized_websocket_frame_is_rejected(self) -> None:
        with (
            mock.patch.object(app, "MAX_STREAM_CHUNK_BYTES", 4),
            mock.patch.object(app, "_load_model", return_value=FakeWhisperModel()),
            TestClient(app.app).websocket_connect(
                "/v1/audio/stream",
                headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"},
            ) as websocket,
        ):
            websocket.send_bytes(b"12345")
            with self.assertRaises(WebSocketDisconnect) as raised:
                websocket.receive_json()

        self.assertEqual(raised.exception.code, 1009)

    def test_explicit_japanese_is_kept_for_lyrics(self) -> None:
        self.assertEqual(app._effective_language_for_mode("japanese", "lyrics"), "ja")
        self.assertFalse(app._multilingual_for_mode("ja", "lyrics"))

    def test_auto_lyrics_enables_segment_language_detection(self) -> None:
        model = FakeWhisperModel()
        initial_prompt = app._initial_prompt_for_mode("lyrics", None)

        app._transcribe_audio(
            model,
            np.zeros(1600, dtype=np.float32),
            None,
            False,
            beam_size=3,
            initial_prompt=initial_prompt,
            content_mode="lyrics",
        )

        self.assertIsNone(model.kwargs["language"])
        self.assertTrue(model.kwargs["multilingual"])
        self.assertEqual(model.kwargs["language_detection_segments"], 3)
        self.assertEqual(model.kwargs["temperature"], app.DECODE_TEMPERATURE)
        self.assertEqual(model.kwargs["initial_prompt"], initial_prompt)

    def test_lyrics_mode_uses_stronger_search_for_fast_songs(self) -> None:
        self.assertEqual(app._beam_size_for_mode("lyrics", "medium"), app.LYRICS_BEAM_SIZE)
        self.assertGreaterEqual(app.LYRICS_BEAM_SIZE, 5)
        self.assertTrue(app.LYRICS_INITIAL_PROMPT)

    def test_streaming_only_retries_without_vad_when_enabled(self) -> None:
        audio = np.full(32000, 0.1, dtype=np.float32)
        for retry in (False, True):
            with (
                self.subTest(retry=retry),
                mock.patch.object(app, "DEFAULT_VAD", True),
                mock.patch.object(app, "EMPTY_RETRY_NO_VAD", retry),
                mock.patch.object(
                    app, "_transcribe_audio",
                    side_effect=[([], None, True), ([SimpleNamespace(text="The sky is light.")], None, False)],
                ) as transcribe,
            ):
                text, _, _ = app._stream_transcribe_text(object(), audio, "en", "spoken")
                self.assertEqual(text, "The sky is light." if retry else "")
                self.assertEqual(transcribe.call_count, 2 if retry else 1)

    def test_lyrics_websocket_discards_finalized_audio_during_interlude(self) -> None:
        profile = app._stream_profile_for_model("lyrics", "qwen3-asr-1.7b")
        headers = {"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"}

        def infer(_model: object, audio: np.ndarray, *_args: object) -> tuple[str, bool, int]:
            level = float(np.max(audio)) * 32768
            text = "次の歌詞が始まる。" if level >= 9000 else "青い空を見上げる。" if level >= 6000 else ""
            return text, False, 1

        with (
            mock.patch.object(app, "_load_model", return_value=object()),
            mock.patch.object(app, "_stream_profile_for_model", return_value=(profile[0], 0, 0.1, profile[3], profile[4])),
            mock.patch.object(app, "_startup_stream_timing", return_value=(0.1, 100)),
            mock.patch.object(app, "_stream_transcribe_text", side_effect=infer),
            TestClient(app.app).websocket_connect(
                "/v1/audio/stream?content_mode=lyrics&model=qwen3-asr-1.7b", headers=headers
            ) as socket,
        ):
            for expected in ("partial", "final"):
                socket.send_bytes(np.full(3200, 6000, dtype="<i2").tobytes())
                self.assertEqual(socket.receive_json()["type"], expected)
            socket.send_bytes(np.full(3200, 1000, dtype="<i2").tobytes())
            self.assertEqual(socket.receive_json()["type"], "status")
            socket.send_bytes(np.full(3200, 9000, dtype="<i2").tobytes())
            result = socket.receive_json()
            self.assertEqual(result["type"], "partial")
            self.assertEqual(result["text"], "次の歌詞が始まる。")

    def test_short_qwen_lyrics_require_agreement_without_prompt_examples(self) -> None:
        t = np.arange(32000, dtype=np.float32) / app.STREAM_SAMPLE_RATE
        audio = 0.1 * np.sin(2 * np.pi * 440 * t)
        for unprompted, expected in [("Oh, oh.", ""), ("Baby!", "Baby.")]:
            with self.subTest(unprompted=unprompted):
                model = mock.Mock()
                model.transcribe.side_effect = [
                    ([SimpleNamespace(text="Baby.")], None),
                    ([SimpleNamespace(text=unprompted)], None),
                ]
                text, _, _ = app._stream_transcribe_text(
                    model, audio, "en", "lyrics", model_name="qwen3-asr-1.7b", check_short_lyrics=True
                )
                self.assertEqual(text, expected)
                self.assertTrue(model.transcribe.call_args_list[0].kwargs["initial_prompt"])
                self.assertIsNone(model.transcribe.call_args_list[1].kwargs["initial_prompt"])

    def test_live_uses_permissive_vad_without_releasing_language(self) -> None:
        model = FakeWhisperModel()

        app._transcribe_audio(
            model,
            np.zeros(1600, dtype=np.float32),
            "ja",
            True,
            beam_size=3,
            content_mode="live",
        )

        self.assertEqual(model.kwargs["language"], "ja")
        self.assertFalse(model.kwargs["multilingual"])
        self.assertEqual(
            model.kwargs["vad_parameters"],
            {
                "threshold": app.LIVE_VAD_THRESHOLD,
                "min_silence_duration_ms": app.LIVE_VAD_MIN_SILENCE_MS,
                "speech_pad_ms": app.LIVE_VAD_SPEECH_PAD_MS,
            },
        )

    def test_confident_lyric_refrain_survives_repetition_filter(self) -> None:
        segment = SimpleNamespace(
            text="ラ ラ ラ ラ ラ ラ",
            no_speech_prob=0.1,
            avg_logprob=-0.2,
            compression_ratio=3.2,
        )
        uncertain_segment = SimpleNamespace(
            text=segment.text,
            no_speech_prob=0.95,
            avg_logprob=-1.5,
            compression_ratio=segment.compression_ratio,
        )

        self.assertFalse(app._is_low_confidence_segment(segment, "lyrics"))
        self.assertTrue(app._is_low_confidence_segment(uncertain_segment, "lyrics"))

    def test_observed_japanese_instrumental_hallucinations_are_filtered(self) -> None:
        self.assertTrue(app._is_probable_hallucination("詳細は概要欄にリンクを貼っています。"))
        self.assertTrue(app._is_probable_hallucination("日本語の歌詞。日本語の歌詞。"))
        self.assertTrue(app._is_probable_hallucination("Thank you very much."))

    def test_old_lyric_prompt_example_is_filtered_without_dropping_genuine_hooks(self) -> None:
        example = "ラララ、ああ、wow、yeah、baby。"
        self.assertTrue(app._is_probable_hallucination(example))
        self.assertNotIn(app._speech_key(example), app._speech_key(app.DEFAULT_LYRICS_INITIAL_PROMPT))
        self.assertFalse(app._is_probable_hallucination("ラララ、君と歌う。Wow, baby!"))

    def test_japanese_log_text_is_safe_for_windows_korean_codepage(self) -> None:
        logged = app._safe_log_text("ご視聴ありがとうございました", 80)

        logged.encode("cp949")
        self.assertIn("\\u", logged)

    def test_small_model_uses_more_search_and_context_than_medium(self) -> None:
        self.assertEqual(app._beam_size_for_mode("live", "small"), app.SMALL_MODEL_BEAM_SIZE)
        self.assertEqual(app._beam_size_for_mode("live", "medium"), app.LIVE_BEAM_SIZE)

        small_profile = app._stream_profile_for_model("lyrics", "small")
        medium_profile = app._stream_profile_for_model("lyrics", "medium")
        self.assertGreater(small_profile[0], medium_profile[0])
        self.assertEqual(small_profile[4], medium_profile[4])
        self.assertEqual(small_profile[4], 0.0)
        self.assertGreater(
            app._no_speech_threshold_for_mode("live", "small"),
            app._no_speech_threshold_for_mode("live", "medium"),
        )

    def test_first_stream_result_uses_short_startup_timing(self) -> None:
        min_audio, final_interval = app._startup_stream_timing("lyrics", 3.5, 4.0)

        self.assertLessEqual(min_audio, 1.6)
        self.assertLessEqual(final_interval, 2.4)
        self.assertEqual(app._startup_stream_timing("spoken", 1.0, 1.5), (1.0, 1.5))

    def test_base_model_uses_stable_profile(self) -> None:
        self.assertEqual(app._beam_size_for_mode("live", "base"), app.BASE_MODEL_BEAM_SIZE)
        self.assertEqual(app._beam_size_for_mode("spoken", "base"), app.BASE_MODEL_BEAM_SIZE)

        base_profile = app._stream_profile_for_model("lyrics", "base")
        small_profile = app._stream_profile_for_model("lyrics", "small")
        self.assertGreaterEqual(base_profile[0], 12.0)
        self.assertGreaterEqual(base_profile[2], 2.8)
        self.assertGreaterEqual(base_profile[3], 3.4)
        self.assertEqual(base_profile[4], 0.0)
        self.assertLess(base_profile[0], small_profile[0])
        self.assertLess(base_profile[2], small_profile[2])
        self.assertLess(base_profile[3], small_profile[3])

        live_profile = app._stream_profile_for_model("live", "base")
        self.assertGreaterEqual(live_profile[0], 9.0)
        self.assertGreaterEqual(live_profile[2], 2.2)
        self.assertGreaterEqual(live_profile[3], 3.0)
        self.assertGreaterEqual(live_profile[4], 1.8)

        spoken_profile = app._stream_profile_for_model("spoken", "base")
        self.assertGreaterEqual(spoken_profile[0], 7.5)
        self.assertGreaterEqual(spoken_profile[2], 1.9)
        self.assertGreaterEqual(spoken_profile[3], 2.6)
        self.assertGreaterEqual(spoken_profile[4], 1.2)
        self.assertGreater(
            app._no_speech_threshold_for_mode("live", "base"),
            app._no_speech_threshold_for_mode("live", "small"),
        )

    def test_small_auto_detection_uses_more_audio_segments(self) -> None:
        model = FakeWhisperModel()

        app._transcribe_audio(
            model,
            np.zeros(1600, dtype=np.float32),
            None,
            False,
            beam_size=app.SMALL_MODEL_BEAM_SIZE,
            content_mode="live",
            model_name="small",
        )

        self.assertEqual(model.kwargs["language_detection_segments"], 5)

    def test_base_auto_detection_uses_more_audio_segments(self) -> None:
        model = FakeWhisperModel()

        app._transcribe_audio(
            model,
            np.zeros(1600, dtype=np.float32),
            None,
            False,
            beam_size=app.BASE_MODEL_BEAM_SIZE,
            content_mode="live",
            model_name="base",
        )

        self.assertEqual(model.kwargs["language_detection_segments"], 6)

    def test_small_drops_short_low_confidence_instrumental_guess(self) -> None:
        segment = SimpleNamespace(
            text="エンディング",
            no_speech_prob=0.753,
            avg_logprob=-0.861,
            compression_ratio=0.75,
        )

        self.assertTrue(app._is_low_confidence_segment(segment, "live", "small"))
        self.assertFalse(app._is_low_confidence_segment(segment, "live", "base"))
        self.assertFalse(app._is_low_confidence_segment(segment, "live", "medium"))

    def test_base_still_drops_very_uncertain_short_guess(self) -> None:
        segment = SimpleNamespace(
            text="エンディング",
            no_speech_prob=0.91,
            avg_logprob=-1.12,
            compression_ratio=0.75,
        )

        self.assertTrue(app._is_low_confidence_segment(segment, "live", "base"))

    def test_lyrics_keeps_fast_low_logprob_fragment_that_spoken_mode_would_drop(self) -> None:
        segment = SimpleNamespace(
            text="響け la-la-la",
            no_speech_prob=0.42,
            avg_logprob=-1.36,
            compression_ratio=1.2,
        )

        self.assertFalse(app._is_low_confidence_segment(segment, "lyrics", "medium"))
        self.assertTrue(app._is_low_confidence_segment(segment, "spoken", "medium"))

    def test_confident_fast_lyrics_survive_high_compression(self) -> None:
        segment = SimpleNamespace(
            text="駆け抜けていく",
            no_speech_prob=0.3,
            avg_logprob=-0.82,
            compression_ratio=3.4,
        )

        self.assertFalse(app._is_low_confidence_segment(segment, "lyrics", "medium"))


class MlxBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.transcribe = mock.Mock(return_value={
            "language": "ja",
            "segments": [{
                "start": 0.0, "end": 1.0, "text": "青い風の中で",
                "no_speech_prob": 0.1, "avg_logprob": -0.2, "compression_ratio": 1.0,
            }],
        })
        self.mx = SimpleNamespace(
            metal=SimpleNamespace(is_available=mock.Mock(return_value=True)),
            gpu="gpu",
            stream=mock.Mock(side_effect=lambda device: nullcontext()),
            synchronize=mock.Mock(),
        )
        modules = mock.patch.dict(app.sys.modules, {
            "mlx": SimpleNamespace(core=self.mx),
            "mlx.core": self.mx,
            "mlx_whisper": SimpleNamespace(transcribe=self.transcribe),
        })
        modules.start()
        self.addCleanup(modules.stop)
        self.model = MlxWhisperModel("small")

    def test_gpu_result_preserves_timing_language_and_confidence(self) -> None:
        segments, info = self.model.transcribe(np.zeros(32000, dtype=np.float32), language="ja", beam_size=5)
        self.assertEqual(info.language, "ja")
        self.assertEqual(info.duration, 2.0)
        self.assertEqual(segments[0].text, "青い風の中で")
        self.assertEqual(segments[0].avg_logprob, -0.2)
        self.assertEqual(segments[0].end, 1.0)
        options = self.transcribe.call_args.kwargs
        self.assertEqual(options["path_or_hf_repo"], "mlx-community/whisper-small-mlx")
        self.assertTrue(options["fp16"])
        self.assertNotIn("beam_size", options)
        self.mx.stream.assert_called_once_with(self.mx.gpu)
        self.mx.synchronize.assert_called_once()

    def test_vad_keeps_original_audio_timestamps(self) -> None:
        with mock.patch("faster_whisper.vad.get_speech_timestamps", return_value=[{"start": 16000, "end": 24000}]):
            self.model.transcribe(np.zeros(32000, dtype=np.float32), vad_filter=True)
        self.assertEqual(self.transcribe.call_args.kwargs["clip_timestamps"], [1.0, 1.5])

    def test_vad_silence_does_not_trigger_gpu_decoding(self) -> None:
        with mock.patch("faster_whisper.vad.get_speech_timestamps", return_value=[]):
            segments, info = self.model.transcribe(np.zeros(32000, dtype=np.float32), vad_filter=True)
        self.assertEqual(segments, [])
        self.assertEqual(info.duration, 2.0)
        self.transcribe.assert_not_called()

    def test_missing_metal_is_not_reported_as_gpu_success(self) -> None:
        self.mx.metal.is_available.return_value = False
        with self.assertRaisesRegex(RuntimeError, "Metal GPU is unavailable"):
            MlxWhisperModel("small")

    def test_cpu_precision_is_rejected_for_mlx(self) -> None:
        with self.assertRaisesRegex(ValueError, "float16 or float32"):
            MlxWhisperModel("small", compute_type="int8")

    def test_mlx_factory_and_health_probe_use_the_shared_pipeline(self) -> None:
        with (
            mock.patch.object(app, "DEFAULT_DEVICE", "mlx"),
            mock.patch.object(app, "DEFAULT_COMPUTE_TYPE", "float16"),
            mock.patch.object(app, "_model", None),
            mock.patch.object(app, "_model_name", None),
            mock.patch.object(app, "_runtime_checked_model", None),
            mock.patch.object(app, "_runtime_error", None),
        ):
            model = app._load_model("small")
            self.assertIsInstance(model, MlxWhisperModel)
            app._probe_runtime(model, "small")
            self.assertEqual(app._beam_size_for_mode("lyrics", "small"), 1)
            self.assertEqual(app._server_config()["backend"], "mlx-whisper")
        self.transcribe.assert_called_once()

    def test_http_uses_mlx_without_changing_the_response_contract(self) -> None:
        with (
            mock.patch.object(app, "DEFAULT_DEVICE", "mlx"),
            mock.patch.object(app, "DEFAULT_VAD", False),
            mock.patch.object(app, "_load_model", return_value=self.model),
            mock.patch.object(app, "_decode_audio", return_value=np.full(32000, 0.1, dtype=np.float32)),
        ):
            response = TestClient(app.app).post(
                "/v1/audio/transcriptions",
                files={"file": ("audio.wav", b"audio", "audio/wav")},
                data={"language": "ja"},
                headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["text"], "青い風の中で")
        self.assertEqual(response.json()["language"], "ja")
        self.assertEqual(response.json()["beam_size_used"], 1)

    def test_websocket_uses_mlx_for_streaming_transcripts(self) -> None:
        with (
            mock.patch.object(app, "DEFAULT_DEVICE", "mlx"),
            mock.patch.object(app, "DEFAULT_VAD", False),
            mock.patch.object(app, "_load_model", return_value=self.model),
            TestClient(app.app).websocket_connect(
                "/v1/audio/stream?language=ja",
                headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"},
            ) as websocket,
        ):
            websocket.send_bytes(np.full(32000, 6000, dtype="<i2").tobytes())
            message = websocket.receive_json()
            self.assertEqual(message["type"], "partial")
            self.assertEqual(message["text"], "青い風の中で")
            self.assertEqual(message["beam_size_used"], 1)


class StreamBufferTests(unittest.TestCase):
    def test_stream_buffer_keeps_only_the_latest_samples(self) -> None:
        chunks: deque[np.ndarray] = deque()
        buffered_samples = 0

        for values in ([0.0, 1.0, 2.0], [3.0, 4.0], [5.0, 6.0]):
            buffered_samples = app._append_stream_samples(
                chunks,
                buffered_samples,
                np.asarray(values, dtype=np.float32),
                max_samples=5,
            )

        self.assertEqual(buffered_samples, 5)
        np.testing.assert_array_equal(
            app._join_stream_samples(chunks),
            np.asarray([2.0, 3.0, 4.0, 5.0, 6.0], dtype=np.float32),
        )


class FakeStreamSocket:
    headers = {"origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"}
    query_params: dict[str, str] = {}

    def __init__(self, expected_results: int) -> None:
        self.incoming: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self.sent: list[dict[str, object]] = []
        self.expected_results = expected_results

    async def accept(self) -> None:
        pass

    async def receive(self) -> dict[str, object]:
        message = await self.incoming.get()
        self.incoming.task_done()
        return message

    async def send_json(self, message: dict[str, object]) -> None:
        self.sent.append(message)
        if len(self.sent) >= self.expected_results:
            self.incoming.put_nowait({"type": "websocket.disconnect"})

    def audio(self, value: int, samples: int = 800) -> None:
        self.incoming.put_nowait({"bytes": np.full(samples, value, dtype="<i2").tobytes()})


class StreamSchedulingTests(unittest.IsolatedAsyncioTestCase):
    async def test_finalization_retains_audio_received_while_inference_is_running(self) -> None:
        socket = FakeStreamSocket(3)
        started = [threading.Event(), threading.Event()]
        release = [threading.Event(), threading.Event()]
        windows: list[np.ndarray] = []

        def infer(_model: object, audio: np.ndarray, *_args: object) -> tuple[str, bool, int]:
            index = len(windows)
            windows.append(audio.copy())
            if index < 2:
                started[index].set()
                self.assertTrue(release[index].wait(3))
            return "same spoken line" if index < 2 else "next spoken line", False, 1

        with (
            mock.patch.object(app, "_load_model", return_value=object()),
            mock.patch.object(app, "_stream_profile_for_model", return_value=(1, 0, 0.01, 100, 0)),
            mock.patch.object(app, "_startup_stream_timing", return_value=(0.01, 100)),
            mock.patch.object(app, "_stream_transcribe_text", side_effect=infer),
        ):
            socket.audio(1)
            task = asyncio.create_task(app.audio_stream(socket))
            try:
                for index in range(2):
                    self.assertTrue(await asyncio.to_thread(started[index].wait, 2))
                    socket.audio(index + 2)
                    await asyncio.wait_for(socket.incoming.join(), 2)
                    release[index].set()
                await asyncio.wait_for(task, 3)
            finally:
                for event in release:
                    event.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertEqual([message["type"] for message in socket.sent], ["partial", "final", "partial"])
        self.assertEqual([window.size for window in windows], [800, 1600, 800])
        self.assertAlmostEqual(float(windows[2][0]), 3 / 32768)

    async def test_slow_inference_reads_latest_bounded_window_without_frame_backlog(self) -> None:
        socket = FakeStreamSocket(2)
        started, release = threading.Event(), threading.Event()
        windows: list[np.ndarray] = []

        def infer(_model: object, audio: np.ndarray, *_args: object) -> tuple[str, bool, int]:
            windows.append(audio.copy())
            if len(windows) == 1:
                started.set()
                self.assertTrue(release.wait(3))
            return f"fresh speech {len(windows)}", False, 1

        with (
            mock.patch.object(app, "_load_model", return_value=object()),
            mock.patch.object(app, "_stream_profile_for_model", return_value=(1, 0, 0.01, 100, 0)),
            mock.patch.object(app, "_startup_stream_timing", return_value=(0.01, 100)),
            mock.patch.object(app, "_stream_transcribe_text", side_effect=infer),
        ):
            socket.audio(1)
            task = asyncio.create_task(app.audio_stream(socket))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                for value in range(2, 42):
                    socket.audio(value)
                await asyncio.wait_for(socket.incoming.join(), 2)
                release.set()
                await asyncio.wait_for(task, 3)
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(len(windows), 2)
        self.assertEqual(windows[1].size, 16000)
        self.assertAlmostEqual(float(windows[1][-1]), 41 / 32768)
        self.assertEqual([result["end_ms"] for result in socket.sent], [50, 2050])

    async def test_reset_drops_in_flight_result_and_disconnect_drops_pending_work(self) -> None:
        for disconnect in (False, True):
            with self.subTest(disconnect=disconnect):
                socket = FakeStreamSocket(1)
                started, release = threading.Event(), threading.Event()
                windows: list[np.ndarray] = []

                def infer(_model: object, audio: np.ndarray, *_args: object) -> tuple[str, bool, int]:
                    windows.append(audio.copy())
                    if len(windows) == 1:
                        started.set()
                        self.assertTrue(release.wait(3))
                    return f"fresh speech {len(windows)}", False, 1

                with (
                    mock.patch.object(app, "_load_model", return_value=object()),
                    mock.patch.object(app, "_stream_profile_for_model", return_value=(1, 0, 0.01, 100, 0)),
                    mock.patch.object(app, "_startup_stream_timing", return_value=(0.01, 100)),
                    mock.patch.object(app, "_stream_transcribe_text", side_effect=infer),
                ):
                    socket.audio(1)
                    task = asyncio.create_task(app.audio_stream(socket))
                    try:
                        self.assertTrue(await asyncio.to_thread(started.wait, 2))
                        socket.incoming.put_nowait({"type": "websocket.disconnect"} if disconnect else {"text": "reset"})
                        if not disconnect:
                            socket.audio(9)
                        await asyncio.wait_for(socket.incoming.join(), 2)
                        release.set()
                        await asyncio.wait_for(task, 3)
                    finally:
                        release.set()
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                if disconnect:
                    self.assertEqual(socket.sent, [])
                    self.assertEqual(len(windows), 1)
                else:
                    self.assertEqual(len(socket.sent), 1)
                    self.assertEqual(socket.sent[0]["text"], "fresh speech 2")
                    self.assertEqual(socket.sent[0]["end_ms"], 50)
                    self.assertAlmostEqual(float(windows[1][0]), 9 / 32768)


if __name__ == "__main__":
    unittest.main()
