# LM Studio 설정 값

**한국어** · [English](lm-studio-settings.en.md) · [日本語](lm-studio-settings.ja.md)

YouTube Live Translator에서 로컬 번역 모델로 LM Studio를 사용할 때의 권장 설정입니다. 이 문서는 RTX 5070 12 GB VRAM, 시스템 메모리 64 GB 환경에서 테스트한 `Gemma4-E4B-Instruct-Pure-GGUF`를 기준으로 작성했습니다.

확장 프로그램에서는 Gemma가 자막을 번역하고, 로컬 Whisper 또는 Qwen3-ASR가 탭 음성을 인식합니다. 전체 지원 범위와 설치 방법은 프로젝트 개요에서 확인할 수 있습니다. [README](../README.md)

## 테스트 모델

| 항목 | 값 |
| --- | --- |
| 모델 | `Gemma4-E4B-Instruct-Pure-GGUF` |
| 검증 환경의 모델 ID | `gemma4-e4b-instruct-pure` |
| 용도 | 공식 자막 및 STT 원문의 한국어 번역 |
| 권장 제공자 | 확장 프로그램의 `LM Studio` |
| 테스트한 노래 STT | 로컬 Qwen3-ASR 1.7B (Windows CUDA/FP16) |
| 권장 엔드포인트 | `/chat/completions` |

LM Studio의 모델 ID는 파일명으로 직접 추측하지 말고, 모델을 로드한 뒤 확장 프로그램 옵션의 `LM Studio > 모델 목록 불러오기`에서 표시되는 값을 그대로 선택합니다.

## 모델 Load 설정

| 설정 | 권장 값 | 이유 |
| --- | --- | --- |
| GPU offload | 가능한 모든 레이어를 GPU에 배치 | RTX 5070에서 번역 지연을 줄입니다. |
| Context length | `4096` | 현재 자막, 주변 문맥, 번역 결과에 충분하면서 VRAM 사용량을 안정적으로 유지합니다. |
| Flash Attention | 사용 가능하면 켜기 | 긴 자막 문맥에서 메모리 사용량과 처리 시간을 줄일 수 있습니다. |
| CPU threads | Auto 권장 | GPU 번역에서는 CPU thread 수보다 GPU offload가 더 중요합니다. |
| 모델 유지 | 모델을 계속 로드한 상태로 유지 | 영상 재생 중 재로딩 지연을 막습니다. |

`Context length`를 `8192` 이상으로 높여도 이 확장 프로그램의 일반적인 번역 품질은 크게 좋아지지 않습니다. VRAM 여유가 줄거나 영상 재생이 불안정해지면 먼저 `4096`으로 낮추세요.

## Inference 설정

| 설정 | 권장 값 | 설명 |
| --- | --- | --- |
| 최대 출력 길이 | 제한 해제 또는 기본값 | 확장 프로그램이 요청마다 자막 길이에 맞는 출력 토큰 수를 직접 지정합니다. |
| Stop strings | 비워 두기 | 확장 프로그램과 모델의 기본 chat template가 출력을 정상 종료하게 둡니다. |
| 추론/Thinking | 끄기 | 확장 프로그램은 로컬 LM Studio의 Gemma 4 `/chat/completions` 번역 요청에 `reasoning_effort: "none"`을 보냅니다. |

확장 프로그램이 로컬 LM Studio의 자막 번역 요청에 아래 값을 지정합니다.

| 콘텐츠 모드 | Temperature | Top P |
| --- | ---: | ---: |
| 자동·일반 영상 | `0.14` | `0.86` |
| 라이브/잡음 | `0.12` | `0.86` |
| 노래/가사 | `0.16` | `0.88` |

LM Studio에서 여러 줄을 번역할 때도 확장 프로그램은 한 줄씩 요청합니다.

## 시스템 프롬프트

시스템 프롬프트는 비워 두어도 됩니다. 확장 프로그램이 번역 요청마다 가사, 라이브, 혼합 언어, 환각 방지 규칙을 담은 시스템 지침을 이미 전송합니다.

LM Studio에서 reasoning, 설명문, `번역:` 같은 불필요한 출력을 억제하고 싶다면 아래의 짧은 프롬프트만 사용하세요.

```text
You are a subtitle translation engine.
Follow the system instructions provided by the application as the highest priority.
Output only the final translated subtitle.
Do not output reasoning, explanations, labels, source text, quotation marks, or Markdown.
```

가사 번역, 일본어 표현, 영어 훅, 환각 방지 같은 긴 지침을 LM Studio에도 중복 입력하지 마세요. 확장 프로그램의 콘텐츠 모드별 지침과 충돌하거나 요청 토큰과 처리 시간만 늘릴 수 있습니다.

## Local Server 설정

LM Studio의 `Developer > Local Server`에서 서버를 시작한 뒤 다음 값을 사용합니다.

| 항목 | 값 |
| --- | --- |
| 서버 상태 | Running |
| Base URL | `http://127.0.0.1:1234/v1` |
| API 형식 | OpenAI-compatible |
| 권장 엔드포인트 | `/chat/completions` |
| API 토큰 | 인증을 켜지 않았다면 비워 두기 |
| 인증 방식 | 인증을 켜지 않았다면 `none` |

로컬 서버 인증을 LM Studio에서 별도로 켠 경우에만 같은 토큰을 확장 프로그램의 `LM Studio > API 토큰`에 입력하고 인증 방식을 맞춥니다.

## 확장 프로그램 설정

옵션 페이지의 `LM Studio` 섹션에서 아래처럼 설정합니다.

| 항목 | 값 |
| --- | --- |
| 번역 제공자 | `LM Studio` |
| Base URL | `http://127.0.0.1:1234/v1` |
| 번역 모델 | `모델 목록 불러오기`에서 선택한 로드 모델 ID |
| 엔드포인트 | `/chat/completions` |
| 인증 방식 | 로컬 서버 인증을 끈 경우 `인증 헤더 없음` |
| LM Studio STT 먼저 시도 | 끄기 |

설정 후 `LM Studio 번역 테스트`를 실행해 최종 번역문이 반환되는지 확인하고 `설정 저장`을 누르세요.

## 로컬 STT 스트리밍으로 첫 번역 앞당기기

1. **전체 설정**에서 `로컬 STT (Whisper / Qwen)`과 사용할 모델을 선택합니다.
2. **로컬 STT WebSocket 스트리밍 사용**을 켜고 **스트리밍 STT WebSocket**에 `ws://127.0.0.1:8765/v1/audio/stream`을 설정한 뒤 저장합니다.
3. Gemma가 로드된 LM Studio 서버와 로컬 STT 서버를 실행합니다. 영상 탭의 팝업에서 **음성 시작**을 누릅니다. [로컬 STT 서버 설정](../local_stt/README.md)

충분한 길이의 중간 인식 결과가 들어오면 임시 번역을 표시하고 인식이 확정되면 자막을 갱신합니다. 원문을 함께 보려면 **오버레이**의 **원문도 표시**를 켭니다. WebSocket 연결이 실패하면 HTTP 전사로 전환합니다. 노래에서 14초 설정을 사용하려면 아래 표대로 스트리밍을 끕니다.

Windows의 RTX 5070에서 모델을 미리 로드하고 합성 영어 음성을 실시간 속도로 보냈습니다. 첫 음성 입력부터 로컬 `gemma4-e4b-instruct-pure` 번역 결과가 생성될 때까지 측정했습니다.

| 음성 인식 모델 | 첫 임시 번역 | 첫 확정 번역 |
| --- | ---: | ---: |
| Qwen3-ASR 1.7B | 1.43초 | 3.78초 |
| Whisper base | 1.27초 | 3.59초 |

## 빠른 일본어 노래 설정

`uv`를 설치한 뒤 프로젝트 폴더에서 로컬 STT 환경과 Qwen 모델을 준비합니다.

```bash
npm run stt:setup
npm run stt:qwen:download
```

「快晴」 커버의 1:00–1:30 구간에서 아래 조합으로 가사를 인식하고 Gemma로 번역했습니다. 첫 자막은 재생 약 13초 뒤에 표시됐습니다. [검증 영상](https://www.youtube.com/watch?v=YA7QcvdHk70&t=60s)

| 확장 프로그램 설정 | 값 |
| --- | --- |
| 입력 방식 | `음성만` |
| 콘텐츠 모드 | `노래/가사` |
| 음성 언어 | `일본어` |
| STT provider | `로컬 STT (Whisper / Qwen)` |
| 로컬 STT 모델 | `Qwen3-ASR 1.7B` |
| 로컬 STT Base URL | `http://127.0.0.1:8765/v1` |
| 로컬 STT 엔드포인트 | `/audio/transcriptions` |
| 로컬 STT WebSocket 스트리밍 사용 | 끄기 |
| 음성 청크(ms) | `14000` |

이 조합은 음성을 14초씩 모아 HTTP로 전사합니다. 선택한 음성 언어는 WebSocket과 HTTP 전사에 모두 적용됩니다. 여러 언어가 섞인 노래는 `자동 감지`를 사용할 수 있습니다.

팝업에서 서버를 시작하려면 Chrome 확장 관리 화면(`chrome://extensions`)에서 설치된 확장의 ID를 확인하고 `npm run stt:native:install -- YOUR_EXTENSION_ID`에서 `YOUR_EXTENSION_ID`를 바꿔 한 번 실행하세요. 설정을 저장한 뒤 영상 탭의 팝업에서 `로컬 STT 시작`을 누르고 서버가 준비되면 `음성 시작`을 누릅니다.

## 문제 해결

- 번역문이 비거나 추론만 표시되면 확장을 최신 빌드로 새로고침하고 LM Studio 모델 ID와 `/chat/completions` 설정을 확인하세요.
- 연결에 실패하면 Local Server가 실행 중인지, Base URL이 `/v1`으로 끝나는지 확인하세요.
- 번역이 느리면 모델 재로딩 여부와 GPU offload를 확인하세요.
- 노래나 라이브의 번역이 지나치게 직역되면 `콘텐츠 모드`를 `노래/가사` 또는 `라이브/잡음`으로 맞추세요.
