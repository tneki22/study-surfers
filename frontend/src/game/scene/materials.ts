import { MeshBasicMaterial, MeshStandardMaterial, type WebGLProgramParametersWithUniforms } from "three";
import type { Channel } from "./kit/batch";
import { adsTexture } from "./textures";

/*
 * Общие материалы окружения. Цвет — в вершинах (см. kit/batch), поэтому на
 * весь город хватает пары материалов. Время и «сумерки» — общие униформы:
 * их двигает игровой цикл.
 */

export const sceneUniforms = {
  uTime: { value: 0 },
  /** 0 днём, 1 на закате: загораются окна. */
  uDusk: { value: 0 },
};

/** Окна рисуются на гранях домов шейдером: сетка по метрам фасада, рамы, подоконники, свет по вечерам. */
const FACADE_VERTEX_PARS = /* glsl */ `
attribute vec2 facadeUv;
attribute vec4 facade;
attribute vec2 extent;
varying vec2 vFacadeUv;
varying vec4 vFacade;
varying vec2 vExtent;
`;

const FACADE_FRAGMENT_PARS = /* glsl */ `
uniform float uDusk;
varying vec2 vFacadeUv;
varying vec4 vFacade;
varying vec2 vExtent;
float facadeHash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
`;

const FACADE_COLOR = /* glsl */ `
float winMask = 0.0;
float winLit = 0.0;
if (vFacade.z > 0.5) {
  float spacing = vFacade.x;
  float floorH = vFacade.y;
  float style = vFacade.z;
  vec2 p = vFacadeUv;
  float base = 0.9;
  float cols = max(1.0, floor((vExtent.x * 2.0 - 0.9) / spacing));
  float cx = (p.x + cols * spacing * 0.5) / spacing;
  float rows = floor((vExtent.y - base - 0.7) / floorH);
  float cy = (p.y - base) / floorH;
  vec2 cell = floor(vec2(cx, cy));
  vec2 f = fract(vec2(cx, cy));
  if (cell.x >= 0.0 && cell.x < cols && cell.y >= 0.0 && cell.y < rows) {
    vec2 lo = vec2(0.24, 0.26);
    vec2 hi = vec2(0.76, 0.84);
    if (style > 2.5) { lo = vec2(0.0, 0.3); hi = vec2(1.0, 0.8); }
    else if (style > 1.5 && cell.y < 0.5) { lo = vec2(0.07, 0.04); hi = vec2(0.93, 0.86); }
    vec2 inWin = step(lo, f) * step(f, hi);
    winMask = inWin.x * inWin.y;
    vec2 inFrame = step(lo - 0.05, f) * step(f, hi + 0.05);
    float frame = inFrame.x * inFrame.y * (1.0 - winMask);
    float sill = step(lo.x - 0.08, f.x) * step(f.x, hi.x + 0.08) * step(lo.y - 0.11, f.y) * step(f.y, lo.y - 0.05);
    if (style > 2.5) { frame = 0.0; sill = 0.0; }
    float trimMask = max(frame, sill);
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb, vec3(0.95, 0.93, 0.9), 0.7), trimMask);
    float h = facadeHash(cell + vFacade.w * 7.31);
    float g = clamp((f.y - lo.y) / (hi.y - lo.y), 0.0, 1.0);
    vec3 glass = mix(vec3(0.035, 0.075, 0.14), vec3(0.36, 0.55, 0.78), g * g * 0.85);
    // Шторы и жалюзи в части окон — фасад не выглядит копипастой.
    glass = mix(glass, vec3(0.62, 0.52, 0.42) * (0.7 + 0.3 * g), step(0.82, h) * step(f.y, mix(lo.y, hi.y, 0.55 + 0.4 * fract(h * 13.0))));
    diffuseColor.rgb = mix(diffuseColor.rgb, glass, winMask);
    winLit = step(0.5, fract(h * 7.0)) * winMask;
  }
}
`;

function withFacade(material: MeshStandardMaterial): MeshStandardMaterial {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uDusk = sceneUniforms.uDusk;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${FACADE_VERTEX_PARS}`)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFacadeUv = facadeUv;\nvFacade = facade;\nvExtent = extent;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FACADE_FRAGMENT_PARS}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${FACADE_COLOR}`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.08, winMask);")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.35, winMask);")
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance += winLit * uDusk * vec3(1.0, 0.6, 0.26) * 1.8;",
      );
  };
  material.customProgramCacheKey = () => "ss-facade";
  return material;
}

/** Листва чуть качается от ветра: смещение растёт с высотой над землёй. */
function withSway(material: MeshStandardMaterial): MeshStandardMaterial {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uTime = sceneUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
float swayPhase = uTime * 1.7 + position.x * 0.31 + position.z * 0.23;
float swayAmount = max(0.0, position.y - 1.5) * 0.03;
transformed.x += sin(swayPhase) * swayAmount;
transformed.z += cos(swayPhase * 0.8) * swayAmount * 0.6;`,
      );
  };
  material.customProgramCacheKey = () => "ss-sway";
  return material;
}

export const glowMaterial = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });

export const CHANNEL_MATERIALS: Record<Channel, MeshStandardMaterial | MeshBasicMaterial> = {
  solid: new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
  facade: withFacade(new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 })),
  glass: new MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.6 }),
  glow: glowMaterial,
  leaf: withSway(new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 })),
  metal: new MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.75 }),
  ads: new MeshStandardMaterial({ roughness: 0.55, metalness: 0, emissive: "#ffffff", emissiveIntensity: 0.25 }),
};

/** Текстуры с надписями рисуются после загрузки шрифта — поэтому не при импорте модуля. */
export function prepareSceneMaterials() {
  const ads = CHANNEL_MATERIALS.ads as MeshStandardMaterial;
  if (ads.map) return;
  ads.map = adsTexture();
  ads.emissiveMap = ads.map;
  ads.needsUpdate = true;
}

/** Фонари и вывески ярче к вечеру — блум делает из них ореолы. */
export function updateSceneMaterials(time: number, dusk: number) {
  sceneUniforms.uTime.value = time;
  sceneUniforms.uDusk.value = dusk;
  glowMaterial.color.setScalar(1.15 + dusk * 2.4);
  (CHANNEL_MATERIALS.ads as MeshStandardMaterial).emissiveIntensity = 0.25 + dusk * 0.9;
}
