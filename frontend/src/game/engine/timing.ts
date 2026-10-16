import type { Pace } from "./settings";

/** Скорость бега, м/с. Постоянная: темп задаётся временем на вопрос, а не скоростью. */
export const RUN_SPEED = 14;
/** Пауза между воротами и следующим вопросом, с. */
export const GAP_SECONDS = 0.8;

const PACE_RANGE: Record<Exclude<Pace, "custom">, { base: number; charsPerSecond: number; min: number; max: number }> = {
  calm: { base: 6, charsPerSecond: 22, min: 8, max: 12 },
  normal: { base: 4, charsPerSecond: 28, min: 5, max: 10 },
  fast: { base: 3, charsPerSecond: 35, min: 4, max: 7 },
};

/**
 * Длина текста «как читается»: LaTeX-обвязка (`$`, `\frac`, скобки) не буквы,
 * но формулу читать дольше обычного слова — поэтому команда считается за 2 знака.
 */
export function readingLength(text: string): number {
  const commands = text.match(/\\[a-zA-Z]+/g)?.length ?? 0;
  const plain = text.replace(/\\[a-zA-Z]+/g, "").replace(/[${}^_\\]/g, "").replace(/\s+/g, " ").trim();
  return plain.length + commands * 2;
}

export function answerSeconds(prompt: string, options: string[], pace: Pace, customSeconds: number): number {
  if (pace === "custom") return Math.max(3, Math.min(20, customSeconds));
  const range = PACE_RANGE[pace];
  const chars = readingLength(prompt) + options.reduce((sum, option) => sum + readingLength(option), 0);
  return Math.max(range.min, Math.min(range.max, range.base + chars / range.charsPerSecond));
}

export function gateDistance(seconds: number): number {
  return seconds * RUN_SPEED;
}
