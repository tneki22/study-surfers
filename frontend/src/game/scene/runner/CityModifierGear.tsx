import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { AdditiveBlending, Color, type Group, type Mesh, type MeshBasicMaterial, NormalBlending, type Object3D, type PerspectiveCamera, Quaternion, Vector3 } from "three";
import { GROUND_Y, laneX } from "../../constants";
import { useRuntime } from "../context";
import { ParticlePool } from "../Effects";
import { softDotTexture } from "../textures";

const hdr = (hex: string, boost: number) => new Color(hex).multiplyScalar(boost);
const FIRE = [hdr("#ff8a2a", 3), hdr("#ffd36b", 3), hdr("#ff5a1f", 2.6)];
const SMOKE = new Color("#ece6dc");
const GREEN = [hdr("#a1f56b", 2.6), hdr("#e4ffc7", 2.2), hdr("#5ef0a0", 2.4)];
const SOLE = new Color("#a1f56b");

/**
 * Общая экипировка: подстраивается под кости KayKit и процедурные стопы.
 * Ранец висит на кости груди и наклоняется вместе с корпусом; факелы, дым и
 * зелёный след гравикроссов — частицы в мире, они уезжают назад вместе с трассой.
 */
export function CityModifierGear({ feet, back, frame, backOffset, quiet }: {
  feet?: () => (Object3D | null)[];
  /** Кость или группа груди и система корпуса (наклон, сальто). */
  back?: () => Object3D | null;
  frame?: () => Object3D | null;
  /** Ранец относительно груди: вверх и назад, в системе корпуса. */
  backOffset: [number, number];
  quiet: boolean;
}) {
  const runtime = useRuntime();
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const gl = useThree((state) => state.gl);
  const jet = useRef<Group>(null);
  const soles = useRef<(Group | null)[]>([]);
  const soleMaterials = useRef<(MeshBasicMaterial | null)[]>([]);
  const flames = useRef<(Group | null)[]>([]);
  const cores = useRef<(Group | null)[]>([]);
  const halos = useRef<(Object3D | null)[]>([]);
  const nozzles = useRef<(Object3D | null)[]>([]);
  const marker = useRef<Group>(null);
  const pulse = useRef<Mesh>(null);
  const landRing = useRef<Mesh>(null);
  const state = useRef({ jetVisible: false, emberDebt: 0, smokeDebt: 0, trailDebt: 0, superLand: -10 });
  const vectors = useMemo(() => ({ point: new Vector3(), offset: new Vector3(), quat: new Quaternion() }), []);
  const pools = useMemo(() => ({ fire: new ParticlePool(220, AdditiveBlending), smoke: new ParticlePool(160, NormalBlending) }), []);
  useEffect(() => () => { pools.fire.dispose(); pools.smoke.dispose(); }, [pools]);

  useEffect(() => runtime.on((event) => {
    if (quiet) return;
    const rand = (spread: number) => (Math.random() - 0.5) * spread;
    const floor = GROUND_Y + runtime.support() + 0.06;
    const x = runtime.runnerX;
    if (event.type === "modifier" && event.kind === "jetpack" && event.action === "pickup") {
      // Старт: кольцо дыма по опоре и сноп искр вниз.
      for (let i = 0; i < 22; i += 1) {
        const a = (i / 22) * Math.PI * 2;
        pools.smoke.spawn({ x: x + Math.cos(a) * 0.3, y: floor, z: Math.sin(a) * 0.3, vx: Math.cos(a) * 3.2, vy: 0.4 + Math.random() * 0.6, vz: Math.sin(a) * 3.2,
          color: SMOKE, size: 0.45 + Math.random() * 0.3, life: 0.9, drag: 3.2, grow: 1.3, world: true, alpha: 0.5 });
      }
      for (let i = 0; i < 26; i += 1) pools.fire.spawn({ x: x + rand(0.5), y: floor + 0.2, z: rand(0.4), vx: rand(4), vy: 1 + Math.random() * 3, vz: rand(4),
        color: FIRE[i % 3], size: 0.13 + Math.random() * 0.08, life: 0.5, gravity: -6, drag: 2, grow: -0.12 });
    }
    if (event.type === "jump" && runtime.superJump) {
      for (let i = 0; i < 18; i += 1) {
        const a = (i / 18) * Math.PI * 2;
        pools.fire.spawn({ x: x + Math.cos(a) * 0.25, y: floor, z: Math.sin(a) * 0.25, vx: Math.cos(a) * 2.6, vy: 1.6 + Math.random() * 2.4, vz: Math.sin(a) * 2.6,
          color: GREEN[i % 3], size: 0.14 + Math.random() * 0.08, life: 0.6, gravity: -5, drag: 2.4, grow: -0.12, world: true });
      }
    }
    if (event.type === "land" && runtime.superJump && runtime.clock - runtime.jumpClock < 3) {
      state.current.superLand = runtime.clock;
      for (let i = 0; i < 14; i += 1) {
        const a = (i / 14) * Math.PI * 2;
        pools.fire.spawn({ x: x + Math.cos(a) * 0.35, y: floor, z: Math.sin(a) * 0.35, vx: Math.cos(a) * 3.4, vy: 0.5 + Math.random(), vz: Math.sin(a) * 3.4,
          color: GREEN[i % 3], size: 0.12 + Math.random() * 0.06, life: 0.45, drag: 3, grow: -0.1, world: true });
      }
    }
  }), [runtime, pools, quiet]);

  useFrame((_, rawDelta) => {
    if (runtime.phase === "paused") return;
    const dt = Math.min(rawDelta, 1 / 20);
    const { point, offset, quat } = vectors;
    const s = state.current;
    const clock = runtime.clock;
    const hasJet = runtime.modifiers.has("jetpack");
    const shoes = runtime.modifiers.has("gravity-shoes");
    const scale = gl.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    pools.fire.material.uniforms.uScale.value = scale;
    pools.smoke.material.uniforms.uScale.value = scale;

    if (jet.current) {
      const visible = hasJet || runtime.flying;
      // Ранец снят после посадки — облачко дыма на его месте.
      if (s.jetVisible && !visible && !quiet) {
        jet.current.getWorldPosition(point);
        for (let i = 0; i < 12; i += 1) pools.smoke.spawn({ x: point.x + (Math.random() - 0.5) * 0.5, y: point.y + (Math.random() - 0.5) * 0.5, z: point.z + (Math.random() - 0.5) * 0.3,
          vx: (Math.random() - 0.5) * 1.5, vy: 0.4 + Math.random(), vz: (Math.random() - 0.5) * 1.5, color: SMOKE, size: 0.35, life: 0.6, drag: 3, grow: 1.1, world: true, alpha: 0.45 });
      }
      s.jetVisible = visible;
      jet.current.visible = visible;
      const chest = back?.();
      const body = frame?.();
      if (chest && body) {
        body.getWorldQuaternion(quat);
        chest.getWorldPosition(point);
        offset.set(0, backOffset[0], backOffset[1]).applyQuaternion(quat);
        jet.current.position.copy(point).add(offset);
        jet.current.quaternion.copy(quat);
      } else {
        jet.current.position.set(runtime.runnerX, GROUND_Y + runtime.feet + 1.13, 0.43);
        jet.current.rotation.set(0, 0, -Math.max(-0.4, Math.min(0.4, runtime.runnerVX * 0.17)));
      }
      // Тяга: рывок на взлёте, ровное пламя в полёте, ослабление на посадке.
      const launch = Math.max(0, 1 - (clock - runtime.flightAt) / 0.8);
      const landing = hasJet ? 1 : Math.max(0.25, 1 - (clock - runtime.landingAt) / 0.85);
      const thrust = (1 + launch * 0.9) * landing;
      flames.current.forEach((flame, i) => {
        if (!flame) return;
        const flicker = quiet ? 1 : 0.86 + Math.sin(clock * 53 + i * 1.7) * 0.1 + Math.sin(clock * 97 + i) * 0.06;
        flame.scale.set(1 + launch * 0.3, thrust * flicker, 1 + launch * 0.3);
        const core = cores.current[i];
        if (core) core.scale.set(1, thrust * (quiet ? 1 : 0.9 + Math.sin(clock * 71 + i * 2.3) * 0.1), 1);
        halos.current[i]?.scale.setScalar(0.62 * Math.min(1.5, thrust) * flicker);
      });
      if (visible && !quiet && runtime.speed > 0.5) {
        s.emberDebt += dt * 70 * thrust;
        s.smokeDebt += dt * 26 * thrust;
        jet.current.updateWorldMatrix(true, true);
        while (s.emberDebt >= 1) {
          s.emberDebt -= 1;
          const nozzle = nozzles.current[Math.random() < 0.5 ? 0 : 1];
          if (!nozzle) continue;
          nozzle.getWorldPosition(point);
          pools.fire.spawn({ x: point.x + (Math.random() - 0.5) * 0.08, y: point.y, z: point.z, vx: (Math.random() - 0.5) * 0.8, vy: -4 - Math.random() * 3 * thrust, vz: 0.6 + Math.random(),
            color: FIRE[Math.floor(Math.random() * 3)], size: 0.1 + Math.random() * 0.08, life: 0.22 + Math.random() * 0.14, drag: 2, grow: -0.2, world: true });
        }
        while (s.smokeDebt >= 1) {
          s.smokeDebt -= 1;
          const nozzle = nozzles.current[Math.random() < 0.5 ? 0 : 1];
          if (!nozzle) continue;
          nozzle.getWorldPosition(point);
          pools.smoke.spawn({ x: point.x, y: point.y - 0.35, z: point.z + 0.1, vx: (Math.random() - 0.5) * 0.9, vy: -2.4 - Math.random() * 1.5, vz: 0.4 + Math.random() * 0.6,
            color: SMOKE, size: 0.3 + Math.random() * 0.12, life: 0.8, drag: 2.6, grow: 1.35, world: true, alpha: 0.45 });
        }
      }
    }

    const anchors = feet?.();
    const glow = 0.75 + Math.sin(clock * 9) * 0.25;
    soles.current.forEach((sole, i) => {
      if (!sole) return;
      sole.visible = shoes;
      if (anchors?.[i]) {
        anchors[i]!.getWorldPosition(point);
        sole.position.copy(point);
        sole.position.y -= 0.09;
        anchors[i]!.getWorldQuaternion(sole.quaternion);
      } else sole.position.set(runtime.runnerX + (i ? 0.16 : -0.16), GROUND_Y + runtime.feet + 0.08, -0.03);
      soleMaterials.current[i]?.color.copy(SOLE).multiplyScalar(quiet ? 1.4 : 1 + glow * 1.2);
    });
    // След из-под подошв всё время суперпрыжка: дуга сальто читается и сзади.
    if (shoes && runtime.airborne && runtime.superJump && !quiet) {
      s.trailDebt += dt * 90;
      while (s.trailDebt >= 1) {
        s.trailDebt -= 1;
        const sole = soles.current[Math.random() < 0.5 ? 0 : 1];
        if (!sole) continue;
        pools.fire.spawn({ x: sole.position.x + (Math.random() - 0.5) * 0.12, y: sole.position.y, z: sole.position.z + (Math.random() - 0.5) * 0.12,
          vx: (Math.random() - 0.5) * 0.4, vy: -0.3 + Math.random() * 0.5, vz: 0.2, color: GREEN[Math.floor(Math.random() * 3)],
          size: 0.11 + Math.random() * 0.07, life: 0.45, drag: 1.5, grow: -0.18, world: true });
      }
    } else s.trailDebt = 0;
    pools.fire.update(dt, runtime.speed);
    pools.smoke.update(dt, runtime.speed);

    if (marker.current) {
      marker.current.visible = runtime.airborne && !["intro", "finished", "gameover"].includes(runtime.phase);
      // Высокая камера уводит наземную метку за нижнюю кромку экрана.
      // Поднимаем её вслед за ступнями: выбранный трек виден весь полёт.
      marker.current.position.set(laneX(runtime.targetLane, runtime.lanes), GROUND_Y + Math.max(0.035, runtime.feet - 0.3), -1.1);
    }
    if (pulse.current) {
      const age = clock - runtime.jumpClock;
      pulse.current.visible = runtime.superJump && age >= 0 && age < 0.6 && !quiet;
      pulse.current.position.set(runtime.runnerX, GROUND_Y + runtime.support() + 0.04, 0);
      pulse.current.scale.setScalar(0.5 + age * 4.5);
      (pulse.current.material as MeshBasicMaterial).opacity = Math.max(0, 0.85 - age * 1.45);
    }
    if (landRing.current) {
      const age = clock - s.superLand;
      landRing.current.visible = age >= 0 && age < 0.45 && !quiet;
      landRing.current.position.set(runtime.runnerX, GROUND_Y + runtime.support() + 0.04, 0);
      landRing.current.scale.setScalar(0.6 + age * 5);
      (landRing.current.material as MeshBasicMaterial).opacity = Math.max(0, 0.7 - age * 1.6);
    }
  });

  return <>
    <primitive object={pools.smoke.points} />
    <primitive object={pools.fire.points} />
    <group ref={jet} visible={false} name="modifier-jetpack">
      {/* Корпус, крышка, лямки и индикатор заряда */}
      <mesh><boxGeometry args={[0.46, 0.5, 0.24]} /><meshStandardMaterial color="#2c4a66" metalness={0.6} roughness={0.35} /></mesh>
      <mesh position={[0, 0.27, 0]}><boxGeometry args={[0.5, 0.06, 0.28]} /><meshStandardMaterial color="#e94f37" metalness={0.3} roughness={0.4} /></mesh>
      <mesh position={[0, 0.05, 0.13]}><boxGeometry args={[0.24, 0.07, 0.02]} /><meshBasicMaterial color="#ffcb72" toneMapped={false} /></mesh>
      {[-1, 1].map((side) => <mesh key={side} position={[side * 0.13, 0.05, -0.15]}><boxGeometry args={[0.06, 0.46, 0.04]} /><meshStandardMaterial color="#1d2a3a" roughness={0.7} /></mesh>)}
      {[-1, 1].map((side, i) => <group key={side} position={[side * 0.27, -0.02, 0.02]}>
        <mesh><capsuleGeometry args={[0.12, 0.36, 4, 12]} /><meshStandardMaterial color="#e5edf3" metalness={0.55} roughness={0.25} /></mesh>
        <mesh position-y={0.14}><cylinderGeometry args={[0.125, 0.125, 0.05, 12]} /><meshStandardMaterial color="#e94f37" roughness={0.4} /></mesh>
        <mesh position-y={-0.3}><cylinderGeometry args={[0.09, 0.14, 0.14, 12]} /><meshStandardMaterial color="#37465b" metalness={0.75} roughness={0.3} /></mesh>
        <object3D ref={(node) => { nozzles.current[i] = node; }} position-y={-0.42} />
        {/* Факел: вершина конуса у сопла, растёт вниз */}
        <group position-y={-0.37}>
          <group ref={(node) => { flames.current[i] = node; }}>
            <mesh position-y={-0.42} rotation-z={Math.PI}><coneGeometry args={[0.15, 0.84, 10, 1, true]} /><meshBasicMaterial color={FIRE[0]} transparent opacity={0.8} blending={AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>
          </group>
          <group ref={(node) => { cores.current[i] = node; }}>
            <mesh position-y={-0.22} rotation-z={Math.PI}><coneGeometry args={[0.08, 0.44, 8]} /><meshBasicMaterial color={hdr("#fff6d0", 2.4)} toneMapped={false} /></mesh>
          </group>
          <sprite ref={(node) => { halos.current[i] = node; }} position-y={-0.12}>
            <spriteMaterial map={softDotTexture()} color={hdr("#ffb347", 2.2)} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
          </sprite>
        </group>
      </group>)}
    </group>
    {[0, 1].map((i) => <group key={i} ref={(node) => { soles.current[i] = node; }} visible={false} name="modifier-gravity-sole">
      <mesh scale={[0.18, 0.055, 0.35]}><boxGeometry /><meshBasicMaterial ref={(node) => { soleMaterials.current[i] = node; }} color={SOLE} toneMapped={false} /></mesh>
      {!quiet && <mesh scale={[0.25, 0.09, 0.42]}><boxGeometry /><meshBasicMaterial color="#a1f56b" transparent opacity={0.22} depthWrite={false} blending={AdditiveBlending} /></mesh>}
    </group>)}
    <group ref={marker} visible={false} name="flight-lane-marker">
      <mesh rotation-x={-Math.PI / 2}><ringGeometry args={[0.52, 0.61, 28]} /><meshBasicMaterial color="#ffffff" transparent opacity={0.85} depthWrite={false} /></mesh>
      <mesh position={[0, 0.01, -0.68]} rotation-x={-Math.PI / 2} rotation-z={Math.PI}><circleGeometry args={[0.2, 3]} /><meshBasicMaterial color="#ffbd63" depthWrite={false} /></mesh>
    </group>
    <mesh ref={pulse} rotation-x={-Math.PI / 2} visible={false}><ringGeometry args={[0.45, 0.62, 32]} /><meshBasicMaterial color={hdr("#a1f56b", 1.8)} transparent depthWrite={false} toneMapped={false} blending={AdditiveBlending} /></mesh>
    <mesh ref={landRing} rotation-x={-Math.PI / 2} visible={false}><ringGeometry args={[0.5, 0.6, 32]} /><meshBasicMaterial color={hdr("#a1f56b", 1.6)} transparent depthWrite={false} toneMapped={false} blending={AdditiveBlending} /></mesh>
  </>;
}
