import assert from "node:assert/strict";
import test from "node:test";
import { analysisLabel, byTopics, foundLine } from "./importSteps";

test("until roles are known the step stays generic", () => {
  assert.equal(analysisLabel([]), "Разбираю материал");
  assert.equal(analysisLabel([{ filename: "a.pdf", role: null }]), "Разбираю материал");
  assert.equal(foundLine([{ filename: "a.pdf", role: "notes" }, { filename: "b.pdf", role: null }]), null);
});

test("notes alone are split into topics", () => {
  const sources = [{ filename: "ЛР5.pdf", role: "notes" as const }];
  assert.equal(analysisLabel(sources), "Делю конспект на темы");
  assert.equal(byTopics(sources), true);
  assert.equal(foundLine(sources), "Нашёл: ЛР5.pdf — конспект");
});

test("answers without a question list behave like notes", () => {
  const sources = [{ filename: "ответы.pdf", role: "answers" as const }];
  assert.equal(analysisLabel(sources), "Делю конспект на темы");
  assert.equal(foundLine(sources), "Нашёл: ответы.pdf — конспект");
});

test("questions with answers and notes are listed together", () => {
  const sources = [
    { filename: "билеты.pdf", role: "questions" as const },
    { filename: "ответы.pdf", role: "answers" as const },
    { filename: "лекции.pdf", role: "notes" as const },
  ];
  assert.equal(analysisLabel(sources), "Нахожу вопросы, сопоставляю ответы и делю конспект на темы");
  assert.equal(byTopics(sources), false);
  assert.equal(analysisLabel(sources.slice(0, 1)), "Нахожу вопросы");
  assert.equal(analysisLabel([{ filename: "всё.docx", role: "combined" }]), "Разбираю вопросы с ответами");
});
