# YouTube Live Translator

YouTube 실시간 방송과 녹화 영상 위에 번역 자막을 표시하는 Manifest V3 Chrome 확장 프로그램입니다.

제작자가 제공한 YouTube 공식 자막을 먼저 사용하고, 자막이 없을 때만 탭 오디오 STT로 전환합니다. 번역은 OpenAI 호환 AI API, LM Studio 또는 Ollama로 처리할 수 있으며, 로컬 STT는 Apple Silicon Mac의 MLX GPU와 Windows·Linux의 faster-whisper CUDA/CPU를 지원합니다.

> API 키는 확장 프로그램 설정 화면에서 입력하며 `chrome.storage.local`에만 저장됩니다. API 키는 이 저장소나 빌드된 확장 프로그램 소스에 포함되지 않습니다.

## 주요 기능

- YouTube 실시간 방송과 녹화 영상의 번역 자막 오버레이
- YouTube timed text, 전체 자막 선번역, IndexedDB 캐시를 활용하는 공식 자막 우선 처리
- 공식 자막이 없을 때 `chrome.tabCapture`, offscreen WebAudio, 로컬 WebSocket STT를 이용하는 음성 인식 대체 경로
- 제목·설명의 곡 후보를 LRCLIB에서 한 번 검색하고 STT와 연속 일치할 때만 가사를 채택하는 노래 보조
- 사용자가 입력한 원문·교정 번역과 커버별 차이를 로컬에 저장하는 곡 교정 사전
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

Node.js 22.18 이상(권장 24)과 Chrome 116 이상이 필요합니다. 로컬 STT를 사용하려면 [uv](https://docs.astral.sh/uv/getting-started/installation/)도 설치하세요. Windows PowerShell과 macOS 터미널에서 같은 npm 명령을 사용합니다.

```bash
npm ci
npm run build
```

Chrome에서 개발자 모드를 켠 뒤 `chrome://extensions`의 `압축해제된 확장 프로그램을 로드합니다`로 생성된 `dist` 폴더를 선택합니다.

## macOS에서 처음 실행

Apple Silicon(M 시리즈)과 Intel Mac에서 다음 순서로 실행합니다.

```bash
git clone https://github.com/ljwoo8942/youtube-live-translator.git
cd youtube-live-translator
npm ci
npm run build
npm run stt:setup
npm run stt:start
```

위 터미널은 열어 두고, Chrome에 `dist` 폴더를 로드하세요. 옵션 페이지에서 AI 번역 API 키를 입력한 뒤 `로컬 STT 연결 확인`과 `STT + 번역 API 전체 테스트`를 실행합니다. 새 터미널에서 `npm run stt:health`로 서버 상태를 확인할 수도 있습니다.

M 시리즈 Mac에서는 [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper)가 Metal GPU를 사용하도록 자동 선택됩니다. macOS 14 이상과 Apple Silicon용 arm64 Python이 필요하며, `npm run stt:setup`이 해당 Mac에서만 MLX를 설치합니다. Intel Mac 또는 Rosetta의 x86_64 Python에서는 faster-whisper CPU/int8을 사용합니다. LM Studio/Ollama 번역은 별도로 선택할 수 있습니다.

이미 설치한 Mac은 `git pull`, `npm run stt:setup`을 실행하고 기존 STT 서버를 종료한 뒤 다시 시작하세요. 최초 인식 또는 상태 확인 시 MLX 형식의 모델을 내려받습니다. `npm run stt:health` 응답의 `backend`가 `mlx-whisper`, `device`가 `mlx`, `compute_type`이 `float16`, `ok`가 `true`이면 실제 GPU 초기화와 짧은 추론 검사를 통과한 것입니다.

직접 지정하려면 `YT_TRANSLATOR_STT_DEVICE=mlx npm run stt:start`를 사용하세요. CPU로 실행할 때는 `YT_TRANSLATOR_STT_DEVICE=cpu YT_TRANSLATOR_STT_COMPUTE_TYPE=int8 npm run stt:start`를 사용합니다. 모델을 바꾸려면 서버 시작 전에 `YT_TRANSLATOR_STT_MODEL=base` 등으로 지정하고 옵션 페이지의 `로컬 STT 연결 확인`으로 서버 모델을 적용하세요.

가상환경 `.venv-stt`는 운영체제와 CPU 구조에 종속됩니다. Windows 가상환경을 Mac으로 복사하지 말고 Mac에서 `npm run stt:setup`을 실행하세요. 설정·곡 교정 사전은 각 Chrome 프로필에 저장되므로, 곡 교정 사전은 JSON 내보내기/가져오기로 옮길 수 있습니다.

## 로컬 AI 기본값

- Ollama: `http://localhost:11434`
- 로컬 Whisper STT: `http://127.0.0.1:8765/v1/audio/transcriptions`
- 로컬 Whisper 스트리밍 STT: `ws://127.0.0.1:8765/v1/audio/stream`
- LM Studio: 로컬 LLM 번역을 선택한 경우 `http://127.0.0.1:1234/v1`

확장 프로그램의 옵션 페이지에서 제공자를 선택하고, API 키와 언어 코드를 입력하며, 자막 오버레이를 조절할 수 있습니다.

기본 권장 조합은 로컬 Whisper STT와 AI 번역 API입니다. 텍스트 번역 제공자로 LM Studio를 직접 선택한 경우에만 `LM Studio 연결 확인`을 사용하세요.

`Gemma4-E4B-Instruct-Pure-GGUF` 기준의 모델 Load, Inference, Local Server, 확장 프로그램 연결 값은 [LM Studio 설정 값](docs/lm-studio-settings.md)에서 확인할 수 있습니다.

## 공식 자막 선번역

YouTube timed text를 사용할 수 있으면 확장 프로그램은 오디오 캡처를 시작하지 않습니다. 전체 timed text 트랙을 받아 현재 재생 구간 주변을 먼저 번역하고, 나머지 영상은 백그라운드에서 계속 번역합니다.

번역 자막 캐시는 영상 ID, 자막 해시, 목표 언어, 제공자/모델, 콘텐츠 모드를 기준으로 IndexedDB에 저장됩니다. 같은 영상을 다시 열면 캐시된 번역을 즉시 표시할 수 있습니다.

음악 영상의 가사형 번역에는 옵션 페이지의 `콘텐츠 모드` 또는 YouTube 미니 컨트롤의 `♪` 버튼을 사용하세요.

## 곡 교정 사전

팝업이나 옵션 페이지의 `곡 교정 사전`을 누르면 독립된 관리 페이지가 열립니다. 곡 이름, 가수/작곡가, YouTube 영상 ID, 원문 가사와 교정 번역을 줄 단위 또는 일괄 입력으로 저장할 수 있습니다.

공식 자막은 저장 원문과 일치하는 줄을 즉시 교정문으로 표시합니다. 음성 STT는 같은 곡의 원문이 두 줄 연속 일치한 뒤 교정문을 사용하며, 불일치가 이어지면 기존 실시간 번역으로 돌아갑니다. 커버 프로필에는 영상 ID, 커버 가수와 개사된 줄만 별도로 저장할 수 있습니다.

교정 사전은 IndexedDB에 로컬로 저장되며 서버로 전송되지 않습니다. JSON 백업과 복원, LRC/SRT 원문 가져오기를 지원합니다.

## 자막 없는 노래 가사 보조

`자막 없는 노래에서 제목·설명의 가사 후보로 STT 보정`을 켜면 영상 제목과 설명의 세트리스트 후보를 LRCLIB에서 검색합니다. 검색 결과는 STT와 두 줄 연속 일치한 뒤에만 사용하며, 전체 가사는 저장하지 않고 현재 영상 세션의 메모리에만 유지합니다.

라이브 모드에서는 가사 불일치가 두 구간 연속 발생하면 대화 번역으로 돌아가고, 같은 곡이나 다음 곡의 가사가 다시 두 줄 연속 일치하면 노래 번역으로 전환합니다. 검색 실패나 일치도 부족 시에는 기존 STT 결과를 그대로 사용합니다.

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

## 로컬 STT + 번역 API

이 프로젝트에는 자막이 없을 때 사용할 수 있는 OpenAI 호환 및 WebSocket STT 서버가 포함돼 있습니다. MLX와 faster-whisper가 같은 오디오 처리·음성 감지·자막 필터를 사용합니다.

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

서버는 M 시리즈 Mac에서 MLX GPU, Intel Mac에서 CPU를 사용하고, Windows·Linux에서는 사용 가능한 NVIDIA GPU가 있으면 CUDA를 선택합니다. `YT_TRANSLATOR_STT_DEVICE`와 `YT_TRANSLATOR_STT_COMPUTE_TYPE`으로 직접 지정할 수도 있습니다.

- 모델: `small`
- 장치: Apple Silicon은 `mlx`, Intel Mac 및 GPU 없는 환경은 `cpu`, NVIDIA GPU가 있으면 `cuda`
- 연산 형식: MLX와 CUDA는 `float16`, CPU는 `int8`
- 스트리밍 엔드포인트: `ws://127.0.0.1:8765/v1/audio/stream`
- HTTP 대체 청크: `8000ms`
- 엔드포인트: `http://127.0.0.1:8765/v1/audio/transcriptions`

옵션 페이지에서 로컬 STT 모델을 선택할 수 있습니다. 기본값인 `small`은 속도와 안정성의 균형을 목표로 합니다. 더 가볍게 테스트하려면 `base`, 끊김이 없고 인식률이 부족하면 `medium`을 선택하고 저장한 뒤 `STT + 번역 API 전체 테스트`를 실행하세요.

로컬 STT 서버의 기본 모델도 `small`입니다. 요청된 모델을 동적으로 불러올 수 있으므로 옵션 페이지에서 `base`, `small`, `medium`을 선택하면 선택된 엔진 형식의 모델이 로컬 캐시에 있는 경우 적용됩니다. MLX는 `mlx-community`의 변환된 모델을 사용하며 faster-whisper의 모델 파일과 캐시가 별도입니다. 사용자 모델 경로는 `YT_TRANSLATOR_STT_MODEL`로 지정하세요.

노래에는 `노래 STT 프리셋`을 사용하거나 `콘텐츠 모드`를 `노래/가사`로 설정하세요. 확장 프로그램이 로컬 STT 서버에 `content_mode=lyrics`를 전송하면 VAD를 비활성화하고, 인식 창과 beam size를 늘려 가창 음성 인식을 개선합니다. CPU에서는 medium보다 base/small부터 테스트하세요. 서버에서 아직 준비하지 않은 모델을 쓰려면 `YT_TRANSLATOR_STT_MODEL`로 지정한 뒤 서버를 재시작하세요.

옵션 페이지에서 다음을 설정합니다.

- `AI API` 키 입력
- `로컬 STT + 번역 API 프리셋` 클릭
- `로컬 STT 연결 확인` 클릭
- `STT + 번역 API 전체 테스트`로 로컬 STT와 AI API 번역을 함께 확인

로컬 프리셋은 `로컬 STT WebSocket 스트리밍 사용`을 활성화합니다. WebSocket 스트림에 실패하면 확장 프로그램은 기존 HTTP 전사 청크 방식으로 자동 전환하고, 설정된 경우 API STT로 한 번 더 대체합니다.

기존 백그라운드 실행 방식을 의도적으로 사용하려면 `npm run stt:daemon`을 실행할 수 있지만, 안정적인 기본 경로는 포그라운드의 `npm run stt:start`입니다.

`/health`가 CUDA 오류를 보고하면 faster-whisper/CTranslate2에 필요한 NVIDIA CUDA/cuDNN 런타임을 설치한 뒤 `npm run stt:start`를 다시 실행하세요.

`/health`가 모델 파일을 로컬에서 찾을 수 없고 Hub에서 다운로드할 수 없다고 표시하면, 인터넷에 연결된 상태에서 서버를 시작하고 `npm run stt:health`로 모델을 준비하세요. 또는 `YT_TRANSLATOR_STT_MODEL`에 현재 엔진에 맞는 로컬 모델 디렉터리를 설정할 수 있습니다.

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
- 로컬 실시간 음성 번역의 기본 경로는 로컬 Whisper STT와 AI API 텍스트 번역입니다. LM Studio 번역은 선택 가능한 로컬 LLM 모드로 계속 사용할 수 있습니다.
- MLX Whisper 0.4.3은 beam search를 지원하지 않아 greedy decoding을 사용합니다. 상태·전사 응답의 beam 값도 `1`로 표시하며 언어 자동 감지는 각 오디오 창에서 수행합니다. 음성 감지와 환각 차단은 두 엔진 모두에 적용됩니다.

## 검증

```bash
npm run test:contracts
npm run build
uv pip install --python .venv-stt -r local_stt/requirements-dev.txt
npm run stt:test
```

GitHub Actions는 Windows, Apple Silicon Mac, Intel Mac에서 빌드·테스트·STT 설치와 실제 CPU/int8 모델 초기화를 확인합니다. Metal GPU 검사는 Apple Silicon에서 실행하며, runner에 GPU가 없으면 생략 사유를 표시합니다. 실제 M 시리즈 Mac에서는 `YT_TRANSLATOR_STT_MODEL=tiny uv run --no-project --python .venv-stt python -m unittest local_stt.test_mlx_runtime -v`로 GPU 추론을 확인할 수 있습니다. YouTube 재생 중 탭 오디오 캡처와 자막 표시까지는 Chrome에서 확인해야 합니다.
