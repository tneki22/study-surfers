import { RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { type Group, LatheGeometry, MeshBasicMaterial, MeshStandardMaterial, Vector2 } from "three";
import { GROUND_Y } from "../../constants";
import { useRuntime } from "../context";
import { RUNNER_BODY } from "../debug/ClearanceProbe";
import { RunnerFx } from "./RunnerFx";
import { CityModifierGear } from "./CityModifierGear";
import { ModifierMotion, TILT_PIVOT } from "./modifierMotion";

const COLORS = {
  hoodie: "#ff5a3c",
  hoodieDark: "#e2472c",
  pants: "#273451",
  skin: "#eab48f",
  hair: "#3b2a20",
  shoe: "#f7f8fa",
  sole: "#2b2f3a",
  accent: "#25c8f5",
  pack: "#ffc93c",
  pocket: "#ff7a4a",
  strap: "#2b2f3a",
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t * t * (3 - 2 * t);

/** Поза суставов; все анимации смешиваются как числа, потом пишутся в группы. */
interface Pose {
  hipsY: number;
  hipsTwist: number;
  lean: number;
  torsoTwist: number;
  headPitch: number;
  headYaw: number;
  thigh: [number, number];
  knee: [number, number];
  ankle: [number, number];
  shoulder: [number, number];
  shoulderOut: [number, number];
  elbow: [number, number];
}

const blank = (): Pose => ({
  hipsY: 0.95, hipsTwist: 0, lean: 0, torsoTwist: 0, headPitch: 0, headYaw: 0,
  thigh: [0, 0], knee: [0, 0], ankle: [0, 0], shoulder: [0, 0], shoulderOut: [0.12, 0.12], elbow: [0.3, 0.3],
});

function mix(target: Pose, other: Pose, w: number) {
  if (w <= 0) return;
  for (const key of Object.keys(target) as (keyof Pose)[]) {
    const a = target[key];
    const b = other[key];
    if (Array.isArray(a) && Array.isArray(b)) {
      a[0] = lerp(a[0], b[0], w);
      a[1] = lerp(a[1], b[1], w);
    } else {
      (target[key] as number) = lerp(a as number, b as number, w);
    }
  }
}

/**
 * Бегун из примитивов со «скелетом»: таз → корпус → голова и руки с локтями,
 * бёдра → колени → стопы. Позы считаются кодом и смешиваются: бег, ожидание,
 * прыжок с группировкой, подкат, спотыкание, радость на финише, падение.
 * Персонаж «Студент» в параметрах; пока грузится модель KayKit, бежит он же.
 */
export function ProceduralRunner({ reducedMotion, quietEffects = reducedMotion }: { reducedMotion: boolean; quietEffects?: boolean }) {
  const runtime = useRuntime();
  const root = useRef<Group>(null);
  const squash = useRef<Group>(null);
  const tilt = useRef<Group>(null);
  const hips = useRef<Group>(null);
  const torso = useRef<Group>(null);
  const head = useRef<Group>(null);
  const thighs = [useRef<Group>(null), useRef<Group>(null)];
  const knees = [useRef<Group>(null), useRef<Group>(null)];
  const ankles = [useRef<Group>(null), useRef<Group>(null)];
  const shoulders = [useRef<Group>(null), useRef<Group>(null)];
  const elbows = [useRef<Group>(null), useRef<Group>(null)];
  const smoothed = useRef({ lean: 0, air: 0 });
  const motion = useMemo(() => new ModifierMotion(), []);

  const materials = useMemo(() => ({
    hoodie: new MeshStandardMaterial({ color: COLORS.hoodie, roughness: 0.78 }),
    hoodieDark: new MeshStandardMaterial({ color: COLORS.hoodieDark, roughness: 0.8 }),
    pants: new MeshStandardMaterial({ color: COLORS.pants, roughness: 0.82 }),
    skin: new MeshStandardMaterial({ color: COLORS.skin, roughness: 0.55 }),
    hair: new MeshStandardMaterial({ color: COLORS.hair, roughness: 0.7 }),
    shoe: new MeshStandardMaterial({ color: COLORS.shoe, roughness: 0.45 }),
    sole: new MeshStandardMaterial({ color: COLORS.sole, roughness: 0.6 }),
    accent: new MeshStandardMaterial({ color: COLORS.accent, roughness: 0.3, metalness: 0.2 }),
    pack: new MeshStandardMaterial({ color: COLORS.pack, roughness: 0.6 }),
    pocket: new MeshStandardMaterial({ color: COLORS.pocket, roughness: 0.6 }),
    strap: new MeshStandardMaterial({ color: COLORS.strap, roughness: 0.7 }),
    eye: new MeshStandardMaterial({ color: "#1b1f2a", roughness: 0.2 }),
    shine: new MeshBasicMaterial({ color: "#ffffff" }),
    mouth: new MeshStandardMaterial({ color: "#8a3b2e", roughness: 0.6 }),
  }), []);
  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials]);

  // Корпус в толстовке: шире в плечах, уже в талии.
  const torsoGeometry = useMemo(() => {
    const profile = [[0.0, -0.02], [0.19, 0.0], [0.215, 0.12], [0.25, 0.3], [0.265, 0.44], [0.235, 0.54], [0.12, 0.61], [0.0, 0.63]];
    const geometry = new LatheGeometry(profile.map(([r, y]) => new Vector2(r, y)), 18);
    geometry.scale(1, 1, 0.74);
    return geometry;
  }, []);
  useEffect(() => () => torsoGeometry.dispose(), [torsoGeometry]);

  const pose = useMemo(blank, []);
  const scratch = useMemo(blank, []);

  useFrame((_, rawDelta) => {
    if (runtime.phase === "paused") return;
    const parts = [root, squash, tilt, hips, torso, head, ...thighs, ...knees, ...ankles, ...shoulders, ...elbows];
    if (parts.some((part) => !part.current)) return;
    const dt = Math.min(rawDelta, 1 / 20);
    const phase = runtime.phase;
    const clock = runtime.clock;
    const amp = clamp01(runtime.speed / 9);
    const stride = runtime.stride * Math.PI * 2;
    const smooth = smoothed.current;

    // --- Бег и ожидание ---
    Object.assign(pose, blank());
    for (let side = 0; side < 2; side += 1) {
      const phi = stride + side * Math.PI;
      const s = Math.sin(phi);
      pose.thigh[side] = s * 0.9 * amp;
      pose.knee[side] = -(0.12 + 1.35 * Math.max(0, Math.cos(phi + 0.4)) ** 1.6) * amp - 0.05;
      pose.ankle[side] = 0.3 * Math.sin(phi - 0.7) * amp;
      pose.shoulder[side] = -s * 0.8 * amp;
      pose.elbow[side] = 0.35 + (1.05 + 0.25 * s) * amp;
    }
    const breathe = Math.sin(clock * 2.3);
    pose.hipsY = 0.95 - 0.03 * amp + Math.abs(Math.cos(stride)) * 0.065 * amp + breathe * 0.008 * (1 - amp);
    pose.lean = -0.2 * amp;
    pose.torsoTwist = Math.sin(stride) * 0.2 * amp;
    pose.hipsTwist = -Math.sin(stride) * 0.12 * amp;
    pose.headPitch = 0.16 * amp;
    pose.headYaw = -pose.torsoTwist * 0.8;

    // --- Прыжок и падение с крыши: группировка, руки вверх ---
    // Вес позы сглажен: приземление на крышу раньше конца прыжка не дёргает тело.
    const jump = runtime.jumpProgress();
    smooth.air += ((runtime.airborne ? 1 : 0) - smooth.air) * (1 - Math.exp(-dt * (runtime.airborne ? 16 : 11)));
    if (smooth.air > 0.001) {
      Object.assign(scratch, blank());
      scratch.hipsY = 0.95;
      scratch.thigh = [1.15, 0.35];
      scratch.knee = [-1.55, -1.05];
      scratch.ankle = [-0.35, -0.2];
      scratch.shoulder = [-2.4, -2.0];
      scratch.shoulderOut = [0.35, 0.35];
      scratch.elbow = [0.45, 0.6];
      scratch.lean = -0.08;
      scratch.headPitch = 0.05;
      mix(pose, scratch, smooth.air);
    }

    // --- Джетпак: руки на ручках ранца, ноги болтаются; сальто гравикроссов — группировка ---
    motion.update(runtime, dt, reducedMotion);
    if (motion.fly > 0) {
      const swing = Math.sin(motion.kick) * 0.3;
      Object.assign(scratch, blank());
      scratch.thigh = [0.2 + swing, 0.2 - swing];
      scratch.knee = [-0.75 + swing * 0.5, -0.75 - swing * 0.5];
      scratch.ankle = [-0.35, -0.35];
      scratch.shoulder = [0.3, 0.3];
      scratch.shoulderOut = [0.4, 0.4];
      scratch.elbow = [1.45, 1.45];
      scratch.headPitch = -0.3;
      mix(pose, scratch, motion.fly);
    }
    if (motion.tuck > 0) {
      Object.assign(scratch, blank());
      scratch.thigh = [1.95, 1.95];
      scratch.knee = [-2.2, -2.2];
      scratch.ankle = [-0.2, -0.2];
      scratch.shoulder = [-1.15, -1.15];
      scratch.shoulderOut = [0.3, 0.3];
      scratch.elbow = [1.1, 1.1];
      scratch.lean = -0.35;
      scratch.headPitch = 0.35;
      mix(pose, scratch, motion.tuck);
    }

    // --- Подкат: корпус назад, ноги вперёд (та же кривая, по которой логика пускает под балку) ---
    const slide = runtime.slideDepth();
    if (slide > 0) {
      Object.assign(scratch, blank());
      scratch.hipsY = 0.4;
      scratch.thigh = [1.42, 1.1];
      scratch.knee = [-0.15, -1.2];
      scratch.ankle = [0.3, 0.1];
      scratch.lean = 1.12;
      scratch.headPitch = -0.95;
      scratch.shoulder = [0.75, 0.55];
      scratch.shoulderOut = [0.5, 0.5];
      scratch.elbow = [0.3, 0.5];
      mix(pose, scratch, slide);
    }

    // --- Спотыкание о препятствие ---
    const bump = (clock - runtime.bumpClock) / (runtime.bumpSeverity === "crash" ? 0.9 : runtime.bumpSeverity === "graze" ? 0.4 : 0.65);
    if (bump >= 0 && bump < 1) {
      // Задел — лёгкое спотыкание, крушение — сильнее.
      const w = Math.sin(bump * Math.PI) * (runtime.bumpSeverity === "graze" ? 0.4 : runtime.bumpSeverity === "crash" ? 1.25 : 1);
      pose.lean -= 0.55 * w;
      pose.shoulder[0] = lerp(pose.shoulder[0], -1.6 + Math.sin(bump * 28) * 0.5, w);
      pose.shoulder[1] = lerp(pose.shoulder[1], -0.9 - Math.sin(bump * 26) * 0.5, w);
      pose.shoulderOut = [lerp(pose.shoulderOut[0], 0.9, w), lerp(pose.shoulderOut[1], 0.9, w)];
      pose.headPitch += 0.3 * w;
    }

    // --- Неверный ответ: вздрогнуть и мотнуть головой ---
    const hit = (clock - runtime.hitClock) / 0.55;
    if (hit >= 0 && hit < 1) {
      const w = Math.sin(hit * Math.PI);
      pose.headYaw += Math.sin(hit * 30) * 0.35 * (1 - hit);
      pose.lean -= 0.18 * w;
      pose.hipsY -= 0.05 * w;
    }

    // --- Верный ответ: короткий взмах кулаком ---
    const win = (clock - runtime.successClock) / 0.5;
    if (win >= 0 && win < 1 && !runtime.airborne && slide <= 0) {
      const w = Math.sin(win * Math.PI);
      pose.shoulder[1] = lerp(pose.shoulder[1], -2.7, w);
      pose.elbow[1] = lerp(pose.elbow[1], 1.4, w);
      pose.shoulderOut[1] = lerp(pose.shoulderOut[1], 0.25, w);
    }

    // --- Финиш и проигрыш ---
    let hop = 0;
    if (phase === "finished") {
      const t = runtime.phaseClock;
      const w = clamp01(t / 0.4);
      Object.assign(scratch, blank());
      scratch.shoulder = [-2.75 + Math.sin(t * 9) * 0.25, -2.75 - Math.sin(t * 9) * 0.25];
      scratch.shoulderOut = [0.55, 0.55];
      scratch.elbow = [0.3, 0.3];
      scratch.headPitch = -0.25;
      mix(pose, scratch, w);
      hop = Math.max(0, Math.sin(t * 7)) * 0.32 * w;
    }
    if (phase === "gameover") {
      const t = clamp01(runtime.phaseClock / 0.6);
      pose.lean = lerp(pose.lean, -1.35, ease(t));
      pose.hipsY = lerp(pose.hipsY, 0.55, ease(t));
      pose.shoulder = [lerp(pose.shoulder[0], -1.5, t), lerp(pose.shoulder[1], -1.5, t)];
      pose.thigh = [lerp(pose.thigh[0], -0.4, t), lerp(pose.thigh[1], 0.2, t)];
    }

    // --- Запись в скелет ---
    const feet = runtime.feet;
    const targetLean = Math.max(-0.5, Math.min(0.5, runtime.runnerVX * 0.17));
    smooth.lean += (targetLean - smooth.lean) * (1 - Math.exp(-dt * 14));
    root.current!.position.set(runtime.runnerX, GROUND_Y + feet + hop, 0);
    root.current!.rotation.set(0, -smooth.lean * 0.55, -smooth.lean);

    // Сжатие на приземлении и вытягивание при отрыве.
    let stretch = 0;
    const land = (clock - runtime.landClock) / 0.18;
    if (land >= 0 && land < 1 && !reducedMotion) stretch = -0.13 * Math.sin(land * Math.PI);
    if (jump >= 0 && jump < 0.35 && !reducedMotion) stretch = 0.09 * Math.sin((jump / 0.35) * Math.PI);
    stretch *= Math.min(1, 0.4 + runtime.landImpact() / 8);
    squash.current!.scale.set(1 - stretch * 0.5, 1 + stretch, 1 - stretch * 0.5);
    tilt.current!.position.y = TILT_PIVOT + motion.bob;
    tilt.current!.rotation.set(motion.pitch, 0, motion.roll);

    hips.current!.position.y = pose.hipsY;
    hips.current!.rotation.set(0, pose.hipsTwist, 0);
    torso.current!.rotation.set(pose.lean, pose.torsoTwist, 0);
    head.current!.rotation.set(pose.headPitch, pose.headYaw, 0);
    for (let side = 0; side < 2; side += 1) {
      const sign = side === 0 ? -1 : 1;
      thighs[side].current!.rotation.x = pose.thigh[side];
      knees[side].current!.rotation.x = pose.knee[side];
      ankles[side].current!.rotation.x = pose.ankle[side];
      shoulders[side].current!.rotation.set(pose.shoulder[side], 0, sign * pose.shoulderOut[side]);
      elbows[side].current!.rotation.x = pose.elbow[side];
    }

  });

  const m = materials;
  return (
    <>
      <RunnerFx starsHeight={2.05} />
      <CityModifierGear feet={() => ankles.map(ankle => ankle.current)} back={() => torso.current} frame={() => tilt.current} backOffset={[0.36, 0.52]} quiet={quietEffects} />
      <group ref={root} name={RUNNER_BODY}>
        <group ref={tilt} position-y={TILT_PIVOT}>
        <group position-y={-TILT_PIVOT}>
        <group ref={squash}>
          <group ref={hips} position-y={0.95}>
            <mesh material={m.pants} scale={[0.21, 0.13, 0.16]} castShadow>
              <sphereGeometry args={[1, 16, 10]} />
            </mesh>

            <group ref={torso}>
              <mesh geometry={torsoGeometry} material={m.hoodie} castShadow />
              {/* Низ толстовки и капюшон за шеей */}
              <mesh material={m.hoodieDark} position-y={0.02} rotation-x={Math.PI / 2} scale={[1, 0.74, 1]}>
                <torusGeometry args={[0.2, 0.035, 8, 20]} />
              </mesh>
              <mesh material={m.hoodieDark} position={[0, 0.585, 0.09]} rotation-x={1.25} castShadow>
                <torusGeometry args={[0.13, 0.06, 8, 16]} />
              </mesh>
              {/* Рюкзак с карманом и лямками */}
              <RoundedBox args={[0.36, 0.42, 0.18]} radius={0.06} smoothness={3} position={[0, 0.32, 0.25]} material={m.pack} castShadow />
              <RoundedBox args={[0.27, 0.17, 0.08]} radius={0.035} smoothness={3} position={[0, 0.2, 0.355]} material={m.pocket} />
              <mesh material={m.strap} position={[0, 0.53, 0.25]}>
                <torusGeometry args={[0.05, 0.012, 6, 12, Math.PI]} />
              </mesh>
              {[-1, 1].map((side) => (
                <mesh key={side} material={m.strap} position={[side * 0.12, 0.38, -0.17]} rotation-z={side * 0.12}>
                  <boxGeometry args={[0.045, 0.4, 0.02]} />
                </mesh>
              ))}

              <group ref={head} position-y={0.62}>
                <mesh material={m.skin} position-y={0.05}>
                  <cylinderGeometry args={[0.06, 0.07, 0.1, 10]} />
                </mesh>
                <mesh material={m.skin} position-y={0.2} castShadow>
                  <sphereGeometry args={[0.2, 24, 18]} />
                </mesh>
                <mesh material={m.hair} position={[0, 0.235, 0.035]} scale={[1, 0.96, 1]} castShadow>
                  <sphereGeometry args={[0.206, 22, 16]} />
                </mesh>
                {/* Лицо: глаза с бликом, брови, нос, улыбка */}
                {[-1, 1].map((side) => (
                  <group key={side} position={[side * 0.07, 0.215, -0.18]}>
                    <mesh material={m.eye} scale={[0.85, 1.25, 0.5]}>
                      <sphereGeometry args={[0.032, 12, 10]} />
                    </mesh>
                    <mesh material={m.shine} position={[side * -0.008, 0.012, -0.014]}>
                      <sphereGeometry args={[0.009, 8, 6]} />
                    </mesh>
                    <mesh material={m.hair} position={[0, 0.06, 0.004]} rotation-z={side * -0.18}>
                      <boxGeometry args={[0.06, 0.013, 0.02]} />
                    </mesh>
                  </group>
                ))}
                <mesh material={m.skin} position={[0, 0.17, -0.2]} scale={[1, 0.85, 1]}>
                  <sphereGeometry args={[0.026, 10, 8]} />
                </mesh>
                <mesh material={m.mouth} position={[0, 0.125, -0.178]} rotation={[0.35, 0, Math.PI]}>
                  <torusGeometry args={[0.035, 0.008, 6, 12, Math.PI]} />
                </mesh>
                {/* Наушники */}
                <mesh material={m.accent} position-y={0.21}>
                  <torusGeometry args={[0.222, 0.022, 8, 24, Math.PI]} />
                </mesh>
                {[-1, 1].map((side) => (
                  <mesh key={side} material={m.accent} position={[side * 0.215, 0.19, 0]} rotation-z={Math.PI / 2}>
                    <cylinderGeometry args={[0.072, 0.072, 0.07, 16]} />
                  </mesh>
                ))}
              </group>

              {[0, 1].map((side) => (
                <group key={side} ref={shoulders[side]} position={[side === 0 ? -0.27 : 0.27, 0.5, 0]}>
                  <mesh material={m.hoodie} position-y={-0.14} castShadow>
                    <capsuleGeometry args={[0.072, 0.18, 4, 10]} />
                  </mesh>
                  <group ref={elbows[side]} position-y={-0.29}>
                    <mesh material={m.hoodie} position-y={-0.11} castShadow>
                      <capsuleGeometry args={[0.064, 0.15, 4, 10]} />
                    </mesh>
                    <mesh material={m.hoodieDark} position-y={-0.21}>
                      <cylinderGeometry args={[0.066, 0.066, 0.04, 10]} />
                    </mesh>
                    <mesh material={m.skin} position-y={-0.27}>
                      <sphereGeometry args={[0.062, 12, 10]} />
                    </mesh>
                  </group>
                </group>
              ))}
            </group>

            {[0, 1].map((side) => (
              <group key={side} ref={thighs[side]} position={[side === 0 ? -0.105 : 0.105, -0.05, 0]}>
                <mesh material={m.pants} position-y={-0.19} castShadow>
                  <capsuleGeometry args={[0.088, 0.24, 4, 10]} />
                </mesh>
                <group ref={knees[side]} position-y={-0.41}>
                  <mesh material={m.pants} position-y={-0.18} castShadow>
                    <capsuleGeometry args={[0.074, 0.24, 4, 10]} />
                  </mesh>
                  <group ref={ankles[side]} position-y={-0.39}>
                    <RoundedBox args={[0.13, 0.11, 0.29]} radius={0.045} smoothness={3} position={[0, -0.02, -0.05]} material={m.shoe} castShadow />
                    <mesh material={m.sole} position={[0, -0.07, -0.05]}>
                      <boxGeometry args={[0.135, 0.03, 0.29]} />
                    </mesh>
                    <mesh material={m.accent} position={[side === 0 ? -0.066 : 0.066, -0.015, -0.04]}>
                      <boxGeometry args={[0.006, 0.04, 0.16]} />
                    </mesh>
                  </group>
                </group>
              </group>
            ))}
          </group>
        </group>
        </group>
        </group>
      </group>
    </>
  );
}
