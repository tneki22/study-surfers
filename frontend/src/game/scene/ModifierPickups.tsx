import { useFrame } from "@react-three/fiber";
import { useEffect, useReducer, useRef } from "react";
import { AdditiveBlending, type Group, type Mesh, type MeshBasicMaterial } from "three";
import { GROUND_Y, laneX } from "../constants";
import { MODIFIER_INFO, type ModifierKind, type ModifierPickup } from "../engine/modifiers";
import { useRuntime } from "./context";

/** Силуэты предметов читаются по форме и на низкой графике без bloom. */
function Glyph({ kind, color }: { kind: ModifierKind; color: string }) {
  const glow = <meshBasicMaterial color={color} toneMapped={false} />;
  if (kind === "jetpack") return <>
    {[-1, 1].map(side => <group key={side} position-x={side * 0.19}>
      <mesh><capsuleGeometry args={[0.12, 0.3, 3, 8]} />{glow}</mesh>
      <mesh position-y={-0.4} rotation-z={Math.PI}><coneGeometry args={[0.09, 0.25, 6]} /><meshBasicMaterial color="#fff4c0" /></mesh>
    </group>)}
    <mesh><boxGeometry args={[0.3, 0.12, 0.12]} />{glow}</mesh>
  </>;
  if (kind === "gravity-shoes") return <>{[-1, 1].map(side => <mesh key={side} position={[side * 0.19, side * 0.1, 0]} rotation-z={-0.2}><boxGeometry args={[0.21, 0.18, 0.48]} />{glow}</mesh>)}</>;
  if (kind === "magnet") return <group rotation-z={Math.PI}>
    <mesh><torusGeometry args={[0.29, 0.09, 6, 16, Math.PI]} />{glow}</mesh>
    {[-1, 1].map(side => <mesh key={side} position={[side * 0.29, -0.13, 0]}><boxGeometry args={[0.18, 0.26, 0.18]} /><meshBasicMaterial color="#fff8dd" /></mesh>)}
  </group>;
  if (kind === "phase") return <><mesh><octahedronGeometry args={[0.34]} />{glow}</mesh><mesh rotation-y={0.5}><torusGeometry args={[0.46, 0.025, 5, 20]} />{glow}</mesh></>;
  return <group><mesh scale={[0.8, 1, 0.3]}><icosahedronGeometry args={[0.45, 0]} /><meshBasicMaterial color={color} wireframe /></mesh><mesh><boxGeometry args={[0.07, 0.38, 0.07]} />{glow}</mesh><mesh><boxGeometry args={[0.27, 0.07, 0.07]} />{glow}</mesh></group>;
}

function Pickup({ pickup, quiet }: { pickup: ModifierPickup; quiet: boolean }) {
  const runtime = useRuntime();
  const root = useRef<Group>(null);
  const icon = useRef<Group>(null);
  const burst = useRef<Mesh>(null);
  const base = useRef<Group>(null);
  const color = MODIFIER_INFO[pickup.kind].color;
  useFrame(() => {
    if (!root.current || !icon.current) return;
    const z = runtime.distance - pickup.distance;
    const age = runtime.clock - pickup.takenClock;
    root.current.visible = z > -180 && z < 12 && (!pickup.resolved || pickup.taken && age < 0.5);
    // Подобранный предмет взмывает и тает; кольцо вспышкой расходится по треку.
    const collect = pickup.taken ? Math.max(0, 1 - age / 0.4) : 1;
    root.current.position.set(pickup.taken ? runtime.runnerX : laneX(pickup.lane, runtime.lanes), GROUND_Y, pickup.taken ? 0 : z);
    icon.current.scale.setScalar(pickup.taken ? collect * (1 + age * 2) : 1);
    icon.current.position.y = 1.35 + (quiet ? 0 : Math.sin(runtime.clock * 3 + pickup.id) * 0.1) + (pickup.taken ? age * 2.5 : 0);
    icon.current.rotation.y = quiet ? 0 : runtime.clock * 1.4 + (pickup.taken ? age * 18 : 0);
    if (base.current) base.current.visible = !pickup.taken;
    if (burst.current) {
      burst.current.visible = pickup.taken && age < 0.5;
      burst.current.scale.setScalar(1 + age * 7);
      (burst.current.material as MeshBasicMaterial).opacity = Math.max(0, 0.9 - age * 1.9);
    }
  });
  return <group ref={root} name={`modifier-pickup-${pickup.kind}`}>
    <group ref={base}>
    <mesh rotation-x={-Math.PI / 2} position-y={0.03}><ringGeometry args={[0.44, 0.53, 24]} /><meshBasicMaterial color={color} toneMapped={false} /></mesh>
    <mesh position-y={1.9}><cylinderGeometry args={[0.025, 0.025, 3.8, 5]} /><meshBasicMaterial color={color} transparent opacity={0.55} depthWrite={false} /></mesh>
    {!quiet && <mesh position-y={1.9}><cylinderGeometry args={[0.1, 0.3, 3.8, 8, 1, true]} /><meshBasicMaterial color={color} transparent opacity={0.1} depthWrite={false} blending={AdditiveBlending} /></mesh>}
    </group>
    <mesh ref={burst} rotation-x={-Math.PI / 2} position-y={0.05} visible={false}><ringGeometry args={[0.4, 0.5, 32]} /><meshBasicMaterial color={color} transparent depthWrite={false} blending={AdditiveBlending} toneMapped={false} /></mesh>
    <group ref={icon} position-y={1.35}>
      <mesh><torusGeometry args={[0.62, 0.035, 6, 24]} /><meshBasicMaterial color={color} /></mesh>
      <Glyph kind={pickup.kind} color={color} />
    </group>
  </group>;
}

export function ModifierPickups({ quiet }: { quiet: boolean }) {
  const runtime = useRuntime();
  const [, refresh] = useReducer(n => n + 1, 0);
  useEffect(() => runtime.on(event => { if (event.type === "course" || event.type === "question") refresh(); }), [runtime]);
  return <>{runtime.pickups.map(pickup => <Pickup key={pickup.id} pickup={pickup} quiet={quiet} />)}</>;
}
