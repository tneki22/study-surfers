import assert from "node:assert/strict";
import test from "node:test";
import type { RunIn } from "../api/types";
import { createRunLog } from "./pendingRuns";

const run = (id: string) => ({ id, deck_id: "deck" } as RunIn);
function setup() {
  let value = "[]";
  return { storage: () => ({ getItem: () => value, setItem: (_key: string, next: string) => { value = next; } }),
    ids: () => (JSON.parse(value) as RunIn[]).map((entry) => entry.id) };
}

test("результат лежит в очереди ещё до ответа сервера и переживает закрытие окна", async () => {
  const state = setup();
  let resolve!: () => void;
  const log = createRunLog(() => new Promise<void>((done) => { resolve = done; }), state.storage);
  const saving = log.submitRun(run("new"));
  assert.deepEqual(state.ids(), ["new"]);
  await Promise.resolve();
  resolve();
  assert.equal(await saving, "saved");
  assert.deepEqual(state.ids(), []);
});

test("отправка старой очереди сохраняет добавленный в это время забег", async () => {
  const state = setup();
  const offline = createRunLog(async () => { throw new Error("offline"); }, state.storage);
  await offline.submitRun(run("old"));
  let resolve!: () => void;
  const log = createRunLog(() => new Promise<void>((done) => { resolve = done; }), state.storage);
  const flushing = log.flushPendingRuns();
  await offline.submitRun(run("new"));
  resolve();
  await flushing;
  assert.deepEqual(state.ids(), ["new"]);
});

test("два параллельных повтора не дублируют запрос и не теряют очередь при ошибке", async () => {
  const state = setup();
  const offline = createRunLog(async () => { throw new Error("offline"); }, state.storage);
  await offline.submitRun(run("old"));
  let reject!: (reason: Error) => void;
  let calls = 0;
  const log = createRunLog(() => { calls += 1; return new Promise<void>((_done, fail) => { reject = fail; }); }, state.storage);
  const one = log.flushPendingRuns();
  const two = log.flushPendingRuns();
  await Promise.resolve();
  assert.equal(calls, 1);
  reject(new Error("offline"));
  await Promise.all([one, two]);
  assert.deepEqual(state.ids(), ["old"]);
  const retry = createRunLog(async () => {}, state.storage);
  await retry.flushPendingRuns();
  assert.deepEqual(state.ids(), []);
});
