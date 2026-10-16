import { create } from "zustand";
import type { ItemSource } from "../api/types";
import type { Severity } from "./engine/impact";
import type { Gate, OptionKind } from "./engine/playlist";

export type Phase =
  | "loading"
  | "intro"
  | "countdown"
  | "running"
  | "paused"
  | "finishing"
  | "finished"
  | "gameover";

/** Где на экране табло и карточки треков. Считается из камеры при изменении размера. */
export interface ScreenLayout {
  width: number;
  height: number;
  billboard: { left: number; top: number; width: number; height: number };
  cards: { centerX: number; width: number }[];
  cardsY: number;
}

export interface AnswerResult {
  key: string;
  correct: boolean;
  delta: number;
  comboUp: boolean;
  multiplier: number;
  /** Серия после ответа, бонус за веху серии и длина оборванной серии. */
  streak: number;
  bonus: number;
  lostStreak: number;
  chosenLane: number;
  correctLane: number;
  correctText: string;
  chosenText: string;
  whyWrong: string | null;
}

export interface Mistake {
  itemId: string;
  prompt: string;
  correct: string;
  chosen: string;
  chosenKind: OptionKind;
  whyWrong: string | null;
  explanation: string;
  source: ItemSource;
}

export interface RunResult {
  finished: boolean;
  score: number;
  correct: number;
  wrong: number;
  maxStreak: number;
  durationMs: number;
  mistakes: Mistake[];
  previousBest: number | null;
  coins: number;
  /** Сколько рядов препятствий встретилось и сколько из них сбили. */
  obstacles: number;
  bumps: number;
  /** Лучшая серия препятствий подряд без касаний. */
  bestClean: number;
  /** Столкновения по силе. */
  impacts: Record<Severity, number>;
}

/** Погоня после столкновения: ключ — для перезапуска индикатора, сила — для его цвета. */
export interface ChaseState {
  key: number;
  severity: Severity;
}

/** Всплывающее изменение счёта рядом с ним: ответ или удар о препятствие. */
export interface ScorePop {
  key: number;
  delta: number;
  /** Множитель верного ответа — подписью к очкам. */
  multiplier?: number;
}

/** Подсказка перед первым барьером, первой балкой и первыми вагонетками. */
export type MoveHint = "jump" | "slide" | "board" | "dodge" | "swerve";

/**
 * Состояние HUD. Меняется только на событиях забега (вопрос, ответ, пауза),
 * а не каждый кадр: покадровое движение живёт в GameRuntime и читается сценой через ref.
 */
export interface GameHud {
  phase: Phase;
  lanes: number;
  score: number;
  streak: number;
  multiplier: number;
  lives: number | null;
  maxLives: number | null;
  gate: Gate | null;
  gateSeconds: number;
  gateIndex: number;
  plannedTotal: number;
  targetLane: number;
  lastResult: AnswerResult | null;
  timeline: boolean[];
  countdown: number | null;
  startSpeed: number;
  waiting: boolean;
  layout: ScreenLayout | null;
  result: RunResult | null;
  coins: number;
  pop: ScorePop | null;
  hint: MoveHint | null;
  /** Препятствия включены в настройках забега — от этого зависят подсказки клавиш. */
  obstacles: boolean;
  /** Бегун в прыжке: карточка над ним становится прозрачной, чтобы не закрывать его. */
  airborne: boolean;
  /** Непройденная опасность в ближайших 35 м ночью: открываем сцену под всеми карточками. */
  nightDangerNear: boolean;
  /** «На хвосте»: CHASE_SECONDS после столкновения следующее — на ступень сильнее. */
  chase: ChaseState | null;
}

export const initialHud = (lanes: number): GameHud => ({
  phase: "loading",
  lanes,
  score: 0,
  streak: 0,
  multiplier: 1,
  lives: null,
  maxLives: null,
  gate: null,
  gateSeconds: 0,
  gateIndex: 0,
  plannedTotal: 0,
  targetLane: Math.floor((lanes - 1) / 2),
  lastResult: null,
  timeline: [],
  countdown: null,
  startSpeed: 1,
  waiting: false,
  layout: null,
  result: null,
  coins: 0,
  pop: null,
  hint: null,
  obstacles: false,
  airborne: false,
  nightDangerNear: false,
  chase: null,
});

export const useHud = create<GameHud>(() => initialHud(3));
