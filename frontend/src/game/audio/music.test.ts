import assert from "node:assert/strict";
import test from "node:test";
import { Music } from "./music";

function setup() {
  const sources: { started: boolean; stopAt: number | null; loop: boolean; loopEnd: number }[] = [];
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => { resolve = done; });
  const tone = { type: "", frequency: { setTargetAtTime() {} }, connect() {}, disconnect() {} };
  const ctx = {
    currentTime: 10,
    createBiquadFilter: () => tone,
    decodeAudioData: async () => ({ duration: 65.085 }),
    createBufferSource: () => {
      const source = { started: false, stopAt: null as number | null, loop: false, loopEnd: 0,
        connect() {}, disconnect() {}, start() { this.started = true; }, stop(at: number) { this.stopAt = at; } };
      sources.push(source);
      return source;
    },
  };
  const music = new Music({ ctx: ctx as unknown as AudioContext, musicOut: {} as GainNode, fadeMusic() {} }, "sunline");
  return { music, sources, pending, ready: () => resolve(new Response(new ArrayBuffer(8))) };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("музыка: остановка до загрузки не включает звук после ответа сети", async (t) => {
  const { music, sources, pending, ready } = setup();
  t.mock.method(globalThis, "fetch", () => pending);
  music.start();
  music.stop();
  ready();
  await flush();
  assert.equal(music.playing, false);
  assert.equal(sources.length, 0);
});

test("музыка: быстрый перезапуск использует один источник и бесшовную петлю", async (t) => {
  const { music, sources, pending, ready } = setup();
  const fetchMock = t.mock.method(globalThis, "fetch", () => pending);
  music.start(); music.stop(0); music.start(1); music.start(2);
  ready();
  await flush();
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].started, true);
  assert.equal(sources[0].loop, true);
  assert.ok(Math.abs(sources[0].loopEnd - 128 * 60 / 118) < .001);
  music.stop(.6);
  assert.equal(sources[0].stopAt, 10.6);
});

test("музыка: уход с экрана во время загрузки отменяет запрос и запуск", async (t) => {
  const { music, sources, pending, ready } = setup();
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return pending;
  });
  music.start(); music.dispose(); music.start(1);
  assert.equal(signal?.aborted, true);
  ready(); await flush();
  assert.equal(sources.length, 0);
  assert.equal(music.playing, false);
});
