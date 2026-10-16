import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { AdditiveBlending, Color, type InstancedMesh, MeshBasicMaterial, Object3D } from "three";
import { createRng } from "../../engine/random";
import { MAX_SPEED_FACTOR } from "../../engine/speed";
import { useRuntime } from "../context";
import { districtAt } from "./Districts";

const MOTE_COLORS = ["#55d6cc", "#ff4fb4", "#ffb35c", "#8f6bff", "#bfe8ff"];

/**
 * Воздух ночного города: дождь над виадуком, светящаяся пыль у трассы и линии
 * скорости — они проявляются и вытягиваются, когда байк разгоняется.
 */
export function Atmosphere({ tier, reducedMotion }: { tier: "low" | "medium" | "high"; reducedMotion: boolean }) {
  const runtime = useRuntime();
  const rain = useRef<InstancedMesh>(null);
  const motes = useRef<InstancedMesh>(null);
  const streaks = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const rainCount = tier === "high" ? 420 : tier === "medium" ? 220 : 0;
  const moteCount = tier === "low" ? 0 : 70;
  const streakCount = tier === "low" ? 0 : 56;
  const rainMaterial = useMemo(() => new MeshBasicMaterial({ color: "#8fb4d8", transparent: true, opacity: 0.32, depthWrite: false, blending: AdditiveBlending }), []);
  const moteMaterial = useMemo(() => new MeshBasicMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false }), []);
  const streakMaterial = useMemo(() => new MeshBasicMaterial({ color: new Color(1.4, 1.9, 2.0), transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending, toneMapped: false }), []);
  const seeds = useMemo(() => {
    const rng = createRng(7);
    return {
      motes: Array.from({ length: moteCount }, () => ({ x: (rng() < 0.5 ? -1 : 1) * (3 + rng() * 12), y: 0.4 + rng() * 6, z: rng() * 60, phase: rng() * 6.28, size: 0.02 + rng() * 0.035 })),
      streaks: Array.from({ length: streakCount }, () => {
        const side = rng() < 0.5 ? -1 : 1;
        const high = rng() < 0.35;
        return { x: high ? (rng() - 0.5) * 18 : side * (4.8 + rng() * 9), y: high ? 6.5 + rng() * 5 : 0.6 + rng() * 5.5, z: rng() * 140 };
      }),
    };
  }, [moteCount, streakCount]);
  useEffect(() => {
    const color = new Color();
    seeds.motes.forEach((_, i) => motes.current?.setColorAt(i, color.set(MOTE_COLORS[i % MOTE_COLORS.length]).multiplyScalar(2.2)));
    if (motes.current?.instanceColor) motes.current.instanceColor.needsUpdate = true;
  }, [seeds]);
  useEffect(() => () => { rainMaterial.dispose(); moteMaterial.dispose(); streakMaterial.dispose(); }, [rainMaterial, moteMaterial, streakMaterial]);
  const travel = useRef(0);

  useFrame((_, delta) => {
    const t = runtime.clock;
    const paused = runtime.phase === "paused";
    if (!paused) travel.current += runtime.speed * Math.min(delta, 0.05);
    const boost = Math.max(0, Math.min(1, (runtime.speedFactor - 1) / (MAX_SPEED_FACTOR - 1)));
    const moving = runtime.speed > 1 && !reducedMotion;
    if (rain.current) {
      const visible = !reducedMotion && districtAt(runtime.distance - 10) === "viaduct";
      rain.current.visible = visible;
      if (visible) {
        for (let i = 0; i < rainCount; i++) {
          const fall = (t * 16 + i * 0.73) % 14;
          dummy.position.set(Math.sin(i * 54.2) * 15, 13 - fall, 6 - ((i * 1.83 + travel.current) % 52));
          dummy.rotation.set(0.32, 0, 0.08);
          dummy.scale.set(0.012, 0.7, 0.012);
          dummy.updateMatrix();
          rain.current.setMatrixAt(i, dummy.matrix);
        }
        rain.current.instanceMatrix.needsUpdate = true;
      }
    }
    if (motes.current) {
      motes.current.visible = !reducedMotion;
      seeds.motes.forEach((m, i) => {
        const z = 8 - ((m.z + travel.current * 0.85) % 60);
        dummy.position.set(m.x + Math.sin(t * 0.6 + m.phase) * 0.4, m.y + Math.sin(t * 0.9 + m.phase * 2) * 0.3, z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(m.size, m.size, m.size * (1 + (moving ? runtime.speed * 0.25 : 0)));
        dummy.updateMatrix();
        motes.current!.setMatrixAt(i, dummy.matrix);
      });
      motes.current.instanceMatrix.needsUpdate = true;
    }
    if (streaks.current) {
      streaks.current.visible = moving;
      streakMaterial.opacity = 0.1 + boost * 0.45;
      const length = 1.6 + boost * 7 + runtime.speed * 0.08;
      seeds.streaks.forEach((s, i) => {
        dummy.position.set(s.x, s.y, 10 - ((s.z + travel.current * 1.7) % 140));
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(0.022, 0.022, length);
        dummy.updateMatrix();
        streaks.current!.setMatrixAt(i, dummy.matrix);
      });
      streaks.current.instanceMatrix.needsUpdate = true;
    }
  });

  return <>
    {rainCount > 0 && <instancedMesh ref={rain} args={[undefined, rainMaterial, rainCount]} frustumCulled={false}><boxGeometry /></instancedMesh>}
    {moteCount > 0 && <instancedMesh ref={motes} args={[undefined, moteMaterial, moteCount]} frustumCulled={false}><sphereGeometry args={[1, 6, 4]} /></instancedMesh>}
    {streakCount > 0 && <instancedMesh ref={streaks} args={[undefined, streakMaterial, streakCount]} frustumCulled={false}><boxGeometry /></instancedMesh>}
  </>;
}
