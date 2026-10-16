import { Hud, PerspectiveCamera, RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { Color, DoubleSide, type Group, MeshBasicMaterial, MeshStandardMaterial } from "three";
import { CAMERA } from "../constants";
import { boardElement } from "../hud/QuestionBoard";
import { useHud } from "../store";
import { useRuntime } from "./context";
import { Batch, SHAPES } from "./kit/batch";

/** Глубина, на которой висят дроны в собственной сцене HUD; размеры пересчитываются из пикселей. */
const DEPTH = 6;
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Магнитный подвес: корпус, катушки и свет собраны в три меша. */
function HoverDrone() {
  const geometry = useMemo(() => {
    const b = new Batch();
    b.add("solid", SHAPES.sphere, [0, 0, 0], [0.23, 0.07, 0.17], { color: "#bacbd0", ground: false });
    b.add("metal", SHAPES.dome, [0, 0.06, 0], [0.11, 0.09, 0.1], { color: "#18343e", ground: false });
    for (const side of [-1, 1]) {
      b.add("solid", SHAPES.box, [side * 0.22, 0, 0], [0.2, 0.055, 0.035], { color: "#526d78", ground: false });
      b.add("metal", SHAPES.cylinder, [side * 0.31, 0, 0], [0.19, 0.08, 0.19], { color: "#253f49", ground: false });
      b.add("glow", SHAPES.ring, [side * 0.31, -0.025, 0], [0.17, 0.17, 0.17], { color: "#55d6cc", ground: false, rotation: [Math.PI / 2, 0, 0] });
    }
    b.add("metal", SHAPES.cylinder, [0, -0.09, 0], [0.04, 0.09, 0.04], { color: "#354952", ground: false });
    return b.build();
  }, []);
  const materials = useMemo(() => ({
    solid: new MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.25 }),
    metal: new MeshStandardMaterial({ vertexColors: true, roughness: 0.2, metalness: 0.6 }),
    glow: new MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  }), []);
  useEffect(() => () => { geometry.forEach(g => g.dispose()); Object.values(materials).forEach(m => m.dispose()); }, [geometry, materials]);
  return <>{[...geometry].map(([channel, part]) => <mesh key={channel} geometry={part} material={materials[channel as keyof typeof materials]} dispose={null} />)}</>;
}

/** Квадрокоптер: корпус, четыре луча с винтами, мигалка и подвес троса снизу. */
function Drone({ materials, rotors }: { materials: ReturnType<typeof useDroneMaterials>; rotors: RefObject<Group[]> }) {
  return (
    <>
      <RoundedBox args={[0.34, 0.1, 0.26]} radius={0.04} smoothness={3} material={materials.body} />
      <mesh material={materials.dome} position-y={0.06} scale={[1, 0.55, 1]}>
        <sphereGeometry args={[0.1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
      </mesh>
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], index) => (
        <group key={index}>
          <mesh material={materials.arm} position={[sx * 0.17, 0.01, sz * 0.12]} rotation-y={Math.atan2(sz * 0.12, sx * 0.17) * -1}>
            <boxGeometry args={[0.22, 0.03, 0.035]} />
          </mesh>
          <group position={[sx * 0.27, 0.05, sz * 0.19]}>
            <mesh material={materials.arm}>
              <cylinderGeometry args={[0.025, 0.03, 0.06, 10]} />
            </mesh>
            <group ref={(node) => { if (node && rotors.current) rotors.current[index] = node; }} position-y={0.04}>
              <mesh material={materials.blur} rotation-x={-Math.PI / 2}>
                <circleGeometry args={[0.13, 24]} />
              </mesh>
              <mesh material={materials.blade}>
                <boxGeometry args={[0.25, 0.006, 0.025]} />
              </mesh>
            </group>
          </group>
        </group>
      ))}
      <mesh material={materials.led} position={[0, -0.02, -0.135]}>
        <sphereGeometry args={[0.022, 8, 6]} />
      </mesh>
      <mesh material={materials.arm} position-y={-0.08}>
        <cylinderGeometry args={[0.02, 0.035, 0.07, 8]} />
      </mesh>
    </>
  );
}

function useDroneMaterials() {
  const materials = useMemo(() => ({
    body: new MeshStandardMaterial({ color: "#f4f6fa", roughness: 0.35, metalness: 0.1 }),
    dome: new MeshStandardMaterial({ color: "#1d2a44", roughness: 0.1, metalness: 0.6 }),
    arm: new MeshStandardMaterial({ color: "#2a3346", roughness: 0.4, metalness: 0.4 }),
    blade: new MeshBasicMaterial({ color: "#1d2433", transparent: true, opacity: 0.55 }),
    blur: new MeshBasicMaterial({ color: "#c8d4e8", transparent: true, opacity: 0.22, side: DoubleSide, depthWrite: false }),
    led: new MeshBasicMaterial({ color: new Color("#2fd3ff") }),
    cable: new MeshStandardMaterial({ color: "#2a3346", roughness: 0.6 }),
  }), []);
  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials]);
  return materials;
}

function BoardDrones({ reducedMotion }: { reducedMotion: boolean }) {
  const runtime = useRuntime();
  const layout = useHud((state) => state.layout);
  const materials = useDroneMaterials();
  const drones = [useRef<Group>(null), useRef<Group>(null)];
  const cables = [useRef<Group>(null), useRef<Group>(null)];
  const rotors = [useRef<Group[]>([]), useRef<Group[]>([])];
  const lastOffset = useRef(Number.NaN);

  // Перевод экранных пикселей в мировые единицы на глубине DEPTH.
  const frame = useMemo(() => {
    if (!layout) return null;
    const viewHeight = 2 * DEPTH * Math.tan((CAMERA.fov * Math.PI) / 360);
    const unit = viewHeight / layout.height;
    const toX = (px: number) => (px - layout.width / 2) * unit;
    const toY = (px: number) => (layout.height / 2 - px) * unit;
    const rect = layout.billboard;
    const inset = Math.min(90, rect.width * 0.12);
    return {
      unit,
      corners: [toX(rect.left + inset), toX(rect.left + rect.width - inset)],
      top: toY(rect.top),
      hover: 40 * unit,
      travel: (rect.top + rect.height + 120) * unit,
      travelPx: rect.top + rect.height + 120,
    };
  }, [layout]);

  useFrame(() => {
    if (!frame) return;
    if (runtime.night && runtime.phase === "paused") return;
    const phase = runtime.phase;
    let arrive = 1;
    if (phase === "loading") arrive = 0;
    else if (phase === "intro") arrive = smooth(Math.min(1, Math.max(0, (runtime.phaseClock - 0.9) / 1.3)));
    else if (phase === "finished" || phase === "gameover") arrive = 1 - smooth(Math.min(1, runtime.phaseClock / 0.9));
    const clock = runtime.clock;
    const bobPx = reducedMotion ? 0 : Math.sin(clock * 2.1) * 3;
    const offsetPx = -(1 - arrive) * frame.travelPx + bobPx;

    // Табло — DOM-элемент: двигаем его вместе с дронами, без перерисовки React.
    const element = boardElement.current;
    if (element && !(Math.abs(offsetPx - lastOffset.current) <= 0.05)) {
      element.style.transform = `translate3d(0, ${offsetPx.toFixed(2)}px, 0)`;
      lastOffset.current = offsetPx;
    }

    const lift = (1 - arrive) * frame.travel - bobPx * frame.unit;
    drones.forEach((drone, index) => {
      const group = drone.current;
      if (!group) return;
      const sway = reducedMotion ? 0 : Math.sin(clock * 1.7 + index * 2.1);
      group.position.set(frame.corners[index] + sway * 0.03, frame.top + frame.hover + lift + sway * 0.015, 0);
      group.rotation.set(0.35 + sway * 0.05, index ? -0.25 : 0.25, sway * 0.06 + (1 - arrive) * (index ? -0.2 : 0.2));
      group.visible = arrive > 0.001;
      const cable = cables[index].current;
      if (cable) {
        // Трос от подвеса дрона к углу табло.
        const fromY = group.position.y - 0.14;
        const toY = frame.top + lift + 0.02;
        cable.position.set(group.position.x, (fromY + toY) / 2, -0.02);
        cable.scale.set(1, Math.max(0.01, fromY - toY), 1);
        cable.visible = group.visible;
      }
      if (!reducedMotion) for (const rotor of rotors[index].current) if (rotor) rotor.rotation.y += index % 2 ? 0.75 : -0.75;
    });
    materials.led.color.set(runtime.night ? "#55d6cc" : Math.sin(clock * 6) > 0.6 ? "#ff3b5c" : "#2fd3ff");
  });

  return (
    <>
      <PerspectiveCamera makeDefault fov={CAMERA.fov} position={[0, 0, DEPTH]} near={0.1} far={50} />
      <ambientLight intensity={1.3} />
      <directionalLight position={[2, 5, 4]} intensity={2.2} />
      {[0, 1].map((index) => (
        <group key={index}>
          <group ref={drones[index]} visible={false} scale={1.35}>
            {runtime.night ? <HoverDrone /> : <Drone materials={materials} rotors={rotors[index]} />}
          </group>
          <group ref={cables[index]} visible={false}>
            <mesh material={materials.cable}>
              <cylinderGeometry args={[0.008, 0.008, 1, 6]} />
            </mesh>
          </group>
        </group>
      ))}
    </>
  );
}

/**
 * «Дрон-табло»: само табло — DOM-панель из матового стекла (чёткий KaTeX),
 * её на тросах держат два 3D-дрона. Дроны живут в отдельной сцене поверх
 * мира — постобработка и туман их не трогают, проезжающие ворота не режут.
 */
export function Billboard({ renderPriority, reducedMotion = false }: { renderPriority: number; reducedMotion?: boolean }) {
  return (
    <Hud renderPriority={renderPriority}>
      <BoardDrones reducedMotion={reducedMotion} />
    </Hud>
  );
}
