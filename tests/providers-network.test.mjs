import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { DEFAULT_SETTINGS } from "../src/shared/defaults.ts";

const resolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === "../shared/network" ? `${specifier}.ts` : specifier, context);
  }
});
const { assertTranscriptionReady, reviewLocalAudioTranslation, transcribeAudio, translateSegment, translateSegments } =
  await import("../src/background/providers.ts");
resolver.deregister();

const segment = { id: "one", source: "youtubeTimedText", startMs: 0, endMs: 1000, text: "こんにちは" };
const segments = [segment, { ...segment, id: "two", text: "ありがとう" }];
const audio = new ArrayBuffer(4);

test("local STT HTTP checks and uploads identify extension requests without adding headers to remote STT", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, extensionRequest: new Headers(init.headers).get("X-YT-Translator-Local-STT") });
    return Response.json({ ok: true, text: "speech" });
  });
  const settings = settingsFor("whisper", "stt");
  await assertTranscriptionReady(settings);
  await transcribeAudio(settings, audio, "audio/webm");
  settings.whisper.baseUrl = "https://stt.example.com/v1";
  await transcribeAudio(settings, audio, "audio/webm");
  assert.deepEqual(requests.map((request) => request.extensionRequest), ["1", "1", null]);
});

test("local LM Studio Gemma 4 returns subtitle text with reasoning disabled", async (t) => {
  const settings = settingsFor("lmStudio");
  settings.lmStudio.model = "gemma4-e4b-instruct-pure";
  settings.lmStudio.endpointMode = "chat";
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    return Response.json({
      choices: [body.reasoning_effort === "none"
        ? { finish_reason: "stop", message: { content: "오늘도 맑아." } }
        : { finish_reason: "length", message: { content: "", reasoning_content: "thinking" } }]
    });
  });

  const result = await translateSegment(settings, segment);
  assert.equal(result.translatedText, "오늘도 맑아.");
  const batch = await translateSegments(settings, segments);
  assert.equal(batch.translations.length, 2);
  assert.equal(requests.length, 3);
  for (const { url, body } of requests) {
    assert.match(url, /\/chat\/completions$/);
    assert.equal(body.reasoning_effort, "none");
  }
});

test("local lyric examples do not complete a fragment from the current subtitle", async (t) => {
  const settings = settingsFor("lmStudio");
  settings.lmStudio.model = "gemma4-e2b-instruct-pure";
  settings.contentMode = "lyrics";
  const full = "人が嫌いなあの子に気付けば子供ができた";
  const prompts = [];
  t.mock.method(globalThis, "fetch", async (_, init) => {
    const { messages } = JSON.parse(init.body);
    prompts.push(messages[0].content);
    const content = messages[0].content.includes(full) ? "어느새 아이가 생겼어" : "어느새 아이가";
    return Response.json({ choices: [{ message: { content } }] });
  });

  const fragment = await translateSegment(settings, { ...segment, text: "気付けば子供が" });
  assert.equal(fragment.translatedText, "어느새 아이가");
  await translateSegment(settings, { ...segment, text: full });
  assert.ok(prompts[1].includes(full));
});

test("local Gemma lyrics preserve leading English hooks verbatim", async (t) => {
  const settings = settingsFor("lmStudio");
  settings.lmStudio.model = "gemma4-e2b-instruct-pure";
  settings.contentMode = "lyrics";
  const input = "Oh, oh, あなたが呼ぶまで返事はしない。";
  const prompts = [];
  t.mock.method(globalThis, "fetch", async (_, init) => {
    const { messages } = JSON.parse(init.body);
    prompts.push(messages[1].content);
    const content = messages[1].content.includes("Oh, oh")
      ? "오, 오, 네가 부를 때까지 대답하지 않아."
      : "네가 부를 때까지 대답하지 않아.";
    return Response.json({ choices: [{ message: { content } }] });
  });

  const result = await translateSegment(settings, { ...segment, text: input });
  assert.equal(result.translatedText, "Oh, oh, 네가 부를 때까지 대답하지 않아.");
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes("あなたが呼ぶまで返事はしない。"));
});

test("local subtitle review receives the source and returns a validated correction", async (t) => {
  const source = { ...segment, source: "audioStt", text: "明日は会議に行きません。" };
  const correction = { decision: "correct", translation: "내일 회의에 가지 않을 거예요." };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, redirect: init.redirect, body });
    const content = JSON.stringify(correction);
    if (url.endsWith("/api/chat")) return Response.json({ message: { content } });
    if (url.endsWith("/responses")) return Response.json({ output_text: content });
    return Response.json({ choices: [{ message: { content } }] });
  });
  for (const [provider, endpoint] of [["lmStudio", "chat"], ["lmStudio", "responses"], ["ollama", "chat"]]) {
    const settings = settingsFor(provider);
    settings.lmStudio.model = endpoint === "responses" ? "local-translator" : "gemma4-e4b-instruct-pure";
    settings.lmStudio.endpointMode = endpoint;
    const result = await reviewLocalAudioTranslation(
      settings, source, "내일 회의에 갈 거예요.", undefined, new AbortController().signal
    );
    assert.deepEqual(result, correction);
  }
  assert.deepEqual(requests.map(({ redirect }) => redirect), ["error", "error", "error"]);
  assert.deepEqual(requests[0].body.response_format.json_schema.schema.properties.decision.enum, ["keep", "correct"]);
  assert.deepEqual(requests[2].body.format.properties.decision.enum, ["keep", "correct"]);
  const state = JSON.parse(requests[0].body.messages[1].content);
  assert.equal(state.source, source.text);
  assert.equal(state.translation, "내일 회의에 갈 거예요.");
});

test("LM Studio E2B Responses translates without reasoning and reviews with a JSON schema", async (t) => {
  const settings = settingsFor("lmStudio");
  settings.lmStudio.model = "gemma4-e2b-instruct-pure";
  settings.lmStudio.endpointMode = "responses";
  const source = { ...segment, source: "audioStt", text: "明日は会議に行きません。" };
  const correction = { decision: "correct", translation: "내일 회의에 가지 않을 거예요." };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (url.endsWith("/responses")) {
      const content = body.reasoning?.effort === "none" ? correction.translation : "Thinking Process:";
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: content }] }] });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(correction) } }] });
  });

  const translated = await translateSegment(settings, source);
  assert.equal(translated.translatedText, correction.translation);
  const review = await reviewLocalAudioTranslation(
    settings, source, "내일 회의에 갈 거예요.", undefined, new AbortController().signal
  );
  assert.deepEqual(review, correction);
  assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), ["/v1/responses", "/v1/chat/completions"]);
  assert.equal(requests[0].body.reasoning.effort, "none");
  assert.equal(requests[1].body.reasoning_effort, "none");
  assert.equal(requests[1].body.response_format.type, "json_schema");
});

test("subtitle review skips remote URLs and discards an invalid verdict", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    return Response.json({ choices: [{ message: { content: '{"decision":"correct","translation":42}' } }] });
  });
  const settings = settingsFor("lmStudio");
  settings.lmStudio.model = "gemma4-e4b-instruct-pure";
  const signal = new AbortController().signal;
  const remote = { ...settings, lmStudio: { ...settings.lmStudio, baseUrl: "https://example.test/v1" } };
  assert.equal(await reviewLocalAudioTranslation(remote, segment, "translation", undefined, signal), undefined);
  assert.equal(calls.length, 0);
  assert.equal(await reviewLocalAudioTranslation(settings, segment, "translation", undefined, signal), undefined);
  assert.equal(calls.length, 1);
});

test("cancelling the parent request cancels a pending local subtitle review", async (t) => {
  const calls = pendingFetch(t, "headers");
  const settings = settingsFor("lmStudio");
  settings.lmStudio.model = "gemma4-e4b-instruct-pure";
  const controller = new AbortController();
  const pending = reviewLocalAudioTranslation(settings, segment, "translation", undefined, controller.signal);
  await setImmediate();
  assert.equal(calls.length, 1);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls[0].signal.aborted, true);
});

test("lyric transcription uses the selected language and leaves automatic language detection available", async (t) => {
  const languages = [];
  t.mock.method(globalThis, "fetch", async (_, init) => {
    languages.push(init.body.get("language"));
    return Response.json({ text: "こんにちは" });
  });
  const settings = settingsFor("whisper", "stt");
  settings.contentMode = "lyrics";
  settings.sourceLanguage = "ja";
  await transcribeAudio(settings, audio, "audio/webm");
  settings.sourceLanguage = "auto";
  await transcribeAudio(settings, audio, "audio/webm");
  assert.deepEqual(languages, ["ja", null]);
});

function settingsFor(provider, kind = "translation") {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.openai.apiKey = "test-key";
  settings.apiStt.apiKey = "test-key";
  settings.lmStudio.tryStt = true;
  if (kind === "translation") settings.translationProvider = provider;
  else settings.sttProvider = provider;
  return settings;
}

function pendingFetch(t, phase) {
  const calls = [];
  t.mock.method(globalThis, "fetch", (url, init) => {
    const call = { url, signal: init.signal, bodyRead: false };
    calls.push(call);
    if (phase === "headers") {
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    const response = new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
      }
    }));
    const readBody = response.arrayBuffer.bind(response);
    response.arrayBuffer = () => {
      call.bodyRead = true;
      return readBody();
    };
    return Promise.resolve(response);
  });
  return calls;
}

const operations = [
  ...["openai", "ollama", "lmStudio"].map((provider) => ({
    name: `${provider} single translation`,
    run: (signal) => translateSegment(settingsFor(provider), segment, undefined, signal)
  })),
  ...["openai", "ollama", "lmStudio"].map((provider) => ({
    name: `${provider} batch translation`,
    run: (signal) => translateSegments(settingsFor(provider), segments, signal)
  })),
  ...["openai", "whisper", "lmStudio"].map((provider) => ({
    name: `${provider} transcription`,
    run: (signal) => transcribeAudio(settingsFor(provider, "stt"), audio, "audio/webm", signal)
  })),
  {
    name: "LM Studio model discovery",
    run: (signal) => {
      const settings = settingsFor("lmStudio");
      settings.lmStudio.model = "local-model";
      return translateSegment(settings, segment, undefined, signal);
    }
  },
  {
    name: "local health check",
    run: (signal) => assertTranscriptionReady(settingsFor("whisper", "stt"), signal)
  }
];

for (const phase of ["headers", "body"]) {
  for (const { name, run } of operations) {
    test(`${name} cancels delayed ${phase} without another request`, async (t) => {
      const calls = pendingFetch(t, phase);
      const controller = new AbortController();
      const reason = new DOMException("Session ended", "AbortError");
      const rejected = assert.rejects(run(controller.signal), (error) => error === reason);
      await setImmediate();
      if (phase === "body") assert.equal(calls[0].bodyRead, true);
      controller.abort(reason);
      await rejected;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].signal.aborted, true);
    });
  }
}

test("already cancelled provider calls do not fetch", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch");
  const reason = new DOMException("Session ended", "AbortError");
  for (const { run } of operations) {
    await assert.rejects(run(AbortSignal.abort(reason)), (error) => error === reason);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

for (const phase of ["headers", "body"]) {
  for (const [name, timeoutMs] of [
    ["openai batch translation", 60_000],
    ["LM Studio model discovery", 120_000],
    ["lmStudio transcription", 120_000],
    ["local health check", 45_000]
  ]) {
    test(`${name} deadline aborts delayed ${phase} without fallback`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const calls = pendingFetch(t, phase);
      const { run } = operations.find((operation) => operation.name === name);
      const rejected = assert.rejects(run(), { name: "TimeoutError" });
      await setImmediate();
      t.mock.timers.tick(timeoutMs - 1);
      assert.equal(calls[0].signal.aborted, false);
      t.mock.timers.tick(1);
      await rejected;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].signal.aborted, true);
    });
  }
}

test("ordinary batch failures still fall back to single translations", async (t) => {
  t.mock.method(console, "warn", () => {});
  let requests = 0;
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    choices: [{ message: { content: ++requests === 1 ? "invalid batch" : "안녕하세요." } }]
  }));
  const result = await translateSegments(settingsFor("openai"), segments);
  assert.equal(fetch.mock.callCount(), 3);
  assert.deepEqual(result.translations, segments.map(({ id }) => ({ id, translatedText: "안녕하세요." })));
});

test("ordinary LM Studio STT failures still use the configured Whisper fallback", async (t) => {
  t.mock.method(console, "warn", () => {});
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    return urls.length === 1
      ? Response.json({ error: "STT not supported" }, { status: 404 })
      : Response.json({ text: "こんにちは" });
  });
  const settings = settingsFor("lmStudio", "stt");
  assert.equal(await transcribeAudio(settings, audio, "audio/webm"), "こんにちは");
  assert.equal(urls.length, 2);
  assert.ok(urls[1].startsWith(settings.whisper.baseUrl));
});
