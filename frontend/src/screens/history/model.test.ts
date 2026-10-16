import assert from "node:assert/strict";
import test from "node:test";
import type { DeckSummary, QuizItem, RunSettings, RunSummary } from "../../api/types";
import { parseItemsFilter } from "../../game/engine/settings";
import {
  NO_TOPIC,
  accuracy,
  decksWithRuns,
  describePace,
  filterDecks,
  formatDuration,
  frequentMistakes,
  groupRunsByDay,
  historySearch,
  itemAccuracy,
  mergeRunPages,
  percent,
  readHistoryView,
  resolveSelectedDeck,
  settingFacts,
  topicRows,
} from "./model";

const deck = (id: string, title: string, runs: number, last: string | null): DeckSummary => ({
  id,
  title,
  status: "ready",
  source_kind: "upload",
  item_count: 10,
  enabled_item_count: 10,
  question_count: 5,
  active_job_id: null,
  runs_count: runs,
  best_score: runs ? 100 : null,
  last_played_at: last,
  weak_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

const settings: RunSettings = { lanes: 3, difficulty: "medium", filter: "all", pace: "normal", lives: null, world: "classic", obstacles: "normal" };

const run = (id: string, finishedAt: Date): RunSummary => ({
  id,
  deck_id: "d",
  settings,
  score: 100,
  distance: 500,
  max_streak: 3,
  correct_count: 5,
  wrong_count: 1,
  duration_ms: 60_000,
  started_at: new Date(finishedAt.getTime() - 60_000).toISOString(),
  finished_at: finishedAt.toISOString(),
});

function card(id: string, seq: number, seen: number, correct: number, extra: Partial<QuizItem> = {}): QuizItem {
  return {
    id,
    deck_id: "d",
    question_id: null,
    question_ordinal: null,
    seq,
    prompt: id,
    correct: "ответ",
    distractors: [],
    explanation: "",
    source: "user_docs",
    evidence_quote: null,
    section: null,
    enabled: true,
    edited: false,
    stats: { seen, correct, streak: 0, last_wrong_at: null },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

test("адрес: значения по умолчанию не попадают в строку и читаются обратно", () => {
  assert.equal(historySearch({ deck: "a" }), "?deck=a");
  assert.equal(historySearch({ deck: "a", tab: "analytics" }), "?deck=a&tab=analytics");
  assert.equal(historySearch({ deck: "a", tab: "runs", run: "r1" }), "?deck=a&run=r1");
  assert.equal(historySearch({}), "");
  // На вкладке «Аналитика» раскрытого забега нет.
  assert.equal(historySearch({ deck: "a", tab: "analytics", run: "r1" }), "?deck=a&tab=analytics");

  assert.deepEqual(readHistoryView(new URLSearchParams("deck=a&run=r1")), { deck: "a", tab: "runs", run: "r1" });
  assert.deepEqual(readHistoryView(new URLSearchParams("deck=a&tab=analytics&run=r1")), { deck: "a", tab: "analytics", run: null });
  assert.deepEqual(readHistoryView(new URLSearchParams("tab=мусор&deck=")), { deck: null, tab: "runs", run: null });
});

test("колоды: только с забегами, последняя сыгранная первой, поиск без учёта регистра и ё", () => {
  const decks = [
    deck("old", "Алгебра", 2, "2026-10-01T10:00:00Z"),
    deck("never", "Пустая", 0, null),
    deck("new", "Ёлка и Физика", 1, "2026-10-13T10:00:00Z"),
  ];
  assert.deepEqual(decksWithRuns(decks).map((d) => d.id), ["new", "old"]);
  assert.deepEqual(filterDecks(decksWithRuns(decks), "  ЕЛКА ").map((d) => d.id), ["new"]);
  assert.deepEqual(filterDecks(decksWithRuns(decks), "физ").map((d) => d.id), ["new"]);
  assert.deepEqual(filterDecks(decksWithRuns(decks), "").map((d) => d.id), ["new", "old"]);
  assert.deepEqual(filterDecks(decksWithRuns(decks), "нет такой"), []);
});

test("выбранная колода: из адреса; иначе первая на широком экране и никакой на узком", () => {
  const decks = decksWithRuns([deck("a", "A", 1, "2026-10-02T00:00:00Z"), deck("b", "B", 1, "2026-10-01T00:00:00Z")]);
  assert.equal(resolveSelectedDeck(decks, "b", true)?.id, "b");
  assert.equal(resolveSelectedDeck(decks, "b", false)?.id, "b");
  assert.equal(resolveSelectedDeck(decks, null, true)?.id, "a");
  assert.equal(resolveSelectedDeck(decks, null, false), null);
  assert.equal(resolveSelectedDeck(decks, "удалена", true)?.id, "a");
  assert.equal(resolveSelectedDeck(decks, "удалена", false), null);
  assert.equal(resolveSelectedDeck([], null, true), null);
});

test("точность: без ответов нет значения и нет деления на ноль", () => {
  assert.equal(accuracy(0, 0), null);
  assert.equal(percent(accuracy(0, 0)), "—");
  assert.equal(accuracy(3, 1), 0.75);
  assert.equal(percent(accuracy(3, 1)), "75 %");
  assert.equal(percent(accuracy(0, 4)), "0 %");
  assert.equal(itemAccuracy({ seen: 0, errors: 0 }), null);
  assert.equal(itemAccuracy({ seen: 4, errors: 1 }), 0.75);
});

test("страницы забегов склеиваются без повторов при сдвиге архива", () => {
  const now = new Date(2026, 9, 14, 12);
  const a = run("a", now);
  const b = run("b", now);
  const c = run("c", now);
  assert.deepEqual(mergeRunPages([a, b], [b, c]).map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(mergeRunPages([], [a]).map((r) => r.id), ["a"]);
  assert.deepEqual(mergeRunPages([a], []).map((r) => r.id), ["a"]);
});

test("забеги группируются по локальным дням: сегодня, вчера, раньше", () => {
  const now = new Date(2026, 9, 14, 15, 0);
  const runs = [
    run("t1", new Date(2026, 9, 14, 14, 30)),
    run("t2", new Date(2026, 9, 14, 0, 5)),
    run("y1", new Date(2026, 9, 13, 23, 55)),
    run("o1", new Date(2026, 8, 30, 10, 0)),
    run("o2", new Date(2025, 11, 31, 10, 0)),
  ];
  const days = groupRunsByDay(runs, now);
  assert.deepEqual(days.map((d) => d.runs.map((r) => r.id)), [["t1", "t2"], ["y1"], ["o1"], ["o2"]]);
  assert.equal(days[0].label, "Сегодня");
  assert.equal(days[1].label, "Вчера");
  assert.match(days[2].label, /30 сентября/);
  assert.doesNotMatch(days[2].label, /2026/);
  assert.match(days[3].label, /31 декабря 2025/);
  assert.deepEqual(groupRunsByDay([], now), []);
});

test("длительность: секунды, минуты, часы", () => {
  assert.equal(formatDuration(0), "0 с");
  assert.equal(formatDuration(45_400), "45 с");
  assert.equal(formatDuration(192_000), "3 мин 12 с");
  assert.equal(formatDuration(3_900_000), "1 ч 05 мин");
});

test("сохранённые настройки: темп, фильтр, жизни", () => {
  assert.equal(describePace("normal"), "Обычный");
  assert.equal(describePace("custom:8"), "Свой: 8 с");
  assert.equal(describePace("custom"), "Свой");
  assert.equal(describePace(1.5), "скорость 1.5");
  assert.equal(describePace("что-то новое"), "что-то новое");
  assert.equal(describePace("toString"), "toString");
  const facts = Object.fromEntries(settingFacts({ ...settings, filter: "last_mistakes", lives: 3 }).map((f) => [f.label, f.value]));
  assert.equal(facts["Какие карточки"], "Ошибки прошлого забега");
  assert.equal(facts["Жизни"], "3");
  assert.equal(facts["Сложность"], "Средняя");
  assert.equal(Object.fromEntries(settingFacts(settings).map((f) => [f.label, f.value]))["Жизни"], "выключены");
});

test("частые ошибки: seen − correct, затем доля ошибок, затем порядок карточки", () => {
  const items = [
    card("мало-ошибок", 1, 2, 1),
    card("шесть-из-восьми", 2, 8, 2),
    card("шесть-из-десяти", 3, 10, 4),
    card("три-из-четырёх-поздняя", 9, 4, 1),
    card("три-из-четырёх-ранняя", 4, 4, 1),
    card("три-из-шести", 5, 6, 3),
    card("без-ошибок", 6, 5, 5),
    card("не-показывалась", 7, 0, 0),
    card("выключена", 8, 9, 0, { enabled: false }),
    card("без-статистики", 10, 0, 0, { stats: null }),
  ];
  assert.deepEqual(frequentMistakes(items).map((m) => m.item.id), [
    "шесть-из-восьми",
    "шесть-из-десяти",
    "три-из-четырёх-ранняя",
    "три-из-четырёх-поздняя",
    "три-из-шести",
    "мало-ошибок",
  ]);
  assert.deepEqual(frequentMistakes(items).slice(0, 2).map((m) => [m.errors, m.seen]), [[6, 8], [6, 10]]);
});

test("частые ошибки: при равенстве решает порядок вопросов программы, карточки без вопроса — в конце", () => {
  const items = [
    card("без-вопроса", 1, 2, 1),
    card("второй-вопрос", 2, 2, 1, { question_ordinal: 2 }),
    card("первый-вопрос-поздняя", 5, 2, 1, { question_ordinal: 1 }),
    card("первый-вопрос-ранняя", 3, 2, 1, { question_ordinal: 1 }),
  ];
  assert.deepEqual(frequentMistakes(items).map((m) => m.item.id), [
    "первый-вопрос-ранняя",
    "первый-вопрос-поздняя",
    "второй-вопрос",
    "без-вопроса",
  ]);
});

test("частые ошибки: пустой список, нули и испорченная статистика не ломают расчёт", () => {
  assert.deepEqual(frequentMistakes([]), []);
  assert.deepEqual(frequentMistakes([card("a", 1, 0, 0)]), []);
  // Верных больше, чем показов, — ошибок «минус», карточку не показываем.
  assert.deepEqual(frequentMistakes([card("a", 1, 2, 5)]), []);
});

test("темы: от слабой к сильной, безымянная — «Без темы»", () => {
  const rows = topicRows([
    { section: "Пределы", accuracy: 0.9, count: 4 },
    { section: null, accuracy: 0.5, count: 2 },
    { section: "Ряды", accuracy: 0.5, count: 7 },
    { section: "  ", accuracy: 0, count: 1 },
  ]);
  assert.deepEqual(rows.map((r) => [r.label, r.accuracy]), [
    [NO_TOPIC, 0],
    ["Ряды", 0.5],
    [NO_TOPIC, 0.5],
    ["Пределы", 0.9],
  ]);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
  assert.deepEqual(topicRows([]), []);
});

test("фильтр из адреса настроек: допустимые значения и ничего больше", () => {
  assert.equal(parseItemsFilter("weak"), "weak");
  assert.equal(parseItemsFilter("last_mistakes"), "last_mistakes");
  assert.equal(parseItemsFilter("all"), "all");
  assert.equal(parseItemsFilter("hard"), null);
  assert.equal(parseItemsFilter(""), null);
  assert.equal(parseItemsFilter(null), null);
});
