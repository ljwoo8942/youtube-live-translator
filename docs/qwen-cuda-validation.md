# Qwen3-ASR Windows CUDA 검증

검증 기간: 2026-11-13~14 (한국 시간). 이 기록은 해당 환경에서의 실행 확인이며 다른 GPU나 장시간 라이브 성능을 보장하는 벤치마크가 아닙니다.

## 환경과 설치

| 항목 | 확인값 |
| --- | --- |
| GPU | NVIDIA GeForce RTX 5070, 12,227 MiB |
| 드라이버 | 621.14 |
| PyTorch | 2.15.0+cu132 |
| PyTorch CUDA | 13.2 |
| GPU 아키텍처 | sm_120 / compute capability 12.0 |
| Python | 3.11.15, 프로젝트 `.venv-stt` |

기존 CPU 전용 PyTorch를 제거하고 공식 CUDA 배포판으로 교체했습니다. 설치된 `torch` 배포판은 `2.15.0+cu132` 하나이며 `torch.cuda.is_available()`은 `True`입니다. `npm run stt:setup`을 다시 실행해도 CUDA 버전이 유지되고 FP16 행렬 연산 검사가 통과했습니다. `uv pip check`도 통과했습니다.

## 실제 모델 검증

| 모델 | 실행 장치·정밀도 | HTTP / WebSocket 실제 생성 | 측정한 PyTorch 최대 할당량 |
| --- | --- | --- | ---: |
| Qwen3-ASR 0.6B | CUDA / FP16 | 모두 통과 | 1,533.2 MiB |
| Qwen3-ASR 1.7B | CUDA / FP16 | 모두 통과 | 3,926.6 MiB |

메모리는 2초 합성 신호로 생성 경로를 검사할 때의 `torch.cuda.max_memory_allocated()` 값입니다. 모델 가중치는 포함하지만 PyTorch 예약 캐시·CUDA 컨텍스트·다른 프로세스·번역 LLM·영상 재생의 메모리는 포함하지 않습니다. 전체 GPU 사용량이나 긴 음성 창의 메모리 상한이 아닙니다.

검사에서는 모델 파라미터, 처리된 입력 텐서와 생성 출력이 실제 CUDA 장치에 있는지 확인합니다. 상태 응답만 GPU라고 표시되거나 CPU 대체 실행이 일어나면 GPU 검사는 실패합니다.

별도로 Windows 음성 합성으로 다음 영어 문장을 생성해 HTTP와 WebSocket에 전송했습니다. 두 모델 모두 CUDA/FP16으로 아래 문장을 인식했습니다.

> The quick brown fox jumps over the lazy dog. Please turn on the live subtitles.

기존 Whisper `base`도 `faster-whisper`, CUDA/FP16 상태 확인과 짧은 실제 추론을 통과했습니다.

## 재현과 범위

설치·모델 준비 후 실행할 GPU 검사 명령은 [로컬 STT 안내](../local_stt/README.md#cuda-acceptance-test)에 있습니다. 기존 CPU·Apple Silicon 동작은 플랫폼 회귀 검사와 GitHub CI로 별도 확인합니다.

이번 검증은 두 Qwen 모델의 GPU 사용과 서버 전송 경로를 확인합니다. 일본어·노래 인식 정확도, 장시간 YouTube 재생, 번역 LLM과의 동시 GPU 부하는 측정하지 않았습니다.
