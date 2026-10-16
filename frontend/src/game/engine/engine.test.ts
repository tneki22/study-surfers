import assert from "node:assert/strict";
import test from "node:test";
import type { Distractor, QuizItem } from "../../api/types";
import { buildGate, distractorMix, pickDistractors, Playlist, selectItems } from "./playlist";
import { createRng } from "./random";
import { applyAnswer, comboMultiplier, comboTierStart, initialScore, isMilestone, nextComboAt, pointsForCorrect, scoreRules, starsFor } from "./scoring";
import { DEFAULT_SETTINGS, type SessionSettings } from "./settings";
import { answerSeconds, readingLength } from "./timing";

const rules = (difficulty: "easy" | "medium" | "hard") => scoreRules({ ...DEFAULT_SETTINGS, difficulty });
const FAR: Distractor[] = ["f1", "f2", "f3"].map((text) => ({ text, kind: "far", why_wrong: `${text}?` }));
const NEAR: Distractor[] = ["n1", "n2", "n3", "n4"].map((text) => ({ text, kind: "near", why_wrong: `${text}?` }));

function item(id: string, seq: number, extra: Partial<QuizItem> = {}): QuizItem {
  return {
    id,
    deck_id: "deck",
    question_id: null,
    seq,
    prompt: `Вопрос ${id}`,
    correct: `ok-${id}`,
    distractors: [...FAR, ...NEAR],
    explanation: "",
    source: "user_docs",
    evidence_quote: null,
    section: null,
    enabled: true,
    edited: false,
    stats: null,
    created_at: "",
    updated_at: "",
    ...extra,
  };
}

const settings = (patch: Partial<SessionSettings> = {}): SessionSettings => ({ ...DEFAULT_SETTINGS, ...patch });

test("сложность раскладывает далёкие и близкие варианты", () => {
  assert.deepEqual(distractorMix("easy", 3), { far: 2, near: 1 });
  assert.deepEqual(distractorMix("medium", 3), { far: 1, near: 2 });
  assert.deepEqual(distractorMix("hard", 3), { far: 0, near: 3 });
  assert.deepEqual(distractorMix("easy", 2), { far: 2, near: 0 });
  assert.deepEqual(distractorMix("medium", 2), { far: 1, near: 1 });
});

test("сложная берёт только близкие, лёгкая — один близкий", () => {
  const rng = createRng(1);
  const hard = pickDistractors([...FAR, ...NEAR], "hard", 3, rng);
  assert.equal(hard.length, 3);
  assert.ok(hard.every((d) => d.kind === "near"));
  const easy = pickDistractors([...FAR, ...NEAR], "easy", 3, rng);
  assert.equal(easy.filter((d) => d.kind === "near").length, 1);
  assert.equal(easy.filter((d) => d.kind === "far").length, 2);
});

test("нехватка пула добирается из другого вида", () => {
  const onlyNear = pickDistractors(NEAR.slice(0, 3), "easy", 3, createRng(2));
  assert.equal(onlyNear.length, 3);
  const fewNear = pickDistractors([...FAR, NEAR[0]], "hard", 3, createRng(3));
  assert.equal(fewNear.length, 3);
  assert.equal(fewNear[0].kind, "near");
});

test("ворота: верный ответ на одном треке, варианты уникальны", () => {
  for (let seed = 0; seed < 50; seed += 1) {
    const gate = buildGate(item("a", 1), 4, "medium", createRng(seed), "k");
    assert.equal(gate.options.length, 4);
    assert.equal(gate.options[gate.correctLane].kind, "correct");
    assert.equal(gate.options.filter((o) => o.kind === "correct").length, 1);
    assert.equal(new Set(gate.options.map((o) => o.text)).size, 4);
  }
});

test("верный ответ попадает на разные треки", () => {
  const lanes = new Set<number>();
  for (let seed = 0; seed < 40; seed += 1) lanes.add(buildGate(item("a", 1), 3, "easy", createRng(seed), "k").correctLane);
  assert.deepEqual([...lanes].sort(), [0, 1, 2]);
});

test("отбор карточек: выключенные и ответы ИИ по настройке", () => {
  const items = [item("a", 1), item("b", 2, { enabled: false }), item("c", 3, { source: "ai_knowledge" })];
  assert.deepEqual(selectItems(items, { includeAiItems: true, order: "program" }, createRng(1)).map((i) => i.id), ["a", "c"]);
  assert.deepEqual(selectItems(items, { includeAiItems: false, order: "program" }, createRng(1)).map((i) => i.id), ["a"]);
});

test("плейлист соблюдает лимит и догрузку", () => {
  const playlist = new Playlist(settings({ count: 10, order: "program" }), createRng(1), [item("a", 1), item("b", 2)]);
  assert.equal(playlist.next()?.item.id, "a");
  assert.equal(playlist.next()?.item.id, "b");
  assert.equal(playlist.next(), null);
  assert.ok(playlist.starving());
  assert.equal(playlist.append([item("b", 2), item("c", 3)]), 1, "дубли не добавляются");
  assert.equal(playlist.next()?.item.id, "c");

  const limited = new Playlist(settings({ count: 10, order: "program" }), createRng(1),
    Array.from({ length: 15 }, (_, i) => item(`i${i}`, i + 1)));
  let served = 0;
  while (limited.next()) served += 1;
  assert.equal(served, 10);
  assert.ok(!limited.starving());
});

test("ошибка возвращается через 3–5 вопросов один раз", () => {
  const items = Array.from({ length: 12 }, (_, i) => item(`i${i}`, i + 1));
  const playlist = new Playlist(settings({ count: "all", order: "program", retryMistakes: true }), createRng(7), items);
  const first = playlist.next()!;
  playlist.reportMistake(first.item);
  playlist.reportMistake(first.item);
  const order: string[] = [];
  let gate;
  while ((gate = playlist.next())) order.push(gate.item.id + (gate.retry ? "*" : ""));
  const retryAt = order.indexOf("i0*");
  assert.ok(retryAt >= 2 && retryAt <= 4, `повтор на позиции ${retryAt + 1}`);
  assert.equal(order.filter((id) => id === "i0*").length, 1);
});

test("без повтора ошибок карточка не возвращается", () => {
  const playlist = new Playlist(settings({ order: "program" }), createRng(1), [item("a", 1), item("b", 2)]);
  playlist.reportMistake(playlist.next()!.item);
  assert.equal(playlist.next()?.item.id, "b");
  assert.equal(playlist.next(), null);
});

test("порядок программы использует номер вопроса, а не порядок готовности", () => {
  const items = [item("late", 1, { question_ordinal: 2 }), item("early2", 2, { question_ordinal: 1 }), item("early1", 3, { question_ordinal: 1 }), item("ungrouped", 4)];
  const playlist = new Playlist(settings({ order: "program" }), createRng(1), items);
  assert.deepEqual(Array.from({ length: 4 }, () => playlist.next()!.item.id), ["early2", "early1", "late", "ungrouped"]);
});

test("новые пачки перемешиваются со всеми ещё не выданными карточками", () => {
  let mixed = 0;
  for (let seed = 0; seed < 100; seed++) {
    const playlist = new Playlist(settings({ count: "all", order: "shuffle" }), createRng(seed), Array.from({ length: 6 }, (_, i) => item(`old${i}`, i + 1)));
    const first = playlist.next()!;
    playlist.append(Array.from({ length: 6 }, (_, i) => item(`new${i}`, i + 7)));
    const rest = Array.from({ length: 11 }, () => playlist.next()!.item.id);
    assert.equal(new Set([first.item.id, ...rest]).size, 12);
    if (rest.slice(0, 5).some(id => id.startsWith("new"))) mixed++;
  }
  assert.ok(mixed > 90, `${mixed} из 100 очередей перемешаны`);
});

test("дубли внутри одной пачки игнорируются", () => {
  const playlist = new Playlist(settings(), createRng(1), [item("a", 1), item("a", 1)]);
  assert.equal(playlist.next()!.item.id, "a");
  assert.equal(playlist.next(), null);
});

test("повтор ошибки не выскакивает сразу, если забег уже заканчивается", () => {
  const playlist = new Playlist(settings({ count: "all", retryMistakes: true }), createRng(1), [item("a", 1)]);
  playlist.reportMistake(playlist.next()!.item);
  assert.equal(playlist.hasNext(), false);
  assert.equal(playlist.next(), null);
  assert.equal(playlist.plannedTotal(), 1);
  // При живой догрузке повтор снова возможен после достаточного числа новых вопросов.
  playlist.append(Array.from({ length: 6 }, (_, i) => item(`b${i}`, i + 2)));
  const gates = [];
  let next;
  while ((next = playlist.next())) gates.push(next);
  const retryAt = gates.findIndex(g => g.retry);
  assert.ok(retryAt >= 3 && retryAt <= 5);
});

test("комбо и очки", () => {
  assert.equal(comboMultiplier(2), 1);
  assert.equal(comboMultiplier(3), 2);
  assert.equal(comboMultiplier(4), 2);
  assert.equal(comboMultiplier(5), 3);
  assert.equal(comboMultiplier(8), 4);
  assert.equal(comboMultiplier(11), 4);
  assert.equal(comboMultiplier(12), 5);
  assert.equal(comboMultiplier(30), 5);
  assert.equal(nextComboAt(0), 3);
  assert.equal(nextComboAt(4), 5);
  assert.equal(nextComboAt(8), 12);
  assert.equal(nextComboAt(12), null);
  assert.equal(comboTierStart(4), 3);
  assert.equal(comboTierStart(2), 0);
  assert.equal(pointsForCorrect(1, 1, 0), 100);
  assert.equal(pointsForCorrect(1, 1, 1), 150);
  assert.equal(pointsForCorrect(3, 1.5, 0), 300);
});

test("цена очков зависит от сложности, темпа и числа треков", () => {
  assert.deepEqual(rules("medium"), { factor: 1.25, penalty: 63 });
  assert.deepEqual(rules("easy"), { factor: 1, penalty: 50 });
  const hardest = scoreRules({ ...DEFAULT_SETTINGS, difficulty: "hard", pace: "fast", lanes: 4 });
  assert.ok(Math.abs(hardest.factor - 1.5 * 1.15 * 1.1) < 1e-9);
  assert.equal(scoreRules({ ...DEFAULT_SETTINGS, difficulty: "easy", pace: "calm" }).factor, 0.9);
  assert.equal(scoreRules({ ...DEFAULT_SETTINGS, difficulty: "easy", pace: "custom", customSeconds: 4 }).factor, 1.15);
  assert.equal(scoreRules({ ...DEFAULT_SETTINGS, difficulty: "easy", pace: "custom", customSeconds: 12 }).factor, 0.9);
});

test("ошибка: штраф не уводит в минус, серия и жизнь теряются", () => {
  let state = initialScore(3);
  state = applyAnswer(state, true, rules("medium"), 1).state;
  assert.equal(state.score, 175);
  const wrong = applyAnswer(state, false, rules("medium"), 0);
  assert.equal(wrong.delta, -63);
  assert.equal(wrong.state.streak, 0);
  assert.equal(wrong.state.lives, 2);
  const broke = applyAnswer(initialScore(0), false, rules("easy"), 0);
  assert.equal(broke.state.score, 0);
  assert.equal(broke.state.lives, null);
});

test("комбо растёт на третьем верном подряд", () => {
  let state = initialScore(0);
  const outcomes = [1, 2, 3].map(() => {
    const outcome = applyAnswer(state, true, rules("easy"), 0);
    state = outcome.state;
    return outcome.comboUp;
  });
  assert.deepEqual(outcomes, [false, false, true]);
  assert.equal(state.maxStreak, 3);
  assert.equal(applyAnswer(state, false, rules("easy"), 0).lostStreak, 3);
});

test("бонус серии на 10, 15, 20 верных подряд", () => {
  let state = initialScore(0);
  const bonuses: number[] = [];
  for (let i = 1; i <= 20; i += 1) {
    const outcome = applyAnswer(state, true, rules("hard"), 0);
    state = outcome.state;
    if (outcome.bonus) bonuses.push(i);
    if (i === 10) assert.equal(outcome.delta, pointsForCorrect(10, 1.5, 0) + 300);
  }
  assert.deepEqual(bonuses, [10, 15, 20]);
  assert.equal(isMilestone(25), true);
  assert.equal(isMilestone(5), false);
});

test("время на вопрос растёт с длиной текста в пределах темпа", () => {
  const short = answerSeconds("Чему равно $1+1$?", ["2", "3", "4"], "normal", 8);
  const long = answerSeconds("Очень длинный вопрос ".repeat(10), ["вариант ответа номер один", "вариант два", "три"], "normal", 8);
  assert.equal(short, 5);
  assert.equal(long, 10);
  assert.equal(answerSeconds("x", [], "custom", 13), 13);
  assert.equal(answerSeconds("x", [], "custom", 40), 20);
  assert.ok(answerSeconds("x", [], "calm", 0) >= 8);
});

test("длина формулы считается по смыслу, а не по разметке", () => {
  assert.equal(readingLength("$x$"), 1);
  assert.equal(readingLength("$\\frac{a}{b}$"), 4);
});

test("звёзды по точности", () => {
  assert.equal(starsFor(9, 10), 3);
  assert.equal(starsFor(7, 10), 2);
  assert.equal(starsFor(4, 10), 1);
  assert.equal(starsFor(1, 10), 0);
  assert.equal(starsFor(0, 0), 0);
});
