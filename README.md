# YouTube Live Translator

YouTube 실시간 방송과 녹화 영상 위에 번역 자막을 표시하는 Manifest V3 Chrome 확장 프로그램입니다.

제작자가 제공한 YouTube 공식 자막을 먼저 사용하고, 자막이 없을 때만 탭 오디오 STT로 전환합니다. 번역은 OpenAI 호환 AI API, LM Studio 또는 Ollama로 처리할 수 있으며, 포함된 faster-whisper 서버로 로컬 GPU STT도 사용할 수 있습니다.

> API 키는 확장 프로그램 설정 화면에서 입력하며 `chrome.storage.local`에만 저장됩니다. API 키는 이 저장소나 빌드된 확장 프로그램 소스에 포함되지 않습니다.

## 주요 기능

- YouTube 실시간 방송과 녹화 영상의 번역 자막 오버레이
- YouTube timed text, 전체 자막 선번역, IndexedDB 캐시를 활용하는 공식 자막 우선 처리
- 공식 자막이 없을 때 `chrome.tabCapture`, offscreen WebAudio, 로컬 WebSocket STT를 이용하는 음성 인식 대체 경로
- 켜기/끄기, 원문 표시, 노래 모드, 글자 크기, 위치, 재시도, 설정 열기를 제공하는 YouTube 미니 컨트롤
- 번역 제공자:
  - OpenAI 호환 AI API
  - OpenAI 호환 AI API 설정을 통한 Mindlogic Gateway 및 멀티 모델 게이트웨이
  - Ollama
  - LM Studio
- STT 제공자:
  - LM Studio 우선 사용 후 Whisper 호환 제공자로 대체
  - Whisper 호환 로컬/클라우드 엔드포인트
  - OpenAI 호환 오디오 전사 엔드포인트

## 빌드 및 설치

```bash
npm install
npm run build
```

Chrome에서 개발자 모드를 켠 뒤 `chrome://extensions`의 `압축해제된 확장 프로그램을 로드합니다`로 생성된 `dist` 폴더를 선택합니다.

## 로컬 AI 기본값

- Ollama: `http://localhost:11434`
- faster-whisper GPU STT: `http://127.0.0.1:8765/v1/audio/transcriptions`
- faster-whisper 스트리밍 STT: `ws://127.0.0.1:8765/v1/audio/stream`
- LM Studio: 로컬 LLM 번역을 선택한 경우 `http://127.0.0.1:1234/v1`

확장 프로그램의 옵션 페이지에서 제공자를 선택하고, API 키와 언어 코드를 입력하며, 자막 오버레이를 조절할 수 있습니다.

기본 권장 조합은 로컬 faster-whisper STT와 AI 번역 API입니다. 텍스트 번역 제공자로 LM Studio를 직접 선택한 경우에만 `LM Studio 연결 확인`을 사용하세요.

`Gemma4-E4B-Instruct-Pure-GGUF` 기준의 모델 Load, Inference, Local Server, 확장 프로그램 연결 값은 [LM Studio 설정 값](docs/lm-studio-settings.md)에서 확인할 수 있습니다.

## 공식 자막 선번역

YouTube timed text를 사용할 수 있으면 확장 프로그램은 오디오 캡처를 시작하지 않습니다. 전체 timed text 트랙을 받아 현재 재생 구간 주변을 먼저 번역하고, 나머지 영상은 백그라운드에서 계속 번역합니다.

번역 자막 캐시는 영상 ID, 자막 해시, 목표 언어, 제공자/모델, 콘텐츠 모드를 기준으로 IndexedDB에 저장됩니다. 같은 영상을 다시 열면 캐시된 번역을 즉시 표시할 수 있습니다.

음악 영상의 가사형 번역에는 옵션 페이지의 `콘텐츠 모드` 또는 YouTube 미니 컨트롤의 `♪` 버튼을 사용하세요.

## API 키 기반 음성 자막

YouTube 영상에 내장 자막이 없을 때 번역 API 키만으로는 충분하지 않습니다. 확장 프로그램이 탭 오디오를 STT 엔드포인트로 전송해 원문을 인식해야 합니다.

옵션 페이지에서 다음 순서로 설정합니다.

- `API 키로 음성 자막 프리셋` 클릭
- `AI API` 키 또는 `API STT` 키 입력
- `API STT + 번역 테스트`를 클릭해 STT 연결과 AI 번역을 함께 확인
- 저장한 뒤 YouTube에서 `자막 우선 + 음성` 또는 `음성만` 선택

전사 엔드포인트만 확인하려면 `API STT 연결 테스트`, 텍스트 번역만 확인하려면 `테스트`를 사용할 수 있습니다.

API STT 기본값:

- Base URL: `https://api.openai.com/v1`
- Endpoint: `/audio/transcriptions`
- Model: `gpt-4o-mini-transcribe`
- 인증: `Authorization: Bearer`

`API STT` 키가 비어 있으면 확장 프로그램은 `AI API` 키를 STT와 번역 모두에 사용합니다. `AI API` 키가 비어 있지만 `API STT` 키가 있으면 OpenAI 호환 번역에도 같은 키를 사용할 수 있습니다.

## 멀티 모델 AI API

한 API 키로 여러 LLM 회사의 모델을 호출할 수 있다면 옵션 페이지의 `AI API` 섹션을 사용하세요.

- `API 프리셋`에서 `Mindlogic Gateway` 또는 `직접 입력` 선택
- 공용 API 키 입력
- `모델 목록 불러오기` 클릭
- `불러온 모델`에서 GPT, Claude, Gemini, xAI, Perplexity 또는 오픈 모델 ID 선택
- 저장 후 `번역 테스트` 실행

확장 프로그램은 선택한 모델을 `AI API > 모델`에 저장하고, 기존의 OpenAI 호환 `/chat/completions` 또는 `/responses` 경로로 번역 요청을 보냅니다.

## 로컬 GPU STT + 번역 API

이 프로젝트에는 자막이 없을 때 사용할 수 있는 OpenAI 호환 및 WebSocket faster-whisper STT 서버가 포함돼 있습니다.

`uv`로 Python 3.11 가상환경을 설정합니다.

```bash
npm run stt:setup
```

STT 서버를 시작합니다.

```bash
npm run stt:start
```

YouTube 번역을 사용하는 동안 이 터미널을 열어 두세요. `stt:start`는 로컬 서버를 포그라운드에서 실행하므로 Chrome이 `http://127.0.0.1:8765`에 계속 연결할 수 있습니다.

상태 확인:

```bash
npm run stt:health
```

기본 STT 설정은 RTX 5070 12 GB VRAM에서 YouTube 재생을 부드럽게 유지하는 데 초점을 둡니다.

- 모델: `medium`
- 장치: `cuda`
- 연산 형식: `int8_float16`
- 스트리밍 엔드포인트: `ws://127.0.0.1:8765/v1/audio/stream`
- HTTP 대체 청크: `8000ms`
- 엔드포인트: `http://127.0.0.1:8765/v1/audio/transcriptions`

옵션 페이지에서 로컬 STT 모델을 선택할 수 있습니다. 기본값인 `medium`은 특히 노래에서 더 나은 인식률을 목표로 합니다. 재생이 불안정하면 `small` 또는 `base`를 선택하고 저장한 뒤 `STT + 번역 API 전체 테스트`를 실행하세요.

로컬 STT 서버의 기본 모델도 `medium`입니다. 요청된 모델을 동적으로 불러올 수 있으므로 옵션 페이지에서 `small` 또는 `base`를 선택하면 해당 faster-whisper 모델이 로컬에서 사용 가능한 경우 자동으로 적용됩니다.

노래에는 `노래 STT 프리셋`을 사용하거나 `콘텐츠 모드`를 `노래/가사`로 설정하세요. 확장 프로그램이 로컬 STT 서버에 `content_mode=lyrics`를 전송하면 VAD를 비활성화하고, 인식 창을 12초로 늘리며, beam size를 높여 가창 음성 인식을 개선합니다.

옵션 페이지에서 다음을 설정합니다.

- `AI API` 키 입력
- `로컬 STT + 번역 API 프리셋` 클릭
- `faster-whisper 연결 확인` 클릭
- `STT + 번역 API 전체 테스트`로 로컬 STT와 AI API 번역을 함께 확인

로컬 프리셋은 `로컬 STT WebSocket 스트리밍 사용`을 활성화합니다. WebSocket 스트림에 실패하면 확장 프로그램은 기존 HTTP 전사 청크 방식으로 자동 전환하고, 설정된 경우 API STT로 한 번 더 대체합니다.

기존 백그라운드 실행 방식을 의도적으로 사용하려면 `npm run stt:daemon`을 실행할 수 있지만, 안정적인 기본 경로는 포그라운드의 `npm run stt:start`입니다.

`/health`가 CUDA 오류를 보고하면 faster-whisper/CTranslate2에 필요한 NVIDIA CUDA/cuDNN 런타임을 설치한 뒤 `npm run stt:start`를 다시 실행하세요.

`/health`가 모델 파일을 로컬에서 찾을 수 없고 Hub에서 다운로드할 수 없다고 표시하면, 일반 네트워크 환경의 터미널에서 `npm run stt:start`를 한 번 실행해 선택한 모델을 캐시하세요. 또는 `YT_TRANSLATOR_STT_MODEL`에 로컬 faster-whisper 모델 디렉터리를 설정할 수 있습니다.

## Mindlogic Gateway

옵션 페이지 AI API 섹션의 `Mindlogic Gateway 프리셋` 버튼을 사용하세요.

- Base URL: `https://factchat-cloud.mindlogic.ai/v1/gateway`
- 기본 모델: `claude-sonnet-4-6`
- 지원 인증 헤더:
  - `Authorization: Bearer YOUR_API_KEY`
  - `x-api-key: YOUR_API_KEY`

저장하기 전에 사용하는 API 키 방식에 맞는 인증 헤더 모드를 선택하세요. 기본 프리셋은 OpenAI 형식의 Bearer 헤더를 사용합니다.

## 참고 사항

- LM Studio 텍스트 번역은 OpenAI 호환 `/chat/completions` 또는 `/responses`를 사용합니다.
- 로컬 실시간 음성 번역의 기본 경로는 faster-whisper STT와 AI API 텍스트 번역입니다. LM Studio 번역은 선택 가능한 로컬 LLM 모드로 계속 사용할 수 있습니다.
