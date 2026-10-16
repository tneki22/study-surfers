import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { ExtrudeGeometry, type Group, Shape as PathShape } from "three";
import { LANE_WIDTH } from "../../constants";
import { createRng } from "../../engine/random";
import { useRuntime } from "../context";
import { toShape } from "../kit/batch";
import { NIGHT, NightBuilder, TRAIN_OFFSET, type NightMaterials } from "./kit";
import { NightMesh } from "./NightMesh";

const CAR = 10;
const CARS = 3;
const LIVERIES = [{ stripe: NIGHT.magenta, roof: NIGHT.cyan, body: "#c9d4de" }, { stripe: NIGHT.amber, roof: NIGHT.violet, body: "#aab8c6" }];

/** Сечение вагона: плоское днище, скруглённая крыша. Длина 1 по z — масштабируется. */
function bodySection() {
  const w = 1.36, h = 2.9, top = 0.95, bottom = 0.32;
  const shape = new PathShape();
  shape.moveTo(-w + bottom, 0);
  shape.lineTo(w - bottom, 0);
  shape.quadraticCurveTo(w, 0, w, bottom);
  shape.lineTo(w, h - top);
  shape.quadraticCurveTo(w, h, w - top, h);
  shape.lineTo(-w + top, h);
  shape.quadraticCurveTo(-w, h, -w, h - top);
  shape.lineTo(-w, bottom);
  shape.quadraticCurveTo(-w, 0, -w + bottom, 0);
  const geometry = new ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 6 }).translate(0, 0, -0.5);
  const result = toShape(geometry);
  geometry.dispose();
  return result;
}

/** Состав идёт навстречу: нос к +z. Обе головы обтекаемые — поезд двусторонний. */
function trainGeometry(livery: (typeof LIVERIES)[number], seed: number) {
  const b = new NightBuilder();
  const rng = createRng(seed);
  const section = bodySection();
  const y0 = 0.45;
  for (let car = 0; car < CARS; car++) {
    const z = -car * (CAR + 0.6);
    b.shape("solid", section, [0, y0, z], [1, 1, CAR], livery.body);
    b.rounded("metal", [0, y0 - 0.05, z], [2.3, 0.3, CAR - 0.4], NIGHT.dark);
    for (const side of [-1, 1]) {
      // Лента окон: тёмное стекло, тёплый свет салона, силуэты пассажиров.
      b.box("glass", [side * 1.37, y0 + 1.95, z], [0.03, 0.82, CAR - 1.2], "#0e1a24");
      for (let w = -CAR / 2 + 1.1; w < CAR / 2 - 0.8; w += 1.25) {
        if (rng() < 0.82) b.box("glow", [side * 1.385, y0 + 1.95, z + w], [0.01, 0.62, 1.0], rng() < 0.75 ? "#9c7044" : "#5f8296");
        if (rng() < 0.4) {
          const pz = z + w + (rng() - 0.5) * 0.4;
          b.bead("solid", [side * 1.393, y0 + 1.86, pz], [0.015, 0.1, 0.085], "#141820");
          b.box("solid", [side * 1.393, y0 + 1.7, pz], [0.012, 0.12, 0.3], "#141820");
        }
      }
      b.box("glow", [side * 1.375, y0 + 1.05, z], [0.02, 0.09, CAR - 0.4], livery.stripe);
      b.box("glow", [side * 1.1, y0 + 2.72, z], [0.02, 0.05, CAR - 1], livery.roof);
      // Двери и юбка с подсветкой магнитного подвеса.
      for (const d of [-CAR / 4, CAR / 4]) {
        b.box("metal", [side * 1.375, y0 + 1.5, z + d - 0.7], [0.02, 2.1, 0.04], "#5a6878");
        b.box("metal", [side * 1.375, y0 + 1.5, z + d + 0.7], [0.02, 2.1, 0.04], "#5a6878");
      }
      b.rounded("metal", [side * 0.95, y0 - 0.2, z], [0.45, 0.35, CAR - 0.8], "#232c38");
      b.box("glow", [side * 0.95, y0 - 0.39, z], [0.3, 0.03, CAR - 1.2], NIGHT.violet);
    }
    for (let k = -1; k <= 1; k++) b.soft("metal", [0, y0 + 2.95, z + k * 3], [1.2, 0.25, 1.6], "#5a6878");
    if (car < CARS - 1) b.rounded("solid", [0, y0 + 1.45, z - CAR / 2 - 0.3], [2.2, 2.4, 0.9], "#202832");
  }
  // Головы: вытянутая «пуля», стекло кабины, полосы фар.
  for (const end of [1, -1]) {
    const z = end > 0 ? CAR / 2 : -(CARS - 1) * (CAR + 0.6) - CAR / 2;
    b.sphere("solid", [0, y0 + 1.42, z], [1.36, 1.44, 3.6], livery.body, [0, 0, 0]);
    b.sphere("glass", [0, y0 + 1.95, z + end * 1.15], [1.08, 0.82, 2.2], "#0c1a26");
    b.rounded("metal", [0, y0 + 0.2, z + end * 0.9], [2.2, 0.4, 3.2], NIGHT.dark);
    for (const side of [-1, 1]) b.box("glow", [side * 0.78, y0 + 0.95, z + end * 2.95], [0.62, 0.1, 0.12], end > 0 ? "#f2f9ff" : "#ff3a4a", [0, side * end * 0.5, 0]);
    b.box("glow", [0, y0 + 0.55, z + end * 3.35], [0.9, 0.05, 0.08], livery.stripe);
  }
  return b.build();
}

export function Maglevs({ materials, shadows, onPass }: { materials: NightMaterials; shadows: boolean; onPass?: (side: -1 | 1) => void }) {
  const runtime = useRuntime();
  const geometries = useMemo(() => LIVERIES.map((livery, i) => trainGeometry(livery, 50 + i)), []);
  const groups = useRef<(Group | null)[]>([]);
  const travel = useRef([-100, -205]);
  const played = useRef([false, false]);
  useEffect(() => () => geometries.forEach(geometry => geometry.forEach(g => g.dispose())), [geometries]);
  useFrame((_, delta) => {
    const moving = runtime.phase === "running" || runtime.phase === "finishing";
    groups.current.forEach((group, i) => {
      if (!group) return;
      if (moving) travel.current[i] += (runtime.speed + (i ? 7 : 13)) * Math.min(delta, 0.05);
      if (travel.current[i] > 65 + CARS * CAR) {
        const safe = !runtime.gate || runtime.gate.distance - runtime.distance > runtime.answerZone;
        if (safe) { travel.current[i] = -240 - i * 55; played.current[i] = false; }
      }
      group.position.set((i ? 1 : -1) * (runtime.lanes * LANE_WIDTH / 2 + TRAIN_OFFSET), 0, travel.current[i]);
      group.visible = travel.current[i] < 60 + CARS * CAR;
      if (!played.current[i] && travel.current[i] > -9 && moving) { onPass?.(i ? 1 : -1); played.current[i] = true; }
    });
  });
  return <>{geometries.map((geometry, i) => <group key={i} ref={node => { groups.current[i] = node; }}>
    <NightMesh geometry={geometry} materials={materials} receiveShadow={shadows} />
  </group>)}</>;
}
