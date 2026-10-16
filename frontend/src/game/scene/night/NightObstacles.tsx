import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useReducer, useRef } from "react";
import { type Group, type InstancedMesh, Object3D, Vector3 } from "three";
import { GROUND_Y, laneX } from "../../constants";
import { ARM_BOTTOM, BOT_TOP, NIGHT_TRIALS, SHUTTLE_LENGTH, SHUTTLE_TOP, SHUTTLE_TRIGGER, WALL_TOP } from "../../engine/night-obstacles";
import type { NightObstacle } from "../../runtime";
import { useRuntime } from "../context";
import { NIGHT, NightBuilder, nightMaterials, type NightMaterials } from "./kit";
import { NightMesh } from "./NightMesh";

/** Энергия: над роботами и дорожки за кольцами. */
const MAX_COINS = 64;

function robotGeometry(overhead: boolean) {
  const b = new NightBuilder();
  // Корпус высокого робота стоит сбоку: сниженный байк проходит только под консолью.
  const x = overhead ? -1.32 : 0;
  const height = overhead ? 0.9 : BOT_TOP;
  b.rounded("solid", [x, height * 0.55, -0.8], [0.7, height * 0.65, 0.85], "#87979c");
  b.rounded("metal", [x, 0.12, -0.8], [0.9, 0.24, 0.95], NIGHT.dark);
  b.rounded("solid", [x, height - 0.08, -0.6], [0.48, 0.16, 0.38], NIGHT.pale);
  b.box("glass", [x, height - 0.05, -0.39], [0.39, 0.1, 0.02], "#173c42");
  b.box("glow", [x, height - 0.05, -0.37], [0.18, 0.025, 0.02], NIGHT.amber);
  for (const side of [-1, 1]) {
    b.rounded("metal", [x + side * 0.41, 0.12, -0.8], [0.17, 0.24, 1.05], "#42565f");
    for (let z = -1.25; z < -0.2; z += 0.2) b.box("solid", [x + side * 0.43, 0.25, z], [0.16, 0.03, 0.04], "#61767e");
    b.rounded("solid", [x + side * 0.26, height * 0.5, -0.1], [0.15, 0.16, 0.65], "#607980");
  }
  if (overhead) {
    b.rounded("metal", [-1.17, ARM_BOTTOM / 2, -0.7], [0.16, ARM_BOTTOM, 0.2], NIGHT.metal);
    b.rounded("solid", [-0.1, ARM_BOTTOM + 0.15, -0.7], [2.3, 0.3, 0.45], "#667d85");
    b.box("glow", [0, ARM_BOTTOM + 0.02, -0.44], [1.65, 0.03, 0.02], NIGHT.amber);
    for (let i = 0; i < 7; i++) b.box("metal", [-0.75 + i * 0.25, ARM_BOTTOM + 0.17, -0.46], [0.1, 0.23, 0.02], NIGHT.dark, [0, 0, -0.3]);
  }
  // Проекция занятого места и предупреждение видны независимо от bloom.
  b.box("glow", [0, 0.014, -0.8], [1.82, 0.018, 0.035], NIGHT.amber);
  for (const side of [-1, 1]) b.box("glow", [side * 0.91, 0.014, -0.8], [0.035, 0.018, 1.6], NIGHT.amber);
  return b.build();
}

function zoneGeometry() {
  const b = new NightBuilder();
  b.box("solid", [0, 0.018, -2.1], [1.85, 0.025, 4.2], "#532c2e");
  for (const side of [-1, 1]) b.box("glow", [side * 0.91, 0.04, -2.1], [0.04, 0.02, 4.2], NIGHT.red);
  for (let z = -0.6; z > -4.2; z -= 0.85) {
    b.box("glow", [-0.05, 0.045, z - 0.17], [0.64, 0.012, 0.09], NIGHT.red, [0, -0.6, 0]);
    b.box("glow", [-0.05, 0.045, z + 0.17], [0.64, 0.012, 0.09], NIGHT.red, [0, 0.6, 0]);
    b.box("metal", [-0.7, 0.042, z], [0.12, 0.012, 0.35], "#a96560", [0, 0.4, 0]);
  }
  return b.build();
}

/**
 * Сервисный челнок: низкая парящая капсула нос к байку. Высота — SHUTTLE_TOP, выше
 * любого прыжка, так что силуэт сразу говорит «объезжай». Фары и полосы на полотне
 * показывают его дорожку издалека.
 */
function shuttleGeometry() {
  const b = new NightBuilder();
  const mid = -SHUTTLE_LENGTH / 2;
  b.soft("solid", [0, 1.05, mid], [1.66, 1.5, SHUTTLE_LENGTH], "#d9e2e8");
  b.soft("metal", [0, 0.36, mid], [1.78, 0.26, SHUTTLE_LENGTH + 0.1], NIGHT.dark);
  b.box("glass", [0, 1.38, -0.1], [1.36, 0.5, 0.06], "#173c42");
  b.box("glass", [0, 1.62, mid - 0.2], [1.3, 0.04, 1.7], "#1c4148");
  // Красно-белые шевроны на носу и янтарная полоса по борту.
  for (let i = 0; i < 4; i++) b.box(i % 2 ? "solid" : "glow", [-0.6 + i * 0.4, 0.72, 0.005], [0.36, 0.22, 0.03], i % 2 ? "#f2f4f6" : NIGHT.red, [0, 0, 0.5]);
  for (const side of [-1, 1]) {
    b.box("glow", [side * 0.84, 0.95, mid], [0.02, 0.06, SHUTTLE_LENGTH - 0.4], NIGHT.amber);
    b.box("glow", [side * 0.56, 0.98, 0.01], [0.32, 0.12, 0.03], "#fff6dd");
    b.box("glow", [side * 0.62, 0.62, -SHUTTLE_LENGTH - 0.01], [0.24, 0.1, 0.03], NIGHT.red);
  }
  b.box("metal", [0, SHUTTLE_TOP - 0.04, mid - 0.6], [0.5, 0.1, 0.3], NIGHT.metal);
  // Парящая юбка и лужа света под ней.
  b.box("glow", [0, 0.2, mid], [1.5, 0.02, SHUTTLE_LENGTH - 0.6], NIGHT.cyan);
  return b.build();
}

/** Лазерная растяжка: два излучателя по краям дорожки; луч — отдельно, чтобы мерцать им. */
function laserGeometry(height: number) {
  const b = new NightBuilder();
  for (const side of [-1, 1]) {
    b.rounded("metal", [side * 0.95, (height + 0.25) / 2, -0.3], [0.16, height + 0.25, 0.16], NIGHT.metal);
    b.box("glow", [side * 0.95, height, -0.21], [0.14, 0.14, 0.02], NIGHT.red);
    b.box("glow", [side * 0.95, height + 0.25, -0.3], [0.18, 0.03, 0.18], NIGHT.red);
    b.box("metal", [side * 0.95, 0.03, -0.3], [0.34, 0.06, 0.34], NIGHT.dark);
  }
  // Проекция на полотне: где луч пересекает дорожку.
  b.box("glow", [0, 0.014, -0.3], [1.8, 0.012, 0.04], NIGHT.red);
  return b.build();
}

function laserBeam(height: number) {
  const b = new NightBuilder();
  b.box("glow", [0, height, -0.3], [1.78, 0.07, 0.07], NIGHT.red);
  b.box("glow", [0, height, -0.3], [1.78, 0.02, 0.16], "#ffb0b6");
  return b.build();
}

/** Кабель ремонтников: толстый провод на катушках поперёк дорожки, провис — ниже верха робота. */
function cableGeometry() {
  const b = new NightBuilder();
  for (const side of [-1, 1]) {
    b.cylinder("solid", [side * 0.9, BOT_TOP / 2, -0.6], [0.26, BOT_TOP, 0.26], "#f2b33d");
    b.cylinder("metal", [side * 0.9, BOT_TOP / 2, -0.6], [0.5, 0.08, 0.5], NIGHT.dark, [0, 0, 0]);
    b.cylinder("metal", [side * 0.9, BOT_TOP, -0.6], [0.5, 0.06, 0.5], NIGHT.dark);
    b.box("glow", [side * 0.9, BOT_TOP + 0.08, -0.6], [0.08, 0.08, 0.08], NIGHT.amber);
  }
  const points: [number, number, number][] = [];
  for (let i = 0; i <= 8; i++) {
    const x = -0.9 + (i / 8) * 1.8;
    points.push([x, BOT_TOP - 0.1 - 0.18 * (1 - (x / 0.9) ** 2), -0.6]);
  }
  // Кабель в жёлто-чёрную полоску: заметен на тёмном полотне.
  for (let i = 0; i < 8; i++) b.bone(i % 2 ? "solid" : "glow", points[i], points[i + 1], 0.07, i % 2 ? "#1d2026" : NIGHT.amber);
  b.box("glow", [0, 0.014, -0.6], [1.82, 0.018, 0.035], NIGHT.amber);
  return b.build();
}

/** Грузовой дрон с ящиком: низ ящика — ARM_BOTTOM, пройти — снижением. Тень — отдельно. */
function droneGeometry() {
  const b = new NightBuilder();
  b.rounded("solid", [0, ARM_BOTTOM + 0.3, -0.8], [1.5, 0.6, 1.1], "#b5793d");
  b.box("metal", [0, ARM_BOTTOM + 0.3, -0.24], [1.52, 0.08, 0.02], NIGHT.dark);
  b.rounded("metal", [0, ARM_BOTTOM + 0.75, -0.8], [0.9, 0.22, 0.7], NIGHT.metal);
  for (const [x, z] of [[-0.75, -0.35], [0.75, -0.35], [-0.75, -1.25], [0.75, -1.25]]) {
    b.beam("metal", [0, ARM_BOTTOM + 0.78, -0.8], [x, ARM_BOTTOM + 0.82, z], 0.06, NIGHT.metal);
    b.cylinder("glass", [x, ARM_BOTTOM + 0.86, z], [0.6, 0.02, 0.6], "#2a3a44");
  }
  b.box("glow", [0, ARM_BOTTOM + 0.02, -0.25], [1.4, 0.03, 0.02], NIGHT.amber);
  b.box("glow", [0, ARM_BOTTOM + 0.9, -0.42], [0.2, 0.06, 0.04], NIGHT.red);
  return b.build();
}

function droneShadow() {
  const b = new NightBuilder();
  b.cylinder("solid", [0, 0.012, -0.8], [1.7, 0.01, 1.3], "#07090d");
  b.cylinder("glow", [0, 0.008, -0.8], [1.9, 0.008, 1.5], NIGHT.red, undefined, true);
  return b.build();
}

/** Энергобарьер: стена полос на всю высоту между пилонами — только объезд. */
function wallGeometry() {
  const b = new NightBuilder();
  for (const side of [-1, 1]) {
    b.rounded("metal", [side * 0.95, WALL_TOP / 2, -0.3], [0.18, WALL_TOP, 0.3], NIGHT.metal);
    b.box("glow", [side * 0.86, WALL_TOP / 2, -0.3], [0.03, WALL_TOP - 0.1, 0.12], NIGHT.magenta);
  }
  for (let y = 0.15; y < WALL_TOP; y += 0.22) b.box("glow", [0, y, -0.3], [1.72, 0.05, 0.03], NIGHT.magenta);
  b.box("glow", [0, 0.014, -0.3], [1.85, 0.018, 0.5], NIGHT.magenta);
  return b.build();
}

/** Ускорительное кольцо: награда за чистую серию, пролететь сквозь — разгон. */
function ringGeometry() {
  const b = new NightBuilder();
  const segments = 20;
  const points: [number, number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push([Math.cos(a) * 1.05, 1.3 + Math.sin(a) * 1.05, -0.4]);
  }
  for (let i = 0; i < segments; i++) b.bone("glow", points[i], points[i + 1], 0.07, NIGHT.cyan);
  for (const side of [-1, 1]) b.box("metal", [side * 1.05, 0.14, -0.4], [0.12, 0.28, 0.2], NIGHT.metal);
  for (let i = 0; i < 4; i++) b.box("glow", [0, 0.014, -1.5 - i * 1.6], [0.9 - i * 0.15, 0.012, 0.3], NIGHT.cyan, [0, 0, 0]);
  return b.build();
}

/** Маячок на крыше и полосы дорожки впереди — отдельно, чтобы мигать ими без пересборки. */
function beaconGeometry() {
  const b = new NightBuilder();
  b.box("glow", [0, SHUTTLE_TOP + 0.05, -SHUTTLE_LENGTH / 2 - 0.6], [0.36, 0.12, 0.2], NIGHT.amber);
  for (let i = 0; i < 6; i++) b.box("glow", [0, 0.02, 1.2 + i * 2.2], [1.1 - i * 0.12, 0.012, 0.32], NIGHT.amber, [0, 0, 0]);
  return b.build();
}

type Geometry = ReturnType<typeof robotGeometry>;

/** Облик ряда: ключ — вид и вариант (см. NIGHT_LOOKS). */
const lookKey = (row: NightObstacle) => (row.kind === "repair-bot" || row.kind === "repair-arm" ? `${row.kind}:${row.variant}` : row.kind);

function Row({ row, materials, geometry, extra, tool, beacon, reducedMotion, shadows }: { row: NightObstacle; materials: NightMaterials; geometry: Geometry; extra: Geometry | null; tool: Geometry; beacon: Geometry; reducedMotion: boolean; shadows: boolean }) {
  const runtime = useRuntime();
  const group = useRef<Group>(null);
  const arm = useRef<Group>(null);
  const light = useRef<Group>(null);
  const part = useRef<Group>(null);
  const shade = useRef<Group>(null);
  const look = lookKey(row);
  const laser = look === "repair-bot:1" || look === "repair-arm:1";
  const drone = look === "repair-arm:2";
  const flicker = laser && NIGHT_TRIALS.has(row.pattern);
  useFrame(() => {
    if (!group.current) return;
    const z = runtime.distance - row.distance;
    group.current.position.set(laneX(row.lane, runtime.lanes), GROUND_Y, z);
    group.current.visible = z < row.length + 12 && z > -190;
    if (row.kind === "magnetic-zone") group.current.scale.x = row.direction;
    if (arm.current && !reducedMotion) arm.current.rotation.x = Math.sin(runtime.clock * 2 + row.id) * 0.15;
    if (light.current) {
      // Стоит — мигает редко, тронулся — часто; после встречи полосы впереди гаснут.
      const moving = row.distance - runtime.distance < SHUTTLE_TRIGGER;
      light.current.visible = !row.resolved && (reducedMotion || Math.sin(runtime.clock * (moving ? 16 : 5) + row.id) > -0.2);
      if (!reducedMotion && moving) group.current.position.y += Math.sin(runtime.clock * 9 + row.id) * 0.03;
    }
    if (part.current) {
      // Луч на испытаниях мерцает толщиной (сам луч не пропадает: проверка — по высоте).
      if (laser) part.current.scale.set(1, flicker && !reducedMotion ? 0.6 + Math.abs(Math.sin(runtime.clock * 23 + row.id)) * 0.9 : 1, 1);
      // Грузовой дрон опускается к своей высоте за 20 м до байка; тень растёт и темнеет.
      if (drone) {
        const ahead = row.distance - runtime.distance;
        const lift = Math.min(1, Math.max(0, (ahead - 20) / 60)) * 9;
        part.current.position.y = lift;
        if (shade.current) shade.current.scale.setScalar(Math.max(0.35, 1 - lift / 12));
      }
      if (row.kind === "boost-ring" && !reducedMotion) part.current.rotation.z = runtime.clock * 0.8;
    }
    const since = runtime.clock - row.resolvedClock;
    if (row.neutralized) {
      const t = Math.min(1, since / (reducedMotion ? 0.18 : 0.45));
      if (laser) {
        if (part.current) part.current.visible = false;
      } else if (row.kind === "magnetic-zone" || row.kind === "energy-wall") {
        group.current.visible = false;
      } else {
        // Управляемый отход за пределы треков, без разлетающейся физики.
        const side = row.lane < runtime.lanes / 2 ? -1 : 1;
        group.current.position.x += side * t * (runtime.lanes * 2.6 + 3);
        if (!reducedMotion) group.current.rotation.y = side * t * 0.35;
        if (t >= 1) group.current.visible = false;
      }
    }
    if (row.kind === "boost-ring" && row.resolved) group.current.scale.setScalar(1 + Math.min(1, since / 0.3) * 0.4);
    if (row.hit && row.kind !== "magnetic-zone" && !laser) group.current.rotation.z = Math.sin(Math.min(1, since / 0.45) * Math.PI) * 0.16;
  });
  if (drone || laser || row.kind === "boost-ring") {
    return <group ref={group}>
      {laser && <NightMesh geometry={geometry} materials={materials} shadows={shadows} />}
      {drone && extra && <group ref={shade}><NightMesh geometry={extra} materials={materials} /></group>}
      <group ref={part} position={row.kind === "boost-ring" ? [0, 1.3, -0.4] : undefined}>
        <group position={row.kind === "boost-ring" ? [0, -1.3, 0.4] : undefined}>
          <NightMesh geometry={laser && extra ? extra : geometry} materials={materials} shadows={shadows && drone} />
        </group>
      </group>
    </group>;
  }
  return <group ref={group}>
    <NightMesh geometry={geometry} materials={materials} shadows={shadows} />
    {row.kind === "shuttle" && <group ref={light}><NightMesh geometry={beacon} materials={materials} /></group>}
    {(look === "repair-bot:0" || look === "repair-arm:0") && <group ref={arm} position={[row.kind === "repair-arm" ? -1.32 : 0, 0.35, -0.2]}><NightMesh geometry={tool} materials={materials} /></group>}
  </group>;
}

export function NightObstacles({ reducedMotion, quiet, shadows }: { reducedMotion: boolean; quiet: boolean; shadows: boolean }) {
  const runtime = useRuntime();
  const [, refresh] = useReducer(n => n + 1, 0);
  const materials = useMemo(nightMaterials, []);
  const geometry = useMemo<Record<string, Geometry>>(() => ({
    "repair-bot:0": robotGeometry(false), "repair-bot:1": laserGeometry(BOT_TOP - 0.12), "repair-bot:2": cableGeometry(),
    "repair-arm:0": robotGeometry(true), "repair-arm:1": laserGeometry(ARM_BOTTOM + 0.05), "repair-arm:2": droneGeometry(),
    "magnetic-zone": zoneGeometry(), shuttle: shuttleGeometry(), "energy-wall": wallGeometry(), "boost-ring": ringGeometry(),
  }), []);
  const extras = useMemo<Record<string, Geometry>>(() => ({
    "repair-bot:1": laserBeam(BOT_TOP - 0.12), "repair-arm:1": laserBeam(ARM_BOTTOM + 0.05), "repair-arm:2": droneShadow(),
  }), []);
  const beacon = useMemo(beaconGeometry, []);
  const tool = useMemo(() => {
    const b = new NightBuilder();
    b.rounded("metal", [0, 0, 0], [0.12, 0.12, 0.5], NIGHT.metal);
    b.rounded("solid", [0, -0.08, 0.25], [0.18, 0.18, 0.13], NIGHT.pale);
    b.box("glow", [0, -0.19, 0.26], [0.06, 0.07, 0.06], NIGHT.cyan);
    return b.build();
  }, []);
  const coins = useRef<InstancedMesh>(null);
  const pulls = useRef<InstancedMesh>(null);
  const sparks = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const pullVectors = useMemo(() => ({ direction: new Vector3(), up: new Vector3(0, 1, 0) }), []);
  useEffect(() => runtime.on(event => { if (event.type === "course" || event.type === "question" || event.type === "phase") refresh(); }), [runtime]);
  useEffect(() => () => { Object.values(geometry).forEach(v => v.forEach(g => g.dispose())); Object.values(extras).forEach(v => v.forEach(g => g.dispose())); tool.forEach(g => g.dispose()); beacon.forEach(g => g.dispose()); Object.values(materials).forEach(m => m.dispose()); }, [geometry, extras, tool, beacon, materials]);
  useFrame(() => {
    if (coins.current) {
      for (let i = 0; i < MAX_COINS; i++) {
        const coin = runtime.coins[i];
        const pull = coin?.attracted && coin.taken ? Math.min(1, (runtime.clock - coin.takenClock) / (reducedMotion ? 0.1 : 0.32)) : 1;
        const attracting = Boolean(coin?.attracted && coin.taken && pull < 1);
        const visible = coin && ((!coin.resolved && coin.distance - runtime.distance < 180) || attracting);
        dummy.scale.setScalar(visible ? 0.18 : 0);
        if (coin) {
          const eased = 1 - (1 - pull) ** 2;
          dummy.position.set(
            laneX(coin.lane, runtime.lanes) + (runtime.runnerX - laneX(coin.lane, runtime.lanes)) * (attracting ? eased : 0),
            GROUND_Y + coin.height + (runtime.feet + 1 - coin.height) * (attracting ? eased : 0),
            attracting ? (runtime.distance - coin.distance) * (1 - eased) : runtime.distance - coin.distance);
          if (attracting) dummy.scale.setScalar(0.18 * (1 - pull * 0.7));
        }
        dummy.rotation.set(0, runtime.clock * (reducedMotion ? 0 : 2), Math.PI / 4); dummy.updateMatrix(); coins.current.setMatrixAt(i, dummy.matrix);
        if (pulls.current) {
          if (attracting && coin && !quiet) {
            const { direction, up } = pullVectors;
            direction.set(laneX(coin.lane, runtime.lanes) - runtime.runnerX, coin.height - runtime.feet - 1, runtime.distance - coin.distance).normalize();
            const length = 0.9 * (1 - pull);
            dummy.position.addScaledVector(direction, length / 2);
            dummy.quaternion.setFromUnitVectors(up, direction);
            dummy.scale.set(0.018 * (1 - pull), length, 0.018 * (1 - pull));
          } else dummy.scale.setScalar(0);
          dummy.updateMatrix(); pulls.current.setMatrixAt(i, dummy.matrix);
        }
      }
      coins.current.instanceMatrix.needsUpdate = true;
      if (pulls.current) pulls.current.instanceMatrix.needsUpdate = true;
    }
    if (sparks.current) {
      const near = runtime.nightObstacles.find(row => !row.neutralized && (row.kind === "repair-bot" || row.kind === "repair-arm") && Math.abs(row.distance - runtime.distance) < 30);
      for (let i = 0; i < 12; i++) {
        const age = (runtime.clock * 1.8 + i * 0.07) % 1;
        dummy.scale.setScalar(near && !quiet ? 0.02 * (1 - age) : 0);
        if (near) dummy.position.set(laneX(near.lane, runtime.lanes) + Math.sin(i * 8) * age * 0.6, GROUND_Y + 0.5 + age * 0.6 - age * age, runtime.distance - near.distance + Math.cos(i * 9) * age);
        dummy.updateMatrix(); sparks.current.setMatrixAt(i, dummy.matrix);
      }
      sparks.current.instanceMatrix.needsUpdate = true;
    }
  });
  return <>
    {runtime.nightObstacles.map(row => <Row key={row.id} row={row} geometry={geometry[lookKey(row)] ?? geometry[row.kind]} extra={extras[lookKey(row)] ?? null} tool={tool} beacon={beacon} materials={materials} reducedMotion={reducedMotion} shadows={shadows} />)}
    <instancedMesh ref={coins} args={[undefined, undefined, MAX_COINS]} frustumCulled={false}><octahedronGeometry /><meshBasicMaterial color={NIGHT.amber} toneMapped={false} /></instancedMesh>
    {!quiet && <instancedMesh ref={pulls} args={[undefined, undefined, MAX_COINS]} frustumCulled={false}><cylinderGeometry args={[1, 1, 1, 4]} /><meshBasicMaterial color="#ffe8a6" transparent opacity={0.55} toneMapped={false} depthWrite={false} /></instancedMesh>}
    <instancedMesh ref={sparks} args={[undefined, undefined, 12]} frustumCulled={false}><boxGeometry /><meshBasicMaterial color="#b9fff2" toneMapped={false} /></instancedMesh>
  </>;
}
