# LM Studio 설정 값

YouTube Live Translator에서 로컬 번역 모델로 LM Studio를 사용할 때의 권장 설정입니다. 이 문서는 RTX 5070 12 GB VRAM, 시스템 메모리 64 GB 환경에서 테스트한 `Gemma4-E4B-Instruct-Pure-GGUF`를 기준으로 작성했습니다.

이 모델은 **번역 전용 LLM**입니다. YouTube 음성 인식(STT)은 LM Studio가 아니라 이 프로젝트의 faster-whisper 로컬 서버를 사용하는 구성을 권장합니다.

## 테스트 모델

| 항목 | 값 |
| --- | --- |
| 모델 | `Gemma4-E4B-Instruct-Pure-GGUF` |
| 용도 | 공식 자막 및 STT 원문의 한국어 번역 |
| 권장 제공자 | 확장 프로그램의 `LM Studio` |
| 권장 STT | faster-whisper 로컬 WebSocket STT |
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
| Temperature | `0.2` | 자연스러움과 원문 충실도 사이의 안정적인 기본값입니다. |
| Top P | `0.9` | 지나친 직역과 무작위 표현을 모두 피하는 기본값입니다. |
| 최대 출력 길이 | 제한 해제 또는 기본값 | 확장 프로그램이 요청마다 자막 길이에 맞는 출력 토큰 수를 직접 지정합니다. |
| Stop strings | 비워 두기 | 확장 프로그램과 모델의 기본 chat template가 출력을 정상 종료하게 둡니다. |
| 추론/Thinking | 끄기 또는 비추론 모델 사용 | 자막에는 최종 번역문만 필요하므로 지연과 빈 응답 위험을 줄입니다. |

확장 프로그램은 OpenAI 호환 요청에서 Inference 값을 직접 보냅니다. 따라서 실제 요청 기준 값은 콘텐츠 모드에 따라 자동 조절됩니다.

| 콘텐츠 모드 | Temperature | Top P | 의도 |
| --- | ---: | ---: | --- |
| 일반 영상 | `0.20` | `0.90` | 자연스럽고 읽기 쉬운 대사 자막 |
| 라이브/잡음 | `0.18` | `0.90` | 빠르고 안정적인 구어체 자막 |
| 노래/가사 | `0.28` | `0.92` | 정서와 이미지를 살린 가사 표현 |

공식 자막 선번역처럼 여러 줄을 한 번에 처리하는 요청은 일관성을 높이기 위해 위 값보다 더 보수적으로 조절됩니다. 따라서 LM Studio UI에서 영상마다 온도를 다시 바꿀 필요가 없습니다.

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
| 인증 방식 | `none` |
| LM Studio STT 먼저 시도 | 끄기 |

설정 후 `LM Studio 번역 테스트`를 실행해 최종 번역문만 응답하는지 확인합니다. 실제 YouTube 음성 자막은 `Whisper-compatible` STT와 faster-whisper 로컬 서버를 선택하는 구성이 가장 안정적입니다.

## 문제 해결

- 빈 응답, reasoning만 출력, 토큰 한도 오류: 비추론 Instruct 모델을 사용하고 `추론/Thinking`을 끕니다.
- `failed to fetch` 또는 연결 실패: Local Server가 Running인지, Base URL이 `/v1`으로 끝나는지 확인합니다.
- 번역이 느림: 모델 재로딩 여부와 GPU offload를 먼저 확인합니다. Context length를 과도하게 높이지 마세요.
- 번역이 지나치게 직역됨: 시스템 프롬프트를 길게 추가하지 말고 확장 프로그램의 `콘텐츠 모드`를 `노래/가사` 또는 `라이브/잡음`으로 맞춥니다.
