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
const { assertTranscriptionReady, transcribeAudio, translateSegment, translateSegments } =
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
