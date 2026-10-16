import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { type BufferGeometry, Group, Mesh } from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { GROUND_Y, LANE_WIDTH } from "../constants";
import { createRng } from "../engine/random";
import { useRuntime } from "./context";
import { TrainGraffiti } from "./Graffiti";
import { Batch, SHAPES, toShape, type Channel } from "./kit/batch";
import { CHANNEL_MATERIALS } from "./materials";

const CAR_LENGTH = 11;
const CAR_GAP = 0.7;
const CARS = 4;
const TRAIN_LENGTH = CARS * CAR_LENGTH + (CARS - 1) * CAR_GAP;
const SIDE_TRACK = 3.8;

const LIVERIES = [
  { body: "#eef1f5", stripe: "#e63946", roof: "#c9ced6" },
  { body: "#ffd23f", stripe: "#1d3557", roof: "#d9b232" },
  { body: "#3a86ff", stripe: "#ffffff", roof: "#2f6fd6" },
  { body: "#2ec4b6", stripe: "#ff9f1c", roof: "#25a195" },
];

const carBody = toShape(new RoundedBoxGeometry(2.8, 3.0, CAR_LENGTH, 3, 0.32));

/** Поезд из нескольких вагонов: кузов со скруглениями, окна, двери, полоса, крыша, тележки; кабина смотрит на +z. */
function buildTrain(livery: (typeof LIVERIES)[number]): Map<Channel, BufferGeometry> {
  const batch = new Batch();
  const box = (channel: Channel, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string, rotation?: number | [number, number, number]) =>
    batch.add(channel, SHAPES.box, [x, y, z], [sx, sy, sz], { color, ground: false, rotation });
  const base = 0.95;
  for (let car = 0; car < CARS; car += 1) {
    const zc = TRAIN_LENGTH / 2 - CAR_LENGTH / 2 - car * (CAR_LENGTH + CAR_GAP);
    batch.add("solid", carBody, [0, base + 1.5, zc], [1, 1, 1], { color: livery.body, ground: false, shade: 0.18 });
    box("solid", 0, base + 0.75, zc, 2.83, 0.32, CAR_LENGTH - 0.5, livery.stripe);
    box("solid", 0, base + 3.08, zc, 2.0, 0.22, CAR_LENGTH - 1.4, livery.roof);
    box("solid", 0, base + 3.25, zc - 2.5, 1.2, 0.3, 1.8, "#aab1bb");
    box("solid", 0, base + 3.25, zc + 2.5, 1.2, 0.3, 1.8, "#aab1bb");
    for (const side of [-1, 1]) {
      const x = side * 1.41;
      for (const dz of [-3.7, -2.0, 2.0, 3.7]) box("glass", x, base + 1.95, zc + dz, 0.04, 0.95, 1.3, "#5f84a8");
      for (const dz of [-0.75, 0.75]) {
        box("glass", x, base + 1.55, zc + dz * 1.1, 0.04, 2.05, 0.68, "#3e5d80");
        box("solid", x + side * 0.01, base + 1.55, zc + dz * 1.1, 0.02, 2.12, 0.05, "#9aa3ad");
      }
    }
    box("solid", 0, base - 0.25, zc, 2.3, 0.5, CAR_LENGTH - 1.2, "#2a2f38");
    for (const bogie of [-3.6, 3.6]) {
      box("metal", 0, 0.62, zc + bogie, 2.0, 0.35, 2.3, "#3a3f48");
      for (const dz of [-0.75, 0.75]) {
        for (const side of [-1, 1]) {
          batch.add("metal", SHAPES.cylinder, [side * 0.62, 0.48, zc + bogie + dz], [0.62, 0.12, 0.62], {
            color: "#4b515b", ground: false, rotation: [0, 0, Math.PI / 2],
          });
        }
      }
    }
    if (car < CARS - 1) box("solid", 0, base + 1.4, zc - CAR_LENGTH / 2 - CAR_GAP / 2, 1.6, 2.2, CAR_GAP + 0.1, "#3a3f48");
  }
  // Кабина: лобовое стекло, фары и номер маршрута.
  const front = TRAIN_LENGTH / 2;
  box("glass", 0, base + 2.0, front + 0.01, 2.1, 1.05, 0.06, "#2c4a6b");
  box("solid", 0, base + 2.7, front + 0.02, 1.2, 0.3, 0.05, "#1d2230");
  box("glow", 0, base + 2.7, front + 0.05, 0.7, 0.16, 0.02, "#ffcf6b");
  for (const side of [-1, 1]) box("glow", side * 0.92, base + 0.95, front + 0.02, 0.32, 0.18, 0.04, "#fff4d6");
  for (const side of [-1, 1]) box("glow", side * 0.92, base + 0.95, -front - 0.02, 0.3, 0.16, 0.04, "#ff4040");
  return batch.build();
}

interface TrainState {
  group: Group;
  side: -1 | 1;
  /** Положение центра поезда по z. */
  z: number;
  /** Собственная скорость к камере, м/с; 0 — стоит на запасном пути. */
  velocity: number;
  passed: boolean;
}

/**
 * Поезда на запасных путях: одни стоят, другие едут навстречу. Уехавший за
 * камеру поезд появляется снова далеко впереди с новой раскраской.
 */
export function Trains({ shadows, onPass }: { shadows: boolean; onPass?: (side: -1 | 1) => void }) {
  const runtime = useRuntime();
  const root = useRef<Group>(null);
  const H = (runtime.lanes * LANE_WIDTH) / 2;
  const liveries = useMemo(() => LIVERIES.map(buildTrain), []);
  const rng = useMemo(() => createRng(77), []);

  const trains = useMemo<TrainState[]>(() => {
    const make = (side: -1 | 1, z: number, velocity: number, livery: number): TrainState => {
      const group = new Group();
      for (const [channel, geometry] of liveries[livery]) {
        const mesh = new Mesh(geometry, CHANNEL_MATERIALS[channel]);
        mesh.castShadow = shadows && channel !== "glow" && channel !== "glass";
        mesh.receiveShadow = shadows && channel !== "glow";
        group.add(mesh);
      }
      group.position.set(side * (H + SIDE_TRACK), GROUND_Y - 0.02, z);
      return { group, side, z, velocity, passed: false };
    };
    return [make(-1, -42, 0, 0), make(1, -210, 11, 2), make(-1, -330, 9, 1)];
  }, [liveries, H, shadows]);

  useEffect(() => {
    const parent = root.current;
    trains.forEach((train) => parent?.add(train.group));
    return () => trains.forEach((train) => parent?.remove(train.group));
  }, [trains]);

  useEffect(() => () => liveries.forEach((geometries) => geometries.forEach((g) => g.dispose())), [liveries]);

  useFrame((_, rawDelta) => {
    if (runtime.phase === "paused") return;
    const dt = Math.min(rawDelta, 1 / 20);
    for (const train of trains) {
      train.z += (runtime.speed + train.velocity) * dt;
      if (!train.passed && train.velocity > 0 && train.z + TRAIN_LENGTH / 2 > -6) {
        train.passed = true;
        onPass?.(train.side);
      }
      if (train.z - TRAIN_LENGTH / 2 > 30) {
        // Новый поезд далеко впереди, не наезжая на соседа по тому же пути.
        const side: -1 | 1 = rng() < 0.5 ? -1 : 1;
        let z = -(230 + rng() * 140);
        for (const other of trains) {
          if (other !== train && other.side === side && Math.abs(other.z - z) < TRAIN_LENGTH + 20) z = other.z - TRAIN_LENGTH - 30;
        }
        train.side = side;
        train.z = z;
        train.velocity = rng() < 0.45 ? 0 : 8 + rng() * 8;
        train.passed = false;
        const livery = liveries[Math.floor(rng() * liveries.length)];
        train.group.children.forEach((child, index) => {
          const geometry = [...livery.values()][index];
          if (geometry) (child as Mesh).geometry = geometry;
        });
        train.group.position.x = side * (H + SIDE_TRACK);
      }
      train.group.position.z = train.z;
    }
  });

  return <><group ref={root} /><TrainGraffiti groups={trains.map(train => train.group)} /></>;
}
