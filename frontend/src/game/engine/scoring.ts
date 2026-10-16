import type { Difficulty } from "../../api/types";
import type { Pace, SessionSettings } from "./settings";

export const BASE_POINTS = 100;
export const EARLY_BONUS_MAX = 50;
/** Бегун не сходил с трека: мог просто стоять на верном, поэтому бонус за решение — половина. */
export const STAY_SHARE = 0.5;

const DIFFICULTY_FACTOR: Record<Difficulty, number> = { easy: 1, medium: 1.25, hard: 1.5 };
const PACE_FACTOR: Record<Exclude<Pace, "custom">, number> = { calm: 0.9, normal: 1, fast: 1.15 };
const LANES_FACTOR: Record<3 | 4, number> = { 3: 1, 4: 1.1 };

/** Свой темп приравнивается к ближайшему готовому по секундам на вопрос. */
export function paceFactor(pace: Pace, customSeconds: number): number {
  if (pace !== "custom") return PACE_FACTOR[pace];
  return customSeconds <= 5 ? PACE_FACTOR.fast : customSeconds >= 10 ? PACE_FACTOR.calm : PACE_FACTOR.normal;
}

export interface ScoreRules {
  /** Во сколько раз очки за ответ и бонус серии больше базовых: сложность × темп × треки. */
  factor: number;
  /** Штраф за ошибку; растёт со сложностью, как и цена верного ответа. */
  penalty: number;
}

export function scoreRules(settings: Pick<SessionSettings, "difficulty" | "pace" | "customSeconds" | "lanes" | "penalty">): ScoreRules {
  const factor = DIFFICULTY_FACTOR[settings.difficulty] * paceFactor(settings.pace, settings.customSeconds) * LANES_FACTOR[settings.lanes];
  return { factor, penalty: Math.round(settings.penalty * DIFFICULTY_FACTOR[settings.difficulty]) };
}

/** С какой серии верных подряд действует ×2, ×3, ×4, ×5. */
export const COMBO_TIERS = [3, 5, 8, 12] as const;
export const MAX_MULTIPLIER = COMBO_TIERS.length + 1;
/** Каждые 5 подряд, начиная с 10, — бонус серии. */
export const MILESTONE_FROM = 10;
export const MILESTONE_EVERY = 5;
export const MILESTONE_BONUS = 200;

/** Множитель комбо по длине серии верных ответов (включая текущий). */
export function comboMultiplier(streak: number): number {
  return 1 + COMBO_TIERS.filter((at) => streak >= at).length;
}

/** Сколько верных подряд нужно до следующего множителя; null — максимум. */
export function nextComboAt(streak: number): number | null {
  return COMBO_TIERS.find((at) => streak < at) ?? null;
}

/** С какой серии начался текущий множитель (для полоски до следующего). */
export function comboTierStart(streak: number): number {
  return [...COMBO_TIERS].reverse().find((at) => streak >= at) ?? 0;
}

export function isMilestone(streak: number): boolean {
  return streak >= MILESTONE_FROM && (streak - MILESTONE_FROM) % MILESTONE_EVERY === 0;
}

/**
 * Очки за верный ответ. `decidedShare` — доля времени, оставшаяся на момент
 * последней смены трека (1 — сразу встал куда надо, 0 — в последний миг).
 */
export function pointsForCorrect(streak: number, factor: number, decidedShare: number): number {
  const share = Math.max(0, Math.min(1, decidedShare));
  const base = BASE_POINTS * comboMultiplier(streak) * factor;
  return Math.round(base + EARLY_BONUS_MAX * share);
}

export interface ScoreState {
  score: number;
  streak: number;
  maxStreak: number;
  lives: number | null;
  correct: number;
  wrong: number;
}

export function initialScore(lives: number): ScoreState {
  return { score: 0, streak: 0, maxStreak: 0, lives: lives > 0 ? lives : null, correct: 0, wrong: 0 };
}

export interface AnswerOutcome {
  state: ScoreState;
  delta: number;
  multiplier: number;
  comboUp: boolean;
  /** Бонус серии, уже включённый в delta; 0 — не веха. */
  bonus: number;
  /** Длина серии, которую оборвал этот неверный ответ. */
  lostStreak: number;
}

export function applyAnswer(
  state: ScoreState,
  correct: boolean,
  rules: ScoreRules,
  decidedShare: number,
): AnswerOutcome {
  if (correct) {
    const streak = state.streak + 1;
    const bonus = isMilestone(streak) ? Math.round(MILESTONE_BONUS * rules.factor) : 0;
    const delta = pointsForCorrect(streak, rules.factor, decidedShare) + bonus;
    return {
      state: {
        ...state,
        score: state.score + delta,
        streak,
        maxStreak: Math.max(state.maxStreak, streak),
        correct: state.correct + 1,
      },
      delta,
      multiplier: comboMultiplier(streak),
      comboUp: comboMultiplier(streak) > comboMultiplier(state.streak),
      bonus,
      lostStreak: 0,
    };
  }
  const delta = -Math.min(rules.penalty, state.score);
  return {
    state: {
      ...state,
      score: state.score + delta,
      streak: 0,
      lives: state.lives === null ? null : Math.max(0, state.lives - 1),
      wrong: state.wrong + 1,
    },
    delta,
    multiplier: 1,
    comboUp: false,
    bonus: 0,
    lostStreak: state.streak,
  };
}

/** Очки вне ответов (монеты, штраф за препятствие): серия не меняется, счёт не уходит в минус. */
export function addPoints(state: ScoreState, delta: number): { state: ScoreState; delta: number } {
  const applied = Math.max(-state.score, delta);
  return { state: { ...state, score: state.score + applied }, delta: applied };
}

/** Звёзды за забег по точности. */
export function starsFor(correct: number, total: number): 0 | 1 | 2 | 3 {
  if (total === 0) return 0;
  const accuracy = correct / total;
  if (accuracy >= 0.9) return 3;
  if (accuracy >= 0.7) return 2;
  if (accuracy >= 0.4) return 1;
  return 0;
}
