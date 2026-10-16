import type { QuizItem, RunAnswerIn } from "../api/types";
import { LANE_WIDTH, laneX } from "./constants";
import {
  cityImpact,
  COIN_POINTS,
  DECK_HEIGHT,
  DIVE_VELOCITY,
  GRAVITY,
  HANDCAR_SPEED,
  HANDCAR_TRIGGER,
  HURDLE_COINS,
  JUMP_SECONDS,
  JUMP_VELOCITY,
  LAUNCH_VELOCITY,
  planObstacles,
  RAMP_LENGTH,
  RAMP_TOP,
  rampCoins,
  rampHeight,
  BAR_COINS,
  SLOPE_LENGTH,
  SLIDE_SECONDS,
  slopeHeight,
  slideDepth,
  touchesCoin,
  wagonCoins,
  type CoinSpot,
  type ObstacleKind,
  type PlannedObstacle,
} from "./engine/obstacles";
import { Playlist, type Gate } from "./engine/playlist";
import { createRng, type Rng } from "./engine/random";
import { addPoints, applyAnswer, initialScore, scoreRules, STAY_SHARE, type ScoreRules, type ScoreState } from "./engine/scoring";
import type { SessionSettings } from "./engine/settings";
import { answerSeconds, GAP_SECONDS, RUN_SPEED } from "./engine/timing";
import { initialHud, useHud, type Mistake, type MoveHint, type Phase, type RunResult } from "./store";
import { ACCELERATION, advanceSpeed, BRAKING, MAX_SPEED_FACTOR, SpeedControl } from "./engine/speed";
import { CHASE_SECONDS, escalate, IMPACTS, Slowdown, type Severity } from "./engine/impact";
import { crossingShare, forcedLane, nightClearDistance, nightImpact, planNightObstacles, RING_BOOST, SHUTTLE_SPEED, SHUTTLE_TRIGGER, touchesNightObstacle, type NightPlannedObstacle, type NightObstacleKind } from "./engine/night-obstacles";
import { FLIGHT_HEIGHT, MAGNET_REACH, SHIELD_REACH, ModifierPlanner, ModifierState, type ModifierKind, type ModifierPickup } from "./engine/modifiers";

const INTRO_SECONDS = 2.6;
const COUNT_STEP = 0.75;
const FIRST_QUESTION_AFTER = 1.4;
const FINISH_AFTER = 2.4;
const RESULTS_DELAY = { finished: 1.9, gameover: 2.1 };
const LANE_DAMPING = 13;
/** Длина полного цикла бега (два шага), м: по ней шагают ноги обеих моделей и звучат шаги. */
export const STRIDE_LENGTH = 6.8;
/** Доли цикла, на которых стопа касается опоры. */
const FOOTFALLS = [0.19, 0.69];
/** После схода с опоры прыжок ещё можно нажать столько секунд. */
const COYOTE_SECONDS = 0.1;
/** За сколько секунд до первого барьера (балки) показать подсказку клавиш. */
const HINT_LEAD = 1.8;
/** Карточки открывают вид на опасности на любой дорожке в этом радиусе перед байком. */
const NIGHT_DANGER_DISTANCE = 35;
/** Уход с трека и возврат быстрее этого — объезд, а не смена решения. */
const EXCURSION_SECONDS = 1.2;
/** Награда (катапульта, кольцо) — за столько тактов подряд без касаний; «Больше» — REWARD_BEATS.more. */
export const REWARD_BEATS = { normal: 6, more: 8 } as const;
/** Награда — не чаще чем раз в столько вопросов. */
export const REWARD_EVERY = 3;
/** Монеты подряд, взятые с паузой меньше этой, повышают тон звука. */
const COIN_CHAIN_SECONDS = 1.2;
/**
 * Трасса расставлена вперёд хотя бы на столько метров от бегуна: препятствия
 * рождаются за видимой далью (туман и рост рядов — до 190 м), а не перед носом.
 */
export const COURSE_HORIZON = 230;
/**
 * Сколько вопросов можно взять из очереди наперёд. При 4 повтор ошибки всё равно
 * приходит через 3–5 вопросов: раньше, чем взятые наперёд, его не поставить.
 */
export const MAX_AHEAD = 4;

export interface ActiveGate {
  gate: Gate;
  seconds: number;
  /** Где стоят ворота (пройденная дистанция). */
  distance: number;
  appearedAt: number;
  appearedClock: number;
  /** Трек бегуна в момент появления вопроса: остался на нём — бонус за решение половинный. */
  appearedLane: number;
  lastChangeAt: number;
  lastChangeClock: number;
  /** null — ещё не пройдены. */
  chosenLane: number | null;
  correct: boolean | null;
  judgedClock: number;
}

/** Препятствие на одном треке. */
export interface ObstacleRow extends PlannedObstacle {
  id: number;
  resolved: boolean;
  /** Бегун встретил его на своём треке. */
  met: boolean;
  hit: boolean;
  resolvedClock: number;
}

export interface Coin {
  id: number;
  distance: number;
  lane: number;
  height: number;
  resolved: boolean;
  taken: boolean;
  takenClock: number;
  attracted?: boolean;
}

export interface NightObstacle extends NightPlannedObstacle {
  id: number;
  resolved: boolean;
  hit: boolean;
  resolvedClock: number;
  /** Щит убрал объект с пути; фаза оставляет его на месте. */
  neutralized?: boolean;
  protected?: boolean;
}

export type RuntimeEvent =
  | { type: "modifier"; kind: ModifierKind; action: "pickup" | "end" }
  | { type: "shield-pulse"; id: number; lane: number; charges: number }
  | { type: "lane"; lane: number; direction: -1 | 1 }
  | { type: "jump" }
  | { type: "land"; impact: number; surface: Surface }
  | { type: "step"; surface: Surface }
  | { type: "slide" }
  | { type: "question"; gate: Gate }
  /** На трассу впереди добавлены участки, препятствия и монеты. */
  | { type: "course" }
  | { type: "answer"; correct: boolean; comboUp: boolean; multiplier: number; streak: number; milestone: boolean; lane: number }
  | { type: "obstacle"; kind: ObstacleKind; hit: boolean; severity: Severity | null }
  | { type: "night-obstacle"; kind: NightObstacleKind; hit: boolean; lane: number; severity: Severity | null }
  /** Сервисный челнок тронулся навстречу. */
  | { type: "shuttle"; lane: number }
  /** Дрезина тронулась навстречу. */
  | { type: "handcar"; lane: number }
  /** Байк пролетел ускорительное кольцо. */
  | { type: "boost"; lane: number }
  | { type: "coin"; chain: number; lane: number; height: number }
  | { type: "phase"; phase: Phase }
  | { type: "countdown"; value: number };

/** По чему бежит бегун: шпалы или крыша вагонетки — от этого звук шагов. */
export type Surface = "ground" | "deck";

interface Section {
  gate: Gate;
  seconds: number;
  /** Дистанция, на которой вопрос появится. */
  start: number;
  /** Дистанция ворот. */
  distance: number;
}

export interface RuntimeOptions {
  settings: SessionSettings;
  items: QuizItem[];
  /** Генерация ещё идёт: если карточки кончились раньше лимита — ждать догрузки. */
  live: boolean;
  previousBest: number | null;
  /** Зерно случайностей трассы — для тестов. */
  seed?: number;
  onComplete: (result: RunResult, answers: RunAnswerIn[], startedAt: Date, finishedAt: Date) => void;
}

/**
 * Один забег. Всё покадровое (дистанция, позиция бегуна, ворота) живёт здесь
 * в обычных полях — сцена читает их в useFrame без перерисовки React. В HUD
 * (zustand) уходят только события: новый вопрос, ответ, смена фазы.
 */
export class GameRuntime {
  readonly settings: SessionSettings;
  readonly lanes: number;
  private readonly playlist: Playlist;
  private readonly options: RuntimeOptions;
  private readonly rng: Rng;
  private listeners = new Set<(event: RuntimeEvent) => void>();

  phase: Phase = "loading";
  private pausedFrom: Phase | null = null;
  clock = 0;
  /** Секунды с начала текущей фазы — по ним анимируются камера и бегун. */
  phaseClock = 0;
  /** Ускорение только вступления и отсчёта; сохраняется между этими фазами. */
  private startSpeed = 1;

  distance = 0;
  speed = 0;
  baseSpeed = RUN_SPEED;
  readonly speedControl = new SpeedControl();
  targetLane: number;
  runnerX: number;
  /** Скорость смещения по X — для наклона бегуна. */
  runnerVX = 0;
  jumpClock = -10;
  private jumpSeconds = JUMP_SECONDS;
  /** Прыжок в гравикроссах: визуал крутит сальто и оставляет след. */
  superJump = false;
  /** Начало взлёта и посадки джетпака — для позы, факелов и камеры. */
  flightAt = -10;
  private flightFrom = 0;
  landingAt = -10;
  private landingFrom = 0;
  slideClock = -10;
  landClock = -10;
  /** Высота ступней над шпалами и вертикальная скорость: прыжок — честная баллистика. */
  feet = 0;
  vy = 0;
  /** В воздухе: прыжок или падение с крыши вагонетки. */
  airborne = false;
  /** Вагонетки, на крышах которых бегун сейчас (или над которыми летит). */
  deck: ObstacleRow | null = null;
  /** Трамплин или пандус под бегуном: подъём (у трамплина — бросок с края). */
  private ramp: ObstacleRow | null = null;
  /** Удар о передний край вагонетки: бегун карабкается наверх. */
  climbClock = -10;
  /** Фаза бега в циклах: ноги и шаги считаются от неё, а не от времени. */
  stride = 0;
  private groundedClock = 0;
  private jumped = false;
  private impact = 0;
  /** Неверный ответ. */
  hitClock = -10;
  /** Удар о препятствие. */
  bumpClock = -10;
  /** Сила последнего столкновения: от неё тряска камеры. */
  bumpSeverity: Severity = "hit";
  /** Замедление после столкновения и догон потерянных метров. */
  readonly slowdown = new Slowdown();
  /**
   * С какой дистанции бегун на каждом треке в текущем вопросе. Короткая отлучка
   * (объезд) не начинает отсчёт заново, а только сдвигает его на время в стороне.
   */
  private stays = new Map<number, { since: number; leftAt: number | null }>();
  successClock = -10;

  gate: ActiveGate | null = null;
  /**
   * Вопросы, взятые наперёд: их участки, ворота и препятствия уже на трассе. Очередь
   * пополняется, пока трасса не уходит за COURSE_HORIZON, но не больше MAX_AHEAD.
   */
  private ahead: Section[] = [];
  /** Где начнётся следующий участок, который возьмём наперёд. */
  private nextStart = 0;
  /** Сколько вопросов показано на табло (номер текущего). */
  private presented = 0;
  /** Пройденные ворота доезжают до камеры и исчезают. */
  passed: ActiveGate[] = [];
  obstacles: ObstacleRow[] = [];
  nightObstacles: NightObstacle[] = [];
  coins: Coin[] = [];
  readonly modifiers = new ModifierState();
  readonly modifierPlanner: ModifierPlanner;
  pickups: ModifierPickup[] = [];
  private nextPickupId = 1;
  private nextQuestionAt = Number.POSITIVE_INFINITY;
  private nextQuestionClock = Number.POSITIVE_INFINITY;
  finishDistance: number | null = null;
  private liveEnded: boolean;
  private waiting = false;

  private score: ScoreState;
  private rules: ScoreRules;
  private answers: RunAnswerIn[] = [];
  private mistakes: Mistake[] = [];
  private startedAt = new Date();
  private completed = false;

  private nextId = 1;
  private rowsPlaced = 0;
  private rowsPassed = 0;
  private bumps = 0;
  /** Столкновения по силе и серия препятствий подряд без касаний — для итогов. */
  private impacts: Record<Severity, number> = { graze: 0, hit: 0, crash: 0 };
  private cleanRun = 0;
  private bestClean = 0;
  /** Такты подряд без касаний: за REWARD_BEATS — катапульта или кольцо в ближайшем участке. */
  private cleanBeats = 0;
  private lastCleanBeat = -1;
  private dirtyBeat = -1;
  private rewardPending = false;
  private lastRewardGate = Number.NEGATIVE_INFINITY;
  /** Сколько наград поставлено — для тестов. */
  rewards = 0;
  private coinCount = 0;
  private coinChain = 0;
  private lastCoinClock = -10;
  private hinted = new Set<ObstacleKind>();
  private hint: MoveHint | null = null;
  private nightHinted = new Set<NightObstacleKind>();
  private nightDangerNear = false;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.settings = { ...options.settings, modifiers: options.settings.modifiers ?? true, world: options.settings.world ?? "classic" };
    this.lanes = options.settings.lanes;
    this.playlist = new Playlist(options.settings, createRng(options.seed === undefined ? undefined : options.seed + 1), options.items);
    this.rng = createRng(options.seed);
    this.modifierPlanner = new ModifierPlanner(this.settings.world, createRng(options.seed === undefined ? undefined : options.seed + 0x5f3759df));
    this.targetLane = Math.floor((this.lanes - 1) / 2);
    this.runnerX = laneX(this.targetLane, this.lanes);
    this.score = initialScore(options.settings.lives);
    this.rules = scoreRules(this.settings);
    this.liveEnded = !options.live;
    useHud.setState({
      ...initialHud(this.lanes),
      lives: this.score.lives,
      maxLives: this.score.lives,
      plannedTotal: this.playlist.plannedTotal(),
      layout: useHud.getState().layout,
      obstacles: options.settings.obstacles,
    });
  }

  on(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private setPhase(phase: Phase) {
    if (phase !== "running") this.speedControl.clear();
    this.phase = phase;
    this.phaseClock = 0;
    if (phase === "finished" || phase === "gameover") this.setNightDangerNear(false);
    if (phase === "finished" || phase === "gameover") this.clearModifiers();
    useHud.setState({ phase });
    this.emit({ type: "phase", phase });
  }

  start() {
    this.startedAt = new Date();
    this.nextStart = this.distance + RUN_SPEED * FIRST_QUESTION_AFTER;
    // Трасса готова до облёта камеры: первые ряды стоят с самого начала, а не вырастают на старте.
    this.extendCourse();
    this.setPhase("intro");
  }

  // --- Ввод ---

  accelerateStart(): boolean {
    if (this.phase !== "intro" && this.phase !== "countdown") return false;
    this.startSpeed = Math.min(12, this.startSpeed + 3);
    useHud.setState({ startSpeed: this.startSpeed });
    return true;
  }

  get night(): boolean { return this.settings.world === "night-maglev"; }
  get maxSpeed(): number { return this.baseSpeed * MAX_SPEED_FACTOR; }
  /** Свободный путь перед ночными воротами, м: в нём нет опасностей, и маглевы не отвлекают. */
  get answerZone(): number { return nightClearDistance(this.baseSpeed, this.gate?.seconds ?? 10); }
  get speedFactor(): number { return this.speedControl.factor; }
  setSpeedInput(accelerating: boolean, braking: boolean) {
    if (!this.night || this.phase !== "running") { this.speedControl.clear(); return; }
    this.speedControl.accelerating = accelerating;
    this.speedControl.braking = braking;
  }
  gateProgress(): number {
    if (!this.gate) return 0;
    return Math.max(0, Math.min(1, (this.distance - this.gate.appearedAt) / (this.gate.distance - this.gate.appearedAt)));
  }

  private canSteer(): boolean {
    return this.phase === "running" || this.phase === "finishing";
  }

  setLane(lane: number) {
    if (!this.canSteer()) return;
    const next = Math.max(0, Math.min(this.lanes - 1, lane));
    if (next === this.targetLane) return;
    const direction = next > this.targetLane ? 1 : -1;
    const previous = this.targetLane;
    this.targetLane = next;
    if (this.gate && this.gate.chosenLane === null) {
      // Бонус за раннее решение считается по времени на итоговом треке: короткий объезд
      // и возврат стоят только тех метров, что бегун был в стороне.
      const left = this.stays.get(previous);
      if (left) left.leftAt = this.distance;
      const stay = this.stays.get(next);
      if (stay && stay.leftAt !== null && this.distance - stay.leftAt < this.baseSpeed * EXCURSION_SECONDS) {
        stay.since = Math.min(this.distance, stay.since + (this.distance - stay.leftAt));
        stay.leftAt = null;
      } else this.stays.set(next, { since: this.distance, leftAt: null });
      this.gate.lastChangeAt = this.stays.get(next)!.since;
      this.gate.lastChangeClock = this.clock;
    }
    useHud.setState({ targetLane: next });
    this.emit({ type: "lane", lane: next, direction });
  }

  moveLane(direction: -1 | 1) {
    this.setLane(this.targetLane + direction);
  }

  jump() {
    if (!this.canSteer()) return;
    if (this.flying) return;
    const grounded = !this.airborne || (!this.jumped && this.clock - this.groundedClock < COYOTE_SECONDS);
    if (!grounded) return;
    this.slideClock = -10;
    this.superJump = this.modifiers.has("gravity-shoes");
    this.vy = this.superJump ? Math.sqrt(2 * GRAVITY * FLIGHT_HEIGHT) : JUMP_VELOCITY;
    this.jumpSeconds = 2 * this.vy / GRAVITY;
    this.jumpClock = this.clock;
    this.jumped = true;
    this.setAirborne(true);
    this.emit({ type: "jump" });
  }

  /** Подкат; в воздухе — сначала нырок вниз. */
  slide() {
    if (!this.canSteer()) return;
    if (this.flying) return;
    if (this.airborne) this.vy = Math.min(this.vy, -DIVE_VELOCITY);
    const fresh = this.slideProgress() < 0;
    this.slideClock = this.clock;
    if (fresh) this.emit({ type: "slide" });
  }

  private setAirborne(value: boolean) {
    if (this.airborne === value) return;
    this.airborne = value;
    useHud.setState({ airborne: value });
  }

  togglePause() {
    if (this.phase === "paused") this.resume();
    else this.pause();
  }

  pause() {
    this.speedControl.clear();
    if (!["intro", "countdown", "running", "finishing"].includes(this.phase)) return;
    this.pausedFrom = this.phase;
    this.phase = "paused";
    useHud.setState({ phase: "paused" });
    this.emit({ type: "phase", phase: "paused" });
  }

  resume() {
    if (this.phase !== "paused" || !this.pausedFrom) return;
    this.phase = this.pausedFrom;
    this.pausedFrom = null;
    useHud.setState({ phase: this.phase });
    this.emit({ type: "phase", phase: this.phase });
  }

  /** Прервать забег досрочно и показать результаты по уже пройденным воротам. */
  quit() {
    this.speedControl.clear();
    this.complete(false);
  }

  // --- Догрузка карточек ---

  appendItems(items: QuizItem[]) {
    if (!this.playlist.append(items)) return;
    useHud.setState({ plannedTotal: this.playlist.plannedTotal() });
    if (this.waiting) this.nextQuestionAt = this.distance + RUN_SPEED * 0.4;
    if (this.waiting && this.night) this.nextQuestionClock = this.clock + 0.4;
  }

  endLive() {
    this.liveEnded = true;
  }

  // --- Положение тела ---

  /** Доля прыжка 0…1 или −1, если бегун не в прыжке (падение с крыши — не прыжок). */
  jumpProgress(): number {
    if (!this.airborne || !this.jumped) return -1;
    return Math.min(1, (this.clock - this.jumpClock) / this.jumpSeconds);
  }

  /** Доля подката 0…1 или −1. */
  slideProgress(): number {
    const t = (this.clock - this.slideClock) / SLIDE_SECONDS;
    return t >= 0 && t <= 1 ? t : -1;
  }

  /** Насколько бегун лёг в подкате, 0…1 — общая кривая для логики и обеих моделей. */
  slideDepth(): number {
    return slideDepth(this.slideProgress());
  }

  /** Скорость касания при последнем приземлении, м/с: от неё сила «сплющивания». */
  landImpact(): number {
    return this.impact;
  }

  /** Высота ступней над шпалами. */
  feetHeight(): number {
    return this.feet;
  }

  /** Управляемый полёт и мягкая посадка. Прыжок и подкат в этом состоянии не меняют высоту. */
  get flying(): boolean { return this.modifiers.has("jetpack") || this.clock - this.landingAt < 0.85; }

  /** Высота опоры под бегуном: крыша вагонеток, подъём трамплина или шпалы. */
  support(): number {
    if (this.ramp) return this.ramp.kind === "slope" ? slopeHeight(this.distance - this.ramp.distance) : rampHeight(this.distance - this.ramp.distance);
    const deck = this.deck;
    if (!deck || this.distance < deck.distance || this.distance > deck.distance + deck.length) return 0;
    return DECK_HEIGHT;
  }

  // --- Кадр ---

  update(rawDelta: number) {
    // Подшаги сохраняют скорость таймера и проверку столкновений на редких кадрах.
    // Длинное зависание вкладки не перематывает весь забег одним кадром.
    let remaining = Math.max(0, Math.min(rawDelta, 0.25));
    while (remaining > 1e-8) { const step = Math.min(remaining, 1 / 60); this.tick(step); remaining -= step; }
  }

  private tick(dt: number) {
    if (this.phase === "paused" || this.phase === "loading") return;
    if (this.phase === "intro" || this.phase === "countdown") dt *= this.startSpeed;
    this.clock += dt;
    this.phaseClock += dt;

    switch (this.phase) {
      case "intro":
        if (this.phaseClock >= INTRO_SECONDS) {
          this.setPhase("countdown");
          useHud.setState({ countdown: 3 });
          this.emit({ type: "countdown", value: 3 });
        }
        break;
      case "countdown": {
        const value = 3 - Math.floor(this.phaseClock / COUNT_STEP);
        if (value <= 0) {
          useHud.setState({ countdown: 0 });
          this.emit({ type: "countdown", value: 0 });
          this.setPhase("running");
          this.nextQuestionAt = this.distance + RUN_SPEED * FIRST_QUESTION_AFTER;
          this.nextQuestionClock = this.clock + FIRST_QUESTION_AFTER;
        } else if (value !== useHud.getState().countdown) {
          useHud.setState({ countdown: value });
          this.emit({ type: "countdown", value });
        }
        break;
      }
      case "running":
      case "finishing": {
        const previousDistance = this.distance;
        const previousX = this.runnerX;
        const previousFeet = this.feet;
        const previousDepth = this.slideDepth();
        for (const effect of this.modifiers.expire(this.clock)) this.endModifier(effect.kind);
        // После столкновения скорость ниже расписания; в городе бегун затем догоняет потерянные метры.
        const slow = this.slowdown.step(this.clock, dt, this.night ? 0 : RUN_SPEED);
        const target = (this.night && this.phase === "running" ? this.baseSpeed * this.speedControl.update(dt) : RUN_SPEED) * slow;
        this.advance(dt, target, this.night && this.phase === "running" && this.speed >= this.baseSpeed
          ? this.baseSpeed * (this.speedControl.braking ? BRAKING : ACCELERATION) : RUN_SPEED / 0.9);
        this.runPickups(previousDistance, previousX);
        if (this.night) this.runNightObstacles(dt, previousDistance, previousX, previousFeet, previousDepth);
        else this.runObstacles(dt);
        if (this.phase === "running") {
          this.extendCourse();
          this.runGates();
        }
        else if (this.finishDistance !== null && this.distance >= this.finishDistance) {
          this.setPhase("finished");
          if (this.night) this.complete(true);
        }
        if (this.phaseClock > 0.8 && useHud.getState().countdown === 0) useHud.setState({ countdown: null });
        if (!this.chase() && useHud.getState().chase) useHud.setState({ chase: null });
        break;
      }
      case "finished":
        this.advance(dt, 0, RUN_SPEED / 1.1);
        if (this.phaseClock >= RESULTS_DELAY.finished) this.complete(true);
        break;
      case "gameover":
        this.advance(dt, 0, RUN_SPEED / 0.5);
        if (this.phaseClock >= RESULTS_DELAY.gameover) this.complete(false);
        break;
    }
  }

  private advance(dt: number, targetSpeed: number, acceleration: number) {
    const step = acceleration * dt;
    if (this.night) {
      const next = advanceSpeed(this.speed, targetSpeed, acceleration, dt);
      this.speed = next.speed;
      this.distance += next.distance;
    } else {
      this.speed = this.speed < targetSpeed ? Math.min(targetSpeed, this.speed + step) : Math.max(targetSpeed, this.speed - step);
      this.distance += this.speed * dt;
    }
    const targetX = laneX(this.targetLane, this.lanes);
    const previousX = this.runnerX;
    this.runnerX += (targetX - this.runnerX) * (1 - Math.exp(-dt * LANE_DAMPING));
    this.runnerVX = (this.runnerX - previousX) / Math.max(dt, 1e-4) / LANE_WIDTH;
    this.passed = this.passed.filter((gate) => this.distance - gate.distance < 14);
    this.fall(dt);
    this.footsteps(dt);
  }

  /** Вертикаль: гравитация до опоры; сход с крыши — падение, касание опоры — приземление. */
  private fall(dt: number) {
    // С крыши или подъёма можно уйти на соседний трек — тогда опоры под ногами больше нет.
    const lane = this.currentLane();
    if (this.deck && (this.distance > this.deck.distance + this.deck.length || this.deck.lane !== lane)) this.deck = null;
    if (this.ramp && this.ramp.lane !== lane) this.ramp = null;
    if (this.ramp?.kind === "slope" && this.distance > this.ramp.distance + SLOPE_LENGTH) this.ramp = null;
    if (this.ramp && this.distance > this.ramp.distance + RAMP_LENGTH) this.launch();
    if (this.flying) {
      // Крыша под траекторией — опора для посадки, даже если влетели в состав сбоку.
      const deck = this.obstacles.find(row => row.kind === "wagons" && row.lane === lane && this.distance >= row.distance && this.distance <= row.distance + row.length);
      this.deck = deck ?? null;
      this.ramp = null;
      this.vy = 0;
      const smooth = (t: number) => t * t * (3 - 2 * t);
      if (this.modifiers.has("jetpack")) {
        const t = Math.min(1, (this.clock - this.flightAt) / 0.65);
        this.feet = this.flightFrom + (FLIGHT_HEIGHT - this.flightFrom) * smooth(t);
      } else {
        const t = Math.min(1, (this.clock - this.landingAt) / 0.85);
        this.feet = this.landingFrom + (this.support() - this.landingFrom) * smooth(t);
      }
      this.setAirborne(true);
      return;
    }
    const ground = this.support();
    if (!this.airborne && this.feet <= ground + 1e-3) {
      this.feet = ground;
      this.groundedClock = this.clock;
      return;
    }
    if (!this.airborne) this.setAirborne(true);
    this.vy -= GRAVITY * dt;
    this.feet += this.vy * dt;
    if (this.feet > ground) return;
    const impact = -this.vy;
    this.impact = impact;
    this.feet = ground;
    this.vy = 0;
    this.jumped = false;
    this.groundedClock = this.clock;
    this.setAirborne(false);
    this.landClock = this.clock;
    this.emit({ type: "land", impact, surface: ground > 0 ? "deck" : "ground" });
  }

  /** Край трамплина: бегун, бежавший по подъёму, взлетает высоко над путями. */
  private launch() {
    this.ramp = null;
    if (this.airborne && this.feet > RAMP_TOP + 0.05) return;
    this.feet = RAMP_TOP;
    this.vy = LAUNCH_VELOCITY;
    this.superJump = false;
    this.jumpSeconds = 2 * LAUNCH_VELOCITY / GRAVITY;
    this.jumpClock = this.clock;
    this.jumped = true;
    this.slideClock = -10;
    this.setAirborne(true);
    this.emit({ type: "jump" });
  }

  private footsteps(dt: number) {
    const before = this.stride;
    this.stride += (this.speed * dt) / STRIDE_LENGTH;
    if (this.night) return;
    if (this.airborne || this.slideProgress() >= 0 || this.speed < 2) return;
    for (const at of FOOTFALLS) {
      if (Math.floor(before - at) !== Math.floor(this.stride - at)) {
        this.emit({ type: "step", surface: this.support() > 0 ? "deck" : "ground" });
      }
    }
  }

  private runGates() {
    // Каждый вопрос появляется в начале своего участка, даже при разгоне в паузе.
    // В ожидании генерации нет участка — повторную проверку назначаем по времени.
    const byClock = this.night && !this.ahead.length;
    const at = this.ahead[0] && !this.waiting ? this.ahead[0].start : this.nextQuestionAt;
    if (!this.gate && (byClock ? this.clock >= this.nextQuestionClock : this.distance >= at)) this.presentNext();
    const gate = this.gate;
    if (gate && gate.chosenLane === null && this.distance >= gate.distance) this.judge(gate);
  }

  private presentNext() {
    this.extendCourse();
    const section = this.ahead.shift();
    if (!section) {
      if (this.playlist.starving() && !this.liveEnded) {
        // Генерация ещё идёт: бежим дальше и ждём новых карточек.
        if (!this.waiting) useHud.setState({ waiting: true, gate: null, gateSeconds: 0 });
        this.waiting = true;
        this.nextQuestionAt = this.distance + RUN_SPEED * 0.5;
        this.nextQuestionClock = this.clock + 0.5;
        return;
      }
      this.beginFinish();
      return;
    }
    this.waiting = false;
    this.stays = new Map([[this.targetLane, { since: this.distance, leftAt: null }]]);
    this.presented += 1;
    const { gate, seconds, distance } = section;
    this.gate = {
      gate,
      seconds,
      distance,
      appearedAt: this.distance,
      appearedClock: this.clock,
      appearedLane: this.targetLane,
      lastChangeAt: this.distance,
      lastChangeClock: this.clock,
      chosenLane: null,
      correct: null,
      judgedClock: 0,
    };
    // Время участка задано для базовой скорости; газ ускоряет прохождение.
    this.baseSpeed = (distance - section.start) / seconds;
    useHud.setState({
      gate,
      gateSeconds: seconds,
      gateIndex: this.presented,
      plannedTotal: this.playlist.plannedTotal(),
      waiting: false,
    });
    this.emit({ type: "question", gate });
    this.extendCourse();
  }

  /**
   * Берёт вопросы из очереди наперёд и ставит их участки на трассу, пока она не уйдёт
   * за COURSE_HORIZON: препятствия проступают из тумана у горизонта, а не возникают
   * перед бегуном. Ворота каждого следующего — через паузу после предыдущих.
   */
  private extendCourse() {
    let added = false;
    while (this.ahead.length < MAX_AHEAD) {
      const last = this.ahead.at(-1)?.distance ?? this.gate?.distance;
      if (last !== undefined && last > this.distance + COURSE_HORIZON) break;
      const gate = this.playlist.next();
      if (!gate) break;
      const seconds = answerSeconds(gate.item.prompt, gate.options.map((o) => o.text), this.settings.pace, this.settings.customSeconds);
      // Карточки догрузились, пока бегун ждал: участок начинается от него, без препятствий у самого носа.
      const late = this.nextStart < this.distance + RUN_SPEED * 0.4;
      const start = late ? this.distance + RUN_SPEED * 0.4 : this.nextStart;
      const distance = start + RUN_SPEED * seconds;
      this.ahead.push({ gate, seconds, start, distance });
      this.nextStart = distance + RUN_SPEED * GAP_SECONDS;
      if (this.settings.obstacles && !late) this.placeObstacles(start, distance, this.presented + this.ahead.length);
      if (this.settings.modifiers) {
        const hazards = this.night ? this.nightObstacles.map(row => ({ lane: row.lane, from: row.distance - (row.kind === "shuttle" ? SHUTTLE_TRIGGER : 0), to: row.distance + row.length }))
          : this.obstacles.map(row => ({ lane: row.lane, from: row.distance - (row.kind === "handcar" ? HANDCAR_TRIGGER : 0), to: row.distance + row.length }));
        const pickup = this.modifierPlanner.section({ mainTotal: this.playlist.mainTotal(), retry: gate.retry, start: late ? Math.max(start, this.distance + COURSE_HORIZON) : start, end: distance, lanes: this.lanes, maxSpeed: RUN_SPEED * (this.night ? MAX_SPEED_FACTOR : 1), hazards });
        if (pickup) this.pickups.push({ ...pickup, id: this.nextPickupId++ });
      }
      added = true;
    }
    if (added) {
      useHud.setState({ plannedTotal: this.playlist.plannedTotal() });
      this.emit({ type: "course" });
    }
  }

  // --- Препятствия и монеты ---

  private runPickups(previousDistance: number, previousX: number) {
    for (const pickup of this.pickups) {
      if (pickup.resolved || pickup.distance > this.distance) continue;
      pickup.resolved = true;
      const share = crossingShare(previousDistance, this.distance, pickup.distance);
      const x = previousX + (this.runnerX - previousX) * share;
      if (Math.abs(x - laneX(pickup.lane, this.lanes)) > 0.85) continue;
      pickup.taken = true;
      pickup.takenClock = this.clock;
      this.activateModifier(pickup.kind);
    }
    this.pickups = this.pickups.filter(pickup => this.distance - pickup.distance < 18);
  }

  /** Общая точка активации: подбор, визуальный стенд и проверки механик. */
  activateModifier(kind: ModifierKind) {
    if (!this.settings.modifiers || !this.canSteer() || this.night !== ["magnet", "phase", "shield"].includes(kind)) return;
    for (const effect of this.modifiers.activate(kind, this.clock)) {
      if (effect.kind !== kind) this.endModifier(effect.kind);
    }
    if (kind === "jetpack") {
      this.flightAt = this.clock;
      this.flightFrom = this.feet;
      this.vy = 0;
      this.slideClock = -10;
      this.jumped = false;
      this.setAirborne(true);
    }
    this.emit({ type: "modifier", kind, action: "pickup" });
  }

  private endModifier(kind: ModifierKind) {
    if (kind === "jetpack") { this.landingAt = this.clock; this.landingFrom = this.feet; }
    this.emit({ type: "modifier", kind, action: "end" });
  }

  private clearModifiers() {
    const effects = [...this.modifiers.active];
    this.modifiers.clear();
    for (const effect of effects) this.emit({ type: "modifier", kind: effect.kind, action: "end" });
  }

  private placeObstacles(start: number, end: number, gateIndex: number) {
    if (this.night) {
      const { rows: planned, beats, rewarded } = planNightObstacles(this.rng, { start, end, baseSpeed: RUN_SPEED, lanes: this.lanes, gateIndex, placed: this.rowsPlaced, more: Boolean(this.settings.moreObstacles), reward: this.rewardDue(gateIndex) });
      for (const row of planned) {
        this.nightObstacles.push({ ...row, beat: this.rowsPlaced + row.beat, id: this.nextId++, hit: false, resolved: false, resolvedClock: 0 });
        // Энергия над роботом награждает прыжок, без маршрута к ответным воротам.
        if (row.kind === "repair-bot") for (const offset of [0.5, 1.1]) this.coins.push({ id: this.nextId++, distance: row.distance + offset, lane: row.lane, height: 2.5, resolved: false, taken: false, takenClock: 0 });
        // В кольце и за ним — дорожка энергии на высоте байка.
        if (row.kind === "boost-ring") for (let offset = 0.4; offset < 12; offset += 2.2) this.coins.push({ id: this.nextId++, distance: row.distance + offset, lane: row.lane, height: 1.25, resolved: false, taken: false, takenClock: 0 });
      }
      this.rowsPlaced += beats;
      if (rewarded) this.rewardPlaced(gateIndex);
      return;
    }
    const { rows, beats, rewarded } = planObstacles(this.rng, {
      start,
      end,
      speed: RUN_SPEED,
      lanes: this.lanes,
      more: Boolean(this.settings.moreObstacles),
      gateIndex,
      placed: this.rowsPlaced,
      reward: this.rewardDue(gateIndex),
    });
    for (const row of rows) {
      this.obstacles.push({ ...row, beat: this.rowsPlaced + row.beat, id: this.nextId++, resolved: false, met: false, hit: false, resolvedClock: 0 });
      const spots: CoinSpot[] = row.kind === "hurdle" ? HURDLE_COINS : row.kind === "bar" ? BAR_COINS
        : row.kind === "wagons" ? wagonCoins(row.length) : row.kind === "ramp" ? rampCoins(RUN_SPEED) : [];
      for (const spot of spots) {
        this.coins.push({ id: this.nextId++, distance: row.distance + spot.offset, lane: row.lane, height: spot.height, resolved: false, taken: false, takenClock: 0 });
      }
    }
    this.rowsPlaced += beats;
    if (rewarded) this.rewardPlaced(gateIndex);
  }

  /** Награда заслужена и давно не ставилась. */
  private rewardDue(gateIndex: number): boolean {
    return this.rewardPending && gateIndex - this.lastRewardGate >= REWARD_EVERY;
  }

  private rewardPlaced(gateIndex: number) {
    this.rewardPending = false;
    this.cleanBeats = 0;
    this.lastRewardGate = gateIndex;
    this.rewards += 1;
  }

  private runObstacles(dt: number) {
    if (!this.obstacles.length && !this.coins.length) return;
    const sliding = this.slideProgress() >= 0;
    let hint: MoveHint | null = null;

    const lane = this.currentLane();
    for (const row of this.obstacles) {
      // Дрезина стоит, пока бегун не подбежит, затем катит навстречу — и после встречи тоже.
      if (row.kind === "handcar" && row.distance - this.distance < HANDCAR_TRIGGER) {
        if (row.distance - this.distance + this.speed * dt >= HANDCAR_TRIGGER) this.emit({ type: "handcar", lane: row.lane });
        row.distance -= HANDCAR_SPEED * dt;
      }
      if (row.resolved) continue;
      if (this.distance < row.distance) {
        const closing = row.kind === "handcar" ? RUN_SPEED + HANDCAR_SPEED : RUN_SPEED;
        if (row.lane === lane && !this.hinted.has(row.kind) && row.distance - this.distance < closing * HINT_LEAD) {
          hint = row.kind === "hurdle" || row.kind === "handcar" ? "jump" : row.kind === "bar" ? "slide" : row.kind === "wagons" ? "board" : hint;
        }
        continue;
      }
      if (row.kind === "ramp" || row.kind === "slope") {
        // Подъём не проверяет реакцию: на него взбегают сами, с края трамплина — бросок.
        row.resolved = true;
        row.resolvedClock = this.clock;
        if (row.lane === lane && !this.airborne) this.ramp = row;
        continue;
      }
      if (row.kind === "wagons") {
        this.boardWagons(row, lane);
        continue;
      }
      row.resolved = true;
      row.resolvedClock = this.clock;
      if (row.lane !== lane) continue;
      this.meet(row, this.flying ? null : cityImpact(row.kind, this.feet, this.slideDepth(), row.variant));
    }

    for (const coin of this.coins) {
      if (coin.resolved || this.distance < coin.distance) continue;
      coin.resolved = true;
      if (coin.lane !== lane || !touchesCoin(coin.height, this.feet, sliding)) continue;
      coin.taken = true;
      coin.takenClock = this.clock;
      this.coinChain = this.clock - this.lastCoinClock < COIN_CHAIN_SECONDS ? this.coinChain + 1 : 0;
      this.lastCoinClock = this.clock;
      this.coinCount += 1;
      this.score = addPoints(this.score, COIN_POINTS).state;
      useHud.setState({ score: this.score.score, coins: this.coinCount });
      this.emit({ type: "coin", chain: this.coinChain, lane: coin.lane, height: coin.height });
    }

    if (hint !== this.hint) {
      this.hint = hint;
      useHud.setState({ hint });
    }
    this.obstacles = this.obstacles.filter((row) => row === this.deck || row === this.ramp || this.distance - (row.distance + row.length) < 16);
    this.coins = this.coins.filter((coin) => this.distance - coin.distance < 16);
  }

  /**
   * Вагонетки на треке `row.lane`. Спереди на них заскакивают; не допрыгнул — удар
   * о торец, и бегун карабкается наверх. Сбоку (перестроение рядом с составом)
   * на крышу переходят на высоте, а с земли — задевают борт и тоже карабкаются:
   * выбор трека с ответом препятствие не отменяет.
   */
  private boardWagons(row: ObstacleRow, lane: number) {
    if (this.distance > row.distance + row.length) {
      row.resolved = true;
      return;
    }
    if (row.lane !== lane || this.deck === row) return;
    // Спереди — по высоте прыжка; сбоку с земли — задел о борт.
    const front = this.distance - row.distance <= RUN_SPEED / 30;
    const impact = this.flying ? null : cityImpact("wagons", this.feet, 0);
    const severity = impact && !front ? "graze" : impact;
    const hit = severity !== null;
    this.deck = row;
    this.ramp = null;
    if (hit) {
      this.climbClock = this.clock;
      this.slideClock = -10;
    }
    if (this.feet < DECK_HEIGHT) {
      this.feet = DECK_HEIGHT;
      this.vy = hit ? 2.5 : Math.max(this.vy, 0);
      this.jumped = false;
      if (this.vy > 0) this.setAirborne(true);
      else {
        this.setAirborne(false);
        this.landClock = this.clock;
        this.impact = 3;
        this.emit({ type: "land", impact: 3, surface: "deck" });
      }
    }
    if (row.met && !hit) return;
    this.meet(row, severity);
  }

  /** Бегун встретил препятствие на своём треке: взял или ударился. */
  private meet(row: ObstacleRow, impact: Severity | null) {
    const hit = impact !== null;
    const first = !row.met;
    const fresh = !row.hit;
    if (first) {
      row.met = true;
      row.resolvedClock = this.clock;
      this.rowsPassed += 1;
      this.hinted.add(row.kind);
    }
    if (hit) {
      // В итогах — препятствия, а не удары: второй удар о тот же состав не считается.
      if (!row.hit) this.bumps += 1;
      row.hit = true;
      row.resolvedClock = this.clock;
    }
    const severity = impact && this.collide(row.id, impact);
    if (!this.flying && (severity ? fresh : first)) this.countMet(severity, row.beat);
    this.emit({ type: "obstacle", kind: row.kind, hit, severity });
  }

  /** Итоги: чистое препятствие продлевает серию, столкновение обрывает её и учитывается по силе. */
  private countMet(severity: Severity | null, beat: number) {
    if (severity) {
      this.impacts[severity] += 1;
      this.cleanRun = 0;
      this.cleanBeats = 0;
      this.dirtyBeat = beat;
      return;
    }
    this.cleanRun += 1;
    this.bestClean = Math.max(this.bestClean, this.cleanRun);
    // Такт засчитывается чистым по первому взятому препятствию, если в нём ещё не было касаний.
    if (beat !== this.lastCleanBeat && beat !== this.dirtyBeat) {
      this.lastCleanBeat = beat;
      this.cleanBeats += 1;
      if (this.cleanBeats >= REWARD_BEATS[this.settings.moreObstacles ? "more" : "normal"]) this.rewardPending = true;
    }
  }

  /** «На хвосте»: доля оставшегося времени 0…1, 0 — погони нет. */
  chase(): number {
    const left = 1 - (this.clock - this.bumpClock) / CHASE_SECONDS;
    return left > 0 && left <= 1 ? left : 0;
  }

  /**
   * Столкновение: штраф и замедление по силе. «На хвосте» — следующее столкновение
   * в течение CHASE_SECONDS на ступень сильнее. Крушение ночью сбрасывает разгон.
   */
  private collide(key: number, impact: Severity): Severity {
    const severity = this.clock - this.bumpClock < CHASE_SECONDS ? escalate(impact) : impact;
    const effect = IMPACTS[severity];
    this.bumpClock = this.clock;
    this.bumpSeverity = severity;
    this.slowdown.hit(this.clock, effect);
    this.speed *= 1 - effect.drop;
    if (severity === "crash" && this.night) this.speedControl.factor = 1;
    const outcome = addPoints(this.score, -effect.penalty);
    this.score = outcome.state;
    useHud.setState({ score: this.score.score, pop: outcome.delta ? { key, delta: outcome.delta } : null, chase: { key, severity } });
    return severity;
  }

  private runNightObstacles(dt: number, previousDistance: number, previousX: number, previousFeet: number, previousDepth: number) {
    let hint: MoveHint | null = null;
    for (const row of this.nightObstacles) {
      // Положение ряда в прошлом кадре: челнок сам едет навстречу, когда байк подъехал.
      const was = row.distance;
      if (row.kind === "shuttle" && row.distance - this.distance < SHUTTLE_TRIGGER) {
        if (was - previousDistance >= SHUTTLE_TRIGGER) this.emit({ type: "shuttle", lane: row.lane });
        row.distance -= SHUTTLE_SPEED * dt;
      }
      if (row.resolved) continue;
      if (row.kind === "boost-ring") {
        if (this.distance < row.distance) continue;
        row.resolved = true; row.resolvedClock = this.clock;
        // Кольцо разгоняет байк, если он пролетел сквозь него на своей дорожке.
        if (Math.abs(this.runnerX - laneX(row.lane, this.lanes)) < LANE_WIDTH / 2) {
          this.speedControl.factor = Math.min(MAX_SPEED_FACTOR, this.speedControl.factor + RING_BOOST);
          this.emit({ type: "boost", lane: row.lane });
        }
        continue;
      }
      if (this.modifiers.has("shield") && this.shieldThreat(row)) {
        this.neutralize(row);
        continue;
      }
      // Всё — относительно байка: так встречное движение не проскакивает между кадрами.
      const before = was - previousDistance;
      const now = row.distance - this.distance;
      if (now > 0) {
        const closing = row.kind === "shuttle" ? this.maxSpeed + SHUTTLE_SPEED : this.maxSpeed;
        if (!this.nightHinted.has(row.kind) && now < closing * HINT_LEAD) hint = row.kind === "repair-arm" ? "slide" : row.kind === "magnetic-zone" ? "dodge" : row.kind === "shuttle" || row.kind === "energy-wall" ? "swerve" : "jump";
        continue;
      }
      const share = Math.max(0, Math.min(1, before / Math.max(1e-6, before - now)));
      const x = previousX + (this.runnerX - previousX) * share;
      const feet = previousFeet + (this.feet - previousFeet) * share;
      const depth = previousDepth + (this.slideDepth() - previousDepth) * share;
      const overlaps = before >= -row.length;
      const hit = overlaps && (touchesNightObstacle(row.kind, row.lane, this.lanes, x, feet, depth)
        || (now >= -row.length && touchesNightObstacle(row.kind, row.lane, this.lanes, this.runnerX, this.feet, this.slideDepth())));
      if (!hit && now > -row.length) continue;
      // Редкий кадр мог пересечь угрозу в середине перестроения: последний
      // импульс проверяется по тому же пересечению, что и обычный удар.
      if (hit && this.modifiers.has("shield")) { this.neutralize(row); continue; }
      // Помечаем объект до штрафа и магнитного сноса. По окончании фазы внутри
      // длинного челнока этот же объект больше не может ударить второй раз.
      if (hit && this.modifiers.has("phase")) {
        row.resolved = true; row.protected = true; row.resolvedClock = this.clock;
        this.rowsPassed++;
        continue;
      }
      row.resolved = true; row.hit = hit; row.resolvedClock = this.clock;
      this.nightHinted.add(row.kind); this.rowsPassed++;
      let severity: Severity | null = null;
      if (hit) {
        this.bumps++;
        severity = this.collide(row.id, nightImpact(row.kind, row.lane, this.lanes, x, feet, depth));
        if (row.kind === "magnetic-zone") this.setLane(forcedLane(row.lane, row.direction, this.lanes));
      }
      this.countMet(severity, row.beat);
      this.emit({ type: "night-obstacle", kind: row.kind, hit, lane: row.lane, severity });
    }
    for (const coin of this.coins) {
      if (!coin.resolved && this.modifiers.has("magnet") && coin.distance >= this.distance && coin.distance - this.distance <= MAGNET_REACH) {
        coin.attracted = true;
        this.takeNightCoin(coin);
        continue;
      }
      if (coin.resolved || this.distance < coin.distance) continue;
      coin.resolved = true;
      const share = crossingShare(previousDistance, this.distance, coin.distance);
      const x = previousX + (this.runnerX - previousX) * share;
      const feet = previousFeet + (this.feet - previousFeet) * share;
      if (Math.abs(x - laneX(coin.lane, this.lanes)) > 0.9 || !touchesCoin(coin.height, feet, this.slideDepth() > 0.6)) continue;
      this.takeNightCoin(coin);
    }
    if (hint !== this.hint) { this.hint = hint; useHud.setState({ hint }); }
    this.nightObstacles = this.nightObstacles.filter(row => this.distance - row.distance - row.length < 16);
    this.coins = this.coins.filter(coin => this.distance - coin.distance < 16);
    this.setNightDangerNear(this.nightObstacles.some(row => !row.resolved && row.kind !== "boost-ring"
      && row.distance - this.distance <= NIGHT_DANGER_DISTANCE && row.distance + row.length >= this.distance));
  }

  private takeNightCoin(coin: Coin) {
    coin.resolved = true; coin.taken = true; coin.takenClock = this.clock; this.coinCount++;
    this.coinChain = this.clock - this.lastCoinClock < COIN_CHAIN_SECONDS ? this.coinChain + 1 : 0;
    this.lastCoinClock = this.clock;
    this.score = addPoints(this.score, COIN_POINTS).state;
    useHud.setState({ score: this.score.score, coins: this.coinCount });
    this.emit({ type: "coin", chain: this.coinChain, lane: coin.lane, height: coin.height });
  }

  private neutralize(row: NightObstacle) {
    row.neutralized = true; row.protected = true; row.resolved = true; row.resolvedClock = this.clock;
    this.rowsPassed++;
    this.nightHinted.add(row.kind);
    const charges = this.modifiers.pulse();
    this.emit({ type: "shield-pulse", id: row.id, lane: row.lane, charges });
  }

  /** Угроза по фактической траектории: учитываем перестроение, прыжок и снижение. */
  private shieldThreat(row: NightObstacle): boolean {
    const ahead = row.distance - this.distance;
    if (ahead > SHIELD_REACH || ahead + row.length < 0) return false;
    const closing = Math.max(1, this.speed) + (row.kind === "shuttle" ? SHUTTLE_SPEED : 0);
    const seconds = Math.max(0, ahead / closing);
    const targetX = laneX(this.targetLane, this.lanes);
    const x = targetX + (this.runnerX - targetX) * Math.exp(-LANE_DAMPING * seconds);
    const feet = this.airborne ? Math.max(0, this.feet + this.vy * seconds - GRAVITY * seconds * seconds / 2) : this.feet;
    const depth = slideDepth((this.clock + seconds - this.slideClock) / SLIDE_SECONDS);
    return touchesNightObstacle(row.kind, row.lane, this.lanes, x, feet, depth);
  }

  /** В HUD уходит только событие входа/выхода опасностей из ближней зоны, а не каждый кадр. */
  private setNightDangerNear(near: boolean) {
    if (near === this.nightDangerNear) return;
    this.nightDangerNear = near;
    useHud.setState({ nightDangerNear: near });
  }

  /** Трек, над которым бегун сейчас физически (во время перестроения — ближайший). */
  private currentLane(): number {
    const offset = this.runnerX / LANE_WIDTH + (this.lanes - 1) / 2;
    return Math.max(0, Math.min(this.lanes - 1, Math.round(offset)));
  }

  // --- Ответ ---

  private judge(active: ActiveGate) {
    const lane = this.targetLane;
    const option = active.gate.options[lane];
    const correct = option.kind === "correct";
    const span = active.distance - active.appearedAt;
    const decidedShare = lane === active.appearedLane ? STAY_SHARE : span > 0 ? (active.distance - active.lastChangeAt) / span : 1;
    const outcome = applyAnswer(this.score, correct, this.rules, decidedShare);
    this.score = outcome.state;
    active.chosenLane = lane;
    active.correct = correct;
    active.judgedClock = this.clock;

    const item = active.gate.item;
    this.answers.push({
      item_id: item.id,
      ordinal: this.answers.length + 1,
      chosen_text: option.text,
      chosen_kind: option.kind,
      correct,
      reaction_ms: Math.round((active.lastChangeClock - active.appearedClock) * 1000),
    });
    if (correct) {
      this.successClock = this.clock;
    } else {
      this.hitClock = this.clock;
      // Взятые наперёд вопросы очередь уже выдала — повтор отсчитываем от текущего.
      this.playlist.reportMistake(item, this.ahead.length);
      this.mistakes.push({
        itemId: item.id,
        prompt: item.prompt,
        correct: item.correct,
        chosen: option.text,
        chosenKind: option.kind,
        whyWrong: option.whyWrong,
        explanation: item.explanation,
        source: item.source,
      });
    }

    const hud = useHud.getState();
    useHud.setState({
      score: this.score.score,
      streak: this.score.streak,
      multiplier: outcome.multiplier,
      lives: this.score.lives,
      timeline: [...hud.timeline, correct],
      plannedTotal: this.playlist.plannedTotal(),
      pop: outcome.delta ? { key: this.nextId++, delta: outcome.delta, multiplier: correct ? outcome.multiplier : undefined } : null,
      lastResult: {
        key: active.gate.key,
        correct,
        delta: outcome.delta,
        comboUp: outcome.comboUp,
        multiplier: outcome.multiplier,
        streak: this.score.streak,
        bonus: outcome.bonus,
        lostStreak: outcome.lostStreak,
        chosenLane: lane,
        correctLane: active.gate.correctLane,
        correctText: item.correct,
        chosenText: option.text,
        whyWrong: option.whyWrong,
      },
    });
    this.emit({ type: "answer", correct, comboUp: outcome.comboUp, multiplier: outcome.multiplier, streak: this.score.streak, milestone: outcome.bonus > 0, lane });

    this.passed.push(active);
    this.gate = null;
    // Вопрос в HUD остаётся до следующего: карточки успевают показать, где был верный ответ.
    this.nextQuestionAt = this.ahead[0]?.start ?? this.distance + RUN_SPEED * GAP_SECONDS;
    this.nextQuestionClock = this.clock + GAP_SECONDS;

    if (this.score.lives === 0) {
      this.setPhase("gameover");
      if (this.night) this.complete(false);
    }
  }

  private beginFinish() {
    this.finishDistance = this.distance + RUN_SPEED * FINISH_AFTER;
    useHud.setState({ waiting: false, gate: null });
    this.setPhase("finishing");
  }

  private complete(finished: boolean) {
    this.speedControl.clear();
    if (this.completed) return;
    this.completed = true;
    this.clearModifiers();
    const finishedAt = new Date();
    const result: RunResult = {
      finished,
      score: this.score.score,
      correct: this.score.correct,
      wrong: this.score.wrong,
      maxStreak: this.score.maxStreak,
      durationMs: finishedAt.getTime() - this.startedAt.getTime(),
      mistakes: this.mistakes,
      previousBest: this.options.previousBest,
      coins: this.coinCount,
      obstacles: this.rowsPassed,
      bumps: this.bumps,
      bestClean: this.bestClean,
      impacts: { ...this.impacts },
    };
    useHud.setState({ result, gate: null, hint: null, chase: null });
    this.options.onComplete(result, this.answers, this.startedAt, finishedAt);
  }

  get maxStreak(): number {
    return this.score.maxStreak;
  }
}
