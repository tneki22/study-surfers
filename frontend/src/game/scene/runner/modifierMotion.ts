import { type Bone, type Object3D, Quaternion, Vector3 } from "three";
import type { GameRuntime } from "../../runtime";

const TAU = Math.PI * 2;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Высота оси наклона и сальто над ступнями: примерно центр тела. */
export const TILT_PIVOT = 0.9;

/**
 * Общая для обоих бегунов «телесная» часть усилений: вес позы полёта,
 * наклон вперёд с покачиванием, сальто в прыжке гравикроссов.
 * Только визуал: физика и столкновения считаются в рантайме.
 */
export class ModifierMotion {
  /** 0…1 — поза полёта на джетпаке (плавно и при посадке). */
  fly = 0;
  /** Угол сальто, 0…2π. */
  flip = 0;
  /** 0…1 — группировка в середине сальто. */
  tuck = 0;
  /** Поворот корпуса вокруг оси X (минус — вперёд). */
  pitch = 0;
  roll = 0;
  /** Сдвиг корпуса вверх: покачивание в полёте и подъём центра сальто. */
  bob = 0;
  /** Фаза болтания ногами в полёте. */
  kick = 0;

  update(runtime: GameRuntime, dt: number, reducedMotion: boolean) {
    const jet = runtime.modifiers.has("jetpack");
    this.fly += ((jet ? 1 : 0) - this.fly) * (1 - Math.exp(-dt * (jet ? 5 : 3.5)));
    if (this.fly < 1e-3) this.fly = 0;

    // Сальто растянуто на подъём и пик суперпрыжка. Нырок или посадка до конца
    // оборота докручивают его быстро, без рывка позы.
    const progress = runtime.jumpProgress();
    if (!reducedMotion && runtime.superJump && progress >= 0) {
      this.flip = Math.max(this.flip, TAU * smoother(clamp01((progress - 0.08) / 0.6)));
    } else if (this.flip > 0) {
      this.flip += dt * 15;
      if (this.flip >= TAU) this.flip = 0;
    }
    if (this.flip >= TAU - 1e-4 && progress < 0) this.flip = 0;
    this.tuck = Math.sin(Math.min(this.flip, TAU) / 2) ** 0.6;

    const t = runtime.clock;
    const wobble = reducedMotion ? 0 : 1;
    this.kick = t * 5.2;
    this.pitch = -0.3 * this.fly - this.flip;
    this.roll = Math.sin(t * 1.7) * 0.05 * this.fly * wobble;
    // Перевёрнутая голова иначе уходит ниже ступней: центр сальто приподнят.
    this.bob = Math.sin(t * 2.6) * 0.05 * this.fly * wobble + (1 - Math.cos(this.flip)) * 0.3;
  }
}

/** Направления сегментов в системе корпуса (−Z — вперёд, +X — правая рука героя). */
export interface LimbAims {
  upperArm: [Vector3, Vector3];
  foreArm: [Vector3, Vector3];
  thigh: [Vector3, Vector3];
  shin: [Vector3, Vector3];
}

const scratch = {
  from: new Vector3(),
  to: new Vector3(),
  want: new Vector3(),
  turn: new Quaternion(),
  full: new Quaternion(),
  world: new Quaternion(),
  parent: new Quaternion(),
  frame: new Quaternion(),
  identity: new Quaternion(),
};

/**
 * Довернуть кость, чтобы сегмент «кость → дочерняя кость» смотрел в заданном
 * направлении корпуса. Не зависит от локальных осей риггинга, поэтому одна
 * поза подходит всем пяти героям KayKit.
 */
export function aimBone(bone: Bone, child: Object3D, direction: Vector3, frame: Object3D, weight: number) {
  if (weight <= 0 || !bone.parent) return;
  bone.updateWorldMatrix(true, true);
  const { from, to, want, turn, world, parent } = scratch;
  from.setFromMatrixPosition(bone.matrixWorld);
  to.setFromMatrixPosition(child.matrixWorld).sub(from);
  if (to.lengthSq() < 1e-8) return;
  to.normalize();
  frame.getWorldQuaternion(scratch.frame);
  want.copy(direction).normalize().applyQuaternion(scratch.frame);
  scratch.full.setFromUnitVectors(to, want);
  turn.slerpQuaternions(scratch.identity, scratch.full, Math.min(1, weight));
  bone.getWorldQuaternion(world);
  bone.parent.getWorldQuaternion(parent);
  bone.quaternion.copy(parent.invert().multiply(turn.multiply(world)));
  bone.updateWorldMatrix(false, true);
}

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

/** Полёт: держит ручки ранца у пояса, колени чуть согнуты, ноги болтаются. */
export function flightAims(kick: number, out: LimbAims) {
  const swing = Math.sin(kick) * 0.28;
  out.upperArm[0].set(-0.42, -1, 0.12);
  out.upperArm[1].set(0.42, -1, 0.12);
  out.foreArm[0].set(-0.12, -0.35, -1);
  out.foreArm[1].set(0.12, -0.35, -1);
  out.thigh[0].set(-0.08, -1, -0.16 + swing);
  out.thigh[1].set(0.08, -1, -0.16 - swing);
  out.shin[0].set(0, -1, 0.5 - swing * 0.6);
  out.shin[1].set(0, -1, 0.5 + swing * 0.6);
  return out;
}

/** Группировка в сальто: колени к груди, руки обхватывают голени. */
export const TUCK_AIMS: LimbAims = {
  upperArm: [v(-0.3, -0.35, -1), v(0.3, -0.35, -1)],
  foreArm: [v(-0.05, -1, -0.25), v(0.05, -1, -0.25)],
  thigh: [v(-0.14, 0.35, -1), v(0.14, 0.35, -1)],
  shin: [v(-0.04, -1, 0.1), v(0.04, -1, 0.1)],
};

export const emptyAims = (): LimbAims => ({
  upperArm: [v(0, -1, 0), v(0, -1, 0)],
  foreArm: [v(0, -1, 0), v(0, -1, 0)],
  thigh: [v(0, -1, 0), v(0, -1, 0)],
  shin: [v(0, -1, 0), v(0, -1, 0)],
});
