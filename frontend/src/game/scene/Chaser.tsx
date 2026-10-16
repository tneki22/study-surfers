import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Color, type Group, MeshBasicMaterial, MeshStandardMaterial } from "three";
import { GROUND_Y } from "../constants";
import { CHASE_SECONDS } from "../engine/impact";
import { useRuntime } from "./context";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Где держится преследователь: позади бегуна и чуть сбоку, чтобы не закрывать его от камеры. */
const BEHIND = 2.6;
const SIDE = 0.95;
const AWAY = 9;

/**
 * «На хвосте» после столкновения: в городе за бегуном бежит контролёр со свистком,
 * ночью — патрульный дрон с мигалкой. Он догоняет за долю секунды, держится
 * CHASE_SECONDS и отстаёт, когда погоня кончилась.
 */
export function Chaser({ night, reducedMotion }: { night: boolean; reducedMotion: boolean }) {
  const runtime = useRuntime();
  const root = useRef<Group>(null);
  const legs = useRef<(Group | null)[]>([]);
  const arms = useRef<(Group | null)[]>([]);
  const materials = useMemo(() => ({
    uniform: new MeshStandardMaterial({ color: "#23395d", roughness: 0.7 }),
    trousers: new MeshStandardMaterial({ color: "#1a2235", roughness: 0.8 }),
    skin: new MeshStandardMaterial({ color: "#f0c6a0", roughness: 0.7 }),
    cap: new MeshStandardMaterial({ color: "#152238", roughness: 0.5 }),
    badge: new MeshStandardMaterial({ color: "#ffd166", metalness: 0.8, roughness: 0.3 }),
    vest: new MeshStandardMaterial({ color: "#ff8a1f", roughness: 0.6, emissive: "#ff6a00", emissiveIntensity: 0.25 }),
    drone: new MeshStandardMaterial({ color: "#2f3d4c", roughness: 0.4, metalness: 0.6 }),
    pale: new MeshStandardMaterial({ color: "#c4d2dc", roughness: 0.5 }),
    red: new MeshBasicMaterial({ color: new Color(3, 0.3, 0.4), toneMapped: false }),
    blue: new MeshBasicMaterial({ color: new Color(0.3, 0.7, 3), toneMapped: false }),
  }), []);
  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials]);

  useFrame(() => {
    const group = root.current;
    if (!group) return;
    const since = runtime.clock - runtime.bumpClock;
    const left = runtime.chase();
    const active = left > 0 && runtime.phase !== "gameover";
    // Догоняет за 0,35 с, последние 0,6 с отстаёт.
    const come = clamp01(since / 0.35);
    const go = active ? clamp01((left * CHASE_SECONDS) / 0.6) : 0;
    const near = Math.min(come, go);
    group.visible = active && near > 0.01;
    if (!group.visible) return;
    const side = runtime.runnerX > 0 ? -1 : 1;
    const z = BEHIND + (AWAY - BEHIND) * (1 - near);
    const bob = reducedMotion ? 0 : Math.sin(runtime.clock * 9) * 0.06;
    if (night) {
      // Дрон держится выше и сбоку от байка, чуть позади: не закрывает ни байк, ни дорожку впереди.
      group.position.set(runtime.runnerX + side * SIDE * 2, GROUND_Y + 3.3 + bob, 0.6 + (AWAY - 0.6) * (1 - near));
      group.scale.setScalar(0.6);
      group.rotation.set(0.15, 0, reducedMotion ? 0 : Math.sin(runtime.clock * 3) * 0.08);
      const flash = reducedMotion || Math.sin(runtime.clock * 14) > 0;
      materials.red.color.setRGB(flash ? 3 : 0.4, 0.3, 0.4);
      materials.blue.color.setRGB(0.3, 0.7, flash ? 0.6 : 3);
      return;
    }
    group.position.set(runtime.runnerX + side * SIDE, GROUND_Y + Math.abs(bob), z);
    group.rotation.set(-0.12, 0, 0);
    const swing = reducedMotion ? 0 : Math.sin(runtime.stride * Math.PI * 2) * 0.8;
    legs.current.forEach((leg, i) => leg && (leg.rotation.x = i ? swing : -swing));
    // Правая рука со свистком поднята, левая машет на бегу.
    if (arms.current[0]) arms.current[0].rotation.x = swing * 0.7;
    if (arms.current[1]) arms.current[1].rotation.x = -2.4 + (reducedMotion ? 0 : Math.sin(runtime.clock * 6) * 0.15);
  });

  if (night) {
    return (
      <group ref={root} visible={false}>
        <mesh material={materials.drone} castShadow>
          <boxGeometry args={[0.9, 0.22, 0.7]} />
        </mesh>
        <mesh material={materials.pale} position={[0, -0.14, -0.2]}>
          <sphereGeometry args={[0.16, 12, 8]} />
        </mesh>
        {[[-0.6, -0.45], [0.6, -0.45], [-0.6, 0.45], [0.6, 0.45]].map(([x, z]) => (
          <group key={`${x}:${z}`} position={[x, 0.02, z]}>
            <mesh material={materials.drone}>
              <cylinderGeometry args={[0.32, 0.32, 0.04, 16]} />
            </mesh>
          </group>
        ))}
        <mesh position={[-0.2, 0.17, 0]} material={materials.red}>
          <boxGeometry args={[0.3, 0.1, 0.2]} />
        </mesh>
        <mesh position={[0.2, 0.17, 0]} material={materials.blue}>
          <boxGeometry args={[0.3, 0.1, 0.2]} />
        </mesh>
      </group>
    );
  }

  return (
    <group ref={root} visible={false}>
      {[-1, 1].map((side, i) => (
        <group key={side} ref={(g) => { legs.current[i] = g; }} position={[side * 0.13, 0.92, 0]}>
          <mesh material={materials.trousers} position-y={-0.45} castShadow>
            <boxGeometry args={[0.17, 0.9, 0.2]} />
          </mesh>
        </group>
      ))}
      <mesh material={materials.uniform} position-y={1.25} castShadow>
        <boxGeometry args={[0.5, 0.65, 0.3]} />
      </mesh>
      <mesh material={materials.vest} position={[0, 1.2, 0.01]}>
        <boxGeometry args={[0.52, 0.32, 0.31]} />
      </mesh>
      <mesh material={materials.badge} position={[0.12, 1.42, -0.16]}>
        <boxGeometry args={[0.08, 0.08, 0.02]} />
      </mesh>
      {[-1, 1].map((side, i) => (
        <group key={side} ref={(g) => { arms.current[i] = g; }} position={[side * 0.32, 1.52, 0]}>
          <mesh material={materials.uniform} position-y={-0.3} castShadow>
            <boxGeometry args={[0.13, 0.6, 0.15]} />
          </mesh>
        </group>
      ))}
      <mesh material={materials.skin} position-y={1.75} castShadow>
        <sphereGeometry args={[0.17, 14, 10]} />
      </mesh>
      <mesh material={materials.cap} position={[0, 1.9, -0.03]}>
        <cylinderGeometry args={[0.19, 0.19, 0.1, 16]} />
      </mesh>
      <mesh material={materials.cap} position={[0, 1.86, -0.18]}>
        <boxGeometry args={[0.26, 0.03, 0.14]} />
      </mesh>
      <mesh material={materials.badge} position={[0, 1.92, -0.2]}>
        <boxGeometry args={[0.07, 0.05, 0.02]} />
      </mesh>
    </group>
  );
}
