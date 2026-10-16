import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Color, type Group, type Material, ShaderMaterial } from "three";
import { createRng } from "../../engine/random";
import { useRuntime } from "../context";
import { NIGHT, NIGHT_SKY, NIGHT_WINDOW_GLSL, NightBuilder, nightFog, nightUniforms, type NightMaterials } from "./kit";
import { NightMesh } from "./NightMesh";
import { NEON } from "./signs";

/** Длина повторяющегося куска фона: копии стыкуются без шва. */
const TILE = 160;
const COPIES = 4;
const WALLS = ["#151a2c", "#1a1830", "#121c2a", "#1d1a2a", "#16202e"];
const CROWNS = [NIGHT.cyan, NIGHT.magenta, NIGHT.amber, NIGHT.violet, "#7fd0ff"];

function tileGeometry(dense: boolean) {
  const b = new NightBuilder();
  const rng = createRng(4242);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rng() * list.length)];
  for (const side of [-1, 1]) for (const band of [0, 1]) {
    let z = -rng() * 8;
    while (z > -TILE + 6) {
      const depth = 9 + rng() * 14;
      const w = 9 + rng() * 14;
      const x = side * (band ? 96 + rng() * 90 : 54 + rng() * 26 + w / 2);
      const height = band ? 70 + rng() * 120 : 34 + rng() * 70;
      const cz = z - depth / 2;
      const base = -42;
      const color = pick(WALLS);
      const style = rng() < 0.2 ? 3 : rng() < 0.55 ? 2 : 1;
      b.facade([x, base, cz], [w, height, depth], color, { spacing: 2.2 + rng() * 1.4, floor: 3.2 + rng() * 0.8, style, seed: rng() * 100 });
      let top = base + height;
      let topW = w;
      let topD = depth;
      if (rng() < 0.55) {
        topW = w * (0.55 + rng() * 0.2);
        topD = depth * (0.6 + rng() * 0.2);
        const extra = 10 + rng() * 30;
        b.facade([x, top, cz], [topW, extra, topD], color, { spacing: 2.4, floor: 3.4, style: rng() < 0.5 ? 3 : 2, seed: rng() * 100 });
        top += extra;
      }
      // Неоновая корона по кромке крыши.
      const crown = pick(CROWNS);
      for (const dz of [-1, 1]) b.box("glow", [x, top + 0.2, cz + dz * topD / 2], [topW + 0.3, 0.35, 0.3], crown);
      for (const dx of [-1, 1]) b.box("glow", [x + dx * topW / 2, top + 0.2, cz], [0.3, 0.35, topD + 0.3], crown);
      if (dense && rng() < 0.5) for (let k = 1; k < 4; k++) b.box("glow", [x - side * (w / 2 + 0.1), base + height * (0.25 + k * 0.17), cz], [0.2, 0.35, depth * 0.9], crown);
      if (rng() < 0.45) {
        const mast = 8 + rng() * 18;
        b.box("metal", [x, top + mast / 2, cz], [0.5, mast, 0.5], "#202836");
        b.box("beacon", [x, top + mast + 0.4, cz], [1.1, 1.1, 1.1], NIGHT.red);
      } else {
        b.box("beacon", [x + topW * 0.4, top + 0.9, cz + topD * 0.4], [0.9, 0.9, 0.9], NIGHT.red);
      }
      if (!band && rng() < 0.4) {
        const slot = Math.floor(rng() * NEON.vertical.length);
        const signH = 14 + rng() * 8;
        b.sign("neon", NEON.vertical[slot], [x - side * (w / 2 + 0.3), base + height * 0.55 + rng() * 10, cz], [signH / 4, signH], side > 0 ? -Math.PI / 2 : Math.PI / 2);
      }
      z -= depth + 3 + rng() * (band ? 14 : 9);
    }
  }
  return b.build();
}

/** Дальние башни рисуются без тумана сцены: у них своя дымка, окна видны и вдали. */
function skylineMaterial() {
  return new ShaderMaterial({
    vertexColors: true, fog: false,
    uniforms: { uTime: nightUniforms.uTime, uHaze: { value: nightFog }, uGlow: { value: new Color(NIGHT_SKY.glow) } },
    vertexShader: /* glsl */ `
      attribute vec2 facadeUv; attribute vec4 facade; attribute vec2 extent;
      varying vec2 vF; varying vec4 vSpec; varying vec2 vExt; varying vec3 vColor; varying vec3 vWorld; varying vec3 vN;
      void main() {
        vF = facadeUv; vSpec = facade; vExt = extent; vColor = color;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uHaze; uniform vec3 uGlow;
      varying vec2 vF; varying vec4 vSpec; varying vec2 vExt; varying vec3 vColor; varying vec3 vWorld; varying vec3 vN;
      ${NIGHT_WINDOW_GLSL}
      void main() {
        float light = 0.55 + 0.45 * max(dot(vN, normalize(vec3(-0.35, 0.4, 0.85))), 0.0) + 0.25 * max(vN.y, 0.0);
        vec3 color = vColor * light;
        color += uGlow * 0.4 * exp(-max(vWorld.y + 30.0, 0.0) * 0.035);
        float lod = nightWindowLod(vF, vSpec).x;
        vec4 win = nightWindow(vF, vSpec, vExt, uTime, lod);
        color = mix(color, vec3(0.015, 0.02, 0.03), win.a * 0.85) + win.rgb * win.a * 1.5;
        float dist = length(vWorld - cameraPosition);
        float haze = smoothstep(50.0, 330.0, dist);
        color = mix(color, uHaze, haze * 0.8);
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export function Skyline({ materials, tier }: { materials: NightMaterials; tier: "low" | "medium" | "high" }) {
  const runtime = useRuntime();
  const geometry = useMemo(() => tileGeometry(tier !== "low"), [tier]);
  const own = useMemo(() => {
    const glow = materials.glow.clone(); glow.fog = false;
    const beacon = materials.beacon.clone(); beacon.fog = false; beacon.onBeforeCompile = materials.beacon.onBeforeCompile; beacon.customProgramCacheKey = materials.beacon.customProgramCacheKey;
    const neon = materials.neon.clone(); neon.fog = false; neon.onBeforeCompile = materials.neon.onBeforeCompile; neon.customProgramCacheKey = materials.neon.customProgramCacheKey;
    return { facade: skylineMaterial(), glow, beacon, neon, metal: materials.metal } satisfies Record<string, Material>;
  }, [materials]);
  const root = useRef<Group>(null);
  useEffect(() => () => geometry.forEach(g => g.dispose()), [geometry]);
  useEffect(() => () => { own.facade.dispose(); own.glow.dispose(); own.beacon.dispose(); own.neon.dispose(); }, [own]);
  useFrame(() => {
    if (root.current) root.current.position.z = (runtime.distance * 0.3) % TILE;
  });
  return <group ref={root}>
    {Array.from({ length: COPIES }, (_, i) => <group key={i} position-z={TILE - i * TILE}>
      <NightMesh geometry={geometry} materials={own} />
    </group>)}
  </group>;
}
