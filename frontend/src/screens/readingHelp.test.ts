import assert from "node:assert/strict";
import test from "node:test";
import { readingRecovery, warningLocation } from "./readingHelp";
import type { JobWarning } from "../api/types";

const warning = (context: JobWarning["context"] = {}): JobWarning => ({ code: "pdf_no_text_layer", message: "Не удалось прочитать текст", context });

test("reading problems offer OCR and another model, including older jobs", () => {
  const result = readingRecovery([warning()])!;
  assert.equal(result.steps.length, 2);
  assert.match(result.steps[0], /OCR/);
  assert.match(result.steps[1], /другую модель/);
  assert.match(result.formulaHelp, /LaTeX/);
  assert.equal(readingRecovery([{ code: "questions_without_answer", message: "Нет ответов", context: {} }]), null);
});

test("file locations are independent for repeated warning codes", () => {
  assert.equal(warningLocation(warning({ filename: "скан.pdf", pages: [1, 2] })), "скан.pdf · стр. 1, 2");
  assert.equal(warningLocation(warning({ filename: "второй.pdf", pages: [4] })), "второй.pdf · стр. 4");
  assert.equal(warningLocation(warning({ pages: [null, "2", -1, 3] })), "стр. 3");
});

test("reading help from the backend is shared once for multiple problems", () => {
  const result = readingRecovery([warning({ recovery_steps: ["OCR", "Другая модель"], formula_help: "Сохраните индексы" }), warning()]);
  assert.deepEqual(result, { steps: ["OCR", "Другая модель"], formulaHelp: "Сохраните индексы" });
});
