import { RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { type RefObject, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { type BufferGeometry, Color, CylinderGeometry, type Group, type InstancedMesh, MeshBasicMaterial, MeshStandardMaterial, Object3D } from "three";
import { GROUND_Y, laneX } from "../constants";
import { BAR_BOTTOM, DECK_HEIGHT, HANDCAR_LENGTH, HANDCAR_TOP, HANDCAR_TRIGGER, HURDLE_TOP, RAMP_LENGTH, RAMP_TOP, SLOPE_LENGTH, WAGON_GAP, WAGON_LENGTH } from "../engine/obstacles";
import type { ObstacleRow } from "../runtime";
import { useRuntime } from "./context";
import { Batch, SHAPES, type Channel } from "./kit/batch";
import { CHANNEL_MATERIALS } from "./materials";
import { sessionBannerTexture, stripeTexture } from "./textures";

// Размеры — из логики препятствий: что видно, то и проверяется.
const HURDLE = { top: HURDLE_TOP, board: 0.26, half: 0.9 };
const BAR = { bottom: BAR_BOTTOM, beam: 0.42, post: 2.5, half: 1.0 };
const MAX_COINS = 140;
/** Колея: колёса вагонеток стоят на рельсах трека. */
const GAUGE = 1.1;

const WAGON_LIVERIES = [
  { body: "#e63946", trim: "#9d1f2b" },
  { body: "#2b9bf0", trim: "#1a5f99" },
  { body: "#12b886", trim: "#0b7a59" },
  { body: "#ffb703", trim: "#c47f00" },
];

/**
 * Состав вагонеток на одном треке: передний край в z = 0, вагоны уходят в −z.
 * Крыша — настил из досок ровно на высоте DECK_HEIGHT, по нему и бежит бегун.
 */
function buildWagons(cars: number, livery: (typeof WAGON_LIVERIES)[number]): Map<Channel, BufferGeometry> {
  const batch = new Batch();
  const box = (channel: Channel, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string, shade = 0) =>
    batch.add(channel, SHAPES.box, [x, y, z], [sx, sy, sz], { color, ground: false, shade });
  const bodyBottom = 0.5;
  const bodyTop = DECK_HEIGHT - 0.06;
  for (let car = 0; car < cars; car += 1) {
    const front = -car * (WAGON_LENGTH + WAGON_GAP);
    const zc = front - WAGON_LENGTH / 2;
    // Рама, колёса на рельсах, кузов с рёбрами жёсткости.
    box("metal", 0, 0.42, zc, 1.5, 0.2, WAGON_LENGTH - 0.6, "#2c313b");
    for (const axle of [-1, 1]) {
      const z = zc + axle * (WAGON_LENGTH / 2 - 1.3);
      for (const side of [-1, 1]) {
        batch.add("metal", SHAPES.cylinder, [side * (GAUGE / 2), 0.3, z], [0.56, 0.14, 0.56], { color: "#454b56", ground: false, rotation: [0, 0, Math.PI / 2] });
        batch.add("metal", SHAPES.cylinder, [side * (GAUGE / 2 + 0.08), 0.3, z], [0.22, 0.04, 0.22], { color: "#b8bec8", ground: false, rotation: [0, 0, Math.PI / 2] });
      }
      box("metal", 0, 0.3, z, GAUGE + 0.1, 0.07, 0.07, "#20242c");
    }
    box("solid", 0, (bodyBottom + bodyTop) / 2, zc, 2.1, bodyTop - bodyBottom, WAGON_LENGTH, livery.body, 0.28);
    for (let rib = 0; rib <= 6; rib += 1) {
      const z = front - 0.25 - (rib * (WAGON_LENGTH - 0.5)) / 6;
      for (const side of [-1, 1]) box("solid", side * 1.065, (bodyBottom + bodyTop) / 2, z, 0.05, bodyTop - bodyBottom + 0.02, 0.1, livery.trim);
    }
    for (const side of [-1, 1]) box("solid", side * 1.03, bodyTop + 0.02, zc, 0.1, 0.1, WAGON_LENGTH, livery.trim);
    // Настил из досок — та самая «крыша», по которой бегут.
    const planks = Math.round(WAGON_LENGTH / 0.5);
    for (let i = 0; i < planks; i += 1) {
      const z = front - (i + 0.5) * (WAGON_LENGTH / planks);
      box("solid", 0, DECK_HEIGHT - 0.03, z, 1.96, 0.06, WAGON_LENGTH / planks - 0.035, i % 2 ? "#b98a5c" : "#a97b4f");
    }
    if (car < cars - 1) box("metal", 0, 0.62, front - WAGON_LENGTH - WAGON_GAP / 2, 0.32, 0.2, WAGON_GAP + 0.3, "#2c313b");
  }
  // Спереди — полосатый буфер и фары, сзади — красные фонари.
  for (let i = 0; i < 5; i += 1) box("solid", -0.84 + i * 0.42, 0.66, 0.06, 0.42, 0.22, 0.12, i % 2 ? "#1b1f2a" : "#ffc400");
  for (const side of [-1, 1]) {
    box("glow", side * 0.72, 0.88, 0.02, 0.26, 0.12, 0.05, "#fff1c4");
    box("glow", side * 0.72, 0.88, -cars * (WAGON_LENGTH + WAGON_GAP) + WAGON_GAP - 0.02, 0.22, 0.1, 0.05, "#ff3b3b");
  }
  return batch.build();
}

const wagonCache = new Map<string, Map<Channel, BufferGeometry>>();
function wagonGeometry(cars: number, livery: number): Map<Channel, BufferGeometry> {
  const key = `${cars}:${livery}`;
  let geometry = wagonCache.get(key);
  if (!geometry) {
    geometry = buildWagons(cars, WAGON_LIVERIES[livery]);
    wagonCache.set(key, geometry);
  }
  return geometry;
}

function Wagons({ cars, livery }: { cars: number; livery: number }) {
  const geometry = wagonGeometry(cars, livery);
  return (
    <>
      {[...geometry].map(([channel, part]) => (
        <mesh key={channel} geometry={part} material={CHANNEL_MATERIALS[channel]} castShadow={channel !== "glow"} receiveShadow={channel !== "glow"} />
      ))}
    </>
  );
}

function useObstacleMaterials() {
  const materials = useMemo(() => ({
    hurdle: new MeshStandardMaterial({ map: stripeTexture("#e63946", "#ffffff"), roughness: 0.5 }),
    bar: new MeshStandardMaterial({ map: stripeTexture("#ffc400", "#1b1f2a"), roughness: 0.5 }),
    post: new MeshStandardMaterial({ color: "#3a4150", roughness: 0.45, metalness: 0.5 }),
    foot: new MeshStandardMaterial({ color: "#20252f", roughness: 0.7 }),
    light: new MeshBasicMaterial({ color: new Color(3, 1.3, 0.25), toneMapped: false }),
    wood: new MeshStandardMaterial({ color: "#b98250", roughness: 0.8 }),
    woodDark: new MeshStandardMaterial({ color: "#7a5230", roughness: 0.85 }),
    sign: new MeshStandardMaterial({ color: "#1e63d6", roughness: 0.4, metalness: 0.2 }),
    paint: new MeshStandardMaterial({ color: "#f4f6fa", roughness: 0.5 }),
    ramp: new MeshStandardMaterial({ color: "#ff8a1f", roughness: 0.55 }),
    cone: new MeshStandardMaterial({ color: "#ff6a1a", roughness: 0.5 }),
    tape: new MeshStandardMaterial({ map: stripeTexture("#ffd400", "#1b1f2a"), roughness: 0.6 }),
    concrete: new MeshStandardMaterial({ color: "#a9adb3", roughness: 0.95 }),
    chevron: new MeshStandardMaterial({ map: stripeTexture("#ffc400", "#1b1f2a"), roughness: 0.6 }),
    pages: new MeshStandardMaterial({ color: "#f6f0e1", roughness: 0.9 }),
    bookRed: new MeshStandardMaterial({ color: "#c0392b", roughness: 0.6 }),
    bookBlue: new MeshStandardMaterial({ color: "#2457a8", roughness: 0.6 }),
    bookGreen: new MeshStandardMaterial({ color: "#1f8a5b", roughness: 0.6 }),
    gold: new MeshStandardMaterial({ color: "#e8b530", metalness: 0.7, roughness: 0.35 }),
    railArm: new MeshStandardMaterial({ map: stripeTexture("#e63946", "#ffffff"), roughness: 0.45 }),
    red: new MeshBasicMaterial({ color: new Color(3, 0.25, 0.2), toneMapped: false }),
    banner: new MeshStandardMaterial({ map: sessionBannerTexture(), roughness: 0.8 }),
    rope: new MeshStandardMaterial({ color: "#3a2a1c", roughness: 0.9 }),
    pipe: new MeshStandardMaterial({ color: "#c9cfd6", roughness: 0.35, metalness: 0.6 }),
    rust: new MeshStandardMaterial({ color: "#7d4a2a", roughness: 0.85 }),
  }), []);
  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials]);
  return materials;
}

type Materials = ReturnType<typeof useObstacleMaterials>;

/** Ящики вместо барьера: та же высота HURDLE_TOP, прыгать так же. */
function Crates({ materials }: { materials: Materials }) {
  return (
    <>
      {[-0.46, 0.46].map((x) => (
        <group key={x} position-x={x}>
          <mesh material={materials.wood} position-y={HURDLE.top / 2} castShadow receiveShadow>
            <boxGeometry args={[0.86, HURDLE.top, 0.7]} />
          </mesh>
          {[0.06, HURDLE.top - 0.06].map((y) => (
            <mesh key={y} material={materials.woodDark} position={[0, y, 0.36]}>
              <boxGeometry args={[0.88, 0.07, 0.03]} />
            </mesh>
          ))}
          <mesh material={materials.woodDark} position={[0, HURDLE.top / 2, 0.36]} rotation-z={Math.atan2(HURDLE.top - 0.12, 0.8)}>
            <boxGeometry args={[0.92, 0.07, 0.03]} />
          </mesh>
        </group>
      ))}
      <mesh material={materials.light} position={[0.46, HURDLE.top + 0.06, 0]}>
        <sphereGeometry args={[0.06, 10, 8]} />
      </mesh>
    </>
  );
}

/** Дорожный знак на портале вместо балки: низ щита на высоте BAR_BOTTOM, пройти — только подкатом. */
function Sign({ materials }: { materials: Materials }) {
  const panel = 0.8;
  return (
    <>
      {[-1, 1].map((side) => (
        <mesh key={side} material={materials.post} position={[side * BAR.half, BAR.post / 2, 0]} castShadow>
          <boxGeometry args={[0.1, BAR.post, 0.1]} />
        </mesh>
      ))}
      <mesh material={materials.paint} position-y={BAR.bottom + panel / 2} castShadow>
        <boxGeometry args={[BAR.half * 2 + 0.2, panel, 0.08]} />
      </mesh>
      <mesh material={materials.sign} position={[0, BAR.bottom + panel / 2, 0.045]}>
        <boxGeometry args={[BAR.half * 2 + 0.06, panel - 0.12, 0.02]} />
      </mesh>
      {/* Стрелка вниз: «пригнись». */}
      <mesh material={materials.paint} position={[0, BAR.bottom + panel / 2 + 0.08, 0.06]}>
        <boxGeometry args={[0.1, 0.36, 0.02]} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} material={materials.paint} position={[side * 0.08, BAR.bottom + panel / 2 - 0.12, 0.06]} rotation-z={side * 0.8}>
          <boxGeometry args={[0.08, 0.26, 0.02]} />
        </mesh>
      ))}
      <mesh material={materials.light} position={[0, BAR.bottom + panel + 0.06, 0]}>
        <sphereGeometry args={[0.07, 10, 8]} />
      </mesh>
    </>
  );
}

/**
 * Подъём от шпал до `top` на длине `length`: трамплин (с края бегуна бросает высоко
 * вверх) или пандус, по которому въезжают на крыши вагонеток.
 */
function Ramp({ materials, top = RAMP_TOP, length = RAMP_LENGTH }: { materials: Materials; top?: number; length?: number }) {
  const RAMP_TOP = top;
  const RAMP_LENGTH = length;
  const RAMP_SLOPE = Math.atan2(top, length);
  const RAMP_BOARD = Math.hypot(top, length);
  return (
    <>
      <mesh material={materials.ramp} position={[0, RAMP_TOP / 2, -RAMP_LENGTH / 2]} rotation-x={RAMP_SLOPE} castShadow receiveShadow>
        <boxGeometry args={[1.9, 0.08, RAMP_BOARD]} />
      </mesh>
      {[0.2, 0.4, 0.6, 0.8].map((t) => (
        <group key={t} position={[0, RAMP_TOP * t + 0.05, -RAMP_LENGTH * t]} rotation-x={RAMP_SLOPE}>
          {[-1, 1].map((side) => (
            <mesh key={side} material={materials.paint} position-x={side * 0.22} rotation-y={side * 0.7}>
              <boxGeometry args={[0.1, 0.02, 0.6]} />
            </mesh>
          ))}
        </group>
      ))}
      {[-1, 1].map((side) => (
        <mesh key={side} material={materials.post} position={[side * 0.98, RAMP_TOP / 2 - 0.04, -RAMP_LENGTH / 2]} rotation-x={RAMP_SLOPE}>
          <boxGeometry args={[0.08, 0.14, RAMP_BOARD]} />
        </mesh>
      ))}
      <mesh material={materials.post} position={[0, RAMP_TOP / 2, -RAMP_LENGTH + 0.05]}>
        <boxGeometry args={[1.9, RAMP_TOP, 0.1]} />
      </mesh>
      <mesh material={materials.light} position={[0, RAMP_TOP + 0.08, -RAMP_LENGTH + 0.05]}>
        <boxGeometry args={[1.6, 0.05, 0.05]} />
      </mesh>
    </>
  );
}

/** Конусы с натянутой лентой: верх конусов и лента — на высоте барьера. */
function Cones({ materials }: { materials: Materials }) {
  return (
    <>
      {[-0.82, 0, 0.82].map((x) => (
        <group key={x} position-x={x}>
          <mesh material={materials.cone} position-y={HURDLE.top / 2} castShadow>
            <coneGeometry args={[0.2, HURDLE.top, 16]} />
          </mesh>
          <mesh material={materials.paint} position-y={HURDLE.top * 0.55}>
            <cylinderGeometry args={[0.11, 0.13, 0.08, 16]} />
          </mesh>
          <mesh material={materials.foot} position-y={0.02}>
            <boxGeometry args={[0.46, 0.04, 0.46]} />
          </mesh>
        </group>
      ))}
      <mesh material={materials.tape} position-y={HURDLE.top - 0.06}>
        <boxGeometry args={[1.7, 0.08, 0.01]} />
      </mesh>
    </>
  );
}

/** Бетонный блок с полосатой шевронной лентой: прыгать. */
function Block({ materials }: { materials: Materials }) {
  return (
    <>
      <RoundedBox args={[1.86, HURDLE.top, 0.6]} radius={0.04} smoothness={2} position-y={HURDLE.top / 2} material={materials.concrete} castShadow receiveShadow />
      <mesh material={materials.chevron} position={[0, HURDLE.top * 0.62, 0.305]}>
        <boxGeometry args={[1.7, 0.12, 0.01]} />
      </mesh>
      <mesh material={materials.light} position={[0.8, HURDLE.top + 0.05, 0]}>
        <sphereGeometry args={[0.06, 10, 8]} />
      </mesh>
    </>
  );
}

/** Стопка гигантских учебников: три тома вразнобой, верх — на высоте барьера. */
function Books({ materials }: { materials: Materials }) {
  const books = [
    { cover: materials.bookBlue, y: 0, h: 0.18, turn: 0.04, shift: 0.02 },
    { cover: materials.bookRed, y: 0.18, h: 0.17, turn: -0.07, shift: -0.06 },
    { cover: materials.bookGreen, y: 0.35, h: HURDLE.top - 0.35, turn: 0.1, shift: 0.05 },
  ];
  return (
    <>
      {books.map((book, i) => (
        <group key={i} position={[book.shift, book.y + book.h / 2, 0]} rotation-y={book.turn}>
          <mesh material={book.cover} castShadow receiveShadow>
            <boxGeometry args={[1.8, book.h, 0.8]} />
          </mesh>
          <mesh material={materials.pages} position={[0.03, 0, 0.02]}>
            <boxGeometry args={[1.78, book.h - 0.04, 0.8]} />
          </mesh>
          <mesh material={materials.gold} position={[-0.6, 0, 0.41]}>
            <boxGeometry args={[0.36, book.h * 0.35, 0.01]} />
          </mesh>
        </group>
      ))}
    </>
  );
}

/**
 * Железнодорожный шлагбаум с мигалками: поднят, пока бегун далеко, и опускается при
 * подходе — низ стрелы ложится ровно на BAR_BOTTOM. Угол задаёт Row по дистанции.
 */
function RailGate({ materials, arm }: { materials: Materials; arm: RefObject<Group | null> }) {
  const pivot = BAR.bottom + 0.09;
  return (
    <>
      <mesh material={materials.post} position={[-BAR.half - 0.1, BAR.post / 2, 0]} castShadow>
        <boxGeometry args={[0.16, BAR.post, 0.16]} />
      </mesh>
      <mesh material={materials.post} position={[-BAR.half - 0.1, pivot, 0.12]}>
        <boxGeometry args={[0.34, 0.34, 0.12]} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} material={materials.red} position={[-BAR.half - 0.1 + side * 0.17, BAR.post - 0.25, 0.1]}>
          <sphereGeometry args={[0.09, 12, 8]} />
        </mesh>
      ))}
      <mesh material={materials.paint} position={[-BAR.half - 0.1, BAR.post - 0.55, 0.09]} rotation-z={0.7}>
        <boxGeometry args={[0.6, 0.07, 0.02]} />
      </mesh>
      <mesh material={materials.paint} position={[-BAR.half - 0.1, BAR.post - 0.55, 0.09]} rotation-z={-0.7}>
        <boxGeometry args={[0.6, 0.07, 0.02]} />
      </mesh>
      <group ref={arm} position={[-BAR.half - 0.1, pivot, 0.2]}>
        <mesh material={materials.railArm} position-x={1.15} castShadow>
          <boxGeometry args={[2.3, 0.16, 0.08]} />
        </mesh>
        <mesh material={materials.red} position={[2.2, 0.12, 0]}>
          <sphereGeometry args={[0.05, 8, 6]} />
        </mesh>
      </group>
    </>
  );
}

/** Растяжка «СЕССИЯ» на тросах между столбами: низ полотнища — BAR_BOTTOM. */
function SessionBanner({ materials }: { materials: Materials }) {
  const height = 0.55;
  return (
    <>
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh material={materials.wood} position={[side * (BAR.half + 0.12), BAR.post / 2, 0]} castShadow>
            <cylinderGeometry args={[0.07, 0.08, BAR.post, 10]} />
          </mesh>
          <mesh material={materials.rope} position={[side * (BAR.half + 0.04), BAR.bottom + height + 0.15, 0]} rotation-z={side * 0.9}>
            <boxGeometry args={[0.02, 0.36, 0.02]} />
          </mesh>
        </group>
      ))}
      <mesh material={materials.banner} position-y={BAR.bottom + height / 2} castShadow>
        <boxGeometry args={[BAR.half * 2 - 0.1, height, 0.02]} />
      </mesh>
    </>
  );
}

/** Труба теплотрассы на П-опорах поперёк путей: низ трубы — BAR_BOTTOM. */
function HeatPipe({ materials }: { materials: Materials }) {
  const radius = 0.26;
  const y = BAR.bottom + radius;
  return (
    <>
      {[-1, 1].map((side) => (
        <group key={side} position-x={side * (BAR.half + 0.05)}>
          <mesh material={materials.rust} position-y={y / 2} castShadow>
            <boxGeometry args={[0.12, y, 0.12]} />
          </mesh>
          <mesh material={materials.pipe} position-y={y}>
            <cylinderGeometry args={[radius + 0.04, radius + 0.04, 0.12, 18]} />
          </mesh>
        </group>
      ))}
      <mesh material={materials.pipe} position-y={y} rotation-z={Math.PI / 2} castShadow>
        <cylinderGeometry args={[radius, radius, BAR.half * 2 + 0.8, 20]} />
      </mesh>
      {[-0.5, 0, 0.5].map((x) => (
        <mesh key={x} material={materials.rust} position={[x, y, 0]} rotation-z={Math.PI / 2}>
          <cylinderGeometry args={[radius + 0.015, radius + 0.015, 0.05, 20]} />
        </mesh>
      ))}
    </>
  );
}

/** Встречная дрезина: низкая платформа на колёсах с рычагом, едет передом к бегуну. */
function Handcar({ materials }: { materials: Materials }) {
  const deck = HANDCAR_TOP - 0.08;
  return (
    <>
      <mesh material={materials.wood} position={[0, deck, -HANDCAR_LENGTH / 2]} castShadow receiveShadow>
        <boxGeometry args={[1.7, 0.1, HANDCAR_LENGTH]} />
      </mesh>
      <mesh material={materials.post} position={[0, deck - 0.12, -HANDCAR_LENGTH / 2]}>
        <boxGeometry args={[1.3, 0.14, HANDCAR_LENGTH - 0.3]} />
      </mesh>
      {[0.45, HANDCAR_LENGTH - 0.45].map((z) => [-1, 1].map((side) => (
        <mesh key={`${z}:${side}`} material={materials.post} position={[side * (GAUGE / 2), 0.2, -z]} rotation-z={Math.PI / 2}>
          <cylinderGeometry args={[0.2, 0.2, 0.08, 16]} />
        </mesh>
      )))}
      {/* Рычаг-коромысло: низко, вровень с бортом — перепрыгивается вместе с платформой. */}
      <mesh material={materials.post} position={[0, HANDCAR_TOP - 0.02, -HANDCAR_LENGTH / 2]}>
        <boxGeometry args={[0.1, 0.06, 1.3]} />
      </mesh>
      {/* Полосатый передок во всю высоту и красные борта: видно издалека. */}
      <mesh material={materials.hurdle} position={[0, (HANDCAR_TOP + 0.08) / 2, 0.02]} castShadow>
        <boxGeometry args={[1.76, HANDCAR_TOP - 0.08, 0.06]} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} material={materials.cone} position={[side * 0.86, deck - 0.06, -HANDCAR_LENGTH / 2]}>
          <boxGeometry args={[0.05, 0.22, HANDCAR_LENGTH - 0.1]} />
        </mesh>
      ))}
      {/* Мачта с мигалкой у борта — сбоку от бегуна, над ней не прыгают. */}
      <mesh material={materials.post} position={[0.8, HANDCAR_TOP + 0.35, -HANDCAR_LENGTH + 0.2]}>
        <boxGeometry args={[0.05, 0.7, 0.05]} />
      </mesh>
      <mesh material={materials.light} position={[0.8, HANDCAR_TOP + 0.74, -HANDCAR_LENGTH + 0.2]}>
        <sphereGeometry args={[0.1, 12, 8]} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} material={materials.light} position={[side * 0.6, HANDCAR_TOP * 0.55, 0.06]}>
          <boxGeometry args={[0.18, 0.08, 0.02]} />
        </mesh>
      ))}
    </>
  );
}

/** Классический барьер: доска на двух стойках, прыгать. */
function Hurdle({ materials }: { materials: Materials }) {
  return (
    <>
      {[-1, 1].map((side) => (
        <group key={side} position-x={side * HURDLE.half}>
          <mesh material={materials.post} position-y={HURDLE.top / 2} castShadow>
            <boxGeometry args={[0.09, HURDLE.top, 0.09]} />
          </mesh>
          <mesh material={materials.foot} position-y={0.03}>
            <boxGeometry args={[0.16, 0.06, 0.55]} />
          </mesh>
          <mesh material={materials.light} position-y={HURDLE.top + 0.06}>
            <sphereGeometry args={[0.06, 10, 8]} />
          </mesh>
        </group>
      ))}
      <RoundedBox args={[HURDLE.half * 2 + 0.1, HURDLE.board, 0.08]} radius={0.03} smoothness={2} position-y={HURDLE.top - HURDLE.board / 2} material={materials.hurdle} castShadow />
    </>
  );
}

/** Полосатая балка на стойках: подкат. */
function Bar({ materials }: { materials: Materials }) {
  return (
    <>
      {[-1, 1].map((side) => (
        <group key={side} position-x={side * BAR.half}>
          <mesh material={materials.post} position-y={BAR.post / 2} castShadow>
            <boxGeometry args={[0.12, BAR.post, 0.12]} />
          </mesh>
          <mesh material={materials.foot} position-y={0.05}>
            <boxGeometry args={[0.32, 0.1, 0.5]} />
          </mesh>
          <mesh material={materials.light} position-y={BAR.post + 0.07}>
            <sphereGeometry args={[0.08, 10, 8]} />
          </mesh>
        </group>
      ))}
      <RoundedBox args={[BAR.half * 2 + 0.14, BAR.beam, 0.14]} radius={0.04} smoothness={2} position-y={BAR.bottom + BAR.beam / 2} material={materials.bar} castShadow />
    </>
  );
}

/** Облик препятствия по виду и `variant` (у вагонеток — окраска). */
function Look({ row, materials, arm }: { row: ObstacleRow; materials: Materials; arm: RefObject<Group | null> }) {
  switch (row.kind) {
    case "wagons":
      return <Wagons cars={Math.round((row.length + WAGON_GAP) / (WAGON_LENGTH + WAGON_GAP))} livery={row.variant % WAGON_LIVERIES.length} />;
    case "ramp":
      return <Ramp materials={materials} />;
    case "slope":
      return <Ramp materials={materials} top={DECK_HEIGHT} length={SLOPE_LENGTH} />;
    case "handcar":
      return <Handcar materials={materials} />;
    case "hurdle":
      return [<Hurdle materials={materials} />, <Crates materials={materials} />, <Cones materials={materials} />, <Block materials={materials} />, <Books materials={materials} />][row.variant] ?? <Hurdle materials={materials} />;
    case "bar":
      return [<Bar materials={materials} />, <Sign materials={materials} />, <RailGate materials={materials} arm={arm} />, <SessionBanner materials={materials} />, <HeatPipe materials={materials} />][row.variant] ?? <Bar materials={materials} />;
  }
}

/** Препятствие на своём треке; при ударе опрокидывается. */
function Row({ row, materials }: { row: ObstacleRow; materials: Materials }) {
  const runtime = useRuntime();
  const group = useRef<Group>(null);
  const body = useRef<Group>(null);
  const arm = useRef<Group>(null);
  const knockable = row.kind === "hurdle" || row.kind === "bar";

  useFrame(() => {
    if (!group.current) return;
    const z = -(row.distance - runtime.distance);
    group.current.position.z = z;
    group.current.visible = z - row.length < 12;
    // Препятствие «вырастает» вдали, чтобы не появляться из тумана рывком.
    group.current.scale.y = Math.min(1, Math.max(0.02, (190 + z) / 30));
    // Шлагбаум поднят вдали и опускается, пока бегун пробегает последние ~45 м.
    if (arm.current) arm.current.rotation.z = (Math.PI / 2) * Math.min(1, Math.max(0, (-z - 18) / 28));
    // Дрезина: рычаг качается, пока она едет.
    if (row.kind === "handcar" && body.current) body.current.position.y = row.distance - runtime.distance < HANDCAR_TRIGGER ? Math.abs(Math.sin(runtime.clock * 14)) * 0.02 : 0;
    if (knockable && row.hit && body.current) {
      const t = Math.min(1, (runtime.clock - row.resolvedClock) / 0.35);
      body.current.rotation.x = -1.45 * t * t;
      body.current.position.z = -0.6 * t;
    }
  });

  return (
    <group ref={group}>
      <group position={[laneX(row.lane, runtime.lanes), GROUND_Y, 0]}>
        <group ref={body}>
          <Look row={row} materials={materials} arm={arm} />
        </group>
      </group>
    </group>
  );
}

/** Монеты дугой над барьерами, низко под балками и дорожкой по крышам вагонеток: вращаются, при сборе взлетают и тают. */
function Coins() {
  const runtime = useRuntime();
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const geometry = useMemo(() => {
    const coin = new CylinderGeometry(0.26, 0.26, 0.06, 26);
    coin.rotateX(Math.PI / 2);
    return coin;
  }, []);
  const material = useMemo(() => new MeshStandardMaterial({ color: "#ffc93c", metalness: 0.85, roughness: 0.22, emissive: "#ff9800", emissiveIntensity: 0.55 }), []);
  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);

  useLayoutEffect(() => {
    if (mesh.current) mesh.current.count = 0;
  }, []);

  useFrame(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    let count = 0;
    const spin = runtime.clock * 4;
    for (const coin of runtime.coins) {
      if (count >= MAX_COINS) break;
      const z = -(coin.distance - runtime.distance);
      if (z < -190 || (coin.resolved && !coin.taken)) continue;
      let y = GROUND_Y + coin.height;
      let scale = Math.min(1, Math.max(0.02, (190 + z) / 30));
      if (coin.taken) {
        const t = (runtime.clock - coin.takenClock) / 0.28;
        if (t >= 1) continue;
        y += t * 0.9;
        scale *= 1 - t;
      }
      dummy.position.set(laneX(coin.lane, runtime.lanes), y, coin.taken ? 0 : z);
      dummy.rotation.set(0, spin + coin.distance * 0.4, 0);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      instanced.setMatrixAt(count, dummy.matrix);
      count += 1;
    }
    instanced.count = count;
    instanced.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={mesh} args={[geometry, material, MAX_COINS]} castShadow frustumCulled={false} />;
}

export function Obstacles() {
  const runtime = useRuntime();
  const materials = useObstacleMaterials();
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  useEffect(() => runtime.on((event) => {
    if (event.type === "course" || event.type === "question" || event.type === "obstacle") refresh();
  }), [runtime]);

  // Мигание сигнальных огней.
  useFrame(() => {
    const on = Math.sin(runtime.clock * 9) > 0 ? 1 : 0.25;
    materials.light.color.setRGB(3 * on, 1.3 * on, 0.25 * on);
  });

  if (!runtime.settings.obstacles) return null;
  return (
    <group>
      {runtime.obstacles.map((row) => <Row key={row.id} row={row} materials={materials} />)}
      <Coins />
    </group>
  );
}
