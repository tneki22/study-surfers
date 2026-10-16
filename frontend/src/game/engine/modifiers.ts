import { shuffle, type Rng } from "./random";
import type { World } from "./settings";

export type ModifierKind = "jetpack" | "gravity-shoes" | "magnet" | "phase" | "shield";
export const MODIFIER_SECONDS = 6;
export const PICKUP_CLEAR_SECONDS = 0.7;
export const FLIGHT_HEIGHT = 2.6;
export const MAGNET_REACH = 10;
export const SHIELD_REACH = 12;
export const MODIFIER_INFO: Record<ModifierKind, { name: string; hint: string; color: string }> = {
  jetpack: { name: "Джетпак", hint: "Лети над препятствиями · выбирай трек", color: "#ff943d" },
  "gravity-shoes": { name: "Гравикроссы", hint: "Прыжок вдвое выше · вниз — нырок", color: "#a1f56b" },
  magnet: { name: "Магнит", hint: "Монеты со всех треков в радиусе 10 м", color: "#ffd36b" },
  phase: { name: "Фазовый ход", hint: "Проходи сквозь опасности", color: "#c5a3ff" },
  shield: { name: "Импульсный щит", hint: "Три импульса расчищают путь", color: "#70e6ff" },
};

export interface ActiveModifier { kind: ModifierKind; expiresAt: number; charges: number }
export interface ModifierPickup { id: number; kind: ModifierKind; lane: number; distance: number; resolved: boolean; taken: boolean; takenClock: number }
export interface PickupHazard { lane: number; from: number; to: number }

/** Таймеры привязаны к игровому времени, а не к кадрам или настенным часам. */
export class ModifierState {
  active: ActiveModifier[] = [];
  has(kind: ModifierKind): boolean { return this.active.some(effect => effect.kind === kind); }
  activate(kind: ModifierKind, clock: number) {
    // Магнит — независимый слот; движение и защита занимают по одному слоту.
    const slot = (value: ModifierKind) => value === "magnet" ? "magnet" : value === "phase" || value === "shield" ? "defence" : "movement";
    const replaced = this.active.filter(effect => slot(effect.kind) === slot(kind));
    this.active = this.active.filter(effect => slot(effect.kind) !== slot(kind));
    this.active.push({ kind, expiresAt: clock + MODIFIER_SECONDS, charges: kind === "shield" ? 3 : 0 });
    return replaced;
  }
  expire(clock: number): ActiveModifier[] {
    const expired = this.active.filter(effect => effect.expiresAt <= clock);
    this.active = this.active.filter(effect => effect.expiresAt > clock);
    return expired;
  }
  pulse(): number {
    const shield = this.active.find(effect => effect.kind === "shield");
    if (!shield) return 0;
    shield.charges -= 1;
    if (!shield.charges) this.active = this.active.filter(effect => effect !== shield);
    return shield.charges;
  }
  clear() { this.active = []; }
}

/**
 * Сколько предметов получает забег из N основных карточек: от N/5 до 2N/5
 * (10 вопросов → 2–4, 20 → 4–8). Доля u выбирается один раз на забег, поэтому
 * при догрузке карточек бюджет растёт по той же формуле.
 */
export function modifierBudget(mainTotal: number, share: number): number {
  return Math.round((mainTotal / 5) * (1 + share));
}

/** Последний основной участок, где ещё можно ставить предмет: первые 80% забега. */
export const lastModifierSection = (mainTotal: number) => Math.floor(mainTotal * 0.8);

/**
 * Номер участка для очередного предмета: бюджет раскладывается равномерно по
 * участкам 2…80%, первый — на втором вопросе.
 */
export function modifierTarget(placed: number, mainTotal: number, budget: number): number {
  const span = lastModifierSection(mainTotal) - 1;
  return 2 + Math.floor((placed * Math.max(1, span)) / Math.max(1, budget));
}

/** Независимый RNG: ни вопросы, ни препятствия не расходуют эту последовательность. */
export class ModifierPlanner {
  private readonly rng: Rng;
  private readonly kinds: ModifierKind[];
  private bag: ModifierKind[] = [];
  /** Доля u ∈ [0, 1) из формулы бюджета — своя для каждого забега. */
  readonly share: number;
  placed = 0;
  mainIndex = 0;
  constructor(world: World, rng: Rng) {
    this.rng = rng;
    this.share = rng();
    this.kinds = world === "classic" ? ["jetpack", "gravity-shoes"] : ["magnet", "phase", "shield"];
  }
  budget(mainTotal: number): number { return modifierBudget(mainTotal, this.share); }
  section(input: { mainTotal: number; retry: boolean; start: number; end: number; maxSpeed: number; lanes: number; hazards: PickupHazard[] }): Omit<ModifierPickup, "id"> | null {
    if (input.retry) return null;
    this.mainIndex += 1;
    const budget = this.budget(input.mainTotal);
    if (this.placed >= budget || this.mainIndex < modifierTarget(this.placed, input.mainTotal, budget) || this.mainIndex > lastModifierSection(input.mainTotal)) return null;
    const margin = input.maxSpeed * PICKUP_CLEAR_SECONDS;
    // Сначала выбираем трек, без знания правильного ответа. Нет места — перенос на следующий участок.
    const lane = Math.floor(this.rng() * input.lanes);
    let gaps: [number, number][] = [[input.start + margin, input.end - margin]];
    for (const hazard of input.hazards) {
      if (hazard.lane !== lane) continue;
      const from = hazard.from - margin;
      const to = hazard.to + margin;
      gaps = gaps.flatMap(([a, b]) => to <= a || from >= b ? [[a, b] as [number, number]] : [[a, Math.min(b, from)], [Math.max(a, to), b]].filter(([x, y]) => y - x > 0.05) as [number, number][]);
    }
    gaps = gaps.filter(([a, b]) => b > a);
    const room = gaps.reduce((sum, [a, b]) => sum + b - a, 0);
    if (room <= 0) return null;
    let offset = this.rng() * room;
    let distance = gaps[0][0];
    for (const [a, b] of gaps) {
      distance = a + Math.min(offset, b - a);
      if (offset <= b - a) break;
      offset -= b - a;
    }
    if (!this.bag.length) this.bag = shuffle(this.kinds, this.rng);
    this.placed += 1;
    return { kind: this.bag.pop()!, lane, distance, resolved: false, taken: false, takenClock: -10 };
  }
}
