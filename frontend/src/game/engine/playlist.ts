import type { Difficulty, Distractor, QuizItem } from "../../api/types";
import { shuffle, type Rng } from "./random";
import type { SessionSettings } from "./settings";

export type OptionKind = "correct" | "far" | "near";

export interface LaneOption {
  text: string;
  kind: OptionKind;
  whyWrong: string | null;
}

/** Один вопрос забега: карточка и разложенные по трекам варианты. */
export interface Gate {
  /** Уникален в пределах забега: одна карточка может прийти дважды (повтор ошибки). */
  key: string;
  item: QuizItem;
  options: LaneOption[];
  correctLane: number;
  /** Повтор карточки после ошибки в этом же забеге. */
  retry: boolean;
}

/**
 * Сколько «далёких» и «близких» неверных вариантов положить на треки.
 * Лёгкая: два далёких, остальные близкие. Средняя: один далёкий, остальные близкие.
 * Сложная: только близкие.
 */
export function distractorMix(difficulty: Difficulty, wrongCount: number): { far: number; near: number } {
  if (difficulty === "easy") return { far: Math.min(2, wrongCount), near: Math.max(0, wrongCount - 2) };
  if (difficulty === "medium") return { far: Math.min(1, wrongCount), near: Math.max(0, wrongCount - 1) };
  return { far: 0, near: wrongCount };
}

/** Набирает неверные варианты по сложности; если пула не хватает — добирает из другого. */
export function pickDistractors(distractors: Distractor[], difficulty: Difficulty, wrongCount: number, rng: Rng): Distractor[] {
  const far = shuffle(distractors.filter((d) => d.kind === "far"), rng);
  const near = shuffle(distractors.filter((d) => d.kind === "near"), rng);
  const mix = distractorMix(difficulty, wrongCount);
  const picked = [...far.splice(0, mix.far), ...near.splice(0, mix.near)];
  const rest = difficulty === "easy" ? [...far, ...near] : [...near, ...far];
  while (picked.length < wrongCount && rest.length) picked.push(rest.shift()!);
  return picked;
}

export function buildGate(item: QuizItem, lanes: number, difficulty: Difficulty, rng: Rng, key: string, retry = false): Gate {
  const wrong = pickDistractors(item.distractors, difficulty, lanes - 1, rng);
  const options: LaneOption[] = shuffle([
    { text: item.correct, kind: "correct" as const, whyWrong: null },
    ...wrong.map((d) => ({ text: d.text, kind: d.kind, whyWrong: d.why_wrong })),
  ], rng);
  return { key, item, options, correctLane: options.findIndex((o) => o.kind === "correct"), retry };
}

/** Отбирает карточки для забега: включённые, без «ответов ИИ» по желанию, в нужном порядке. */
export function selectItems(items: QuizItem[], settings: Pick<SessionSettings, "includeAiItems" | "order">, rng: Rng): QuizItem[] {
  const usable = items.filter((item) => item.enabled && (settings.includeAiItems || item.source !== "ai_knowledge"));
  return settings.order === "shuffle" ? shuffle(usable, rng) : [...usable].sort(compareProgramOrder);
}

function compareProgramOrder(a: QuizItem, b: QuizItem): number {
  return (a.question_ordinal ?? Number.MAX_SAFE_INTEGER) - (b.question_ordinal ?? Number.MAX_SAFE_INTEGER) || a.seq - b.seq;
}

const RETRY_GAP_MIN = 3;
const RETRY_GAP_MAX = 5;

/**
 * Очередь вопросов забега. Карточки могут догружаться по ходу (генерация
 * ещё идёт), ошибочные — возвращаться через 3–5 вопросов, если это включено.
 */
export class Playlist {
  private queue: QuizItem[] = [];
  private retries: { item: QuizItem; dueAt: number }[] = [];
  private seen = new Set<string>();
  private retried = new Set<string>();
  private served = 0;
  private gateCounter = 0;
  /** Сколько вопросов из основной очереди ещё можно выдать (лимит количества). */
  private remainingQuota: number;
  private readonly settings: SessionSettings;
  private readonly rng: Rng;

  // Без параметров-свойств: юнит-тесты идут через type stripping Node, а он их не умеет.
  constructor(settings: SessionSettings, rng: Rng, items: QuizItem[] = []) {
    this.settings = settings;
    this.rng = rng;
    this.remainingQuota = settings.count === "all" ? Number.POSITIVE_INFINITY : settings.count;
    this.append(items);
  }

  /** Добавляет новые карточки (догрузка во время генерации); дубли по id игнорируются. */
  append(items: QuizItem[]): number {
    const fresh = selectItems(items, this.settings, this.rng).filter((item) => {
      if (this.seen.has(item.id)) return false;
      this.seen.add(item.id);
      return true;
    });
    if (fresh.length) {
      const combined = [...this.queue, ...fresh];
      this.queue = this.settings.order === "shuffle" ? shuffle(combined, this.rng) : combined.sort(compareProgramOrder);
    }
    return fresh.length;
  }

  /** Основные вопросы и повторы, до которых успеваем дойти при текущем запасе. */
  plannedTotal(): number {
    const main = Math.min(this.queue.length, this.remainingQuota);
    return this.served + main + this.retries.filter((r) => r.dueAt <= this.served + main).length;
  }

  /** Бюджет усилений считают только основные вопросы, без повторов ошибок. */
  mainTotal(): number {
    return this.settings.count === "all" ? this.seen.size : Math.min(this.seen.size, this.settings.count);
  }

  hasNext(): boolean {
    return this.retries.some((r) => r.dueAt <= this.served) || (this.queue.length > 0 && this.remainingQuota > 0);
  }

  /** Лимит ещё не выбран, но запас кончился — имеет смысл ждать догрузки. */
  starving(): boolean {
    return !this.hasNext() && this.remainingQuota > 0;
  }

  next(): Gate | null {
    const dueIndex = this.retries.findIndex((r) => r.dueAt <= this.served);
    const mainAvailable = this.queue.length > 0 && this.remainingQuota > 0;
    let item: QuizItem | undefined;
    let retry = false;
    if (dueIndex >= 0) {
      item = this.retries.splice(dueIndex, 1)[0].item;
      retry = true;
    } else if (mainAvailable) {
      item = this.queue.shift();
      this.remainingQuota -= 1;
    }
    if (!item) return null;
    this.served += 1;
    this.gateCounter += 1;
    return buildGate(item, this.settings.lanes, this.settings.difficulty, this.rng, `${item.id}#${this.gateCounter}`, retry);
  }

  /**
   * После ошибки: вернуть карточку через 3–5 вопросов (один раз за забег).
   * ahead — сколько следующих вопросов уже выдано наперёд (ночной мир берёт один).
   */
  reportMistake(item: QuizItem, ahead = 0): void {
    if (!this.settings.retryMistakes || this.retried.has(item.id)) return;
    this.retried.add(item.id);
    const gap = RETRY_GAP_MIN + Math.floor(this.rng() * (RETRY_GAP_MAX - RETRY_GAP_MIN + 1));
    this.retries.push({ item, dueAt: this.served - ahead + gap });
  }

  get servedCount(): number {
    return this.served;
  }
}
