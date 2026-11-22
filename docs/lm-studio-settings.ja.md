# YouTube Live Translator の LM Studio 設定

[한국어](lm-studio-settings.md) · [English](lm-studio-settings.en.md) · **日本語**

ここでは、RTX 5070（VRAM 12 GB）とメインメモリ 64 GB の Windows PC で `Gemma4-E4B-Instruct-Pure-GGUF` を使った検証時の設定を紹介します。

拡張機能では Gemma が字幕を翻訳し、ローカルの Whisper または Qwen3-ASR がタブの音声を認識します。対応環境とインストール方法はプロジェクト概要を参照してください。[README](../README.md)

## 検証した構成

| 項目 | 値 |
| --- | --- |
| 翻訳モデル | `Gemma4-E4B-Instruct-Pure-GGUF` |
| 検証環境でのモデル ID | `gemma4-e4b-instruct-pure` |
| 翻訳プロバイダー | `LM Studio` |
| 歌詞の音声認識 | ローカルの Qwen3-ASR 1.7B（Windows、CUDA/FP16） |
| 翻訳エンドポイント | `/chat/completions` |

LM Studio でモデルを読み込みます。拡張機能の LM Studio 設定で `모델 목록 불러오기`（モデル一覧を取得）を押し、読み込んだモデルの ID を選択します。

## モデルの読み込み設定

| 項目 | 設定値 | 用途 |
| --- | --- | --- |
| GPU offload | GPU に収まる範囲でレイヤーを割り当てる | 翻訳にかかる時間を短くします |
| Context length | `4096` | 翻訳する字幕、前後の文脈、訳文を扱います |
| Flash Attention | 対応していればオン | 長い文脈でのメモリ使用量と処理時間を抑えます |
| CPU threads | Auto | LM Studio がスレッド数を選びます |
| モデルの保持 | 読み込んだ状態を維持 | 再生中の再読み込みを防ぎます |

Gemma と Qwen を同じ GPU で使う場合は、Context length を `4096` から試してください。値を大きくすると VRAM 使用量が増えます。

## 翻訳リクエスト

最大出力長は既定値を使い、Stop strings は空欄にします。字幕ごとの出力トークン数は拡張機能が指定します。ローカルの LM Studio で Gemma 4 を使う場合、拡張機能は `/chat/completions` の翻訳リクエストに `reasoning_effort: "none"` を送ります。

| コンテンツモード | Temperature | Top P |
| --- | ---: | ---: |
| 自動・通常動画 | `0.14` | `0.86` |
| ライブ・雑音 | `0.12` | `0.86` |
| 歌・歌詞 | `0.16` | `0.88` |

ローカルの LM Studio に送るリクエストには、拡張機能が上の値を指定します。複数の字幕を翻訳するときも、リクエストは字幕一行ずつ送ります。

## システムプロンプト

LM Studio のシステムプロンプトは空欄のままで使えます。拡張機能が選択したコンテンツモードに応じた指示を送ります。LM Studio に短い指示も入れる場合は、以下を使えます。

```text
You are a subtitle translation engine.
Follow the system instructions provided by the application as the highest priority.
Output only the final translated subtitle.
Do not output reasoning, explanations, labels, source text, quotation marks, or Markdown.
```

## ローカルサーバーを起動して拡張機能につなぐ

LM Studio の **Developer > Local Server** でサーバーを起動します。拡張機能の `전체 설정`（全体設定）で翻訳プロバイダーを LM Studio にし、LM Studio 欄に下の値を入力します。

| 拡張機能の設定 | 値 |
| --- | --- |
| 翻訳プロバイダー（`번역 provider`） | `LM Studio` |
| Base URL | `http://127.0.0.1:1234/v1` |
| 翻訳モデル（`번역 모델`） | モデル一覧に表示された、読み込み済みのモデル ID |
| エンドポイント（`엔드포인트`） | `/chat/completions` |
| 認証方式（`인증 방식`） | サーバー認証がオフなら `인증 헤더 없음`（認証ヘッダーなし） |
| LM Studio の STT を先に試す（`LM Studio STT 먼저 시도`） | オフ |

LM Studio のサーバーで認証を使う場合は、`API 토큰`（API トークン）にそのトークンを入力し、認証方式を合わせます。`LM Studio 번역 테스트`（LM Studio 翻訳テスト）で訳文が返ることを確認し、`설정 저장`（設定を保存）を押します。

## ローカル STT のストリーミングで字幕を早く表示する

1. 全体設定で `로컬 STT (Whisper / Qwen)`（ローカル STT）を選び、使用する音声認識モデルを選択します。
2. `로컬 STT WebSocket 스트리밍 사용`（ローカル STT の WebSocket ストリーミング）をオンにします。`스트리밍 STT WebSocket` に `ws://127.0.0.1:8765/v1/audio/stream` を指定して保存します。
3. Gemma を読み込んだ LM Studio サーバーとローカル STT サーバーを起動します。動画タブのポップアップで `음성 시작`（音声認識を開始）を押します。[ローカル STT サーバーの設定（英語）](../local_stt/README.md)

話し声の場合は、途中の認識結果が一定の長さになると仮の訳文を表示し、認識が確定すると字幕を更新します。`노래/가사`（歌・歌詞）モードでは、確定した認識結果から表示します。原文も表示するには、オーバーレイ設定の `원문도 표시`（原文も表示）をオンにします。WebSocket に接続できない場合は HTTP に切り替わります。曲に 14 秒の設定を使う場合は、下の表のとおりストリーミングをオフにします。

Windows の RTX 5070 でモデルを事前に読み込み、英語の合成音声を再生時と同じ速度で送信しました。音声入力の開始からローカルの `gemma4-e4b-instruct-pure` が翻訳結果を返すまでを測定しました。

| 音声認識モデル | 最初の仮訳 | 最初の確定訳 |
| --- | ---: | ---: |
| Qwen3-ASR 1.7B | 1.43 秒 | 3.78 秒 |
| Whisper base | 1.27 秒 | 3.59 秒 |

## テンポの速い日本語曲の設定

`uv` をインストールし、プロジェクトのフォルダーで次のコマンドを実行してローカル STT 環境と Qwen モデルを用意します。

```bash
npm run stt:setup
npm run stt:qwen:download
```

「快晴」のカバー動画の 1:00–1:30 で、下の設定で歌詞を認識して Gemma で翻訳しました。再生開始から最初の翻訳字幕が表示されるまで約 13 秒でした。[検証動画](https://www.youtube.com/watch?v=YA7QcvdHk70&t=60s)

| 拡張機能の設定 | 値 |
| --- | --- |
| 入力方式（`입력 방식`） | 音声のみ（`음성만`） |
| コンテンツモード（`콘텐츠 모드`） | 歌・歌詞（`노래/가사`） |
| 音声言語（`음성 언어`） | 日本語（`일본어`） |
| STT プロバイダー（`STT provider`） | ローカル STT（`로컬 STT (Whisper / Qwen)`） |
| ローカル STT モデル | `Qwen3-ASR 1.7B` |
| ローカル STT の Base URL | `http://127.0.0.1:8765/v1` |
| ローカル STT のエンドポイント | `/audio/transcriptions` |
| ローカル STT の WebSocket ストリーミング（`로컬 STT WebSocket 스트리밍 사용`） | オフ |
| 音声チャンク（`음성 청크(ms)`） | `14000` |

この設定では 14 秒ごとに音声をまとめて HTTP で認識します。選択した音声言語は、WebSocket と HTTP の音声認識に適用されます。複数の言語が混ざる曲では `자동 감지`（自動検出）を選べます。

ポップアップから STT サーバーを起動するには、`chrome://extensions` でインストール済みの拡張機能の ID を確認します。`npm run stt:native:install -- YOUR_EXTENSION_ID` の `YOUR_EXTENSION_ID` をその ID に置き換えて、一度実行します。設定を保存し、動画タブのポップアップで `로컬 STT 시작`（ローカル STT を起動）を押します。サーバーが準備できたら `음성 시작`（音声認識を開始）を押します。

## うまく動かないとき

- 訳文が空になる場合や推論だけが返る場合は、最新のビルドで拡張機能を再読み込みし、Gemma のモデル ID と `/chat/completions` の設定を確認します。
- 接続できない場合は、ローカルサーバーが起動しているか、Base URL の末尾が `/v1` かを確認します。
- 翻訳が遅い場合は、モデルが再読み込みされていないか、GPU offload の設定が適切かを確認します。
- 直訳が気になる場合は、動画に合わせて `콘텐츠 모드`（コンテンツモード）を歌・歌詞やライブ・雑音に設定します。
