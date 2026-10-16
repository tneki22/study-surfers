import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Color, type Group, MeshStandardMaterial, type WebGLProgramParametersWithUniforms } from "three";
import { GROUND_Y, LANE_WIDTH, laneX } from "../../constants";
import { NIGHT_LANE_COLORS } from "../../worlds";
import { useRuntime } from "../context";
import { NIGHT, NightBuilder, nightUniforms, type NightMaterials } from "./kit";
import { NightMesh } from "./NightMesh";

/** Трасса тянется от камеры (и за неё — для облёта на старте) до горизонта. */
const NEAR = 70;
const FAR = -262;
const LENGTH = NEAR - FAR;
const CENTER = (NEAR + FAR) / 2;
/** Шаг повторяющихся деталей: группа с ними сдвигается на остаток пути. */
const PERIOD = 4;

/**
 * Полотно магнитной трассы. Рисунок «приклеен» к пути (uDistance): плитка со
 * швами, тёмная канавка между треками, кромки и осевая полоса в цвет трека,
 * шевроны потока, бегущие вперёд быстрее байка. Трек, на котором байк, светится
 * ярче — так видно, какой ответ сейчас выбран. Под байком — пятно его подсветки.
 */
function laneMaterial(lanes: number) {
  const uniforms = {
    uLanes: { value: lanes },
    uLaneWidth: { value: LANE_WIDTH },
    uLaneColor: { value: Array.from({ length: 4 }, (_, i) => new Color(NIGHT_LANE_COLORS[i])) },
    uLaneGlow: { value: [0, 0, 0, 0] },
    uRunner: { value: new Color() },
    uRunnerX: { value: 0 },
    uRunnerLift: { value: 1 },
  };
  const material = new MeshStandardMaterial({ color: "#121a26", roughness: 0.24, metalness: 0.6, envMapIntensity: 1.3 });
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, nightUniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vLaneWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvLaneWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
      varying vec3 vLaneWorld;
      uniform float uTime; uniform float uDistance; uniform float uFlow; uniform float uMotion;
      uniform float uLanes; uniform float uLaneWidth; uniform vec3 uLaneColor[4]; uniform float uLaneGlow[4];
      uniform vec3 uRunner; uniform float uRunnerX; uniform float uRunnerLift;
      vec3 laneEmissive = vec3(0.0);`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float s = uDistance - vLaneWorld.z;
        float lx = vLaneWorld.x / uLaneWidth + uLanes * 0.5;
        float lane = clamp(floor(lx), 0.0, uLanes - 1.0);
        float fx = lx - lane;
        float d = abs(fx - 0.5);
        int li = int(lane);
        vec3 lc = uLaneColor[0]; float glow = uLaneGlow[0];
        if (li == 1) { lc = uLaneColor[1]; glow = uLaneGlow[1]; }
        else if (li == 2) { lc = uLaneColor[2]; glow = uLaneGlow[2]; }
        else if (li == 3) { lc = uLaneColor[3]; glow = uLaneGlow[3]; }
        // Насколько мелок рисунок на экране: вдали тонкие линии гасим, чтобы не рябили.
        float fw = clamp(fwidth(s) * 1.5, 0.0, 1.0);
        float detail = 1.0 - fw;
        // Плитка со швами и лёгкий разнобой тона панелей.
        vec2 tile = vec2(fx * 3.0, s / 2.0);
        vec2 tf = abs(fract(tile) - 0.5);
        float seam = smoothstep(0.46, 0.5, max(tf.x, tf.y)) * detail;
        float tone = fract(sin(dot(floor(tile), vec2(12.9898, 78.233))) * 43758.5453);
        diffuseColor.rgb *= (0.86 + tone * 0.22) * (1.0 - seam * 0.45);
        // Канавка между треками: тёмная, с тонкой светящейся жилой.
        float groove = smoothstep(0.455, 0.475, d);
        diffuseColor.rgb *= 1.0 - groove * 0.75;
        float vein = smoothstep(0.497, 0.5, d) * (lane > 0.0 || fx > 0.5 ? 1.0 : 0.0) * (lane < uLanes - 1.0 || fx < 0.5 ? 1.0 : 0.0);
        // Кромки и осевая полоса в цвет трека.
        float edge = smoothstep(0.405, 0.42, d) * (1.0 - smoothstep(0.435, 0.45, d));
        float strip = 1.0 - smoothstep(0.018, 0.03, d);
        float stripDash = mix(1.0, step(0.35, fract(s * 0.25)), 0.6);
        // Шевроны потока бегут вперёд (uFlow копит путь байка с запасом).
        float chev = fract((s - uFlow) * 0.28 + d * 1.2);
        float chevMask = smoothstep(0.0, 0.03, chev) * (1.0 - smoothstep(0.07, 0.1, chev)) * step(0.06, d) * (1.0 - smoothstep(0.22, 0.26, d)) * detail;
        // Пятно подсветки под байком.
        float rx = vLaneWorld.x - uRunnerX;
        float pool = exp(-rx * rx * 0.9 - vLaneWorld.z * vLaneWorld.z * 0.12) * uRunnerLift;
        float base = 0.18 + 0.82 * glow;
        laneEmissive = lc * (edge * (0.55 + 1.9 * glow) * mix(0.6, 1.0, detail) + strip * stripDash * base * 0.9 + chevMask * (0.04 + 0.75 * glow))
          + vec3(0.25, 0.7, 0.75) * vein * 0.35 * detail
          + uRunner * pool * 0.55;`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.5, seam + groove * 0.5);")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += laneEmissive;");
  };
  material.customProgramCacheKey = () => "night-lane-v1";
  return { material, uniforms };
}

function staticGeometry(lanes: number) {
  const b = new NightBuilder();
  const H = lanes * LANE_WIDTH / 2;
  b.box("solid", [0, -0.16, CENTER], [2 * H + 1.3, 0.74, LENGTH], "#141b27");
  for (let lane = 0; lane < lanes; lane++) {
    const x = laneX(lane, lanes);
    const color = NIGHT_LANE_COLORS[lane];
    for (const side of [-1, 1]) {
      // Магнитные рельсы по краям трека: тёмный профиль и светящаяся грань в цвет трека.
      b.box("metal", [x + side * 1.12, GROUND_Y + 0.05, CENTER], [0.13, 0.12, LENGTH], "#1c2532");
      b.box("glow", [x + side * 1.06, GROUND_Y + 0.105, CENTER], [0.025, 0.018, LENGTH], color);
    }
  }
  for (const side of [-1, 1]) {
    // Отбойник: стенка, скруглённый верх, бегущая полоса света на внутренней грани.
    b.box("metal", [side * (H + 0.46), 0.42, CENTER], [0.3, 0.84, LENGTH], "#202a38");
    b.rounded("solid", [side * (H + 0.46), 0.88, CENTER], [0.44, 0.1, LENGTH], "#3a4a5c");
    b.box("pulse", [side * (H + 0.3), 0.6, CENTER], [0.02, 0.05, LENGTH], side < 0 ? NIGHT.cyan : NIGHT.magenta);
    b.box("glow", [side * (H + 0.3), 0.3, CENTER], [0.02, 0.02, LENGTH], "#2b4a66");
  }
  return b.build();
}

function periodicGeometry(lanes: number) {
  const b = new NightBuilder();
  const H = lanes * LANE_WIDTH / 2;
  for (let z = NEAR; z > FAR; z -= PERIOD) {
    for (let lane = 0; lane < lanes; lane++) {
      const x = laneX(lane, lanes);
      // Катушки подвеса на внешней стороне рельсов.
      for (const side of [-1, 1]) b.box("metal", [x + side * 1.2, GROUND_Y + 0.02, z - 1], [0.07, 0.07, 0.9], "#41505f");
    }
    for (const side of [-1, 1]) {
      b.box("metal", [side * (H + 0.47), 0.48, z], [0.36, 0.92, 0.14], "#2c3848");
      b.box("glow", [side * (H + 0.29), 0.74, z], [0.02, 0.07, 0.07], NIGHT.amber);
    }
    b.box("metal", [0, -0.7, z - 2], [2 * H + 1.1, 0.4, 0.35], "#121925");
  }
  return b.build();
}

export function Guideway({ materials, shadows }: { materials: NightMaterials; shadows: boolean }) {
  const runtime = useRuntime();
  const lanes = runtime.lanes;
  const fixed = useMemo(() => staticGeometry(lanes), [lanes]);
  const repeated = useMemo(() => periodicGeometry(lanes), [lanes]);
  const lane = useMemo(() => laneMaterial(lanes), [lanes]);
  const accent = useMemo(() => new Color(), []);
  const periodic = useRef<Group>(null);
  useEffect(() => () => { fixed.forEach(g => g.dispose()); repeated.forEach(g => g.dispose()); lane.material.dispose(); }, [fixed, repeated, lane]);
  useFrame((_, delta) => {
    if (periodic.current) periodic.current.position.z = runtime.distance % PERIOD;
    const step = 1 - Math.exp(-Math.min(delta, 0.05) * 8);
    const glow = lane.uniforms.uLaneGlow.value;
    for (let i = 0; i < 4; i++) glow[i] += ((i === runtime.targetLane ? 1 : 0) - glow[i]) * step;
    lane.uniforms.uRunnerX.value = runtime.runnerX;
    accent.set(NIGHT_LANE_COLORS[runtime.targetLane] ?? NIGHT.cyan);
    lane.uniforms.uRunner.value.lerp(accent, step);
    const docked = runtime.phase === "finished" || runtime.phase === "gameover";
    lane.uniforms.uRunnerLift.value = (docked ? 0.4 : 1) / (1 + Math.max(0, runtime.feetHeight()) * 0.8);
  });
  return <>
    <mesh rotation-x={-Math.PI / 2} position={[0, GROUND_Y - 0.004, CENTER]} material={lane.material} receiveShadow={shadows}>
      <planeGeometry args={[lanes * LANE_WIDTH, LENGTH]} />
    </mesh>
    <NightMesh geometry={fixed} materials={materials} receiveShadow={shadows} />
    <group ref={periodic}><NightMesh geometry={repeated} materials={materials} /></group>
  </>;
}
