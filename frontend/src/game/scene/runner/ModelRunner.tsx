import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { type AnimationAction, AnimationClip, AnimationMixer, type Bone, type Group, type Material, type Mesh, MeshStandardMaterial, type Object3D } from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { GROUND_Y } from "../../constants";
import { RUN_SPEED } from "../../engine/timing";
import { useRuntime } from "../context";
import { ANIMATIONS_URL, heroUrl, type CharacterId } from "./characters";
import { RUNNER_BODY } from "../debug/ClearanceProbe";
import { RunnerFx } from "./RunnerFx";
import { CityModifierGear } from "./CityModifierGear";
import { aimBone, emptyAims, flightAims, ModifierMotion, TILT_PIVOT, TUCK_AIMS } from "./modifierMotion";

/** Герои KayKit ростом 2,25 единицы — приводим к ~1,85 м, как у процедурного бегуна. */
const SCALE = 0.82;

/** Какие клипы набора играет каждый «слот» автомата. */
const CLIPS = {
  idle: "Unarmed_Idle",
  ready: "Idle",
  run: "Running_A",
  strafeLeft: "Running_Strafe_Left",
  strafeRight: "Running_Strafe_Right",
  takeoff: "Jump_Start",
  air: "Jump_Idle",
  land: "Jump_Land",
  lie: "Lie_Pose",
  bump: "Hit_A",
  flinch: "Hit_B",
  cheer: "Cheer",
  death: "Death_A",
} as const;
type Slot = keyof typeof CLIPS | "pump";

/** Кости верха тела: взмах кулаком на верный ответ играет только их, ноги продолжают бежать. */
const UPPER_BODY = new Set(["chest", "head", "upperarml", "lowerarml", "wristl", "handl", "upperarmr", "lowerarmr", "wristr", "handr"]);

const BUMP_LOOK = { graze: { seconds: 0.4, weight: 0.8 }, hit: { seconds: 0.6, weight: 2.4 }, crash: { seconds: 0.9, weight: 3.2 } } as const;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const bell = (t: number) => (t < 0 || t > 1 ? 0 : Math.sin(t * Math.PI));
const loopTime = (t: number, duration: number) => ((t % duration) + duration) % duration;

/** Начать загрузку героя заранее; промис — когда файлы уже в кеше браузера. */
export function preloadCharacter(id: CharacterId): Promise<void> {
  if (id === "student") return Promise.resolve();
  useGLTF.preload(heroUrl(id), false, true);
  useGLTF.preload(ANIMATIONS_URL, false, true);
  return Promise.all([fetch(heroUrl(id)), fetch(ANIMATIONS_URL)]).then(() => undefined, () => undefined);
}

/**
 * Бегун на модели KayKit. Клипы не переключаются «по событию», а смешиваются
 * каждый кадр по состоянию забега, и время каждого клипа задаётся из рантайма:
 * бег — по фазе шага (ноги совпадают со звуком шагов), прыжок — по баллистике,
 * подкат — по той же кривой, по которой логика пускает под балку. Пауза
 * замораживает позу сама собой.
 */
export function ModelRunner({ hero, reducedMotion, quietEffects = reducedMotion }: { hero: Exclude<CharacterId, "student">; reducedMotion: boolean; quietEffects?: boolean }) {
  const runtime = useRuntime();
  const { scene } = useGLTF(heroUrl(hero), false, true);
  const { animations } = useGLTF(ANIMATIONS_URL, false, true);
  const root = useRef<Group>(null);
  const squash = useRef<Group>(null);
  const tilt = useRef<Group>(null);
  const smoothed = useRef({ lean: 0, air: 0, death: 0 });
  const motion = useMemo(() => new ModifierMotion(), []);
  const aims = useMemo(emptyAims, []);

  const model = useMemo(() => {
    const copy = cloneSkinned(scene);
    const materials = new Map<Material, Material>();
    copy.traverse((object: Object3D) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      const source = mesh.material as Material;
      if (!materials.has(source) && source instanceof MeshStandardMaterial) {
        const tuned = source.clone();
        tuned.roughness = 0.72;
        tuned.metalness = 0;
        materials.set(source, tuned);
      }
      mesh.material = materials.get(source) ?? source;
    });
    return { object: copy, materials: [...materials.values()] };
  }, [scene]);
  useEffect(() => () => model.materials.forEach((m) => m.dispose()), [model]);

  const rig = useMemo(() => {
    const mixer = new AnimationMixer(model.object);
    const byName = new Map(animations.map((clip) => [clip.name, clip]));
    const actions = {} as Record<Slot, AnimationAction>;
    for (const [slot, name] of Object.entries(CLIPS) as [keyof typeof CLIPS, string][]) {
      const clip = byName.get(name);
      if (!clip) throw new Error(`В kaykit-anims.glb нет клипа ${name}`);
      actions[slot] = mixer.clipAction(clip);
    }
    const cheer = byName.get(CLIPS.cheer)!;
    const pump = new AnimationClip("Pump", cheer.duration, cheer.tracks.filter((track) => UPPER_BODY.has(track.name.split(".")[0])));
    actions.pump = mixer.clipAction(pump);
    for (const action of Object.values(actions)) {
      action.play();
      action.setEffectiveWeight(0);
    }
    let head: Object3D | undefined;
    model.object.traverse((object) => {
      if (object.name === "head") head = object;
    });
    const bone = (name: string) => model.object.getObjectByName(name) as Bone | undefined;
    // Цепочки рук и ног для поз усилений: сегмент — от кости к следующей.
    const limbs = (["l", "r"] as const).map((side) => ({
      upperArm: [bone(`upperarm${side}`), bone(`lowerarm${side}`)],
      foreArm: [bone(`lowerarm${side}`), bone(`wrist${side}`)],
      thigh: [bone(`upperleg${side}`), bone(`lowerleg${side}`)],
      shin: [bone(`lowerleg${side}`), bone(`foot${side}`)],
    }));
    return { mixer, actions, head, chest: bone("chest") ?? null, limbs, feet: [model.object.getObjectByName("footl") ?? null, model.object.getObjectByName("footr") ?? null] };
  }, [animations, model]);
  useEffect(() => () => {
    rig.mixer.stopAllAction();
    rig.mixer.uncacheRoot(model.object);
  }, [rig, model]);

  const weights = useMemo(() => Object.fromEntries(Object.keys(rig.actions).map((slot) => [slot, 0])) as Record<Slot, number>, [rig]);

  useFrame((_, rawDelta) => {
    if (!root.current || !squash.current || !tilt.current || runtime.phase === "paused") return;
    const dt = Math.min(rawDelta, 1 / 20);
    const { actions } = rig;
    const clock = runtime.clock;
    const phase = runtime.phase;
    const smooth = smoothed.current;
    const time = (slot: Slot, t: number) => {
      actions[slot].time = Math.min(t, actions[slot].getClip().duration);
    };
    for (const slot of Object.keys(weights) as Slot[]) weights[slot] = 0;

    // --- Основа: стоим, бежим, летим, лежим, радуемся, падаем ---
    if (phase === "loading" || phase === "intro") {
      const cheer = clamp01(Math.min((runtime.phaseClock - 0.25) / 0.2, (2.05 - runtime.phaseClock) / 0.3));
      weights.cheer = cheer;
      weights.idle = 1 - cheer;
      time("cheer", clamp01((runtime.phaseClock - 0.25) / 1.75) * actions.cheer.getClip().duration);
      time("idle", loopTime(clock, actions.idle.getClip().duration));
    } else if (phase === "countdown") {
      weights.ready = 1;
      time("ready", loopTime(clock, actions.ready.getClip().duration));
    } else if (phase === "gameover") {
      smooth.death = Math.min(1, smooth.death + dt / 0.15);
      weights.death = smooth.death;
      weights.run = 1 - smooth.death;
      time("death", runtime.phaseClock);
    } else {
      const runWeight = phase === "finished" ? clamp01(runtime.speed / RUN_SPEED) : 1;
      weights.cheer = 1 - runWeight;
      time("cheer", loopTime(runtime.phaseClock, actions.cheer.getClip().duration));

      smooth.air += ((runtime.airborne ? 1 : 0) - smooth.air) * (1 - Math.exp(-dt * (runtime.airborne ? 18 : 12)));
      const lie = runtime.slideDepth();
      const ground = runWeight * (1 - smooth.air) * (1 - lie);
      weights.lie = runWeight * lie;
      time("lie", 0);

      // Толчок первые 0,18 с прыжка, дальше — поза полёта.
      const sinceJump = clock - runtime.jumpClock;
      const push = runtime.jumpProgress() >= 0 ? clamp01(sinceJump / 0.18) : 1;
      const air = runWeight * smooth.air * (1 - lie);
      weights.takeoff = air * (1 - push);
      weights.air = air * push;
      time("takeoff", 0.3 + push * 0.15);
      time("air", loopTime(clock, actions.air.getClip().duration));

      // Приземление: присед из Jump_Land тем глубже, чем быстрее касание.
      const sinceLand = (clock - runtime.landClock) / 0.3;
      const landing = sinceLand < 1 && !runtime.airborne ? (1 - sinceLand) ** 1.5 * clamp01(runtime.landImpact() / 6) : 0;
      weights.land = ground * landing;
      time("land", 0.12 + clamp01(sinceLand) * 0.26);

      // Бег: время клипа — фаза шага; при смене трека подмешиваем бег боком.
      const running = ground * (1 - landing);
      const strafe = Math.min(0.55, Math.abs(runtime.runnerVX) * 0.3);
      weights.run = running * (1 - strafe);
      weights[runtime.runnerVX < 0 ? "strafeLeft" : "strafeRight"] = running * strafe;
      const stride = loopTime(runtime.stride, 1);
      time("run", stride * actions.run.getClip().duration);
      time("strafeLeft", stride * actions.strafeLeft.getClip().duration);
      time("strafeRight", stride * actions.strafeRight.getClip().duration);
    }

    // Основа в сумме даёт 1, чтобы поза покоя скелета не просвечивала.
    let total = 0;
    for (const slot of Object.keys(CLIPS) as Slot[]) total += weights[slot];
    if (total > 0) for (const slot of Object.keys(CLIPS) as Slot[]) weights[slot] /= total;

    // --- Наложения поверх основы (вес — доля от основы) ---
    if (phase !== "gameover") {
      // Задел — короткое спотыкание, крушение — дольше и сильнее.
      const look = BUMP_LOOK[runtime.bumpSeverity];
      const bump = (clock - runtime.bumpClock) / look.seconds;
      weights.bump = bell(bump) * look.weight;
      time("bump", clamp01(bump) * 0.6);
      const flinch = (clock - runtime.hitClock) / 0.55;
      weights.flinch = bell(flinch) * 0.9;
      time("flinch", clamp01(flinch) * 0.6);
      const win = (clock - runtime.successClock) / 0.6;
      weights.pump = !runtime.airborne && runtime.slideDepth() === 0 ? bell(win) * 3 : 0;
      time("pump", 0.2 + clamp01(win) * 0.7);
    }

    for (const slot of Object.keys(weights) as Slot[]) actions[slot].setEffectiveWeight(weights[slot]);
    rig.mixer.update(0);

    // Полёт и сальто: руки и ноги доворачиваются поверх клипа по направлениям корпуса.
    motion.update(runtime, dt, reducedMotion);
    const pose = (target: typeof aims, weight: number) => {
      if (weight <= 0.001) return;
      // Сначала верхние сегменты, потом нижние: они уже висят на новых суставах.
      for (const part of ["upperArm", "thigh", "foreArm", "shin"] as const) {
        rig.limbs.forEach((limb, side) => {
          const [bone, child] = limb[part];
          if (bone && child) aimBone(bone, child, target[part][side], tilt.current!, weight);
        });
      }
    };
    pose(flightAims(motion.kick, aims), motion.fly);
    pose(TUCK_AIMS, motion.tuck);

    // Ошибка: мотнуть головой поверх клипа.
    const shake = (clock - runtime.hitClock) / 0.55;
    if (rig.head && shake >= 0 && shake < 1) rig.head.rotateY(Math.sin(shake * 30) * 0.3 * (1 - shake));

    // --- Положение, наклон в повороте, сжатие на приземлении ---
    const targetLean = Math.max(-0.5, Math.min(0.5, runtime.runnerVX * 0.17));
    smooth.lean += (targetLean - smooth.lean) * (1 - Math.exp(-dt * 14));
    const hop = phase === "finished" ? Math.max(0, Math.sin(runtime.phaseClock * 7)) * 0.25 * (1 - clamp01(runtime.speed / RUN_SPEED)) : 0;
    root.current.position.set(runtime.runnerX, GROUND_Y + runtime.feet + hop, 0);
    root.current.rotation.set(0, -smooth.lean * 0.55, -smooth.lean);

    let stretch = 0;
    const land = (clock - runtime.landClock) / 0.2;
    if (land >= 0 && land < 1 && !reducedMotion) stretch = -0.12 * Math.sin(land * Math.PI) * Math.min(1, 0.4 + runtime.landImpact() / 8);
    const jump = runtime.jumpProgress();
    if (jump >= 0 && jump < 0.3 && !reducedMotion) stretch = 0.08 * Math.sin((jump / 0.3) * Math.PI);
    squash.current.scale.set(1 - stretch * 0.5, 1 + stretch, 1 - stretch * 0.5);
    tilt.current.position.y = TILT_PIVOT + motion.bob;
    tilt.current.rotation.set(motion.pitch, 0, motion.roll);
  });

  return (
    <>
      <RunnerFx starsHeight={2.15} />
      <CityModifierGear feet={() => rig.feet} back={() => rig.chest} frame={() => tilt.current} backOffset={[0.08, 0.31]} quiet={quietEffects} />
      <group ref={root} name={RUNNER_BODY}>
        <group ref={tilt} position-y={TILT_PIVOT}>
          <group position-y={-TILT_PIVOT}>
            <group ref={squash}>
              <primitive object={model.object} rotation-y={Math.PI} scale={SCALE} />
            </group>
          </group>
        </group>
      </group>
    </>
  );
}
