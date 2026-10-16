import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Group, Mesh } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LANE_WIDTH } from "../../constants";
import { createRng, type Rng } from "../../engine/random";
import { useRuntime } from "../context";
import { GraffitiTrail } from "../Graffiti";
import { SHAPES, toShape, type Shape } from "../kit/batch";
import { NIGHT, NightBuilder, TRAIN_OFFSET, type NightGeometry, type NightMaterials } from "./kit";
import { SOLID_CHANNELS } from "./NightMesh";
import { NEON, SCREENS } from "./signs";

/** Длина сегмента и сколько сегментов подряд занимает район. */
export const SEGMENT = 48;
export const SPAN = 3;
const TYPES = ["station", "viaduct", "canyon", "gallery"] as const;
export type District = (typeof TYPES)[number];
const CYCLE = SEGMENT * SPAN * TYPES.length;
const mod = (value: number, n: number) => ((value % n) + n) % n;
export const districtAt = (distance: number): District => TYPES[Math.floor(mod(distance, CYCLE) / (SEGMENT * SPAN))];
/** 0 — въезд в район, 1 — середина, 2 — выезд. */
const variantAt = (distance: number) => Math.floor(mod(distance, SEGMENT * SPAN) / SEGMENT);

type Vec3 = [number, number, number];
const pick = <T,>(rng: Rng, list: readonly T[]) => list[Math.floor(rng() * list.length)];
const DECK = "#171f2c";
const COATS = ["#2a3142", "#3a2636", "#1f3444", "#3b3324", "#2b2b3b", "#4a2a2a", "#23323a"];
const BAGS = ["#c2485f", "#3b7bd1", "#d39b3a", "#2a8f7a", "#6f4fc2"];
const SKIN = ["#c49a7c", "#a8775a", "#e0b89a", "#8a5d44"];
const ACCENTS = [NIGHT.cyan, NIGHT.magenta, NIGHT.amber, NIGHT.violet, "#7fd0ff"];

/** Служебный настил, линия маглевов сбоку и внешний бортик — общие для всех районов. */
function deck(b: NightBuilder, H: number, s: number, walkway = true) {
  const wx = s * (H + 2.85);
  if (walkway) {
    b.box("solid", [wx, -0.2, -24], [4.3, 0.5, 48], DECK);
    for (let z = -0.6; z > -48; z -= 1.2) b.box("metal", [wx, 0.055, z], [4.2, 0.012, 0.07], "#263243");
    b.box("glow", [s * (H + 4.92), 0.06, -24], [0.05, 0.015, 48], NIGHT.amber);
  }
  const tx = s * (H + TRAIN_OFFSET);
  b.box("solid", [tx, -0.38, -24], [2.5, 0.6, 48], "#111823");
  for (const r of [-1, 1]) {
    b.box("metal", [tx + r * 0.78, -0.02, -24], [0.24, 0.12, 48], "#2a3646");
    b.box("pulse", [tx + r * 0.64, 0.045, -24], [0.03, 0.015, 48], NIGHT.violet);
  }
  b.box("glow", [tx, -0.075, -24], [0.16, 0.01, 48], "#3a2f7a");
  b.box("solid", [s * (H + 8.5), -0.28, -24], [1.3, 0.5, 48], DECK);
}

function person(b: NightBuilder, rng: Rng, x: number, y: number, z: number) {
  const coat = pick(rng, COATS);
  const k = 0.92 + rng() * 0.14;
  for (const leg of [-1, 1]) b.rounded("solid", [x + leg * 0.1, y + 0.42 * k, z], [0.15, 0.84 * k, 0.18], "#171c26");
  b.rounded("solid", [x, y + 1.13 * k, z], [0.44, 0.62 * k, 0.27], coat);
  for (const arm of [-1, 1]) b.rounded("solid", [x + arm * 0.28, y + 1.08 * k, z], [0.11, 0.58 * k, 0.13], coat);
  b.bead("solid", [x, y + 1.6 * k, z], [0.13, 0.15, 0.14], pick(rng, SKIN));
  b.bead("solid", [x, y + 1.67 * k, z + 0.015], [0.138, 0.09, 0.145], rng() < 0.5 ? "#16141a" : "#5a3a22");
  if (rng() < 0.45) b.rounded("solid", [x, y + 1.15 * k, z + 0.21], [0.34, 0.42, 0.16], pick(rng, BAGS));
  if (rng() < 0.5) b.box("glow", [x + 0.14, y + 1.28 * k, z - 0.17], [0.07, 0.11, 0.012], "#9fe6ff");
  if (rng() < 0.25) b.box("glow", [x, y + 1.62 * k, z], [0.3, 0.035, 0.05], pick(rng, ACCENTS));
}

/** Эллиптическая арка в плоскости XY: полуоси a (по x) и h (по y), опора на высоте y0. */
function arch(b: NightBuilder, a: number, h: number, y0: number, z: number, thickness: number, color: string, channel: "metal" | "pulse" | "glow" = "metal", n = 18) {
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) * Math.PI;
    const t1 = ((i + 1) / n) * Math.PI;
    b.beam(channel, [Math.cos(t0) * a, y0 + Math.sin(t0) * h, z], [Math.cos(t1) * a, y0 + Math.sin(t1) * h, z], thickness, color, channel === "metal" ? 0.42 : 0.06);
  }
}

/* ──────────────────────────── Станция ──────────────────────────── */

function station(b: NightBuilder, H: number, rng: Rng, variant: number, props: Shape[]) {
  for (const s of [-1, 1]) {
    deck(b, H, s, false);
    const px = s * (H + 2.85);
    const toTrack = s > 0 ? -Math.PI / 2 : Math.PI / 2;
    // Островная платформа между магистралью и линией маглевов.
    b.box("solid", [px, 0.45, -24], [4.3, 0.9, 48], "#1d2532");
    b.box("solid", [px, 0.91, -24], [4.3, 0.025, 48], "#262d38");
    for (let z = -1.5; z > -48; z -= 3) b.box("solid", [px, 0.924, z], [4.1, 0.004, 0.05], "#1a2029");
    for (const e of [-1, 1]) {
      b.box("solid", [px + e * 1.98, 0.925, -24], [0.2, 0.012, 48], "#6a5420");
      b.box("glow", [px + e * 2.1, 0.93, -24], [0.025, 0.012, 48], "#c98a3a");
    }
    // Стеклянные двери платформы со стороны маглевов.
    const door = px + s * 2.08;
    for (let z = -1.2; z > -48; z -= 2.4) {
      b.box("metal", [door, 1.86, z], [0.09, 1.92, 0.09], "#3a4858");
      b.box("glass", [door, 1.72, z - 1.2], [0.03, 1.55, 2.22], "#1a2e3e");
      b.box("pulse", [door, 2.84, z - 1.2], [0.07, 0.07, 2.3], NIGHT.cyan);
    }
    for (let z = -6; z > -48; z -= 12) {
      // Колонны с неоновыми кольцами и табло.
      const top = 0.8 + 12.4 * Math.sqrt(1 - (px / (H + 9.3)) ** 2);
      b.rounded("solid", [px, (0.9 + top) / 2, z], [0.56, top - 0.9, 0.56], "#b8c4d0");
      for (const ry of [3.0, 6.3]) b.shape("pulse", SHAPES.ring, [px, ry, z], [1.5, 1.5, 1.5], ry < 4 ? NIGHT.magenta : NIGHT.cyan, [Math.PI / 2, 0, 0]);
      b.box("metal", [px, 2.35, z + 0.32], [1.74, 0.94, 0.06], "#0d1219");
      b.sign("ads", rng() < 0.5 ? SCREENS.timetable : pick(rng, [SCREENS.coffee, SCREENS.exam, SCREENS.surfers]), [px, 2.35, z + 0.36], [1.62, 0.82]);
      // Скамейка и автомат с напитками.
      b.rounded("solid", [px - s * 0.9, 1.33, z - 3], [0.5, 0.09, 1.9], "#5a6a7c");
      b.rounded("solid", [px - s * 1.12, 1.62, z - 3], [0.08, 0.5, 1.9], "#5a6a7c");
      for (const lz of [-0.7, 0.7]) b.box("metal", [px - s * 0.9, 1.1, z - 3 + lz], [0.4, 0.4, 0.07], "#2a3240");
      const vend = pick(rng, [NIGHT.magenta, NIGHT.cyan, NIGHT.amber, "#ff5a5a"]);
      b.rounded("solid", [px + s * 1.4, 1.85, z - 6.5], [0.95, 1.9, 0.85], "#202836");
      b.box("glow", [px + s * 1.4 - s * 0.48, 2.1, z - 6.5], [0.02, 1.15, 0.62], vend);
      b.box("glow", [px + s * 1.4 - s * 0.48, 1.25, z - 6.5], [0.02, 0.16, 0.5], "#e8f4ff");
      if (props[1] && rng() < 0.6) b.shape("solid", props[1], [px + s * 1.2, 0.92, z - 9], [1, 1, 1], "#5c6c7c", [0, toTrack, 0]);
    }
    // Светильники-трубки над платформой.
    for (let z = -3; z > -48; z -= 6) {
      b.box("glow", [px, 4.55, z], [0.14, 0.07, 3.6], "#dff1ff");
      b.box("metal", [px, 4.64, z], [0.24, 0.07, 3.8], "#2a3240");
      for (const hz of [-1.4, 1.4]) b.box("metal", [px, 6.5, z + hz], [0.02, 3.8, 0.02], "#4b5868");
    }
    // Люди на платформе.
    const crowd = 4 + Math.floor(rng() * 4);
    for (let i = 0; i < crowd; i++) person(b, rng, px + (rng() - 0.5) * 2.6, 0.92, -2 - rng() * 44);
    // Внешняя стена: остекление снизу, открытый каркас сверху — видно город.
    const wall = s * (H + 9.15);
    b.box("solid", [wall, 0.5, -24], [0.5, 1.4, 48], "#1a2230");
    for (let z = 0; z > -48; z -= 4) {
      b.box("metal", [wall, 4.6, z], [0.16, 8.2, 0.16], "#3a4656");
      b.box("glass", [wall, 2.4, z - 2], [0.04, 2.6, 3.9], "#14283a");
    }
    for (const ty of [1.15, 3.75, 7.2]) b.box("metal", [wall, ty, -24], [0.14, 0.14, 48], "#3a4656");
    b.box("pulse", [wall - s * 0.1, 3.85, -24], [0.04, 0.05, 48], NIGHT.violet);
    // Большие экраны на внешней стене, развёрнутые к камере.
    for (const z of [-14, -38]) {
      const screen = pick(rng, [SCREENS.surfers, SCREENS.graph, SCREENS.coffee, SCREENS.exam, SCREENS.formula]);
      b.box("metal", [wall - s * 0.3, 5.6, z], [0.2, 2.8, 5.4], "#0b0f15");
      b.sign("ads", screen, [wall - s * 0.42, 5.6, z], [5.1, 2.55], toTrack);
    }
  }
  // Свод: арки над всеми путями, обвязка и бегущий свет по внутренней кромке.
  const a = H + 9.3;
  for (const z of [-6, -18, -30, -42]) {
    arch(b, a, 12.4, 0.8, z, 0.5, "#2b3546");
    arch(b, a - 0.36, 12.04, 0.8, z, 0.07, NIGHT.cyan, "pulse");
  }
  for (const t of [0.35, 0.7, 1.1, 1.57, 2.04, 2.44, 2.79]) b.box("metal", [Math.cos(t) * a, 0.8 + Math.sin(t) * 12.4, -24], [0.2, 0.2, 48], "#2b3546");
  if (variant === 0) for (const s of [-1, 1]) {
    // Табличка станции на въезде.
    const px = s * (H + 2.85);
    b.box("metal", [px, 5.5, -2], [4.5, 2.3, 0.12], "#0b0f15");
    b.sign("ads", SCREENS.station, [px, 5.5, -1.93], [4.3, 2.15]);
    for (const hx of [-1.8, 1.8]) b.box("metal", [px + hx, 8.2, -2], [0.04, 3.2, 0.04], "#4b5868");
  }
}

/* ──────────────────────────── Виадук ──────────────────────────── */

function viaduct(b: NightBuilder, H: number, rng: Rng, variant: number) {
  const pierZ = [-12, -36];
  for (const z of pierZ) {
    b.box("solid", [0, -24, z], [Math.max(3, H * 0.9), 46, 3], "#121a26");
    b.box("glow", [0, -18, z + 1.52], [0.08, 30, 0.04], "#2a4a6a");
  }
  for (const s of [-1, 1]) {
    deck(b, H, s);
    // Коробчатая балка под настилом и подсветка её кромки.
    b.box("solid", [s * (H + 4.6), -1.3, -24], [8.8, 1.6, 48], "#0f1620");
    b.box("pulse", [s * (H + 9.08), -0.62, -24], [0.04, 0.08, 48], NIGHT.amber);
    for (const z of pierZ) {
      b.box("solid", [s * (H + TRAIN_OFFSET), -24, z], [2.6, 46, 2.6], "#121a26");
      b.box("glow", [s * (H + TRAIN_OFFSET) - s * 1.32, -16, z], [0.04, 28, 0.08], "#3a2f7a");
    }
    // Ограждение с полосой света.
    const rail = s * (H + 9.05);
    for (let z = -1; z > -48; z -= 2) b.box("metal", [rail, 0.55, z], [0.06, 1.1, 0.06], "#4b5868");
    b.box("metal", [rail, 1.12, -24], [0.1, 0.08, 48], "#5b6a7c");
    b.box("pulse", [rail, 0.98, -24], [0.03, 0.04, 48], NIGHT.cyan);
    b.box("glass", [rail, 0.6, -24], [0.02, 0.8, 48], "#1a2c3c");
    // Вантовый пилон: огни по рёбрам, маяк, «арфа» тросов.
    const px = s * (H + 10.6);
    b.box("solid", [px, -6, -24], [1.5, 72, 2.4], "#1a2230");
    b.box("solid", [px, 30.4, -24], [1.9, 0.8, 2.8], "#2a3444");
    for (const dz of [-1, 1]) b.box("glow", [px - s * 0.76, 15, -24 + dz * 1.21], [0.05, 30, 0.05], dz < 0 ? NIGHT.cyan : NIGHT.magenta);
    b.box("beacon", [px, 31.2, -24], [0.6, 0.6, 0.6], NIGHT.red);
    for (let k = 1; k <= 5; k++) for (const dz of [-1, 1]) {
      b.beam("pulse", [px - s * 0.5, 29 - k * 3.1, -24 + dz * 0.6], [s * (H + 8.9), 1.2, -24 + dz * k * 4.4], 0.05, "#4a8fb0");
    }
    // Город внизу: дома поднимаются из темноты, на крышах — вывески, баки, вертолётные площадки.
    b.box("solid", [s * (H + 13), -44.2, -24], [7, 0.4, 48], "#0d121a");
    for (let z = -2; z > -48; z -= 6) b.box("glow", [s * (H + 13), -43.95, z], [0.12, 0.02, 2.4], "#8a7a5a");
    let z = -rng() * 4;
    while (z > -44) {
      const len = 7 + rng() * 9;
      const w = 7 + rng() * 9;
      const x = s * (H + 17 + rng() * 14 + w / 2);
      const top = -18 + rng() * 34;
      const cz = z - len / 2;
      b.facade([x, -46, cz], [w, top + 46, len], pick(rng, ["#141a28", "#19172a", "#122028", "#1c1a26"]), { spacing: 2 + rng() * 1.2, floor: 3.2 + rng() * 0.6, style: rng() < 0.25 ? 3 : rng() < 0.6 ? 2 : 1, seed: rng() * 100 });
      b.box("metal", [x, top + 0.3, cz], [w + 0.3, 0.6, len + 0.3], "#232c3a");
      const crown = pick(rng, ACCENTS);
      b.box("glow", [x - s * (w / 2 + 0.16), top + 0.3, cz], [0.06, 0.12, len], crown);
      for (let i = 0; i < 3; i++) b.box("metal", [x + (rng() - 0.5) * w * 0.6, top + 1.0, cz + (rng() - 0.5) * len * 0.6], [1.2, 0.8, 1.6], "#3a4656");
      if (rng() < 0.4) b.cylinder("solid", [x + w * 0.25, top + 2, cz], [1.6, 2.4, 1.6], "#4a3a2e");
      if (rng() < 0.3) b.shape("glow", SHAPES.ring, [x, top + 0.65, cz], [w * 0.5, w * 0.5, 2], "#ffd35c", [Math.PI / 2, 0, 0]);
      if (rng() < 0.55) {
        const slot = pick(rng, NEON.horizontal);
        b.box("metal", [x, top + 2.4, cz + len * 0.3], [w * 0.8, 0.1, 0.1], "#2a3240");
        b.sign("neon", slot, [x, top + 3.6, cz + len * 0.3], [w * 0.85, w * 0.85 / 4]);
      }
      if (rng() < 0.5) b.box("beacon", [x - w * 0.35, top + 1.2, cz - len * 0.35], [0.5, 0.5, 0.5], NIGHT.red);
      z -= len + 2 + rng() * 5;
    }
  }
  if (variant === 0) {
    // Табличка района на портале над путями.
    b.box("metal", [0, 7.2, -3], [H * 2 + 2, 0.4, 0.4], "#2a3444");
    for (const s of [-1, 1]) b.box("metal", [s * (H + 0.8), 3.6, -3], [0.4, 7.2, 0.4], "#2a3444");
    b.box("metal", [0, 8.4, -3], [5.4, 2.4, 0.14], "#0b0f15");
    b.sign("ads", SCREENS.viaduct, [0, 8.4, -2.92], [5.2, 2.6]);
  }
}

/* ──────────────────────────── Неоновый квартал ──────────────────────────── */

function canyon(b: NightBuilder, H: number, rng: Rng, variant: number) {
  const front = H + 9.6;
  for (const s of [-1, 1]) {
    deck(b, H, s);
    const toTrack = s > 0 ? -Math.PI / 2 : Math.PI / 2;
    b.box("solid", [s * (front - 0.4), -0.1, -24], [1.6, 0.7, 48], DECK);
    let z = -rng() * 2;
    while (z > -47) {
      const len = Math.min(8 + rng() * 9, z + 48);
      if (len < 3) break;
      const depth = 10 + rng() * 6;
      const height = 22 + rng() * 40;
      const cz = z - len / 2;
      const x = s * (front + depth / 2);
      const face = s * (front - 0.02);
      b.facade([x, -8, cz], [depth, height, len], pick(rng, ["#1a1626", "#14202a", "#221a24", "#171c2a", "#1e1a1e"]), { spacing: 1.8 + rng() * 1.2, floor: 3 + rng() * 0.5, style: rng() < 0.2 ? 3 : rng() < 0.5 ? 2 : 1, seed: rng() * 100 });
      // Первый этаж: витрины, козырьки, вывески над ними.
      const shop = pick(rng, ["#7a4a26", "#7a2f5a", "#2f6070", "#7a6030", "#4a3f7a"]);
      b.box("glow", [face, 1.5, cz], [0.04, 2.2, len * 0.72], shop);
      for (let m = -0.36; m <= 0.361; m += 0.12) b.box("metal", [face - s * 0.03, 1.5, cz + m * len], [0.06, 2.3, 0.08], "#141a22");
      b.box("metal", [face - s * 0.03, 1.5, cz], [0.06, 0.06, len * 0.74], "#141a22");
      const awning = pick(rng, ["#9a2c4a", "#1f6f7a", "#a46a1e", "#3d2f8a", "#2a2f3a"]);
      b.box("solid", [face - s * 0.6, 3.05, cz], [1.3, 0.08, len * 0.76], awning, [0, 0, s * 0.28]);
      b.sign("neon", pick(rng, NEON.horizontal), [face - s * 0.05, 4.2, cz], [Math.min(len * 0.7, 6), Math.min(len * 0.7, 6) / 4], toTrack);
      // Светящиеся пояса, кондиционеры, пожарные лестницы.
      if (rng() < 0.6) b.box("glow", [face - s * 0.03, 8 + Math.floor(rng() * 4) * 3, cz], [0.05, 0.16, len * 0.96], pick(rng, ACCENTS));
      for (let i = 0; i < 4; i++) b.box("metal", [face - s * 0.28, 6 + rng() * (height - 14), cz + (rng() - 0.5) * len * 0.8], [0.5, 0.45, 0.75], "#3a4452");
      if (rng() < 0.5) for (let f = 6; f < Math.min(height - 8, 22); f += 3.2) {
        b.box("metal", [face - s * 0.5, f, cz], [1.0, 0.06, len * 0.4], "#2e3744");
        b.box("metal", [face - s * 0.98, f + 0.5, cz], [0.04, 1.0, len * 0.4], "#2e3744");
      }
      // Вертикальная вывеска-«лопатка» поперёк улицы — видна издалека.
      if (rng() < 0.7) {
        const sz = cz + len * 0.35;
        const signH = 4 + rng() * 3;
        const sy = 5.4 + rng() * 5 + signH / 2;
        b.box("metal", [face - s * 0.7, sy + signH / 2 + 0.2, sz], [1.4, 0.08, 0.08], "#2a3240");
        b.box("metal", [face - s * 1.15, sy, sz - 0.02], [signH / 4 + 0.2, signH + 0.2, 0.08], "#0b0f15");
        b.sign("neon", pick(rng, NEON.vertical), [face - s * 1.15, sy, sz + 0.03], [signH / 4, signH]);
      }
      // Большой экран на фасаде, развёрнутый к камере.
      if (rng() < 0.3 && height > 30) {
        const sy = 15 + rng() * 8;
        b.box("metal", [face - s * 0.4, sy, cz], [0.25, 4.4, Math.min(len - 1, 8.4)], "#0b0f15");
        b.sign("ads", pick(rng, [SCREENS.surfers, SCREENS.graph, SCREENS.formula, SCREENS.exam, SCREENS.coffee]), [face - s * 0.55, sy, cz], [Math.min(len - 1.4, 8), Math.min(len - 1.4, 8) / 2], toTrack);
      }
      b.box("beacon", [x, height - 7.6, cz], [0.5, 0.5, 0.5], NIGHT.red);
      z -= len + 1.2 + rng() * 1.8;
    }
  }
  // Гирлянды через улицу: провис из трёх отрезков и лампочки.
  for (const z of [-8, -20, -32, -44]) {
    const y = 10.5 + rng() * 1.5;
    const pts: Vec3[] = [[-front, y, z], [-front * 0.4, y - 1.4, z + 0.5], [front * 0.4, y - 1.4, z + 0.5], [front, y + 0.4, z]];
    for (let i = 0; i < 3; i++) b.beam("metal", pts[i], pts[i + 1], 0.03, "#2a3240");
    for (let i = 0; i < 3; i++) for (let k = 0; k < 6; k++) {
      const t = (k + 0.5) / 6;
      const p = pts[i].map((v, j) => v + (pts[i + 1][j] - v) * t) as Vec3;
      b.box("glow", [p[0], p[1] - 0.12, p[2]], [0.13, 0.13, 0.13], ACCENTS[(i * 6 + k) % ACCENTS.length]);
    }
  }
  if (variant === 0) {
    // Неоновые ворота квартала над трассой.
    b.box("metal", [0, 9.2, -4], [front * 2, 0.4, 0.4], "#2a3240");
    b.box("metal", [0, 7.6, -4], [6.4, 2.8, 0.14], "#0b0f15");
    b.sign("ads", SCREENS.canyon, [0, 7.6, -3.92], [6.2, 3.1]);
    b.sign("neon", NEON.horizontal[6], [0, 5.6, -3.9], [5, 1.25]);
  }
}

/* ──────────────────────────── Тоннель ──────────────────────────── */

function gallery(b: NightBuilder, H: number, rng: Rng, variant: number, props: Shape[]) {
  const wallX = H + 9.6;
  const profile = (s: number): Vec3[] => [[s * (wallX - 0.2), -0.3, 0], [s * wallX, 5.2, 0], [s * (H + 5.4), 10.8, 0], [0, 12, 0]];
  for (const s of [-1, 1]) {
    deck(b, H, s);
    const p = profile(s);
    // Рёбра с бегущим светом по внутренней кромке.
    for (let z = -3; z > -48; z -= 6) {
      for (let i = 0; i < 3; i++) {
        b.beam("metal", [p[i][0], p[i][1], z], [p[i + 1][0], p[i + 1][1], z], 0.55, "#26313f", 0.45);
        const inset = (v: Vec3): Vec3 => [v[0] - s * 0.34 * (i < 2 ? 1 : 0.6), v[1] - (i === 0 ? 0 : 0.3), z];
        b.beam("pulse", inset(p[i]), inset(p[i + 1]), 0.07, NIGHT.cyan, 0.08);
      }
    }
    // Стены между рёбрами: панели, световые прорези, «зебра», вентиляторы; часть пролётов — окна наружу.
    let bay = 0;
    for (let z = -6; z > -48; z -= 6, bay++) {
      const cz = z + 3;
      const window = (bay + Math.floor(rng() * 2)) % 3 === 0;
      if (window) {
        b.box("metal", [s * wallX, 1.0, cz], [0.3, 0.2, 5.4], "#2f3b4a");
        b.box("metal", [s * wallX, 4.6, cz], [0.3, 0.2, 5.4], "#2f3b4a");
        b.box("glow", [s * (wallX - 0.18), 4.45, cz], [0.03, 0.04, 5.2], NIGHT.amber);
      } else {
        b.box("metal", [s * (wallX + 0.05), 2.5, cz], [0.18, 5.3, 5.5], "#1c2532");
        b.box("glow", [s * (wallX - 0.08), 3.7, cz], [0.03, 0.12, 4.2], rng() < 0.7 ? NIGHT.cyan : NIGHT.amber);
        for (let k = 0; k < 14; k++) b.box("solid", [s * (wallX - 0.07), 0.45, cz - 2.6 + k * 0.4], [0.03, 0.5, 0.2], k % 2 ? "#14161c" : "#e8b23a", [s * 0.6, 0, 0]);
        if (rng() < 0.5) {
          b.cylinder("metal", [s * (wallX - 0.12), 2.3, cz], [1.9, 0.18, 1.9], "#2f3b4a", [0, 0, Math.PI / 2]);
          b.shape("glow", SHAPES.ring, [s * (wallX - 0.24), 2.3, cz], [2, 2, 1.4], "#3fa7a0", [0, Math.PI / 2, 0]);
          for (const r of [0, Math.PI / 2]) b.box("metal", [s * (wallX - 0.26), 2.3, cz], [0.04, 1.7, 0.16], "#5a6878", [r, 0, 0]);
        } else {
          b.rounded("metal", [s * (wallX - 0.12), 2.2, cz], [0.14, 1.3, 2.2], "#2a3442");
          for (let k = 0; k < 6; k++) b.box("metal", [s * (wallX - 0.2), 1.7 + k * 0.2, cz], [0.03, 0.04, 2.0], "#11161e");
        }
      }
      // Кровля пролёта: два ската.
      b.beam("solid", [p[1][0], p[1][1] + 0.3, cz], [p[2][0], p[2][1] + 0.3, cz], 0.2, "#151c27", 5.6);
      b.beam("solid", [p[2][0], p[2][1] + 0.3, cz], [p[3][0], p[3][1] + 0.3, cz], 0.2, "#151c27", 5.6);
      if (props[0] && rng() < 0.4) b.shape("solid", props[0], [s * (H + 3.4), 0.05, cz], [1.4, 1.4, 1.4], pick(rng, ["#7a4a3a", "#3a5a7a", "#6a6a3a"]), [0, rng() < 0.5 ? 0 : Math.PI / 2, 0]);
    }
    // Трубы и лотки с кабелями вдоль стен.
    for (const [y, r, color] of [[1.2, 0.5, "#3a4656"], [1.9, 0.34, "#5a4436"], [6.4, 0.3, "#3a4656"]] as const) {
      const x = s * (wallX - 0.45 - r / 2);
      b.cylinder("metal", [x, y, -24], [r, 48, r], color, [Math.PI / 2, 0, 0]);
      for (let z = -1.5; z > -48; z -= 6) b.cylinder("metal", [x, y, z], [r + 0.12, 0.2, r + 0.12], "#56657a", [Math.PI / 2, 0, 0]);
    }
    b.box("metal", [s * (wallX - 0.6), 5.6, -24], [0.9, 0.08, 48], "#2a3442");
    for (let k = 0; k < 4; k++) b.cylinder("solid", [s * (wallX - 0.35 - k * 0.18), 5.7, -24], [0.1, 48, 0.1], pick(rng, ["#202a36", "#5a2a2a", "#2a4a5a", "#2a2a2a"]), [Math.PI / 2, 0, 0]);
    b.box("pulse", [s * (H + 5.2), 10.2, -24], [0.12, 0.05, 48], NIGHT.violet);
  }
  b.box("pulse", [0, 11.6, -24], [0.3, 0.05, 48], NIGHT.cyan);
  if (variant !== 1) {
    // Портал тоннеля: толстая рамка по профилю и табличка.
    const z = variant === 0 ? -0.5 : -47.5;
    for (const s of [-1, 1]) {
      const p = profile(s);
      for (let i = 0; i < 3; i++) {
        b.beam("solid", [p[i][0] + s * 0.6, p[i][1] + 0.6, z], [p[i + 1][0] + s * 0.6, p[i + 1][1] + 0.6, z], 1.6, "#1e2733", 1.4);
        b.beam("glow", [p[i][0] - s * 0.25, p[i][1], z + 0.72], [p[i + 1][0] - s * 0.25, p[i + 1][1], z + 0.72], 0.12, NIGHT.amber, 0.04);
      }
    }
    if (variant === 0) {
      b.box("metal", [0, 9.2, z + 0.7], [5.6, 2.6, 0.12], "#0b0f15");
      b.sign("ads", SCREENS.tunnel, [0, 9.2, z + 0.78], [5.4, 2.7]);
    }
  }
}

function segmentGeometry(type: District, variant: number, H: number, props: Shape[]): NightGeometry {
  const b = new NightBuilder();
  const rng = createRng(1000 + TYPES.indexOf(type) * 17 + variant * 131);
  if (type === "station") station(b, H, rng, variant, props);
  else if (type === "viaduct") viaduct(b, H, rng, variant);
  else if (type === "canyon") canyon(b, H, rng, variant);
  else gallery(b, H, rng, variant, props);
  return b.build();
}

/** Модули станции Kenney (контейнер, пульт) — одной геометрией каждый. */
function useProps() {
  const kit = useGLTF(`${import.meta.env.BASE_URL}models/night/station-props.glb`);
  return useMemo(() => {
    const list: Shape[] = [];
    kit.scene.updateMatrixWorld(true);
    for (const root of kit.scene.children) {
      const pieces: ReturnType<Mesh["geometry"]["clone"]>[] = [];
      root.traverse(node => { if ((node as Mesh).isMesh) {
        const mesh = node as Mesh; let g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        if (g.index) { const flat = g.toNonIndexed(); g.dispose(); g = flat; }
        for (const key of Object.keys(g.attributes)) if (!["position", "normal"].includes(key)) g.deleteAttribute(key);
        pieces.push(g);
      } });
      if (pieces.length) { const merged = mergeGeometries(pieces)!; list.push(toShape(merged)); merged.dispose(); pieces.forEach(g => g.dispose()); }
    }
    return list;
  }, [kit]);
}

/**
 * Районы вдоль трассы: станция, виадук, неоновый квартал, тоннель — по три
 * сегмента (въезд, середина, выезд). Геометрия каждого варианта строится один
 * раз. У слота пула по одному мешу на канал материала: переехав вперёд, слот
 * просто берёт геометрию нужного варианта. Раньше в каждом слоте лежали все
 * двенадцать вариантов, и сцена каждый кадр пересчитывала сотни скрытых мешей.
 */
/** Районы только принимают тени: отбрасывают их байк, ворота и роботы, а огромные сегменты в карте теней — лишняя цена. */
export function Districts({ materials, tier, shadows }: { materials: NightMaterials; tier: "low" | "medium" | "high"; shadows: boolean }) {
  const runtime = useRuntime();
  const props = useProps();
  const H = runtime.lanes * LANE_WIDTH / 2;
  const variants = useMemo(() => TYPES.flatMap(type => [0, 1, 2].map(variant => segmentGeometry(type, variant, H, tier === "low" ? [] : props))), [H, tier, props]);
  const channels = useMemo(() => [...new Set(variants.flatMap(v => [...v.keys()]))].filter(channel => materials[channel]), [variants, materials]);
  const slots = useRef<(Group | null)[]>([]);
  const count = tier === "low" ? 5 : tier === "medium" ? 6 : 7;
  // Какой вариант сейчас в слоте; сбрасывается вместе с набором мешей.
  const shown = useMemo(() => Array.from({ length: count }, () => -1), [count, channels]);
  useEffect(() => () => variants.forEach(v => v.forEach(g => g.dispose())), [variants]);
  useFrame(() => {
    const origin = Math.floor(runtime.distance / SEGMENT);
    slots.current.forEach((slot, i) => {
      if (!slot) return;
      const at = (origin - 1 + i) * SEGMENT;
      slot.position.z = runtime.distance - at;
      const variant = TYPES.indexOf(districtAt(at)) * SPAN + variantAt(at);
      if (shown[i] === variant) return;
      shown[i] = variant;
      slot.children.forEach((child, j) => {
        const geometry = variants[variant].get(channels[j]);
        child.visible = Boolean(geometry);
        if (geometry) (child as Mesh).geometry = geometry;
      });
    });
  });
  return <><GraffitiTrail night />{Array.from({ length: count }, (_, i) => <group key={i} ref={node => { slots.current[i] = node; }}>
    {channels.map(channel => <mesh key={channel} visible={false} material={materials[channel]} receiveShadow={shadows && SOLID_CHANNELS.has(channel)} dispose={null} />)}
  </group>)}</>;
}
