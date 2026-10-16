import assert from "node:assert/strict";
import test from "node:test";
import type { DeckSummary, Job } from "../api/types";
import { generationSummary, loadGenerationTasks, type GenerationTask } from "./generationTasks";

const job = (id: string, patch: Partial<Job> = {}): Job => ({
  id, deck_id: "math", kind: "quick_import", state: "generating", stage_label: "Генерация",
  done: 12, total: 30, ready_items: 48, failed_questions: 0, can_play: true,
  warnings: [], error: null, estimate: null,
  usage: { input_tokens: 0, output_tokens: 0, cost_usd: null }, sources: [],
  created_at: "2026-10-14T10:00:00Z", finished_at: null, ...patch,
});
const deck = (id: string, active: boolean): DeckSummary => ({
  id, title: id, active_job_id: active ? `${id}-job` : null, status: active ? "generating" : "ready",
  source_kind: "upload", item_count: 48, enabled_item_count: 48, question_count: 30,
  runs_count: 0, best_score: null, last_played_at: null, weak_count: 0,
  created_at: "2026-10-14T10:00:00Z", updated_at: "2026-10-14T10:00:00Z",
});
const task: GenerationTask = { deckId: "math", title: "Математика", jobs: [job("one")], stale: false };

test("ожидание модели через MCP остаётся активной задачей в шапке", async () => {
  const tasks = await loadGenerationTasks({
    listDecks: async () => [deck("math", true)],
    listDeckJobs: async () => [job("chat", { state: "awaiting_executor" })],
  });
  assert.equal(tasks.length, 1);
  assert.equal(generationSummary(tasks[0]).label, "Ожидаю модель через MCP");
});

test("шапка находит фоновые задачи и убирает завершённые между запросами", async () => {
  const queried: string[] = [];
  const tasks = await loadGenerationTasks({
    listDecks: async () => [deck("math", true), deck("history", true), deck("ready", false)],
    listDeckJobs: async (id, active) => {
      queried.push(id);
      assert.equal(active, true);
      return [job(id, { state: id === "math" ? "generating" : "done" })];
    },
  });
  assert.deepEqual(queried, ["math", "history"]);
  assert.deepEqual(tasks.map((entry) => entry.deckId), ["math"]);
});

test("ошибка обновления предмета сохраняет прогресс и не скрывает остальные задачи", async () => {
  const tasks = await loadGenerationTasks({
    listDecks: async () => [deck("math", true), deck("history", true)],
    listDeckJobs: async (id) => {
      if (id === "math") throw new Error("offline");
      return [job("history")];
    },
  }, [task]);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].stale, true);
  assert.equal(tasks[0].jobs[0].done, 12);
  assert.equal(tasks[1].stale, false);
});

test("параллельные задачи суммируют вопросы, не дублируют карточки и ведут к подтверждению", () => {
  const summary = generationSummary({ ...task, jobs: [
    job("running", { done: 1, total: 3 }),
    job("confirm", { done: 0, total: 1, state: "awaiting_confirm" }),
  ] });
  assert.equal(summary.done, 1);
  assert.equal(summary.total, 4);
  assert.equal(summary.cards, 48);
  assert.equal(summary.awaitingConfirm, true);
  assert.equal(summary.jobId, "confirm");
});
