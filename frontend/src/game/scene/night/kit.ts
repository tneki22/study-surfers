import {
  AdditiveBlending, CapsuleGeometry, Color, CylinderGeometry, DoubleSide, Euler, MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial, Quaternion, SphereGeometry, Vector3,
  type BufferGeometry, type Texture, type WebGLProgramParametersWithUniforms,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { Batch, SHAPES, toShape, type FacadeSpec, type NightChannel, type Shape } from "../kit/batch";

export const NIGHT = {
  dark: "#0d131c", metal: "#2f3d4c", pale: "#c4d2dc", cyan: "#55d6cc", amber: "#ffb35c", red: "#ff4a5a",
  magenta: "#ff4fb4", violet: "#8f6bff", ice: "#bfe8ff", warm: "#ffd3a0",
};

/** Ось линии маглевов от края магистрали (полуширины треков). */
export const TRAIN_OFFSET = 6.6;

/** Небо и туман: туман совпадает с горизонтом, поэтому дальние детали растворяются в небе. */
export const NIGHT_SKY = {
  zenith: "#02030a", upper: "#0a0b25", horizon: "#24183f", glow: "#5e2652", fog: "#171429",
};

/** Текущий цвет тумана: его ведёт DistrictLight, небо и дальние башни подстраивают горизонт. */
export const nightFog = new Color(NIGHT_SKY.fog);

/**
 * Общие униформы ночного мира. Их двигает NightScene раз за кадр:
 * время, пройденный путь (рисунки «приклеены» к трассе) и «поток»
 * для огней, которые бегут вперёд быстрее байка.
 */
export const nightUniforms = {
  uTime: { value: 0 },
  uDistance: { value: 0 },
  uFlow: { value: 0 },
  /** 0 при «меньше движения»: бегущие огни и мерцание замирают. */
  uMotion: { value: 1 },
};

// Мелкие детали — экономные формы: сотни людей и скамеек не должны стоить сотни тысяч треугольников.
const rounded = toShape(new RoundedBoxGeometry(1, 1, 1, 1, 0.08));
const softRounded = toShape(new RoundedBoxGeometry(1, 1, 1, 2, 0.22));
const ball = toShape(new SphereGeometry(1, 12, 8));
const bead = toShape(new SphereGeometry(1, 7, 5));
const capsule = toShape(new CapsuleGeometry(0.5, 1, 3, 10));
const tube = toShape(new CylinderGeometry(0.5, 0.5, 1, 10, 1, true));
const disc = toShape(new CylinderGeometry(0.5, 0.5, 1, 18));
type Vec3 = [number, number, number];
const Y = new Vector3(0, 1, 0);

/** Детали запекаются в несколько мешей: одинаковая геометрия не создаёт сотни draw calls. */
export class NightBuilder extends Batch<NightChannel> {
  private q = new Quaternion();
  private e = new Euler();
  private d = new Vector3();

  box(channel: NightChannel, position: Vec3, scale: Vec3, color: string, rotation?: Vec3) {
    this.add(channel, SHAPES.box, position, scale, { color, ground: false, rotation });
  }
  rounded(channel: NightChannel, position: Vec3, scale: Vec3, color: string, rotation?: Vec3) {
    this.add(channel, rounded, position, scale, { color, ground: false, rotation });
  }
  soft(channel: NightChannel, position: Vec3, scale: Vec3, color: string, rotation?: Vec3) {
    this.add(channel, softRounded, position, scale, { color, ground: false, rotation });
  }
  sphere(channel: NightChannel, position: Vec3, scale: Vec3, color: string, rotation?: Vec3) {
    this.add(channel, ball, position, scale, { color, ground: false, rotation });
  }
  /** Капсула вдоль Y (полная высота — 2 × scale[1]): руки, ноги, корпус пилота. */
  limb(channel: NightChannel, position: Vec3, scale: Vec3, color: string, rotation?: Vec3) {
    this.add(channel, capsule, position, scale, { color, ground: false, rotation });
  }
  /** Капсула с круглыми концами от точки a до точки b: кости пилота. */
  bone(channel: NightChannel, a: Vec3, b: Vec3, radius: number, color: string) {
    this.d.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const length = this.d.length();
    this.q.setFromUnitVectors(Y, this.d.normalize());
    this.e.setFromQuaternion(this.q);
    const shape = toShape(new CapsuleGeometry(radius, Math.max(0.001, length), 3, 10));
    this.add(channel, shape, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], [1, 1, 1], {
      color, ground: false, rotation: [this.e.x, this.e.y, this.e.z],
    });
  }
  /** Маленькая сфера: головы, плафоны. */
  bead(channel: NightChannel, position: Vec3, scale: Vec3, color: string) {
    this.add(channel, bead, position, scale, { color, ground: false });
  }
  /** Цилиндр вдоль оси Y; поворотом кладётся вдоль трассы ([π/2, 0, 0]). */
  cylinder(channel: NightChannel, position: Vec3, scale: Vec3, color: string, rotation?: Vec3, open = false) {
    this.add(channel, open ? tube : disc, position, scale, { color, ground: false, rotation });
  }
  shape(channel: NightChannel, shape: Shape, position: Vec3, scale: Vec3, color: string, rotation?: Vec3) {
    this.add(channel, shape, position, scale, { color, ground: false, rotation });
  }
  /** Брус от точки a до точки b: тросы, фермы, рёбра арок. */
  beam(channel: NightChannel, a: Vec3, b: Vec3, thickness: number, color: string, depth = thickness) {
    this.d.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const length = this.d.length();
    this.q.setFromUnitVectors(Y, this.d.normalize());
    this.e.setFromQuaternion(this.q);
    this.add(channel, SHAPES.box, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], [thickness, length, depth], {
      color, ground: false, rotation: [this.e.x, this.e.y, this.e.z],
    });
  }
  /** Плоскость с куском атласа: экраны (ads) и неоновые вывески (neon). */
  sign(channel: "ads" | "neon", rect: [number, number, number, number], position: Vec3, size: [number, number], rotationY = 0, color = "#ffffff") {
    this.add(channel, SHAPES.plane, position, [size[0], size[1], 1], { color, ground: false, rotation: [0, rotationY, 0], uvRect: rect });
  }
  /** Дом с окнами из шейдера: центр основания (x, y0, z). */
  facade(position: Vec3, scale: Vec3, color: string, spec: FacadeSpec) {
    this.add("facade", SHAPES.box, [position[0], position[1] + scale[1] / 2, position[2]], scale, { color, ground: false, facade: spec });
  }
}

/** Окна ночного фасада: сетка по метрам, часть окон горит тёплым, часть холодным, редкие мерцают. */
export const NIGHT_WINDOW_GLSL = /* glsl */ `
float nightHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// lod 0…1: насколько окна мельче пикселя; вдали сетка сливается в средний тон вместо ряби.
vec4 nightWindowLod(vec2 p, vec4 spec) {
  vec2 cells = fwidth(p) / max(vec2(spec.x, spec.y), vec2(0.1));
  return vec4(clamp(max(cells.x, cells.y) * 2.2 - 0.35, 0.0, 1.0));
}
vec4 nightWindow(vec2 p, vec4 spec, vec2 extent, float time, float lod) {
  float style = spec.z;
  if (style < 0.5) return vec4(0.0);
  float spacing = spec.x;
  float floorH = spec.y;
  float cols = max(1.0, floor((extent.x * 2.0 - 0.6) / spacing));
  float cx = (p.x + cols * spacing * 0.5) / spacing;
  float cy = (p.y - 1.2) / floorH;
  vec2 cell = floor(vec2(cx, cy));
  vec2 f = fract(vec2(cx, cy));
  float rows = floor((extent.y - 2.0) / floorH);
  if (cell.x < 0.0 || cell.x >= cols || cell.y < 0.0 || cell.y >= rows) return vec4(0.0);
  vec2 lo = vec2(0.2, 0.24);
  vec2 hi = vec2(0.8, 0.82);
  if (style > 2.5) { lo = vec2(-0.01, 0.3); hi = vec2(1.01, 0.72); }
  else if (style > 1.5) { lo = vec2(0.07, 0.12); hi = vec2(0.93, 0.9); }
  vec2 inside = step(lo, f) * step(f, hi);
  float mask = inside.x * inside.y;
  float h = nightHash(cell + spec.w * 13.17);
  float tint = nightHash(cell.yx * 1.31 + spec.w * 7.7 + 3.0);
  float lit = step(0.46, h) * step(0.16, nightHash(vec2(cell.y, spec.w)));
  vec3 color = tint < 0.55 ? vec3(1.0, 0.62, 0.3) : tint < 0.8 ? vec3(0.5, 0.85, 1.0) : tint < 0.92 ? vec3(0.95, 0.92, 1.0) : vec3(1.0, 0.32, 0.72);
  if (style > 2.5) { color = mix(vec3(0.35, 0.8, 1.0), vec3(1.0, 0.35, 0.75), step(0.7, nightHash(vec2(cell.y, spec.w + 1.0)))); lit = step(0.25, nightHash(vec2(cell.y, spec.w + 2.0))); }
  float gradient = 0.6 + 0.4 * smoothstep(lo.y, hi.y, f.y);
  float flicker = 1.0 - step(0.975, tint) * step(0.55, fract(time * 2.3 + h * 9.0));
  vec4 sharp = vec4(color * lit * gradient * flicker * (0.55 + 0.7 * h), mask);
  vec4 blur = vec4(vec3(0.42, 0.34, 0.3) * (style > 2.5 ? 0.9 : 0.55), style > 2.5 ? 0.45 : 0.32);
  return mix(sharp, blur, lod);
}
`;

function grain<M extends MeshStandardMaterial | MeshLambertMaterial>(material: M, key: string) {
  // Микрофактура и следы обработки металла в мировых координатах, без больших текстур.
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vNightWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvNightWorld=(modelMatrix*vec4(transformed,1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vNightWorld;")
      .replace("#include <color_fragment>", `#include <color_fragment>
        float grain=fract(sin(dot(floor(vNightWorld*140.0),vec3(12.9898,78.233,45.164)))*43758.5453);
        float brush=0.5+0.5*sin(vNightWorld.z*76.0+vNightWorld.x*3.0);
        float stain=0.5+0.5*sin(vNightWorld.x*1.2+sin(vNightWorld.z*0.6));
        diffuseColor.rgb*=0.87+grain*0.06+brush*0.035+stain*0.04;
      `);
  };
  material.customProgramCacheKey = () => key;
  return material;
}

/** Мировые координаты фрагмента для Basic-материалов (бегущие огни, маяки). */
function withWorld(material: MeshBasicMaterial, key: string, uniforms: string, body: string) {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, nightUniforms);
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vNightWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvNightWorld=(modelMatrix*vec4(transformed,1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vNightWorld;\nuniform float uTime;\nuniform float uDistance;\nuniform float uFlow;\nuniform float uMotion;\n${uniforms}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${body}`);
  };
  material.customProgramCacheKey = () => key;
  return material;
}

/** Фасад: окна горят всю ночь, стекло в окнах — гладкое. */
function nightFacade<M extends MeshStandardMaterial | MeshLambertMaterial>(material: M) {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uTime = nightUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 facadeUv;\nattribute vec4 facade;\nattribute vec2 extent;\nvarying vec2 vFacadeUv;\nvarying vec4 vFacade;\nvarying vec2 vExtent;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFacadeUv = facadeUv;\nvFacade = facade;\nvExtent = extent;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nuniform float uTime;\nvarying vec2 vFacadeUv;\nvarying vec4 vFacade;\nvarying vec2 vExtent;\n${NIGHT_WINDOW_GLSL}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float nightLod = nightWindowLod(vFacadeUv, vFacade).x;
        vec4 nightWin = nightWindow(vFacadeUv, vFacade, vExtent, uTime, nightLod);
        float panel = step(0.5, vFacade.z) * (1.0 - nightWin.a) * smoothstep(0.42, 0.5, abs(fract(vFacadeUv.y / max(vFacade.y, 0.1)) - 0.5));
        diffuseColor.rgb = mix(diffuseColor.rgb * (1.0 + panel * 0.5), vec3(0.025, 0.035, 0.05), nightWin.a);`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, nightWin.a);")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += nightWin.rgb * nightWin.a * 2.2;");
  };
  material.customProgramCacheKey = () => `night-facade-v3-${material.type}`;
  return material;
}

export interface NightTextures { screens: Texture | null; neon: Texture | null }

/** cheap — для низкого качества: Lambert вместо PBR, без отражений окружения. */
export function nightMaterials(textures: NightTextures = { screens: null, neon: null }, cheap = false) {
  const glowColor = new Color(1.8, 1.8, 1.8);
  const lit = (roughness: number, metalness: number, envMapIntensity = 1) => cheap
    ? new MeshLambertMaterial({ vertexColors: true })
    : new MeshStandardMaterial({ vertexColors: true, roughness, metalness, envMapIntensity });
  const materials = {
    solid: grain(lit(0.58, 0.28), cheap ? "night-solid-lambert" : "night-solid-v2"),
    metal: grain(lit(0.3, 0.82), cheap ? "night-metal-lambert" : "night-metal-v2"),
    glass: lit(0.06, 0.9, 1.5),
    glow: new MeshBasicMaterial({ vertexColors: true, color: glowColor, toneMapped: false }),
    facade: nightFacade(lit(0.72, 0.22)),
    ads: withWorld(new MeshBasicMaterial({ vertexColors: true, map: textures.screens, color: new Color(1.35, 1.35, 1.35), toneMapped: false }), "night-ads-v1", "",
      // Экраны: тонкая строчная развёртка и редкий сбой кадра.
      `#ifdef USE_MAP
        float scan = 0.94 + 0.06 * sin(vMapUv.y * 700.0 - uTime * 6.0 * uMotion);
        float glitch = step(0.985, fract(sin(floor(uTime * 9.0) * 12.9 + floor(vMapUv.y * 6.0)) * 437.5)) * uMotion;
        diffuseColor.rgb *= scan * (1.0 + glitch * 0.6);
      #endif`),
    neon: withWorld(new MeshBasicMaterial({
      vertexColors: true, map: textures.neon, color: new Color(2.3, 2.3, 2.3), toneMapped: false,
      transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide,
    }), "night-neon-v1", "",
      // Неон вспыхивает при включении и изредка «моргает» отдельными вывесками.
      `#ifdef USE_MAP
        float signId = floor(vMapUv.x * 4.0) + floor(vMapUv.y * 8.0) * 4.0 + floor((uDistance - vNightWorld.z) * 0.05);
        float stutter = step(0.7, fract(signId * 0.618)) * step(0.9, fract(sin(signId * 91.7 + floor(uTime * 14.0)) * 437.5));
        diffuseColor.rgb *= 1.0 - stutter * 0.8 * uMotion;
      #endif`),
    // Бегущие огни: волна света уходит вперёд по трассе быстрее байка.
    pulse: withWorld(new MeshBasicMaterial({ vertexColors: true, color: glowColor, toneMapped: false }), "night-pulse-v1", "",
      `float pulseS = uDistance - vNightWorld.z;
       float pulseWave = fract((pulseS - uFlow * 1.6) * 0.045);
       diffuseColor.rgb *= mix(1.0, 0.55 + 1.6 * pow(1.0 - pulseWave, 10.0) + 0.5 * pow(1.0 - pulseWave, 2.0), uMotion);`),
    // Маяки на крышах и мачтах мигают каждый в своей фазе.
    beacon: withWorld(new MeshBasicMaterial({ vertexColors: true, color: new Color(2.6, 2.6, 2.6), toneMapped: false }), "night-beacon-v1", "",
      `float beaconPhase = fract(uTime * 0.55 + vNightWorld.x * 0.137 + vNightWorld.y * 0.071 + (uDistance - vNightWorld.z) * 0.013);
       diffuseColor.rgb *= mix(1.0, 0.12 + 1.6 * smoothstep(0.78, 0.82, beaconPhase) * (1.0 - smoothstep(0.92, 0.98, beaconPhase)), uMotion);`),
  };
  return materials;
}
export type NightMaterials = ReturnType<typeof nightMaterials>;
export type NightGeometry = Map<NightChannel, BufferGeometry>;
