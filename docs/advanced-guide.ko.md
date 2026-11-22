# YouTube Live Translator 고급 설정 및 기술 참고서

처음 설치한다면 [한국어 사용 설명서](user-guide.ko.md)부터 시작하세요. [English](user-guide.en.md) · [日本語](user-guide.ja.md) · [프로젝트 홈](../README.md)

YouTube와 치지직의 라이브·다시보기에 번역 자막을 표시하는 Manifest V3 Chrome 확장 프로그램입니다.

YouTube에서는 제작자가 제공한 공식 자막을 우선 사용합니다. 치지직과 공식 자막이 없는 YouTube 영상은 탭 음성을 인식합니다. 번역은 OpenAI 호환 AI API, LM Studio 또는 Ollama로 처리할 수 있으며, 로컬 STT는 Whisper와 Qwen3-ASR 0.6B·1.7B를 지원합니다. 지원 플랫폼은 Windows와 Apple Silicon Mac입니다. Intel Mac은 지원 대상에서 제외합니다.

> API 키는 확장 프로그램 설정 화면에서 입력하며 `chrome.storage.local`에만 저장됩니다. API 키는 이 저장소나 빌드된 확장 프로그램 소스에 포함되지 않습니다.

## 지원 범위

| 항목 | 지원 내용 |
| --- | --- |
| 사이트 | `www.youtube.com`, `m.youtube.com`, `chzzk.naver.com` |
| 영상 | YouTube 실시간 방송·녹화 영상과 치지직 라이브·다시보기 |
| 브라우저 | 데스크톱 Chrome 116 이상 |
| 운영체제 | Windows, macOS 14 이상 Apple Silicon(M 시리즈) |
| 로컬 음성 인식 | Whisper, Qwen3-ASR 0.6B·1.7B |
| 번역 | OpenAI 호환 API·게이트웨이, LM Studio, Ollama |

다른 동영상 사이트, 인강 사이트, 로컬 동영상 파일은 지원하지 않습니다. `m.youtube.com` 지원은 데스크톱 Chrome에서 해당 주소를 여는 경우를 뜻하며, Android·iOS의 YouTube 앱이나 모바일 브라우저 지원을 뜻하지 않습니다. Intel Mac과 Rosetta의 x86_64 Python은 지원하지 않습니다.

## 주요 기능

- YouTube와 치지직 플레이어 위에 번역 자막 표시
- YouTube timed text, 전체 자막 선번역, IndexedDB 캐시를 활용하는 공식 자막 우선 처리
- `chrome.tabCapture`, offscreen WebAudio, 로컬 WebSocket STT를 이용하는 탭 음성 인식
- YouTube 영상 제목·설명을 활용하는 LRCLIB 노래 보조와 곡 교정 사전
- 켜기/끄기, 원문 표시, 노래 모드, 글자 크기, 위치, 재시도, 설정 열기를 제공하는 플레이어 미니 컨트롤
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
git clone https://github.com/ljwoo8942/youtube-live-translator.git
cd youtube-live-translator
npm ci
npm run build
```

Chrome에서 개발자 모드를 켠 뒤 `chrome://extensions`의 `압축해제된 확장 프로그램을 로드합니다`로 생성된 `dist` 폴더를 선택합니다.

## 로컬 STT 처음 실행

Whisper 또는 Qwen으로 탭 음성을 인식하려면 저장소 폴더에서 다음을 실행합니다. Windows PowerShell과 macOS 터미널에서 같은 명령을 사용합니다. 클라우드 API STT만 사용하거나 공식 자막만 번역한다면 로컬 STT 서버를 설치할 필요가 없습니다.

```bash
npm run stt:setup
npm run stt:start
```

위 터미널은 열어 두고, Chrome에 `dist` 폴더를 로드하세요. 옵션 페이지에서 AI 번역 API 키와 사용할 모델을 입력하고 `설정 저장`을 누르세요. `로컬 STT 연결 확인`과 `현재 설정 연결 테스트`로 연결을 검사할 수 있습니다. 새 터미널에서 `npm run stt:health`로 서버 상태를 확인할 수도 있습니다.

M 시리즈 Mac에서는 Metal GPU가 자동 선택됩니다. Whisper는 `mlx-whisper`, Qwen3-ASR는 `mlx-audio`의 8bit 모델을 사용합니다. Apple Silicon용 arm64 Python이 필요하며, `npm run stt:setup`이 해당 Mac에서만 MLX 패키지를 설치합니다. LM Studio/Ollama 번역은 별도로 선택할 수 있습니다.

최초 인식 또는 상태 확인 시 서버 시작 모델을 내려받을 수 있어 시간이 걸립니다. Whisper를 선택한 Mac에서 `npm run stt:health` 응답의 `backend`가 `mlx-whisper`, `device`가 `mlx`, `compute_type`이 `float16`, `ok`가 `true`이면 실제 GPU 초기화와 짧은 추론 검사를 통과한 것입니다. Windows의 Whisper는 사용 가능한 NVIDIA GPU가 있으면 CUDA를 선택하고, 그렇지 않으면 CPU를 사용합니다.

Mac에서 직접 지정하려면 `YT_TRANSLATOR_STT_DEVICE=mlx npm run stt:start`를 사용하세요. Whisper를 CPU로 실행할 때는 `YT_TRANSLATOR_STT_DEVICE=cpu YT_TRANSLATOR_STT_COMPUTE_TYPE=int8 npm run stt:start`를 사용합니다. 새 Whisper 모델을 준비하려면 서버 시작 전에 `YT_TRANSLATOR_STT_MODEL=base` 등으로 지정한 뒤 `npm run stt:health`로 로딩을 확인하세요. 확장 프로그램에서도 같은 모델을 선택하고 `설정 저장`을 눌러야 합니다. `로컬 STT 연결 확인`은 서버 상태만 검사하며 모델 선택이나 저장된 설정을 바꾸지 않습니다.

가상환경 `.venv-stt`는 운영체제와 CPU 구조에 종속됩니다. Windows 가상환경을 Mac으로 복사하지 말고 Mac에서 `npm run stt:setup`을 실행하세요. 설정·곡 교정 사전은 각 Chrome 프로필에 저장되므로, 곡 교정 사전은 JSON 내보내기/가져오기로 옮길 수 있습니다.

## 처음 사용하는 순서

1. YouTube 또는 치지직 영상 탭에서 팝업의 `전체 설정`을 엽니다.
2. 번역 제공자와 API 키 또는 로컬 번역 서버를 설정합니다. 음성 인식이 필요하면 STT 제공자와 모델도 선택합니다.
3. `현재 설정 연결 테스트`로 입력한 값을 검사한 뒤 `설정 저장`을 누릅니다. 테스트만으로는 설정이 저장되지 않습니다.
4. 영상으로 돌아가 확장 프로그램을 켭니다. 기본 입력 방식은 `선택한 공식 자막 우선 + 없으면 음성`입니다.
5. 치지직 본편이 재생되거나 YouTube에서 음성 인식이 필요할 때 팝업의 `음성 시작`을 누릅니다. 첫 실행 시 Chrome의 탭 캡처 권한을 허용하세요.

| 입력 방식 | 동작 |
| --- | --- |
| 선택한 공식 자막만 사용 | YouTube 공식 자막을 번역 |
| 선택한 공식 자막 우선 + 없으면 음성 | YouTube 공식 자막을 우선 사용하며, 치지직에서는 탭 음성을 인식·번역 |
| 음성만 | 탭 음성을 인식·번역 |

YouTube의 자동 생성 자막·자동 번역문은 공식 원문 자막과 구분합니다. 자동 번역 화면이 켜져 있어도 가능한 경우 원래 공식 트랙을 가져옵니다.

## 업데이트

```bash
git pull
npm ci
npm run build
```

Chrome 확장 관리 화면에서 확장 프로그램을 새로고침하고 **열려 있던 YouTube와 치지직 영상 탭도 새로고침**하세요. 로컬 STT를 사용한다면 기존 서버를 종료하고 `npm run stt:setup`을 실행한 뒤 `npm run stt:start`로 다시 시작하세요. 곡 교정 사전은 업데이트 전에 JSON으로 백업할 수 있습니다.

## Qwen3-ASR 0.6B / 1.7B 사용

기존 서버를 종료하고 다음 명령으로 실행 패키지와 두 모델을 준비합니다. 모델 파일은 운영체제별 Hugging Face 캐시에 저장되며 GitHub에는 업로드하지 않습니다.

```bash
git pull
npm ci
npm run build
npm run stt:setup
npm run stt:qwen:download
```

확장 프로그램과 YouTube 페이지를 새로고침하고 전체 설정의 `로컬 STT 모델 (Whisper / Qwen) > 모델`에서 `Qwen3-ASR 0.6B` 또는 `Qwen3-ASR 1.7B`를 선택한 뒤 저장하세요. 라이브·노래 프리셋은 선택한 Qwen 모델을 유지합니다. 다운로드하지 않은 모델은 전사 요청에서 거부되며 준비 명령이 안내됩니다.

| 선택값 | Windows | Apple Silicon Mac |
| --- | --- | --- |
| `qwen3-asr-0.6b` | `Qwen/Qwen3-ASR-0.6B-hf` / Transformers | `mlx-community/Qwen3-ASR-0.6B-8bit` / MLX GPU |
| `qwen3-asr-1.7b` | `Qwen/Qwen3-ASR-1.7B-hf` / Transformers | `mlx-community/Qwen3-ASR-1.7B-8bit` / MLX GPU |

터미널에서 직접 시작하려면 `npm run stt:start`를 사용하세요. 서버의 시작 모델도 Qwen으로 바꾸려면 Mac에서 `YT_TRANSLATOR_STT_MODEL=qwen3-asr-0.6b npm run stt:start`를 사용하세요. Windows PowerShell에서는 `$env:YT_TRANSLATOR_STT_MODEL = 'qwen3-asr-0.6b'` 실행 후 `npm run stt:start`를 실행합니다. 1.7B도 같은 방식으로 지정합니다.

Windows에서 `npm run stt:setup`은 NVIDIA GPU를 감지하면 프로젝트 가상환경의 CPU 전용 PyTorch를 공식 `torch 2.15.0+cu132`로 교체하고 실제 CUDA FP16 연산까지 검사합니다. CUDA 13.2와 호환되는 NVIDIA 드라이버와 PyTorch가 지원하는 Turing(`sm_75`) 이상 GPU가 필요하며, 기존 서버를 종료한 뒤 설치 명령을 실행하세요. 패키지와 다운로드 캐시는 각각 `.venv-stt`, `.cache/uv`에 저장됩니다(이미 지정한 `UV_CACHE_DIR`은 유지). 모델 가중치는 CPU·GPU 공용이므로 다시 받을 필요가 없습니다.

GPU 없는 Windows와 명시적 CPU 설정은 기존 경로를 사용하고, Apple Silicon은 MLX GPU 경로를 사용합니다. CUDA 설치 검사가 실패하면 오류를 해결한 뒤 재실행하세요. `npm run stt:health`의 `loaded_model`, `backend`, `device`, `compute_type`으로 실제 실행 경로를 확인할 수 있습니다. Qwen CUDA의 기대값은 `device=cuda`, `compute_type=float16`입니다. 다른 설치 방법으로 CPU 전용 PyTorch를 설치한 경우에는 Qwen이 경고 후 CPU로 대체 실행할 수 있으므로 상태를 확인해야 합니다.

RTX 5070에서 두 모델의 실제 GPU 모델·입력·출력, HTTP·WebSocket 생성과 음성 인식을 확인했습니다. 명령과 검사 범위는 [Qwen CUDA 검증 기록](qwen-cuda-validation.md)을 참고하세요.

Qwen도 기존 HTTP 전사·WebSocket 롤링 오디오 창과 음성 감지, 텍스트 환각·반복 차단을 사용합니다. 결과 시간은 오디오 창의 범위이며 단어별 정렬 정보가 아닙니다. Whisper식 신뢰도 점수는 생성하지 않습니다. 네이티브 Qwen 스트리밍 상태 유지와 별도 강제 정렬 모델은 이번 연동에 포함하지 않았습니다.

### 확장 팝업에서 로컬 STT 서버 시작·중지

Windows와 Apple Silicon Mac에서는 Chrome Native Messaging 호스트를 한 번 등록하면 팝업에서 Whisper와 Qwen3-ASR 서버를 켜고 끌 수 있습니다. 기존 Qwen 호스트 등록을 그대로 사용할 수 있습니다.

1. `dist`를 Chrome에 로드하거나 이미 로드한 확장을 새로고침하세요. Chrome의 확장 프로그램 관리 화면에서 개발자 모드를 켜고 이 확장의 ID를 복사합니다.
2. 프로젝트 폴더에서 다음 명령을 실행하세요. 예시 ID를 복사한 실제 ID로 바꿉니다.

   ```bash
   npm run stt:native:install -- abcdefghijklmnopabcdefghijklmnop
   ```

3. 전체 설정에서 `로컬 STT (Whisper / Qwen)`, 기본 STT 주소 `http://127.0.0.1:8765/v1` 및 준비된 모델을 선택하고 저장하세요. 스트리밍을 켰다면 주소는 `ws://127.0.0.1:8765/v1/audio/stream`을 사용합니다.
4. YouTube 또는 치지직 탭에서 팝업의 `로컬 STT 시작`을 누르고 첫 사용 시 Chrome의 로컬 프로그램 연결 권한을 허용하세요. 권한 창을 닫으며 팝업이 함께 닫혔다면 다시 열어 시작을 누르세요. 실행 중인 모델과 장치가 표시되면 `음성 시작`으로 탭 음성을 인식할 수 있습니다.
5. 팝업의 `로컬 STT 중지`는 이 확장에서 연 서버를 종료합니다. 다른 모델로 바꾸려면 먼저 서버를 중지한 뒤 모델을 저장하고 다시 시작하세요. 팝업을 닫아도 서버는 유지되며, Chrome 종료나 확장 새로고침 시 함께 종료됩니다.

팝업에서는 캐시된 모델을 사용합니다. Whisper 모델을 처음 준비할 때는 `YT_TRANSLATOR_STT_MODEL`에 모델 이름을 지정해 `npm run stt:start`를 실행한 뒤 다른 터미널에서 `npm run stt:health`를 실행하세요. 모델 준비가 끝나면 터미널 서버를 종료하세요. Qwen 모델은 `npm run stt:qwen:download`로 준비할 수 있습니다. [운영체제별 모델 준비 명령](../local_stt/README.md#run)

이미 8765번에 서버가 실행 중이면 팝업에서 새 서버를 시작할 수 없습니다. 기존 서버를 사용하거나 원래 실행한 터미널에서 종료하세요. 프로젝트를 옮기거나 확장 ID가 바뀌면 호스트를 다시 등록하세요. 등록 범위는 현재 OS 사용자와 입력한 확장 ID입니다. [Chrome Native Messaging 문서](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

## 로컬 AI 기본값

- Ollama: `http://localhost:11434`
- 로컬 STT(Whisper / Qwen) HTTP: `http://127.0.0.1:8765/v1/audio/transcriptions`
- 로컬 STT 스트리밍: `ws://127.0.0.1:8765/v1/audio/stream`
- LM Studio: 로컬 LLM 번역을 선택한 경우 `http://127.0.0.1:1234/v1`

확장 프로그램의 옵션 페이지에서 제공자를 선택하고, API 키와 언어 코드를 입력하며, 자막 오버레이를 조절할 수 있습니다.

기본 권장 조합은 로컬 Whisper STT와 AI 번역 API입니다. 텍스트 번역 제공자로 LM Studio를 직접 선택한 경우 `LM Studio 번역 테스트`로 연결을 확인할 수 있습니다.

`Gemma4-E4B-Instruct-Pure-GGUF` 기준의 모델 Load, Inference, Local Server, 확장 프로그램 연결 값은 [LM Studio 설정 값](lm-studio-settings.md)에서 확인할 수 있습니다.

## 공식 자막 선번역

기본 자막 우선 모드에서 공식 timed text를 사용할 수 있으면 오디오 캡처를 시작하지 않습니다. 전체 원문 트랙을 받아 현재 재생 구간 주변부터 번역합니다. AI API는 남은 자막을 백그라운드에서 선번역하며, 자동 선번역 작업에는 500개 자막·원문 100,000자 한도가 있습니다. LM Studio·Ollama는 재생 위치 주변의 자막을 우선 처리합니다. 이 한도는 전체 API 사용량이나 요금의 상한이 아니며 현재 자막·음성의 개별 번역 요청은 별도입니다.

번역 자막 캐시는 영상 ID, 자막 해시, 목표 언어, 제공자/모델, 콘텐츠 모드를 기준으로 IndexedDB에 저장됩니다. 같은 영상을 다시 열면 캐시된 번역을 즉시 표시할 수 있습니다.

번역 캐시는 30일·10,000개 항목으로 제한하며 오래된 항목부터 정리합니다. 저장 공간이 부족하거나 캐시를 사용할 수 없어도 번역은 계속합니다. 외부 API 주소를 저장하거나 연결을 테스트할 때 해당 서버의 접근 권한을 요청합니다. 서버 요청은 응답 본문까지 외부 API 60초, 로컬 서버 120초(health 45초)로 제한하며 세션 종료·설정 변경 시 이전 요청을 취소합니다.

음악 영상의 가사형 번역에는 옵션 페이지의 `콘텐츠 모드` 또는 YouTube 미니 컨트롤의 `♪` 버튼을 사용하세요.

## 팝업·설정과 연결 테스트

팝업 첫 화면에서 저장·음성 시작·음성 중지와 미니 컨트롤·교정 사전 켜기/끄기를 사용할 수 있습니다. 제공자·언어 등은 `입력·언어·모델 설정`을 펼쳐 변경합니다. 좁은 설정 창에서는 저장 영역이 본문을 가리지 않도록 페이지 하단에 배치됩니다. 작은 영상의 미니 컨트롤은 줄바꿈하며 긴 자막은 자막 영역을 스크롤해 읽을 수 있습니다.

| 버튼 | 검사 범위 |
| --- | --- |
| 현재 설정 연결 테스트 | 현재 입력값으로 검사. 공식 자막 전용 모드는 번역만, 음성 사용 모드는 STT와 번역 연결 검사 |
| 번역 테스트 | 현재 선택한 번역 제공자에 고정 문장 요청 |
| 로컬 STT 연결 확인 | 로컬 서버의 `/health`·`/v1/models` 조회. 선택 모델을 변경하거나 저장하지 않음 |
| 로컬 STT + 번역 연결 테스트 | 로컬 STT 무음 요청과 현재 번역 제공자의 연결 검사 |
| API STT 연결 테스트 | API STT 무음 요청 검사 |
| API STT + 번역 연결 테스트 | API STT와 현재 번역 제공자의 연결 검사 |

연결 테스트는 현재 입력값을 임시 사용하며 설정을 저장하거나 프리셋을 바꾸지 않습니다. 검사 성공은 실제 탭 캡처나 음성 인식 정확도의 검증을 뜻하지 않습니다. 사용하려는 값은 따로 `설정 저장`을 누르세요. 처리 중에는 입력과 버튼을 잠가 중복 실행을 막고 결과를 상태 영역에 표시합니다.

`동작·자막 기본값 복원`은 확인 후 동작·자막 설정만 복원합니다. 저장된 API 주소·인증 방식·키·모델, 제공자 선택과 스트리밍 연결 설정은 유지합니다.

## 곡 교정 사전

팝업이나 옵션 페이지의 `곡 교정 사전`을 누르면 독립된 관리 페이지가 열립니다. 곡 이름, 가수/작곡가, YouTube 영상 ID, 원문 가사와 교정 번역을 줄 단위 또는 일괄 입력으로 저장할 수 있습니다.

공식 자막은 저장 원문과 일치하는 줄을 즉시 교정문으로 표시합니다. 음성 STT는 같은 곡의 원문이 두 줄 연속 일치한 뒤 교정문을 사용하며, 불일치가 이어지면 기존 실시간 번역으로 돌아갑니다. 커버 프로필에는 영상 ID, 커버 가수와 개사된 줄만 별도로 저장할 수 있습니다.

교정 사전은 IndexedDB에 로컬로 저장되며 서버로 전송되지 않습니다. JSON 백업과 복원, LRC/SRT 원문 가져오기를 지원합니다. **JSON을 가져오면 저장된 곡 목록 전체가 교체됩니다.** 빈 목록이 담긴 유효한 JSON은 모든 곡을 지울 수 있습니다. 먼저 편집 중인 곡을 저장하고, 현재 사전을 별도 JSON으로 내보내세요. LRC/SRT는 현재 편집기에 원문을 불러오며, 직접 저장하기 전까지 사전에 반영되지 않습니다.

일괄 편집에서 기존 원문과 일치하는 줄은 식별자·시간·메모를 유지합니다. 원문 변경·삭제로 시간이나 메모가 제거될 때는 적용 전에 확인하며, 삭제된 원문의 커버 교정은 독립된 교정 줄로 보존합니다.

저장 전 수정은 화면에 표시하며 곡 전환·새 곡·가져오기·페이지 이탈 전에 확인합니다. 영상 정보 가져오기는 직접 입력한 곡 정보의 빈 항목만 채웁니다. 일괄 편집 초안은 `일괄 반영`한 뒤 저장해야 합니다.

## 자막 없는 노래 가사 보조

`자막 없는 노래에서 제목·설명의 가사 후보로 STT 보정`을 켜면 영상 제목과 설명의 세트리스트 후보를 LRCLIB에서 검색합니다. 검색 결과는 STT와 두 줄 연속 일치한 뒤에만 사용하며, 전체 가사는 저장하지 않고 현재 영상 세션의 메모리에만 유지합니다.

라이브 모드에서는 가사 불일치가 두 구간 연속 발생하면 대화 번역으로 돌아가고, 같은 곡이나 다음 곡의 가사가 다시 두 줄 연속 일치하면 노래 번역으로 전환합니다. 검색 실패나 일치도 부족 시에는 기존 STT 결과를 그대로 사용합니다.

## API 키 기반 음성 자막

치지직과 공식 자막이 없는 YouTube 영상은 설정한 STT 엔드포인트에서 탭 음성을 먼저 인식합니다.

옵션 페이지에서 다음 순서로 설정합니다.

- `API 키로 음성 자막 프리셋` 클릭
- `AI API` 키 또는 `API STT` 키 입력
- `API STT + 번역 연결 테스트`를 클릭해 STT 연결과 AI 번역을 함께 확인
- 저장한 뒤 영상 재생 탭에서 `자막 우선 + 음성` 또는 `음성만` 선택

전사 엔드포인트만 확인하려면 `API STT 연결 테스트`, 텍스트 번역만 확인하려면 `번역 테스트`를 사용할 수 있습니다.

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

탭 음성 번역을 사용하는 동안 이 터미널을 열어 두세요. `stt:start`는 로컬 서버를 포그라운드에서 실행하므로 Chrome이 `http://127.0.0.1:8765`에 계속 연결할 수 있습니다.

상태 확인:

```bash
npm run stt:health
```

서버는 M 시리즈 Mac에서 MLX GPU를 사용하고, Windows에서는 사용 가능한 NVIDIA GPU가 있으면 CUDA를 선택합니다. Whisper는 `YT_TRANSLATOR_STT_DEVICE`와 `YT_TRANSLATOR_STT_COMPUTE_TYPE`으로 직접 지정할 수도 있습니다. Qwen의 실제 정밀도는 선택된 엔진에 따라 결정됩니다.

- 모델: `small`
- 장치: Apple Silicon은 `mlx`, GPU 없는 Windows는 `cpu`, NVIDIA GPU가 있으면 `cuda`
- Whisper 연산 형식: MLX와 CUDA는 `float16`, CPU는 `int8` (Qwen은 MLX `8bit`, PyTorch CUDA `float16` / CPU `float32`)
- 스트리밍 엔드포인트: `ws://127.0.0.1:8765/v1/audio/stream`
- HTTP 대체 청크: `8000ms`
- 엔드포인트: `http://127.0.0.1:8765/v1/audio/transcriptions`

옵션 페이지에서 로컬 STT 모델을 선택할 수 있습니다. 기본값인 `small`은 속도와 안정성의 균형을 목표로 합니다. 더 가볍게 테스트하려면 `base`, 끊김이 없고 인식률이 부족하면 `medium`을 선택하고 저장한 뒤 `로컬 STT + 번역 연결 테스트`를 실행하세요.

로컬 STT 서버의 기본 모델도 `small`입니다. 요청된 모델을 동적으로 불러올 수 있으므로 옵션 페이지에서 `base`, `small`, `medium`을 선택하면 선택된 엔진 형식의 모델이 로컬 캐시에 있는 경우 적용됩니다. MLX는 `mlx-community`의 변환된 모델을 사용하며 faster-whisper의 모델 파일과 캐시가 별도입니다. 사용자 모델 경로는 `YT_TRANSLATOR_STT_MODEL`로 지정하세요.

노래에는 `노래 STT 프리셋`을 사용하거나 `콘텐츠 모드`를 `노래/가사`로 설정하세요. 확장 프로그램이 로컬 STT 서버에 `content_mode=lyrics`를 전송하면 VAD를 비활성화하고, 인식 창과 beam size를 늘려 가창 음성 인식을 개선합니다. CPU에서는 medium보다 base/small부터 테스트하세요. 서버에서 아직 준비하지 않은 모델을 쓰려면 `YT_TRANSLATOR_STT_MODEL`로 지정한 뒤 서버를 재시작하세요.

노래/가사 모드에서 선택한 `음성 언어`는 WebSocket과 HTTP 전사에 모두 적용됩니다. 여러 언어가 섞인 노래에선 `자동 감지`를 사용할 수 있습니다.

「快晴」 커버의 1:00–1:30 구간에서 검증한 정확도 우선 조합은 `음성만`, `노래/가사`, `일본어`, `Qwen3-ASR 1.7B`입니다. `로컬 STT WebSocket 스트리밍 사용`을 끄고 `음성 청크(ms)`를 `14000`으로 저장한 뒤 로컬 STT 서버와 음성 인식을 시작하세요. 첫 자막은 재생 약 13초 뒤에 표시됐습니다. [검증 영상](https://www.youtube.com/watch?v=YA7QcvdHk70&t=60s)

옵션 페이지에서 다음을 설정합니다.

- `AI API` 키 입력
- `로컬 STT + 번역 API 프리셋` 클릭
- `로컬 STT 연결 확인` 클릭
- `로컬 STT + 번역 연결 테스트`로 로컬 STT와 번역 제공자 연결을 함께 확인

로컬 프리셋은 `로컬 STT WebSocket 스트리밍 사용`을 활성화합니다. Qwen과 Whisper 모두 중간 인식 결과를 번역에 보내고, 인식이 확정되면 자막을 갱신합니다. LM Studio와 Ollama로도 중간 결과를 번역할 수 있습니다. WebSocket 스트림에 실패하면 선택한 Whisper 호환 제공자의 HTTP 전사 청크 방식으로 전환합니다. 클라우드 API STT를 사용하려면 STT 제공자를 `OpenAI-compatible`로 직접 선택하세요. `LM Studio STT 먼저 시도`를 선택한 경우에는 실패 시 설정된 Whisper 호환 제공자로 대체합니다.

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

## 데이터 처리와 권한

- 탭 음성 인식은 선택한 YouTube 또는 치지직 재생 탭의 오디오를 사용합니다.
- AI 번역 API를 선택하면 원문 자막·인식된 텍스트와 번역 문맥을 설정한 제공자에 전송합니다. 클라우드 STT를 선택하면 탭 오디오 조각도 해당 STT 제공자에 전송합니다. 제공자에 따라 API 사용 요금이 발생할 수 있습니다.
- 로컬 STT와 LM Studio·Ollama 번역을 선택하면 음성 인식·번역 연산을 로컬에서 수행합니다. 최초 모델 다운로드와 동영상 재생에는 네트워크가 필요합니다.
- 가사 검색 보조를 켜면 영상 제목·설명에서 추출한 검색어를 LRCLIB에 보냅니다. 설정에서 끌 수 있습니다.
- 외부 API 접근 권한은 선택한 서버별로 요청합니다. 외부 서버는 HTTPS/WSS를 사용하고, HTTP/WS는 `localhost`·`127.0.0.1`에만 허용합니다. 포함된 STT 서버는 기본적으로 `127.0.0.1:8765`에서 실행됩니다.

## 문제 해결

| 증상 | 확인할 항목 |
| --- | --- |
| 다른 사이트에서 버튼이 비활성화됨 | YouTube 또는 치지직 영상 탭에서 팝업을 다시 여세요. |
| 업데이트 후 이전 화면이 남음 | `npm run build` 후 확장 프로그램과 영상 탭을 모두 새로고침하세요. |
| STT 서버에 연결되지 않음 | 팝업의 `로컬 STT 시작` 또는 `npm run stt:start`로 서버를 켠 뒤 `npm run stt:health`로 상태와 실제 장치를 확인하세요. |
| Chrome 연결 프로그램을 등록하라는 메시지가 표시됨 | 확장 관리 화면에서 ID를 확인하고 `npm run stt:native:install -- 실제ID`를 실행하세요. |
| 선택한 모델이 준비되지 않았다고 표시됨 | Qwen은 `npm run stt:qwen:download`, Whisper는 서버 시작 모델 지정 후 상태 확인으로 준비하고, 확장에서도 모델 선택 후 저장하세요. |
| 외부 API가 연결되지 않음 | URL·엔드포인트·접근 권한·인증 방식을 확인하세요. 401/403이면 키와 제공자 권한도 확인하세요. |
| 연결 테스트는 성공하지만 자막이 없음 | 영상 탭에서 확장 켜기, 입력 방식, 재생 상태와 탭 캡처 권한을 확인하세요. |
| 일괄 편집 후 저장이 막힘 | 초안을 `일괄 반영`한 뒤 저장하세요. 곡 전환 확인에서 취소하면 작성하던 내용을 유지할 수 있습니다. |

## 검증

```bash
npm run test:contracts
npm run build
uv pip install --python .venv-stt -r local_stt/requirements-dev.txt
npm run stt:test
```

GitHub Actions는 Windows와 Apple Silicon Mac에서 빌드·테스트·설치, Whisper 실행, Qwen 0.6B 실제 추론을 확인합니다. Mac에서는 Qwen 1.7B Metal 추론도 확인하며, runner에 GPU가 없으면 생략 사유를 표시합니다. Intel Mac 검증은 제외합니다. `YT_TRANSLATOR_STT_MODEL=qwen3-asr-0.6b uv run --no-project --python .venv-stt python -m unittest local_stt.test_qwen_runtime -v`로 준비된 Qwen 모델을 직접 확인할 수 있습니다. YouTube 재생 중 탭 오디오 캡처와 자막 표시까지는 Chrome에서 확인해야 합니다.

`test:contracts`에는 자막 처리의 소스 검사와 편집 보호·진단·권한·중복 실행 등에 대한 동작 회귀 검사가 포함됩니다. 브라우저 API와 폼을 대체한 검사는 실제 Chrome 권한 팝업·전체화면·접근성 도구 검증을 대신하지 않습니다. 스트림 창 길이와 디코딩 간격은 설정값이며 실제 자막 지연이나 모델 정확도 측정값이 아닙니다.
