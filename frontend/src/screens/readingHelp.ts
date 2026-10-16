import type { JobWarning } from "../api/types";

const READING_CODES = new Set([
  "pdf_no_text_layer", "pdf_text_incomplete", "pdf_formulas_need_review",
  "document_no_text", "document_text_unreadable", "document_images_skipped",
  "formulas_invalid", "source_requires_review",
]);

export function isReadingWarning(warning: JobWarning): boolean {
  return READING_CODES.has(warning.code);
}

export function warningLocation(warning: JobWarning): string {
  const { filename, pages } = warning.context ?? {};
  const name = typeof filename === "string" ? filename : "";
  const numbers = Array.isArray(pages) ? pages.filter((page) => Number.isInteger(page) && page > 0) : [];
  // Длинные списки не заслоняют объяснение; все страницы видны в title.
  const pageLabel = numbers.length ? `стр. ${numbers.slice(0, 12).join(", ")}${numbers.length > 12 ? "…" : ""}` : "";
  return [name, pageLabel].filter(Boolean).join(" · ");
}

export function readingRecovery(warnings: JobWarning[]): { steps: string[]; formulaHelp: string } | null {
  const warning = warnings.find(isReadingWarning);
  if (!warning) return null;
  const context = warning.context ?? {};
  const steps = context.recovery_steps;
  return {
    steps: Array.isArray(steps) && steps.every((step) => typeof step === "string") && steps.length
      ? steps
      : [
        "Сначала распознайте текст в файле через OCR (распознавание текста), сохраните результат и загрузите его снова.",
        "Либо попросите другую модель проанализировать исходный файл и выдать весь материал в текстовом формате: без пропусков, с читаемыми формулами. Затем загрузите этот текст или вставьте его сюда.",
      ],
    formulaHelp: typeof context.formula_help === "string" ? context.formula_help
      : "Если в файле есть формулы, проверьте знаки, дроби, степени и индексы. Попросите сохранить формулы в LaTeX ($…$), чтобы они отображались на карточках. Можно загрузить исходный документ .tex или .typ.",
  };
}
