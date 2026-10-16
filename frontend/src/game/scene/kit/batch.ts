import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  IcosahedronGeometry,
  Matrix3,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";

/*
 * Сборка окружения в несколько больших мешей. Каждая деталь — копия базовой
 * формы с матрицей и цветом в вершинах; детали одного материала («канала»)
 * сливаются в одну геометрию. Сегмент трассы с сотнями деталей рисуется
 * за 5–6 вызовов вместо сотен.
 */

export interface Shape {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  /** Для куба: номер грани у каждой вершины (px, nx, py, ny, pz, nz). */
  face: Uint8Array | null;
}

export function toShape(source: BufferGeometry, boxFaces = false): Shape {
  const geometry = source.index ? source.toNonIndexed() : source;
  const count = geometry.attributes.position.count;
  let face: Uint8Array | null = null;
  if (boxFaces) {
    face = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) face[i] = Math.floor(i / 6);
  }
  return {
    position: geometry.attributes.position.array as Float32Array,
    normal: geometry.attributes.normal.array as Float32Array,
    uv: (geometry.attributes.uv?.array as Float32Array | undefined) ?? new Float32Array(count * 2),
    face,
  };
}

/** Двускатная крыша: ширина 1 по x, глубина 1 по z, высота 1, конёк вдоль z. */
function gableGeometry(): BufferGeometry {
  const v = (x: number, y: number, z: number) => [x, y, z];
  const quads = [
    [v(-0.5, 0, 0.5), v(-0.5, 0, -0.5), v(0, 1, -0.5), v(0, 1, 0.5)],
    [v(0.5, 0, -0.5), v(0.5, 0, 0.5), v(0, 1, 0.5), v(0, 1, -0.5)],
  ];
  const tris = [
    [v(-0.5, 0, 0.5), v(0.5, 0, 0.5), v(0, 1, 0.5)],
    [v(0.5, 0, -0.5), v(-0.5, 0, -0.5), v(0, 1, -0.5)],
  ];
  const positions: number[] = [];
  for (const [a, b, c, d] of quads) positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (const [a, b, c] of tris) positions.push(...a, ...b, ...c);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

export const SHAPES = {
  box: toShape(new BoxGeometry(1, 1, 1), true),
  cylinder: toShape(new CylinderGeometry(0.5, 0.5, 1, 12)),
  prism: toShape(new CylinderGeometry(0.5, 0.5, 1, 6)),
  trunk: toShape(new CylinderGeometry(0.32, 0.5, 1, 7)),
  cone: toShape(new ConeGeometry(0.5, 1, 9)),
  blob: toShape(new IcosahedronGeometry(1, 1)),
  sphere: toShape(new SphereGeometry(1, 14, 10)),
  dome: toShape(new SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2)),
  ring: toShape(new TorusGeometry(0.5, 0.08, 6, 16)),
  gable: toShape(gableGeometry()),
  plane: toShape(new PlaneGeometry(1, 1)),
};

export type Channel = "solid" | "facade" | "glass" | "glow" | "leaf" | "metal" | "ads";
/** Каналы ночного мира: неон по атласу, бегущие огни и мигающие маяки. */
export type NightChannel = Exclude<Channel, "leaf"> | "neon" | "pulse" | "beacon";
/** Каналы, которым нужна развёртка атласа (uvRect). */
const ATLAS_CHANNELS: ReadonlySet<string> = new Set(["ads", "neon"]);

export interface FacadeSpec {
  /** Шаг окон по горизонтали, м. */
  spacing: number;
  /** Высота этажа, м. */
  floor: number;
  /** 1 — жилые окна, 2 — витрины на первом этаже, 3 — ленточное остекление. */
  style: number;
  seed: number;
}

export interface PieceOptions {
  color: string;
  /** Угол вокруг Y или полный поворот. */
  rotation?: number | [number, number, number];
  /** Затемнять у земли — контактная тень без расчёта освещения. */
  ground?: boolean;
  /** Низ детали темнее верха на эту долю. */
  shade?: number;
  facade?: FacadeSpec;
  /** Для канала ads: какой прямоугольник атласа рекламы натянуть на деталь. */
  uvRect?: [number, number, number, number];
}

type Vec3 = [number, number, number];

interface Part {
  position: number[];
  normal: number[];
  color: number[];
  uv: number[];
  facade: number[];
  extent: number[];
}

const colorCache = new Map<string, Color>();
function linear(color: string): Color {
  let value = colorCache.get(color);
  if (!value) {
    value = new Color(color);
    colorCache.set(color, value);
  }
  return value;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Batch<C extends string = Channel> {
  private parts = new Map<C, Part>();
  private matrix = new Matrix4();
  private normalMatrix = new Matrix3();
  private quaternion = new Quaternion();
  private euler = new Euler();
  private vector = new Vector3();
  private offset = new Vector3();
  private size = new Vector3();

  private part(channel: C): Part {
    let part = this.parts.get(channel);
    if (!part) {
      part = { position: [], normal: [], color: [], uv: [], facade: [], extent: [] };
      this.parts.set(channel, part);
    }
    return part;
  }

  add(channel: C, shape: Shape, position: Vec3, scale: Vec3, options: PieceOptions) {
    const rotation = options.rotation ?? 0;
    if (typeof rotation === "number") this.euler.set(0, rotation, 0);
    else this.euler.set(rotation[0], rotation[1], rotation[2]);
    this.quaternion.setFromEuler(this.euler);
    this.offset.set(position[0], position[1], position[2]);
    this.size.set(scale[0], scale[1], scale[2]);
    this.matrix.compose(this.offset, this.quaternion, this.size);
    this.normalMatrix.getNormalMatrix(this.matrix);

    const part = this.part(channel);
    const base = linear(options.color);
    const count = shape.position.length / 3;
    const start = part.position.length;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < count; i += 1) {
      this.vector.fromArray(shape.position, i * 3).applyMatrix4(this.matrix);
      part.position.push(this.vector.x, this.vector.y, this.vector.z);
      minY = Math.min(minY, this.vector.y);
      maxY = Math.max(maxY, this.vector.y);
      this.vector.fromArray(shape.normal, i * 3).applyMatrix3(this.normalMatrix).normalize();
      part.normal.push(this.vector.x, this.vector.y, this.vector.z);
    }

    const ground = options.ground ?? channel !== "glow";
    const shade = options.shade ?? 0;
    const span = Math.max(1e-3, maxY - minY);
    for (let i = 0; i < count; i += 1) {
      const y = part.position[start + i * 3 + 1];
      let factor = 1;
      if (ground) factor *= 0.66 + 0.34 * smoothstep(0, 1.8, y);
      if (shade) factor *= 1 - shade * (1 - (y - minY) / span);
      part.color.push(base.r * factor, base.g * factor, base.b * factor);
    }

    if (ATLAS_CHANNELS.has(channel)) {
      const [u0, v0, u1, v1] = options.uvRect ?? [0, 0, 1, 1];
      for (let i = 0; i < count; i += 1) {
        part.uv.push(u0 + shape.uv[i * 2] * (u1 - u0), v0 + shape.uv[i * 2 + 1] * (v1 - v0));
      }
    }

    if (channel === "facade") {
      const facade = options.facade;
      for (let i = 0; i < count; i += 1) {
        const face = shape.face ? shape.face[i] : 2;
        // Окна только на боковых гранях куба: px/nx — ширина по z, pz/nz — по x.
        const width = face <= 1 ? scale[2] : scale[0];
        const walls = face <= 1 || face >= 4;
        const u = shape.uv[i * 2];
        const v = shape.uv[i * 2 + 1];
        part.uv.push((u - 0.5) * width, v * scale[1]);
        part.extent.push(width / 2, scale[1]);
        if (facade && walls) part.facade.push(facade.spacing, facade.floor, facade.style, facade.seed);
        else part.facade.push(1, 1, 0, 0);
      }
    }
  }

  build(): Map<C, BufferGeometry> {
    const result = new Map<C, BufferGeometry>();
    for (const [channel, part] of this.parts) {
      if (!part.position.length) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(new Float32Array(part.position), 3));
      geometry.setAttribute("normal", new BufferAttribute(new Float32Array(part.normal), 3));
      geometry.setAttribute("color", new BufferAttribute(new Float32Array(part.color), 3));
      if (ATLAS_CHANNELS.has(channel)) geometry.setAttribute("uv", new BufferAttribute(new Float32Array(part.uv), 2));
      if (channel === "facade") {
        geometry.setAttribute("facadeUv", new BufferAttribute(new Float32Array(part.uv), 2));
        geometry.setAttribute("facade", new BufferAttribute(new Float32Array(part.facade), 4));
        geometry.setAttribute("extent", new BufferAttribute(new Float32Array(part.extent), 2));
      }
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      result.set(channel, geometry);
    }
    return result;
  }
}
