import assert from "node:assert/strict";
import test from "node:test";
import { loadItemPages } from "./itemPages";
import type { ItemsPage, QuizItem } from "./types";

const cards = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `q${from + i}`, seq: from + i }) as QuizItem);

test("загрузка читает больше 500 карточек, сохраняя фильтр и курсор", async () => {
  const queries: { since?: number; filter?: string }[] = [];
  const page = await loadItemPages(async (_deck, query) => {
    queries.push(query);
    const items = query.since ? cards(501, 101) : cards(1, 500);
    return { items, next_since: items.at(-1)!.seq, total_ready: 601, job_active: false };
  }, "deck", { filter: "weak" });
  assert.equal(page.items.length, 601);
  assert.equal(page.next_since, 601);
  assert.deepEqual(queries.map(q => [q.since, q.filter]), [[0, "weak"], [500, "weak"]]);
});

test("последний опрос дочитывает все страницы после завершения генерации", async () => {
  const pages: ItemsPage[] = [
    { items: cards(8, 2), next_since: 9, total_ready: 11, job_active: false },
    { items: cards(10, 2), next_since: 11, total_ready: 11, job_active: false },
    { items: [], next_since: 11, total_ready: 11, job_active: false },
  ];
  const cursors: number[] = [];
  const page = await loadItemPages(async (_deck, query) => {
    cursors.push(query.since!);
    return pages.shift()!;
  }, "deck", { since: 7, filter: "last_mistakes", limit: 2 });
  assert.deepEqual(cursors, [7, 9, 11]);
  assert.equal(page.items.length, 4);
  assert.equal(page.job_active, false);
});

test("застрявший курсор и отмена не запускают бесконечную загрузку", async () => {
  await assert.rejects(loadItemPages(async () => ({ items: cards(1, 2), next_since: 0, total_ready: 2, job_active: false }), "deck", { limit: 2 }), /курсор/);
  let stopped = false;
  let calls = 0;
  await assert.rejects(loadItemPages(async () => {
    calls++;
    stopped = true;
    return { items: cards(1, 2), next_since: 2, total_ready: 2, job_active: false };
  }, "deck", { limit: 2 }, () => stopped), { name: "AbortError" });
  assert.equal(calls, 1);
});
