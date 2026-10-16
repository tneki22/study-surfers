import type { Rng } from "./random";

/**
 * Общий каркас расстановки препятствий для обоих миров. Окно препятствий
 * участка заполняется тактами: такт — паттерн из клеток по трекам (одиночка,
 * пара «пригнись / перепрыгни», лесенка…). Между тактами — разбег. Паттерны
 * задаются для любого числа треков и случайно зеркалятся; облик каждой клетки
 * выбирается в самом конце, чтобы одинаковые не стояли рядом.
 *
 * Планировщик не знает верного трека: препятствия не подсказывают ответ.
 */

/** Клетка паттерна: трек, сдвиг от начала такта (с бега на базовой скорости) и вид. */
export interface PatternCell<K extends string> {
  lane: number;
  at: number;
  kind: K;
  /** Протяжённость по дистанции, м (вагоны, подъём); у тонких препятствий 0. */
  length: number;
}

/**
 * Уровень паттерна: 1 — знакомство и передышка, 2 — комбинации, 3 — испытание
 * (только «Больше препятствий» и ближе к середине забега).
 */
export type Tier = 1 | 2 | 3;

export interface Pattern<K extends string> {
  name: string;
  tier: Tier;
  /** Вес при выборе среди доступных. */
  weight: number;
  /** Клетки для `lanes` треков; null — паттерну не хватает треков или места `room` (м). */
  build: (lanes: number, rng: Rng, room: number) => PatternCell<K>[] | null;
}

export interface PlacedCell<K extends string> {
  distance: number;
  lane: number;
  kind: K;
  length: number;
  /** Облик: 0…looks−1. */
  variant: number;
  /** Имя паттерна — для тестов и отладки. */
  pattern: string;
  /** Номер такта в этом окне, с 0: по тактам считается чистая серия. */
  beat: number;
}

export interface FillInput {
  /** Окно препятствий участка, м. */
  from: number;
  to: number;
  speed: number;
  lanes: number;
  /** «Больше препятствий»: такты чаще, испытания доступны. */
  more: boolean;
  /** Номер вопроса в забеге, с 1. */
  gateIndex: number;
  /** Сколько тактов уже было в забеге. */
  placed: number;
  /** Игрок заслужил награду: первым тактом окна ставится паттерн-награда. */
  reward?: boolean;
}

export interface FillResult<K extends string> {
  cells: PlacedCell<K>[];
  /** Сколько тактов поставлено. */
  beats: number;
  /** Поставлена награда. */
  rewarded: boolean;
}

/** Разбег между тактами, с: от конца одного до начала другого. */
export const BEAT_GAP = { normal: [1.6, 2.4], more: [0.8, 1.15] } as const;
/** Доля участков-передышек без препятствий. */
export const BREATHER = { normal: 0.12, more: 0.05 } as const;

const span = <K extends string>(cells: PatternCell<K>[], speed: number) =>
  Math.max(...cells.map((cell) => cell.at * speed + cell.length));

function pickWeighted<T extends { weight: number }>(rng: Rng, items: T[]): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

export interface Dictionary<K extends string> {
  patterns: Pattern<K>[];
  /** Первые такты забега — по одному паттерну знакомства на каждый. */
  intro: Pattern<K>[];
  /** Сколько обликов у вида. */
  looks: (kind: K) => number;
  /** Какой уровень паттернов открыт к этому моменту забега. */
  maxTier: (input: FillInput) => Tier;
  /** Такт-награда за чистую серию (катапульта, ускорительное кольцо): в обычный выбор не входит. */
  reward?: Pattern<K>;
  /** Свой разбег между тактами, с; по умолчанию BEAT_GAP. */
  gaps?: { normal: readonly [number, number]; more: readonly [number, number] };
}

/**
 * Заполняет окно тактами. Каждый такт целиком помещается в окно, после
 * испытания (уровень 3) следует простой такт — ритм «напряжение → разрядка».
 */
export function fillWindow<K extends string>(rng: Rng, input: FillInput, dict: Dictionary<K>): FillResult<K> {
  const { from, to, speed, lanes, more } = input;
  const cells: PlacedCell<K>[] = [];
  if (to <= from) return { cells, beats: 0, rewarded: false };
  if (!input.reward && input.placed >= dict.intro.length && rng() < (more ? BREATHER.more : BREATHER.normal)) return { cells, beats: 0, rewarded: false };

  const gaps = (dict.gaps ?? BEAT_GAP)[more ? "more" : "normal"];
  const gap = () => (gaps[0] + rng() * (gaps[1] - gaps[0])) * speed;
  const tier = dict.maxTier(input);
  let beats = 0;
  let calm = false;
  let rewarded = false;
  // Начало первого такта плавает: ряды не встают в одно и то же место участка.
  let cursor = from + rng() * Math.min(speed * 0.6, (to - from) * 0.25);

  while (cursor < to) {
    const room = to - cursor;
    const placed = input.placed + beats;
    const intro = placed < dict.intro.length ? dict.intro[placed] : null;
    let built: { pattern: Pattern<K>; cells: PatternCell<K>[] } | null = null;
    if (intro) {
      const introCells = intro.build(lanes, rng, room);
      if (introCells && span(introCells, speed) <= room) built = { pattern: intro, cells: introCells };
    }
    if (!built && !intro && input.reward && !rewarded && dict.reward) {
      const rewardCells = dict.reward.build(lanes, rng, room);
      if (rewardCells && span(rewardCells, speed) <= room) {
        built = { pattern: dict.reward, cells: rewardCells };
        rewarded = true;
      }
    }
    if (!built) {
      let pool = dict.patterns.filter((pattern) => pattern.tier <= (calm ? 1 : tier));
      // Несколько попыток: если выбранному паттерну не хватило места, пробуем другой.
      for (let attempt = 0; attempt < 6 && pool.length && !built; attempt += 1) {
        const pattern = pickWeighted(rng, pool);
        const patternCells = pattern.build(lanes, rng, room);
        if (patternCells && patternCells.length && span(patternCells, speed) <= room) built = { pattern, cells: patternCells };
        else pool = pool.filter((other) => other !== pattern);
      }
    }
    if (!built) break;
    const mirror = rng() < 0.5;
    for (const cell of built.cells) {
      cells.push({
        distance: cursor + cell.at * speed,
        lane: mirror ? lanes - 1 - cell.lane : cell.lane,
        kind: cell.kind,
        length: cell.length,
        variant: 0,
        pattern: built.pattern.name,
        beat: beats,
      });
    }
    beats += 1;
    // Знакомство — по одному такту на вопрос: новое действие встречают без спешки.
    if (intro && built.pattern === intro) break;
    calm = built.pattern.tier === 3;
    cursor += span(built.cells, speed) + gap();
    // В обычном режиме на коротком участке хватает одного-двух тактов: остаток — передышка.
    if (!more && beats >= 2 && rng() < 0.5) break;
  }
  cells.sort((a, b) => a.distance - b.distance || a.lane - b.lane);
  assignLooks(rng, cells, dict.looks);
  return { cells, beats, rewarded };
}

/** Насколько близко по дистанции клетки считаются «рядом», м. */
const NEAR = 6;

/**
 * Облик каждой клетки: не такой, как у соседей по ряду (соседние треки
 * в пределах NEAR) и у предыдущей клетки того же вида на этом же треке.
 */
export function assignLooks<K extends string>(rng: Rng, cells: PlacedCell<K>[], looks: (kind: K) => number) {
  const lastOnLane = new Map<string, number>();
  cells.forEach((cell, index) => {
    const count = looks(cell.kind);
    if (count <= 1) return;
    const banned = new Set<number>();
    const besides = new Set<number>();
    let paired: number | null = null;
    for (let other = 0; other < index; other += 1) {
      const prev = cells[other];
      if (prev.kind !== cell.kind) continue;
      if (cell.distance - prev.distance >= NEAR) continue;
      if (Math.abs(prev.lane - cell.lane) === 1) besides.add(prev.variant);
      // Через трек — тот же облик: тогда средней клетке ряда всегда найдётся другой.
      if (Math.abs(prev.lane - cell.lane) === 2) paired = prev.variant;
    }
    const previous = lastOnLane.get(`${cell.lane}:${cell.kind}`);
    if (previous !== undefined) banned.add(previous);
    const all = Array.from({ length: count }, (_, look) => look);
    let options = all.filter((look) => !banned.has(look) && !besides.has(look));
    // Не хватило обликов — важнее, чтобы не совпали соседи по ряду.
    if (!options.length) options = all.filter((look) => !besides.has(look));
    if (!options.length) options = all;
    // При двух обликах соседи по ряду важнее повтора на треке.
    cell.variant = count === 2 && paired !== null && !besides.has(paired) ? paired : options[Math.floor(rng() * options.length)];
    lastOnLane.set(`${cell.lane}:${cell.kind}`, cell.variant);
  });
}

/** Случайный трек из `lanes`. */
export const anyLane = (rng: Rng, lanes: number) => Math.floor(rng() * lanes);

/** Случайный из двух вариантов. */
export const either = <T>(rng: Rng, a: T, b: T): T => (rng() < 0.5 ? a : b);
