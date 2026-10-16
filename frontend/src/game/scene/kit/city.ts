import type { BufferGeometry } from "three";
import { SEGMENT_LENGTH } from "../../constants";
import { createRng, type Rng } from "../../engine/random";
import { adRect } from "../textures";
import { Batch, SHAPES, type Channel, type PieceOptions, type Shape } from "./batch";

/*
 * Городской пейзаж вдоль путей, по сегментам длиной SEGMENT_LENGTH. Сегмент
 * зависит только от номера: трасса при перезапуске та же, а пул сегментов
 * можно строить заранее. Координаты сегмента: z от 0 до −L, x — от оси трассы.
 *
 * Поперёк трассы (для стороны s = ±1, H — полуширина главных путей):
 *   H…H+2.6     обочина и опоры контактной сети
 *   H+2.6…H+5   запасной путь (рельсы и поезда — в Track и Trains)
 *   H+5.9       стена с граффити, забор или живая изгородь
 *   H+6.1…H+9   тротуар: фонари, деревья в кадках, скамейки
 *   H+9.4…      первая линия домов фасадом к путям, дальше — высотки
 */

const L = SEGMENT_LENGTH;

const WALLS = ["#ecd9bd", "#f2c094", "#e59b7b", "#cf7a5c", "#a6cfc2", "#86b8cc", "#bccae6", "#f3e2a2", "#dfaab8", "#b2cf8f", "#efe8de", "#d4dde2"];
const TOWERS = ["#c3cfdf", "#dde2ea", "#a9bdd2", "#e8dccb", "#c9d6cf", "#d8c8d8"];
const ROOFS = ["#c65a41", "#a8483c", "#5c6779", "#6f5847", "#3f6f7a"];
const LEAVES = ["#5cae4a", "#4f9e44", "#6dbb52", "#86c55a", "#3f8f45", "#74b84e"];
const AUTUMN = ["#e8a93a", "#dc7c45", "#c9b13f"];
const PINES = ["#2f7d4f", "#357f4b", "#2d6e4a"];
const GRAFFITI = ["#ff4f8b", "#7b5cff", "#2ec4f1", "#ffcf3f", "#3ddc84", "#ff7b3a", "#ffffff"];
const AWNINGS = ["#e4572e", "#2e86de", "#17a589", "#f1c40f", "#8e44ad", "#e84393"];
const METAL = "#5f6874";
const CONCRETE = "#c8c1b5";

const pick = <T,>(values: readonly T[], rng: Rng): T => values[Math.floor(rng() * values.length)];
const shade = (hex: string, factor: number) => {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, "0")).join("")}`;
};

class Builder {
  readonly batch = new Batch();
  readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  /** Деталь по центру (x, y, z) с размерами (sx, sy, sz). */
  put(channel: Channel, shape: Shape, x: number, y: number, z: number, sx: number, sy: number, sz: number, options: PieceOptions) {
    this.batch.add(channel, shape, [x, y, z], [sx, sy, sz], options);
  }

  box(channel: Channel, x: number, y: number, z: number, sx: number, sy: number, sz: number, options: PieceOptions) {
    this.put(channel, SHAPES.box, x, y, z, sx, sy, sz, options);
  }

  tree(x: number, z: number, size: number) {
    const rng = this.rng;
    if (rng() < 0.3) {
      this.put("solid", SHAPES.trunk, x, 0.7 * size, z, 0.34 * size, 1.4 * size, 0.34 * size, { color: "#7a4e33" });
      const color = pick(PINES, rng);
      [[2.7, 2.2, 1.7], [2.1, 2.0, 2.7], [1.45, 1.7, 3.6]].forEach(([width, height, y], i) => {
        this.put("leaf", SHAPES.cone, x, y * size, z, width * size, height * size, width * size, {
          color: shade(color, 1 + i * 0.07), rotation: rng() * Math.PI, shade: 0.35,
        });
      });
      return;
    }
    this.put("solid", SHAPES.trunk, x, 1.1 * size, z, 0.36 * size, 2.2 * size, 0.36 * size, { color: "#7d5136" });
    const base = rng() < 0.1 ? pick(AUTUMN, rng) : pick(LEAVES, rng);
    this.put("leaf", SHAPES.blob, x, 2.95 * size, z, 1.45 * size, 1.25 * size, 1.45 * size, { color: base, shade: 0.4 });
    const clumps = 3 + Math.floor(rng() * 2);
    for (let i = 0; i < clumps; i += 1) {
      const angle = (i / clumps) * Math.PI * 2 + rng();
      const r = (0.8 + rng() * 0.3) * size;
      this.put("leaf", SHAPES.blob, x + Math.cos(angle) * r, (2.4 + rng() * 0.9) * size, z + Math.sin(angle) * r,
        (0.8 + rng() * 0.3) * size, (0.75 + rng() * 0.25) * size, (0.8 + rng() * 0.3) * size,
        { color: shade(base, 0.92 + rng() * 0.18), shade: 0.4, rotation: rng() * Math.PI });
    }
  }

  bush(x: number, z: number, size: number) {
    const color = pick(LEAVES, this.rng);
    this.put("leaf", SHAPES.blob, x, 0.45 * size, z, 0.9 * size, 0.6 * size, 0.9 * size, { color, shade: 0.4 });
    this.put("leaf", SHAPES.blob, x + 0.5 * size, 0.35 * size, z - 0.3 * size, 0.6 * size, 0.45 * size, 0.6 * size, { color: shade(color, 1.08), shade: 0.4 });
  }
}

/** Портал контактной сети поперёк главных путей: фермы, подвесы, изоляторы. */
function catenary(b: Builder, H: number, lanes: number, laneWidth: number) {
  const z = -3;
  const x = H + 1.45;
  for (const side of [-1, 1]) {
    b.box("solid", side * x, 0.2, z, 0.8, 0.4, 0.8, { color: CONCRETE });
    b.box("metal", side * x, 3.4, z, 0.3, 6.6, 0.3, { color: METAL });
  }
  const span = x * 2 + 0.3;
  b.box("metal", 0, 6.55, z, span, 0.22, 0.26, { color: METAL, ground: false });
  b.box("metal", 0, 6.0, z, span, 0.14, 0.2, { color: METAL, ground: false });
  const struts = Math.round(span / 1.3);
  for (let i = 0; i <= struts; i += 1) {
    const sx = -span / 2 + (span / struts) * i;
    b.box("metal", sx, 6.27, z, 0.07, 0.5, 0.07, { color: METAL, ground: false });
    if (i < struts) {
      b.box("metal", sx + span / struts / 2, 6.27, z, span / struts * 1.1, 0.06, 0.06, {
        color: METAL, ground: false, rotation: [0, 0, (i % 2 ? 1 : -1) * 0.36],
      });
    }
  }
  for (let lane = 0; lane < lanes; lane += 1) {
    const lx = (lane - (lanes - 1) / 2) * laneWidth;
    b.box("metal", lx, 5.65, z, 0.05, 0.7, 0.05, { color: "#3d434c", ground: false });
    b.put("solid", SHAPES.cylinder, lx, 5.85, z, 0.13, 0.26, 0.13, { color: "#d9e1ea", ground: false });
  }
}

function signal(b: Builder, side: number, H: number, z: number, green: boolean) {
  const x = side * (H + 0.95);
  b.put("metal", SHAPES.cylinder, x, 1.7, z, 0.14, 3.4, 0.14, { color: "#3a4049" });
  b.box("solid", x, 3.55, z, 0.38, 0.95, 0.3, { color: "#262b33", ground: false });
  b.box("solid", x, 4.06, z + 0.06, 0.46, 0.06, 0.42, { color: "#262b33", ground: false });
  b.put(green ? "glow" : "solid", SHAPES.sphere, x, 3.8, z + 0.16, 0.1, 0.1, 0.06, { color: green ? "#5dff9a" : "#1d3a28", ground: false });
  b.put(green ? "solid" : "glow", SHAPES.sphere, x, 3.35, z + 0.16, 0.1, 0.1, 0.06, { color: green ? "#3a1d1d" : "#ff5a4a", ground: false });
}

/** Граница полосы отвода: бетонная стена с граффити, забор или изгородь. */
function edge(b: Builder, side: number, H: number, mural: boolean) {
  const rng = b.rng;
  const x = side * (H + 5.9);
  const roll = rng();
  if (mural || roll < 0.45) {
    const height = mural ? 4.1 : 1.7;
    b.box("solid", x, height / 2, -L / 2, 0.35, height, L, { color: CONCRETE });
    b.box("solid", x, height + 0.06, -L / 2, 0.46, 0.12, L, { color: "#ddd6cb", ground: false });
    for (let post = 0; post < 6; post += 1) {
      b.box("solid", x - side * 0.2, 0.85, -post * 6 - 0.4, 0.1, 1.7, 0.35, { color: "#b7b0a4" });
    }
    const face = x - side * 0.2;
    const pieces = mural ? 0 : 1 + Math.floor(rng() * 3);
    for (let i = 0; i < pieces; i += 1) {
      const width = 2 + rng() * 3.5;
      const z = -2 - rng() * (L - width - 4) - width / 2;
      const height = 0.6 + rng() * 0.7;
      const y = 0.25 + height / 2 + rng() * 0.2;
      b.box("solid", face, y, z, 0.03, height, width, { color: pick(GRAFFITI, rng), ground: false });
      b.box("solid", face - side * 0.012, y + (rng() - 0.5) * 0.3, z + (rng() - 0.5) * width * 0.4, 0.03, height * 0.55, width * 0.45, {
        color: pick(GRAFFITI, rng), ground: false, rotation: [0.15 * (rng() - 0.5), 0, 0],
      });
    }
    if (!mural && rng() < 0.4) {
      const z = -6 - rng() * (L - 12);
      b.put("ads", SHAPES.plane, face - side * 0.03, 1.0, z, 3.0, 1.5, 1, {
        color: "#ffffff", rotation: -side * Math.PI / 2, uvRect: adRect(Math.floor(rng() * 4)), ground: false,
      });
    }
  } else if (roll < 0.8) {
    for (let z = -0.6; z > -L; z -= 2.4) b.box("metal", x, 0.8, z, 0.07, 1.6, 0.07, { color: "#3f5a4b" });
    for (const y of [0.3, 0.95, 1.55]) b.box("metal", x, y, -L / 2, 0.04, 0.05, L, { color: "#3f5a4b", ground: false });
  } else {
    for (let z = -0.7; z > -L; z -= 1.3) {
      const color = pick(LEAVES, rng);
      b.put("leaf", SHAPES.blob, x + (rng() - 0.5) * 0.2, 0.62, z, 0.75, 0.68 + rng() * 0.1, 0.95, { color: shade(color, 0.9), shade: 0.35 });
    }
  }
}

function lamp(b: Builder, side: number, H: number, z: number) {
  const x = side * (H + 6.7);
  b.put("metal", SHAPES.cylinder, x, 2.6, z, 0.15, 5.2, 0.15, { color: "#39424e" });
  b.put("solid", SHAPES.cylinder, x, 0.25, z, 0.3, 0.5, 0.3, { color: "#39424e" });
  b.box("metal", x - side * 0.55, 5.18, z, 1.15, 0.08, 0.08, { color: "#39424e", ground: false });
  b.box("solid", x - side * 1.1, 5.15, z, 0.62, 0.16, 0.32, { color: "#2c333c", ground: false });
  b.box("glow", x - side * 1.1, 5.06, z, 0.48, 0.04, 0.22, { color: "#ffe2a6" });
}

/** Тротуар: фонари, деревья в кадках, скамейки, урны. */
function sidewalk(b: Builder, side: number, H: number) {
  const rng = b.rng;
  lamp(b, side, H, -10);
  lamp(b, side, H, -28);
  const x = side * (H + 8.1);
  for (const z of [-3 - rng() * 3, -19 - rng() * 4]) {
    if (rng() < 0.75) {
      b.box("solid", x, 0.25, z, 1.3, 0.5, 1.3, { color: "#bdb4a6" });
      b.tree(x, z, 0.7 + rng() * 0.15);
    } else {
      b.bush(x, z, 1.1);
    }
  }
  if (rng() < 0.5) {
    const z = -14 - rng() * 3;
    const bx = side * (H + 8.4);
    b.box("solid", bx, 0.46, z, 0.45, 0.08, 1.7, { color: "#a8714a" });
    b.box("solid", bx + side * 0.22, 0.78, z, 0.07, 0.42, 1.7, { color: "#a8714a", ground: false });
    for (const dz of [-0.7, 0.7]) b.box("metal", bx, 0.22, z + dz, 0.4, 0.44, 0.07, { color: "#3a4049" });
  }
  if (rng() < 0.5) {
    b.put("solid", SHAPES.cylinder, side * (H + 6.5), 0.42, -21 - rng() * 2, 0.5, 0.84, 0.5, { color: "#2f8f5b" });
  }
}

/** Дом фасадом к путям. `front` — x фасада, `zc` — центр по z, `w` — ширина вдоль путей. */
function building(b: Builder, side: number, front: number, zc: number, w: number) {
  const rng = b.rng;
  const depth = 9 + rng() * 6;
  const cx = front + side * depth / 2;
  const roll = rng();
  const kind = roll < 0.22 ? "house" : roll < 0.48 ? "shop" : "block";
  const floors = kind === "house" ? 2 + Math.floor(rng() * 2) : 2 + Math.floor(rng() * 5);
  const floorH = 3.1;
  const height = 0.9 + floors * floorH + 0.5;
  const wall = pick(WALLS, rng);
  const trim = shade(wall, 0.78);
  const spacing = 2.5 + rng() * 0.9;
  const seed = Math.floor(rng() * 1000);

  b.box("facade", cx, height / 2, zc, depth, height, w, {
    color: wall, shade: 0.12, facade: { spacing, floor: floorH, style: kind === "shop" ? 2 : 1, seed },
  });
  b.box("solid", cx, 0.45, zc, depth + 0.14, 0.9, w + 0.14, { color: trim });

  if (kind === "house") {
    const roof = pick(ROOFS, rng);
    b.put("solid", SHAPES.gable, cx, height, zc, depth + 0.7, 2.4 + rng() * 0.8, w + 0.5, { color: roof, ground: false });
    b.box("solid", cx + (rng() - 0.5) * depth * 0.4, height + 1.4, zc + (rng() - 0.5) * w * 0.4, 0.7, 1.8, 0.7, { color: "#9c4f3c", ground: false });
    return;
  }

  b.box("solid", cx, height + 0.14, zc, depth + 0.3, 0.38, w + 0.3, { color: shade(wall, 0.9), ground: false });
  if (rng() < 0.5) {
    for (let f = 1; f < floors; f += 1) {
      b.box("solid", cx, 0.9 + f * floorH - 0.08, zc, depth + 0.08, 0.14, w + 0.08, { color: shade(wall, 0.88), ground: false });
    }
  }

  if (kind === "shop") {
    const awning = pick(AWNINGS, rng);
    b.box("solid", front - side * 0.65, 3.35, zc, 1.4, 0.1, w * 0.86, { color: awning, ground: false, rotation: [0, 0, side * 0.28] });
    b.box("solid", front - side * 0.66, 3.18, zc, 1.42, 0.22, w * 0.86, { color: shade(awning, 0.8), ground: false, rotation: [0, 0, side * 0.28] });
    b.box("glow", front - side * 0.08, 3.95, zc, 0.08, 0.42, Math.min(w * 0.6, 5), { color: pick(["#fff1c9", "#c9f2ff", "#ffd0ea"], rng) });
  }

  // Балконы в двух колонках окон.
  if (kind === "block" && floors >= 3 && rng() < 0.55) {
    const cols = Math.max(1, Math.floor((w - 0.9) / spacing));
    const chosen = new Set([Math.floor(rng() * cols), Math.floor(rng() * cols)]);
    for (const col of chosen) {
      const z = zc + (col + 0.5) * spacing - (cols * spacing) / 2;
      for (let f = 1; f < floors; f += 1) {
        const y = 0.9 + f * floorH;
        b.box("solid", front - side * 0.45, y - 0.02, z, 0.9, 0.14, spacing * 0.86, { color: "#e9e4dc", ground: false });
        b.box("glass", front - side * 0.88, y + 0.45, z, 0.04, 0.8, spacing * 0.86, { color: "#6f8fae", ground: false });
        b.box("metal", front - side * 0.88, y + 0.88, z, 0.07, 0.06, spacing * 0.86, { color: "#59606b", ground: false });
      }
    }
  }

  // Крыша: кондиционеры, бак, антенна, солнечные панели, рекламный щит.
  const top = height + 0.33;
  const units = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < units; i += 1) {
    b.box("solid", cx + (rng() - 0.5) * depth * 0.6, top + 0.35, zc + (rng() - 0.5) * w * 0.6, 1.1, 0.7, 0.9, { color: "#d3d7dc", ground: false });
  }
  if (rng() < 0.35) {
    const tx = cx + side * depth * 0.2;
    const tz = zc + (rng() - 0.5) * w * 0.4;
    for (const [dx, dz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
      b.box("metal", tx + dx, top + 0.6, tz + dz, 0.1, 1.2, 0.1, { color: "#4a3a2e", ground: false });
    }
    b.put("solid", SHAPES.cylinder, tx, top + 2.1, tz, 1.9, 1.9, 1.9, { color: "#9a6a45", ground: false });
    b.put("solid", SHAPES.cone, tx, top + 3.4, tz, 2.0, 0.7, 2.0, { color: "#7b5236", ground: false });
  } else if (rng() < 0.3) {
    for (let i = 0; i < 3; i += 1) {
      b.box("glass", cx + (i - 1) * 1.5, top + 0.45, zc, 1.3, 0.05, Math.min(3, w * 0.5), { color: "#27466e", ground: false, rotation: [0, 0, side * 0.45] });
    }
  }
  if (rng() < 0.3) {
    const ax = cx + (rng() - 0.5) * depth * 0.5;
    b.put("metal", SHAPES.cylinder, ax, top + 1.6, zc, 0.06, 3.2, 0.06, { color: "#646c78", ground: false });
    b.box("metal", ax, top + 2.6, zc, 0.04, 0.04, 1.2, { color: "#646c78", ground: false });
  }
  if (floors <= 4 && rng() < 0.28) {
    // Щит повёрнут к путям и к камере, чтобы читался издалека.
    const bx = front + side * 2.2;
    const angle = Math.atan2(-side * 0.82, 0.57);
    b.box("metal", bx - 1.6, top + 1.3, zc, 0.12, 2.6, 0.12, { color: METAL, ground: false });
    b.box("metal", bx + 1.6, top + 1.3, zc, 0.12, 2.6, 0.12, { color: METAL, ground: false });
    b.put("ads", SHAPES.plane, bx, top + 3.4, zc, 5, 2.5, 1, { color: "#ffffff", rotation: angle, uvRect: adRect(Math.floor(rng() * 4)), ground: false });
    b.box("solid", bx - Math.sin(angle) * 0.08, top + 3.4, zc - Math.cos(angle) * 0.08, 5.1, 2.6, 0.1, { color: "#4a515c", rotation: angle, ground: false });
  }
}

/** Первая линия домов вплотную друг к другу, с редкими скверами. */
function buildingRow(b: Builder, side: number, H: number) {
  const rng = b.rng;
  const front = side * (H + 9.4);
  let z = -rng() * 1.2;
  while (z > -L + 4.5) {
    const remaining = L + z;
    if (rng() < 0.16 && remaining > 7) {
      const gap = 4 + rng() * 4;
      b.tree(front + side * (2 + rng() * 3), z - gap / 2, 0.9 + rng() * 0.35);
      if (rng() < 0.6) b.bush(front + side * (5 + rng() * 3), z - gap * (0.2 + rng() * 0.6), 1.2);
      if (rng() < 0.5) b.tree(front + side * (7 + rng() * 4), z - gap * (0.3 + rng() * 0.4), 1 + rng() * 0.3);
      z -= gap;
      continue;
    }
    const w = Math.min(remaining - 0.3, 7 + rng() * 7);
    if (w < 4.5) break;
    building(b, side, front, z - w / 2, w);
    z -= w + (rng() < 0.65 ? 0 : 0.5 + rng() * 1.5);
  }
}

/** Вторая линия: высотки над крышами первой. */
function backRow(b: Builder, side: number, H: number) {
  const rng = b.rng;
  if (rng() < 0.35) return;
  const w = 10 + rng() * 6;
  const depth = 10 + rng() * 5;
  const cx = side * (H + 9.4 + 16 + rng() * 8 + depth / 2);
  const zc = -w / 2 - rng() * (L - w);
  const floors = 7 + Math.floor(rng() * 8);
  const height = 0.9 + floors * 3.2 + 0.5;
  const color = pick(TOWERS, rng);
  const ribbon = rng() < 0.45;
  b.box("facade", cx, height / 2, zc, depth, height, w, {
    color, shade: 0.15, facade: { spacing: ribbon ? 3.2 : 2.4, floor: 3.2, style: ribbon ? 3 : 1, seed: Math.floor(rng() * 1000) },
  });
  b.box("solid", cx, height + 0.2, zc, depth + 0.3, 0.4, w + 0.3, { color: shade(color, 0.85), ground: false });
  b.box("solid", cx + (rng() - 0.5) * depth * 0.3, height + 1.6, zc, depth * 0.35, 2.8, w * 0.3, { color: shade(color, 0.92), ground: false });
  if (rng() < 0.5) {
    b.put("metal", SHAPES.cylinder, cx, height + 5, zc, 0.12, 4.5, 0.12, { color: "#7b8390", ground: false });
    b.put("glow", SHAPES.sphere, cx, height + 7.3, zc, 0.18, 0.18, 0.18, { color: "#ff4a4a", ground: false });
  }
}

export function buildSegment(index: number, trackHalf: number, lanes: number, laneWidth: number): Map<Channel, BufferGeometry> {
  const b = new Builder(createRng((index * 7919 + 17) >>> 0));
  const H = trackHalf;
  catenary(b, H, lanes, laneWidth);
  if (index % 2 === 0) signal(b, b.rng() < 0.5 ? -1 : 1, H, -16, b.rng() < 0.7);
  for (const side of [-1, 1]) {
    edge(b, side, H, ((index % 4) + 4) % 4 === 1);
    sidewalk(b, side, H);
    buildingRow(b, side, H);
    backRow(b, side, H);
  }
  return b.batch.build();
}
