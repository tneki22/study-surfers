import type { Difficulty, ItemsFilter } from "../../api/types";

export type Pace = "calm" | "normal" | "fast" | "custom";
export type ItemCount = 10 | 20 | 30 | "all";
export type Lives = 0 | 3 | 5;
export type World = "classic" | "night-maglev";

/** Настройки одного забега. Последние использованные сохраняются — это «Быстрый старт». */
export interface SessionSettings {
  world: World;
  count: ItemCount;
  filter: ItemsFilter;
  order: "shuffle" | "program";
  lanes: 3 | 4;
  difficulty: Difficulty;
  pace: Pace;
  /** Секунды на вопрос при `pace: "custom"`. */
  customSeconds: number;
  /** 0 — жизни выключены. */
  lives: Lives;
  penalty: number;
  /** Вернуть ошибочную карточку в этот же забег через несколько вопросов. */
  retryMistakes: boolean;
  includeAiItems: boolean;
  /** Барьеры и балки между воротами: прыжок и подкат. */
  obstacles: boolean;
  /** Усиления появляются независимо от препятствий. */
  modifiers: boolean;
  /** «Больше препятствий»: такты вдвое чаще и сложные комбинации. */
  moreObstacles: boolean;
}

export const DEFAULT_SETTINGS: SessionSettings = {
  world: "classic",
  count: 20,
  filter: "all",
  order: "shuffle",
  lanes: 3,
  difficulty: "medium",
  pace: "normal",
  customSeconds: 8,
  lives: 0,
  penalty: 50,
  retryMistakes: false,
  includeAiItems: true,
  obstacles: true,
  modifiers: true,
  moreObstacles: false,
};

/** Режим препятствий в сохранённом забеге: от него зависят монеты и штрафы, а значит и рекорд. */
export function obstaclesMode(settings: Pick<SessionSettings, "obstacles" | "moreObstacles">): "off" | "normal" | "more" {
  return !settings.obstacles ? "off" : settings.moreObstacles ? "more" : "normal";
}

export const PACE_LABEL: Record<Pace, string> = {
  calm: "Спокойный",
  normal: "Обычный",
  fast: "Быстрый",
  custom: "Свой",
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: "Лёгкая",
  medium: "Средняя",
  hard: "Сложная",
};

/** Допустимый фильтр забега из адреса экрана настроек; всё остальное — «нет фильтра». */
export function parseItemsFilter(value: string | null): ItemsFilter | null {
  return value === "all" || value === "weak" || value === "last_mistakes" ? value : null;
}
