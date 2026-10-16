import { anyLane, either, fillWindow, type Dictionary, type FillInput, type Pattern, type PatternCell } from "./course";
import { GRAZE_MARGIN, type Severity } from "./impact";
import { shuffle, type Rng } from "./random";

/**
 * Препятствия между воротами — клетки на отдельных треках: барьер (прыжок),
 * балка (подкат), вагонетки (заскок на крышу, иногда с пандусом). Каждый трек
 * проходим на месте, поэтому выбор трека остаётся ответом на вопрос, а
 * препятствия проверяют внимание. Трамплин-катапульта — подарок: подбрасывает
 * бегуна высоко над путями к дуге монет; стоит сразу на всех треках.
 * Расстановка — тактами из паттернов (см. course.ts).
 */
export type ObstacleKind = "hurdle" | "bar" | "wagons" | "ramp" | "slope" | "handcar";

/** Прыжок с земли: сколько длится и на какую высоту поднимает ступни. */
export const JUMP_SECONDS = 0.7;
export const JUMP_HEIGHT = 1.2;
/** Баллистика того же прыжка: высота пика JUMP_HEIGHT ровно через JUMP_SECONDS / 2. */
export const GRAVITY = (8 * JUMP_HEIGHT) / (JUMP_SECONDS * JUMP_SECONDS);
export const JUMP_VELOCITY = (4 * JUMP_HEIGHT) / JUMP_SECONDS;
/** Подкат в воздухе: бегун ныряет вниз с этой скоростью. */
export const DIVE_VELOCITY = 11;
/** Подкат: сколько бегун лежит под балкой. */
export const SLIDE_SECONDS = 0.8;

/**
 * Размеры препятствий от уровня шпал. Сцена рисует их по этим же числам,
 * поэтому «взял / задел» в логике совпадает с картинкой.
 */
export const HURDLE_TOP = 0.5;
/** Ступни выше этой высоты в момент прохода — барьер взят с запасом под длину стопы. */
export const HURDLE_CLEARANCE = 0.7;
export const BAR_BOTTOM = 1.4;
/** Верх поперечной части каждого облика: балка, знак, шлагбаум, баннер, труба. */
export const BAR_TOPS = [1.82, 2.34, 1.58, 1.95, 1.94] as const;
/** Крыша вагонетки — по ней бегут. */
export const DECK_HEIGHT = 1.05;
/** На сколько ниже крыши можно быть у переднего края, чтобы ещё заскочить без удара. */
export const STEP_UP = 0.4;
export const WAGON_LENGTH = 7;
export const WAGON_GAP = 0.8;
/** Трамплин: подъём длиной RAMP_LENGTH до высоты RAMP_TOP, с края — бросок вверх. */
export const RAMP_LENGTH = 5;
export const RAMP_TOP = 0.9;
export const LAUNCH_VELOCITY = 9;

/**
 * Встречная дрезина (испытание уровня 3): низкая платформа высотой с барьер, едет
 * навстречу, когда бегун подбежал на HANDCAR_TRIGGER. Берётся прыжком, но
 * встречное движение сокращает время на реакцию.
 */
export const HANDCAR_TOP = HURDLE_TOP;
export const HANDCAR_LENGTH = 2.4;
export const HANDCAR_TRIGGER = 60;
export const HANDCAR_SPEED = 6;

/** Где дрезина встретит бегуна, бегущего со скоростью `speed`: смещение от стоянки назад, м. */
export function handcarMeetOffset(speed: number): number {
  return (HANDCAR_TRIGGER * HANDCAR_SPEED) / (speed + HANDCAR_SPEED);
}

export const BUMP_PENALTY = 25;
export const COIN_POINTS = 10;

/** Первые секунды вопроса — только чтение, последние перед воротами — только выбор трека. */
const READ_FIRST = 1.1;
const GATE_CLEAR = 1.5;
/** Пандус на крыши вагонеток: подъём до DECK_HEIGHT без броска. */
export const SLOPE_LENGTH = 4.5;

/** Высота ступней в прыжке с земли; `t` — доля прыжка 0…1. */
export function jumpHeight(t: number): number {
  if (t < 0 || t > 1) return 0;
  return 4 * JUMP_HEIGHT * t * (1 - t);
}

/**
 * Насколько бегун «лёг» в подкате, 0…1; `t` — доля подката. Этой же кривой
 * обе модели бегуна опускают тело, так что под балкой проходит только то,
 * что уже лежит.
 */
export function slideDepth(t: number): number {
  if (t < 0 || t > 1) return 0;
  const x = Math.min(1, t / 0.16, (1 - t) / 0.24);
  return x * x * (3 - 2 * x);
}

/** Насколько надо лечь, чтобы пройти под балкой: почти полностью — смешанная поза «полулёжа» у модели ещё выше балки. */
export const SLIDE_LOW = 0.95;

export function clearsObstacle(kind: ObstacleKind, feetHeight: number, depth: number, variant = 0): boolean {
  if (kind === "ramp" || kind === "slope") return true;
  if (kind === "hurdle" || kind === "handcar") return feetHeight >= HURDLE_CLEARANCE;
  if (kind === "bar") return feetHeight >= (BAR_TOPS[variant] ?? BAR_TOPS[0]) + 0.08 || depth >= SLIDE_LOW && feetHeight < BAR_BOTTOM - 0.9;
  return feetHeight >= DECK_HEIGHT - STEP_UP;
}

/**
 * Сила столкновения в городе; null — взял чисто. Чуть низкий прыжок, неполный
 * подкат и заскок «почти до крыши» — задел, остальное — удар.
 */
export function cityImpact(kind: ObstacleKind, feetHeight: number, depth: number, variant = 0): Severity | null {
  if (clearsObstacle(kind, feetHeight, depth, variant)) return null;
  if (kind === "hurdle" || kind === "handcar") return feetHeight >= HURDLE_CLEARANCE - GRAZE_MARGIN ? "graze" : "hit";
  if (kind === "bar") return depth >= 0.7 && feetHeight < BAR_BOTTOM - 0.9 ? "graze" : "hit";
  if (kind === "wagons") return feetHeight >= DECK_HEIGHT - STEP_UP - GRAZE_MARGIN * 2 ? "graze" : "hit";
  return null;
}

/** Длина состава из `cars` вагонеток. */
export function wagonsLength(cars: number): number {
  return cars * WAGON_LENGTH + (cars - 1) * WAGON_GAP;
}

/** Высота подъёма трамплина на расстоянии `along` от его начала. */
export function rampHeight(along: number): number {
  if (along < 0 || along > RAMP_LENGTH) return 0;
  return (RAMP_TOP * along) / RAMP_LENGTH;
}

/** Высота пандуса к крышам на расстоянии `along` от его начала. */
export function slopeHeight(along: number): number {
  if (along < 0 || along > SLOPE_LENGTH) return 0;
  return (DECK_HEIGHT * along) / SLOPE_LENGTH;
}

/** Полёт с края трамплина до шпал, с. */
export function rampFlightSeconds(): number {
  const peak = RAMP_TOP + (LAUNCH_VELOCITY * LAUNCH_VELOCITY) / (2 * GRAVITY);
  return LAUNCH_VELOCITY / GRAVITY + Math.sqrt((2 * peak) / GRAVITY);
}

/** Сколько пути занимает трамплин вместе с полётом: на нём не место другим рядам. */
export function rampFootprint(speed: number): number {
  return RAMP_LENGTH + speed * rampFlightSeconds() + speed * 0.3;
}

export interface PlannedObstacle {
  distance: number;
  lane: number;
  kind: ObstacleKind;
  /** Протяжённость по дистанции: у вагонеток — длина состава, у трамплина — с полётом, у пандуса — подъём, у остальных 0. */
  length: number;
  /** Облик: у барьера — барьер или ящики, у балки — балка или знак, у вагонеток — окраска. */
  variant: number;
  /** Паттерн, из которого клетка. */
  pattern: string;
  /** Номер такта в окне, с 0. */
  beat: number;
}

export interface PlanInput {
  /** Дистанция, на которой появился вопрос. */
  start: number;
  /** Дистанция ворот. */
  end: number;
  speed: number;
  lanes: number;
  /** «Больше препятствий». */
  more: boolean;
  /** Номер вопроса в забеге, с 1. */
  gateIndex: number;
  /** Сколько тактов уже было в забеге: первые три знакомят с барьером, балкой и вагонетками. */
  placed: number;
  /** Заслужена катапульта-награда: ставится первым тактом. */
  reward?: boolean;
}

/**
 * Сколько обликов у вида: сцена рисует столько же. Барьер: барьер, ящики, конусы
 * с лентой, бетонный блок, стопка учебников. Балка: балка, знак, ж/д шлагбаум,
 * растяжка «СЕССИЯ», труба теплотрассы.
 */
export const OBSTACLE_LOOKS: Record<ObstacleKind, number> = { hurdle: 5, bar: 5, wagons: 4, ramp: 1, slope: 1, handcar: 1 };

/** Через барьер с последующей балкой на том же треке — нырок в воздухе: столько секунд между ними. */
export const DIVE_AFTER = 0.5;
/** Два действия подряд на одном треке («двойка»): прыжок → подкат или подкат → прыжок. */
export const DOUBLE_AFTER = 0.95;

type Cell = PatternCell<ObstacleKind>;
const cell = (lane: number, at: number, kind: ObstacleKind, length = 0): Cell => ({ lane, at, kind, length });
const action = (rng: Rng): ObstacleKind => (rng() < 0.55 ? "hurdle" : "bar");
const opposite = (kind: ObstacleKind): ObstacleKind => (kind === "hurdle" ? "bar" : "hurdle");
const lanesOf = (lanes: number) => Array.from({ length: lanes }, (_, lane) => lane);
/** Чуть разное время клеток одного ряда: ряд не встаёт ровной линейкой. */
const jitter = (rng: Rng) => rng() * 0.18;

/** Действия по всем трекам, среди которых есть и прыжок, и подкат. */
function mixedWall(rng: Rng, lanes: number): ObstacleKind[] {
  const kinds = lanesOf(lanes).map(() => action(rng));
  if (kinds.every((kind) => kind === kinds[0])) kinds[Math.floor(rng() * lanes)] = opposite(kinds[0]);
  return kinds;
}

function cityPatterns(speed: number): Pattern<ObstacleKind>[] {
  const cars = (rng: Rng, room: number, extra: number) => {
    const three = wagonsLength(3) + extra <= room && rng() < 0.4;
    return wagonsLength(three ? 3 : 2);
  };
  const fitsWagons = (room: number, extra = 0) => wagonsLength(2) + extra <= room;
  return [
    // --- Уровень 1 ---
    { name: "single", tier: 1, weight: 3, build: (lanes, rng) => [cell(anyLane(rng, lanes), 0, action(rng))] },
    {
      name: "pair", tier: 1, weight: 3,
      build: (lanes, rng) => {
        const left = Math.floor(rng() * (lanes - 1));
        const [a, b] = either<ObstacleKind[]>(rng, ["hurdle", "bar"], ["bar", "hurdle"]);
        return [cell(left, jitter(rng), a), cell(left + 1, jitter(rng), b)];
      },
    },
    {
      name: "wagon", tier: 1, weight: 2,
      build: (lanes, rng, room) => (fitsWagons(room) ? [cell(anyLane(rng, lanes), 0, "wagons", cars(rng, room, 0))] : null),
    },
    // --- Уровень 2 ---
    {
      name: "wall", tier: 2, weight: 2,
      build: (lanes, rng) => mixedWall(rng, lanes).map((kind, lane) => cell(lane, jitter(rng), kind)),
    },
    {
      name: "ladder", tier: 2, weight: 2,
      build: (lanes, rng) => {
        let kind = action(rng);
        return lanesOf(lanes).map((lane) => {
          const placed = cell(lane, lane * 0.45, kind);
          kind = opposite(kind);
          return placed;
        });
      },
    },
    {
      name: "double", tier: 2, weight: 1.5,
      build: (lanes, rng) => {
        const chosen = shuffle(lanesOf(lanes), rng).slice(0, lanes > 3 && rng() < 0.5 ? 3 : 2);
        const kinds = mixedWall(rng, chosen.length);
        return chosen.flatMap((lane, i) => [cell(lane, 0, kinds[i]), cell(lane, DOUBLE_AFTER, opposite(kinds[i]))]);
      },
    },
    {
      name: "corridor", tier: 2, weight: 1.5,
      build: (lanes, rng, room) => {
        if (!fitsWagons(room)) return null;
        const length = cars(rng, room, 0);
        const middle = lanesOf(lanes).slice(1, -1);
        const kinds = middle.length > 1 ? mixedWall(rng, middle.length) : [action(rng)];
        const at = (length / speed) * (0.3 + rng() * 0.3);
        return [
          cell(0, 0, "wagons", length),
          cell(lanes - 1, jitter(rng), "wagons", length),
          ...middle.map((lane, i) => cell(lane, at + jitter(rng), kinds[i])),
        ];
      },
    },
    {
      name: "train", tier: 2, weight: 2,
      build: (lanes, rng, room) => {
        if (!fitsWagons(room, SLOPE_LENGTH + speed * 0.2)) return null;
        const free = anyLane(rng, lanes);
        const train = lanesOf(lanes).filter((lane) => lane !== free);
        const slope = train[Math.floor(rng() * train.length)];
        const length = cars(rng, room, SLOPE_LENGTH + speed * 0.2);
        const onDeck = SLOPE_LENGTH / speed;
        return [
          cell(slope, 0, "slope", SLOPE_LENGTH),
          ...train.map((lane) => cell(lane, lane === slope ? onDeck : onDeck + rng() * 0.2, "wagons", length)),
          cell(free, onDeck + (length / speed) * (0.3 + rng() * 0.3), action(rng)),
        ];
      },
    },
    // --- Уровень 3 ---
    {
      name: "jump-dive", tier: 3, weight: 1.5,
      build: (lanes, rng) => {
        const lane = anyLane(rng, lanes);
        const cells = [cell(lane, 0, "hurdle"), cell(lane, DIVE_AFTER, "bar")];
        // Сосед — наоборот: подкат, затем прыжок.
        const neighbour = lane === 0 ? 1 : lane === lanes - 1 ? lanes - 2 : lane + (rng() < 0.5 ? -1 : 1);
        cells.push(cell(neighbour, 0.1, "bar"), cell(neighbour, 0.1 + DOUBLE_AFTER, "hurdle"));
        return cells;
      },
    },
    {
      name: "wall-ladder", tier: 3, weight: 1.2,
      build: (lanes, rng) => {
        const wall = mixedWall(rng, lanes).map((kind, lane) => cell(lane, 0, kind));
        const reverse = rng() < 0.5;
        const ladder = lanesOf(lanes).map((lane) => {
          const step = reverse ? lanes - 1 - lane : lane;
          return cell(lane, 1 + step * 0.42, opposite(wall[lane].kind));
        });
        return [...wall, ...ladder];
      },
    },
    {
      name: "handcar", tier: 3, weight: 1.2,
      build: (lanes, rng, room) => {
        // Клетка дрезины — от встречи до стоянки: на её треке в этом отрезке ничего нет, она едет сквозь.
        const length = handcarMeetOffset(speed) + HANDCAR_LENGTH;
        if (length > room) return null;
        const lane = anyLane(rng, lanes);
        const side = lane === 0 ? 1 : lane === lanes - 1 ? lanes - 2 : lane + (rng() < 0.5 ? -1 : 1);
        return [cell(lane, 0, "handcar", length), cell(side, 0.15 + rng() * 0.3, action(rng))];
      },
    },
    {
      name: "train-double", tier: 3, weight: 1,
      build: (lanes, rng, room) => {
        if (!fitsWagons(room)) return null;
        const length = cars(rng, room, 0);
        const wagons = shuffle(lanesOf(lanes), rng).slice(0, lanes > 3 ? 2 : 1);
        const free = lanesOf(lanes).filter((lane) => !wagons.includes(lane));
        const first = action(rng);
        return [
          ...wagons.map((lane) => cell(lane, rng() * 0.2, "wagons", length)),
          ...free.flatMap((lane) => [cell(lane, 0.15, first), cell(lane, 0.15 + DOUBLE_AFTER, opposite(first))]),
        ];
      },
    },
  ];
}

/** Знакомство: первые три такта — стена одного действия, чтобы его точно встретить. */
function cityIntro(): Pattern<ObstacleKind>[] {
  const wall = (kind: ObstacleKind): Pattern<ObstacleKind> => ({
    name: `intro-${kind}`, tier: 1, weight: 1,
    build: (lanes, rng) => lanesOf(lanes).map((lane) => cell(lane, jitter(rng) * 0.5, kind)),
  });
  return [
    wall("hurdle"),
    wall("bar"),
    {
      name: "intro-wagons", tier: 1, weight: 1,
      build: (lanes, rng, room) => (wagonsLength(2) <= room ? lanesOf(lanes).map((lane) => cell(lane, rng() * 0.15, "wagons", wagonsLength(2))) : null),
    },
  ];
}

const dictionaries = new Map<number, Dictionary<ObstacleKind>>();
function cityDictionary(speed: number): Dictionary<ObstacleKind> {
  let dict = dictionaries.get(speed);
  if (!dict) {
    dict = {
      patterns: cityPatterns(speed),
      intro: cityIntro(),
      looks: (kind) => OBSTACLE_LOOKS[kind],
      maxTier: (input: FillInput) => (input.more && input.gateIndex >= 7 ? 3 : input.gateIndex >= 4 ? 2 : 1),
      // Катапульта — награда за чистую серию: трамплин на всех треках к дуге монет.
      reward: {
        name: "catapult", tier: 1, weight: 0,
        build: (lanes, _rng, room) => {
          const length = rampFootprint(speed);
          return length <= room ? lanesOf(lanes).map((lane) => cell(lane, 0, "ramp", length)) : null;
        },
      },
    };
    dictionaries.set(speed, dict);
  }
  return dict;
}

/**
 * Где на отрезке вопроса поставить препятствия. На первом вопросе их нет —
 * сначала игрок привыкает к карточкам. Окно — после чтения вопроса и до
 * зоны выбора трека у ворот; вагонетки и трамплин заканчиваются до неё.
 */
export function planObstacles(rng: Rng, input: PlanInput): { rows: PlannedObstacle[]; beats: number; rewarded: boolean } {
  const { start, end, speed, gateIndex } = input;
  const from = start + speed * READ_FIRST;
  const to = end - speed * GATE_CLEAR;
  if (gateIndex < 2 || to - from < speed * 0.4) return { rows: [], beats: 0, rewarded: false };
  const result = fillWindow(rng, {
    from,
    to,
    speed,
    lanes: input.lanes,
    more: input.more,
    gateIndex,
    placed: input.placed,
    reward: input.reward,
  }, cityDictionary(speed));
  // Дрезина стоит на стоянке и тронется навстречу: в плане клетка — от точки встречи.
  const rows = result.cells.map((cell) => cell.kind === "handcar"
    ? { ...cell, distance: cell.distance + handcarMeetOffset(speed), length: HANDCAR_LENGTH }
    : cell);
  return { rows: rows.sort((a, b) => a.distance - b.distance || a.lane - b.lane), beats: result.beats, rewarded: result.rewarded };
}

/** Монеты под балкой: низко, у земли — стоя их не достать, только подкатом. */
export const BAR_COINS: CoinSpot[] = [
  { offset: -1.6, height: 0.55 },
  { offset: 0, height: 0.55 },
  { offset: 1.6, height: 0.55 },
];

export interface CoinSpot {
  /** Смещение по дистанции от начала препятствия. */
  offset: number;
  height: number;
}

/**
 * Дуга монет над барьером. Нижняя монета выше макушки стоящего бегуна —
 * собрать их можно только прыжком.
 */
export const HURDLE_COINS: CoinSpot[] = [
  { offset: -4, height: 2.05 },
  { offset: -2, height: 2.3 },
  { offset: 0, height: 2.45 },
  { offset: 2, height: 2.3 },
  { offset: 4, height: 2.05 },
];

/** Монеты к вагонеткам: дуга на заскок и дорожка по крышам. */
export function wagonCoins(length: number): CoinSpot[] {
  const spots: CoinSpot[] = [
    { offset: -3, height: 2.1 },
    { offset: -1, height: 2.45 },
  ];
  for (let offset = 1.5; offset <= length - 1; offset += 2.2) spots.push({ offset, height: DECK_HEIGHT + 1 });
  return spots;
}

/**
 * Монеты к трамплину: две на подъёме и дуга по траектории броска — на уровне
 * груди, так что берутся сами, если не нырять вниз.
 */
export function rampCoins(speed: number): CoinSpot[] {
  const spots: CoinSpot[] = [
    { offset: 1.6, height: rampHeight(1.6) + 1 },
    { offset: 3.6, height: rampHeight(3.6) + 1 },
  ];
  const flight = rampFlightSeconds();
  for (let t = 0.12; t < flight - 0.2; t += 0.13) {
    spots.push({ offset: RAMP_LENGTH + speed * t, height: RAMP_TOP + LAUNCH_VELOCITY * t - (GRAVITY * t * t) / 2 + 1 });
  }
  return spots;
}

/**
 * Рост бегуна: стоя и в подкате. Монета берётся, если она в этом диапазоне над ступнями.
 * Стоя руки не тянутся ниже колен — монеты под балкой (0,55 м) берёт только подкат.
 */
export const BODY = { standing: 1.9, sliding: 0.8, reachBelow: 0.3, standingReachBelow: 0.7 };

export function touchesCoin(coinHeight: number, feetHeight: number, sliding: boolean): boolean {
  const top = feetHeight + (sliding ? BODY.sliding : BODY.standing);
  return coinHeight >= feetHeight + (sliding ? BODY.reachBelow : BODY.standingReachBelow) && coinHeight <= top;
}
