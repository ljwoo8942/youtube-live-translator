from __future__ import annotations

import unittest
from collections import deque
from types import SimpleNamespace
from unittest import mock

import numpy as np
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from local_stt import app


class FakeWhisperModel:
    def __init__(self) -> None:
        self.kwargs: dict[str, object] = {}

    def transcribe(self, _audio: object, **kwargs: object) -> tuple[list[object], SimpleNamespace]:
        self.kwargs = kwargs
        return [], SimpleNamespace(language=kwargs.get("language"))


class PlatformConfigurationTests(unittest.TestCase):
    def test_macos_uses_cpu_without_querying_cuda(self) -> None:
        with (
            mock.patch.object(app.sys, "platform", "darwin"),
            mock.patch("ctranslate2.get_cuda_device_count") as cuda_count,
        ):
            self.assertEqual(app._default_device(), "cpu")
            self.assertEqual(app._candidate_cuda_dll_dirs(), [])
        cuda_count.assert_not_called()

    def test_cuda_is_used_only_when_available(self) -> None:
        with mock.patch.object(app.sys, "platform", "win32"):
            with mock.patch("ctranslate2.get_cuda_device_count", return_value=1):
                self.assertEqual(app._default_device(), "cuda")
            with mock.patch("ctranslate2.get_cuda_device_count", return_value=0):
                self.assertEqual(app._default_device(), "cpu")


class ModeConfigurationTests(unittest.TestCase):
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
        self.assertGreaterEqual(app.LYRICS_STREAM_OVERLAP_SECONDS, 3.0)

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
        self.assertGreater(small_profile[4], medium_profile[4])
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
        self.assertGreaterEqual(base_profile[4], 2.6)
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


if __name__ == "__main__":
    unittest.main()
