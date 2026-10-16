import { LANE_WIDTH, laneX } from "../constants";
import { anyLane, either, fillWindow, type Dictionary, type FillInput, type Pattern, type PatternCell, type PlacedCell } from "./course";
import { GRAZE_MARGIN, type Severity } from "./impact";
import type { Rng } from "./random";
import { MAX_SPEED_FACTOR } from "./speed";
import { GAP_SECONDS } from "./timing";

/**
 * Опасности ночи: робот (прыжок), консоль (снижение), магнит (объезд, иначе сдвиг),
 * челнок (встречный, объезд), энергобарьер (стена на одну дорожку, только объезд).
 * Ускорительное кольцо — награда за чистую серию: пролёт сквозь него разгоняет байк.
 */
export type NightObstacleKind = "repair-bot" | "repair-arm" | "magnetic-zone" | "shuttle" | "energy-wall" | "boost-ring";
/** После паузы между вопросами: столько секунд на 1,5× остаётся на чтение до первой опасности. */
export const NIGHT_READ_SECONDS = 0.6;
/** Свободный путь перед воротами — доля участка на базовой скорости, в этих пределах. */
export const NIGHT_CLEAR_SECONDS = 3;
export const NIGHT_CLEAR_MIN_SECONDS = 1.3;
export const NIGHT_CLEAR_SHARE = 0.3;
export const NIGHT_RECOVERY_SECONDS = 0.65;
export const BOT_TOP = 0.65;
export const BOT_CLEARANCE = 0.75;
export const ARM_BOTTOM = 1.58;
export const ZONE_CLEARANCE = 0.35;
/** Сервисный челнок выше любого прыжка: его только объезжают. */
export const SHUTTLE_TOP = 1.9;
export const SHUTTLE_LENGTH = 3.4;
/** Челнок стоит с мигалкой, пока байк не подъедет на это расстояние, затем едет навстречу. */
export const SHUTTLE_TRIGGER = 105;
export const SHUTTLE_SPEED = 9;
export const NIGHT_OBSTACLE_HALF_WIDTH = 0.92;
export const BIKE_HALF_WIDTH = 0.78;
/**
 * Чтение и восстановление расставлены под 1,5× базы (21 м/с), свободный путь у ворот —
 * под базу. Разгон выше — выбор игрока: он сам сокращает себе запас.
 */
export const PLAN_SPEED_FACTOR = 1.5;
/** Энергобарьер выше любого прыжка и ниже любого снижения не пройти: только объезд. */
export const WALL_TOP = 2.8;
/** Кольцо: пролёт добавляет столько к множителю скорости (не выше максимума). */
export const RING_BOOST = 0.45;
const LENGTH: Record<NightObstacleKind, number> = { "repair-bot": 1.6, "repair-arm": 1.6, "magnetic-zone": 4.2, shuttle: SHUTTLE_LENGTH, "energy-wall": 0.6, "boost-ring": 0.8 };
/**
 * Облики: робот — робот, низкая лазерная растяжка, кабель ремонтников; консоль — консоль,
 * высокая растяжка, грузовой дрон с тенью-предупреждением.
 */
export const NIGHT_LOOKS: Record<NightObstacleKind, number> = { "repair-bot": 3, "repair-arm": 3, "magnetic-zone": 1, shuttle: 1, "energy-wall": 1, "boost-ring": 1 };
/** Паттерны-испытания: на них лазерные растяжки мерцают. */
export const NIGHT_TRIALS = new Set(["double-shuttle", "gate-slalom"]);

export interface NightPlannedObstacle {
  distance: number;
  kind: NightObstacleKind;
  length: number;
  lane: number;
  direction: -1 | 1;
  /** Паттерн, из которого ряд. */
  pattern: string;
  /** Облик (см. NIGHT_LOOKS). */
  variant: number;
  /** Номер такта в окне, с 0. */
  beat: number;
}

/** Свободный путь перед ночными воротами, м: в нём нет опасностей, и маглевы не отвлекают. */
export function nightClearDistance(baseSpeed: number, seconds: number): number {
  return baseSpeed * Math.max(NIGHT_CLEAR_MIN_SECONDS, Math.min(NIGHT_CLEAR_SECONDS, seconds * NIGHT_CLEAR_SHARE));
}

/** Где на участке можно ставить опасности: [from, to] для начала и конца ряда. */
export function nightWindow(input: { start: number; end: number; baseSpeed: number }): { from: number; to: number } {
  const planSpeed = input.baseSpeed * PLAN_SPEED_FACTOR;
  const seconds = (input.end - input.start) / input.baseSpeed;
  // Пауза между вопросами отсчитывается временем: на разгоне байк въезжает в участок дальше начала.
  const from = input.start + planSpeed * (GAP_SECONDS + NIGHT_READ_SECONDS) - input.baseSpeed * GAP_SECONDS;
  const to = input.end - nightClearDistance(input.baseSpeed, seconds) - planSpeed * NIGHT_RECOVERY_SECONDS;
  return { from, to };
}

/**
 * Сколько пути ряд занимает перед своим началом: челнок встречает байк раньше места
 * стоянки, дальше всего — на базовой скорости (медленнее байк не едет).
 */
export function nightReach(kind: NightObstacleKind, baseSpeed: number): number {
  return kind === "shuttle" ? shuttleMeetOffset(baseSpeed) : 0;
}

/**
 * Встречный челнок в паттерне занимает отрезок, где он может встретить байк:
 * от встречи на базовой скорости до встречи на максимальной, плюс сам челнок.
 * Стоянка — дальше, на shuttleMeetOffset(base) от начала отрезка.
 */
export function shuttleMeetSpan(baseSpeed: number): number {
  return shuttleMeetOffset(baseSpeed) - shuttleMeetOffset(baseSpeed * MAX_SPEED_FACTOR) + SHUTTLE_LENGTH;
}

type NightCell = PatternCell<NightObstacleKind>;
/** Тянуть дорожку магнитом — к центру, у края — внутрь. */
const directionFor = (lane: number, lanes: number, rng: Rng): -1 | 1 =>
  lane === 0 ? 1 : lane === lanes - 1 ? -1 : rng() < 0.5 ? -1 : 1;
const nightAction = (rng: Rng): NightObstacleKind => (rng() < 0.55 ? "repair-bot" : "repair-arm");
const otherAction = (kind: NightObstacleKind): NightObstacleKind => (kind === "repair-bot" ? "repair-arm" : "repair-bot");
const allLanes = (lanes: number) => Array.from({ length: lanes }, (_, lane) => lane);
/** Два действия подряд на одной дорожке: на максимальном разгоне это 0,73 с. */
export const NIGHT_STEP_SECONDS = 1.1;

function nightPatterns(baseSpeed: number, planSpeed: number): Pattern<NightObstacleKind>[] {
  const ncell = (lane: number, at: number, kind: NightObstacleKind): NightCell => ({
    lane, at, kind, length: kind === "shuttle" ? shuttleMeetSpan(baseSpeed) : LENGTH[kind],
  });
  const jitter = (rng: Rng) => rng() * 0.15;
  return [
    // --- Уровень 1 ---
    { name: "single", tier: 1, weight: 2, build: (lanes, rng) => [ncell(anyLane(rng, lanes), 0, rng() < 0.25 ? "magnetic-zone" : nightAction(rng))] },
    {
      name: "pair", tier: 1, weight: 3,
      build: (lanes, rng) => {
        const left = Math.floor(rng() * (lanes - 1));
        const first = nightAction(rng);
        return [ncell(left, jitter(rng), first), ncell(left + 1, jitter(rng), otherAction(first))];
      },
    },
    {
      name: "edge-magnet", tier: 1, weight: 1.5,
      build: (lanes, rng) => {
        const edge = either(rng, 0, lanes - 1);
        // Рядом с магнитом — робот: сдвиг магнитом ведёт под прыжок.
        return [ncell(edge, 0, "magnetic-zone"), ncell(edge === 0 ? 1 : lanes - 2, 0.35, nightAction(rng))];
      },
    },
    // --- Уровень 2 ---
    {
      name: "gate", tier: 2, weight: 2,
      build: (lanes, rng) => {
        const kinds = allLanes(lanes).map(() => nightAction(rng));
        if (kinds.every((kind) => kind === kinds[0])) kinds[anyLane(rng, lanes)] = otherAction(kinds[0]);
        return kinds.map((kind, lane) => ncell(lane, jitter(rng), kind));
      },
    },
    {
      name: "oncoming", tier: 2, weight: 1.5,
      build: (lanes, rng, room) => {
        if (shuttleMeetSpan(baseSpeed) > room) return null;
        const lane = anyLane(rng, lanes);
        const side = lane === 0 ? 1 : lane === lanes - 1 ? lanes - 2 : lane + either<number>(rng, -1, 1);
        return [ncell(lane, 0, "shuttle"), ncell(side, 0.2 + rng() * 0.4, nightAction(rng))];
      },
    },
    {
      name: "slalom", tier: 2, weight: 2,
      build: (lanes, rng) => {
        // Три ряда, в каждом свободна одна дорожка, и она смещается на соседнюю.
        let free = anyLane(rng, lanes);
        const cells: NightCell[] = [];
        for (let row = 0; row < 3; row += 1) {
          const at = row * NIGHT_STEP_SECONDS;
          // Магнит или энергобарьер — не больше одного на ряд и только рядом со свободной дорожкой: от него есть куда уйти.
          const zone = rng() < 0.35 ? either(rng, free - 1, free + 1) : -1;
          const avoid: NightObstacleKind = rng() < 0.5 ? "magnetic-zone" : "energy-wall";
          for (const lane of allLanes(lanes)) {
            if (lane === free) continue;
            cells.push(ncell(lane, at + jitter(rng), lane === zone ? avoid : nightAction(rng)));
          }
          free = free === 0 ? 1 : free === lanes - 1 ? lanes - 2 : free + either<number>(rng, -1, 1);
        }
        return cells;
      },
    },
    {
      name: "barrier", tier: 2, weight: 1.2,
      build: (lanes, rng) => {
        // Энергобарьер на одной дорожке, через дорожку — действие: объезд ведёт на свободную.
        const lane = anyLane(rng, lanes);
        const cells = [ncell(lane, 0, "energy-wall")];
        const far = lane + 2 < lanes ? lane + 2 : lane - 2 >= 0 ? lane - 2 : -1;
        if (far >= 0 && rng() < 0.7) cells.push(ncell(far, jitter(rng), nightAction(rng)));
        return cells;
      },
    },
    {
      name: "magnet-trap", tier: 2, weight: 1.2,
      build: (lanes, rng) => {
        const lane = anyLane(rng, lanes);
        const direction = directionFor(lane, lanes, rng);
        // Магнит сдвигает на соседнюю дорожку, а там через мгновение консоль: снижайся.
        return [ncell(lane, 0, "magnetic-zone"), ncell(lane + direction, 0.8, "repair-arm")];
      },
    },
    // --- Уровень 3 ---
    {
      name: "double-shuttle", tier: 3, weight: 1.2,
      build: (lanes, rng, room) => {
        const span = shuttleMeetSpan(baseSpeed);
        const second = 1 + rng() * 0.3;
        if (span + second * planSpeed > room) return null;
        const first = anyLane(rng, lanes);
        const other = first === 0 ? 1 : first === lanes - 1 ? lanes - 2 : first + either<number>(rng, -1, 1);
        return [ncell(first, 0, "shuttle"), ncell(other, second, "shuttle")];
      },
    },
    {
      name: "gate-slalom", tier: 3, weight: 1,
      build: (lanes, rng) => {
        const gate = allLanes(lanes).map((lane) => ncell(lane, jitter(rng), nightAction(rng)));
        const zone = anyLane(rng, lanes);
        const cells = [...gate];
        for (const lane of allLanes(lanes)) {
          if (lane === zone) cells.push(ncell(lane, NIGHT_STEP_SECONDS, "magnetic-zone"));
          else if (rng() < 0.6) cells.push(ncell(lane, NIGHT_STEP_SECONDS + jitter(rng), otherAction(gate[lane].kind)));
        }
        return cells;
      },
    },
  ];
}

function nightIntro(): Pattern<NightObstacleKind>[] {
  const wall = (kind: NightObstacleKind): Pattern<NightObstacleKind> => ({
    name: `intro-${kind}`, tier: 1, weight: 1,
    build: (lanes, rng) => allLanes(lanes).map((lane) => ({ lane, at: rng() * 0.08, kind, length: LENGTH[kind] })),
  });
  return [
    wall("repair-bot"),
    wall("repair-arm"),
    { name: "intro-magnetic-zone", tier: 1, weight: 1, build: (lanes, rng) => [{ lane: anyLane(rng, lanes), at: 0, kind: "magnetic-zone", length: LENGTH["magnetic-zone"] }] },
  ];
}

const nightDictionaries = new Map<number, Dictionary<NightObstacleKind>>();
function nightDictionary(baseSpeed: number): Dictionary<NightObstacleKind> {
  let dict = nightDictionaries.get(baseSpeed);
  if (!dict) {
    dict = {
      patterns: nightPatterns(baseSpeed, baseSpeed * PLAN_SPEED_FACTOR),
      intro: nightIntro(),
      looks: (kind) => NIGHT_LOOKS[kind],
      // Награда за чистую серию — ускорительные кольца на всех дорожках.
      reward: { name: "boost-ring", tier: 1, weight: 0, build: (lanes) => allLanes(lanes).map((lane) => ({ lane, at: 0, kind: "boost-ring", length: LENGTH["boost-ring"] })) },
      maxTier: (input: FillInput) => (input.more && input.gateIndex >= 7 ? 3 : input.gateIndex >= 4 ? 2 : 1),
      // Окно ночью короче (чтение и восстановление — на 1,5× базы), такты чаще.
      gaps: { normal: [1.6, 2.4], more: [0.35, 0.6] },
    };
    nightDictionaries.set(baseSpeed, dict);
  }
  return dict;
}

/**
 * Куда тянет магнит: на соседнюю дорожку, где вскоре робот или консоль (сдвиг
 * ведёт под действие), иначе — туда, где нет другого магнита и челнока.
 */
function magnetDirection(zone: PlacedCell<NightObstacleKind>, cells: PlacedCell<NightObstacleKind>[], lanes: number, planSpeed: number, rng: Rng): -1 | 1 {
  const options = ([-1, 1] as const).filter((d) => zone.lane + d >= 0 && zone.lane + d < lanes);
  const near = (d: number, kinds: NightObstacleKind[], after: number) => cells.some((other) => other.lane === zone.lane + d && kinds.includes(other.kind)
    && other.distance >= zone.distance - 3 && other.distance <= zone.distance + after);
  const action = options.filter((d) => near(d, ["repair-bot", "repair-arm"], planSpeed * 1.2));
  if (action.length) return action[Math.floor(rng() * action.length)];
  const safe = options.filter((d) => !near(d, ["magnetic-zone", "shuttle", "energy-wall"], LENGTH["magnetic-zone"] + planSpeed));
  const pool = safe.length ? safe : options;
  return pool.length > 1 ? directionFor(zone.lane, lanes, rng) : pool[0];
}

export interface NightPlanInput {
  start: number;
  end: number;
  baseSpeed: number;
  lanes: number;
  gateIndex: number;
  placed: number;
  /** «Больше препятствий». */
  more?: boolean;
  /** Заслужено ускорительное кольцо. */
  reward?: boolean;
}

/**
 * Опасности участка — тактами из паттернов (см. course.ts). Челнок ставится
 * так, чтобы в окно попала встреча с байком на любой скорости, а стоянка может
 * быть и дальше; на его дорожке до стоянки других опасностей нет — он едет сквозь.
 */
export function planNightObstacles(rng: Rng, input: NightPlanInput): { rows: NightPlannedObstacle[]; beats: number; rewarded: boolean } {
  if (input.gateIndex < 2) return { rows: [], beats: 0, rewarded: false };
  const planSpeed = input.baseSpeed * PLAN_SPEED_FACTOR;
  const { from, to } = nightWindow(input);
  const result = fillWindow(rng, {
    from, to, speed: planSpeed, lanes: input.lanes, more: Boolean(input.more), gateIndex: input.gateIndex, placed: input.placed, reward: input.reward,
  }, nightDictionary(input.baseSpeed));
  const rows: NightPlannedObstacle[] = result.cells.map((cell) => {
    const direction = cell.kind === "magnetic-zone" ? magnetDirection(cell, result.cells, input.lanes, planSpeed, rng) : directionFor(cell.lane, input.lanes, rng);
    const look = { variant: cell.variant, beat: cell.beat, pattern: cell.pattern, lane: cell.lane, direction };
    if (cell.kind !== "shuttle") return { ...look, distance: cell.distance, kind: cell.kind, length: LENGTH[cell.kind] };
    return { ...look, distance: cell.distance + shuttleMeetOffset(input.baseSpeed), kind: "shuttle", length: SHUTTLE_LENGTH };
  });
  // Челнок едет от стоянки навстречу: всё на его дорожке до стоянки он прошёл бы насквозь.
  const meet = (row: NightPlannedObstacle) => (row.kind === "shuttle" ? row.distance - shuttleMeetOffset(input.baseSpeed) : row.distance);
  const kept: NightPlannedObstacle[] = [];
  const isAction = (row: NightPlannedObstacle) => row.kind === "repair-bot" || row.kind === "repair-arm";
  const step = planSpeed * NIGHT_STEP_SECONDS - 1e-6;
  for (const row of rows.sort((a, b) => meet(a) - meet(b))) {
    const blocked = kept.some((shuttle) => shuttle.kind === "shuttle" && shuttle.lane === row.lane
      && row.distance + row.length > meet(shuttle) - 2 && row.distance < shuttle.distance + SHUTTLE_LENGTH + 2);
    // Прыжок или снижение после другого — не раньше, чем успевает байк на полном газу: и на своей
    // дорожке, и на соседней (объезд проходит через неё). Соседи в одном ряду не мешают — байк на одной из них.
    const crowded = isAction(row) && kept.some((other) => isAction(other) && Math.abs(other.lane - row.lane) <= 1
      && row.distance - other.distance < step && (other.lane === row.lane || row.distance - other.distance > planSpeed * 0.3));
    if (!blocked && !crowded) kept.push(row);
  }
  // И сам челнок не едет сквозь то, что уже стоит на его дорожке дальше встречи.
  const clear = kept.filter((row) => row.kind !== "shuttle" || !kept.some((other) => other !== row && other.lane === row.lane
    && other.distance + other.length > meet(row) - 2 && other.distance < row.distance + SHUTTLE_LENGTH + 2));
  return { rows: clear.sort((a, b) => a.distance - b.distance), beats: result.beats, rewarded: result.rewarded };
}

/** Проверяем весь объём байка, а не только выбранный индекс дорожки. */
export function touchesNightObstacle(kind: NightObstacleKind, lane: number, lanes: number, x: number, feet: number, depth: number): boolean {
  if (Math.abs(x - laneX(lane, lanes)) > NIGHT_OBSTACLE_HALF_WIDTH + BIKE_HALF_WIDTH) return false;
  if (kind === "repair-bot") return feet < BOT_CLEARANCE;
  if (kind === "magnetic-zone") return feet < ZONE_CLEARANCE;
  if (kind === "shuttle") return feet < SHUTTLE_TOP;
  if (kind === "energy-wall") return feet < WALL_TOP;
  if (kind === "boost-ring") return false;
  // Верх шлема без снижения — 2,15 м, при полном снижении — 1,3 м.
  return feet + 2.15 - depth * 0.85 >= ARM_BOTTOM;
}

/**
 * Сила столкновения ночью: челнок — крушение, магнит — задел (и сдвиг), робот и
 * консоль — задел, если почти взял (по высоте или краем корпуса), иначе удар.
 */
export function nightImpact(kind: NightObstacleKind, lane: number, lanes: number, x: number, feet: number, depth: number): Severity {
  if (kind === "shuttle") return "crash";
  if (kind === "magnetic-zone") return "graze";
  const edge = Math.abs(x - laneX(lane, lanes)) > NIGHT_OBSTACLE_HALF_WIDTH + BIKE_HALF_WIDTH - 0.35;
  if (edge) return "graze";
  if (kind === "energy-wall") return "hit";
  if (kind === "repair-bot") return feet >= BOT_CLEARANCE - GRAZE_MARGIN ? "graze" : "hit";
  return feet + 2.15 - depth * 0.85 - ARM_BOTTOM < GRAZE_MARGIN ? "graze" : "hit";
}

/** Где челнок встретит байк, если тот едет с постоянной скоростью `speed`: смещение от стоянки назад, м. */
export function shuttleMeetOffset(speed: number): number {
  return (SHUTTLE_TRIGGER * SHUTTLE_SPEED) / (speed + SHUTTLE_SPEED);
}

/** Доля продольного пересечения за кадр: нужна для позы и положения при встрече. */
export function crossingShare(previousDistance: number, distance: number, at: number): number {
  return Math.max(0, Math.min(1, (at - previousDistance) / Math.max(1e-6, distance - previousDistance)));
}

export function forcedLane(lane: number, direction: -1 | 1, lanes: number): number {
  return Math.max(0, Math.min(lanes - 1, lane + direction));
}

export const nightLaneAt = (x: number, lanes: number) => Math.max(0, Math.min(lanes - 1, Math.round(x / LANE_WIDTH + (lanes - 1) / 2)));
