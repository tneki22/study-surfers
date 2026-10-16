import assert from "node:assert/strict";
import test from "node:test";
import type { DeckSummary } from "../api/types";
import { selectRecentProject } from "./recentProject";

const deck = (id: string, patch: Partial<DeckSummary> = {}): DeckSummary => ({
  id, title: id, status: "ready", active_job_id: null, source_kind: "upload",
  item_count: 12, enabled_item_count: 12, question_count: 4, runs_count: 0,
  best_score: null, last_played_at: null, weak_count: 0,
  created_at: "2026-10-14T10:00:00Z", updated_at: "2026-10-14T10:00:00Z", ...patch,
});

test("последняя открытая колода важнее последнего забега и порядка списка", () => {
  const opened = deck("opened");
  assert.equal(selectRecentProject([
    deck("played", { last_played_at: "2026-10-14T12:00:00Z" }), opened,
  ], "opened"), opened);
});

test("до первого открытия или после удаления предлагаем последний сыгранный проект", () => {
  const lastPlayed = deck("played", { last_played_at: "2026-10-14T11:00:00Z" });
  const decks = [deck("new", { updated_at: "2026-10-14T12:00:00Z" }), lastPlayed,
    deck("older", { last_played_at: "2026-10-14T09:00:00Z" })];
  assert.equal(selectRecentProject(decks, null), lastPlayed);
  assert.equal(selectRecentProject(decks, "deleted"), lastPlayed);
});

test("пустые колоды не вытесняют доступный забег, но открытая пустая колода остаётся последней", () => {
  const empty = deck("empty", { enabled_item_count: 0, updated_at: "2026-10-14T12:00:00Z" });
  const ready = deck("ready");
  assert.equal(selectRecentProject([empty, ready], null), ready);
  assert.equal(selectRecentProject([empty, ready], "empty"), empty);
});

test("без забегов берём недавно обновлённую колоду; без колод возвращаем пустое состояние", () => {
  const newest = deck("newest", { updated_at: "2026-10-14T12:00:00Z" });
  assert.equal(selectRecentProject([deck("old"), newest], null), newest);
  assert.equal(selectRecentProject([], "deleted"), null);
});
